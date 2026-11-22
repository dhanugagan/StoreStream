import type {
  CityName,
  Product,
  ProductCategory,
  SearchProductHit,
  SearchResponse,
  SearchSuggestion,
  SortOption,
} from '../shared/types/storestream.ts';
import { aivenBridge } from './adapters/aiven.ts';
import { CITIES, getAllProducts } from './store-db.ts';

interface IndexedProductDoc {
  product: Product;
  tokens: string[];
  searchableText: string;
}

class OpenSearchEngine {
  private docs: Map<string, IndexedProductDoc> = new Map();
  private lastIndexedAt: string = new Date().toISOString();

  public rebuildFromDatabase(): number {
    const products = getAllProducts();
    this.docs.clear();
    for (const product of products) {
      this.upsertProduct(product);
    }
    this.lastIndexedAt = new Date().toISOString();
    return this.docs.size;
  }

  public upsertProduct(product: Product): void {
    const rawText = [
      product.name,
      product.brand,
      product.category,
      product.sku,
      product.description,
      ...product.tags,
      ...product.specs,
    ]
      .join(' ')
      .toLowerCase();

    const tokens = Array.from(
      new Set(
        rawText
          .split(/[^a-z0-9]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)
      )
    );

    this.docs.set(product.id, {
      product,
      tokens,
      searchableText: rawText,
    });

    // Mirror index document to live Aiven OpenSearch cluster if configured
    const totalStock = CITIES.reduce(
      (sum, c) => sum + (product.inventory_by_city[c]?.stock_qty ?? 0),
      0
    );
    const cityAvailability: Record<string, number> = {};
    for (const c of CITIES) {
      cityAvailability[c] = product.inventory_by_city[c]?.stock_qty ?? 0;
    }

    void aivenBridge.indexOpenSearchDocument(product.id, {
      product_id: product.id,
      sku: product.sku,
      product_name: product.name,
      description: product.description,
      category: product.category,
      brand: product.brand,
      price: product.price_inr,
      discount_pct: product.discount_pct,
      rating: product.rating,
      popularity: product.popularity,
      available_stock: totalStock,
      city_availability: cityAvailability,
      tags: product.tags,
      updated_at: new Date().toISOString(),
    });
  }

  public getDocumentCount(): number {
    return this.docs.size;
  }

  public getLastIndexedAt(): string {
    return this.lastIndexedAt;
  }

  public suggest(query: string, city: CityName, limit = 6): SearchSuggestion[] {
    const res = this.search({ query, city });
    return res.hits.slice(0, limit).map((h) => ({
      product_id: h.id,
      name: h.name,
      brand: h.brand,
      category: h.category,
      price_inr: h.price_inr,
      stock_in_city: h.inventory_by_city[city]?.stock_qty ?? 0,
      matched_via: h.matched_via,
    }));
  }

  public search(params: {
    query: string;
    city: CityName;
    category?: ProductCategory | 'all';
    brand?: string | 'all';
    minPrice?: number;
    maxPrice?: number;
    minRating?: number;
    inStockOnly?: boolean;
    sort?: SortOption;
  }): SearchResponse {
    const started = performance.now();
    const q = params.query.trim().toLowerCase();
    const queryTokens = q
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const allDocs = Array.from(this.docs.values());
    const hits: SearchProductHit[] = [];
    const fuzzyNotes = new Set<string>();

    for (const doc of allDocs) {
      const p = doc.product;
      if (params.category && params.category !== 'all' && p.category !== params.category) {
        continue;
      }
      if (params.brand && params.brand !== 'all' && p.brand !== params.brand) {
        continue;
      }
      if (params.minPrice !== undefined && p.price_inr < params.minPrice) {
        continue;
      }
      if (params.maxPrice !== undefined && p.price_inr > params.maxPrice) {
        continue;
      }
      if (params.minRating !== undefined && p.rating < params.minRating) {
        continue;
      }

      const cityInv = p.inventory_by_city[params.city];
      if (params.inStockOnly && (!cityInv || cityInv.stock_qty <= 0)) {
        continue;
      }

      if (queryTokens.length === 0) {
        hits.push({
          ...p,
          relevance_score: (cityInv && cityInv.stock_qty > 0 ? 100 : 60) + p.popularity * 0.2,
          matched_via: 'exact',
        });
        continue;
      }

      let totalScore = 0;
      let matchMode: 'exact' | 'prefix' | 'fuzzy' = 'exact';
      let matchedTokens = 0;

      for (const qt of queryTokens) {
        if (doc.searchableText.includes(qt)) {
          const inTitleOrBrand =
            p.name.toLowerCase().includes(qt) || p.brand.toLowerCase().includes(qt);
          totalScore += inTitleOrBrand ? 55 : 30;
          matchedTokens++;
          continue;
        }

        const prefixHit = doc.tokens.find((tok) => tok.startsWith(qt) && qt.length >= 3);
        if (prefixHit) {
          totalScore += 32;
          if (matchMode === 'exact') matchMode = 'prefix';
          matchedTokens++;
          continue;
        }

        const maxEdits = qt.length >= 6 ? 2 : 1;
        let bestDist = Infinity;
        let bestToken = '';

        for (const tok of doc.tokens) {
          if (Math.abs(tok.length - qt.length) > maxEdits) continue;
          const dist = damerauLevenshtein(qt, tok);
          if (dist <= maxEdits && dist < bestDist) {
            bestDist = dist;
            bestToken = tok;
          }
        }

        if (bestDist <= maxEdits) {
          totalScore += bestDist === 1 ? 26 : 18;
          matchMode = 'fuzzy';
          matchedTokens++;
          fuzzyNotes.add(`"${qt}" → "${bestToken}"`);
        }
      }

      if (matchedTokens > 0) {
        // Multi-token completeness bonus so "samzung phone" puts Samsung smartphones #1
        const completenessBonus = matchedTokens === queryTokens.length ? 40 : 0;
        const stockBoost = cityInv && cityInv.stock_qty > 0 ? 10 : 0;
        hits.push({
          ...p,
          relevance_score: totalScore + completenessBonus + stockBoost,
          matched_via: matchMode,
        });
      }
    }

    const sort = params.sort || 'relevance';
    hits.sort((a, b) => {
      if (sort === 'price_asc') return a.price_inr - b.price_inr;
      if (sort === 'price_desc') return b.price_inr - a.price_inr;
      if (sort === 'popularity') return b.popularity - a.popularity;
      if (sort === 'rating') return b.rating - a.rating;
      return b.relevance_score - a.relevance_score;
    });

    const categoryMap = new Map<ProductCategory, number>();
    const brandMap = new Map<string, number>();
    let inStockCount = 0;

    for (const doc of allDocs) {
      const cat = doc.product.category;
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
      brandMap.set(doc.product.brand, (brandMap.get(doc.product.brand) || 0) + 1);
      if ((doc.product.inventory_by_city[params.city]?.stock_qty || 0) > 0) {
        inStockCount++;
      }
    }

    const osLive = Boolean(aivenBridge.getOpenSearchClient());

    return {
      query: params.query,
      city: params.city,
      total_hits: hits.length,
      fuzzy_corrected_note:
        fuzzyNotes.size > 0 ? `Typo-tolerant match: ${Array.from(fuzzyNotes).join(', ')}` : null,
      took_ms: Math.max(1, Math.round((performance.now() - started) * 10) / 10),
      engine: osLive ? 'opensearch_live' : 'opensearch_local_demo',
      last_indexed_at: this.lastIndexedAt,
      hits,
      facets: {
        categories: Array.from(categoryMap.entries()).map(([category, count]) => ({
          category,
          count,
        })),
        brands: Array.from(brandMap.entries())
          .map(([brand, count]) => ({ brand, count }))
          .sort((a, b) => a.brand.localeCompare(b.brand)),
        city_stock: CITIES.map((city) => ({
          city,
          in_stock_count: allDocs.filter(
            (doc) => (doc.product.inventory_by_city[city]?.stock_qty || 0) > 0
          ).length,
        })),
        in_stock_in_city: inStockCount,
      },
    };
  }
}

export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }
  return dp[m][n];
}

export const searchIndex = new OpenSearchEngine();
