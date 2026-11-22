import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import type {
  CityName,
  OrderStatus,
  PaymentMethod,
  ProductCategory,
  RaceBuyerOutcome,
  RaceTestReport,
  SortOption,
} from '../shared/types/storestream.ts';
import { aivenBridge } from './adapters/aiven.ts';
import { eventBus } from './event-bus.ts';
import { searchIndex } from './search-engine.ts';
import {
  type AuthenticatedRequest,
  createRateLimiter,
  optionalAuth,
  requireAuth,
  requireRoles,
  securityHeadersMiddleware,
  signJwt,
} from './security.ts';
import {
  CATEGORIES,
  CITIES,
  InsufficientStockError,
  adjustCityInventory,
  authenticateUser,
  claimInitialAdmin,
  createAdminProduct,
  deleteAdminProduct,
  executeTransactionalCheckout,
  getAllProducts,
  getPersistedCart,
  getStoreSnapshot,
  hasAdminClaimed,
  initStoreDatabase,
  markAllNotificationsRead,
  registerCustomer,
  removeCartItem,
  setCartCity,
  storeDb,
  updateAdminProduct,
  updateOrderLifecycle,
  upsertCartItem,
} from './store-db.ts';

const VALID_CITIES = new Set<CityName>(CITIES);
const VALID_CATEGORIES = new Set<ProductCategory>(CATEGORIES);
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const UPLOAD_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), 'storestream_uploads')
  : path.resolve(process.cwd(), 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      cb(null, `prod_${crypto.randomUUID().slice(0, 8)}${safeExt}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const cityEnum = z.enum(['Bengaluru', 'Mumbai', 'Delhi NCR', 'Hyderabad', 'Chennai', 'Pune']);
const categoryEnum = z.enum([
  'Electronics',
  'Fashion',
  'Home and Kitchen',
  'Grocery',
  'Accessories',
  'Beauty',
  'Sports',
]);

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(120),
  defaultCity: cityEnum.default('Bengaluru'),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(4).max(120),
});

const claimAdminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(120),
  role: z.enum(['Administrator', 'Inventory Manager']).default('Administrator'),
});

const cartItemSchema = z.object({
  sessionId: z.string().trim().min(1).max(80),
  city: cityEnum,
  productId: z.string().trim().min(1).max(80),
  delta: z.number().int().min(-50).max(50),
});

const checkoutSchema = z.object({
  sessionId: z.string().trim().max(80).optional(),
  idempotencyKey: z.string().trim().max(80).optional(),
  customerName: z.string().trim().min(2).max(80),
  customerEmail: z.string().trim().email().max(120),
  city: cityEnum,
  shippingAddress: z.string().trim().min(4).max(240),
  paymentMethod: z.enum(['UPI_SIMULATION', 'CARD_SIMULATION', 'COD_SIMULATION']).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(80),
        qty: z.number().int().min(1).max(50),
      })
    )
    .min(1),
});

const createProductSchema = z.object({
  sku: z.string().trim().min(3).max(40),
  name: z.string().trim().min(2).max(140),
  brand: z.string().trim().min(2).max(60),
  category: categoryEnum,
  price_inr: z.number().positive().max(2000000),
  discount_pct: z.number().int().min(0).max(90).default(0),
  description: z.string().trim().min(5).max(800),
  specs: z.array(z.string().trim().min(1).max(120)).default([]),
  image_url: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  initialStock: z.number().int().min(0).max(1000).default(5),
});

const updateProductSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  price_inr: z.number().positive().max(2000000).optional(),
  discount_pct: z.number().int().min(0).max(90).optional(),
  category: categoryEnum.optional(),
  description: z.string().trim().min(5).max(800).optional(),
  image_url: z.string().trim().min(1).max(300).optional(),
});

const restockSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  city: cityEnum,
  delta: z.number().int().min(-500).max(500),
  reason: z.string().trim().max(140).optional(),
});

const orderStatusSchema = z.object({
  status: z.enum(['confirmed', 'packing', 'dispatched', 'delivered', 'cancelled']),
});

export function createStoreStreamApp(broadcastEvent?: (event: string, payload: unknown) => void) {
  initStoreDatabase();
  searchIndex.rebuildFromDatabase();
  if (broadcastEvent) {
    eventBus.registerBroadcaster(broadcastEvent);
  }

  const app = express();
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/', createRateLimiter(300, 60_000));
  app.use('/uploads', express.static(UPLOAD_DIR));

  app.get('/api/health', (_req, res) => {
    const infra = aivenBridge.getStatus();
    res.json({
      status: 'ok',
      service: 'storestream',
      realtimeTransport: IS_SERVERLESS ? 'http' : 'websocket',
      infrastructureMode: infra.mode,
      infrastructure: infra,
      indexedDocuments: searchIndex.getDocumentCount(),
      lastIndexedAt: searchIndex.getLastIndexedAt(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/auth/status', (_req, res) => {
    res.json({
      adminClaimed: hasAdminClaimed(),
      envPasscodeConfigured: Boolean(process.env.ADMIN_PASSCODE?.trim()),
    });
  });

  app.post('/api/auth/claim-admin', (req, res) => {
    const parsed = claimAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid admin claim details.' });
      return;
    }
    try {
      const user = claimInitialAdmin(parsed.data);
      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });
      res.status(201).json({ user, token });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Admin claim unavailable.' });
    }
  });

  app.post('/api/auth/register', (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' });
      return;
    }
    try {
      const user = registerCustomer(parsed.data);
      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });
      res.status(201).json({ user, token });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Registration failed.' });
      return;
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid email and password are required.' });
      return;
    }
    const user = authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const token = signJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    res.json({ user, token });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  app.get('/api/store/snapshot', (_req, res) => {
    res.json(getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt()));
  });

  app.post('/api/notifications/mark-read', (_req, res) => {
    markAllNotificationsRead();
    const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
    broadcastEvent?.('store:synced', snapshot);
    res.json({ snapshot });
  });

  app.get('/api/search/suggest', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const rawCity = typeof req.query.city === 'string' ? (req.query.city as CityName) : 'Bengaluru';
    const city: CityName = VALID_CITIES.has(rawCity) ? rawCity : 'Bengaluru';
    res.json({
      query,
      city,
      suggestions: searchIndex.suggest(query, city, 6),
    });
  });

  app.get('/api/search', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const rawCity = typeof req.query.city === 'string' ? (req.query.city as CityName) : 'Bengaluru';
    const city: CityName = VALID_CITIES.has(rawCity) ? rawCity : 'Bengaluru';
    const rawCat = typeof req.query.category === 'string' ? (req.query.category as ProductCategory) : undefined;
    const category = rawCat && VALID_CATEGORIES.has(rawCat) ? rawCat : 'all';
    const brand = typeof req.query.brand === 'string' && req.query.brand.trim() ? req.query.brand.trim() : 'all';
    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : undefined;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : undefined;
    const minRating = req.query.minRating ? Number(req.query.minRating) : undefined;
    const inStockOnly = req.query.inStockOnly === 'true';
    const sortRaw = typeof req.query.sort === 'string' ? (req.query.sort as SortOption) : 'relevance';

    res.json(
      searchIndex.search({
        query,
        city,
        category,
        brand,
        minPrice: Number.isFinite(minPrice) ? minPrice : undefined,
        maxPrice: Number.isFinite(maxPrice) ? maxPrice : undefined,
        minRating: Number.isFinite(minRating) ? minRating : undefined,
        inStockOnly,
        sort: sortRaw,
      })
    );
  });

  app.get('/api/cart', (req, res) => {
    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
        ? req.query.sessionId.trim()
        : 'default-session';
    res.json(getPersistedCart(sessionId));
  });

  app.put('/api/cart/city', (req, res) => {
    const parsed = z
      .object({ sessionId: z.string().trim().min(1).max(80), city: cityEnum })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid sessionId and city are required.' });
      return;
    }
    const cart = setCartCity(parsed.data.sessionId, parsed.data.city);
    broadcastEvent?.(
      'store:synced',
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });

  app.post('/api/cart/items', (req, res) => {
    const parsed = cartItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid sessionId, city, productId, and numeric delta are required.' });
      return;
    }
    const cart = upsertCartItem(
      parsed.data.sessionId,
      parsed.data.city,
      parsed.data.productId,
      parsed.data.delta
    );
    broadcastEvent?.(
      'store:synced',
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });

  app.delete('/api/cart/items/:productId', (req, res) => {
    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
        ? req.query.sessionId.trim()
        : 'default-session';
    const cart = removeCartItem(sessionId, req.params.productId);
    broadcastEvent?.(
      'store:synced',
      getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt())
    );
    res.json(cart);
  });

  app.post('/api/orders/checkout', optionalAuth, (req: AuthenticatedRequest, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid checkout payload.' });
      return;
    }

    const idempotencyKey =
      (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key']) ||
      parsed.data.idempotencyKey;

    try {
      const result = executeTransactionalCheckout({
        sessionId: parsed.data.sessionId,
        idempotencyKey,
        customerName: parsed.data.customerName,
        customerEmail: parsed.data.customerEmail,
        city: parsed.data.city,
        shippingAddress: parsed.data.shippingAddress,
        paymentMethod: parsed.data.paymentMethod as PaymentMethod | undefined,
        items: parsed.data.items,
      });

      if (!result.deduplicated && result.outboxEntries.length > 0) {
        eventBus.dispatchCommittedOutbox(result.outboxEntries);
      }

      const snapshot = getStoreSnapshot(
        searchIndex.getDocumentCount(),
        searchIndex.getLastIndexedAt()
      );
      broadcastEvent?.('store:synced', snapshot);
      res.status(result.deduplicated ? 200 : 201).json({
        order: result.order,
        deduplicated: result.deduplicated,
        snapshot,
      });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        const snapshot = getStoreSnapshot(
          searchIndex.getDocumentCount(),
          searchIndex.getLastIndexedAt()
        );
        broadcastEvent?.('store:synced', snapshot);
        res.status(409).json({
          error: err.message,
          code: 'INSUFFICIENT_STOCK',
          available: err.available,
          snapshot,
        });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Checkout failed.' });
    }
  });

  app.post('/api/orders/race-test', async (req, res) => {
    const parsed = z
      .object({
        productId: z.string().trim().default('prod_earphones'),
        city: cityEnum.default('Bengaluru'),
      })
      .safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid race test parameters.' });
      return;
    }

    const { productId, city } = parsed.data;
    const product = getAllProducts().find((p) => p.id === productId);
    if (!product) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const stockBefore = product.inventory_by_city[city]?.stock_qty ?? 0;

    const attemptBuyer = async (buyerLabel: string, email: string): Promise<RaceBuyerOutcome> => {
      const start = performance.now();
      try {
        const { order, outboxEntries } = executeTransactionalCheckout({
          customerName: buyerLabel,
          customerEmail: email,
          city,
          shippingAddress: `Express Demo Fulfillment Hub, ${city}`,
          paymentMethod: 'UPI_SIMULATION',
          items: [{ productId, qty: 1 }],
        });

        eventBus.dispatchCommittedOutbox(outboxEntries);
        return {
          buyer: buyerLabel,
          statusCode: 201,
          outcome: 'confirmed',
          orderId: order.id,
          message: `Transaction committed · Order ${order.id} confirmed`,
          durationMs: Math.round((performance.now() - start) * 10) / 10,
        };
      } catch (err) {
        return {
          buyer: buyerLabel,
          statusCode: 409,
          outcome: 'rejected_oversell',
          message: err instanceof Error ? err.message : 'Out of stock',
          durationMs: Math.round((performance.now() - start) * 10) / 10,
        };
      }
    };

    const outcomes = await Promise.all([
      attemptBuyer('Customer A (Web Browser)', 'customer.a@example.in'),
      attemptBuyer('Customer B (Mobile App)', 'customer.b@example.in'),
    ]);

    const afterProd = getAllProducts().find((p) => p.id === productId);
    const stockAfter = afterProd?.inventory_by_city[city]?.stock_qty ?? 0;

    const snapshot = getStoreSnapshot(
      searchIndex.getDocumentCount(),
      searchIndex.getLastIndexedAt()
    );
    broadcastEvent?.('store:synced', snapshot);

    const report: RaceTestReport = {
      productId,
      productName: product.name,
      city,
      stockBefore,
      stockAfter,
      outcomes,
    };
    res.json({ report, snapshot });
  });

  app.post('/api/demo/reset-race-stock', (req, res) => {
    const parsed = z
      .object({
        productId: z.string().trim().default('prod_earphones'),
        city: cityEnum.default('Bengaluru'),
      })
      .safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid parameters.' });
      return;
    }

    const { productId, city } = parsed.data;
    const current = getAllProducts().find((p) => p.id === productId)?.inventory_by_city[city]?.stock_qty ?? 0;
    const delta = 1 - current;
    const updated = adjustCityInventory(
      productId,
      city,
      delta,
      'demo@storestream.in',
      'Reset to 1 unit for Hackathon Race Test'
    );
    eventBus.dispatchCommittedOutbox([updated.outboxEntry]);
    const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
    broadcastEvent?.('store:synced', snapshot);
    res.json({ updated, snapshot });
  });

  app.post(
    '/api/admin/upload',
    requireAuth,
    requireRoles('Administrator'),
    upload.single('image'),
    (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'Valid JPG, PNG, or WEBP image (max 2MB) is required.' });
        return;
      }
      const resolved = path.resolve(req.file.path);
      if (!resolved.startsWith(UPLOAD_DIR + path.sep)) {
        res.status(400).json({ error: 'Invalid upload destination.' });
        return;
      }
      res.status(201).json({ imageUrl: `/uploads/${path.basename(resolved)}` });
    }
  );

  app.post(
    '/api/admin/products',
    requireAuth,
    requireRoles('Administrator'),
    (req: AuthenticatedRequest, res) => {
      const parsed = createProductSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid product payload.' });
        return;
      }
      try {
        const { product, outboxEntry } = createAdminProduct(
          parsed.data,
          req.authUser!.email,
          req.authUser!.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.('store:synced', snapshot);
        res.status(201).json({ product, snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create product.' });
      }
    }
  );

  app.patch(
    '/api/admin/products/:id',
    requireAuth,
    requireRoles('Administrator'),
    (req: AuthenticatedRequest, res) => {
      const parsed = updateProductSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid update payload.' });
        return;
      }
      try {
        const outboxEntry = updateAdminProduct(
          req.params.id,
          parsed.data,
          req.authUser!.email,
          req.authUser!.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.('store:synced', snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : 'Product update failed.' });
      }
    }
  );

  app.delete(
    '/api/admin/products/:id',
    requireAuth,
    requireRoles('Administrator'),
    (req: AuthenticatedRequest, res) => {
      try {
        const outboxEntry = deleteAdminProduct(
          req.params.id,
          req.authUser!.email,
          req.authUser!.role
        );
        eventBus.dispatchCommittedOutbox([outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.('store:synced', snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : 'Product deletion failed.' });
      }
    }
  );

  app.post(
    '/api/admin/inventory/restock',
    requireAuth,
    requireRoles('Administrator', 'Inventory Manager'),
    (req: AuthenticatedRequest, res) => {
      const parsed = restockSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid inventory update.' });
        return;
      }
      try {
        const updated = adjustCityInventory(
          parsed.data.productId,
          parsed.data.city,
          parsed.data.delta,
          req.authUser!.email,
          parsed.data.reason || 'Admin warehouse adjustment'
        );
        eventBus.dispatchCommittedOutbox([updated.outboxEntry]);
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.('store:synced', snapshot);
        res.json({ updated, snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Stock adjustment failed.' });
      }
    }
  );

  app.patch(
    '/api/admin/orders/:id/status',
    requireAuth,
    requireRoles('Administrator', 'Inventory Manager'),
    (req: AuthenticatedRequest, res) => {
      const parsed = orderStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Valid order status is required.' });
        return;
      }
      try {
        const outboxEntries = updateOrderLifecycle(
          req.params.id,
          parsed.data.status as OrderStatus,
          req.authUser!.email,
          req.authUser!.role
        );
        if (outboxEntries.length > 0) {
          eventBus.dispatchCommittedOutbox(outboxEntries);
        }
        const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
        broadcastEvent?.('store:synced', snapshot);
        res.json({ snapshot });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Order status update failed.' });
      }
    }
  );

  app.post(
    '/api/admin/events/:eventId/replay',
    requireAuth,
    requireRoles('Administrator'),
    (req: AuthenticatedRequest, res) => {
      const row = storeDb
        .prepare('SELECT * FROM event_log WHERE event_id = ?')
        .get(req.params.eventId) as
        | {
            offset_id: number;
            event_id: string;
            topic: 'order.placed' | 'inventory.changed' | 'order.confirmed' | 'order.cancelled' | 'product.updated' | 'storestream.dlq';
            event_type: string;
            partition_key: string;
            payload_json: string;
            created_at: string;
          }
        | undefined;
      if (!row) {
        res.status(404).json({ error: 'Event not found.' });
        return;
      }
      eventBus.dispatchCommittedOutbox([
        {
          offset_id: row.offset_id,
          event_id: row.event_id,
          topic: row.topic,
          event_type: row.event_type,
          partition_key: row.partition_key,
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
          created_at: row.created_at,
        },
      ]);
      const snapshot = getStoreSnapshot(searchIndex.getDocumentCount(), searchIndex.getLastIndexedAt());
      res.json({ replayed: row.event_id, snapshot });
    }
  );

  return app;
}
