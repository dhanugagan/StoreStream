export type CityName =
  | 'Bengaluru'
  | 'Mumbai'
  | 'Delhi NCR'
  | 'Hyderabad'
  | 'Chennai'
  | 'Pune';

export type ProductCategory =
  | 'Electronics'
  | 'Fashion'
  | 'Home and Kitchen'
  | 'Grocery'
  | 'Accessories'
  | 'Beauty'
  | 'Sports';

export type UserRole = 'Customer' | 'Administrator' | 'Inventory Manager';

export type PaymentMethod = 'UPI_SIMULATION' | 'CARD_SIMULATION' | 'COD_SIMULATION';

export type OrderStatus = 'confirmed' | 'packing' | 'dispatched' | 'delivered' | 'cancelled';

export type EventTopic =
  | 'order.placed'
  | 'inventory.changed'
  | 'order.confirmed'
  | 'order.cancelled'
  | 'product.updated'
  | 'storestream.dlq';

export type SortOption = 'relevance' | 'price_asc' | 'price_desc' | 'popularity' | 'rating';

export interface CityInventory {
  product_id: string;
  city: CityName;
  warehouse_code: string;
  stock_qty: number;
  low_stock_threshold: number;
  eta_label: string;
  updated_at: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: ProductCategory;
  price_inr: number;
  discount_pct: number;
  rating: number;
  popularity: number;
  is_featured: boolean;
  description: string;
  specs: string[];
  image_url: string;
  tags: string[];
  inventory_by_city: Record<CityName, CityInventory>;
}

export interface SearchProductHit extends Product {
  relevance_score: number;
  matched_via: 'exact' | 'prefix' | 'fuzzy';
  matched_term?: string;
}

export interface SearchSuggestion {
  product_id: string;
  name: string;
  brand: string;
  category: ProductCategory;
  price_inr: number;
  stock_in_city: number;
  matched_via: 'exact' | 'prefix' | 'fuzzy';
}

export interface SearchResponse {
  query: string;
  city: CityName;
  total_hits: number;
  fuzzy_corrected_note: string | null;
  took_ms: number;
  engine: 'opensearch_live' | 'opensearch_local_demo';
  last_indexed_at: string;
  hits: SearchProductHit[];
  facets: {
    categories: Array<{ category: ProductCategory; count: number }>;
    brands: Array<{ brand: string; count: number }>;
    city_stock: Array<{ city: CityName; in_stock_count: number }>;
    in_stock_in_city: number;
  };
}

export interface OrderLineItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  qty: number;
  unit_price_inr: number;
}

export interface StoreOrder {
  id: string;
  idempotency_key: string | null;
  customer_name: string;
  customer_email: string;
  city: CityName;
  shipping_address: string;
  subtotal_inr: number;
  tax_inr: number;
  delivery_inr: number;
  total_inr: number;
  payment_method: PaymentMethod;
  payment_status: 'simulated_authorized' | 'simulated_refunded';
  payment_reference: string;
  status: OrderStatus;
  created_at: string;
  items: OrderLineItem[];
}

export interface NotificationRecord {
  id: string;
  order_id: string | null;
  customer_email: string;
  city: CityName;
  channel: string;
  message: string;
  is_read: boolean;
  dispatched_at: string;
}

export interface StreamEventRecord {
  offset_id: number;
  event_id: string;
  topic: EventTopic;
  event_type: string;
  partition_key: string;
  payload: Record<string, unknown>;
  consumer_status: 'committed' | 'processing' | 'indexed_and_confirmed' | 'dlq';
  retry_count: number;
  last_error: string | null;
  consumer_groups_processed: string[];
  created_at: string;
}

export interface StockMovementRecord {
  id: string;
  product_id: string;
  product_name: string;
  city: CityName;
  delta: number;
  stock_after: number;
  reason: string;
  actor_email: string;
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
  created_at: string;
}

export interface CartItem {
  productId: string;
  qty: number;
}

export interface PersistedCart {
  sessionId: string;
  city: CityName;
  items: CartItem[];
  subtotal_inr: number;
  tax_inr: number;
  delivery_inr: number;
  total_inr: number;
  updatedAt: string;
}

export interface RaceBuyerOutcome {
  buyer: string;
  statusCode: number;
  outcome: 'confirmed' | 'rejected_oversell';
  orderId?: string;
  message: string;
  durationMs: number;
}

export interface RaceTestReport {
  productId: string;
  productName: string;
  city: CityName;
  stockBefore: number;
  stockAfter: number;
  outcomes: RaceBuyerOutcome[];
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  default_city: CityName;
}

export interface InfrastructureStatus {
  mode: 'DEMO_MODE' | 'AIVEN_LIVE';
  postgresql: { configured: boolean; connected: boolean; label: string };
  kafka: { configured: boolean; connected: boolean; label: string };
  opensearch: { configured: boolean; connected: boolean; label: string };
}

export interface AnalyticsSummary {
  totalRevenueInr: number;
  totalOrders: number;
  activeCustomers: number;
  lowStockCount: number;
  outOfStockCount: number;
  awaitingProcessingCount: number;
  revenueByCity: Array<{ city: CityName; revenue: number; orders: number }>;
  categoryPerformance: Array<{ category: ProductCategory; products: number; unitsInStock: number; revenue: number }>;
  topProducts: Array<{ id: string; name: string; brand: string; popularity: number; price_inr: number; stockTotal: number }>;
}

export interface StoreSnapshot {
  cities: CityName[];
  categories: ProductCategory[];
  products: Product[];
  orders: StoreOrder[];
  confirmations: NotificationRecord[];
  events: StreamEventRecord[];
  stockMovements: StockMovementRecord[];
  auditLogs: AuditLogRecord[];
  analytics: AnalyticsSummary;
  infrastructure: InfrastructureStatus;
  lastIndexedAt: string;
  metrics: {
    totalProducts: number;
    totalOrders: number;
    totalRevenueInr: number;
    totalEventsProcessed: number;
    indexedDocuments: number;
    oversellsPrevented: number;
    confirmationsSent: number;
    activeCartItems: number;
    dlqEventsCount: number;
  };
}
