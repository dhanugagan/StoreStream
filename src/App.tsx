import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, LogOut, MapPin, Search, ShoppingBag, User, X } from 'lucide-react';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthModal } from './components/AuthModal';
import { CartDrawer } from './components/CartDrawer';
import { DemoCenter } from './components/DemoCenter';
import { NotificationDrawer } from './components/NotificationDrawer';
import { OrdersView } from './components/OrdersView';
import { ProductCard } from './components/ProductCard';
import { ProductDetailModal } from './components/ProductDetailModal';
import type {
  AuthUser,
  CartItem,
  CityName,
  PaymentMethod,
  PersistedCart,
  Product,
  ProductCategory,
  RaceTestReport,
  SearchResponse,
  SearchSuggestion,
  SortOption,
  StoreOrder,
  StoreSnapshot,
} from './types/storestream';
import { formatInr } from './utils/currency';

type ActiveView = 'storefront' | 'demo' | 'admin' | 'orders';

const CATEGORIES: Array<ProductCategory | 'all'> = [
  'all',
  'Electronics',
  'Fashion',
  'Home and Kitchen',
  'Grocery',
  'Accessories',
  'Beauty',
  'Sports',
];

const TYPO_DEMOS = ['bluetoth', 'samzung phone', 'purifer', 'hedphones'];

function getOrCreateSessionId(): string {
  try {
    const key = 'storestream_bag_session';
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = `sess_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return 'storefront-session';
  }
}

export default function App() {
  const [sessionId] = useState<string>(() => getOrCreateSessionId());
  const [view, setView] = useState<ActiveView>('storefront');
  const [snapshot, setSnapshot] = useState<StoreSnapshot | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Auth State (JWT held strictly in memory)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Storefront Search & Facet Controls
  const [selectedCity, setSelectedCity] = useState<CityName>('Bengaluru');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ProductCategory | 'all'>('all');
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [maxPrice, setMaxPrice] = useState<number>(200000);
  const [minRating, setMinRating] = useState<number>(0);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('relevance');

  // Persisted Cart & Drawers
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch('/api/store/snapshot');
      if (!res.ok) throw new Error('Failed to load StoreStream data.');
      const data = (await res.json()) as StoreSnapshot;
      setSnapshot(data);
      setErrorBanner(null);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to reach StoreStream server.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPersistedCart = useCallback(async () => {
    try {
      const res = await fetch(`/api/cart?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as PersistedCart;
      setCart(data.items);
      setSelectedCity(data.city);
    } catch {
      // Ignore transient cart fetch issue
    }
  }, [sessionId]);

  const runSearch = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        q: searchQuery,
        city: selectedCity,
        category: selectedCategory,
        brand: selectedBrand,
        maxPrice: String(maxPrice),
        minRating: String(minRating),
        inStockOnly: String(inStockOnly),
        sort: sortBy,
      });
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) throw new Error('Search request failed.');
      const data = (await res.json()) as SearchResponse;
      setSearchResult(data);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Search failed.');
    }
  }, [
    searchQuery,
    selectedCity,
    selectedCategory,
    selectedBrand,
    maxPrice,
    minRating,
    inStockOnly,
    sortBy,
  ]);

  useEffect(() => {
    void fetchSnapshot();
    void fetchPersistedCart();
  }, [fetchSnapshot, fetchPersistedCart]);

  useEffect(() => {
    void runSearch();
  }, [runSearch, snapshot]);

  // Autocomplete Suggestions from OpenSearch
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(q)}&city=${encodeURIComponent(selectedCity)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { suggestions?: SearchSuggestion[] } | null) => {
          if (d?.suggestions) setSuggestions(d.suggestions);
        })
        .catch(() => {});
    }, 120);
    return () => window.clearTimeout(timer);
  }, [searchQuery, selectedCity]);

  // Real-Time WebSocket Sync (with clean HTTP polling fallback on serverless hosts like Vercel)
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;

    async function initRealtime() {
      let useWs = true;
      try {
        const healthRes = await fetch('/api/health');
        if (healthRes.ok) {
          const health = (await healthRes.json()) as { realtimeTransport?: string };
          if (health.realtimeTransport === 'http') {
            useWs = false;
          }
        }
      } catch {
        // Proceed with WebSocket check
      }

      if (disposed) return;

      if (!useWs) {
        pollTimer = window.setInterval(() => {
          if (document.visibilityState === 'visible') {
            void fetchSnapshot();
          }
        }, 12000);
        return;
      }

      let failedAttempts = 0;

      function connect() {
        if (disposed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
        wsRef.current = socket;
        let opened = false;

        socket.onopen = () => {
          opened = true;
          failedAttempts = 0;
          void fetchSnapshot();
          void fetchPersistedCart();
        };

        socket.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data as string) as { event: string; payload: unknown };
            if (msg.event === 'store:synced') {
              setSnapshot(msg.payload as StoreSnapshot);
            } else if (msg.event === 'stream:consumer_ack') {
              const ack = msg.payload as {
                event: { topic: string; event_type: string; partition_key: string };
              };
              setLiveNotice(`Stream ${ack.event.topic} (${ack.event.partition_key}) synced`);
              void fetchSnapshot();
            }
          } catch {
            // Ignore invalid frames
          }
        };

        socket.onclose = () => {
          if (disposed) return;
          if (!opened) {
            failedAttempts++;
          }
          if (failedAttempts >= 2) {
            pollTimer = window.setInterval(() => {
              if (document.visibilityState === 'visible') {
                void fetchSnapshot();
              }
            }, 12000);
            return;
          }
          reconnectTimer = window.setTimeout(connect, 2500);
        };
      }

      connect();
    }

    void initRealtime();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (pollTimer) window.clearInterval(pollTimer);
      wsRef.current?.close();
    };
  }, [fetchSnapshot, fetchPersistedCart]);

  useEffect(() => {
    if (!liveNotice) return;
    const t = window.setTimeout(() => setLiveNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [liveNotice]);

  const totalBagCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.qty, 0),
    [cart]
  );

  const unreadNotifCount = useMemo(
    () => (snapshot?.confirmations || []).filter((n) => !n.is_read).length,
    [snapshot]
  );

  const categoryFacetCounts = useMemo(() => {
    const map = new Map<ProductCategory, number>();
    for (const c of searchResult?.facets.categories || []) {
      map.set(c.category, c.count);
    }
    return map;
  }, [searchResult]);

  async function handleSelectCity(city: CityName) {
    setSelectedCity(city);
    setCart([]);
    try {
      const res = await fetch('/api/cart/city', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, city }),
      });
      if (res.ok) {
        const updated = (await res.json()) as PersistedCart;
        setCart(updated.items);
      }
    } catch {
      // Ignore transient error
    }
  }

  async function handleAddToCart(productId: string, qty = 1) {
    const res = await fetch('/api/cart/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, city: selectedCity, productId, delta: qty }),
    });
    if (res.ok) {
      const updated = (await res.json()) as PersistedCart;
      setCart(updated.items);
      setLiveNotice('Bag persisted to database');
    }
  }

  async function handleUpdateCartQty(productId: string, delta: number) {
    const res = await fetch('/api/cart/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, city: selectedCity, productId, delta }),
    });
    if (res.ok) {
      const updated = (await res.json()) as PersistedCart;
      setCart(updated.items);
    }
  }

  async function handleRemoveCartItem(productId: string) {
    const res = await fetch(
      `/api/cart/items/${encodeURIComponent(productId)}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      const updated = (await res.json()) as PersistedCart;
      setCart(updated.items);
    }
  }

  async function handleCheckout(customer: {
    customerName: string;
    customerEmail: string;
    shippingAddress: string;
    paymentMethod: PaymentMethod;
    idempotencyKey: string;
  }): Promise<StoreOrder> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': customer.idempotencyKey,
    };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const res = await fetch('/api/orders/checkout', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        ...customer,
        city: selectedCity,
        items: cart,
      }),
    });
    const data = (await res.json()) as {
      order?: StoreOrder;
      snapshot?: StoreSnapshot;
      error?: string;
    };
    if (data.snapshot) setSnapshot(data.snapshot);
    if (!res.ok || !data.order) {
      throw new Error(data.error || 'Checkout failed.');
    }
    setCart([]);
    return data.order;
  }

  async function handleRunRaceTest(productId: string, city: CityName): Promise<RaceTestReport> {
    const res = await fetch('/api/orders/race-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, city }),
    });
    const data = (await res.json()) as {
      report?: RaceTestReport;
      snapshot?: StoreSnapshot;
      error?: string;
    };
    if (data.snapshot) setSnapshot(data.snapshot);
    if (!res.ok || !data.report) {
      throw new Error(data.error || 'Race simulation failed.');
    }
    return data.report;
  }

  async function handleResetRaceStock(productId: string, city: CityName) {
    const res = await fetch('/api/demo/reset-race-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, city }),
    });
    const data = (await res.json()) as { snapshot?: StoreSnapshot };
    if (data.snapshot) setSnapshot(data.snapshot);
    setLiveNotice(`Reset ${city} stock to 1 unit for race test`);
  }

  async function handleMarkNotificationsRead() {
    const res = await fetch('/api/notifications/mark-read', { method: 'POST' });
    const data = (await res.json()) as { snapshot?: StoreSnapshot };
    if (data.snapshot) setSnapshot(data.snapshot);
  }

  const cities = snapshot?.cities || [
    'Bengaluru',
    'Mumbai',
    'Delhi NCR',
    'Hyderabad',
    'Chennai',
    'Pune',
  ];
  const hits = searchResult?.hits || [];
  const featuredProducts = useMemo(
    () => (snapshot?.products || []).filter((p) => p.is_featured).slice(0, 4),
    [snapshot]
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setView('storefront');
            }}
            className="text-xl font-display font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            StoreStream
          </a>

          <nav className="flex items-center gap-6 text-sm font-medium text-slate-600">
            {(
              [
                ['storefront', 'Storefront'],
                ['demo', 'Demo Center'],
                ['admin', 'Admin'],
                ['orders', 'Orders'],
              ] as Array<[ActiveView, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  view === id
                    ? 'text-slate-900 border-slate-900'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              <span className="font-mono tabular-nums">Bag ({totalBagCount})</span>
            </button>
          </div>
        </div>
      </header>

      {/* Sub-Header Utility Toolbar (City Switcher, Mode Status, Notifications, Account) */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-8 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-slate-600">
            <span className="font-semibold text-slate-900">Zero limits. Zero oversells.</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono text-slate-500">
              {snapshot?.infrastructure.mode === 'AIVEN_LIVE'
                ? 'Aiven Live Cluster'
                : 'DEMO MODE (Transactional Outbox + Local Fuzzy Engine)'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-slate-700">
              <MapPin className="w-3.5 h-3.5 text-blue-600" />
              <select
                aria-label="Active delivery city"
                value={selectedCity}
                onChange={(e) => void handleSelectCity(e.target.value as CityName)}
                className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs font-medium text-slate-900"
              >
                {cities.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => setNotificationsOpen(true)}
              className="inline-flex items-center gap-1.5 text-slate-700 hover:text-slate-900 whitespace-nowrap"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Notifications ({unreadNotifCount})</span>
            </button>

            {authUser ? (
              <div className="inline-flex items-center gap-2 text-slate-700">
                <User className="w-3.5 h-3.5 text-blue-600" />
                <span className="font-medium">
                  {authUser.name} ({authUser.role})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAuthUser(null);
                    setAuthToken(null);
                  }}
                  className="text-slate-400 hover:text-red-700 inline-flex items-center gap-1"
                  title="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                <User className="w-3.5 h-3.5" />
                Sign In / Register
              </button>
            )}
          </div>
        </div>
      </div>

      <main id="top" className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-8 py-8 space-y-10">
        {errorBanner && (
          <div
            role="alert"
            className="p-4 rounded-xl border border-red-200 bg-red-50 flex items-center justify-between text-xs text-red-800"
          >
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="p-1"
              aria-label="Dismiss error"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {loading || !snapshot ? (
          <div className="space-y-6 animate-pulse">
            <div className="h-72 bg-slate-200 rounded-2xl" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-80 bg-slate-200 rounded-xl" />
              ))}
            </div>
          </div>
        ) : view === 'storefront' ? (
          <>
            {/* Section 1: Hero & Instant Autocomplete Typo-Tolerant Search */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-between gap-6">
                <div className="space-y-3">
                  <p className="text-xs font-medium text-blue-700">
                    Transactional Inventory · Event-Driven Sync · 6 Indian City Warehouses
                  </p>
                  <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-slate-900 text-balance leading-[1.12]">
                    Zero limits. Zero oversells across every city storefront.
                  </h1>
                  <p className="text-sm sm:text-base text-slate-600 max-w-xl leading-relaxed">
                    Every product is indexed with typo tolerance, every bag persists to the database,
                    and atomic stock transactions prevent two buyers from purchasing the same last unit.
                  </p>
                </div>

                <div className="space-y-3 relative">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="search"
                        value={searchQuery}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setShowSuggestions(true);
                        }}
                        placeholder='Search 32 products or test a typo like "bluetoth" or "samzung phone"...'
                        className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600 min-h-[44px]"
                      />

                      {showSuggestions && suggestions.length > 0 && (
                        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 bg-white border border-slate-200 rounded-xl shadow-lg divide-y divide-slate-100">
                          {suggestions.map((sug) => (
                            <button
                              key={sug.product_id}
                              type="button"
                              onMouseDown={() => {
                                const prod = snapshot.products.find((p) => p.id === sug.product_id);
                                if (prod) setSelectedProduct(prod);
                                setShowSuggestions(false);
                              }}
                              className="w-full px-4 py-2.5 text-left text-xs flex items-center justify-between hover:bg-slate-50"
                            >
                              <div>
                                <p className="font-semibold text-slate-900">{sug.name}</p>
                                <p className="text-slate-500">
                                  {sug.brand} · {sug.category}
                                </p>
                              </div>
                              <div className="text-right font-mono">
                                <div className="text-slate-900">{formatInr(sug.price_inr)}</div>
                                <div className="text-slate-400">
                                  {sug.stock_in_city} in {selectedCity}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>Try typo search:</span>
                    {TYPO_DEMOS.map((typo) => (
                      <button
                        key={typo}
                        type="button"
                        onClick={() => setSearchQuery(typo)}
                        className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono transition-colors"
                      >
                        &ldquo;{typo}&rdquo;
                      </button>
                    ))}
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="text-blue-700 hover:underline ml-1"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5 bg-slate-100 min-h-[260px]">
                <img
                  src="/src/assets/images/product_bluetooth_earphones_1795314720308.jpg"
                  alt="Acoustic Pulse Bluetooth Earphones"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
            </section>

            {/* Section 2: Featured Collection Strip */}
            {!searchQuery && selectedCategory === 'all' && (
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-display font-semibold text-slate-900">
                    Featured Highlights in {selectedCity}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setView('demo')}
                    className="text-xs font-semibold text-blue-700 hover:underline"
                  >
                    Launch Judge Race &amp; Event Demos →
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                  {featuredProducts.map((p) => {
                    const qty = p.inventory_by_city[selectedCity]?.stock_qty ?? 0;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelectedProduct(p)}
                        className="bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-4 text-left flex items-center gap-3.5 transition-colors"
                      >
                        <img
                          src={p.image_url}
                          alt={p.name}
                          referrerPolicy="no-referrer"
                          className="w-16 h-16 rounded-lg object-cover bg-slate-100 shrink-0"
                        />
                        <div className="min-w-0">
                          <p className="text-[11px] uppercase tracking-wider text-slate-500">
                            {p.category}
                          </p>
                          <p className="text-xs font-semibold text-slate-900 truncate mt-0.5">
                            {p.name}
                          </p>
                          <p className="text-xs font-mono tabular-nums text-slate-700 mt-1">
                            {formatInr(p.price_inr)} · {qty} left
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Section 3: Faceted Filters & 3-Column Product Grid */}
            <section className="space-y-6">
              <div className="space-y-4 pb-4 border-b border-slate-200">
                <div
                  className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg"
                  role="group"
                  aria-label="Product categories"
                >
                  {CATEGORIES.map((cat) => {
                    const count =
                      cat === 'all'
                        ? snapshot.products.length
                        : categoryFacetCounts.get(cat) || 0;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setSelectedCategory(cat)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[34px] ${
                          selectedCategory === cat
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {cat === 'all' ? `All (${count})` : `${cat} (${count})`}
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-slate-700">
                      <input
                        type="checkbox"
                        checked={inStockOnly}
                        onChange={(e) => setInStockOnly(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600"
                      />
                      <span>
                        In stock in {selectedCity} ({searchResult?.facets.in_stock_in_city ?? 0})
                      </span>
                    </label>

                    <label className="inline-flex items-center gap-1.5 text-slate-700">
                      <span>Brand:</span>
                      <select
                        aria-label="Filter by brand"
                        value={selectedBrand}
                        onChange={(e) => setSelectedBrand(e.target.value)}
                        className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md text-xs"
                      >
                        <option value="all">All Brands</option>
                        {(searchResult?.facets.brands || []).map((b) => (
                          <option key={b.brand} value={b.brand}>
                            {b.brand} ({b.count})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="inline-flex items-center gap-1.5 text-slate-700">
                      <span>Max Price:</span>
                      <select
                        aria-label="Maximum price filter"
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(Number(e.target.value))}
                        className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md font-mono text-xs"
                      >
                        <option value={2000}>Up to ₹2,000</option>
                        <option value={5000}>Up to ₹5,000</option>
                        <option value={15000}>Up to ₹15,000</option>
                        <option value={40000}>Up to ₹40,000</option>
                        <option value={200000}>All Prices</option>
                      </select>
                    </label>

                    <label className="inline-flex items-center gap-1.5 text-slate-700">
                      <span>Rating:</span>
                      <select
                        aria-label="Minimum rating filter"
                        value={minRating}
                        onChange={(e) => setMinRating(Number(e.target.value))}
                        className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md text-xs"
                      >
                        <option value={0}>Any Rating</option>
                        <option value={4.5}>4.5★ &amp; above</option>
                        <option value={4.8}>4.8★ &amp; above</option>
                      </select>
                    </label>
                  </div>

                  <label className="inline-flex items-center gap-1.5 text-slate-700">
                    <span>Sort:</span>
                    <select
                      aria-label="Sort products"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortOption)}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md text-xs"
                    >
                      <option value="relevance">Relevance</option>
                      <option value="popularity">Popularity</option>
                      <option value="price_asc">Price: Low to High</option>
                      <option value="price_desc">Price: High to Low</option>
                      <option value="rating">Customer Rating</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums text-slate-800 font-medium">
                    {hits.length} product{hits.length === 1 ? '' : 's'}
                  </span>
                  <span>·</span>
                  <span>Fulfillment: {selectedCity}</span>
                  {searchResult?.fuzzy_corrected_note && (
                    <>
                      <span>·</span>
                      <span className="text-blue-700 font-medium">
                        {searchResult.fuzzy_corrected_note}
                      </span>
                    </>
                  )}
                </div>
                {searchResult && (
                  <span className="font-mono tabular-nums text-slate-400">
                    {searchResult.engine === 'opensearch_live' ? 'OpenSearch Live' : 'Local Fuzzy Index'} · {searchResult.took_ms}ms
                  </span>
                )}
              </div>

              {hits.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
                  <p className="text-sm font-medium text-slate-900">
                    No matching products in {selectedCity}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedCategory('all');
                      setSelectedBrand('all');
                      setMaxPrice(200000);
                      setMinRating(0);
                      setInStockOnly(false);
                    }}
                    className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
                  {hits.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      city={selectedCity}
                      cartQty={cart.find((c) => c.productId === product.id)?.qty || 0}
                      onSelect={(p) => setSelectedProduct(p)}
                      onAddToCart={(id) => void handleAddToCart(id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Section 4: Architectural Guarantee Strip */}
            <section className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-blue-700">01. Source of Truth</p>
                <h2 className="text-base font-display font-semibold text-slate-900">
                  Race-Proof Transactional Checkout
                </h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Carts, idempotency keys, and city stock live in ACID transactions. Stock decrements
                  atomically (`quantity &gt;= qty`) so last units never oversell.
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-blue-700">02. Event Backbone</p>
                <h2 className="text-base font-display font-semibold text-slate-900">
                  Outbox &amp; Idempotent Consumers
                </h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Committed orders write to the transactional outbox and trigger independent inventory,
                  search-sync, and notification consumers deduplicated via processed_events.
                </p>
              </div>
              <div className="space-y-1.5 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-blue-700">03. Discovery Engine</p>
                  <h2 className="text-base font-display font-semibold text-slate-900">
                    OpenSearch Typo Discovery
                  </h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Multi-field fuzzy search resolves &ldquo;bluetoth&rdquo; and &ldquo;samzung phone&rdquo;
                    instantly with live city availability facets.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setView('demo')}
                  className="mt-3 self-start text-xs font-semibold text-slate-900 underline underline-offset-4 hover:text-blue-700"
                >
                  Open Live Hackathon Demo Center →
                </button>
              </div>
            </section>
          </>
        ) : view === 'demo' ? (
          <DemoCenter
            cities={cities}
            products={snapshot.products}
            events={snapshot.events}
            confirmations={snapshot.confirmations}
            infrastructure={snapshot.infrastructure}
            lastIndexedAt={snapshot.lastIndexedAt}
            metrics={snapshot.metrics}
            onRunRaceTest={handleRunRaceTest}
            onResetRaceStock={handleResetRaceStock}
            onJumpToStorefrontSearch={(q, city) => {
              if (city) void handleSelectCity(city);
              setSearchQuery(q);
              setView('storefront');
            }}
          />
        ) : view === 'admin' ? (
          <AdminDashboard
            snapshot={snapshot}
            authUser={authUser}
            authToken={authToken}
            onAuthenticated={(user, token) => {
              setAuthUser(user);
              setAuthToken(token);
            }}
            onRefreshSnapshot={(updated) => {
              if (updated) setSnapshot(updated);
              else void fetchSnapshot();
            }}
          />
        ) : (
          <OrdersView orders={snapshot.orders} confirmations={snapshot.confirmations} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-6 px-4 sm:px-8">
        <div className="max-w-[1280px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>StoreStream — Zero Limits. Zero Oversells. · Built for the Aiven Online Store Challenge</span>
          <span>Bengaluru · Mumbai · Delhi NCR · Hyderabad · Chennai · Pune</span>
        </div>
      </footer>

      <ProductDetailModal
        product={
          selectedProduct
            ? snapshot?.products.find((p) => p.id === selectedProduct.id) || selectedProduct
            : null
        }
        allProducts={snapshot?.products || []}
        cities={cities}
        selectedCity={selectedCity}
        onSelectCity={(c) => void handleSelectCity(c)}
        onSelectProduct={(p) => setSelectedProduct(p)}
        onAddToCart={(id, qty) => void handleAddToCart(id, qty)}
        onClose={() => setSelectedProduct(null)}
      />

      <CartDrawer
        isOpen={cartOpen}
        city={selectedCity}
        cart={cart}
        products={snapshot?.products || []}
        authUser={authUser}
        onClose={() => setCartOpen(false)}
        onUpdateQty={(id, delta) => void handleUpdateCartQty(id, delta)}
        onRemoveItem={(id) => void handleRemoveCartItem(id)}
        onCheckout={handleCheckout}
      />

      <NotificationDrawer
        isOpen={notificationsOpen}
        notifications={snapshot?.confirmations || []}
        onClose={() => setNotificationsOpen(false)}
        onMarkAllRead={handleMarkNotificationsRead}
      />

      <AuthModal
        isOpen={authModalOpen}
        cities={cities}
        defaultCity={selectedCity}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={(user, token) => {
          setAuthUser(user);
          setAuthToken(token);
          if (user.default_city && user.default_city !== selectedCity) {
            void handleSelectCity(user.default_city);
          }
        }}
      />

      {liveNotice && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 bg-slate-900 text-white text-xs px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 max-w-sm"
        >
          <span className="flex-1">{liveNotice}</span>
          <button
            type="button"
            onClick={() => setLiveNotice(null)}
            className="text-slate-400 hover:text-white"
            aria-label="Dismiss notice"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
