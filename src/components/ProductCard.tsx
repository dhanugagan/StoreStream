import { useState } from 'react';
import { Package, Star } from 'lucide-react';
import type { CityName, SearchProductHit } from '../types/storestream';
import { formatInr } from '../utils/currency';

interface ProductCardProps {
  product: SearchProductHit;
  city: CityName;
  cartQty: number;
  onSelect: (product: SearchProductHit) => void;
  onAddToCart: (productId: string) => void;
}

export function ProductCard({
  product,
  city,
  cartQty,
  onSelect,
  onAddToCart,
}: ProductCardProps) {
  const [imgError, setImgError] = useState(false);
  const cityInv = product.inventory_by_city[city];
  const stockQty = cityInv?.stock_qty ?? 0;
  const isOutOfStock = stockQty <= 0;
  const isLastUnit = stockQty === 1;

  const mrp =
    product.discount_pct > 0
      ? Math.round(product.price_inr / (1 - product.discount_pct / 100))
      : null;

  return (
    <article className="group bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:border-slate-300">
      <div
        onClick={() => onSelect(product)}
        className="relative aspect-[4/3] bg-slate-100 overflow-hidden cursor-pointer"
      >
        {!imgError ? (
          <img
            src={product.image_url}
            alt={product.name}
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-400 bg-slate-100 p-4 text-center">
            <Package className="w-8 h-8" />
            <span className="text-xs font-medium text-slate-600">{product.name}</span>
          </div>
        )}
      </div>

      <div className="p-5 flex-1 flex flex-col justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span className="uppercase tracking-wider font-medium truncate">
              {product.brand} · {product.category}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-700 shrink-0">
              <Star className="w-3 h-3 fill-amber-400 text-amber-500" />
              {product.rating.toFixed(1)}
            </span>
          </div>

          <h3
            onClick={() => onSelect(product)}
            className="text-base font-display font-semibold text-slate-900 leading-snug cursor-pointer group-hover:text-blue-700 transition-colors"
          >
            {product.name}
          </h3>

          <div className="flex items-baseline justify-between gap-2 pt-1">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-mono tabular-nums font-semibold text-slate-900">
                {formatInr(product.price_inr)}
              </span>
              {mrp && (
                <span className="text-xs font-mono tabular-nums text-slate-400 line-through">
                  {formatInr(mrp)}
                </span>
              )}
              {product.discount_pct > 0 && (
                <span className="text-xs font-medium text-emerald-700">
                  {product.discount_pct}% off
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between text-xs pt-0.5">
            <span
              className={`font-medium tabular-nums ${
                isOutOfStock
                  ? 'text-red-700'
                  : isLastUnit
                  ? 'text-amber-700'
                  : 'text-emerald-700'
              }`}
            >
              {isOutOfStock
                ? `Out of stock in ${city}`
                : isLastUnit
                ? `Last 1 unit in ${city}`
                : `${stockQty} in stock · ${city}`}
            </span>
            {product.matched_via === 'fuzzy' && (
              <span className="text-blue-700 font-medium">Fuzzy match</span>
            )}
          </div>

          <p className="text-xs text-slate-500">
            {isOutOfStock ? 'Check regional hubs in details' : cityInv?.eta_label}
          </p>
        </div>

        <div className="pt-3 border-t border-slate-100 flex items-center gap-2.5">
          <button
            type="button"
            disabled={isOutOfStock || cartQty >= stockQty}
            onClick={() => onAddToCart(product.id)}
            className={`flex-1 px-4 py-2.5 text-xs font-medium rounded-lg transition-colors min-h-[40px] whitespace-nowrap ${
              isOutOfStock
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : cartQty >= stockQty
                ? 'bg-slate-900 text-white opacity-75 cursor-not-allowed'
                : 'bg-slate-900 text-white hover:bg-blue-700'
            }`}
          >
            {isOutOfStock
              ? 'Unavailable in City'
              : cartQty > 0
              ? `In Bag (${cartQty}) · Add`
              : 'Add to Bag'}
          </button>
          <button
            type="button"
            onClick={() => onSelect(product)}
            className="px-3.5 py-2.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors min-h-[40px] whitespace-nowrap shrink-0"
          >
            Details
          </button>
        </div>
      </div>
    </article>
  );
}
