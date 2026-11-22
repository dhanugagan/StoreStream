# StoreStream — Zero Limits. Zero Oversells.

A real-time, event-driven multi-city e-commerce platform built for the **Aiven Build the Online Store** challenge.

StoreStream solves the core failure modes of omni-channel retail across multiple Indian cities (**Bengaluru**, **Mumbai**, **Delhi NCR**, **Hyderabad**, **Chennai**, **Pune**):

- **Race-Proof Transactional Checkout** — Atomic conditional stock decrements prevent two concurrent buyers from purchasing the same last unit.
- **Idempotent Request & Event Processing** — `Idempotency-Key` checkout deduplication plus `processed_events(event_id, consumer_group)` guarantees zero duplicate orders or duplicate stock deductions.
- **Transactional Outbox + Kafka Event Backbone** — Every order, inventory mutation, and product change writes to an ACID outbox table and dispatches to partitioned topics (`order.placed`, `inventory.changed`, `order.confirmed`, `order.cancelled`, `product.updated`, `storestream.dlq`).
- **Typo-Tolerant OpenSearch Discovery** — Fuzzy matching (Damerau-Levenshtein), live autocomplete suggestions, and faceted filtering (`category`, `brand`, `city`, `price`, `rating`, `inStockOnly`) resolve misspellings such as `"bluetoth"` or `"samzung phone"`.
- **Zero-Config Demo Mode & Live Aiven Ready** — Boots immediately with embedded ACID SQLite WAL, transactional outbox consumers, and local fuzzy indexing when external Aiven secrets are unset, or connects directly to managed **Aiven PostgreSQL**, **Aiven Apache Kafka**, and **Aiven OpenSearch**.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Key Features](#key-features)
4. [Folder Structure](#folder-structure)
5. [Local Development (DEMO MODE)](#local-development-demo-mode)
6. [Connecting Live Aiven Infrastructure](#connecting-live-aiven-infrastructure)
7. [Environment Variables](#environment-variables)
8. [REST API & Realtime Endpoints](#rest-api--realtime-endpoints)
9. [Security & Role-Based Access Control](#security--role-based-access-control)
10. [Automated & Load Testing](#automated--load-testing)
11. [Deploying to Vercel](#deploying-to-vercel)
12. [Hackathon Judge Demo Walkthrough](#hackathon-judge-demo-walkthrough)
13. [License](#license)

---

## Architecture Overview

```text
React 19 + Tailwind Storefront (Vite SPA)
   │
   ├── REST API (/api/*) ──────────────────────────► Express API (server/app.ts)
   │                                                   │
   └── Realtime Sync (/ws on Node · 12s HTTP poll      ├──► Transactional Store (Aiven PostgreSQL / SQLite WAL)
       fallback on Vercel Serverless)                  │      ├── Conditional Stock Decrement (quantity >= qty)
                                                       │      ├── Idempotency Keys & Shopping Cart Persistence
                                                       │      └── Transactional Outbox (events_outbox)
                                                       │
                                                       ├──► Event Bus & Kafka Producer (server/event-bus.ts)
                                                       │      └── Workers: cg-inventory | cg-search-sync | cg-notifications
                                                       │
                                                       └──► Product Search Engine (server/search-engine.ts)
                                                              └── Aiven OpenSearch / Fuzzy Damerau-Levenshtein Index
```

### Three Mandatory Aiven Pillars

1. **Primary Database (`Aiven PostgreSQL` / `SQLite WAL` in Demo Mode)**
   - Complete 17-table relational schema (`infrastructure/database/schema.sql`) covering `users`, `customers`, `addresses`, `categories`, `brands`, `cities`, `products`, `inventory`, `carts`, `cart_items`, `orders`, `order_items`, `payments`, `events_outbox`, `processed_events`, `notifications`, and `audit_logs`.
   - Enforces atomic conditional inventory decrement (`UPDATE ... SET quantity = quantity - $1 WHERE product_id = $2 AND city = $3 AND quantity >= $1`) inside serializable transactions.

2. **Event Backbone (`Aiven Apache Kafka` / Transactional Outbox Relay)**
   - Topics: `order.placed`, `inventory.changed`, `order.confirmed`, `order.cancelled`, `product.updated`, and dead-letter queue `storestream.dlq`.
   - Independent idempotent consumer groups in `workers/event-consumers.ts`:
     - `cg-inventory`: Records stock movement ledgers and detects low-stock alerts (`<= 3` units).
     - `cg-search-sync`: Synchronizes product availability and city stock counts to OpenSearch.
     - `cg-notifications`: Persists customer confirmation receipts, emits `order.confirmed`, and triggers live UI updates.

3. **Search & Discovery (`Aiven OpenSearch` / Embedded Fuzzy & Faceted Engine)**
   - Index mapping in `infrastructure/opensearch/index-mapping.json`.
   - Supports typo-tolerant multi-field matching, instant prefix autocomplete (`/api/search/suggest`), dynamic facet aggregations, and sorting by relevance, price, popularity, or rating.

---

## Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide React, Recharts |
| **Backend** | Node.js (>=20), Express 4, Zod validation, Multer uploads, WebSockets (`ws`) |
| **Database** | Aiven PostgreSQL (`pg`) + Local ACID fallback (`better-sqlite3` WAL) |
| **Event Streaming** | Aiven Apache Kafka (`kafkajs`) + Transactional Outbox & Idempotent Workers |
| **Search** | Aiven OpenSearch (`@opensearch-project/opensearch`) + Embedded Fuzzy Engine |
| **Testing** | Vitest integration suite (`tests/storestream.test.ts`), k6 concurrency script (`tests/load/checkout-race.k6.js`) |
| **Deployment** | Vercel (static `dist/` + serverless `api/index.mjs`) or persistent Node (`server.ts`) |

---

## Key Features

- **Customer Storefront**: City selector across 6 Indian hubs with live regional stock and delivery ETAs, 32 seeded products across 7 categories (`Electronics`, `Fashion`, `Home and Kitchen`, `Grocery`, `Accessories`, `Beauty`, `Sports`), persistent cart drawer with automatic 18% GST and shipping breakdown, simulated payment methods (`UPI_SIMULATION`, `CARD_SIMULATION`, `COD_SIMULATION`), order history, and confirmation inbox.
- **Interactive Demo Center**: 4 guided interactive demos proving typo-tolerant search, 2-buyer last-unit concurrency race protection, live Kafka consumer cascade & DLQ visibility, and city-wise warehouse comparison.
- **Admin Operations Console**: RBAC-protected console (`Administrator`, `Inventory Manager`) for catalog CRUD, image uploads, city restocking, order lifecycle updates (`confirmed` → `packing` → `dispatched` → `delivered` / `cancelled`), event replay, and Recharts revenue/inventory analytics.

---

## Folder Structure

```text
storestream/
├── api/index.mjs                      # Built Vercel Serverless API bundle (generated by npm run build)
├── server.ts                          # Persistent Node + WebSocket + Vite dev/prod server (port 3000)
├── server/
│   ├── app.ts                         # Express REST API, Zod schemas & security middleware
│   ├── vercel-entry.ts                # Serverless cold-start handler bundled into api/index.mjs
│   ├── adapters/aiven.ts              # Live Aiven PG, KafkaJS & OpenSearch client bridge
│   ├── store-db.ts                    # Transactional source of truth, 32 seeded SKUs across 7 categories & 6 cities
│   ├── search-engine.ts               # Typo-tolerant OpenSearch discovery + autocomplete + facets
│   ├── event-bus.ts                   # Outbox dispatcher with retries, DLQ routing & WS broadcast
│   └── security.ts                    # scrypt hashing, HS256 JWT, RBAC guards & rate limiter
├── workers/
│   └── event-consumers.ts             # Idempotent cg-inventory, cg-search-sync & cg-notifications workers
├── shared/types/storestream.ts        # Shared TypeScript domain contracts
├── infrastructure/
│   ├── database/schema.sql            # 17-table Aiven PostgreSQL DDL
│   ├── opensearch/index-mapping.json  # OpenSearch analyzer & mapping config
│   └── kafka/topics.md                # Kafka topic & consumer group documentation
├── src/
│   ├── App.tsx                        # Main storefront, header search, city context & realtime sync
│   ├── utils/currency.ts              # INR formatting & relative timestamp helpers
│   └── components/                    # ProductCard, ProductDetailModal, CartDrawer, DemoCenter, AdminDashboard, OrdersView, AuthModal, NotificationDrawer
├── tests/
│   ├── storestream.test.ts            # Automated Vitest unit & HTTP integration suite (8 specs)
│   └── load/checkout-race.k6.js       # k6 concurrent last-unit checkout stress test
├── vercel.json                        # Vercel build, output & API rewrite configuration
├── .vercelignore                      # Excludes local DB files, tests & PDFs from Vercel builds
├── docker-compose.yml                 # Optional local Postgres, Kafka & OpenSearch stack
├── .env.example                       # Environment template (no secrets committed)
└── LICENSE                            # Apache License 2.0
```

---

## Local Development (DEMO MODE)

StoreStream starts immediately on port `3000` with zero external setup required:

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

For a local production Node build and run:

```bash
npm run build
npm start
```

---

## Connecting Live Aiven Infrastructure

1. Provision **Aiven for PostgreSQL**, **Aiven for Apache Kafka**, and **Aiven for OpenSearch**.
2. Apply `infrastructure/database/schema.sql` to your Aiven PostgreSQL database.
3. Create the Kafka topics documented in `infrastructure/kafka/topics.md` (`order.placed`, `inventory.changed`, `order.confirmed`, `order.cancelled`, `product.updated`, `storestream.dlq`).
4. Create the `storestream_products` OpenSearch index using `infrastructure/opensearch/index-mapping.json`.
5. Copy `.env.example` to `.env` (or configure secrets in Vercel / Render) and set the connection strings.

Optional local Docker containers for PostgreSQL, Kafka, and OpenSearch:

```bash
docker compose up -d
```

---

## Environment Variables

| Variable | Required | Default / Behavior | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | No | `3000` | HTTP server port for local/Node deployment |
| `FRONTEND_URL` | No | `http://localhost:3000` | Allowed CORS origin when cross-origin requests are used |
| `STORE_DATABASE_PATH` | No | `./data/storestream.db` (or `/tmp/storestream.db` on Vercel) | SQLite fallback database file path |
| `JWT_SECRET` | Recommended | Ephemeral per-process random hex | HS256 JWT signing secret (>=16 chars) |
| `ADMIN_PASSCODE` | No | First-run Admin claim flow in UI | Optional admin claim guard |
| `DATABASE_URL` | Live PG | Unset (`DEMO_MODE`) | Aiven PostgreSQL connection URI |
| `KAFKA_BROKERS` | Live Kafka | Unset (`DEMO_MODE`) | Comma-separated Kafka broker host:port pairs |
| `KAFKA_USERNAME` | Live Kafka | Unset | SASL SCRAM-SHA-256 username |
| `KAFKA_PASSWORD` | Live Kafka | Unset | SASL SCRAM-SHA-256 password |
| `KAFKA_SSL` | Live Kafka | `true` | Enable TLS for Kafka connections |
| `KAFKA_SSL_CA` | No | Unset | Optional PEM CA certificate string |
| `OPENSEARCH_NODE` | Live OS | Unset (`DEMO_MODE`) | Aiven OpenSearch HTTPS endpoint URL |
| `OPENSEARCH_USERNAME` | Live OS | Unset | OpenSearch basic auth username |
| `OPENSEARCH_PASSWORD` | Live OS | Unset | OpenSearch basic auth password |

---

## REST API & Realtime Endpoints

- **Health & Store Snapshot**
  - `GET /api/health` — Infrastructure connectivity, `realtimeTransport` (`websocket` or `http`), and indexed doc count
  - `GET /api/store/snapshot` — Full hydrated storefront, order, event log, stock ledger & analytics snapshot
- **Product Discovery**
  - `GET /api/search?q=&city=&category=&brand=&minPrice=&maxPrice=&minRating=&inStockOnly=&sort=`
  - `GET /api/search/suggest?q=&city=` — Autocomplete suggestions
- **Shopping Cart & Checkout**
  - `GET /api/cart?sessionId=`
  - `PUT /api/cart/city`
  - `POST /api/cart/items`
  - `DELETE /api/cart/items/:productId?sessionId=`
  - `POST /api/orders/checkout` — Supports `Idempotency-Key` header or body `idempotencyKey`
- **Hackathon Concurrency Demo**
  - `POST /api/orders/race-test` — Fires 2 concurrent buyers for the last unit and returns `201` + `409`
  - `POST /api/demo/reset-race-stock` — Resets test SKU city stock back to `1`
- **Authentication & Admin RBAC**
  - `GET /api/auth/status`, `POST /api/auth/claim-admin`, `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
  - `POST /api/admin/upload`, `POST /api/admin/products`, `PATCH /api/admin/products/:id`, `DELETE /api/admin/products/:id`
  - `POST /api/admin/inventory/restock`, `PATCH /api/admin/orders/:id/status`, `POST /api/admin/events/:eventId/replay`
- **Realtime Updates**
  - `WS /ws` on Node (`server.ts`), or automatic 12-second visibility-aware polling when `realtimeTransport === "http"` on serverless hosts.

---

## Security & Role-Based Access Control

- **Password Storage**: Salted `crypto.scryptSync` (64-byte derived keys) verified with `crypto.timingSafeEqual`.
- **Stateless Auth**: Signed `HS256` JWT bearer tokens (`JWT_SECRET`, or secure per-process ephemeral key if unset).
- **RBAC Enforcement**: Customer accounts cannot access `/api/admin/*` endpoints (`403 Forbidden`); Admin access uses an explicit first-run Claim Admin workflow with zero hardcoded passwords.
- **Input & Abuse Protection**: Strict Zod schemas on every route, sanitized image URLs, 2MB upload limits (`JPG`/`PNG`/`WEBP`), rate limiting (`300 req/min`), and security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy`).

---

## Automated & Load Testing

Run TypeScript typechecking and the 8-test Vitest integration suite:

```bash
npm run lint
npm test
```

The test suite verifies catalog seeding (32 SKUs / 7 categories / 6 cities), `scrypt` + JWT auth, RBAC `403` protection, `"bluetoth"` & `"samzung phone"` fuzzy search, GST/shipping calculation, 2-buyer last-unit concurrency race prevention, checkout `Idempotency-Key` deduplication, and duplicate Kafka consumer deduplication.

Run the k6 concurrent checkout stress script (with `k6` installed and server running on `http://localhost:3000`):

```bash
k6 run tests/load/checkout-race.k6.js
```

---

## Deploying to Vercel

This project is pre-configured for **zero-error Vercel deployment** across all plans (Hobby, Pro, and Enterprise):

1. **Included Vercel Files**
   - `vercel.json`: Sets `"framework": "vite"`, `"buildCommand": "npm run build"`, `"outputDirectory": "dist"`, and rewrites `/api/*` and `/uploads/*` to `/api/index.mjs` while routing client SPA paths to `/index.html`.
   - `server/vercel-entry.ts` → `api/index.mjs`: Bundled during `npm run build` via `esbuild` (`--packages=external --format=esm`) so Node serverless never fails on `.ts` relative imports or pulls `vite`/`ws` into the Lambda bundle.
   - `.vercelignore`: Excludes `data/`, `public/uploads/`, `public/assets/aistudio/`, `tests/`, and `docker-compose.yml` from upload/build overhead.
2. **Deploy Steps**
   - Push to GitHub/GitLab/Bitbucket and import the repository in the Vercel Dashboard, **or** run `vercel --prod` from the project root using the Vercel CLI.
   - Keep the defaults from `vercel.json` (do not override Output Directory or Install Command).
   - Ensure Node.js version is `22.x` in Vercel Project Settings (`"engines": { "node": "22.x" }` is declared in `package.json`).
3. **Persistence & Realtime Behavior on Vercel**
   - **Without Aiven environment variables**: StoreStream boots cleanly in `DEMO_MODE` using writable `/tmp/storestream.db` (zero `EROFS` read-only errors) and automatically switches `/api/health` to `realtimeTransport: "http"` so the storefront polls cleanly without WebSocket errors. Note that `/tmp` persists across warm serverless invocations and resets on cold starts.
   - **With Aiven environment variables**: Add `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`, `KAFKA_SSL`, `OPENSEARCH_NODE`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`, and `JWT_SECRET` in Vercel **Project Settings → Environment Variables** for durable production state.

---

## Hackathon Judge Demo Walkthrough

Open **Demo Center** from the top navigation bar to verify all core architecture claims live:

1. **Demo 1 — Typo-Tolerant Search**: Run `"bluetoth"` or `"samzung phone"` to inspect fuzzy OpenSearch correction, query latency, and city stock filtering.
2. **Demo 2 — Race-Proof Last-Unit Checkout**: `Acoustic Pulse Bluetooth Earphones` starts with **1 unit** in `Bengaluru`. Click **Simulate 2 Simultaneous Buyers** — Buyer A gets `201 Confirmed`, Buyer B gets `409 Conflict`, stock drops cleanly to `0`, and **Oversells Blocked** increments. Click **Reset Selected Stock to 1 Unit** to repeat.
3. **Demo 3 — Kafka Event Cascade**: Inspect partitioned outbox offsets, idempotent consumer acknowledgements (`cg-inventory`, `cg-search-sync`, `cg-notifications`), and confirmation receipts.
4. **Demo 4 — City-Wise Inventory & Admin Console**: Compare inventory across all 6 cities, or claim Administrator access in the **Admin** tab to manage products, restock warehouses, transition order statuses, and inspect Recharts analytics.

---

## License

This project is licensed under the **Apache License, Version 2.0**. See the [LICENSE](./LICENSE) file for the full license text.
