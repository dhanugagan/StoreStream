import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AnalyticsSummary,
  AuditLogRecord,
  AuthUser,
  CartItem,
  CityInventory,
  CityName,
  EventTopic,
  NotificationRecord,
  OrderLineItem,
  OrderStatus,
  PaymentMethod,
  PersistedCart,
  Product,
  ProductCategory,
  StockMovementRecord,
  StoreOrder,
  StoreSnapshot,
  StreamEventRecord,
  UserRole,
} from '../shared/types/storestream.ts';
import { aivenBridge } from './adapters/aiven.ts';
import { hashPassword, sanitizeImageUrl, verifyPassword } from './security.ts';

export const CITIES: CityName[] = [
  'Bengaluru',
  'Mumbai',
  'Delhi NCR',
  'Hyderabad',
  'Chennai',
  'Pune',
];

export const CATEGORIES: ProductCategory[] = [
  'Electronics',
  'Fashion',
  'Home and Kitchen',
  'Grocery',
  'Accessories',
  'Beauty',
  'Sports',
];

const CITY_META: Record<CityName, { id: string; state: string; code: string; eta: string }> = {
  Bengaluru: { id: 'city_blr', state: 'Karnataka', code: 'BLR-WH1', eta: 'Same-day · 3 hrs' },
  Mumbai: { id: 'city_bom', state: 'Maharashtra', code: 'BOM-WH1', eta: 'Same-day · 4 hrs' },
  'Delhi NCR': { id: 'city_del', state: 'Delhi', code: 'DEL-WH1', eta: 'Express · 4 hrs' },
  Hyderabad: { id: 'city_hyd', state: 'Telangana', code: 'HYD-WH1', eta: 'Same-day · 5 hrs' },
  Chennai: { id: 'city_maa', state: 'Tamil Nadu', code: 'MAA-WH1', eta: 'Same-day · 5 hrs' },
  Pune: { id: 'city_pnq', state: 'Maharashtra', code: 'PNQ-WH1', eta: 'Next-morning delivery' },
};

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DB_PATH = process.env.STORE_DATABASE_PATH
  ? path.resolve(process.env.STORE_DATABASE_PATH)
  : IS_SERVERLESS
  ? path.join(os.tmpdir(), 'storestream.db')
  : path.resolve(process.cwd(), 'data', 'storestream.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const storeDb = new Database(DB_PATH);
storeDb.pragma('journal_mode = WAL');
storeDb.pragma('busy_timeout = 5000');
storeDb.pragma('foreign_keys = ON');

export class InsufficientStockError extends Error {
  public readonly productId: string;
  public readonly productName: string;
  public readonly city: CityName;
  public readonly available: number;

  constructor(productId: string, productName: string, city: CityName, available: number) {
    super(`Insufficient stock for ${productName} in ${city}: ${available} unit(s) remaining.`);
    this.name = 'InsufficientStockError';
    this.productId = productId;
    this.productName = productName;
    this.city = city;
    this.available = available;
  }
}

export function initStoreDatabase(): void {
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

const IMG = {
  earphones: '/src/assets/images/product_bluetooth_earphones_1795314720308.jpg',
  headphones: '/src/assets/images/product_studio_headphones_1795314721448.jpg',
  speaker: '/src/assets/images/product_smart_speaker_1795314720476.jpg',
  keyboard: '/src/assets/images/product_mechanical_keyboard_1795314721669.jpg',
  purifier: '/src/assets/images/product_air_purifier_1795314721157.jpg',
  charger: '/src/assets/images/product_gan_charger_1795314720768.jpg',
  jacket: '/src/assets/images/product_fashion_jacket_1795315751913.jpg',
  espresso: '/src/assets/images/product_kitchen_espresso_1795315751007.jpg',
  coffee: '/src/assets/images/product_grocery_coffee_1795315750797.jpg',
  serum: '/src/assets/images/product_beauty_serum_1795315751357.jpg',
  shoes: '/src/assets/images/product_sports_shoes_1795315751430.jpg',
  phone: '/src/assets/images/product_smartphone_flagship_1795315751245.jpg',
};

interface SeedProductSpec {
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
  stock: Record<CityName, number>;
}

function seedStoreData(): void {
  const existingCount = (
    storeDb.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number }
  ).cnt;
  if (existingCount >= 30) return;

  const now = new Date().toISOString();

  const insertCat = storeDb.prepare('INSERT OR IGNORE INTO categories (id, name, slug) VALUES (?, ?, ?)');
  for (const c of CATEGORIES) {
    insertCat.run(`cat_${c.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, c, c.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  }

  const insertCity = storeDb.prepare(
    'INSERT OR IGNORE INTO cities (id, name, state_name, warehouse_code, eta_label) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of CITIES) {
    const m = CITY_META[c];
    insertCity.run(m.id, c, m.state, m.code, m.eta);
  }

  const seedProducts: SeedProductSpec[] = [
    {
      id: 'prod_earphones',
      sku: 'SS-AUD-101',
      name: 'Acoustic Pulse Bluetooth Earphones',
      brand: 'SonaWave',
      category: 'Electronics',
      price_inr: 4499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 99,
      is_featured: true,
      description: 'Active noise-cancelling Bluetooth 5.4 wireless earphones with 38-hour battery life and spatial tuning. Seeded at 1 unit in Bengaluru for last-unit race testing.',
      specs: ['Bluetooth 5.4 Dual-Device', '45dB Adaptive ANC', '38h Total Case Runtime', 'IPX5 Sweat Resistant'],
      image_url: IMG.earphones,
      tags: ['bluetooth', 'earphones', 'wireless', 'anc', 'audio', 'earbuds'],
      stock: { Bengaluru: 1, Mumbai: 12, 'Delhi NCR': 8, Hyderabad: 5, Chennai: 7, Pune: 3 },
    },
    {
      id: 'prod_samsung_s25',
      sku: 'SS-ELC-102',
      name: 'Samsung Galaxy S25 Ultra 5G Smartphone',
      brand: 'Samsung',
      category: 'Electronics',
      price_inr: 114999,
      discount_pct: 8,
      rating: 4.9,
      popularity: 97,
      is_featured: true,
      description: 'Flagship Titanium 5G smartphone with 200MP quad telephoto optics, 120Hz AMOLED panel, and multi-city express courier dispatch.',
      specs: ['6.8" QHD+ 120Hz AMOLED', '200MP ProVisual Camera', '5000mAh Fast Charge', '256GB UFS 4.0'],
      image_url: IMG.phone,
      tags: ['samsung', 'phone', 'smartphone', '5g', 'mobile', 'galaxy'],
      stock: { Bengaluru: 9, Mumbai: 14, 'Delhi NCR': 11, Hyderabad: 6, Chennai: 5, Pune: 4 },
    },
    {
      id: 'prod_headphones',
      sku: 'SS-AUD-103',
      name: 'Studio Reference Wireless Headphones',
      brand: 'SonaWave',
      category: 'Electronics',
      price_inr: 12990,
      discount_pct: 12,
      rating: 4.8,
      popularity: 91,
      is_featured: true,
      description: 'Over-ear wireless monitoring headphones with lossless USB-C DAC mode, Bluetooth multipoint, and lambskin cushions.',
      specs: ['40mm Beryllium Drivers', 'Bluetooth 5.3 + Lossless USB-C', '45h Battery Life', '245g Fold-Flat'],
      image_url: IMG.headphones,
      tags: ['headphones', 'wireless', 'bluetooth', 'studio', 'over-ear'],
      stock: { Bengaluru: 6, Mumbai: 0, 'Delhi NCR': 4, Hyderabad: 7, Chennai: 3, Pune: 5 },
    },
    {
      id: 'prod_speaker',
      sku: 'SS-ELC-104',
      name: 'Resonance 360 Smart Speaker',
      brand: 'Kinetix Home',
      category: 'Electronics',
      price_inr: 6990,
      discount_pct: 10,
      rating: 4.6,
      popularity: 85,
      is_featured: false,
      description: 'Omnidirectional room-calibrating Wi-Fi and Bluetooth smart speaker in woven acoustic wool.',
      specs: ['360° Woofer + Dual Tweeters', 'Wi-Fi 6 & Bluetooth 5.2', 'Far-Field 4-Mic Array', 'Matter Hub Ready'],
      image_url: IMG.speaker,
      tags: ['speaker', 'smart speaker', 'wifi', 'bluetooth', 'audio'],
      stock: { Bengaluru: 9, Mumbai: 7, 'Delhi NCR': 5, Hyderabad: 0, Chennai: 6, Pune: 4 },
    },
    {
      id: 'prod_smartwatch',
      sku: 'SS-ELC-105',
      name: 'Samsung Galaxy Watch 7 Titanium LTE',
      brand: 'Samsung',
      category: 'Electronics',
      price_inr: 28990,
      discount_pct: 10,
      rating: 4.7,
      popularity: 88,
      is_featured: false,
      description: 'Dual-frequency GPS fitness and wellness smartwatch with Sapphire crystal glass and 3nm processor.',
      specs: ['44mm Sapphire AMOLED', 'Dual-Band L1+L5 GPS', '5ATM + IP68 Rated', 'Fast Wireless Charging'],
      image_url: IMG.phone,
      tags: ['samsung', 'smartwatch', 'wearable', 'fitness', 'gps'],
      stock: { Bengaluru: 5, Mumbai: 9, 'Delhi NCR': 6, Hyderabad: 4, Chennai: 2, Pune: 6 },
    },
    {
      id: 'prod_soundbar',
      sku: 'SS-ELC-106',
      name: 'Horizon Dolby Atmos 5.1 Soundbar',
      brand: 'SonaWave',
      category: 'Electronics',
      price_inr: 24999,
      discount_pct: 18,
      rating: 4.6,
      popularity: 80,
      is_featured: false,
      description: 'Compact anodized aluminum soundbar with wireless subwoofer and HDMI eARC low-latency pass-through.',
      specs: ['420W Peak Output', 'HDMI eARC + Optical', 'Bluetooth 5.3 Streaming', 'Wireless Subwoofer'],
      image_url: IMG.speaker,
      tags: ['soundbar', 'home theater', 'bluetooth', 'dolby'],
      stock: { Bengaluru: 4, Mumbai: 6, 'Delhi NCR': 3, Hyderabad: 5, Chennai: 2, Pune: 0 },
    },
    {
      id: 'prod_keyboard',
      sku: 'SS-ACC-201',
      name: 'Tactile 75% Aluminum Mechanical Keyboard',
      brand: 'KeyCraft',
      category: 'Accessories',
      price_inr: 8490,
      discount_pct: 10,
      rating: 4.9,
      popularity: 94,
      is_featured: true,
      description: 'CNC anodized aluminum wireless mechanical keyboard with gasket mount, hot-swappable switches, and Mac/Windows dual legends.',
      specs: ['75% Gasket-Mount CNC Frame', 'Tri-Mode Bluetooth / 2.4GHz / USB-C', 'PBT Dye-Sub Keycaps', '4000mAh Battery'],
      image_url: IMG.keyboard,
      tags: ['keyboard', 'mechanical', 'wireless', 'bluetooth', 'usb-c'],
      stock: { Bengaluru: 4, Mumbai: 10, 'Delhi NCR': 14, Hyderabad: 6, Chennai: 8, Pune: 2 },
    },
    {
      id: 'prod_charger',
      sku: 'SS-ACC-202',
      name: 'VoltCube 100W GaN Fast Charger',
      brand: 'VoltCore',
      category: 'Accessories',
      price_inr: 3299,
      discount_pct: 20,
      rating: 4.7,
      popularity: 90,
      is_featured: false,
      description: 'Pocket-sized 4-port 100W GaN wall adapter built for laptops, tablets, and flagship phones with BIS surge protection.',
      specs: ['100W PD 3.1 Total Output', '3x USB-C + 1x USB-A', 'BIS & GaN Thermal Control', 'Foldable Indian Plug'],
      image_url: IMG.charger,
      tags: ['charger', 'gan', 'usb-c', 'laptop', 'fast charge'],
      stock: { Bengaluru: 18, Mumbai: 15, 'Delhi NCR': 12, Hyderabad: 9, Chennai: 11, Pune: 14 },
    },
    {
      id: 'prod_usbc_hub',
      sku: 'SS-ACC-203',
      name: 'KeyCraft 8-in-1 Dual-HDMI USB-C Dock',
      brand: 'KeyCraft',
      category: 'Accessories',
      price_inr: 4199,
      discount_pct: 12,
      rating: 4.5,
      popularity: 77,
      is_featured: false,
      description: 'Machined aluminum laptop docking station with 4K 60Hz HDMI, Gigabit Ethernet, SD UHS-II reader, and 100W PD pass-through.',
      specs: ['4K 60Hz HDMI Output', 'Gigabit RJ45 Ethernet', '10Gbps USB-A & C', '100W PD Pass-Through'],
      image_url: IMG.charger,
      tags: ['hub', 'dock', 'usb-c', 'laptop', 'hdmi'],
      stock: { Bengaluru: 11, Mumbai: 8, 'Delhi NCR': 7, Hyderabad: 5, Chennai: 4, Pune: 6 },
    },
    {
      id: 'prod_laptop_sleeve',
      sku: 'SS-ACC-204',
      name: 'Monsoon Waxed Canvas 14" Laptop Sleeve',
      brand: 'Indigo Loom',
      category: 'Accessories',
      price_inr: 2199,
      discount_pct: 15,
      rating: 4.6,
      popularity: 73,
      is_featured: false,
      description: 'Water-repellent waxed cotton canvas laptop sleeve lined with plush recycled fleece and magnetic accessory pocket.',
      specs: ['Fits 13"–14.2" Laptops', 'YKK AquaGuard Zipper', 'Microfiber Interior', 'Cable Organizer Pocket'],
      image_url: IMG.jacket,
      tags: ['sleeve', 'laptop', 'bag', 'canvas', 'travel'],
      stock: { Bengaluru: 7, Mumbai: 9, 'Delhi NCR': 5, Hyderabad: 4, Chennai: 6, Pune: 8 },
    },
    {
      id: 'prod_powerbank',
      sku: 'SS-ACC-205',
      name: 'VoltCube 20,000mAh 65W Laptop Power Bank',
      brand: 'VoltCore',
      category: 'Accessories',
      price_inr: 4990,
      discount_pct: 14,
      rating: 4.7,
      popularity: 84,
      is_featured: false,
      description: 'Airline-safe 74Wh portable power bank capable of rapid charging ultrabooks and phones simultaneously.',
      specs: ['65W Bi-Directional USB-C', '20,000mAh Li-Polymer', 'Digital Wattage Readout', 'Flight Approved 74Wh'],
      image_url: IMG.charger,
      tags: ['power bank', 'battery', 'travel', 'usb-c', 'fast charge'],
      stock: { Bengaluru: 2, Mumbai: 6, 'Delhi NCR': 10, Hyderabad: 7, Chennai: 5, Pune: 4 },
    },
    {
      id: 'prod_espresso',
      sku: 'SS-HK-301',
      name: 'Barista Steel PID Espresso Machine',
      brand: 'Kinetix Home',
      category: 'Home and Kitchen',
      price_inr: 34990,
      discount_pct: 10,
      rating: 4.9,
      popularity: 92,
      is_featured: true,
      description: '15-bar PID temperature-stabilized brushed stainless espresso maker with 58mm commercial portafilter and microfoam steam wand.',
      specs: ['PID Thermal Stability', '58mm Stainless Portafilter', '1.8L Removable Reservoir', 'Dual Pressure Gauge'],
      image_url: IMG.espresso,
      tags: ['espresso', 'coffee', 'kitchen', 'appliance', 'barista'],
      stock: { Bengaluru: 5, Mumbai: 4, 'Delhi NCR': 3, Hyderabad: 2, Chennai: 3, Pune: 2 },
    },
    {
      id: 'prod_purifier',
      sku: 'SS-HK-302',
      name: 'PureAir H13 True HEPA Room Purifier',
      brand: 'AeroCare',
      category: 'Home and Kitchen',
      price_inr: 11499,
      discount_pct: 18,
      rating: 4.8,
      popularity: 95,
      is_featured: true,
      description: 'Medical-grade H13 True HEPA purifier capturing 99.97% of PM2.5 particulates across Delhi NCR, Mumbai, and metro apartments.',
      specs: ['CADR 380 m³/hr Coverage', 'H13 HEPA + Activated Carbon', 'Live PM2.5 Laser Sensor', '22dB Night Sleep Mode'],
      image_url: IMG.purifier,
      tags: ['air purifier', 'hepa', 'pm2.5', 'smart home', 'clean air'],
      stock: { Bengaluru: 3, Mumbai: 8, 'Delhi NCR': 16, Hyderabad: 5, Chennai: 4, Pune: 7 },
    },
    {
      id: 'prod_kettle',
      sku: 'SS-HK-303',
      name: 'PourOver Gooseneck Temperature Kettle',
      brand: 'Kinetix Home',
      category: 'Home and Kitchen',
      price_inr: 4690,
      discount_pct: 12,
      rating: 4.7,
      popularity: 81,
      is_featured: false,
      description: 'Variable-temperature precision gooseneck kettle (40°C to 100°C) for filter coffee, green tea, and artisanal brewing.',
      specs: ['1°C Precision Control', '1200W Rapid Boil', '304 Surgical Stainless', '60-Minute Hold Mode'],
      image_url: IMG.espresso,
      tags: ['kettle', 'coffee', 'tea', 'kitchen', 'gooseneck'],
      stock: { Bengaluru: 8, Mumbai: 6, 'Delhi NCR': 9, Hyderabad: 4, Chennai: 5, Pune: 3 },
    },
    {
      id: 'prod_skillet',
      sku: 'SS-HK-304',
      name: 'Heritage Pre-Seasoned Cast Iron Skillet 10"',
      brand: 'Deccan Forge',
      category: 'Home and Kitchen',
      price_inr: 2499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 79,
      is_featured: false,
      description: 'Heavy-gauge heirloom cast iron pan naturally seasoned with cold-pressed flax oil for induction, gas, and oven cooking.',
      specs: ['10-Inch Cooking Surface', 'Induction & Oven Safe', 'Zero Synthetic Coatings', 'Twin Pour Spouts'],
      image_url: IMG.espresso,
      tags: ['cookware', 'cast iron', 'skillet', 'pan', 'kitchen'],
      stock: { Bengaluru: 12, Mumbai: 10, 'Delhi NCR': 8, Hyderabad: 9, Chennai: 7, Pune: 6 },
    },
    {
      id: 'prod_humidifier',
      sku: 'SS-HK-305',
      name: 'AeroCare Ultrasonic Mist Humidifier',
      brand: 'AeroCare',
      category: 'Home and Kitchen',
      price_inr: 3799,
      discount_pct: 10,
      rating: 4.4,
      popularity: 68,
      is_featured: false,
      description: 'Top-fill 4L quiet ultrasonic cool-mist humidifier with built-in hygrometer for dry AC bedrooms.',
      specs: ['4L Top-Fill Tank', '32-Hour Runtime', 'Auto Humidity Sensor', 'Auto Shut-Off'],
      image_url: IMG.purifier,
      tags: ['humidifier', 'home', 'bedroom', 'air care'],
      stock: { Bengaluru: 6, Mumbai: 4, 'Delhi NCR': 7, Hyderabad: 3, Chennai: 2, Pune: 5 },
    },
    {
      id: 'prod_jacket',
      sku: 'SS-FSH-401',
      name: 'Tailored Organic Twill Utility Overshirt',
      brand: 'Indigo Loom',
      category: 'Fashion',
      price_inr: 3899,
      discount_pct: 15,
      rating: 4.8,
      popularity: 89,
      is_featured: true,
      description: 'Breathable 310gsm organic cotton twill overshirt cut cleanly for all-season Indian layering with corozo nut buttons.',
      specs: ['100% GOTS Organic Cotton', '310gsm Brushed Twill', 'Dual Utility Chest Pockets', 'Pre-Shrunk Tailored Fit'],
      image_url: IMG.jacket,
      tags: ['jacket', 'overshirt', 'cotton', 'menswear', 'fashion'],
      stock: { Bengaluru: 14, Mumbai: 11, 'Delhi NCR': 9, Hyderabad: 6, Chennai: 5, Pune: 8 },
    },
    {
      id: 'prod_linen_shirt',
      sku: 'SS-FSH-402',
      name: 'Malabar Pure Linen Mandarin Collar Shirt',
      brand: 'Indigo Loom',
      category: 'Fashion',
      price_inr: 2999,
      discount_pct: 10,
      rating: 4.7,
      popularity: 82,
      is_featured: false,
      description: 'Lightweight woven flax linen shirt engineered for humid coastal cities like Mumbai and Chennai.',
      specs: ['100% European Flax Linen', 'Mother-of-Pearl Buttons', 'Breathable Loose Weave', 'Machine Wash Gentle'],
      image_url: IMG.jacket,
      tags: ['linen', 'shirt', 'summer', 'breathable', 'fashion'],
      stock: { Bengaluru: 10, Mumbai: 16, 'Delhi NCR': 7, Hyderabad: 8, Chennai: 13, Pune: 6 },
    },
    {
      id: 'prod_denim',
      sku: 'SS-FSH-403',
      name: 'Selvedge Stretch Tapered Chinos',
      brand: 'Indigo Loom',
      category: 'Fashion',
      price_inr: 3499,
      discount_pct: 12,
      rating: 4.6,
      popularity: 75,
      is_featured: false,
      description: 'Clean-front tailored trousers in 2% comfort-stretch organic twill with reinforced pocket bags.',
      specs: ['98% Cotton / 2% Elastane', 'Concealed Coin Pocket', 'Tapered Ankle Fit', 'YKK Brass Zip'],
      image_url: IMG.jacket,
      tags: ['chinos', 'trousers', 'pants', 'workwear', 'fashion'],
      stock: { Bengaluru: 8, Mumbai: 9, 'Delhi NCR': 11, Hyderabad: 5, Chennai: 4, Pune: 7 },
    },
    {
      id: 'prod_merino_polo',
      sku: 'SS-FSH-404',
      name: 'Fine-Knit Pima Cotton Polo',
      brand: 'Indigo Loom',
      category: 'Fashion',
      price_inr: 2299,
      discount_pct: 8,
      rating: 4.5,
      popularity: 71,
      is_featured: false,
      description: 'Mercerized long-staple cotton knit polo holding crisp collar structure across long workdays.',
      specs: ['100% Long-Staple Pima', 'Anti-Curl Ribbed Collar', '220gsm Pique Knit', 'Side Vent Hem'],
      image_url: IMG.jacket,
      tags: ['polo', 'tshirt', 'cotton', 'fashion'],
      stock: { Bengaluru: 12, Mumbai: 8, 'Delhi NCR': 6, Hyderabad: 9, Chennai: 10, Pune: 7 },
    },
    {
      id: 'prod_coffee',
      sku: 'SS-GRC-501',
      name: 'Chikmagalur Single-Estate Arabica Beans (250g)',
      brand: 'Malnad Roasters',
      category: 'Grocery',
      price_inr: 649,
      discount_pct: 5,
      rating: 4.9,
      popularity: 96,
      is_featured: true,
      description: 'Shade-grown 100% AA Arabica whole coffee beans roasted weekly in Karnataka with notes of roasted hazelnut and dark cocoa.',
      specs: ['1,350m Estate Elevation', 'Medium-Dark Filter & Espresso', 'Nitrogen-Flushed Valve Bag', 'Roasted Within 7 Days'],
      image_url: IMG.coffee,
      tags: ['coffee', 'arabica', 'beans', 'grocery', 'chikmagalur'],
      stock: { Bengaluru: 28, Mumbai: 20, 'Delhi NCR': 15, Hyderabad: 18, Chennai: 22, Pune: 16 },
    },
    {
      id: 'prod_matcha',
      sku: 'SS-GRC-502',
      name: 'First-Harvest Ceremonial Green Tea Tin (50g)',
      brand: 'Malnad Roasters',
      category: 'Grocery',
      price_inr: 1199,
      discount_pct: 10,
      rating: 4.7,
      popularity: 78,
      is_featured: false,
      description: 'Stone-milled shade-grown ceremonial grade matcha packed in an airtight UV-protected tin.',
      specs: ['First Spring Harvest', 'Stone-Milled Ultra-Fine', 'Zero Added Sugar', '50g Airtight Tin'],
      image_url: IMG.coffee,
      tags: ['tea', 'matcha', 'green tea', 'grocery', 'organic'],
      stock: { Bengaluru: 14, Mumbai: 11, 'Delhi NCR': 9, Hyderabad: 6, Chennai: 7, Pune: 5 },
    },
    {
      id: 'prod_honey',
      sku: 'SS-GRC-503',
      name: 'Nilgiri Wildflower Raw Forest Honey (500g)',
      brand: 'Malnad Roasters',
      category: 'Grocery',
      price_inr: 749,
      discount_pct: 0,
      rating: 4.8,
      popularity: 83,
      is_featured: false,
      description: 'Unheated, NMR-tested raw multifloral forest honey ethically harvested from Nilgiri foothills.',
      specs: ['NMR Purity Verified', 'Zero Sugar Syrup', 'Glass Apothecary Jar', '500g Net Weight'],
      image_url: IMG.coffee,
      tags: ['honey', 'organic', 'grocery', 'natural', 'raw'],
      stock: { Bengaluru: 19, Mumbai: 14, 'Delhi NCR': 12, Hyderabad: 10, Chennai: 15, Pune: 9 },
    },
    {
      id: 'prod_olive_oil',
      sku: 'SS-GRC-504',
      name: 'Cold-Pressed Extra Virgin Olive Oil (750ml)',
      brand: 'Deccan Pantry',
      category: 'Grocery',
      price_inr: 1399,
      discount_pct: 12,
      rating: 4.6,
      popularity: 74,
      is_featured: false,
      description: 'Single-press early-harvest extra virgin olive oil bottled in dark UV glass for dressings and sautéing.',
      specs: ['Acidity < 0.25%', 'First Cold Extraction', '750ml Dark Glass Bottle', 'Rich Polyphenols'],
      image_url: IMG.serum,
      tags: ['olive oil', 'cooking', 'grocery', 'pantry'],
      stock: { Bengaluru: 9, Mumbai: 13, 'Delhi NCR': 10, Hyderabad: 7, Chennai: 6, Pune: 8 },
    },
    {
      id: 'prod_serum',
      sku: 'SS-BTY-601',
      name: 'Aura 15% Vitamin C + Ferulic Radiance Serum',
      brand: 'Aura Botanics',
      category: 'Beauty',
      price_inr: 1499,
      discount_pct: 15,
      rating: 4.8,
      popularity: 93,
      is_featured: true,
      description: 'Stabilized 15% L-Ascorbic Acid brightening facial serum buffered with hyaluronic acid and ferulic antioxidants.',
      specs: ['15% L-Ascorbic Acid', 'Fragrance-Free pH 3.4', 'Amber UV Dropper 30ml', 'Dermatologist Tested'],
      image_url: IMG.serum,
      tags: ['serum', 'vitamin c', 'skincare', 'beauty', 'glow'],
      stock: { Bengaluru: 16, Mumbai: 22, 'Delhi NCR': 19, Hyderabad: 12, Chennai: 14, Pune: 11 },
    },
    {
      id: 'prod_sunscreen',
      sku: 'SS-BTY-602',
      name: 'Aura Invisible Mineral SPF 50 PA++++ Fluid',
      brand: 'Aura Botanics',
      category: 'Beauty',
      price_inr: 899,
      discount_pct: 10,
      rating: 4.7,
      popularity: 88,
      is_featured: false,
      description: 'Weightless zero-white-cast broad-spectrum sunscreen formulated for humid tropical Indian UV index days.',
      specs: ['SPF 50 PA++++', 'Zero White Cast Matte', 'Niacinamide 2% + Zinc', '50ml Travel Tube'],
      image_url: IMG.serum,
      tags: ['sunscreen', 'spf', 'skincare', 'beauty'],
      stock: { Bengaluru: 21, Mumbai: 25, 'Delhi NCR': 18, Hyderabad: 14, Chennai: 19, Pune: 12 },
    },
    {
      id: 'prod_cleanser',
      sku: 'SS-BTY-603',
      name: 'Barrier-Repair Ceramide Gel Cleanser',
      brand: 'Aura Botanics',
      category: 'Beauty',
      price_inr: 699,
      discount_pct: 8,
      rating: 4.6,
      popularity: 76,
      is_featured: false,
      description: 'Sulfate-free amino acid pH-balanced daily gel cleanser with 5 skin-identical ceramides.',
      specs: ['pH 5.5 Balanced', 'Zero SLS/SLES', '5 Essential Ceramides', '150ml Pump Bottle'],
      image_url: IMG.serum,
      tags: ['cleanser', 'face wash', 'ceramide', 'beauty', 'skincare'],
      stock: { Bengaluru: 15, Mumbai: 12, 'Delhi NCR': 14, Hyderabad: 9, Chennai: 11, Pune: 8 },
    },
    {
      id: 'prod_hair_oil',
      sku: 'SS-BTY-604',
      name: 'Rosemary & Bhringraj Botanical Scalp Elixir',
      brand: 'Aura Botanics',
      category: 'Beauty',
      price_inr: 799,
      discount_pct: 12,
      rating: 4.7,
      popularity: 80,
      is_featured: false,
      description: 'Lightweight non-greasy cold-infused scalp strengthening oil blending Nilgiri rosemary and bhringraj.',
      specs: ['100% Cold-Pressed Oils', 'Silicone & Mineral-Oil Free', 'Precision Glass Pipette', '50ml Concentrated'],
      image_url: IMG.serum,
      tags: ['hair oil', 'rosemary', 'scalp', 'beauty'],
      stock: { Bengaluru: 11, Mumbai: 15, 'Delhi NCR': 13, Hyderabad: 10, Chennai: 16, Pune: 7 },
    },
    {
      id: 'prod_running_shoes',
      sku: 'SS-SPT-701',
      name: 'StridePro Carbon Knit Marathon Shoes',
      brand: 'PaceLab',
      category: 'Sports',
      price_inr: 9499,
      discount_pct: 15,
      rating: 4.9,
      popularity: 95,
      is_featured: true,
      description: 'Ultra-lightweight engineered knit road running shoes with responsive nitrogen midsole and full-length propulsion plate.',
      specs: ['218g Featherweight Knit', 'Nitrogen-Infused Midsole', 'High-Abrasion Continental Grip', '8mm Heel-Toe Drop'],
      image_url: IMG.shoes,
      tags: ['running shoes', 'marathon', 'sneakers', 'sports', 'fitness'],
      stock: { Bengaluru: 8, Mumbai: 10, 'Delhi NCR': 12, Hyderabad: 6, Chennai: 5, Pune: 7 },
    },
    {
      id: 'prod_yoga_mat',
      sku: 'SS-SPT-702',
      name: 'Prana Natural Cork & Rubber Yoga Mat (5mm)',
      brand: 'PaceLab',
      category: 'Sports',
      price_inr: 2899,
      discount_pct: 10,
      rating: 4.8,
      popularity: 84,
      is_featured: false,
      description: 'Antimicrobial Portuguese cork grip top bonded to dense natural tree rubber for hot yoga and strength sessions.',
      specs: ['5mm Joint Cushioning', 'Wet-Grip Natural Cork', '185cm x 68cm Wide', 'Cotton Carry Strap Included'],
      image_url: IMG.shoes,
      tags: ['yoga mat', 'fitness', 'pilates', 'sports', 'cork'],
      stock: { Bengaluru: 14, Mumbai: 9, 'Delhi NCR': 8, Hyderabad: 7, Chennai: 10, Pune: 11 },
    },
    {
      id: 'prod_flask',
      sku: 'SS-SPT-703',
      name: 'PaceLab Vacuum Insulated Steel Flask (1L)',
      brand: 'PaceLab',
      category: 'Sports',
      price_inr: 1399,
      discount_pct: 10,
      rating: 4.7,
      popularity: 79,
      is_featured: false,
      description: 'Double-wall copper-lined stainless steel hydration bottle keeping water ice-cold for 24 hours.',
      specs: ['24h Cold / 12h Hot', '18/8 Food-Grade Steel', 'Leakproof Chug Cap', 'BPA-Free Powder Coat'],
      image_url: IMG.shoes,
      tags: ['bottle', 'flask', 'gym', 'hydration', 'sports'],
      stock: { Bengaluru: 20, Mumbai: 17, 'Delhi NCR': 14, Hyderabad: 12, Chennai: 11, Pune: 15 },
    },
    {
      id: 'prod_dumbbells',
      sku: 'SS-SPT-704',
      name: 'QuickSelect Cast Steel Dumbbells (Pair 12kg)',
      brand: 'PaceLab',
      category: 'Sports',
      price_inr: 5999,
      discount_pct: 12,
      rating: 4.8,
      popularity: 82,
      is_featured: false,
      description: 'Rubber-hex floor-safe strength training dumbbell pair with knurled chrome ergonomic grip handles.',
      specs: ['2x 6kg / 12kg Pair', 'Knurled Anti-Slip Grip', 'Anti-Roll Hex Profile', 'Low-Odor Virgin Rubber'],
      image_url: IMG.shoes,
      tags: ['dumbbells', 'weights', 'home gym', 'strength', 'sports'],
      stock: { Bengaluru: 5, Mumbai: 4, 'Delhi NCR': 6, Hyderabad: 3, Chennai: 4, Pune: 5 },
    },
  ];

  const insertBrand = storeDb.prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?, ?)');
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
      insertBrand.run(`brand_${p.brand.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, p.brand);
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

    // Seed sample customer & order if none exist
    const orderCnt = (storeDb.prepare('SELECT COUNT(*) as cnt FROM orders').get() as { cnt: number }).cnt;
    if (orderCnt === 0) {
      storeDb
        .prepare('INSERT OR IGNORE INTO customers (id, name, email, default_city, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('cust_seed_01', 'Ananya Rao', 'ananya.rao@example.in', 'Bengaluru', now);
      storeDb
        .prepare('INSERT OR IGNORE INTO addresses (id, customer_id, city, line1, postal_code, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('addr_seed_01', 'cust_seed_01', 'Bengaluru', '27th Main, HSR Layout, Bengaluru', '560102', now);
      storeDb
        .prepare(
          `INSERT INTO orders (id, idempotency_key, customer_name, customer_email, city, shipping_address, subtotal_inr, tax_inr, delivery_inr, total_inr, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
        )
        .run('SS-ORD-1001', 'seed-order-1001', 'Ananya Rao', 'ananya.rao@example.in', 'Bengaluru', '27th Main, HSR Layout, Bengaluru', 8490, 1528, 0, 10018, now);
      storeDb
        .prepare(
          `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price_inr)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('oi_seed_01', 'SS-ORD-1001', 'prod_keyboard', 'Tactile 75% Aluminum Mechanical Keyboard', 1, 8490);
      storeDb
        .prepare(
          `INSERT INTO payments (id, order_id, method, status, amount_inr, reference_code, created_at)
           VALUES (?, ?, 'UPI_SIMULATION', 'simulated_authorized', ?, 'SIM-UPI-1001', ?)`
        )
        .run('pay_seed_01', 'SS-ORD-1001', 10018, now);
      storeDb
        .prepare(
          `INSERT INTO notifications (id, order_id, customer_email, city, channel, message, is_read, dispatched_at)
           VALUES (?, ?, ?, ?, 'in_app_and_email_sim', ?, 0, ?)`
        )
        .run('notif_seed_01', 'SS-ORD-1001', 'ananya.rao@example.in', 'Bengaluru', 'Order SS-ORD-1001 confirmed for Bengaluru fulfillment.', now);

      const seedEventId = 'evt_seed_1001';
      storeDb
        .prepare(
          `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
           VALUES (?, 'order.placed', 'OrderPlaced', 'Bengaluru', ?, 'indexed_and_confirmed', 0, ?)`
        )
        .run(seedEventId, JSON.stringify({ orderId: 'SS-ORD-1001', city: 'Bengaluru', totalInr: 10018 }), now);
      storeDb
        .prepare('INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)')
        .run(seedEventId, 'cg-inventory', now);
      storeDb
        .prepare('INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)')
        .run(seedEventId, 'cg-search-sync', now);
      storeDb
        .prepare('INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)')
        .run(seedEventId, 'cg-notifications', now);
    }

    storeDb.prepare('INSERT OR IGNORE INTO store_counters (key, value) VALUES (?, ?)').run('oversells_prevented', 0);
  });

  seedTx();
}

// ---------- Auth & RBAC Helpers ----------

export function hasAdminClaimed(): boolean {
  const row = storeDb
    .prepare("SELECT COUNT(*) as cnt FROM users WHERE role IN ('Administrator', 'Inventory Manager')")
    .get() as { cnt: number };
  return row.cnt > 0 || Boolean(process.env.ADMIN_PASSCODE?.trim());
}

export function claimInitialAdmin(input: {
  name: string;
  email: string;
  password: string;
  role: 'Administrator' | 'Inventory Manager';
}): AuthUser {
  if (hasAdminClaimed()) {
    throw new Error('Administrator account has already been claimed. Please sign in.');
  }
  const email = input.email.trim().toLowerCase();
  const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const passwordHash = hashPassword(input.password);

  storeDb
    .prepare('INSERT INTO users (id, name, email, password_hash, role, default_city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.name.trim(), email, passwordHash, input.role, 'Bengaluru', now);

  recordAuditLog(email, input.role, 'ADMIN_CLAIMED', 'user', id, `Initial ${input.role} credentials claimed.`);

  return {
    id,
    name: input.name.trim(),
    email,
    role: input.role,
    default_city: 'Bengaluru',
  };
}

export function registerCustomer(input: {
  name: string;
  email: string;
  password: string;
  defaultCity: CityName;
}): AuthUser {
  const email = input.email.trim().toLowerCase();
  const existing = storeDb.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    throw new Error('An account with this email already exists.');
  }
  const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const passwordHash = hashPassword(input.password);

  const tx = storeDb.transaction(() => {
    storeDb
      .prepare('INSERT INTO users (id, name, email, password_hash, role, default_city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name.trim(), email, passwordHash, 'Customer', input.defaultCity, now);

    storeDb
      .prepare(
        `INSERT INTO customers (id, user_id, name, email, default_city, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, default_city = excluded.default_city`
      )
      .run(`cust_${crypto.randomUUID().slice(0, 8)}`, id, input.name.trim(), email, input.defaultCity, now);
  });
  tx();

  return {
    id,
    name: input.name.trim(),
    email,
    role: 'Customer',
    default_city: input.defaultCity,
  };
}

export function authenticateUser(emailRaw: string, password: string): AuthUser | null {
  const email = emailRaw.trim().toLowerCase();
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();

  const row = storeDb
    .prepare('SELECT id, name, email, password_hash, role, default_city FROM users WHERE email = ?')
    .get(email) as
    | {
        id: string;
        name: string;
        email: string;
        password_hash: string;
        role: UserRole;
        default_city: CityName;
      }
    | undefined;

  if (row && verifyPassword(password, row.password_hash)) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      default_city: row.default_city,
    };
  }

  // Optional environment-configured admin passcode verification on server
  if (envPasscode && password === envPasscode) {
    return {
      id: 'usr_env_admin',
      name: 'StoreStream Admin',
      email,
      role: 'Administrator',
      default_city: 'Bengaluru',
    };
  }

  return null;
}

// ---------- Catalog & Inventory Reads ----------

export function getAllProducts(): Product[] {
  const prodRows = storeDb
    .prepare('SELECT * FROM products ORDER BY is_featured DESC, popularity DESC, name ASC')
    .all() as Array<{
    id: string;
    sku: string;
    name: string;
    brand: string;
    category: ProductCategory;
    price_inr: number;
    discount_pct: number;
    rating: number;
    popularity: number;
    is_featured: number;
    description: string;
    specs_json: string;
    image_url: string;
    tags_json: string;
  }>;

  const invRows = storeDb.prepare('SELECT * FROM city_inventory').all() as Array<{
    product_id: string;
    city: CityName;
    warehouse_code: string;
    stock_qty: number;
    low_stock_threshold: number;
    eta_label: string;
    updated_at: string;
  }>;

  const invMap = new Map<string, Record<CityName, CityInventory>>();
  for (const row of invRows) {
    if (!invMap.has(row.product_id)) {
      invMap.set(row.product_id, {} as Record<CityName, CityInventory>);
    }
    invMap.get(row.product_id)![row.city] = row;
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
    specs: JSON.parse(p.specs_json) as string[],
    image_url: p.image_url,
    tags: JSON.parse(p.tags_json) as string[],
    inventory_by_city: invMap.get(p.id) || ({} as Record<CityName, CityInventory>),
  }));
}

export function getRecentOrders(limit = 30): StoreOrder[] {
  const orderRows = storeDb
    .prepare(
      `SELECT o.*, p.method as payment_method, p.status as payment_status, p.reference_code as payment_reference
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
       ORDER BY o.created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
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
    payment_method: PaymentMethod | null;
    payment_status: 'simulated_authorized' | 'simulated_refunded' | null;
    payment_reference: string | null;
    status: OrderStatus;
    created_at: string;
  }>;

  const selectItems = storeDb.prepare('SELECT * FROM order_items WHERE order_id = ?');
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
    payment_method: o.payment_method || 'UPI_SIMULATION',
    payment_status: o.payment_status || 'simulated_authorized',
    payment_reference: o.payment_reference || `SIM-${o.id}`,
    status: o.status,
    created_at: o.created_at,
    items: selectItems.all(o.id) as OrderLineItem[],
  }));
}

export function getRecentEvents(limit = 50): StreamEventRecord[] {
  const rows = storeDb
    .prepare('SELECT * FROM event_log ORDER BY offset_id DESC LIMIT ?')
    .all(limit) as Array<{
    offset_id: number;
    event_id: string;
    topic: EventTopic;
    event_type: string;
    partition_key: string;
    payload_json: string;
    consumer_status: StreamEventRecord['consumer_status'];
    retry_count: number;
    last_error: string | null;
    created_at: string;
  }>;

  const selectGroups = storeDb.prepare('SELECT consumer_group FROM processed_events WHERE event_id = ?');
  return rows.map((r) => ({
    offset_id: r.offset_id,
    event_id: r.event_id,
    topic: r.topic,
    event_type: r.event_type,
    partition_key: r.partition_key,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    consumer_status: r.consumer_status,
    retry_count: r.retry_count ?? 0,
    last_error: r.last_error ?? null,
    consumer_groups_processed: (selectGroups.all(r.event_id) as Array<{ consumer_group: string }>).map(
      (g) => g.consumer_group
    ),
    created_at: r.created_at,
  }));
}

export function getRecentNotifications(limit = 30): NotificationRecord[] {
  const rows = storeDb
    .prepare('SELECT * FROM notifications ORDER BY dispatched_at DESC LIMIT ?')
    .all(limit) as Array<{
    id: string;
    order_id: string | null;
    customer_email: string;
    city: CityName;
    channel: string;
    message: string;
    is_read: number;
    dispatched_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    customer_email: r.customer_email,
    city: r.city,
    channel: r.channel,
    message: r.message,
    is_read: Boolean(r.is_read),
    dispatched_at: r.dispatched_at,
  }));
}

export function markAllNotificationsRead(): void {
  storeDb.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
}

export function recordOrderNotification(
  orderId: string | null,
  customerEmail: string,
  city: CityName,
  message: string
): NotificationRecord {
  const id = `notif_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  storeDb
    .prepare(
      `INSERT INTO notifications (id, order_id, customer_email, city, channel, message, is_read, dispatched_at)
       VALUES (?, ?, ?, ?, 'in_app_and_email_sim', ?, 0, ?)`
    )
    .run(id, orderId, customerEmail, city, message, now);
  return {
    id,
    order_id: orderId,
    customer_email: customerEmail,
    city,
    channel: 'in_app_and_email_sim',
    message,
    is_read: false,
    dispatched_at: now,
  };
}

export function recordAuditLog(
  actorEmail: string,
  actorRole: string,
  action: string,
  targetType: string,
  targetId: string,
  details: string
): void {
  storeDb
    .prepare(
      `INSERT INTO audit_logs (id, actor_email, actor_role, action, target_type, target_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`aud_${crypto.randomUUID().slice(0, 8)}`, actorEmail, actorRole, action, targetType, targetId, details, new Date().toISOString());
}

// ---------- Persisted Cart with GST + Delivery Breakdown ----------

function computeCartBreakdown(items: CartItem[]): {
  subtotal_inr: number;
  tax_inr: number;
  delivery_inr: number;
  total_inr: number;
} {
  if (items.length === 0) {
    return { subtotal_inr: 0, tax_inr: 0, delivery_inr: 0, total_inr: 0 };
  }
  const getPrice = storeDb.prepare('SELECT price_inr FROM products WHERE id = ?');
  let subtotal = 0;
  for (const item of items) {
    const row = getPrice.get(item.productId) as { price_inr: number } | undefined;
    if (row) subtotal += row.price_inr * item.qty;
  }
  const tax = Math.round(subtotal * 0.18);
  const delivery = subtotal >= 1999 || subtotal === 0 ? 0 : 99;
  return {
    subtotal_inr: subtotal,
    tax_inr: tax,
    delivery_inr: delivery,
    total_inr: subtotal + tax + delivery,
  };
}

export function getPersistedCart(sessionId: string): PersistedCart {
  const cleanSession = sessionId.slice(0, 80);
  const cartRow = storeDb
    .prepare('SELECT session_id, city, updated_at FROM carts WHERE session_id = ?')
    .get(cleanSession) as { session_id: string; city: CityName; updated_at: string } | undefined;

  if (!cartRow) {
    const now = new Date().toISOString();
    storeDb
      .prepare('INSERT OR IGNORE INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)')
      .run(cleanSession, 'Bengaluru', now);
    return {
      sessionId: cleanSession,
      city: 'Bengaluru',
      items: [],
      subtotal_inr: 0,
      tax_inr: 0,
      delivery_inr: 0,
      total_inr: 0,
      updatedAt: now,
    };
  }

  const itemRows = storeDb
    .prepare('SELECT product_id as productId, qty FROM cart_items WHERE session_id = ?')
    .all(cleanSession) as CartItem[];

  return {
    sessionId: cartRow.session_id,
    city: cartRow.city,
    items: itemRows,
    ...computeCartBreakdown(itemRows),
    updatedAt: cartRow.updated_at,
  };
}

export function setCartCity(sessionId: string, city: CityName): PersistedCart {
  const cleanSession = sessionId.slice(0, 80);
  const now = new Date().toISOString();
  const tx = storeDb.transaction(() => {
    storeDb
      .prepare(
        `INSERT INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET city = excluded.city, updated_at = excluded.updated_at`
      )
      .run(cleanSession, city, now);
    storeDb.prepare('DELETE FROM cart_items WHERE session_id = ?').run(cleanSession);
  });
  tx();
  return getPersistedCart(cleanSession);
}

export function upsertCartItem(
  sessionId: string,
  city: CityName,
  productId: string,
  delta: number
): PersistedCart {
  const cleanSession = sessionId.slice(0, 80);
  const now = new Date().toISOString();

  const tx = storeDb.transaction(() => {
    storeDb
      .prepare(
        `INSERT INTO carts (session_id, city, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET city = excluded.city, updated_at = excluded.updated_at`
      )
      .run(cleanSession, city, now);

    const inv = storeDb
      .prepare('SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?')
      .get(productId, city) as { stock_qty: number } | undefined;
    const maxStock = inv?.stock_qty ?? 0;

    const current = storeDb
      .prepare('SELECT qty FROM cart_items WHERE session_id = ? AND product_id = ?')
      .get(cleanSession, productId) as { qty: number } | undefined;

    const nextQty = Math.min(maxStock, (current?.qty ?? 0) + delta);
    if (nextQty <= 0) {
      storeDb
        .prepare('DELETE FROM cart_items WHERE session_id = ? AND product_id = ?')
        .run(cleanSession, productId);
    } else {
      storeDb
        .prepare(
          `INSERT INTO cart_items (session_id, product_id, qty, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, product_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`
        )
        .run(cleanSession, productId, nextQty, now);
    }
  });
  tx();
  return getPersistedCart(cleanSession);
}

export function removeCartItem(sessionId: string, productId: string): PersistedCart {
  const cleanSession = sessionId.slice(0, 80);
  storeDb
    .prepare('DELETE FROM cart_items WHERE session_id = ? AND product_id = ?')
    .run(cleanSession, productId);
  return getPersistedCart(cleanSession);
}

// ---------- Race-Proof Transactional Checkout + Outbox ----------

export interface OutboxCommitEntry {
  offset_id: number;
  event_id: string;
  topic: EventTopic;
  event_type: string;
  partition_key: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function executeTransactionalCheckout(input: {
  sessionId?: string;
  idempotencyKey?: string;
  customerName: string;
  customerEmail: string;
  city: CityName;
  shippingAddress: string;
  paymentMethod?: PaymentMethod;
  items: Array<{ productId: string; qty: number }>;
}): {
  order: StoreOrder;
  inventoryUpdates: Array<{ productId: string; city: CityName; delta: number; newStockQty: number }>;
  outboxEntries: OutboxCommitEntry[];
  deduplicated: boolean;
} {
  // 1. Idempotency check BEFORE entering write transaction
  const cleanIdempotency = input.idempotencyKey?.trim().slice(0, 80) || null;
  if (cleanIdempotency) {
    const existing = storeDb
      .prepare('SELECT id FROM orders WHERE idempotency_key = ?')
      .get(cleanIdempotency) as { id: string } | undefined;
    if (existing) {
      const existingOrder = getRecentOrders(50).find((o) => o.id === existing.id);
      if (existingOrder) {
        return {
          order: existingOrder,
          inventoryUpdates: [],
          outboxEntries: [],
          deduplicated: true,
        };
      }
    }
  }

  const runTx = storeDb.transaction(() => {
    const now = new Date().toISOString();
    let subtotalInr = 0;
    const resolvedItems: Array<{
      productId: string;
      productName: string;
      qty: number;
      unitPriceInr: number;
      newStockQty: number;
    }> = [];

    const selectProduct = storeDb.prepare('SELECT id, name, price_inr FROM products WHERE id = ?');
    const selectStock = storeDb.prepare(
      'SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?'
    );
    // Atomic conditional stock decrement preventing race oversells
    const decrementStock = storeDb.prepare(
      'UPDATE city_inventory SET stock_qty = stock_qty - ?, updated_at = ? WHERE product_id = ? AND city = ? AND stock_qty >= ?'
    );

    for (const line of input.items) {
      const qty = Math.max(1, Math.round(line.qty));
      const prod = selectProduct.get(line.productId) as
        | { id: string; name: string; price_inr: number }
        | undefined;
      if (!prod) {
        throw new Error(`Product ${line.productId} not found.`);
      }

      const inv = selectStock.get(line.productId, input.city) as
        | { stock_qty: number }
        | undefined;
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
        newStockQty: available - qty,
      });
    }

    const taxInr = Math.round(subtotalInr * 0.18);
    const deliveryInr = subtotalInr >= 1999 ? 0 : 99;
    const totalInr = subtotalInr + taxInr + deliveryInr;

    // Customer & Address persistence
    const custId = `cust_${crypto.randomUUID().slice(0, 8)}`;
    storeDb
      .prepare(
        `INSERT INTO customers (id, name, email, default_city, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, default_city = excluded.default_city`
      )
      .run(custId, input.customerName, input.customerEmail, input.city, now);

    const actualCust = storeDb
      .prepare('SELECT id FROM customers WHERE email = ?')
      .get(input.customerEmail) as { id: string };

    storeDb
      .prepare('INSERT INTO addresses (id, customer_id, city, line1, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`addr_${crypto.randomUUID().slice(0, 8)}`, actualCust.id, input.city, input.shippingAddress, now);

    const orderCount = (storeDb.prepare('SELECT COUNT(*) as cnt FROM orders').get() as { cnt: number }).cnt;
    const candidateId = `SS-ORD-${1001 + orderCount}`;
    const uniqueOrderId = storeDb.prepare('SELECT id FROM orders WHERE id = ?').get(candidateId)
      ? `SS-ORD-${Date.now().toString().slice(-6)}`
      : candidateId;

    storeDb
      .prepare(
        `INSERT INTO orders (
          id, idempotency_key, customer_name, customer_email, city, shipping_address,
          subtotal_inr, tax_inr, delivery_inr, total_inr, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
      )
      .run(
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
    const orderItems: OrderLineItem[] = [];
    for (const r of resolvedItems) {
      const itemId = `oi_${crypto.randomUUID().slice(0, 8)}`;
      insertItem.run(itemId, uniqueOrderId, r.productId, r.productName, r.qty, r.unitPriceInr);
      orderItems.push({
        id: itemId,
        order_id: uniqueOrderId,
        product_id: r.productId,
        product_name: r.productName,
        qty: r.qty,
        unit_price_inr: r.unitPriceInr,
      });

      storeDb
        .prepare(
          `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `mov_${crypto.randomUUID().slice(0, 8)}`,
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

    // Simulated Payment Gateway Record
    const paymentMethod: PaymentMethod = input.paymentMethod || 'UPI_SIMULATION';
    const paymentRef = `SIM-${paymentMethod.slice(0, 3)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    storeDb
      .prepare(
        `INSERT INTO payments (id, order_id, method, status, amount_inr, reference_code, created_at)
         VALUES (?, ?, ?, 'simulated_authorized', ?, ?, ?)`
      )
      .run(`pay_${crypto.randomUUID().slice(0, 8)}`, uniqueOrderId, paymentMethod, totalInr, paymentRef, now);

    // Clear DB-persisted cart on commit
    if (input.sessionId) {
      storeDb.prepare('DELETE FROM cart_items WHERE session_id = ?').run(input.sessionId.slice(0, 80));
    }

    // Transactional Outbox writes inside the SAME transaction
    const insertOutbox = storeDb.prepare(
      `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, 'committed', 0, ?)`
    );

    const outboxEntries: OutboxCommitEntry[] = [];
    const orderPlacedEventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const orderPayload: Record<string, unknown> = {
      eventId: orderPlacedEventId,
      orderId: uniqueOrderId,
      city: input.city,
      totalInr,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      items: resolvedItems.map((r) => ({ productId: r.productId, qty: r.qty })),
      timestamp: now,
    };
    const info1 = insertOutbox.run(
      orderPlacedEventId,
      'order.placed',
      'OrderPlaced',
      input.city,
      JSON.stringify(orderPayload),
      now
    );
    outboxEntries.push({
      offset_id: Number(info1.lastInsertRowid),
      event_id: orderPlacedEventId,
      topic: 'order.placed',
      event_type: 'OrderPlaced',
      partition_key: input.city,
      payload: orderPayload,
      created_at: now,
    });

    for (const r of resolvedItems) {
      const invEventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
      const invPayload: Record<string, unknown> = {
        eventId: invEventId,
        orderId: uniqueOrderId,
        productId: r.productId,
        city: input.city,
        delta: -r.qty,
        newStockQty: r.newStockQty,
        timestamp: now,
      };
      const infoInv = insertOutbox.run(
        invEventId,
        'inventory.changed',
        'InventoryDecremented',
        `${r.productId}:${input.city}`,
        JSON.stringify(invPayload),
        now
      );
      outboxEntries.push({
        offset_id: Number(infoInv.lastInsertRowid),
        event_id: invEventId,
        topic: 'inventory.changed',
        event_type: 'InventoryDecremented',
        partition_key: `${r.productId}:${input.city}`,
        payload: invPayload,
        created_at: now,
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
        payment_status: 'simulated_authorized' as const,
        payment_reference: paymentRef,
        status: 'confirmed' as const,
        created_at: now,
        items: orderItems,
      },
      inventoryUpdates: resolvedItems.map((r) => ({
        productId: r.productId,
        city: input.city,
        delta: -r.qty,
        newStockQty: r.newStockQty,
      })),
      outboxEntries,
      deduplicated: false,
    };
  });

  try {
    return runTx.immediate();
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      storeDb
        .prepare('UPDATE store_counters SET value = value + 1 WHERE key = ?')
        .run('oversells_prevented');
    }
    throw err;
  }
}

// ---------- Warehouse & Admin Catalog / Order Mutations ----------

export function adjustCityInventory(
  productId: string,
  city: CityName,
  delta: number,
  actorEmail = 'warehouse@storestream.in',
  reason = 'Manual warehouse adjustment'
): {
  productId: string;
  productName: string;
  city: CityName;
  newStockQty: number;
  delta: number;
  outboxEntry: OutboxCommitEntry;
} {
  const tx = storeDb.transaction(() => {
    const prod = storeDb.prepare('SELECT id, name FROM products WHERE id = ?').get(productId) as
      | { id: string; name: string }
      | undefined;
    if (!prod) throw new Error('Product not found.');

    const row = storeDb
      .prepare('SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?')
      .get(productId, city) as { stock_qty: number } | undefined;

    const currentQty = row?.stock_qty ?? 0;
    const nextQty = Math.max(0, currentQty + delta);
    const now = new Date().toISOString();

    storeDb
      .prepare('UPDATE city_inventory SET stock_qty = ?, updated_at = ? WHERE product_id = ? AND city = ?')
      .run(nextQty, now, productId, city);

    storeDb
      .prepare(
        `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(`mov_${crypto.randomUUID().slice(0, 8)}`, productId, prod.name, city, delta, nextQty, reason, actorEmail, now);

    const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const eventType = delta >= 0 ? 'InventoryRestocked' : 'InventoryAdjusted';
    const payload: Record<string, unknown> = {
      eventId,
      productId,
      productName: prod.name,
      city,
      delta,
      newStockQty: nextQty,
      timestamp: now,
    };
    const info = storeDb
      .prepare(
        `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'inventory.changed', ?, ?, ?, 'committed', 0, ?)`
      )
      .run(eventId, eventType, `${productId}:${city}`, JSON.stringify(payload), now);

    return {
      productId,
      productName: prod.name,
      city,
      newStockQty: nextQty,
      delta,
      outboxEntry: {
        offset_id: Number(info.lastInsertRowid),
        event_id: eventId,
        topic: 'inventory.changed' as const,
        event_type: eventType,
        partition_key: `${productId}:${city}`,
        payload,
        created_at: now,
      },
    };
  });

  return tx.immediate();
}

export function createAdminProduct(
  input: {
    sku: string;
    name: string;
    brand: string;
    category: ProductCategory;
    price_inr: number;
    discount_pct: number;
    description: string;
    specs: string[];
    image_url: string;
    tags: string[];
    initialStock: number;
  },
  actorEmail: string,
  actorRole: string
): { product: Product; outboxEntry: OutboxCommitEntry } {
  const id = `prod_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const safeImage = sanitizeImageUrl(input.image_url);

  const tx = storeDb.transaction(() => {
    storeDb
      .prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?, ?)')
      .run(`brand_${input.brand.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, input.brand);

    storeDb
      .prepare(
        `INSERT INTO products (
          id, sku, name, brand, category, price_inr, discount_pct, rating, popularity, is_featured,
          description, specs_json, image_url, tags_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 4.7, 75, 0, ?, ?, ?, ?, ?)`
      )
      .run(
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

    const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId: id, name: input.name, action: 'created', timestamp: now };
    const info = storeDb
      .prepare(
        `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductCreated', ?, ?, 'committed', 0, ?)`
      )
      .run(eventId, id, JSON.stringify(payload), now);

    recordAuditLog(actorEmail, actorRole, 'CREATE_PRODUCT', 'product', id, `Created ${input.name} (${input.sku})`);

    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: 'product.updated' as const,
      event_type: 'ProductCreated',
      partition_key: id,
      payload,
      created_at: now,
    };
  });

  const outboxEntry = tx.immediate();
  const product = getAllProducts().find((p) => p.id === id)!;
  return { product, outboxEntry };
}

export function updateAdminProduct(
  productId: string,
  patch: {
    name?: string;
    price_inr?: number;
    discount_pct?: number;
    category?: ProductCategory;
    description?: string;
    image_url?: string;
  },
  actorEmail: string,
  actorRole: string
): OutboxCommitEntry {
  const tx = storeDb.transaction(() => {
    const existing = storeDb.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
      | { name: string; price_inr: number; discount_pct: number; category: ProductCategory; description: string; image_url: string }
      | undefined;
    if (!existing) throw new Error('Product not found.');

    storeDb
      .prepare(
        `UPDATE products SET name = ?, price_inr = ?, discount_pct = ?, category = ?, description = ?, image_url = ? WHERE id = ?`
      )
      .run(
        patch.name?.trim() || existing.name,
        patch.price_inr !== undefined ? Math.round(patch.price_inr) : existing.price_inr,
        patch.discount_pct !== undefined ? Math.round(patch.discount_pct) : existing.discount_pct,
        patch.category || existing.category,
        patch.description?.trim() || existing.description,
        patch.image_url ? sanitizeImageUrl(patch.image_url) : existing.image_url,
        productId
      );

    const now = new Date().toISOString();
    const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId, action: 'updated', timestamp: now };
    const info = storeDb
      .prepare(
        `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductUpdated', ?, ?, 'committed', 0, ?)`
      )
      .run(eventId, productId, JSON.stringify(payload), now);

    recordAuditLog(actorEmail, actorRole, 'UPDATE_PRODUCT', 'product', productId, `Updated product ${patch.name || existing.name}`);

    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: 'product.updated' as const,
      event_type: 'ProductUpdated',
      partition_key: productId,
      payload,
      created_at: now,
    };
  });

  return tx.immediate();
}

export function deleteAdminProduct(
  productId: string,
  actorEmail: string,
  actorRole: string
): OutboxCommitEntry {
  const tx = storeDb.transaction(() => {
    const existing = storeDb.prepare('SELECT name FROM products WHERE id = ?').get(productId) as
      | { name: string }
      | undefined;
    if (!existing) throw new Error('Product not found.');

    storeDb.prepare('DELETE FROM products WHERE id = ?').run(productId);
    const now = new Date().toISOString();
    const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const payload = { eventId, productId, action: 'deleted', timestamp: now };
    const info = storeDb
      .prepare(
        `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'product.updated', 'ProductDeleted', ?, ?, 'committed', 0, ?)`
      )
      .run(eventId, productId, JSON.stringify(payload), now);

    recordAuditLog(actorEmail, actorRole, 'DELETE_PRODUCT', 'product', productId, `Deleted product ${existing.name}`);

    return {
      offset_id: Number(info.lastInsertRowid),
      event_id: eventId,
      topic: 'product.updated' as const,
      event_type: 'ProductDeleted',
      partition_key: productId,
      payload,
      created_at: now,
    };
  });
  return tx.immediate();
}

export function updateOrderLifecycle(
  orderId: string,
  nextStatus: OrderStatus,
  actorEmail: string,
  actorRole: string
): OutboxCommitEntry[] {
  const tx = storeDb.transaction(() => {
    const order = storeDb
      .prepare('SELECT id, city, customer_email, status FROM orders WHERE id = ?')
      .get(orderId) as
      | { id: string; city: CityName; customer_email: string; status: OrderStatus }
      | undefined;
    if (!order) throw new Error('Order not found.');
    if (order.status === 'cancelled') {
      throw new Error('Cancelled orders cannot be transitioned.');
    }

    const now = new Date().toISOString();
    const outboxEntries: OutboxCommitEntry[] = [];

    if (nextStatus === 'cancelled') {
      const items = storeDb
        .prepare('SELECT product_id, product_name, qty FROM order_items WHERE order_id = ?')
        .all(orderId) as Array<{ product_id: string; product_name: string; qty: number }>;

      for (const item of items) {
        storeDb
          .prepare('UPDATE city_inventory SET stock_qty = stock_qty + ?, updated_at = ? WHERE product_id = ? AND city = ?')
          .run(item.qty, now, item.product_id, order.city);

        const invRow = storeDb
          .prepare('SELECT stock_qty FROM city_inventory WHERE product_id = ? AND city = ?')
          .get(item.product_id, order.city) as { stock_qty: number } | undefined;

        storeDb
          .prepare(
            `INSERT INTO stock_movements (id, product_id, product_name, city, delta, stock_after, reason, actor_email, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            `mov_${crypto.randomUUID().slice(0, 8)}`,
            item.product_id,
            item.product_name,
            order.city,
            item.qty,
            invRow?.stock_qty ?? item.qty,
            `Order ${orderId} cancelled & refunded`,
            actorEmail,
            now
          );

        const invEvtId = `evt_${crypto.randomUUID().slice(0, 12)}`;
        const invPayload = {
          eventId: invEvtId,
          orderId,
          productId: item.product_id,
          city: order.city,
          delta: item.qty,
          newStockQty: invRow?.stock_qty ?? item.qty,
          timestamp: now,
        };
        const invInfo = storeDb
          .prepare(
            `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
             VALUES (?, 'inventory.changed', 'InventoryRestored', ?, ?, 'committed', 0, ?)`
          )
          .run(invEvtId, `${item.product_id}:${order.city}`, JSON.stringify(invPayload), now);
        outboxEntries.push({
          offset_id: Number(invInfo.lastInsertRowid),
          event_id: invEvtId,
          topic: 'inventory.changed',
          event_type: 'InventoryRestored',
          partition_key: `${item.product_id}:${order.city}`,
          payload: invPayload,
          created_at: now,
        });
      }

      storeDb
        .prepare("UPDATE payments SET status = 'simulated_refunded' WHERE order_id = ?")
        .run(orderId);

      const cancelEvtId = `evt_${crypto.randomUUID().slice(0, 12)}`;
      const cancelPayload = {
        eventId: cancelEvtId,
        orderId,
        city: order.city,
        customerEmail: order.customer_email,
        timestamp: now,
      };
      const cancelInfo = storeDb
        .prepare(
          `INSERT INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
           VALUES (?, 'order.cancelled', 'OrderCancelled', ?, ?, 'committed', 0, ?)`
        )
        .run(cancelEvtId, orderId, JSON.stringify(cancelPayload), now);
      outboxEntries.push({
        offset_id: Number(cancelInfo.lastInsertRowid),
        event_id: cancelEvtId,
        topic: 'order.cancelled',
        event_type: 'OrderCancelled',
        partition_key: orderId,
        payload: cancelPayload,
        created_at: now,
      });
    }

    storeDb.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, orderId);
    recordAuditLog(actorEmail, actorRole, 'ORDER_STATUS', 'order', orderId, `Updated order ${orderId} → ${nextStatus}`);

    return outboxEntries;
  });

  return tx.immediate();
}

// ---------- Full Store Snapshot & Analytics ----------

export function getStoreSnapshot(
  indexedDocuments: number,
  lastIndexedAt: string
): StoreSnapshot {
  const products = getAllProducts();
  const orders = getRecentOrders(30);
  const events = getRecentEvents(50);
  const confirmations = getRecentNotifications(30);

  const stockMovements = storeDb
    .prepare('SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 30')
    .all() as StockMovementRecord[];
  const auditLogs = storeDb
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30')
    .all() as AuditLogRecord[];

  const totalOrders = (storeDb.prepare('SELECT COUNT(*) as cnt FROM orders').get() as { cnt: number }).cnt;
  const totalRevenueInr = (
    storeDb.prepare("SELECT COALESCE(SUM(total_inr), 0) as rev FROM orders WHERE status != 'cancelled'").get() as {
      rev: number;
    }
  ).rev;
  const activeCustomers = (storeDb.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number }).cnt;
  const totalEventsProcessed = (
    storeDb.prepare('SELECT COUNT(*) as cnt FROM event_log').get() as { cnt: number }
  ).cnt;
  const dlqEventsCount = (
    storeDb.prepare("SELECT COUNT(*) as cnt FROM event_log WHERE consumer_status = 'dlq'").get() as { cnt: number }
  ).cnt;
  const oversellsPrevented =
    (
      storeDb
        .prepare('SELECT value FROM store_counters WHERE key = ?')
        .get('oversells_prevented') as { value: number } | undefined
    )?.value ?? 0;
  const confirmationsSent = (
    storeDb.prepare('SELECT COUNT(*) as cnt FROM notifications').get() as { cnt: number }
  ).cnt;
  const activeCartItems = (
    storeDb.prepare('SELECT COALESCE(SUM(qty), 0) as cnt FROM cart_items').get() as { cnt: number }
  ).cnt;

  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const p of products) {
    for (const c of CITIES) {
      const qty = p.inventory_by_city[c]?.stock_qty ?? 0;
      if (qty === 0) outOfStockCount++;
      else if (qty <= 3) lowStockCount++;
    }
  }

  const awaitingProcessingCount = (
    storeDb.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'confirmed'").get() as { cnt: number }
  ).cnt;

  const cityRevMap = new Map<CityName, { revenue: number; orders: number }>();
  for (const c of CITIES) cityRevMap.set(c, { revenue: 0, orders: 0 });
  const orderCityRows = storeDb
    .prepare("SELECT city, total_inr FROM orders WHERE status != 'cancelled'")
    .all() as Array<{ city: CityName; total_inr: number }>;
  for (const r of orderCityRows) {
    const prev = cityRevMap.get(r.city) || { revenue: 0, orders: 0 };
    cityRevMap.set(r.city, { revenue: prev.revenue + r.total_inr, orders: prev.orders + 1 });
  }

  const categoryPerfMap = new Map<ProductCategory, { products: number; unitsInStock: number; revenue: number }>();
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
  const itemRevRows = storeDb
    .prepare(
      `SELECT p.category, SUM(oi.qty * oi.unit_price_inr) as rev
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'cancelled'
       GROUP BY p.category`
    )
    .all() as Array<{ category: ProductCategory; rev: number }>;
  for (const row of itemRevRows) {
    const entry = categoryPerfMap.get(row.category);
    if (entry) entry.revenue = row.rev;
  }

  const analytics: AnalyticsSummary = {
    totalRevenueInr,
    totalOrders,
    activeCustomers,
    lowStockCount,
    outOfStockCount,
    awaitingProcessingCount,
    revenueByCity: CITIES.map((city) => ({
      city,
      revenue: cityRevMap.get(city)?.revenue || 0,
      orders: cityRevMap.get(city)?.orders || 0,
    })),
    categoryPerformance: CATEGORIES.map((category) => ({
      category,
      ...categoryPerfMap.get(category)!,
    })),
    topProducts: [...products]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        name: p.name,
        brand: p.brand,
        popularity: p.popularity,
        price_inr: p.price_inr,
        stockTotal: CITIES.reduce((s, c) => s + (p.inventory_by_city[c]?.stock_qty ?? 0), 0),
      })),
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
      dlqEventsCount,
    },
  };
}
