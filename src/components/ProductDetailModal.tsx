import { MapPin, Minus, Package, Plus, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CityName, Product } from '../types/storestream';
import { formatInr } from '../utils/currency';

interface ProductDetailModalProps {
  product: Product | null;
  allProducts: Product[];
  cities: CityName[];
  selectedCity: CityName;
  onSelectCity: (city: CityName) => void;
  onSelectProduct: (product: Product) => void;
  onAddToCart: (productId: string, qty?: number) => void;
  onClose: () => void;
}

export function ProductDetailModal({
  product,
  allProducts,
  cities,
  selectedCity,
  onSelectCity,
  onSelectProduct,
  onAddToCart,
  onClose,
}: ProductDetailModalProps) {
  const [imgError, setImgError] = useState(false);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    setImgError(false);
    setQty(1);
  }, [product?.id, selectedCity]);

  if (!product) return null;

  const activeInv = product.inventory_by_city[selectedCity];
  const stockQty = activeInv?.stock_qty ?? 0;
  const mrp =
    product.discount_pct > 0
      ? Math.round(product.price_inr / (1 - product.discount_pct / 100))
      : null;

  const related = allProducts
    .filter((p) => p.category === product.category && p.id !== product.id)
    .slice(0, 3);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={product.name}
    >
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="text-xs font-mono text-slate-500">
            SKU {product.sku} · {product.brand} · {product.category}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close product details"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
            {/* Studio Product Image & Hardware Specs */}
            <div className="md:col-span-6 space-y-4">
              <div className="aspect-[4/3] rounded-xl overflow-hidden bg-slate-100 border border-slate-200">
                {!imgError ? (
                  <img
                    src={product.image_url}
                    alt={product.name}
                    referrerPolicy="no-referrer"
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                    <Package className="w-10 h-10" />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Key Specifications
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  {product.specs.map((spec) => (
                    <div
                      key={spec}
                      className="px-3 py-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      {spec}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Contiguous Purchase Module + City Stock Matrix */}
            <div className="md:col-span-6 space-y-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1 text-slate-800 font-medium">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500" />
                    {product.rating.toFixed(1)} rating
                  </span>
                  <span>·</span>
                  <span>Popularity score {product.popularity}</span>
                </div>
                <h2 className="text-2xl font-display font-bold text-slate-900 text-balance">
                  {product.name}
                </h2>
                <div className="flex items-baseline gap-2.5">
                  <p className="text-2xl font-mono tabular-nums font-semibold text-slate-900">
                    {formatInr(product.price_inr)}
                  </p>
                  {mrp && (
                    <span className="text-sm font-mono tabular-nums text-slate-400 line-through">
                      {formatInr(mrp)}
                    </span>
                  )}
                  {product.discount_pct > 0 && (
                    <span className="text-xs font-semibold text-emerald-700">
                      Save {product.discount_pct}%
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-600 leading-relaxed pt-1">{product.description}</p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800 inline-flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-blue-600" />
                    Live Warehouse Stock Across India
                  </span>
                  <span className="text-slate-500">Click city to switch</span>
                </div>

                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-white">
                  {cities.map((c) => {
                    const inv = product.inventory_by_city[c];
                    const available = inv?.stock_qty ?? 0;
                    const isCurrent = c === selectedCity;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onSelectCity(c)}
                        className={`w-full px-3.5 py-2 flex items-center justify-between text-xs text-left transition-colors ${
                          isCurrent ? 'bg-blue-50/70 font-semibold' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div>
                          <span className="text-slate-900">{c}</span>
                          <span className="text-slate-400 font-mono ml-2">
                            {inv?.warehouse_code}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 hidden sm:inline">{inv?.eta_label}</span>
                          <span
                            className={`font-mono tabular-nums ${
                              available === 0
                                ? 'text-red-700'
                                : available === 1
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            {available} units
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="inline-flex items-center border border-slate-200 rounded-xl bg-slate-50 px-2 h-11">
                  <button
                    type="button"
                    disabled={qty <= 1}
                    onClick={() => setQty((q) => Math.max(1, q - 1))}
                    className="p-1.5 text-slate-600 hover:text-slate-900 disabled:opacity-40"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-3 text-xs font-mono tabular-nums font-semibold text-slate-900">
                    {qty}
                  </span>
                  <button
                    type="button"
                    disabled={qty >= stockQty}
                    onClick={() => setQty((q) => Math.min(stockQty, q + 1))}
                    className="p-1.5 text-slate-600 hover:text-slate-900 disabled:opacity-40"
                    aria-label="Increase quantity"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button
                  type="button"
                  disabled={stockQty <= 0}
                  onClick={() => {
                    onAddToCart(product.id, qty);
                    onClose();
                  }}
                  className="flex-1 py-3 px-6 text-sm font-medium text-white bg-slate-900 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl transition-colors min-h-[44px]"
                >
                  {stockQty > 0
                    ? `Add ${qty} to Bag · ${selectedCity}`
                    : `Out of Stock in ${selectedCity}`}
                </button>
              </div>
            </div>
          </div>

          {related.length > 0 && (
            <div className="pt-6 border-t border-slate-200 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Related in {product.category}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {related.map((rel) => {
                  const relStock = rel.inventory_by_city[selectedCity]?.stock_qty ?? 0;
                  return (
                    <button
                      key={rel.id}
                      type="button"
                      onClick={() => onSelectProduct(rel)}
                      className="p-3 rounded-xl border border-slate-200 hover:border-slate-300 text-left flex items-center gap-3 transition-colors"
                    >
                      <img
                        src={rel.image_url}
                        alt={rel.name}
                        referrerPolicy="no-referrer"
                        className="w-14 h-12 rounded-lg object-cover bg-slate-100 shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900 truncate">{rel.name}</p>
                        <p className="text-xs font-mono tabular-nums text-slate-600 mt-0.5">
                          {formatInr(rel.price_inr)} · {relStock} in {selectedCity}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
