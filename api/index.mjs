// server/adapters/aiven.ts
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Kafka } from "kafkajs";
import pg from "pg";
var AivenInfrastructureBridge = class {
  constructor() {
    this.pgPool = null;
    this.pgConnected = false;
    this.kafkaProducer = null;
    this.kafkaConnected = false;
    this.osClient = null;
    this.osConnected = false;
  }
  async initialize() {
    const dbUrl = process.env.DATABASE_URL?.trim();
    if (dbUrl) {
      try {
        this.pgPool = new pg.Pool({
          connectionString: dbUrl,
          ssl: dbUrl.includes("localhost") ? void 0 : { rejectUnauthorized: false },
          max: 10,
          connectionTimeoutMillis: 4e3
        });
        await this.pgPool.query("SELECT 1");
        this.pgConnected = true;
      } catch (err) {
        console.warn("[Aiven PG] Connection unavailable, falling back to local transactional engine:", err.message);
        this.pgConnected = false;
      }
    }
    const brokersRaw = process.env.KAFKA_BROKERS?.trim();
    if (brokersRaw) {
      try {
        const brokers = brokersRaw.split(",").map((b) => b.trim()).filter(Boolean);
        const useSsl = process.env.KAFKA_SSL !== "false";
        const username = process.env.KAFKA_USERNAME?.trim();
        const password = process.env.KAFKA_PASSWORD?.trim();
        const ca = process.env.KAFKA_SSL_CA?.trim();
        const kafka = new Kafka({
          clientId: "storestream-backend",
          brokers,
          ssl: useSsl ? ca ? { rejectUnauthorized: true, ca: [ca] } : { rejectUnauthorized: false } : false,
          sasl: username && password ? { mechanism: "scram-sha-256", username, password } : void 0,
          connectionTimeout: 4e3
        });
        this.kafkaProducer = kafka.producer();
        await this.kafkaProducer.connect();
        this.kafkaConnected = true;
      } catch (err) {
        console.warn("[Aiven Kafka] Broker unavailable, running embedded transactional outbox & consumers:", err.message);
        this.kafkaConnected = false;
      }
    }
    const osNode = process.env.OPENSEARCH_NODE?.trim();
    if (osNode) {
      try {
        const username = process.env.OPENSEARCH_USERNAME?.trim();
        const password = process.env.OPENSEARCH_PASSWORD?.trim();
        this.osClient = new OpenSearchClient({
          node: osNode,
          auth: username && password ? { username, password } : void 0,
          ssl: { rejectUnauthorized: false }
        });
        await this.osClient.ping();
        this.osConnected = true;
      } catch (err) {
        console.warn("[Aiven OpenSearch] Cluster unavailable, running local fuzzy & faceted engine:", err.message);
        this.osConnected = false;
      }
    }
    return this.getStatus();
  }
  getStatus() {
    const pgConfigured = Boolean(process.env.DATABASE_URL?.trim());
    const kafkaConfigured = Boolean(process.env.KAFKA_BROKERS?.trim());
    const osConfigured = Boolean(process.env.OPENSEARCH_NODE?.trim());
    const allLive = this.pgConnected && this.kafkaConnected && this.osConnected;
    return {
      mode: allLive ? "AIVEN_LIVE" : "DEMO_MODE",
      postgresql: {
        configured: pgConfigured,
        connected: this.pgConnected,
        label: this.pgConnected ? "Aiven PostgreSQL Connected" : "DEMO MODE \xB7 Local Transactional SQLite (WAL)"
      },
      kafka: {
        configured: kafkaConfigured,
        connected: this.kafkaConnected,
        label: this.kafkaConnected ? "Aiven Apache Kafka Connected" : "DEMO MODE \xB7 Transactional Outbox + Embedded Consumers"
      },
      opensearch: {
        configured: osConfigured,
        connected: this.osConnected,
        label: this.osConnected ? "Aiven OpenSearch Connected" : "DEMO MODE \xB7 Local Fuzzy & Faceted Index"
      }
    };
  }
  async publishKafkaMessage(topic, key, payload) {
    if (!this.kafkaConnected || !this.kafkaProducer) return false;
    try {
      await this.kafkaProducer.send({
        topic,
        messages: [{ key, value: JSON.stringify(payload) }]
      });
      return true;
    } catch (err) {
      console.warn(`[Aiven Kafka] Publish error on ${topic}:`, err.message);
      return false;
    }
  }
  async indexOpenSearchDocument(productId, doc) {
    if (!this.osConnected || !this.osClient) return false;
    try {
      await this.osClient.index({
        index: "storestream_products",
        id: productId,
        body: doc,
        refresh: true
      });
      return true;
    } catch (err) {
      console.warn("[Aiven OpenSearch] Index sync warning:", err.message);
      return false;
    }
  }
  getOpenSearchClient() {
    return this.osConnected ? this.osClient : null;
  }
  getPgPool() {
    return this.pgConnected ? this.pgPool : null;
  }
};
var aivenBridge = new AivenInfrastructureBridge();

// server/app.ts
import crypto4 from "node:crypto";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
import express from "express";
import multer from "multer";
import { z } from "zod";

// workers/event-consumers.ts
import crypto3 from "node:crypto";

// server/store-db.ts
import crypto2 from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// server/security.ts
import crypto from "node:crypto";
var EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString("hex");
function getJwtSecret() {
  const configured = process.env.JWT_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : EPHEMERAL_JWT_SECRET;
}
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}
function verifyPassword(plain, storedHash) {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(plain, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}
function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}
function signJwt(payload, ttlSeconds = 86400) {
  const now = Math.floor(Date.now() / 1e3);
  const claims = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds
  };
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac("sha256", getJwtSecret()).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}
function verifyJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac("sha256", getJwtSecret()).update(signingInput).digest("base64url");
  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payloadB64));
    if (!parsed.sub || !parsed.role || parsed.exp < Math.floor(Date.now() / 1e3)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const claims = verifyJwt(token);
    if (claims) {
      req.authUser = claims;
    }
  }
  next();
}
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const claims = verifyJwt(authHeader.slice(7).trim());
  if (!claims) {
    res.status(401).json({ error: "Invalid or expired session token." });
    return;
  }
  req.authUser = claims;
  next();
}
function requireRoles(...allowed) {
  return (req, res, next) => {
    if (!req.authUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (!allowed.includes(req.authUser.role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${allowed.join(" or ")}.`
      });
      return;
    }
    next();
  };
}
function securityHeadersMiddleware(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  const allowedOrigin = process.env.FRONTEND_URL?.trim();
  const origin = req.headers.origin;
  if (origin && allowedOrigin && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key");
    res.status(204).end();
    return;
  }
  next();
}
function createRateLimiter(maxRequests, windowMs) {
  const hits = /* @__PURE__ */ new Map();
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= maxRequests) {
      res.status(429).json({ error: "Too many requests. Please slow down and retry." });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
function sanitizeImageUrl(url) {
  const trimmed = url.trim();
  if (trimmed.startsWith("/src/assets/images/") || trimmed.startsWith("/uploads/")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
  }
  return "/src/assets/images/product_bluetooth_earphones_1795314720308.jpg";
}

// server/store-db.ts
var CITIES = [
  "Bengaluru",
  "Mumbai",
  "Delhi NCR",
  "Hyderabad",
  "Chennai",
  "Pune"
];
var CATEGORIES = [
  "Electronics",
  "Fashion",
  "Home and Kitchen",
  "Grocery",
  "Accessories",
  "Beauty",
  "Sports"
];
var CITY_META = {
  Bengaluru: { id: "city_blr", state: "Karnataka", code: "BLR-WH1", eta: "Same-day \xB7 3 hrs" },
  Mumbai: { id: "city_bom", state: "Maharashtra", code: "BOM-WH1", eta: "Same-day \xB7 4 hrs" },
  "Delhi NCR": { id: "city_del", state: "Delhi", code: "DEL-WH1", eta: "Express \xB7 4 hrs" },
  Hyderabad: { id: "city_hyd", state: "Telangana", code: "HYD-WH1", eta: "Same-day \xB7 5 hrs" },
  Chennai: { id: "city_maa", state: "Tamil Nadu", code: "MAA-WH1", eta: "Same-day \xB7 5 hrs" },
  Pune: { id: "city_pnq", state: "Maharashtra", code: "PNQ-WH1", eta: "Next-morning delivery" }
};
var IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
var DB_PATH = process.env.STORE_DATABASE_PATH ? path.resolve(process.env.STORE_DATABASE_PATH) : IS_SERVERLESS ? path.join(os.tmpdir(), "storestream.db") : path.resolve(process.cwd(), "data", "storestream.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
var storeDb = new Database(DB_PATH);
storeDb.pragma("journal_mode = WAL");
storeDb.pragma("busy_timeout = 5000");
storeDb.pragma("foreign_keys = ON");
var InsufficientStockError = class extends Error {
  constructor(productId, productName, city, available) {
    super(`Insufficient stock for ${productName} in ${city}: ${available} unit(s) remaining.`);
    this.name = "InsufficientStockError";
    this.productId = productId;
    this.productName = productName;
    this.city = city;
    this.available = available;
  }
};
function initStoreDatabase() {
  storeDb.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
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
      role TEXT NOT NULL,
      default_city TEXT NOT NULL DEFAULT 'Bengaluru',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      default_city TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS addresses (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      city TEXT NOT NULL,
      line1 TEXT NOT NULL,
      postal_code TEXT NOT NULL DEFAULT '560038',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      price_inr INTEGER NOT NULL,
      discount_pct INTEGER NOT NULL DEFAULT 0,
      rating REAL NOT NULL DEFAULT 4.6,
      popularity INTEGER NOT NULL DEFAULT 60,
      is_featured INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      specs_json TEXT NOT NULL,
      image_url TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS city_inventory (
      product_id TEXT NOT NULL,
      city TEXT NOT NULL,
      warehouse_code TEXT NOT NULL,
      stock_qty INTEGER NOT NULL CHECK (stock_qty >= 0),
      low_stock_threshold INTEGER NOT NULL DEFAULT 3,
      eta_label TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (product_id, city),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS carts (
      session_id TEXT PRIMARY KEY,
      city TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      session_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, product_id),
      FOREIGN KEY (session_id) REFERENCES carts(session_id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      city TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      subtotal_inr INTEGER NOT NULL,
      tax_inr INTEGER NOT NULL,
      delivery_inr INTEGER NOT NULL,
      total_inr INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      unit_price_inr INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_inr INTEGER NOT NULL,
      reference_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_log (
      offset_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      consumer_status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT NOT NULL,
      consumer_group TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (event_id, consumer_group)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      customer_email TEXT NOT NULL,
      city TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app_and_email_sim',
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      dispatched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      city TEXT NOT NULL,
      delta INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  seedStoreData();
}
var IMG = {
  earphones: "/src/assets/images/product_bluetooth_earphones_1795314720308.jpg",
  headphones: "/src/assets/images/product_studio_headphones_1795314721448.jpg",
  speaker: "/src/assets/images/product_smart_speaker_1795314720476.jpg",
  keyboard: "/src/assets/images/product_mechanical_keyboard_1795314721669.jpg",
  purifier: "/src/assets/images/product_air_purifier_1795314721157.jpg",
  charger: "/src/assets/images/product_gan_charger_1795314720768.jpg",
  jacket: "/src/assets/images/product_fashion_jacket_1795315751913.jpg",
  espresso: "/src/assets/images/product_kitchen_espresso_1795315751007.jpg",
  coffee: "/src/assets/images/product_grocery_coffee_1795315750797.jpg",
  serum: "/src/assets/images/product_beauty_serum_1795315751357.jpg",
  shoes: "/src/assets/images/product_sports_shoes_1795315751430.jpg",
  phone: "/src/assets/images/product_smartphone_flagship_1795315751245.jpg"
};
function seedStoreData() {
  const existingCount = storeDb.prepare("SELECT COUNT(*) as cnt FROM products").get().cnt;
  if (existingCount >= 30) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const insertCat = storeDb.prepare("INSERT OR IGNORE INTO categories (id, name, slug) VALUES (?, ?, ?)");
  for (const c of CATEGORIES) {
    insertCat.run(`cat_${c.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, c, c.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  }
  const insertCity = storeDb.prepare(
    "INSERT OR IGNORE INTO cities (id, name, state_name, warehouse_code, eta_label) VALUES (?, ?, ?, ?, ?)"
  );
  for (const c of CITIES) {
    const m = CITY_META[c];
    insertCity.run(m.id, c, m.state, m.code, m.eta);
  }
  const seedProducts = [
    {
      id: "prod_earphones",
      sku: "SS-AUD-101",
      name: "Acoustic Pulse Bluetooth Earphones",
      brand: "SonaWave",
      category: "Electronics",
      price_inr: 4499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 99,
      is_featured: true,
      description: "Active noise-cancelling Bluetooth 5.4 wireless earphones with 38-hour battery life and spatial tuning. Seeded at 1 unit in Bengaluru for last-unit race testing.",
      specs: ["Bluetooth 5.4 Dual-Device", "45dB Adaptive ANC", "38h Total Case Runtime", "IPX5 Sweat Resistant"],
      image_url: IMG.earphones,
      tags: ["bluetooth", "earphones", "wireless", "anc", "audio", "earbuds"],
      stock: { Bengaluru: 1, Mumbai: 12, "Delhi NCR": 8, Hyderabad: 5, Chennai: 7, Pune: 3 }
    },
    {
      id: "prod_samsung_s25",
      sku: "SS-ELC-102",
      name: "Samsung Galaxy S25 Ultra 5G Smartphone",
      brand: "Samsung",
      category: "Electronics",
      price_inr: 114999,
      discount_pct: 8,
      rating: 4.9,
      popularity: 97,
      is_featured: true,
      description: "Flagship Titanium 5G smartphone with 200MP quad telephoto optics, 120Hz AMOLED panel, and multi-city express courier dispatch.",
      specs: ['6.8" QHD+ 120Hz AMOLED', "200MP ProVisual Camera", "5000mAh Fast Charge", "256GB UFS 4.0"],
      image_url: IMG.phone,
      tags: ["samsung", "phone", "smartphone", "5g", "mobile", "galaxy"],
      stock: { Bengaluru: 9, Mumbai: 14, "Delhi NCR": 11, Hyderabad: 6, Chennai: 5, Pune: 4 }
    },
    {
      id: "prod_headphones",
      sku: "SS-AUD-103",
      name: "Studio Reference Wireless Headphones",
      brand: "SonaWave",
      category: "Electronics",
      price_inr: 12990,
      discount_pct: 12,
      rating: 4.8,
      popularity: 91,
      is_featured: true,
      description: "Over-ear wireless monitoring headphones with lossless USB-C DAC mode, Bluetooth multipoint, and lambskin cushions.",
      specs: ["40mm Beryllium Drivers", "Bluetooth 5.3 + Lossless USB-C", "45h Battery Life", "245g Fold-Flat"],
      image_url: IMG.headphones,
      tags: ["headphones", "wireless", "bluetooth", "studio", "over-ear"],
      stock: { Bengaluru: 6, Mumbai: 0, "Delhi NCR": 4, Hyderabad: 7, Chennai: 3, Pune: 5 }
    },
    {
      id: "prod_speaker",
      sku: "SS-ELC-104",
      name: "Resonance 360 Smart Speaker",
      brand: "Kinetix Home",
      category: "Electronics",
      price_inr: 6990,
      discount_pct: 10,
      rating: 4.6,
      popularity: 85,
      is_featured: false,
      description: "Omnidirectional room-calibrating Wi-Fi and Bluetooth smart speaker in woven acoustic wool.",
      specs: ["360\xB0 Woofer + Dual Tweeters", "Wi-Fi 6 & Bluetooth 5.2", "Far-Field 4-Mic Array", "Matter Hub Ready"],
      image_url: IMG.speaker,
      tags: ["speaker", "smart speaker", "wifi", "bluetooth", "audio"],
      stock: { Bengaluru: 9, Mumbai: 7, "Delhi NCR": 5, Hyderabad: 0, Chennai: 6, Pune: 4 }
    },
    {
      id: "prod_smartwatch",
      sku: "SS-ELC-105",
      name: "Samsung Galaxy Watch 7 Titanium LTE",
      brand: "Samsung",
      category: "Electronics",
      price_inr: 28990,
      discount_pct: 10,
      rating: 4.7,
      popularity: 88,
      is_featured: false,
      description: "Dual-frequency GPS fitness and wellness smartwatch with Sapphire crystal glass and 3nm processor.",
      specs: ["44mm Sapphire AMOLED", "Dual-Band L1+L5 GPS", "5ATM + IP68 Rated", "Fast Wireless Charging"],
      image_url: IMG.phone,
      tags: ["samsung", "smartwatch", "wearable", "fitness", "gps"],
      stock: { Bengaluru: 5, Mumbai: 9, "Delhi NCR": 6, Hyderabad: 4, Chennai: 2, Pune: 6 }
    },
    {
      id: "prod_soundbar",
      sku: "SS-ELC-106",
      name: "Horizon Dolby Atmos 5.1 Soundbar",
      brand: "SonaWave",
      category: "Electronics",
      price_inr: 24999,
      discount_pct: 18,
      rating: 4.6,
      popularity: 80,
      is_featured: false,
      description: "Compact anodized aluminum soundbar with wireless subwoofer and HDMI eARC low-latency pass-through.",
      specs: ["420W Peak Output", "HDMI eARC + Optical", "Bluetooth 5.3 Streaming", "Wireless Subwoofer"],
      image_url: IMG.speaker,
      tags: ["soundbar", "home theater", "bluetooth", "dolby"],
      stock: { Bengaluru: 4, Mumbai: 6, "Delhi NCR": 3, Hyderabad: 5, Chennai: 2, Pune: 0 }
    },
    {
      id: "prod_keyboard",
      sku: "SS-ACC-201",
      name: "Tactile 75% Aluminum Mechanical Keyboard",
      brand: "KeyCraft",
      category: "Accessories",
      price_inr: 8490,
      discount_pct: 10,
      rating: 4.9,
      popularity: 94,
      is_featured: true,
      description: "CNC anodized aluminum wireless mechanical keyboard with gasket mount, hot-swappable switches, and Mac/Windows dual legends.",
      specs: ["75% Gasket-Mount CNC Frame", "Tri-Mode Bluetooth / 2.4GHz / USB-C", "PBT Dye-Sub Keycaps", "4000mAh Battery"],
      image_url: IMG.keyboard,
      tags: ["keyboard", "mechanical", "wireless", "bluetooth", "usb-c"],
      stock: { Bengaluru: 4, Mumbai: 10, "Delhi NCR": 14, Hyderabad: 6, Chennai: 8, Pune: 2 }
    },
    {
      id: "prod_charger",
      sku: "SS-ACC-202",
      name: "VoltCube 100W GaN Fast Charger",
      brand: "VoltCore",
      category: "Accessories",
      price_inr: 3299,
      discount_pct: 20,
      rating: 4.7,
      popularity: 90,
      is_featured: false,
      description: "Pocket-sized 4-port 100W GaN wall adapter built for laptops, tablets, and flagship phones with BIS surge protection.",
      specs: ["100W PD 3.1 Total Output", "3x USB-C + 1x USB-A", "BIS & GaN Thermal Control", "Foldable Indian Plug"],
      image_url: IMG.charger,
      tags: ["charger", "gan", "usb-c", "laptop", "fast charge"],
      stock: { Bengaluru: 18, Mumbai: 15, "Delhi NCR": 12, Hyderabad: 9, Chennai: 11, Pune: 14 }
    },
    {
      id: "prod_usbc_hub",
      sku: "SS-ACC-203",
      name: "KeyCraft 8-in-1 Dual-HDMI USB-C Dock",
      brand: "KeyCraft",
      category: "Accessories",
      price_inr: 4199,
      discount_pct: 12,
      rating: 4.5,
      popularity: 77,
      is_featured: false,
      description: "Machined aluminum laptop docking station with 4K 60Hz HDMI, Gigabit Ethernet, SD UHS-II reader, and 100W PD pass-through.",
      specs: ["4K 60Hz HDMI Output", "Gigabit RJ45 Ethernet", "10Gbps USB-A & C", "100W PD Pass-Through"],
      image_url: IMG.charger,
      tags: ["hub", "dock", "usb-c", "laptop", "hdmi"],
      stock: { Bengaluru: 11, Mumbai: 8, "Delhi NCR": 7, Hyderabad: 5, Chennai: 4, Pune: 6 }
    },
    {
      id: "prod_laptop_sleeve",
      sku: "SS-ACC-204",
      name: 'Monsoon Waxed Canvas 14" Laptop Sleeve',
      brand: "Indigo Loom",
      category: "Accessories",
      price_inr: 2199,
      discount_pct: 15,
      rating: 4.6,
      popularity: 73,
      is_featured: false,
      description: "Water-repellent waxed cotton canvas laptop sleeve lined with plush recycled fleece and magnetic accessory pocket.",
      specs: ['Fits 13"\u201314.2" Laptops', "YKK AquaGuard Zipper", "Microfiber Interior", "Cable Organizer Pocket"],
      image_url: IMG.jacket,
      tags: ["sleeve", "laptop", "bag", "canvas", "travel"],
      stock: { Bengaluru: 7, Mumbai: 9, "Delhi NCR": 5, Hyderabad: 4, Chennai: 6, Pune: 8 }
    },
    {
      id: "prod_powerbank",
      sku: "SS-ACC-205",
      name: "VoltCube 20,000mAh 65W Laptop Power Bank",
      brand: "VoltCore",
      category: "Accessories",
      price_inr: 4990,
      discount_pct: 14,
      rating: 4.7,
      popularity: 84,
      is_featured: false,
      description: "Airline-safe 74Wh portable power bank capable of rapid charging ultrabooks and phones simultaneously.",
      specs: ["65W Bi-Directional USB-C", "20,000mAh Li-Polymer", "Digital Wattage Readout", "Flight Approved 74Wh"],
      image_url: IMG.charger,
      tags: ["power bank", "battery", "travel", "usb-c", "fast charge"],
      stock: { Bengaluru: 2, Mumbai: 6, "Delhi NCR": 10, Hyderabad: 7, Chennai: 5, Pune: 4 }
    },
    {
      id: "prod_espresso",
      sku: "SS-HK-301",
      name: "Barista Steel PID Espresso Machine",
      brand: "Kinetix Home",
      category: "Home and Kitchen",
      price_inr: 34990,
      discount_pct: 10,
      rating: 4.9,
      popularity: 92,
      is_featured: true,
      description: "15-bar PID temperature-stabilized brushed stainless espresso maker with 58mm commercial portafilter and microfoam steam wand.",
      specs: ["PID Thermal Stability", "58mm Stainless Portafilter", "1.8L Removable Reservoir", "Dual Pressure Gauge"],
      image_url: IMG.espresso,
      tags: ["espresso", "coffee", "kitchen", "appliance", "barista"],
      stock: { Bengaluru: 5, Mumbai: 4, "Delhi NCR": 3, Hyderabad: 2, Chennai: 3, Pune: 2 }
    },
    {
      id: "prod_purifier",
      sku: "SS-HK-302",
      name: "PureAir H13 True HEPA Room Purifier",
      brand: "AeroCare",
      category: "Home and Kitchen",
      price_inr: 11499,
      discount_pct: 18,
      rating: 4.8,
      popularity: 95,
      is_featured: true,
      description: "Medical-grade H13 True HEPA purifier capturing 99.97% of PM2.5 particulates across Delhi NCR, Mumbai, and metro apartments.",
      specs: ["CADR 380 m\xB3/hr Coverage", "H13 HEPA + Activated Carbon", "Live PM2.5 Laser Sensor", "22dB Night Sleep Mode"],
      image_url: IMG.purifier,
      tags: ["air purifier", "hepa", "pm2.5", "smart home", "clean air"],
      stock: { Bengaluru: 3, Mumbai: 8, "Delhi NCR": 16, Hyderabad: 5, Chennai: 4, Pune: 7 }
    },
    {
      id: "prod_kettle",
      sku: "SS-HK-303",
      name: "PourOver Gooseneck Temperature Kettle",
      brand: "Kinetix Home",
      category: "Home and Kitchen",
      price_inr: 4690,
      discount_pct: 12,
      rating: 4.7,
      popularity: 81,
      is_featured: false,
      description: "Variable-temperature precision gooseneck kettle (40\xB0C to 100\xB0C) for filter coffee, green tea, and artisanal brewing.",
      specs: ["1\xB0C Precision Control", "1200W Rapid Boil", "304 Surgical Stainless", "60-Minute Hold Mode"],
      image_url: IMG.espresso,
      tags: ["kettle", "coffee", "tea", "kitchen", "gooseneck"],
      stock: { Bengaluru: 8, Mumbai: 6, "Delhi NCR": 9, Hyderabad: 4, Chennai: 5, Pune: 3 }
    },
    {
      id: "prod_skillet",
      sku: "SS-HK-304",
      name: 'Heritage Pre-Seasoned Cast Iron Skillet 10"',
      brand: "Deccan Forge",
      category: "Home and Kitchen",
      price_inr: 2499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 79,
      is_featured: false,
      description: "Heavy-gauge heirloom cast iron pan naturally seasoned with cold-pressed flax oil for induction, gas, and oven cooking.",
      specs: ["10-Inch Cooking Surface", "Induction & Oven Safe", "Zero Synthetic Coatings", "Twin Pour Spouts"],
      image_url: IMG.espresso,
      tags: ["cookware", "cast iron", "skillet", "pan", "kitchen"],
      stock: { Bengaluru: 12, Mumbai: 10, "Delhi NCR": 8, Hyderabad: 9, Chennai: 7, Pune: 6 }
    },
    {
      id: "prod_humidifier",
      sku: "SS-HK-305",
      name: "AeroCare Ultrasonic Mist Humidifier",
      brand: "AeroCare",
      category: "Home and Kitchen",
      price_inr: 3799,
      discount_pct: 10,
      rating: 4.4,
      popularity: 68,
      is_featured: false,
      description: "Top-fill 4L quiet ultrasonic cool-mist humidifier with built-in hygrometer for dry AC bedrooms.",
      specs: ["4L Top-Fill Tank", "32-Hour Runtime", "Auto Humidity Sensor", "Auto Shut-Off"],
      image_url: IMG.purifier,
      tags: ["humidifier", "home", "bedroom", "air care"],
      stock: { Bengaluru: 6, Mumbai: 4, "Delhi NCR": 7, Hyderabad: 3, Chennai: 2, Pune: 5 }
    },
    {
      id: "prod_jacket",
      sku: "SS-FSH-401",
      name: "Tailored Organic Twill Utility Overshirt",
      brand: "Indigo Loom",
      category: "Fashion",
      price_inr: 3899,
      discount_pct: 15,
      rating: 4.8,
      popularity: 89,
      is_featured: true,
      description: "Breathable 310gsm organic cotton twill overshirt cut cleanly for all-season Indian layering with corozo nut buttons.",
      specs: ["100% GOTS Organic Cotton", "310gsm Brushed Twill", "Dual Utility Chest Pockets", "Pre-Shrunk Tailored Fit"],
      image_url: IMG.jacket,
      tags: ["jacket", "overshirt", "cotton", "menswear", "fashion"],
      stock: { Bengaluru: 14, Mumbai: 11, "Delhi NCR": 9, Hyderabad: 6, Chennai: 5, Pune: 8 }
    },
    {
      id: "prod_linen_shirt",
      sku: "SS-FSH-402",
      name: "Malabar Pure Linen Mandarin Collar Shirt",
      brand: "Indigo Loom",
      category: "Fashion",
      price_inr: 2999,
      discount_pct: 10,
      rating: 4.7,
      popularity: 82,
      is_featured: false,
      description: "Lightweight woven flax linen shirt engineered for humid coastal cities like Mumbai and Chennai.",
      specs: ["100% European Flax Linen", "Mother-of-Pearl Buttons", "Breathable Loose Weave", "Machine Wash Gentle"],
      image_url: IMG.jacket,
      tags: ["linen", "shirt", "summer", "breathable", "fashion"],
      stock: { Bengaluru: 10, Mumbai: 16, "Delhi NCR": 7, Hyderabad: 8, Chennai: 13, Pune: 6 }
    },
    {
      id: "prod_denim",
      sku: "SS-FSH-403",
      name: "Selvedge Stretch Tapered Chinos",
      brand: "Indigo Loom",
      category: "Fashion",
      price_inr: 3499,
      discount_pct: 12,
      rating: 4.6,
      popularity: 75,
      is_featured: false,
      description: "Clean-front tailored trousers in 2% comfort-stretch organic twill with reinforced pocket bags.",
      specs: ["98% Cotton / 2% Elastane", "Concealed Coin Pocket", "Tapered Ankle Fit", "YKK Brass Zip"],
      image_url: IMG.jacket,
      tags: ["chinos", "trousers", "pants", "workwear", "fashion"],
      stock: { Bengaluru: 8, Mumbai: 9, "Delhi NCR": 11, Hyderabad: 5, Chennai: 4, Pune: 7 }
    },
    {
      id: "prod_merino_polo",
      sku: "SS-FSH-404",
      name: "Fine-Knit Pima Cotton Polo",
      brand: "Indigo Loom",
      category: "Fashion",
      price_inr: 2299,
      discount_pct: 8,
      rating: 4.5,
      popularity: 71,
      is_featured: false,
      description: "Mercerized long-staple cotton knit polo holding crisp collar structure across long workdays.",
      specs: ["100% Long-Staple Pima", "Anti-Curl Ribbed Collar", "220gsm Pique Knit", "Side Vent Hem"],
      image_url: IMG.jacket,
      tags: ["polo", "tshirt", "cotton", "fashion"],
      stock: { Bengaluru: 12, Mumbai: 8, "Delhi NCR": 6, Hyderabad: 9, Chennai: 10, Pune: 7 }
    },
    {
      id: "prod_coffee",
      sku: "SS-GRC-501",
      name: "Chikmagalur Single-Estate Arabica Beans (250g)",
      brand: "Malnad Roasters",
      category: "Grocery",
      price_inr: 649,
      discount_pct: 5,
      rating: 4.9,
      popularity: 96,
      is_featured: true,
      description: "Shade-grown 100% AA Arabica whole coffee beans roasted weekly in Karnataka with notes of roasted hazelnut and dark cocoa.",
      specs: ["1,350m Estate Elevation", "Medium-Dark Filter & Espresso", "Nitrogen-Flushed Valve Bag", "Roasted Within 7 Days"],
      image_url: IMG.coffee,
      tags: ["coffee", "arabica", "beans", "grocery", "chikmagalur"],
      stock: { Bengaluru: 28, Mumbai: 20, "Delhi NCR": 15, Hyderabad: 18, Chennai: 22, Pune: 16 }
    },
    {
      id: "prod_matcha",
      sku: "SS-GRC-502",
      name: "First-Harvest Ceremonial Green Tea Tin (50g)",
      brand: "Malnad Roasters",
      category: "Grocery",
      price_inr: 1199,
      discount_pct: 10,
      rating: 4.7,
      popularity: 78,
      is_featured: false,
      description: "Stone-milled shade-grown ceremonial grade matcha packed in an airtight UV-protected tin.",
      specs: ["First Spring Harvest", "Stone-Milled Ultra-Fine", "Zero Added Sugar", "50g Airtight Tin"],
      image_url: IMG.coffee,
      tags: ["tea", "matcha", "green tea", "grocery", "organic"],
      stock: { Bengaluru: 14, Mumbai: 11, "Delhi NCR": 9, Hyderabad: 6, Chennai: 7, Pune: 5 }
    },
    {
      id: "prod_honey",
      sku: "SS-GRC-503",
      name: "Nilgiri Wildflower Raw Forest Honey (500g)",
      brand: "Malnad Roasters",
      category: "Grocery",
      price_inr: 749,
      discount_pct: 0,
      rating: 4.8,
      popularity: 83,
      is_featured: false,
      description: "Unheated, NMR-tested raw multifloral forest honey ethically harvested from Nilgiri foothills.",
      specs: ["NMR Purity Verified", "Zero Sugar Syrup", "Glass Apothecary Jar", "500g Net Weight"],
      image_url: IMG.coffee,
      tags: ["honey", "organic", "grocery", "natural", "raw"],
      stock: { Bengaluru: 19, Mumbai: 14, "Delhi NCR": 12, Hyderabad: 10, Chennai: 15, Pune: 9 }
    },
    {
      id: "prod_olive_oil",
      sku: "SS-GRC-504",
      name: "Cold-Pressed Extra Virgin Olive Oil (750ml)",
      brand: "Deccan Pantry",
      category: "Grocery",
      price_inr: 1399,
      discount_pct: 12,
      rating: 4.6,
      popularity: 74,
      is_featured: false,
      description: "Single-press early-harvest extra virgin olive oil bottled in dark UV glass for dressings and saut\xE9ing.",
      specs: ["Acidity < 0.25%", "First Cold Extraction", "750ml Dark Glass Bottle", "Rich Polyphenols"],
      image_url: IMG.serum,
      tags: ["olive oil", "cooking", "grocery", "pantry"],
      stock: { Bengaluru: 9, Mumbai: 13, "Delhi NCR": 10, Hyderabad: 7, Chennai: 6, Pune: 8 }
    },
    {
      id: "prod_serum",
      sku: "SS-BTY-601",
      name: "Aura 15% Vitamin C + Ferulic Radiance Serum",
      brand: "Aura Botanics",
      category: "Beauty",
      price_inr: 1499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 93,
      is_featured: true,
      description: "Stabilized 15% L-Ascorbic Acid brightening facial serum buffered with hyaluronic acid and ferulic antioxidants.",
      specs: ["15% L-Ascorbic Acid", "Fragrance-Free pH 3.4", "Amber UV Dropper 30ml", "Dermatologist Tested"],
      image_url: IMG.serum,
      tags: ["serum", "vitamin c", "skincare", "beauty", "glow"],
      stock: { Bengaluru: 16, Mumbai: 22, "Delhi NCR": 19, Hyderabad: 12, Chennai: 14, Pune: 11 }
    },
    {
      id: "prod_sunscreen",
      sku: "SS-BTY-602",
      name: "Aura Invisible Mineral SPF 50 PA++++ Fluid",
      brand: "Aura Botanics",
      category: "Beauty",
      price_inr: 899,
      discount_pct: 10,
      rating: 4.7,
      popularity: 88,
      is_featured: false,
      description: "Weightless zero-white-cast broad-spectrum sunscreen formulated for humid tropical Indian UV index days.",
      specs: ["SPF 50 PA++++", "Zero White Cast Matte", "Niacinamide 2% + Zinc", "50ml Travel Tube"],
      image_url: IMG.serum,
      tags: ["sunscreen", "spf", "skincare", "beauty"],
      stock: { Bengaluru: 21, Mumbai: 25, "Delhi NCR": 18, Hyderabad: 14, Chennai: 19, Pune: 12 }
    },
    {
      id: "prod_cleanser",
      sku: "SS-BTY-603",
      name: "Barrier-Repair Ceramide Gel Cleanser",
      brand: "Aura Botanics",
      category: "Beauty",
      price_inr: 699,
      discount_pct: 8,
      rating: 4.6,
      popularity: 76,
      is_featured: false,
      description: "Sulfate-free amino acid pH-balanced daily gel cleanser with 5 skin-identical ceramides.",
      specs: ["pH 5.5 Balanced", "Zero SLS/SLES", "5 Essential Ceramides", "150ml Pump Bottle"],
      image_url: IMG.serum,
      tags: ["cleanser", "face wash", "ceramide", "beauty", "skincare"],
      stock: { Bengaluru: 15, Mumbai: 12, "Delhi NCR": 14, Hyderabad: 9, Chennai: 11, Pune: 8 }
    },
    {
      id: "prod_hair_oil",
      sku: "SS-BTY-604",
      name: "Rosemary & Bhringraj Botanical Scalp Elixir",
      brand: "Aura Botanics",
      category: "Beauty",
      price_inr: 799,
      discount_pct: 12,
      rating: 4.7,
      popularity: 80,
      is_featured: false,
      description: "Lightweight non-greasy cold-infused scalp strengthening oil blending Nilgiri rosemary and bhringraj.",
      specs: ["100% Cold-Pressed Oils", "Silicone & Mineral-Oil Free", "Precision Glass Pipette", "50ml Concentrated"],
      image_url: IMG.serum,
      tags: ["hair oil", "rosemary", "scalp", "beauty"],
      stock: { Bengaluru: 11, Mumbai: 15, "Delhi NCR": 13, Hyderabad: 10, Chennai: 16, Pune: 7 }
    },
    {
      id: "prod_running_shoes",
      sku: "SS-SPT-701",
      name: "StridePro Carbon Knit Marathon Shoes",
      brand: "PaceLab",
      category: "Sports",
      price_inr: 9499,
      discount_pct: 15,
      rating: 4.9,
      popularity: 95,
      is_featured: true,
      description: "Ultra-lightweight engineered knit road running shoes with responsive nitrogen midsole and full-length propulsion plate.",
      specs: ["218g Featherweight Knit", "Nitrogen-Infused Midsole", "High-Abrasion Continental Grip", "8mm Heel-Toe Drop"],
      image_url: IMG.shoes,
      tags: ["running shoes", "marathon", "sneakers", "sports", "fitness"],
      stock: { Bengaluru: 8, Mumbai: 10, "Delhi NCR": 12, Hyderabad: 6, Chennai: 5, Pune: 7 }
    },
    {
      id: "prod_yoga_mat",
      sku: "SS-SPT-702",
      name: "Prana Natural Cork & Rubber Yoga Mat (5mm)",
      brand: "PaceLab",
      category: "Sports",
      price_inr: 2899,
      discount_pct: 10,
      rating: 4.8,
      popularity: 84,
      is_featured: false,
      description: "Antimicrobial Portuguese cork grip top bonded to dense natural tree rubber for hot yoga and strength sessions.",
      specs: ["5mm Joint Cushioning", "Wet-Grip Natural Cork", "185cm x 68cm Wide", "Cotton Carry Strap Included"],
      image_url: IMG.shoes,
      tags: ["yoga mat", "fitness", "pilates", "sports", "cork"],
      stock: { Bengaluru: 14, Mumbai: 9, "Delhi NCR": 8, Hyderabad: 7, Chennai: 10, Pune: 11 }
    },
    {
      id: "prod_flask",
      sku: "SS-SPT-703",
      name: "PaceLab Vacuum Insulated Steel Flask (1L)",
      brand: "PaceLab",
      category: "Sports",
      price_inr: 1399,
      discount_pct: 10,
      rating: 4.7,
      popularity: 79,
      is_featured: false,
      description: "Double-wall copper-lined stainless steel hydration bottle keeping water ice-cold for 24 hours.",
      specs: ["24h Cold / 12h Hot", "18/8 Food-Grade Steel", "Leakproof Chug Cap", "BPA-Free Powder Coat"],
      image_url: IMG.shoes,
      tags: ["bottle", "flask", "gym", "hydration", "sports"],
      stock: { Bengaluru: 20, Mumbai: 17, "Delhi NCR": 14, Hyderabad: 12, Chennai: 11, Pune: 15 }
    },
    {
      id: "prod_dumbbells",
      sku: "SS-SPT-704",
      name: "QuickSelect Cast Steel Dumbbells (Pair 12kg)",
      brand: "PaceLab",
      category: "Sports",
      price_inr: 5999,
      discount_pct: 12,
      rating: 4.8,
      popularity: 82,
      is_featured: false,
      description: "Rubber-hex floor-safe strength training dumbbell pair with knurled chrome ergonomic grip handles.",
      specs: ["2x 6kg / 12kg Pair", "Knurled Anti-Slip Grip", "Anti-Roll Hex Profile", "Low-Odor Virgin Rubber"],
      image_url: IMG.shoes,
      tags: ["dumbbells", "weights", "home gym", "strength", "sports"],
      stock: { Bengaluru: 5, Mumbai: 4, "Delhi NCR": 6, Hyderabad: 3, Chennai: 4, Pune: 5 }
    }
  ];
  const insertBrand = storeDb.prepare("INSERT OR IGNORE INTO brands (id, name) VALUES (?, ?)");
  const insertProduct = storeDb.prepare(`
    INSERT OR IGNORE INTO products (
      id, sku, name, brand, category, price_inr, discount_pct, rating, popularity, is_featured,
      description, specs_json, image_url, tags_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertInventory = storeDb.prepare(`
    INSERT OR IGNORE INTO city_inventory (
      product_id, city, warehouse_code, stock_qty, low_stock_threshold, eta_label, updated_at
    ) VALUES (?, ?, ?, ?, 3, ?, ?)
  `);
  const seedTx = storeDb.transaction(() => {
    for (const p of seedProducts) {
      insertBrand.run(`brand_${p.brand.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, p.brand);
      insertProduct.run(
        p.id,
        p.sku,
        p.name,
        p.brand,
        p.category,
        p.price_inr,
        p.discount_pct,
        p.rating,
        p.popularity,
        p.is_featured ? 1 : 0,
        p.description,
        JSON.stringify(p.specs),
        p.image_url,
        JSON.stringify(p.tags),
        now
      );
      for (const city of CITIES) {
        const meta = CITY_META[city];
        insertInventory.run(p.id, city, meta.code, p.stock[city] ?? 5, meta.eta, now);
      }
    }
    const orderCnt = storeDb.prepare("SELECT COUNT(*) as cnt FROM orders").get().cnt;
    if (orderCnt === 0) {
      storeDb.prepare("INSERT OR IGNORE INTO customers (id, name, email, default_city, created_at) VALUES (?, ?, ?, ?, ?)").run("cust_seed_01", "Ananya Rao", "ananya.rao@example.in", "Bengaluru", now);
      storeDb.prepare("INSERT OR IGNORE INTO addresses (id, customer_id, city, line1, postal_code, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("addr_seed_01", "cust_seed_01", "Bengaluru", "27th Main, HSR Layout, Bengaluru", "560102", now);
      storeDb.prepare(
        `INSERT INTO orders (id, idempotency_key, customer_name, customer_email, city, shipping_address, subtotal_inr, tax_inr, delivery_inr, total_inr, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
      ).run("SS-ORD-1001", "seed-order-1001", "Ananya Rao", "ananya.rao@example.in", "Bengaluru", "27th Main, HSR Layout, Bengaluru", 8490, 1528, 0, 10018, now);
      storeDb.prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price_inr)
           VALUES (?, ?, ?, ?, ?, ?)`
      ).run("oi_seed_01", "SS-ORD-1001", "prod_keyboard", "Tactile 75% Aluminum Mechanical Keyboard", 1, 8490);
      storeDb.prepare(
        `INSERT INTO payments (id, order_id, method, status, amount_inr, reference_code, created_at)
           VALUES (?, ?, 'UPI_SIMULATION', 'simulated_authorized', ?, 'SIM-UPI-1001', ?)`
      ).run("pay_seed_01", "SS-ORD-1001", 10018, now);
      storeDb.prepare(
        `INSERT INTO notifications (id, order_id, customer_email, city, channel, message, is_read, dispatched_at)
           VALUES (?, ?, ?, ?, 'in_app_and_email_sim', ?, 0, ?)`
      ).run("notif_seed_01", "SS-ORD-1001", "ananya.rao@example.in", "Bengaluru", "Order SS-ORD-1001 confirmed for Bengaluru fulfillment.", now);
      const seedEventId = "evt_seed_1001";
      storeDb.prepare(
        `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
           VALUES (?, 'order.placed', 'OrderPlaced', 'Bengaluru', ?, 'indexed_and_confirmed', 0, ?)`
      ).run(seedEventId, JSON.stringify({ orderId: "SS-ORD-1001", city: "Bengaluru", totalInr: 10018 }), now);
      storeDb.prepare("INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)").run(seedEventId, "cg-inventory", now);
      storeDb.prepare("INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)").run(seedEventId, "cg-search-sync", now);
      storeDb.prepare("INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)").run(seedEventId, "cg-notifications", now);
    }
    storeDb.prepare("INSERT OR IGNORE INTO store_counters (key, value) VALUES (?, ?)").run("oversells_prevented", 0);
  });
  seedTx();
}
function hasAdminClaimed() {
  const row = storeDb.prepare("SELECT COUNT(*) as cnt FROM users WHERE role IN ('Administrator', 'Inventory Manager')").get();
  return row.cnt > 0 || Boolean(process.env.ADMIN_PASSCODE?.trim());
}
function claimInitialAdmin(input) {
  if (hasAdminClaimed()) {
    throw new Error("Administrator account has already been claimed. Please sign in.");
  }
  const email = input.email.trim().toLowerCase();
  const id = `usr_${crypto2.randomUUID().slice(0, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const passwordHash = hashPassword(input.password);
  storeDb.prepare("INSERT INTO users (id, name, email, password_hash, role, default_city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.name.trim(), email, passwordHash, input.role, "Bengaluru", now);
  recordAuditLog(email, input.role, "ADMIN_CLAIMED", "user", id, `Initial ${input.role} credentials claimed.`);
  return {
    id,
    name: input.name.trim(),
    email,
    role: input.role,
    default_city: "Bengaluru"
  };
}
function registerCustomer(input) {
  const email = input.email.trim().toLowerCase();
  const existing = storeDb.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    throw new Error("An account with this email already exists.");
  }
  const id = `usr_${crypto2.randomUUID().slice(0, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const passwordHash = hashPassword(input.password);
  const tx = storeDb.transaction(() => {
    storeDb.prepare("INSERT INTO users (id, name, email, password_hash, role, default_city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.name.trim(), email, passwordHash, "Customer", input.defaultCity, now);
    storeDb.prepare(
      `INSERT INTO customers (id, user_id, name, email, default_city, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, default_city = excluded.default_city`
    ).run(`cust_${crypto2.randomUUID().slice(0, 8)}`, id, input.name.trim(), email, input.defaultCity, now);
  });
  tx();
  return {
    id,
    name: input.name.trim(),
    email,
    role: "Customer",
    default_city: input.defaultCity
  };
}
function authenticateUser(emailRaw, password) {
  const email = emailRaw.trim().toLowerCase();
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();
  const row = storeDb.prepare("SELECT id, name, email, password_hash, role, default_city FROM users WHERE email = ?").get(email);
  if (row && verifyPassword(password, row.password_hash)) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      default_city: row.default_city
    };
  }
  if (envPasscode && password === envPasscode) {
    return {
      id: "usr_env_admin",
      name: "StoreStream Admin",
      email,
      role: "Administrator",
      default_city: "Bengaluru"
    };
  }
  return null;
}
function getAllProducts() {
  const prodRows = storeDb.prepare("SELECT * FROM products ORDER BY is_featured DESC, popularity DESC, name ASC").all();
  const invRows = storeDb.prepare("SELECT * FROM city_inventory").all();
  const invMap = /* @__PURE__ */ new Map();
  for (const row of invRows) {
    if (!invMap.has(row.product_id)) {
      invMap.set(row.product_id, {});
    }
    invMap.get(row.product_id)[row.city] = row;
  }
  return prodRows.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price_inr: p.price_inr,
    discount_pct: p.discount_pct ?? 0,
    rating: p.rating ?? 4.6,
    popularity: p.popularity ?? 70,
    is_featured: Boolean(p.is_featured),
    description: p.description,
    specs: JSON.parse(p.specs_json),
    image_url: p.image_url,
    tags: JSON.parse(p.tags_json),
    inventory_by_city: invMap.get(p.id) || {}
  }));
}
function getRecentOrders(limit = 30) {
  const orderRows = storeDb.prepare(
    `SELECT o.*, p.method as payment_method, p.status as payment_status, p.reference_code as payment_reference
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
       ORDER BY o.created_at DESC
       LIMIT ?`
  ).all(limit);
  const selectItems = storeDb.prepare("SELECT * FROM order_items WHERE order_id = ?");
  return orderRows.map((o) => ({
    id: o.id,
    idempotency_key: o.idempotency_key,
    customer_name: o.customer_name,
    customer_email: o.customer_email,
    city: o.city,
    shipping_address: o.shipping_address,
    subtotal_inr: o.subtotal_inr,
    tax_inr: o.tax_inr,
    delivery_inr: o.delivery_inr,
    total_inr: o.total_inr,
    payment_method: o.payment_method || "UPI_SIMULATION",
    payment_status: o.payment_status || "simulated_authorized",
    payment_reference: o.payment_reference || `SIM-${o.id}`,
    status: o.status,
    created_at: o.created_at,
    items: selectItems.all(o.id)
  }));
}
function getRecentEvents(limit = 50) {
  const rows = storeDb.prepare("SELECT * FROM event_log ORDER BY offset_id DESC LIMIT ?").all(limit);
  const selectGroups = storeDb.prepare("SELECT consumer_group FROM processed_events WHERE event_id = ?");
  return rows.map((r) => ({
    offset_id: r.offset_id,
    event_id: r.event_id,
    topic: r.topic,
    event_type: r.event_type,
    partition_key: r.partition_key,
    payload: JSON.parse(r.payload_json),
    consumer_status: r.consumer_status,
    retry_count: r.retry_count ?? 0,
    last_error: r.last_error ?? null,
    consumer_groups_processed: selectGroups.all(r.event_id).map(
      (g) => g.consumer_group
    ),
    created_at: r.created_at
  }));
}
function getRecentNotifications(limit = 30) {
  const rows = storeDb.prepare("SELECT * FROM notifications ORDER BY dispatched_at DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    customer_email: r.customer_email,
    city: r.city,
    channel: r.channel,
    message: r.message,
    is_read: Boolean(r.is_read),
    dispatched_at: r.dispatched_at
  }));
}
function markAllNotificationsRead() {
  storeDb.prepare("UPDATE notifications SET is_read = 1 WHERE is_read = 0").run();
}
function recordOrderNotification(orderId, customerEmail, city, message) {
  const id = `notif_${crypto2.randomUUID().slice(0, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  storeDb.prepare(
    `INSERT INTO notifications (id, order_id, customer_email, city, channel, message, is_read, dispatched_at)
       VALUES (?, ?, ?, ?, 'in_app_and_email_sim', ?, 0, ?)`
  ).run(id, orderId, customerEmail, city, message, now);
  return {
    id,
    order_id: orderId,
    customer_email: customerEmail,
    city,
    channel: "in_app_and_email_sim",
    message,
    is_read: false,
    dispatched_at: now
  };
}
function recordAuditLog(actorEmail, actorRole, action, targetType, targetId, details) {
  storeDb.prepare(
    `INSERT INTO audit_logs (id, actor_email, actor_role, action, target_type, target_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`aud_${crypto2.randomUUID().slice(0, 8)}`, actorEmail, actorRole, action, targetType, targetId, details, (/* @__PURE__ */ new Date()).toISOString());
}
function computeCartBreakdown(items) {
  if (items.length === 0) {
    return { subtotal_inr: 0, tax_inr: 0, delivery_inr: 0, total_inr: 0 };
  }
  const getPrice = storeDb.prepare("SELECT price_inr FROM products WHERE id = ?");
  let subtotal = 0;
  for (const item of items) {
    const row = getPrice.get(item.productId);
    if (row) subtotal += row.price_inr * item.qty;
  }
  const tax = Math.round(subtotal * 0.18);
  const delivery = subtotal >= 1999 || subtotal === 0 ? 0 : 99;
  return {
    subtotal_inr: subtotal,
    tax_inr: tax,
    delivery_inr: delivery,
    total_inr: subtotal + tax + delivery
  };
}
function getPersistedCart(sessionId) {
  const cleanSession = sessionId.slice(0, 80);
  const cartRow = storeDb.prepare("SELECT session_id, city, updated_at FROM carts WHERE session_id = ?").get(cleanSession);
  if (!cartRow) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    storeDb.prepare("INSERT OR IGNORE INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)").run(cleanSession, "Bengaluru", now);
    return {
      sessionId: cleanSession,
      city: "Bengaluru",
      items: [],
      subtotal_inr: 0,
      tax_inr: 0,
      delivery_inr: 0,
      total_inr: 0,
      updatedAt: now
    };
  }
  const itemRows = storeDb.prepare("SELECT product_id as productId, qty FROM cart_items WHERE session_id = ?").all(cleanSession);
  return {
    sessionId: cartRow.session_id,
    city: cartRow.city,
    items: itemRows,
    ...computeCartBreakdown(itemRows),
    updatedAt: cartRow.updated_at
  };
}
function setCartCity(sessionId, city) {
  const cleanSession = sessionId.slice(0, 80);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const tx = storeDb.transaction(() => {
    storeDb.prepare(
      `INSERT INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET city = excluded.city, updated_at = excluded.updated_at`
    ).run(cleanSession, city, now);
    storeDb.prepare("DELETE FROM cart_items WHERE session_id = ?").run(cleanSession);
  });
  tx();
  return getPersistedCart(cleanSession);
}
function upsertCartItem(sessionId, city, productId, delta) {
  const cleanSession = sessionId.slice(0, 80);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const tx = storeDb.transaction(() => {
    storeDb.prepare(
      `INSERT INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET city = excluded.city, updated_at = excluded.updated_at`
    ).run(cleanSession, city, now);
    const inv = storeDb.prepare("SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?").get(productId, city);
    const maxStock = inv?.stock_qty ?? 0;
    const current = storeDb.prepare("SELECT qty FROM cart_items WHERE session_id = ? AND product_id = ?").get(cleanSession, productId);
    const nextQty = Math.min(maxStock, (current?.qty ?? 0) + delta);
    if (nextQty <= 0) {
      storeDb.prepare("DELETE FROM cart_items WHERE session_id = ? AND product_id = ?").run(cleanSession, productId);
    } else {
      storeDb.prepare(
        `INSERT INTO cart_items (session_id, product_id, qty, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, product_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`
      ).run(cleanSession, productId, nextQty, now);
    }
  });
  tx();
  return getPersistedCart(cleanSession);
}
function removeCartItem(sessionId, productId) {
  const cleanSession = sessionId.slice(0, 80);
  storeDb.prepare("DELETE FROM cart_items WHERE session_id = ? AND product_id = ?").run(cleanSession, productId);
  return getPersistedCart(cleanSession);
}
function executeTransactionalCheckout(input) {
  const cleanIdempotency = input.idempotencyKey?.trim().slice(0, 80) || null;
  if (cleanIdempotency) {
    const existing = storeDb.prepare("SELECT id FROM orders WHERE idempotency_key = ?").get(cleanIdempotency);
    if (existing) {
      const existingOrder = getRecentOrders(50).find((o) => o.id === existing.id);
      if (existingOrder) {
        return {
          order: existingOrder,
          inventoryUpdates: [],
          outboxEntries: [],
          deduplicated: true
        };
      }
    }
  }
  const runTx = storeDb.transaction(() => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let subtotalInr = 0;
    const resolvedItems = [];
    const selectProduct = storeDb.prepare("SELECT id, name, price_inr FROM products WHERE id = ?");
    const selectStock = storeDb.prepare(
      "SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?"
    );
    const decrementStock = storeDb.prepare(
      "UPDATE city_inventory SET stock_qty = stock_qty - ?, updated_at = ? WHERE product_id = ? AND city = ? AND stock_qty >= ?"
    );
    for (const line of input.items) {
      const qty = Math.max(1, Math.round(line.qty));
      const prod = selectProduct.get(line.productId);
      if (!prod) {
        throw new Error(`Product ${line.productId} not found.`);
      }
      const inv = selectStock.get(line.productId, input.city);
      const available = inv?.stock_qty ?? 0;
      if (available < qty) {
        throw new InsufficientStockError(prod.id, prod.name, input.city, available);
      }
      const updateResult = decrementStock.run(qty, now, prod.id, input.city, qty);
      if (updateResult.changes === 0) {
        throw new InsufficientStockError(prod.id, prod.name, input.city, 0);
      }
      subtotalInr += prod.price_inr * qty;
      resolvedItems.push({
        productId: prod.id,
        productName: prod.name,
        qty,
        unitPriceInr: prod.price_inr,
        newStockQty: available - qty
      });
    }
    const taxInr = Math.round(subtotalInr * 0.18);
    const deliveryInr = subtotalInr >= 1999 ? 0 : 99;
    const totalInr = subtotalInr + taxInr + deliveryInr;
    const custId = `cust_${crypto2.randomUUID().slice(0, 8)}`;
    storeDb.prepare(
      `INSERT INTO customers (id, name, email, default_city, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, default_city = excluded.default_city`
    ).run(custId, input.customerName, input.customerEmail, input.city, now);
    const actualCust = storeDb.prepare("SELECT id FROM customers WHERE email = ?").get(input.customerEmail);
    storeDb.prepare("INSERT INTO addresses (id, customer_id, city, line1, created_at) VALUES (?, ?, ?, ?, ?)").run(`addr_${crypto2.randomUUID().slice(0, 8)}`, actualCust.id, input.city, input.shippingAddress, now);
    const orderCount = storeDb.prepare("SELECT COUNT(*) as cnt FROM orders").get().cnt;
    const candidateId = `SS-ORD-${1001 + orderCount}`;
    const uniqueOrderId = storeDb.prepare("SELECT id FROM orders WHERE id = ?").get(candidateId) ? `SS-ORD-${Date.now().toString().slice(-6)}` : candidateId;
    storeDb.prepare(
      `INSERT INTO orders (
          id, idempotency_key, customer_name, customer_email, city, shipping_address,
          subtotal_inr, tax_inr, delivery_inr, total_inr, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
    ).run(
      uniqueOrderId,
      cleanIdempotency,
      input.customerName,
      input.customerEmail,
      input.city,
      input.shippingAddress,
      subtotalInr,
      taxInr,
      deliveryInr,
      totalInr,
      now
    );
    const insertItem = storeDb.prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price_inr)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const orderItems = [];
    for (const r of resolvedItems) {
      const itemId = `oi_${crypto2.randomUUID().slice(0, 8)}`;
      insertItem.run(itemId, uniqueOrderId, r.productId, r.productName, r.qty, r.unitPriceInr);
      orderItems.push({
        id: itemId,
        order_id: uniqueOrderId,
        product_id: r.productId,
        product_name: r.productName,
        qty: r.qty,
        unit_price_inr: r.unitPriceInr
      });
      storeDb.prepare(
        `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `mov_${crypto2.randomUUID().slice(0, 8)}`,
        r.productId,
        r.productName,
        input.city,
        -r.qty,
        r.newStockQty,
        `Order ${uniqueOrderId} committed`,
        input.customerEmail,
        now
      );
    }
    const paymentMethod = input.paymentMethod || "UPI_SIMULATION";
    const paymentRef = `SIM-${paymentMethod.slice(0, 3)}-${crypto2.randomUUID().slice(0, 6).toUpperCase()}`;
    storeDb.prepare(
      `INSERT INTO payments (id, order_id, method, status, amount_inr, reference_code, created_at)
         VALUES (?, ?, ?, 'simulated_authorized', ?, ?, ?)`
    ).run(`pay_${crypto2.randomUUID().slice(0, 8)}`, uniqueOrderId, paymentMethod, totalInr, paymentRef, now);
    if (input.sessionId) {
      storeDb.prepare("DELETE FROM cart_items WHERE session_id = ?").run(input.sessionId.slice(0, 80));
    }
    const insertOutbox = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, 'committed', 0, ?)`
    );
    const outboxEntries = [];
    const orderPlacedEventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
    const orderPayload = {
      eventId: orderPlacedEventId,
      orderId: uniqueOrderId,
      city: input.city,
      totalInr,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      items: resolvedItems.map((r) => ({ productId: r.productId, qty: r.qty })),
      timestamp: now
    };
    const info1 = insertOutbox.run(
      orderPlacedEventId,
      "order.placed",
      "OrderPlaced",
      input.city,
      JSON.stringify(orderPayload),
      now
    );
    outboxEntries.push({
      offset_id: Number(info1.lastInsertRowid),
      event_id: orderPlacedEventId,
      topic: "order.placed",
      event_type: "OrderPlaced",
      partition_key: input.city,
      payload: orderPayload,
      created_at: now
    });
    for (const r of resolvedItems) {
      const invEventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
      const invPayload = {
        eventId: invEventId,
        orderId: uniqueOrderId,
        productId: r.productId,
        city: input.city,
        delta: -r.qty,
        newStockQty: r.newStockQty,
        timestamp: now
      };
      const infoInv = insertOutbox.run(
        invEventId,
        "inventory.changed",
        "InventoryDecremented",
        `${r.productId}:${input.city}`,
        JSON.stringify(invPayload),
        now
      );
      outboxEntries.push({
        offset_id: Number(infoInv.lastInsertRowid),
        event_id: invEventId,
        topic: "inventory.changed",
        event_type: "InventoryDecremented",
        partition_key: `${r.productId}:${input.city}`,
        payload: invPayload,
        created_at: now
      });
    }
    return {
      order: {
        id: uniqueOrderId,
        idempotency_key: cleanIdempotency,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        city: input.city,
        shipping_address: input.shippingAddress,
        subtotal_inr: subtotalInr,
        tax_inr: taxInr,
        delivery_inr: deliveryInr,
        total_inr: totalInr,
        payment_method: paymentMethod,
        payment_status: "simulated_authorized",
        payment_reference: paymentRef,
        status: "confirmed",
        created_at: now,
        items: orderItems
      },
      inventoryUpdates: resolvedItems.map((r) => ({
        productId: r.productId,
        city: input.city,
        delta: -r.qty,
        newStockQty: r.newStockQty
      })),
      outboxEntries,
      deduplicated: false
    };
  });
  try {
    return runTx.immediate();
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      storeDb.prepare("UPDATE store_counters SET value = value + 1 WHERE key = ?").run("oversells_prevented");
    }
    throw err;
  }
}
function adjustCityInventory(productId, city, delta, actorEmail = "warehouse@storestream.in", reason = "Manual warehouse adjustment") {
  const tx = storeDb.transaction(() => {
    const prod = storeDb.prepare("SELECT id, name FROM products WHERE id = ?").get(productId);
    if (!prod) throw new Error("Product not found.");
    const row = storeDb.prepare("SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?").get(productId, city);
    const currentQty = row?.stock_qty ?? 0;
    const nextQty = Math.max(0, currentQty + delta);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    storeDb.prepare("UPDATE city_inventory SET stock_qty = ?, updated_at = ? WHERE product_id = ? AND city = ?").run(nextQty, now, productId, city);
    storeDb.prepare(
      `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`mov_${crypto2.randomUUID().slice(0, 8)}`, productId, prod.name, city, delta, nextQty, reason, actorEmail, now);
    const eventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
    const eventType = delta >= 0 ? "InventoryRestocked" : "InventoryAdjusted";
    const payload = {
      eventId,
      productId,
      productName: prod.name,
      city,
      delta,
      newStockQty: nextQty,
      timestamp: now
    };
    const info = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'inventory.changed', ?, ?, ?, 'committed', 0, ?)`
    ).run(eventId, eventType, `${productId}:${city}`, JSON.stringify(payload), now);
    return {
      productId,
      productName: prod.name,
      city,
      newStockQty: nextQty,
      delta,
      outboxEntry: {
        offset_id: Number(info.lastInsertRowid),
        event_id: eventId,
        topic: "inventory.changed",
        event_type: eventType,
        partition_key: `${productId}:${city}`,
        payload,
        created_at: now
      }
    };
  });
  return tx.immediate();
}
function createAdminProduct(input, actorEmail, actorRole) {
  const id = `prod_${crypto2.randomUUID().slice(0, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const safeImage = sanitizeImageUrl(input.image_url);
  const tx = storeDb.transaction(() => {
    storeDb.prepare("INSERT OR IGNORE INTO brands (id, name) VALUES (?, ?)").run(`brand_${input.brand.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, input.brand);
    storeDb.prepare(
      `INSERT INTO products (
          id, sku, name, brand, category, price_inr, discount_pct, rating, popularity, is_featured,
          description, specs_json, image_url, tags_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 4.7, 75, 0, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.sku.trim(),
      input.name.trim(),
      input.brand.trim(),
      input.category,
      Math.round(input.price_inr),
      Math.round(input.discount_pct),
      input.description.trim(),
      JSON.stringify(input.specs),
      safeImage,
      JSON.stringify(input.tags),
      now
    );
    const invStmt = storeDb.prepare(
      `INSERT INTO city_inventory (product_id, city, warehouse_code, stock_qty, low_stock_threshold, eta_label, updated_at)
       VALUES (?, ?, ?, ?, 3, ?, ?)`
    );
    for (const c of CITIES) {
      const m = CITY_META[c];
      invStmt.run(id, c, m.code, Math.max(0, Math.round(input.initialStock)), m.eta, now);
    }
    const eventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId: id, name: input.name, action: "created", timestamp: now };
    const info = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductCreated', ?, ?, 'committed', 0, ?)`
    ).run(eventId, id, JSON.stringify(payload), now);
    recordAuditLog(actorEmail, actorRole, "CREATE_PRODUCT", "product", id, `Created ${input.name} (${input.sku})`);
    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: "product.updated",
      event_type: "ProductCreated",
      partition_key: id,
      payload,
      created_at: now
    };
  });
  const outboxEntry = tx.immediate();
  const product = getAllProducts().find((p) => p.id === id);
  return { product, outboxEntry };
}
function updateAdminProduct(productId, patch, actorEmail, actorRole) {
  const tx = storeDb.transaction(() => {
    const existing = storeDb.prepare("SELECT * FROM products WHERE id = ?").get(productId);
    if (!existing) throw new Error("Product not found.");
    storeDb.prepare(
      `UPDATE products SET name = ?, price_inr = ?, discount_pct = ?, category = ?, description = ?, image_url = ? WHERE id = ?`
    ).run(
      patch.name?.trim() || existing.name,
      patch.price_inr !== void 0 ? Math.round(patch.price_inr) : existing.price_inr,
      patch.discount_pct !== void 0 ? Math.round(patch.discount_pct) : existing.discount_pct,
      patch.category || existing.category,
      patch.description?.trim() || existing.description,
      patch.image_url ? sanitizeImageUrl(patch.image_url) : existing.image_url,
      productId
    );
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const eventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId, action: "updated", timestamp: now };
    const info = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductUpdated', ?, ?, 'committed', 0, ?)`
    ).run(eventId, productId, JSON.stringify(payload), now);
    recordAuditLog(actorEmail, actorRole, "UPDATE_PRODUCT", "product", productId, `Updated product ${patch.name || existing.name}`);
    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: "product.updated",
      event_type: "ProductUpdated",
      partition_key: productId,
      payload,
      created_at: now
    };
  });
  return tx.immediate();
}
function deleteAdminProduct(productId, actorEmail, actorRole) {
  const tx = storeDb.transaction(() => {
    const existing = storeDb.prepare("SELECT name FROM products WHERE id = ?").get(productId);
    if (!existing) throw new Error("Product not found.");
    storeDb.prepare("DELETE FROM products WHERE id = ?").run(productId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const eventId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId, action: "deleted", timestamp: now };
    const info = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductDeleted', ?, ?, 'committed', 0, ?)`
    ).run(eventId, productId, JSON.stringify(payload), now);
    recordAuditLog(actorEmail, actorRole, "DELETE_PRODUCT", "product", productId, `Deleted product ${existing.name}`);
    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: "product.updated",
      event_type: "ProductDeleted",
      partition_key: productId,
      payload,
      created_at: now
    };
  });
  return tx.immediate();
}
function updateOrderLifecycle(orderId, nextStatus, actorEmail, actorRole) {
  const tx = storeDb.transaction(() => {
    const order = storeDb.prepare("SELECT id, city, customer_email, status FROM orders WHERE id = ?").get(orderId);
    if (!order) throw new Error("Order not found.");
    if (order.status === "cancelled") {
      throw new Error("Cancelled orders cannot be transitioned.");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const outboxEntries = [];
    if (nextStatus === "cancelled") {
      const items = storeDb.prepare("SELECT product_id, product_name, qty FROM order_items WHERE order_id = ?").all(orderId);
      for (const item of items) {
        storeDb.prepare("UPDATE city_inventory SET stock_qty = stock_qty + ?, updated_at = ? WHERE product_id = ? AND city = ?").run(item.qty, now, item.product_id, order.city);
        const invRow = storeDb.prepare("SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?").get(item.product_id, order.city);
        storeDb.prepare(
          `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `mov_${crypto2.randomUUID().slice(0, 8)}`,
          item.product_id,
          item.product_name,
          order.city,
          item.qty,
          invRow?.stock_qty ?? item.qty,
          `Order ${orderId} cancelled & refunded`,
          actorEmail,
          now
        );
        const invEvtId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
        const invPayload = {
          eventId: invEvtId,
          orderId,
          productId: item.product_id,
          city: order.city,
          delta: item.qty,
          newStockQty: invRow?.stock_qty ?? item.qty,
          timestamp: now
        };
        const invInfo = storeDb.prepare(
          `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
             VALUES (?, 'inventory.changed', 'InventoryRestored', ?, ?, 'committed', 0, ?)`
        ).run(invEvtId, `${item.product_id}:${order.city}`, JSON.stringify(invPayload), now);
        outboxEntries.push({
          offset_id: Number(invInfo.lastInsertRowid),
          event_id: invEvtId,
          topic: "inventory.changed",
          event_type: "InventoryRestored",
          partition_key: `${item.product_id}:${order.city}`,
          payload: invPayload,
          created_at: now
        });
      }
      storeDb.prepare("UPDATE payments SET status = 'simulated_refunded' WHERE order_id = ?").run(orderId);
      const cancelEvtId = `evt_${crypto2.randomUUID().slice(0, 12)}`;
      const cancelPayload = {
        eventId: cancelEvtId,
        orderId,
        city: order.city,
        customerEmail: order.customer_email,
        timestamp: now
      };
      const cancelInfo = storeDb.prepare(
        `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
           VALUES (?, 'order.cancelled', 'OrderCancelled', ?, ?, 'committed', 0, ?)`
      ).run(cancelEvtId, orderId, JSON.stringify(cancelPayload), now);
      outboxEntries.push({
        offset_id: Number(cancelInfo.lastInsertRowid),
        event_id: cancelEvtId,
        topic: "order.cancelled",
        event_type: "OrderCancelled",
        partition_key: orderId,
        payload: cancelPayload,
        created_at: now
      });
    }
    storeDb.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, orderId);
    recordAuditLog(actorEmail, actorRole, "ORDER_STATUS", "order", orderId, `Updated order ${orderId} \u2192 ${nextStatus}`);
    return outboxEntries;
  });
  return tx.immediate();
}
function getStoreSnapshot(indexedDocuments, lastIndexedAt) {
  const products = getAllProducts();
  const orders = getRecentOrders(30);
  const events = getRecentEvents(50);
  const confirmations = getRecentNotifications(30);
  const stockMovements = storeDb.prepare("SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 30").all();
  const auditLogs = storeDb.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30").all();
  const totalOrders = storeDb.prepare("SELECT COUNT(*) as cnt FROM orders").get().cnt;
  const totalRevenueInr = storeDb.prepare("SELECT COALESCE(SUM(total_inr), 0) as rev FROM orders WHERE status != 'cancelled'").get().rev;
  const activeCustomers = storeDb.prepare("SELECT COUNT(*) as cnt FROM customers").get().cnt;
  const totalEventsProcessed = storeDb.prepare("SELECT COUNT(*) as cnt FROM event_log").get().cnt;
  const dlqEventsCount = storeDb.prepare("SELECT COUNT(*) as cnt FROM event_log WHERE consumer_status = 'dlq'").get().cnt;
  const oversellsPrevented = storeDb.prepare("SELECT value FROM store_counters WHERE key = ?").get("oversells_prevented")?.value ?? 0;
  const confirmationsSent = storeDb.prepare("SELECT COUNT(*) as cnt FROM notifications").get().cnt;
  const activeCartItems = storeDb.prepare("SELECT COALESCE(SUM(qty), 0) as cnt FROM cart_items").get().cnt;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const p of products) {
    for (const c of CITIES) {
      const qty = p.inventory_by_city[c]?.stock_qty ?? 0;
      if (qty === 0) outOfStockCount++;
      else if (qty <= 3) lowStockCount++;
    }
  }
  const awaitingProcessingCount = storeDb.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'confirmed'").get().cnt;
  const cityRevMap = /* @__PURE__ */ new Map();
  for (const c of CITIES) cityRevMap.set(c, { revenue: 0, orders: 0 });
  const orderCityRows = storeDb.prepare("SELECT city, total_inr FROM orders WHERE status != 'cancelled'").all();
  for (const r of orderCityRows) {
    const prev = cityRevMap.get(r.city) || { revenue: 0, orders: 0 };
    cityRevMap.set(r.city, { revenue: prev.revenue + r.total_inr, orders: prev.orders + 1 });
  }
  const categoryPerfMap = /* @__PURE__ */ new Map();
  for (const cat of CATEGORIES) {
    categoryPerfMap.set(cat, { products: 0, unitsInStock: 0, revenue: 0 });
  }
  for (const p of products) {
    const entry = categoryPerfMap.get(p.category) || { products: 0, unitsInStock: 0, revenue: 0 };
    const stockSum = CITIES.reduce((s, c) => s + (p.inventory_by_city[c]?.stock_qty ?? 0), 0);
    entry.products += 1;
    entry.unitsInStock += stockSum;
    categoryPerfMap.set(p.category, entry);
  }
  const itemRevRows = storeDb.prepare(
    `SELECT p.category, SUM(oi.qty * oi.unit_price_inr) as rev
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'cancelled'
       GROUP BY p.category`
  ).all();
  for (const row of itemRevRows) {
    const entry = categoryPerfMap.get(row.category);
    if (entry) entry.revenue = row.rev;
  }
  const analytics = {
    totalRevenueInr,
    totalOrders,
    activeCustomers,
    lowStockCount,
    outOfStockCount,
    awaitingProcessingCount,
    revenueByCity: CITIES.map((city) => ({
      city,
      revenue: cityRevMap.get(city)?.revenue || 0,
      orders: cityRevMap.get(city)?.orders || 0
    })),
    categoryPerformance: CATEGORIES.map((category) => ({
      category,
      ...categoryPerfMap.get(category)
    })),
    topProducts: [...products].sort((a, b) => b.popularity - a.popularity).slice(0, 6).map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      popularity: p.popularity,
      price_inr: p.price_inr,
      stockTotal: CITIES.reduce((s, c) => s + (p.inventory_by_city[c]?.stock_qty ?? 0), 0)
    }))
  };
  return {
    cities: CITIES,
    categories: CATEGORIES,
    products,
    orders,
    confirmations,
    events,
    stockMovements,
    auditLogs,
    analytics,
    infrastructure: aivenBridge.getStatus(),
    lastIndexedAt,
    metrics: {
      totalProducts: products.length,
      totalOrders,
      totalRevenueInr,
      totalEventsProcessed,
      indexedDocuments,
      oversellsPrevented,
      confirmationsSent,
      activeCartItems,
      dlqEventsCount
    }
  };
}

// server/search-engine.ts
var OpenSearchEngine = class {
  constructor() {
    this.docs = /* @__PURE__ */ new Map();
    this.lastIndexedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  rebuildFromDatabase() {
    const products = getAllProducts();
    this.docs.clear();
    for (const product of products) {
      this.upsertProduct(product);
    }
    this.lastIndexedAt = (/* @__PURE__ */ new Date()).toISOString();
    return this.docs.size;
  }
  upsertProduct(product) {
    const rawText = [
      product.name,
      product.brand,
      product.category,
      product.sku,
      product.description,
      ...product.tags,
      ...product.specs
    ].join(" ").toLowerCase();
    const tokens = Array.from(
      new Set(
        rawText.split(/[^a-z0-9]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
      )
    );
    this.docs.set(product.id, {
      product,
      tokens,
      searchableText: rawText
    });
    const totalStock = CITIES.reduce(
      (sum, c) => sum + (product.inventory_by_city[c]?.stock_qty ?? 0),
      0
    );
    const cityAvailability = {};
    for (const c of CITIES) {
      cityAvailability[c] = product.inventory_by_city[c]?.stock_qty ?? 0;
    }
    void aivenBridge.indexOpenSearchDocument(product.id, {
      product_id: product.id,
      sku: product.sku,
      product_name: product.name,
      description: product.description,
      category: product.category,
      brand: product.brand,
      price: product.price_inr,
      discount_pct: product.discount_pct,
      rating: product.rating,
      popularity: product.popularity,
      available_stock: totalStock,
      city_availability: cityAvailability,
      tags: product.tags,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  getDocumentCount() {
    return this.docs.size;
  }
  getLastIndexedAt() {
    return this.lastIndexedAt;
  }
  suggest(query, city, limit = 6) {
    const res = this.search({ query, city });
    return res.hits.slice(0, limit).map((h) => ({
      product_id: h.id,
      name: h.name,
      brand: h.brand,
      category: h.category,
      price_inr: h.price_inr,
      stock_in_city: h.inventory_by_city[city]?.stock_qty ?? 0,
      matched_via: h.matched_via
    }));
  }
  search(params) {
    const started = performance.now();
    const q = params.query.trim().toLowerCase();
    const queryTokens = q.split(/[^a-z0-9]+/).map((t) => t.trim()).filter(Boolean);
    const allDocs = Array.from(this.docs.values());
    const hits = [];
    const fuzzyNotes = /* @__PURE__ */ new Set();
    for (const doc of allDocs) {
      const p = doc.product;
      if (params.category && params.category !== "all" && p.category !== params.category) {
        continue;
      }
      if (params.brand && params.brand !== "all" && p.brand !== params.brand) {
        continue;
      }
      if (params.minPrice !== void 0 && p.price_inr < params.minPrice) {
        continue;
      }
      if (params.maxPrice !== void 0 && p.price_inr > params.maxPrice) {
        continue;
      }
      if (params.minRating !== void 0 && p.rating < params.minRating) {
        continue;
      }
      const cityInv = p.inventory_by_city[params.city];
      if (params.inStockOnly && (!cityInv || cityInv.stock_qty <= 0)) {
        continue;
      }
      if (queryTokens.length === 0) {
        hits.push({
          ...p,
          relevance_score: (cityInv && cityInv.stock_qty > 0 ? 100 : 60) + p.popularity * 0.2,
          matched_via: "exact"
        });
        continue;
      }
      let totalScore = 0;
      let matchMode = "exact";
      let matchedTokens = 0;
      for (const qt of queryTokens) {
        if (doc.searchableText.includes(qt)) {
          const inTitleOrBrand = p.name.toLowerCase().includes(qt) || p.brand.toLowerCase().includes(qt);
          totalScore += inTitleOrBrand ? 55 : 30;
          matchedTokens++;
          continue;
        }
        const prefixHit = doc.tokens.find((tok) => tok.startsWith(qt) && qt.length >= 3);
        if (prefixHit) {
          totalScore += 32;
          if (matchMode === "exact") matchMode = "prefix";
          matchedTokens++;
          continue;
        }
        const maxEdits = qt.length >= 6 ? 2 : 1;
        let bestDist = Infinity;
        let bestToken = "";
        for (const tok of doc.tokens) {
          if (Math.abs(tok.length - qt.length) > maxEdits) continue;
          const dist = damerauLevenshtein(qt, tok);
          if (dist <= maxEdits && dist < bestDist) {
            bestDist = dist;
            bestToken = tok;
          }
        }
        if (bestDist <= maxEdits) {
          totalScore += bestDist === 1 ? 26 : 18;
          matchMode = "fuzzy";
          matchedTokens++;
          fuzzyNotes.add(`"${qt}" \u2192 "${bestToken}"`);
        }
      }
      if (matchedTokens > 0) {
        const completenessBonus = matchedTokens === queryTokens.length ? 40 : 0;
        const stockBoost = cityInv && cityInv.stock_qty > 0 ? 10 : 0;
        hits.push({
          ...p,
          relevance_score: totalScore + completenessBonus + stockBoost,
          matched_via: matchMode
        });
      }
    }
    const sort = params.sort || "relevance";
    hits.sort((a, b) => {
      if (sort === "price_asc") return a.price_inr - b.price_inr;
      if (sort === "price_desc") return b.price_inr - a.price_inr;
      if (sort === "popularity") return b.popularity - a.popularity;
      if (sort === "rating") return b.rating - a.rating;
      return b.relevance_score - a.relevance_score;
    });
    const categoryMap = /* @__PURE__ */ new Map();
    const brandMap = /* @__PURE__ */ new Map();
    let inStockCount = 0;
    for (const doc of allDocs) {
      const cat = doc.product.category;
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
      brandMap.set(doc.product.brand, (brandMap.get(doc.product.brand) || 0) + 1);
      if ((doc.product.inventory_by_city[params.city]?.stock_qty || 0) > 0) {
        inStockCount++;
      }
    }
    const osLive = Boolean(aivenBridge.getOpenSearchClient());
    return {
      query: params.query,
      city: params.city,
      total_hits: hits.length,
      fuzzy_corrected_note: fuzzyNotes.size > 0 ? `Typo-tolerant match: ${Array.from(fuzzyNotes).join(", ")}` : null,
      took_ms: Math.max(1, Math.round((performance.now() - started) * 10) / 10),
      engine: osLive ? "opensearch_live" : "opensearch_local_demo",
      last_indexed_at: this.lastIndexedAt,
      hits,
      facets: {
        categories: Array.from(categoryMap.entries()).map(([category, count]) => ({
          category,
          count
        })),
        brands: Array.from(brandMap.entries()).map(([brand, count]) => ({ brand, count })).sort((a, b) => a.brand.localeCompare(b.brand)),
        city_stock: CITIES.map((city) => ({
          city,
          in_stock_count: allDocs.filter(
            (doc) => (doc.product.inventory_by_city[city]?.stock_qty || 0) > 0
          ).length
        })),
        in_stock_in_city: inStockCount
      }
    };
  }
};
function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }
  return dp[m][n];
}
var searchIndex = new OpenSearchEngine();

// workers/event-consumers.ts
function claimConsumerIdempotency(eventId, consumerGroup) {
  const result = storeDb.prepare(
    "INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)"
  ).run(eventId, consumerGroup, (/* @__PURE__ */ new Date()).toISOString());
  return result.changes > 0;
}
function runInventoryConsumer(event) {
  if (!claimConsumerIdempotency(event.event_id, "cg-inventory")) {
    return { processed: false };
  }
  let lowStockAlert;
  if (event.topic === "inventory.changed") {
    const newQty = Number(event.payload.newStockQty ?? -1);
    const productId = String(event.payload.productId || "");
    const city = String(event.payload.city || "");
    if (newQty >= 0 && newQty <= 3 && productId && city) {
      lowStockAlert = `Low-stock alert: ${productId} in ${city} has ${newQty} unit(s) left.`;
    }
  }
  return { processed: true, lowStockAlert };
}
function runSearchIndexConsumer(event) {
  if (!claimConsumerIdempotency(event.event_id, "cg-search-sync")) {
    return { processed: false, indexedDocuments: searchIndex.getDocumentCount() };
  }
  const indexedDocuments = searchIndex.rebuildFromDatabase();
  return { processed: true, indexedDocuments };
}
function runNotificationConsumer(event) {
  if (!claimConsumerIdempotency(event.event_id, "cg-notifications")) {
    return { processed: false, notificationCreated: false };
  }
  if (event.topic === "order.placed" && typeof event.payload.orderId === "string" && typeof event.payload.customerEmail === "string" && typeof event.payload.city === "string") {
    const orderId = event.payload.orderId;
    const customerEmail = event.payload.customerEmail;
    const city = event.payload.city;
    recordOrderNotification(
      orderId,
      customerEmail,
      city,
      `Order ${orderId} confirmed \xB7 Stock reserved in ${city}.`
    );
    const confirmEventId = `evt_conf_${event.event_id}`;
    storeDb.prepare(
      `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'order.confirmed', 'OrderConfirmed', ?, ?, 'indexed_and_confirmed', 0, ?)`
    ).run(
      confirmEventId,
      orderId,
      JSON.stringify({ orderId, customerEmail, city, sourceEventId: event.event_id }),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    return { processed: true, notificationCreated: true };
  }
  if (event.topic === "order.cancelled" && typeof event.payload.orderId === "string" && typeof event.payload.customerEmail === "string" && typeof event.payload.city === "string") {
    recordOrderNotification(
      event.payload.orderId,
      event.payload.customerEmail,
      event.payload.city,
      `Order ${event.payload.orderId} cancelled \xB7 Simulated payment refunded & ${event.payload.city} stock restored.`
    );
    return { processed: true, notificationCreated: true };
  }
  return { processed: true, notificationCreated: false };
}
function routeEventToDeadLetter(event, reason) {
  const dlqId = `dlq_${crypto3.randomUUID().slice(0, 8)}`;
  storeDb.prepare("UPDATE event_log SET consumer_status = 'dlq', retry_count = retry_count + 1, last_error = ? WHERE event_id = ?").run(reason, event.event_id);
  storeDb.prepare(
    `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, last_error, created_at)
       VALUES (?, 'storestream.dlq', 'DeadLetterRouted', ?, ?, 'dlq', 1, ?, ?)`
  ).run(
    dlqId,
    `${event.topic}:${event.event_id}`,
    JSON.stringify({ failedEventId: event.event_id, originalTopic: event.topic, reason }),
    reason,
    (/* @__PURE__ */ new Date()).toISOString()
  );
}

// server/event-bus.ts
var StoreEventBus = class {
  constructor() {
    this.broadcaster = null;
  }
  registerBroadcaster(fn) {
    this.broadcaster = fn;
  }
  dispatchCommittedOutbox(entries) {
    for (const entry of entries) {
      const initialRecord = {
        offset_id: entry.offset_id,
        event_id: entry.event_id,
        topic: entry.topic,
        event_type: entry.event_type,
        partition_key: entry.partition_key,
        payload: entry.payload,
        consumer_status: "committed",
        retry_count: 0,
        last_error: null,
        consumer_groups_processed: [],
        created_at: entry.created_at
      };
      this.broadcaster?.("stream:event", initialRecord);
      void aivenBridge.publishKafkaMessage(entry.topic, entry.partition_key, {
        eventId: entry.event_id,
        eventType: entry.event_type,
        ...entry.payload
      });
      queueMicrotask(() => {
        this.processWithRetry(entry, 0);
      });
    }
  }
  processWithRetry(entry, attempt) {
    try {
      const invRes = runInventoryConsumer(entry);
      const searchRes = runSearchIndexConsumer(entry);
      const notifRes = runNotificationConsumer(entry);
      storeDb.prepare("UPDATE event_log SET consumer_status = 'indexed_and_confirmed' WHERE event_id = ?").run(entry.event_id);
      const finalized = {
        offset_id: entry.offset_id,
        event_id: entry.event_id,
        topic: entry.topic,
        event_type: entry.event_type,
        partition_key: entry.partition_key,
        payload: entry.payload,
        consumer_status: "indexed_and_confirmed",
        retry_count: attempt,
        last_error: null,
        consumer_groups_processed: ["cg-inventory", "cg-search-sync", "cg-notifications"],
        created_at: entry.created_at
      };
      this.broadcaster?.("stream:consumer_ack", {
        event: finalized,
        indexedDocuments: searchRes.indexedDocuments,
        notificationCreated: notifRes.notificationCreated,
        lowStockAlert: invRes.lowStockAlert
      });
      const snapshot = getStoreSnapshot(
        searchIndex.getDocumentCount(),
        searchIndex.getLastIndexedAt()
      );
      this.broadcaster?.("store:synced", snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Consumer execution failed";
      if (attempt < 2) {
        storeDb.prepare("UPDATE event_log SET retry_count = retry_count + 1, last_error = ? WHERE event_id = ?").run(msg, entry.event_id);
        setTimeout(() => this.processWithRetry(entry, attempt + 1), 150 * (attempt + 1));
      } else {
        routeEventToDeadLetter(entry, msg);
      }
    }
  }
};
var eventBus = new StoreEventBus();

// server/app.ts
var VALID_CITIES = new Set(CITIES);
var VALID_CATEGORIES = new Set(CATEGORIES);
var IS_SERVERLESS2 = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
var UPLOAD_DIR = IS_SERVERLESS2 ? path2.join(os2.tmpdir(), "storestream_uploads") : path2.resolve(process.cwd(), "public", "uploads");
fs2.mkdirSync(UPLOAD_DIR, { recursive: true });
var upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path2.extname(file.originalname).toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
      cb(null, `prod_${crypto4.randomUUID().slice(0, 8)}${safeExt}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  }
});
var cityEnum = z.enum(["Bengaluru", "Mumbai", "Delhi NCR", "Hyderabad", "Chennai", "Pune"]);
var categoryEnum = z.enum([
  "Electronics",
  "Fashion",
  "Home and Kitchen",
  "Grocery",
  "Accessories",
  "Beauty",
  "Sports"
]);
var registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(120),
  defaultCity: cityEnum.default("Bengaluru")
});
var loginSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(4).max(120)
});
var claimAdminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(120),
  role: z.enum(["Administrator", "Inventory Manager"]).default("Administrator")
});
var cartItemSchema = z.object({
  sessionId: z.string().trim().min(1).max(80),
  city: cityEnum,
  productId: z.string().trim().min(1).max(80),
  delta: z.number().int().min(-50).max(50)
});
var checkoutSchema = z.object({
  sessionId: z.string().trim().max(80).optional(),
  idempotencyKey: z.string().trim().max(80).optional(),
  customerName: z.string().trim().min(2).max(80),
  customerEmail: z.string().trim().email().max(120),
  city: cityEnum,
  shippingAddress: z.string().trim().min(4).max(240),
  paymentMethod: z.enum(["UPI_SIMULATION", "CARD_SIMULATION", "COD_SIMULATION"]).optional(),
  items: z.array(
    z.object({
      productId: z.string().trim().min(1).max(80),
      qty: z.number().int().min(1).max(50)
    })
  ).min(1)
});
var createProductSchema = z.object({
  sku: z.string().trim().min(3).max(40),
  name: z.string().trim().min(2).max(140),
  brand: z.string().trim().min(2).max(60),
  category: categoryEnum,
  price_inr: z.number().positive().max(2e6),
  discount_pct: z.number().int().min(0).max(90).default(0),
  description: z.string().trim().min(5).max(800),
  specs: z.array(z.string().trim().min(1).max(120)).default([]),
  image_url: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  initialStock: z.number().int().min(0).max(1e3).default(5)
});
var updateProductSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  price_inr: z.number().positive().max(2e6).optional(),
  discount_pct: z.number().int().min(0).max(90).optional(),
  category: categoryEnum.optional(),
  description: z.string().trim().min(5).max(800).optional(),
  image_url: z.string().trim().min(1).max(300).optional()
});
var restockSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  city: cityEnum,
  delta: z.number().int().min(-500).max(500),
  reason: z.string().trim().max(140).optional()
});
var orderStatusSchema = z.object({
  status: z.enum(["confirmed", "packing", "dispatched", "delivered", "cancelled"])
});
function createStoreStreamApp(broadcastEvent) {
  initStoreDatabase();
  searchIndex.rebuildFromDatabase();
  if (broadcastEvent) {
    eventBus.registerBroadcaster(broadcastEvent);
  }
  const app = express();
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/", createRateLimiter(300, 6e4));
  app.use("/uploads", express.static(UPLOAD_DIR));
  app.get("/api/health", (_req, res) => {
    const infra = aivenBridge.getStatus();
    res.json({
      status: "ok",
      service: "storestream",
      realtimeTransport: IS_SERVERLESS2 ? "http" : "websocket",
      infrastructureMode: infra.mode,
      infrastructure: infra,
      indexedDocuments: searchIndex.getDocumentCount(),
      lastIndexedAt: searchIndex.getLastIndexedAt(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  });
  app.get("/api/auth/status", (_req, res) => {
    res.json({
      adminClaimed: hasAdminClaimed(),
      envPasscodeConfigured: Boolean(process.env.ADMIN_PASSCODE?.trim())
    });
  });
  app.post("/api/auth/claim-admin", (req, res) => {
    const parsed = claimAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid admin claim details." });
      return;
    }
    try {
      const user = claimInitialAdmin(parsed.data);
      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      });
      res.status(201).json({ user, token });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Admin claim unavailable." });
    }
  });
  app.post("/api/auth/register", (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid registration data." });
      return;
    }
    try {
      const user = registerCustomer(parsed.data);
      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      });
      res.status(201).json({ user, token });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Registration failed." });
      return;
    }
  });
  app.post("/api/auth/login", (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Valid email and password are required." });
      return;
    }
    const user = authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    const token = signJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    });
    res.json({ user, token });
  });
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.authUser });
  });
  app.get("/api/store/snapshot", (_req, res) => {
    res.json(getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt()));
  });
  app.post("/api/notifications/mark-read", (_req, res) => {
    markAllNotificationsRead();
    const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
    broadcastEvent?.("store:synced", snapshot);
    res.json({ snapshot });
  });
  app.get("/api/search/suggest", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
    const rawCity = typeof req.query.city === "string" ? req.query.city : "Bengaluru";
    const city = VALID_CITIES.has(rawCity) ? rawCity : "Bengaluru";
    res.json({
      query,
      city,
      suggestions: searchIndex.suggest(query, city, 6)
    });
  });
  app.get("/api/search", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const rawCity = typeof req.query.city === "string" ? req.query.city : "Bengaluru";
    const city = VALID_CITIES.has(rawCity) ? rawCity : "Bengaluru";
    const rawCat = typeof req.query.category === "string" ? req.query.category : void 0;
    const category = rawCat && VALID_CATEGORIES.has(rawCat) ? rawCat : "all";
    const brand = typeof req.query.brand === "string" && req.query.brand.trim() ? req.query.brand.trim() : "all";
    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : void 0;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : void 0;
    const minRating = req.query.minRating ? Number(req.query.minRating) : void 0;
    const inStockOnly = req.query.inStockOnly === "true";
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort : "relevance";
    res.json(
      searchIndex.search({
        query,
        city,
        category,
        brand,
        minPrice: Number.isFinite(minPrice) ? minPrice : void 0,
        maxPrice: Number.isFinite(maxPrice) ? maxPrice : void 0,
        minRating: Number.isFinite(minRating) ? minRating : void 0,
        inStockOnly,
        sort: sortRaw
      })
    );
  });
  app.get("/api/cart", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.trim() ? req.query.sessionId.trim() : "default-session";
    res.json(getPersistedCart(sessionId));
  });
  app.put("/api/cart/city", (req, res) => {
    const parsed = z.object({ sessionId: z.string().trim().min(1).max(80), city: cityEnum }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Valid sessionId and city are required." });
      return;
    }
    const cart = setCartCity(parsed.data.sessionId, parsed.data.city);
    broadcastEvent?.(
      "store:synced",
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });
  app.post("/api/cart/items", (req, res) => {
    const parsed = cartItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Valid sessionId, city, productId, and numeric delta are required." });
      return;
    }
    const cart = upsertCartItem(
      parsed.data.sessionId,
      parsed.data.city,
      parsed.data.productId,
      parsed.data.delta
    );
    broadcastEvent?.(
      "store:synced",
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });
  app.delete("/api/cart/items/:productId", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.trim() ? req.query.sessionId.trim() : "default-session";
    const cart = removeCartItem(sessionId, req.params.productId);
    broadcastEvent?.(
      "store:synced",
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });
  app.post("/api/orders/checkout", optionalAuth, (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid checkout payload." });
      return;
    }
    const idempotencyKey = typeof req.headers["idempotency-key"] === "string" && req.headers["idempotency-key"] || parsed.data.idempotencyKey;
    try {
      const result = executeTransactionalCheckout({
        sessionId: parsed.data.sessionId,
        idempotencyKey,
        customerName: parsed.data.customerName,
        customerEmail: parsed.data.customerEmail,
        city: parsed.data.city,
        shippingAddress: parsed.data.shippingAddress,
        paymentMethod: parsed.data.paymentMethod,
        items: parsed.data.items
      });
      if (!result.deduplicated && result.outboxEntries.length > 0) {
        eventBus.dispatchCommittedOutbox(result.outboxEntries);
      }
      const snapshot = getStoreSnapshot(
        searchIndex.getDocumentCount(),
        searchIndex.getLastIndexedAt()
      );
      broadcastEvent?.("store:synced", snapshot);
      res.status(result.deduplicated ? 200 : 201).json({
        order: result.order,
        deduplicated: result.deduplicated,
        snapshot
      });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        const snapshot = getStoreSnapshot(
          searchIndex.getDocumentCount(),
          searchIndex.getLastIndexedAt()
        );
        broadcastEvent?.("store:synced", snapshot);
        res.status(409).json({
          error: err.message,
          code: "INSUFFICIENT_STOCK",
          available: err.available,
          snapshot
        });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Checkout failed." });
    }
  });
  app.post("/api/orders/race-test", async (req, res) => {
    const parsed = z.object({
      productId: z.string().trim().default("prod_earphones"),
      city: cityEnum.default("Bengaluru")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid race test parameters." });
      return;
    }
    const { productId, city } = parsed.data;
    const product = getAllProducts().find((p) => p.id === productId);
    if (!product) {
      res.status(404).json({ error: "Product not found." });
      return;
    }
    const stockBefore = product.inventory_by_city[city]?.stock_qty ?? 0;
    const attemptBuyer = async (buyerLabel, email) => {
      const start = performance.now();
      try {
        const { order, outboxEntries } = executeTransactionalCheckout({
          customerName: buyerLabel,
          customerEmail: email,
          city,
          shippingAddress: `Express Demo Fulfillment Hub, ${city}`,
          paymentMethod: "UPI_SIMULATION",
          items: [{ productId, qty: 1 }]
        });
        eventBus.dispatchCommittedOutbox(outboxEntries);
        return {
          buyer: buyerLabel,
          statusCode: 201,
          outcome: "confirmed",
          orderId: order.id,
          message: `Transaction committed \xB7 Order ${order.id} confirmed`,
          durationMs: Math.round((performance.now() - start) * 10) / 10
        };
      } catch (err) {
        return {
          buyer: buyerLabel,
          statusCode: 409,
          outcome: "rejected_oversell",
          message: err instanceof Error ? err.message : "Out of stock",
          durationMs: Math.round((performance.now() - start) * 10) / 10
        };
      }
    };
    const outcomes = await Promise.all([
      attemptBuyer("Customer A (Web Browser)", "customer.a@example.in"),
      attemptBuyer("Customer B (Mobile App)", "customer.b@example.in")
    ]);
    const afterProd = getAllProducts().find((p) => p.id === productId);
    const stockAfter = afterProd?.inventory_by_city[city]?.stock_qty ?? 0;
    const snapshot = getStoreSnapshot(
      searchIndex.getDocumentCount(),
      searchIndex.getLastIndexedAt()
    );
    broadcastEvent?.("store:synced", snapshot);
    const report = {
      productId,
      productName: product.name,
      city,
      stockBefore,
      stockAfter,
      outcomes
    };
    res.json({ report, snapshot });
  });
  app.post("/api/demo/reset-race-stock", (req, res) => {
    const parsed = z.object({
      productId: z.string().trim().default("prod_earphones"),
      city: cityEnum.default("Bengaluru")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid parameters." });
      return;
    }
    const { productId, city } = parsed.data;
    const current = getAllProducts().find((p) => p.id === productId)?.inventory_by_city[city]?.stock_qty ?? 0;
    const delta = 1 - current;
    const updated = adjustCityInventory(
      productId,
      city,
      delta,
      "demo@storestream.in",
      "Reset to 1 unit for Hackathon Race Test"
    );
    eventBus.dispatchCommittedOutbox([updated.outboxEntry]);
    const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
    broadcastEvent?.("store:synced", snapshot);
    res.json({ updated, snapshot });
  });
  app.post(
    "/api/admin/upload",
    requireAuth,
    requireRoles("Administrator"),
    upload.single("image"),
    (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: "Valid JPG, PNG, or WEBP image (max 2MB) is required." });
        return;
      }
      const resolved = path2.resolve(req.file.path);
      if (!resolved.startsWith(UPLOAD_DIR + path2.sep)) {
        res.status(400).json({ error: "Invalid upload destination." });
        return;
      }
      res.status(201).json({ imageUrl: `/uploads/${path2.basename(resolved)}` });
    }
  );
  app.post(
    "/api/admin/products",
    requireAuth,
    requireRoles("Administrator"),
    (req, res) => {
      const parsed = createProductSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid product payload." });
        return;
      }
      try {
        const { product, outboxEntry } = createAdminProduct(
          parsed.data,
          req.authUser.email,
          req.authUser.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.("store:synced", snapshot);
        res.status(201).json({ product, snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create product." });
      }
    }
  );
  app.patch(
    "/api/admin/products/:id",
    requireAuth,
    requireRoles("Administrator"),
    (req, res) => {
      const parsed = updateProductSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid update payload." });
        return;
      }
      try {
        const outboxEntry = updateAdminProduct(
          req.params.id,
          parsed.data,
          req.authUser.email,
          req.authUser.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.("store:synced", snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : "Product update failed." });
      }
    }
  );
  app.delete(
    "/api/admin/products/:id",
    requireAuth,
    requireRoles("Administrator"),
    (req, res) => {
      try {
        const outboxEntry = deleteAdminProduct(
          req.params.id,
          req.authUser.email,
          req.authUser.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.("store:synced", snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : "Product deletion failed." });
      }
    }
  );
  app.post(
    "/api/admin/inventory/restock",
    requireAuth,
    requireRoles("Administrator", "Inventory Manager"),
    (req, res) => {
      const parsed = restockSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid inventory update." });
        return;
      }
      try {
        const updated = adjustCityInventory(
          parsed.data.productId,
          parsed.data.city,
          parsed.data.delta,
          req.authUser.email,
          parsed.data.reason || "Admin warehouse adjustment"
        );
        eventBus.dispatchCommittedOutbox([updated.outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.("store:synced", snapshot);
        res.json({ updated, snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Stock adjustment failed." });
      }
    }
  );
  app.patch(
    "/api/admin/orders/:id/status",
    requireAuth,
    requireRoles("Administrator", "Inventory Manager"),
    (req, res) => {
      const parsed = orderStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Valid order status is required." });
        return;
      }
      try {
        const outboxEntries = updateOrderLifecycle(
          req.params.id,
          parsed.data.status,
          req.authUser.email,
          req.authUser.role
        );
        if (outboxEntries.length > 0) {
          eventBus.dispatchCommittedOutbox(outboxEntries);
        }
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.("store:synced", snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Order status update failed." });
      }
    }
  );
  app.post(
    "/api/admin/events/:eventId/replay",
    requireAuth,
    requireRoles("Administrator"),
    (req, res) => {
      const row = storeDb.prepare("SELECT * FROM event_log WHERE event_id = ?").get(req.params.eventId);
      if (!row) {
        res.status(404).json({ error: "Event not found." });
        return;
      }
      eventBus.dispatchCommittedOutbox([
        {
          offset_id: row.offset_id,
          event_id: row.event_id,
          topic: row.topic,
          event_type: row.event_type,
          partition_key: row.partition_key,
          payload: JSON.parse(row.payload_json),
          created_at: row.created_at
        }
      ]);
      const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
      res.json({ replayed: row.event_id, snapshot });
    }
  );
  return app;
}

// server/vercel-entry.ts
var readyPromise = null;
function getApp() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await aivenBridge.initialize();
      return createStoreStreamApp();
    })();
  }
  return readyPromise;
}
async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
export {
  handler as default
};
