import { useEffect, useState } from 'react';
import { CheckCircle2, CreditCard, Minus, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import type {
  AuthUser,
  CartItem,
  CityName,
  PaymentMethod,
  Product,
  StoreOrder,
} from '../types/storestream';
import { formatInr } from '../utils/currency';

interface CartDrawerProps {
  isOpen: boolean;
  city: CityName;
  cart: CartItem[];
  products: Product[];
  authUser: AuthUser | null;
  onClose: () => void;
  onUpdateQty: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onCheckout: (customer: {
    customerName: string;
    customerEmail: string;
    shippingAddress: string;
    paymentMethod: PaymentMethod;
    idempotencyKey: string;
  }) => Promise<StoreOrder>;
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  UPI_SIMULATION: 'UPI Instant (Simulated Gateway)',
  CARD_SIMULATION: 'Credit / Debit Card (Simulated Gateway)',
  COD_SIMULATION: 'Cash on Delivery (Simulated Verification)',
};

export function CartDrawer({
  isOpen,
  city,
  cart,
  products,
  authUser,
  onClose,
  onUpdateQty,
  onRemoveItem,
  onCheckout,
}: CartDrawerProps) {
  const [customerName, setCustomerName] = useState(authUser?.name || 'Rohan Kulkarni');
  const [customerEmail, setCustomerEmail] = useState(
    authUser?.email || 'rohan.kulkarni@example.in'
  );
  const [shippingAddress, setShippingAddress] = useState(`12th Main, Indiranagar, ${city}`);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('UPI_SIMULATION');
  const [idempotencyKey, setIdempotencyKey] = useState(() => `idem_${crypto.randomUUID().slice(0, 8)}`);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] = useState<StoreOrder | null>(null);

  useEffect(() => {
    setShippingAddress(`12th Main, Indiranagar, ${city}`);
  }, [city]);

  useEffect(() => {
    if (authUser) {
      setCustomerName(authUser.name);
      setCustomerEmail(authUser.email);
    }
  }, [authUser]);

  if (!isOpen) return null;

  const productMap = new Map(products.map((p) => [p.id, p]));
  const lineItems = cart
    .map((c) => {
      const product = productMap.get(c.productId);
      if (!product) return null;
      return {
        product,
        qty: c.qty,
        available: product.inventory_by_city[city]?.stock_qty ?? 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const subtotal = lineItems.reduce((sum, item) => sum + item.product.price_inr * item.qty, 0);
  const tax = Math.round(subtotal * 0.18);
  const delivery = subtotal >= 1999 || subtotal === 0 ? 0 : 99;
  const grandTotal = subtotal + tax + delivery;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCheckoutError(null);
    setIsSubmitting(true);
    try {
      const order = await onCheckout({
        customerName,
        customerEmail,
        shippingAddress,
        paymentMethod,
        idempotencyKey,
      });
      setConfirmedOrder(order);
      setIdempotencyKey(`idem_${crypto.randomUUID().slice(0, 8)}`);
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Checkout failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Shopping Bag and Transactional Checkout"
    >
      <div className="w-full max-w-md bg-white border-l border-slate-200 h-full flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-display font-semibold text-slate-900">Shopping Bag</h2>
            <p className="text-xs text-slate-500">
              Persisted in DB · Fulfilling from {city} warehouse
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setConfirmedOrder(null);
              setCheckoutError(null);
              onClose();
            }}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close bag"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {confirmedOrder ? (
            <div className="p-5 rounded-xl border border-emerald-200 bg-emerald-50/50 space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Order {confirmedOrder.id} Confirmed
                  </h3>
                  <p className="text-xs text-slate-600 mt-1">
                    Stock reserved atomically in {confirmedOrder.city}. Outbox events published to
                    order.placed and inventory.changed.
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 mt-1">
                    Payment Ref: {confirmedOrder.payment_reference} (Simulated)
                  </p>
                </div>
              </div>
              <div className="pt-3 border-t border-emerald-200 space-y-1.5 text-xs">
                {confirmedOrder.items.map((item) => (
                  <div key={item.id} className="flex justify-between">
                    <span className="text-slate-700">
                      {item.qty}x {item.product_name}
                    </span>
                    <span className="font-mono tabular-nums text-slate-900">
                      {formatInr(item.unit_price_inr * item.qty)}
                    </span>
                  </div>
                ))}
                <div className="pt-2 border-t border-emerald-200 space-y-1 text-slate-600">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span className="font-mono tabular-nums">
                      {formatInr(confirmedOrder.subtotal_inr)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>GST (18%)</span>
                    <span className="font-mono tabular-nums">
                      {formatInr(confirmedOrder.tax_inr)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Delivery ({confirmedOrder.city})</span>
                    <span className="font-mono tabular-nums">
                      {confirmedOrder.delivery_inr === 0
                        ? 'Free'
                        : formatInr(confirmedOrder.delivery_inr)}
                    </span>
                  </div>
                </div>
                <div className="pt-2 border-t border-emerald-200 flex justify-between font-semibold text-slate-900">
                  <span>Total (Simulated)</span>
                  <span className="font-mono tabular-nums">
                    {formatInr(confirmedOrder.total_inr)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setConfirmedOrder(null);
                  onClose();
                }}
                className="w-full py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 min-h-[40px]"
              >
                Continue Shopping
              </button>
            </div>
          ) : lineItems.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <p className="text-sm font-medium text-slate-900">Your bag is empty</p>
              <p className="text-xs text-slate-500">
                Add products in {city} to test GST calculation, idempotent checkout, and atomic stock reservation.
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
                {lineItems.map(({ product, qty, available }) => (
                  <div key={product.id} className="p-4 flex items-center gap-3">
                    <img
                      src={product.image_url}
                      alt={product.name}
                      referrerPolicy="no-referrer"
                      className="w-16 h-12 rounded-lg object-cover bg-slate-100 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">
                        {product.name}
                      </p>
                      <p className="text-xs font-mono tabular-nums text-slate-600 mt-0.5">
                        {formatInr(product.price_inr)} · {available} left in {city}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onUpdateQty(product.id, -1)}
                          className="p-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50"
                          aria-label="Decrease quantity"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="text-xs font-mono tabular-nums px-1">{qty}</span>
                        <button
                          type="button"
                          disabled={qty >= available}
                          onClick={() => onUpdateQty(product.id, 1)}
                          className="p-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                          aria-label="Increase quantity"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveItem(product.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      aria-label={`Remove ${product.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  Transactional Checkout ({city})
                </div>

                <label className="block space-y-1">
                  <span className="text-xs text-slate-600">Full Name</span>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-slate-600">Confirmation Email</span>
                  <input
                    type="email"
                    required
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-slate-600">Delivery Address</span>
                  <input
                    type="text"
                    required
                    value={shippingAddress}
                    onChange={(e) => setShippingAddress(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </label>

                <div className="space-y-1.5">
                  <span className="text-xs text-slate-600 flex items-center gap-1.5">
                    <CreditCard className="w-3.5 h-3.5 text-slate-500" />
                    Payment Simulation (Demo Gateway — No Real Charge)
                  </span>
                  <select
                    aria-label="Simulated payment method"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  >
                    {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((method) => (
                      <option key={method} value={method}>
                        {PAYMENT_LABELS[method]}
                      </option>
                    ))}
                  </select>
                </div>

                {checkoutError && (
                  <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
                    {checkoutError}
                  </div>
                )}

                <div className="pt-3 border-t border-slate-200 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal</span>
                    <span className="font-mono tabular-nums">{formatInr(subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Estimated GST (18%)</span>
                    <span className="font-mono tabular-nums">{formatInr(tax)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Delivery (Free above ₹1,999)</span>
                    <span className="font-mono tabular-nums">
                      {delivery === 0 ? 'Free' : formatInr(delivery)}
                    </span>
                  </div>
                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-sm font-semibold text-slate-900">
                    <span>Order Total</span>
                    <span className="font-mono tabular-nums">{formatInr(grandTotal)}</span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-400">
                    Idempotency Key: {idempotencyKey}
                  </p>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-3 px-4 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-xl transition-colors min-h-[44px]"
                  >
                    {isSubmitting
                      ? 'Executing Atomic Transaction...'
                      : 'Place Order (Simulated Payment)'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
