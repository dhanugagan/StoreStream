-- StoreStream Normalized PostgreSQL Schema (Aiven for PostgreSQL)
-- Covers all 17 core domain, transactional outbox, idempotency, and audit tables.

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  state_name TEXT NOT NULL,
  warehouse_code TEXT NOT NULL UNIQUE,
  eta_label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Customer', 'Administrator', 'Inventory Manager')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  default_city TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  city_id TEXT NOT NULL REFERENCES cities(id),
  line1 TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  price_inr NUMERIC(12, 2) NOT NULL CHECK (price_inr >= 0),
  discount_pct INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 90),
  rating NUMERIC(3, 2) NOT NULL DEFAULT 4.5 CHECK (rating >= 0 AND rating <= 5),
  popularity INTEGER NOT NULL DEFAULT 50,
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL,
  specs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, city_id)
);

CREATE TABLE IF NOT EXISTS carts (
  session_id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  city_id TEXT NOT NULL REFERENCES cities(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
  session_id TEXT NOT NULL REFERENCES carts(session_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  city_id TEXT NOT NULL REFERENCES cities(id),
  shipping_address TEXT NOT NULL,
  subtotal_inr NUMERIC(12, 2) NOT NULL,
  tax_inr NUMERIC(12, 2) NOT NULL,
  delivery_inr NUMERIC(12, 2) NOT NULL,
  total_inr NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'packing', 'dispatched', 'delivered', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_inr NUMERIC(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('UPI_SIMULATION', 'CARD_SIMULATION', 'COD_SIMULATION')),
  status TEXT NOT NULL CHECK (status IN ('simulated_authorized', 'simulated_refunded')),
  amount_inr NUMERIC(12, 2) NOT NULL,
  reference_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transactional Outbox Pattern: written inside the same ACID transaction as orders & inventory
CREATE TABLE IF NOT EXISTS events_outbox (
  offset_id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL CHECK (topic IN ('order.placed', 'inventory.changed', 'order.confirmed', 'order.cancelled', 'product.updated', 'storestream.dlq')),
  event_type TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  consumer_status TEXT NOT NULL DEFAULT 'committed',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Application-Level Idempotency Guard for Independent Kafka Consumers
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  city TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app_and_email_sim',
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_inventory_city ON inventory(city_id, quantity);
CREATE INDEX IF NOT EXISTS idx_orders_city ON orders(city_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON events_outbox(consumer_status, offset_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(dispatched_at DESC);
