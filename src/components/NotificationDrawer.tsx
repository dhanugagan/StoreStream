import { Bell, CheckCheck, X } from 'lucide-react';
import type { NotificationRecord } from '../types/storestream';
import { formatTimeAgo } from '../utils/currency';

interface NotificationDrawerProps {
  isOpen: boolean;
  notifications: NotificationRecord[];
  onClose: () => void;
  onMarkAllRead: () => Promise<void>;
}

export function NotificationDrawer({
  isOpen,
  notifications,
  onClose,
  onMarkAllRead,
}: NotificationDrawerProps) {
  if (!isOpen) return null;

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Notification Center"
    >
      <div className="w-full max-w-md bg-white border-l border-slate-200 h-full flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-blue-600" />
            <div>
              <h2 className="text-base font-display font-semibold text-slate-900">
                Notification Center
              </h2>
              <p className="text-xs text-slate-500">
                Live updates from cg-notifications consumer ({unreadCount} unread)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close notifications"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-2.5 border-b border-slate-100 flex justify-end">
          <button
            type="button"
            disabled={unreadCount === 0}
            onClick={() => void onMarkAllRead()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline disabled:opacity-40"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all read
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {notifications.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No notifications yet. Place an order or restock inventory to see live events.
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`p-4 text-xs space-y-1 ${n.is_read ? 'bg-white' : 'bg-blue-50/40'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold text-slate-900">
                    {n.order_id || 'System'} · {n.city}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    {formatTimeAgo(n.dispatched_at)}
                  </span>
                </div>
                <p className="text-slate-700">{n.message}</p>
                <p className="font-mono text-[11px] text-slate-400">{n.customer_email}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
