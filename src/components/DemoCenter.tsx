import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  MailCheck,
  MapPin,
  Play,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type {
  CityName,
  InfrastructureStatus,
  NotificationRecord,
  Product,
  RaceTestReport,
  SearchResponse,
  StreamEventRecord,
} from '../types/storestream';
import { formatInr, formatTimeAgo } from '../utils/currency';

interface DemoCenterProps {
  cities: CityName[];
  products: Product[];
  events: StreamEventRecord[];
  confirmations: NotificationRecord[];
  infrastructure: InfrastructureStatus;
  lastIndexedAt: string;
  metrics: {
    totalOrders: number;
    totalEventsProcessed: number;
    indexedDocuments: number;
    oversellsPrevented: number;
    confirmationsSent: number;
    activeCartItems: number;
  };
  onRunRaceTest: (productId: string, city: CityName) => Promise<RaceTestReport>;
  onResetRaceStock: (productId: string, city: CityName) => Promise<void>;
  onJumpToStorefrontSearch: (query: string, city?: CityName) => void;
}

export function DemoCenter({
  cities,
  products,
  events,
  confirmations,
  infrastructure,
  lastIndexedAt,
  metrics,
  onRunRaceTest,
  onResetRaceStock,
  onJumpToStorefrontSearch,
}: DemoCenterProps) {
  // Demo 1 state
  const [demoQuery, setDemoQuery] = useState('bluetoth');
  const [demoSearchRes, setDemoSearchRes] = useState<SearchResponse | null>(null);
  const [searchingDemo, setSearchingDemo] = useState(false);

  // Demo 2 state
  const [raceProductId, setRaceProductId] = useState('prod_earphones');
  const [raceCity, setRaceCity] = useState<CityName>('Bengaluru');
  const [isTestingRace, setIsTestingRace] = useState(false);
  const [isResettingRace, setIsResettingRace] = useState(false);
  const [raceReport, setRaceReport] = useState<RaceTestReport | null>(null);

  // Demo 4 city focus
  const [compareCity, setCompareCity] = useState<CityName>('Bengaluru');

  async function runTypoSearchDemo(q: string) {
    setDemoQuery(q);
    setSearchingDemo(true);
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&city=${encodeURIComponent(compareCity)}`
      );
      if (res.ok) {
        const data = (await res.json()) as SearchResponse;
        setDemoSearchRes(data);
      }
    } finally {
      setSearchingDemo(false);
    }
  }

  async function handleRaceSimulation() {
    setIsTestingRace(true);
    try {
      const report = await onRunRaceTest(raceProductId, raceCity);
      setRaceReport(report);
    } finally {
      setIsTestingRace(false);
    }
  }

  async function handleResetToOneUnit() {
    setIsResettingRace(true);
    try {
      await onResetRaceStock(raceProductId, raceCity);
      setRaceReport(null);
    } finally {
      setIsResettingRace(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Honest Infrastructure Mode & Connection Banner */}
      <section className="bg-slate-900 text-white rounded-2xl p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <p className="text-xs font-mono text-blue-300">
              {infrastructure.mode === 'AIVEN_LIVE'
                ? 'AIVEN LIVE INFRASTRUCTURE CONNECTED'
                : 'DEMO MODE · EMBEDDED TRANSACTIONAL & EVENT INFRASTRUCTURE'}
            </p>
            <h2 className="text-xl font-display font-bold mt-1">
              StoreStream Judge Demonstration Center
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-300">
            Last Index Sync: {formatTimeAgo(lastIndexedAt)}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          {[
            { name: 'Primary Source of Truth', desc: infrastructure.postgresql.label, ok: infrastructure.postgresql.connected },
            { name: 'Event Streaming Backbone', desc: infrastructure.kafka.label, ok: infrastructure.kafka.connected },
            { name: 'Search & Discovery Engine', desc: infrastructure.opensearch.label, ok: infrastructure.opensearch.connected },
          ].map((svc) => (
            <div
              key={svc.name}
              className="p-3.5 rounded-xl bg-slate-800/80 border border-slate-700 space-y-1"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{svc.name}</span>
                <Server className={`w-3.5 h-3.5 ${svc.ok ? 'text-emerald-400' : 'text-amber-300'}`} />
              </div>
              <p className="text-slate-300">{svc.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Confirmed Orders</p>
          <p className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900">
            {metrics.totalOrders}
          </p>
          <p className="mt-1 text-xs text-slate-500">Transactional source of truth</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Persisted Cart Qty</p>
          <p className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900">
            {metrics.activeCartItems}
          </p>
          <p className="mt-1 text-xs text-slate-500">DB-backed carts &amp; cart_items</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Outbox Events</p>
          <p className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900">
            {metrics.totalEventsProcessed}
          </p>
          <p className="mt-1 text-xs text-slate-500">order.placed · inventory.changed</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Notifications Sent</p>
          <p className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-slate-900">
            {metrics.confirmationsSent}
          </p>
          <p className="mt-1 text-xs text-slate-500">Idempotent cg-notifications</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Oversells Blocked</p>
          <p className="mt-2 text-2xl font-display font-semibold font-mono tabular-nums text-emerald-700">
            {metrics.oversellsPrevented}
          </p>
          <p className="mt-1 text-xs text-slate-500">Atomic conditional updates</p>
        </div>
      </div>

      {/* DEMO 1: TYPO-TOLERANT SEARCH */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 pb-4 border-b border-slate-100">
          <div>
            <p className="text-xs font-semibold text-blue-700">Demo 1 · Product Discovery</p>
            <h3 className="text-base font-display font-semibold text-slate-900">
              Typo-Tolerant OpenSearch Query Execution
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onJumpToStorefrontSearch(demoQuery, compareCity)}
            className="text-xs font-semibold text-slate-900 underline underline-offset-4 hover:text-blue-700 self-start"
          >
            Open in Storefront →
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={demoQuery}
              onChange={(e) => setDemoQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono"
            />
          </div>
          <button
            type="button"
            disabled={searchingDemo}
            onClick={() => void runTypoSearchDemo(demoQuery)}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 rounded-lg min-h-[38px]"
          >
            {searchingDemo ? 'Querying Index...' : 'Execute Search'}
          </button>
          {['bluetoth', 'samzung phone', 'purifer', 'hedphones'].map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => void runTypoSearchDemo(sample)}
              className="px-3 py-1.5 text-xs font-mono bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md"
            >
              &ldquo;{sample}&rdquo;
            </button>
          ))}
        </div>

        {demoSearchRes && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-slate-700">
                Engine: {demoSearchRes.engine} · Query &ldquo;{demoSearchRes.query}&rdquo; ·{' '}
                {demoSearchRes.total_hits} hit(s) in {demoSearchRes.took_ms}ms
              </span>
              {demoSearchRes.fuzzy_corrected_note && (
                <span className="font-semibold text-blue-700">
                  {demoSearchRes.fuzzy_corrected_note}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {demoSearchRes.hits.slice(0, 3).map((hit) => (
                <div
                  key={hit.id}
                  className="p-3 rounded-lg bg-white border border-slate-200 flex items-center gap-3"
                >
                  <img
                    src={hit.image_url}
                    alt={hit.name}
                    referrerPolicy="no-referrer"
                    className="w-12 h-12 rounded-md object-cover bg-slate-100 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">{hit.name}</p>
                    <p className="font-mono text-slate-600 mt-0.5">
                      {formatInr(hit.price_inr)} · {hit.inventory_by_city[compareCity]?.stock_qty ?? 0} in {compareCity}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* DEMO 2: RACE-PROOF CHECKOUT */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <p className="text-xs font-semibold text-blue-700">Demo 2 · Atomic Transactions</p>
            <h3 className="text-base font-display font-semibold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              Last-Unit Concurrent Checkout Race Lab
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Fires Customer A and Customer B simultaneously against the transactional conditional
              decrement constraint (`quantity &gt;= 1`).
            </p>
          </div>
          <button
            type="button"
            disabled={isResettingRace}
            onClick={() => void handleResetToOneUnit()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border border-slate-200 hover:bg-slate-50 rounded-lg text-slate-700 self-start"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {isResettingRace ? 'Resetting...' : 'Reset Selected Stock to 1 Unit'}
          </button>
        </div>

        <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
          <select
            aria-label="Select product for race test"
            value={raceProductId}
            onChange={(e) => setRaceProductId(e.target.value)}
            className="flex-1 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 min-h-[40px]"
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>

          <select
            aria-label="Select city warehouse for race test"
            value={raceCity}
            onChange={(e) => setRaceCity(e.target.value as CityName)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 min-h-[40px]"
          >
            {cities.map((c) => {
              const prod = products.find((p) => p.id === raceProductId);
              const qty = prod?.inventory_by_city[c]?.stock_qty ?? 0;
              return (
                <option key={c} value={c}>
                  {c} ({qty} in stock)
                </option>
              );
            })}
          </select>

          <button
            type="button"
            disabled={isTestingRace}
            onClick={() => void handleRaceSimulation()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <Play className="w-3.5 h-3.5" />
            {isTestingRace ? 'Firing Concurrent Buyers...' : 'Simulate 2 Simultaneous Buyers'}
          </button>
        </div>

        {raceReport && (
          <div className="pt-4 border-t border-slate-100 space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">{raceReport.productName}</span>
              <span>·</span>
              <span>Warehouse: {raceReport.city}</span>
              <span>·</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                Stock Before: {raceReport.stockBefore} → Final Stock: {raceReport.stockAfter}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {raceReport.outcomes.map((o) => (
                <div
                  key={o.buyer}
                  className={`p-4 rounded-xl border ${
                    o.outcome === 'confirmed'
                      ? 'border-emerald-200 bg-emerald-50/50'
                      : 'border-amber-200 bg-amber-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
                      {o.outcome === 'confirmed' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-700" />
                      )}
                      {o.buyer}
                    </span>
                    <span className="font-mono tabular-nums text-slate-500">
                      HTTP {o.statusCode} · {o.durationMs}ms
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-700">{o.message}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* DEMO 3: KAFKA EVENT CASCADE */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="pb-4 border-b border-slate-100">
          <p className="text-xs font-semibold text-blue-700">Demo 3 · Event-Driven Architecture</p>
          <h3 className="text-base font-display font-semibold text-slate-900">
            Transactional Outbox → Consumer Cascade
          </h3>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs">
          {[
            { n: '01', title: 'Storefront', sub: 'Checkout submit' },
            { n: '02', title: 'Express API', sub: 'Zod + Idempotency' },
            { n: '03', title: 'ACID DB', sub: 'Order + Outbox' },
            { n: '04', title: 'order.placed', sub: 'Partition by city' },
            { n: '05', title: 'cg-inventory', sub: 'Movement ledger' },
            { n: '06', title: 'cg-search-sync', sub: 'Index refresh' },
            { n: '07', title: 'OpenSearch', sub: `${metrics.indexedDocuments} docs synced` },
            { n: '08', title: 'cg-notifications', sub: `${metrics.confirmationsSent} receipts` },
          ].map((node, i) => (
            <div
              key={node.n}
              className="p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between gap-1"
            >
              <div className="flex items-center justify-between text-[11px] font-mono text-blue-700">
                <span>{node.n}</span>
                {i < 7 && <ArrowRight className="w-3 h-3 text-slate-400 hidden lg:inline" />}
              </div>
              <div className="font-semibold text-slate-900 truncate">{node.title}</div>
              <div className="text-[11px] text-slate-500 truncate">{node.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-blue-600" />
                Live Outbox &amp; Kafka Topics
              </span>
              <span className="font-mono text-slate-500">{events.length} recent</span>
            </div>
            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {events.slice(0, 10).map((evt) => (
                <div key={evt.offset_id} className="px-4 py-2.5 text-xs flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-400">#{evt.offset_id}</span>
                      <span className="font-mono font-semibold text-blue-700">{evt.topic}</span>
                      <span className="text-slate-800 font-medium">{evt.event_type}</span>
                    </div>
                    <p className="font-mono text-[11px] text-slate-500 truncate">
                      {evt.event_id} · Groups: {evt.consumer_groups_processed.join(', ') || 'queued'}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-emerald-700 shrink-0">
                    {formatTimeAgo(evt.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
                <MailCheck className="w-3.5 h-3.5 text-emerald-700" />
                Order Notification Consumer Log
              </span>
              <span className="font-mono text-slate-500">{confirmations.length} dispatched</span>
            </div>
            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {confirmations.slice(0, 10).map((c) => (
                <div key={c.id} className="px-4 py-2.5 text-xs space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-slate-900">
                      {c.order_id || 'System'} · {c.city}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {formatTimeAgo(c.dispatched_at)}
                    </span>
                  </div>
                  <p className="text-slate-600">{c.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* DEMO 4: CITY-WISE INVENTORY */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <p className="text-xs font-semibold text-blue-700">Demo 4 · Multi-City Fulfillment</p>
            <h3 className="text-base font-display font-semibold text-slate-900 flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-500" />
              City-Wise Regional Inventory Comparison
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {cities.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCompareCity(c)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  compareCity === c
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Product</th>
                <th className="py-2.5 px-4">Category</th>
                {cities.map((c) => (
                  <th
                    key={c}
                    className={`py-2.5 px-3 text-center whitespace-nowrap ${
                      c === compareCity ? 'text-blue-700 font-semibold' : ''
                    }`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {products.slice(0, 8).map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4 font-medium text-slate-900">{p.name}</td>
                  <td className="py-3 px-4 text-slate-500">{p.category}</td>
                  {cities.map((c) => {
                    const qty = p.inventory_by_city[c]?.stock_qty ?? 0;
                    const active = c === compareCity;
                    return (
                      <td
                        key={c}
                        className={`py-3 px-3 text-center font-mono tabular-nums ${
                          active ? 'bg-blue-50/50 font-semibold' : ''
                        } ${
                          qty === 0
                            ? 'text-red-700'
                            : qty === 1
                            ? 'text-amber-700'
                            : 'text-slate-900'
                        }`}
                      >
                        {qty}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-blue-600" />
            Selected city focus: <strong className="text-slate-900">{compareCity}</strong>
          </span>
          <button
            type="button"
            onClick={() => onJumpToStorefrontSearch('', compareCity)}
            className="font-semibold text-blue-700 hover:underline"
          >
            Browse {compareCity} Storefront →
          </button>
        </div>
      </section>
    </div>
  );
}
