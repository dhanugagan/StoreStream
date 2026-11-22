import { CheckCircle2, MailCheck, Truck, XCircle } from 'lucide-react';
import type { NotificationRecord, StoreOrder } from '../types/storestream';
import { formatInr, formatTimeAgo } from '../utils/currency';

interface OrdersViewProps {
  orders: StoreOrder[];
  confirmations: NotificationRecord[];
}

export function OrdersView({ orders, confirmations }: OrdersViewProps) {
  const confirmationByOrder = new Map(confirmations.map((c) => [c.order_id, c]));

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-display font-semibold text-slate-900">
            Transactional Order Ledger
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Orders verified atomically in regional warehouses with payment simulation receipts and
            consumer-dispatched confirmations.
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-slate-500">
          {orders.length} orders
        </span>
      </div>

      {orders.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-xs text-slate-500">
          No orders placed yet. Add a product from the Storefront and complete checkout.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {orders.map((order) => {
            const conf = confirmationByOrder.get(order.id);
            const isCancelled = order.status === 'cancelled';
            return (
              <div
                key={order.id}
                className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-900">{order.id}</span>
                    <span className="text-slate-300">·</span>
                    <span
                      className={`font-medium inline-flex items-center gap-1 capitalize ${
                        isCancelled ? 'text-red-700' : 'text-emerald-700'
                      }`}
                    >
                      {isCancelled ? (
                        <XCircle className="w-3.5 h-3.5" />
                      ) : order.status === 'dispatched' || order.status === 'delivered' ? (
                        <Truck className="w-3.5 h-3.5" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      {order.status}
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-600">Warehouse: {order.city}</span>
                    <span className="text-slate-300">·</span>
                    <span className="font-mono text-slate-400">
                      {order.payment_reference} ({order.payment_status === 'simulated_refunded' ? 'Refunded' : 'Simulated Paid'})
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="font-mono text-slate-400">
                      {formatTimeAgo(order.created_at)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-slate-900">
                    {order.customer_name} —{' '}
                    <span className="font-normal text-slate-600">{order.shipping_address}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {order.items.map((i) => `${i.qty}x ${i.product_name}`).join(', ')}
                  </p>
                  {conf && (
                    <p className="text-xs text-blue-700 inline-flex items-center gap-1.5">
                      <MailCheck className="w-3.5 h-3.5" />
                      {conf.message}
                    </p>
                  )}
                </div>

                <div className="text-right shrink-0 space-y-0.5">
                  <div className="text-base font-mono tabular-nums font-semibold text-slate-900">
                    {formatInr(order.total_inr)}
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-slate-400">
                    Subtotal {formatInr(order.subtotal_inr)} + GST {formatInr(order.tax_inr)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
