import { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  Database,
  Lock,
  Minus,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  AuthUser,
  CityName,
  OrderStatus,
  Product,
  ProductCategory,
  StoreSnapshot,
} from '../types/storestream';
import { formatInr, formatTimeAgo } from '../utils/currency';

type AdminTab = 'overview' | 'products' | 'inventory' | 'orders' | 'analytics' | 'events';

interface AdminDashboardProps {
  snapshot: StoreSnapshot;
  authUser: AuthUser | null;
  authToken: string | null;
  onAuthenticated: (user: AuthUser, token: string) => void;
  onRefreshSnapshot: (updatedSnapshot?: StoreSnapshot) => void;
}

const STUDIO_IMAGES = [
  { label: 'Bluetooth Earphones', url: '/src/assets/images/product_bluetooth_earphones_1795314720308.jpg' },
  { label: 'Flagship Smartphone', url: '/src/assets/images/product_smartphone_flagship_1795315751245.jpg' },
  { label: 'Studio Headphones', url: '/src/assets/images/product_studio_headphones_1795314721448.jpg' },
  { label: 'Mechanical Keyboard', url: '/src/assets/images/product_mechanical_keyboard_1795314721669.jpg' },
  { label: 'Espresso Machine', url: '/src/assets/images/product_kitchen_espresso_1795315751007.jpg' },
  { label: 'HEPA Air Purifier', url: '/src/assets/images/product_air_purifier_1795314721157.jpg' },
  { label: 'Tailored Overshirt', url: '/src/assets/images/product_fashion_jacket_1795315751913.jpg' },
  { label: 'Specialty Coffee', url: '/src/assets/images/product_grocery_coffee_1795315750797.jpg' },
  { label: 'Vitamin C Serum', url: '/src/assets/images/product_beauty_serum_1795315751357.jpg' },
  { label: 'Marathon Shoes', url: '/src/assets/images/product_sports_shoes_1795315751430.jpg' },
  { label: '100W GaN Charger', url: '/src/assets/images/product_gan_charger_1795314720768.jpg' },
  { label: 'Smart Speaker', url: '/src/assets/images/product_smart_speaker_1795314720476.jpg' },
];

export function AdminDashboard({
  snapshot,
  authUser,
  authToken,
  onAuthenticated,
  onRefreshSnapshot,
}: AdminDashboardProps) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [adminClaimed, setAdminClaimed] = useState<boolean | null>(null);
  const [claimName, setClaimName] = useState('Operations Lead');
  const [claimEmail, setClaimEmail] = useState('admin@storestream.in');
  const [claimPassword, setClaimPassword] = useState('');
  const [claimRole, setClaimRole] = useState<'Administrator' | 'Inventory Manager'>('Administrator');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Admin operation states
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Add Product Form
  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newCategory, setNewCategory] = useState<ProductCategory>('Electronics');
  const [newPrice, setNewPrice] = useState('4999');
  const [newDiscount, setNewDiscount] = useState('10');
  const [newStock, setNewStock] = useState('8');
  const [newDesc, setNewDesc] = useState('');
  const [newImage, setNewImage] = useState(STUDIO_IMAGES[0].url);
  const [editingProd, setEditingProd] = useState<Product | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editDiscount, setEditDiscount] = useState('');

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d: { adminClaimed: boolean }) => setAdminClaimed(d.adminClaimed))
      .catch(() => setAdminClaimed(true));
  }, []);

  const hasAdminAccess =
    Boolean(authToken) &&
    (authUser?.role === 'Administrator' || authUser?.role === 'Inventory Manager');

  async function handleAdminAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const endpoint = adminClaimed === false ? '/api/auth/claim-admin' : '/api/auth/login';
      const body =
        adminClaimed === false
          ? { name: claimName, email: claimEmail, password: claimPassword, role: claimRole }
          : { email: claimEmail, password: claimPassword };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        user?: AuthUser;
        token?: string;
        error?: string;
      };
      if (!res.ok || !data.user || !data.token) {
        throw new Error(data.error || 'Authentication failed.');
      }
      setAdminClaimed(true);
      onAuthenticated(data.user, data.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to authenticate.');
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !authToken) return;
    setActionError(null);
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    const data = (await res.json()) as { imageUrl?: string; error?: string };
    if (!res.ok || !data.imageUrl) {
      setActionError(data.error || 'Upload failed.');
      return;
    }
    setNewImage(data.imageUrl);
    setActionNotice('Uploaded product image cleanly.');
  }

  async function handleCreateProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!authToken) return;
    setActionError(null);
    setActionNotice(null);
    const res = await fetch('/api/admin/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sku: newSku,
        name: newName,
        brand: newBrand,
        category: newCategory,
        price_inr: Number(newPrice),
        discount_pct: Number(newDiscount),
        initialStock: Number(newStock),
        description: newDesc,
        specs: ['Multi-City Warehouse Synced', 'OpenSearch Indexed'],
        tags: [newCategory.toLowerCase(), newBrand.toLowerCase()],
        image_url: newImage,
      }),
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
    if (!res.ok) {
      setActionError(data.error || 'Failed to add product.');
      return;
    }
    if (data.snapshot) onRefreshSnapshot(data.snapshot);
    setNewSku('');
    setNewName('');
    setNewBrand('');
    setNewDesc('');
    setActionNotice('Product created and emitted to product.updated stream.');
  }

  async function handleSaveEditProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!authToken || !editingProd) return;
    setActionError(null);
    const res = await fetch(`/api/admin/products/${encodeURIComponent(editingProd.id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        price_inr: Number(editPrice),
        discount_pct: Number(editDiscount),
      }),
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
    if (!res.ok) {
      setActionError(data.error || 'Update failed.');
      return;
    }
    if (data.snapshot) onRefreshSnapshot(data.snapshot);
    setEditingProd(null);
    setActionNotice('Product price updated and OpenSearch index synced.');
  }

  async function handleDeleteProduct(productId: string) {
    if (!authToken) return;
    setActionError(null);
    const res = await fetch(`/api/admin/products/${encodeURIComponent(productId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
    if (!res.ok) {
      setActionError(data.error || 'Delete failed.');
      return;
    }
    if (data.snapshot) onRefreshSnapshot(data.snapshot);
    setActionNotice('Product deleted cleanly.');
  }

  async function handleRestock(productId: string, city: CityName, delta: number) {
    if (!authToken) return;
    const key = `${productId}:${city}`;
    setBusyKey(key);
    setActionError(null);
    try {
      const res = await fetch('/api/admin/inventory/restock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ productId, city, delta }),
      });
      const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
      if (!res.ok) {
        setActionError(data.error || 'Inventory update failed.');
        return;
      }
      if (data.snapshot) onRefreshSnapshot(data.snapshot);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleOrderStatus(orderId: string, status: OrderStatus) {
    if (!authToken) return;
    setActionError(null);
    const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ status }),
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
    if (!res.ok) {
      setActionError(data.error || 'Order update failed.');
      return;
    }
    if (data.snapshot) onRefreshSnapshot(data.snapshot);
    setActionNotice(
      status === 'cancelled'
        ? `Order ${orderId} cancelled · Stock restored & simulated refund issued.`
        : `Order ${orderId} transitioned to ${status}.`
    );
  }

  async function handleReplayEvent(eventId: string) {
    if (!authToken) return;
    const res = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/replay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot; error?: string };
    if (res.ok && data.snapshot) {
      onRefreshSnapshot(data.snapshot);
      setActionNotice(`Replayed ${eventId} through idempotent consumers.`);
    }
  }

  if (!hasAdminAccess) {
    return (
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl p-8 space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-blue-700">
            <Lock className="w-4 h-4" />
            RBAC Protected Console
          </div>
          <h2 className="text-xl font-display font-bold text-slate-900">
            {adminClaimed === false
              ? 'First-Run Admin Setup'
              : 'Administrator & Inventory Manager Sign-In'}
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            {adminClaimed === false
              ? 'No administrator password is set yet. Claim your initial Administrator account below (hashed with scrypt on the server and locked once claimed).'
              : 'Sign in with your Administrator or Inventory Manager credentials to manage products, city inventory, orders, and event monitors.'}
          </p>
        </div>

        <form onSubmit={handleAdminAuth} className="space-y-4">
          {adminClaimed === false && (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Full Name</span>
                <input
                  type="text"
                  required
                  value={claimName}
                  onChange={(e) => setClaimName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Role</span>
                <select
                  value={claimRole}
                  onChange={(e) =>
                    setClaimRole(e.target.value as 'Administrator' | 'Inventory Manager')
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                >
                  <option value="Administrator">Administrator (Full Access)</option>
                  <option value="Inventory Manager">Inventory Manager</option>
                </select>
              </label>
            </>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-slate-600">Work Email</span>
            <input
              type="email"
              required
              value={claimEmail}
              onChange={(e) => setClaimEmail(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-slate-600">Password</span>
            <input
              type="password"
              required
              minLength={6}
              value={claimPassword}
              onChange={(e) => setClaimPassword(e.target.value)}
              placeholder="Choose or enter your admin password (min 6 chars)"
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </label>

          {authError && (
            <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
              {authError}
            </div>
          )}

          <button
            type="submit"
            disabled={authSubmitting}
            className="w-full py-2.5 px-4 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 rounded-lg min-h-[42px]"
          >
            {authSubmitting
              ? 'Verifying...'
              : adminClaimed === false
              ? 'Claim Initial Admin Account'
              : 'Sign In to Admin Dashboard'}
          </button>
        </form>
      </div>
    );
  }

  const lowStockEntries: Array<{ product: Product; city: CityName; qty: number }> = [];
  for (const p of snapshot.products) {
    for (const c of snapshot.cities) {
      const q = p.inventory_by_city[c]?.stock_qty ?? 0;
      if (q <= 3) lowStockEntries.push({ product: p, city: c, qty: q });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <p className="text-xs font-medium text-blue-700">
            Signed in as {authUser?.name} ({authUser?.role})
          </p>
          <h2 className="text-xl font-display font-bold text-slate-900">
            StoreStream Operations &amp; Analytics Console
          </h2>
        </div>

        <div className="flex flex-wrap gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg text-xs">
          {(
            [
              ['overview', 'Overview'],
              ['products', 'Products'],
              ['inventory', 'Inventory'],
              ['orders', 'Orders'],
              ['analytics', 'Analytics'],
              ['events', 'Event Monitor'],
            ] as Array<[AdminTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="p-3 rounded-xl border border-red-200 bg-red-50 text-xs text-red-800">
          {actionError}
        </div>
      )}
      {actionNotice && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-xs text-emerald-800">
          {actionNotice}
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            {[
              { label: 'Products', value: snapshot.metrics.totalProducts },
              { label: 'Total Orders', value: snapshot.analytics.totalOrders },
              { label: 'Revenue', value: formatInr(snapshot.analytics.totalRevenueInr) },
              { label: 'Customers', value: snapshot.analytics.activeCustomers },
              { label: 'Low Stock SKUs', value: snapshot.analytics.lowStockCount },
              { label: 'Out of Stock', value: snapshot.analytics.outOfStockCount },
              { label: 'Awaiting Pack', value: snapshot.analytics.awaitingProcessingCount },
            ].map((kpi) => (
              <div key={kpi.label} className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs text-slate-500">{kpi.label}</p>
                <p className="mt-1.5 text-lg font-display font-semibold font-mono tabular-nums text-slate-900">
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              Active Low-Stock &amp; Stockout Alerts ({lowStockEntries.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {lowStockEntries.slice(0, 9).map((entry) => (
                <div
                  key={`${entry.product.id}:${entry.city}`}
                  className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 truncate">{entry.product.name}</p>
                    <p className="text-slate-500">{entry.city}</p>
                  </div>
                  <span
                    className={`font-mono font-semibold shrink-0 ${
                      entry.qty === 0 ? 'text-red-700' : 'text-amber-700'
                    }`}
                  >
                    {entry.qty} left
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'products' && (
        <div className="space-y-6">
          {authUser?.role === 'Administrator' && (
            <form
              onSubmit={handleCreateProduct}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <PackagePlus className="w-4 h-4 text-blue-600" />
                Add New Catalog Product
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <input
                  required
                  placeholder="SKU (e.g. SS-NEW-901)"
                  value={newSku}
                  onChange={(e) => setNewSku(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                />
                <input
                  required
                  placeholder="Product Name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg md:col-span-2"
                />
                <input
                  required
                  placeholder="Brand"
                  value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                />
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as ProductCategory)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                >
                  {snapshot.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  required
                  type="number"
                  min={1}
                  placeholder="Price (INR)"
                  value={newPrice}
                  onChange={(e) => setNewPrice(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                />
                <input
                  type="number"
                  min={0}
                  max={90}
                  placeholder="Discount %"
                  value={newDiscount}
                  onChange={(e) => setNewDiscount(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Initial City Stock"
                  value={newStock}
                  onChange={(e) => setNewStock(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs items-center">
                <input
                  required
                  placeholder="Product Description"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg md:col-span-2"
                />
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Choose studio image"
                    value={newImage}
                    onChange={(e) => setNewImage(e.target.value)}
                    className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                  >
                    {STUDIO_IMAGES.map((img) => (
                      <option key={img.url} value={img.url}>
                        {img.label}
                      </option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-1 px-3 py-2 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50 shrink-0">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload</span>
                    <input type="file" accept="image/*" className="hidden" onChange={handleUploadImage} />
                  </label>
                </div>
              </div>

              <button
                type="submit"
                className="px-5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 rounded-lg"
              >
                Create Product &amp; Sync OpenSearch
              </button>
            </form>
          )}

          {editingProd && (
            <form
              onSubmit={handleSaveEditProduct}
              className="bg-blue-50/50 border border-blue-200 rounded-xl p-4 flex flex-wrap items-center gap-3 text-xs"
            >
              <span className="font-semibold text-slate-900">Editing {editingProd.name}:</span>
              <input
                type="number"
                min={1}
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
                placeholder="Price INR"
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg w-28"
              />
              <input
                type="number"
                min={0}
                max={90}
                value={editDiscount}
                onChange={(e) => setEditDiscount(e.target.value)}
                placeholder="Discount %"
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg w-24"
              />
              <button type="submit" className="px-3 py-1.5 bg-slate-900 text-white rounded-lg">
                Save Changes
              </button>
              <button
                type="button"
                onClick={() => setEditingProd(null)}
                className="px-3 py-1.5 border border-slate-200 bg-white rounded-lg"
              >
                Cancel
              </button>
            </form>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-3 px-4">Product</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4">Price</th>
                  <th className="py-3 px-4">Discount</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {snapshot.products.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{p.name}</div>
                      <div className="font-mono text-slate-400">
                        {p.sku} · {p.brand}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{p.category}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-900">
                      {formatInr(p.price_inr)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-emerald-700">
                      {p.discount_pct}%
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                      {authUser?.role === 'Administrator' && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingProd(p);
                              setEditPrice(String(p.price_inr));
                              setEditDiscount(String(p.discount_pct));
                            }}
                            className="p-1.5 text-slate-600 hover:text-blue-700"
                            title="Edit price"
                          >
                            <Pencil className="w-3.5 h-3.5 inline" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteProduct(p.id)}
                            className="p-1.5 text-slate-600 hover:text-red-700"
                            title="Delete product"
                          >
                            <Trash2 className="w-3.5 h-3.5 inline" />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'inventory' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2">
              <Boxes className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Multi-City Warehouse Inventory Controls
              </h3>
            </div>
            <div className="overflow-x-auto max-h-[520px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-3 px-4">Product</th>
                    {snapshot.cities.map((c) => (
                      <th key={c} className="py-3 px-3 text-center whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.products.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{p.name}</div>
                        <div className="font-mono text-slate-400">{p.sku}</div>
                      </td>
                      {snapshot.cities.map((c) => {
                        const qty = p.inventory_by_city[c]?.stock_qty ?? 0;
                        const loadingCell = busyKey === `${p.id}:${c}`;
                        return (
                          <td key={c} className="py-3 px-2 text-center whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={loadingCell || qty <= 0}
                                onClick={() => void handleRestock(p.id, c, -1)}
                                className="p-1 border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-40"
                                aria-label={`Decrement ${p.name} in ${c}`}
                              >
                                <Minus className="w-3 h-3" />
                              </button>
                              <span
                                className={`w-7 font-mono tabular-nums font-semibold ${
                                  qty === 0
                                    ? 'text-red-700'
                                    : qty <= 3
                                    ? 'text-amber-700'
                                    : 'text-slate-900'
                                }`}
                              >
                                {qty}
                              </span>
                              <button
                                type="button"
                                disabled={loadingCell}
                                onClick={() => void handleRestock(p.id, c, 1)}
                                className="p-1 border border-slate-200 rounded hover:bg-slate-100"
                                aria-label={`Restock ${p.name} in ${c}`}
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-semibold text-slate-900">Stock Movement History</h3>
            </div>
            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto text-xs">
              {snapshot.stockMovements.map((mov) => (
                <div key={mov.id} className="px-6 py-3 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-slate-900">
                      {mov.product_name} ({mov.city})
                    </p>
                    <p className="text-slate-500">
                      {mov.reason} · by {mov.actor_email}
                    </p>
                  </div>
                  <div className="text-right font-mono tabular-nums shrink-0">
                    <span className={mov.delta >= 0 ? 'text-emerald-700' : 'text-amber-700'}>
                      {mov.delta >= 0 ? `+${mov.delta}` : mov.delta}
                    </span>
                    <span className="text-slate-400 mx-1.5">→</span>
                    <span className="font-semibold text-slate-900">{mov.stock_after}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'orders' && (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {snapshot.orders.map((order) => (
            <div
              key={order.id}
              className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 text-xs"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold text-slate-900">{order.id}</span>
                  <span className="text-slate-400">·</span>
                  <span className="capitalize font-semibold text-blue-700">{order.status}</span>
                  <span className="text-slate-400">·</span>
                  <span>{order.city}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono text-slate-500">{formatInr(order.total_inr)}</span>
                </div>
                <p className="text-slate-700">
                  {order.customer_name} ({order.customer_email}) · {order.payment_reference}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {(['packing', 'dispatched', 'delivered'] as OrderStatus[]).map((st) => (
                  <button
                    key={st}
                    type="button"
                    disabled={order.status === 'cancelled' || order.status === st}
                    onClick={() => void handleOrderStatus(order.id, st)}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 capitalize"
                  >
                    Mark {st}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={order.status === 'cancelled'}
                  onClick={() => void handleOrderStatus(order.id, 'cancelled')}
                  className="px-2.5 py-1.5 border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-40"
                >
                  Cancel &amp; Refund Sim
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'analytics' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-600" />
              Revenue by City (INR)
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={snapshot.analytics.revenueByCity}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="city" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="revenue" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Units in Stock by Category
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={snapshot.analytics.categoryPerformance}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="unitsInStock" fill="#0f172a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {tab === 'events' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-900 flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-600" />
                Kafka Topics &amp; Outbox Log (DLQ: {snapshot.metrics.dlqEventsCount})
              </span>
              <span className="font-mono text-slate-500">
                Indexed {formatTimeAgo(snapshot.lastIndexedAt)}
              </span>
            </div>
            <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto text-xs">
              {snapshot.events.map((evt) => (
                <div key={evt.offset_id} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-400">#{evt.offset_id}</span>
                      <span className="font-mono font-semibold text-blue-700">{evt.topic}</span>
                      <span className="font-medium text-slate-900">{evt.event_type}</span>
                    </div>
                    <p className="font-mono text-[11px] text-slate-500 truncate">
                      Retries: {evt.retry_count} · Groups: {evt.consumer_groups_processed.join(', ')}
                    </p>
                  </div>
                  {authUser?.role === 'Administrator' && (
                    <button
                      type="button"
                      onClick={() => void handleReplayEvent(evt.event_id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-200 rounded text-[11px] hover:bg-slate-50 shrink-0"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Replay
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 text-xs font-semibold text-slate-900">
              Security &amp; Operations Audit Logs
            </div>
            <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto text-xs">
              {snapshot.auditLogs.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  No administrative audit actions recorded yet.
                </div>
              ) : (
                snapshot.auditLogs.map((log) => (
                  <div key={log.id} className="px-5 py-3 space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold text-slate-900">{log.action}</span>
                      <span className="font-mono text-[11px] text-slate-400">
                        {formatTimeAgo(log.created_at)}
                      </span>
                    </div>
                    <p className="text-slate-700">{log.details}</p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {log.actor_email} ({log.actor_role})
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
