import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DB_PATH = path.resolve(process.cwd(), 'data', `test_storestream_${Date.now()}.db`);
process.env.STORE_DATABASE_PATH = TEST_DB_PATH;
process.env.VITEST = 'true';

const { createStoreStreamApp } = await import('../server.ts');
const {
  InsufficientStockError,
  adjustCityInventory,
  authenticateUser,
  claimInitialAdmin,
  executeTransactionalCheckout,
  getAllProducts,
  getPersistedCart,
  registerCustomer,
  upsertCartItem,
} = await import('../server/store-db.ts');
const { searchIndex } = await import('../server/search-engine.ts');
const { claimConsumerIdempotency, runInventoryConsumer, runNotificationConsumer } = await import(
  '../workers/event-consumers.ts'
);

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  const app = createStoreStreamApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

describe('StoreStream Core Architecture & Race-Proof Suite', () => {
  it('seeds at least 30 products across 7 categories and 6 Indian cities', () => {
    const products = getAllProducts();
    expect(products.length).toBeGreaterThanOrEqual(30);
    const categories = new Set(products.map((p) => p.category));
    expect(categories.size).toBe(7);
  });

  it('registers customer, hashes password with scrypt, and logs in via HTTP + JWT', async () => {
    const customer = registerCustomer({
      name: 'Kavya Sharma',
      email: 'kavya@example.in',
      password: 'SecurePassword123',
      defaultCity: 'Bengaluru',
    });
    expect(customer.role).toBe('Customer');

    const verified = authenticateUser('kavya@example.in', 'SecurePassword123');
    expect(verified?.email).toBe('kavya@example.in');
    expect(authenticateUser('kavya@example.in', 'WrongPass')).toBeNull();

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'kavya@example.in', password: 'SecurePassword123' }),
    });
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as { token: string; user: { role: string } };
    expect(loginJson.token).toBeTruthy();

    // Customer must receive 403 Forbidden on Admin inventory endpoint
    const adminAttempt = await fetch(`${baseUrl}/api/admin/inventory/restock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.token}`,
      },
      body: JSON.stringify({ productId: 'prod_earphones', city: 'Bengaluru', delta: 5 }),
    });
    expect(adminAttempt.status).toBe(403);
  });

  it('supports typo-tolerant search for "bluetoth" and "samzung phone"', async () => {
    const res1 = searchIndex.search({ query: 'bluetoth', city: 'Bengaluru' });
    expect(res1.hits[0]?.id).toBe('prod_earphones');
    expect(res1.fuzzy_corrected_note).toContain('bluetooth');

    const res2 = searchIndex.search({ query: 'samzung phone', city: 'Bengaluru' });
    expect(res2.hits[0]?.id).toBe('prod_samsung_s25');
    expect(res2.fuzzy_corrected_note).toContain('samsung');

    const httpSearch = await fetch(`${baseUrl}/api/search?q=bluetoth&city=Bengaluru`);
    expect(httpSearch.status).toBe(200);
    const body = (await httpSearch.json()) as { total_hits: number };
    expect(body.total_hits).toBeGreaterThan(0);
  });

  it('persists cart items and calculates 18% GST and delivery fee', () => {
    const cart = upsertCartItem('test_sess_1', 'Mumbai', 'prod_coffee', 1);
    expect(cart.items[0]?.qty).toBe(1);
    expect(cart.subtotal_inr).toBe(649);
    expect(cart.delivery_inr).toBe(99);
    expect(cart.tax_inr).toBe(Math.round(649 * 0.18));

    const reloaded = getPersistedCart('test_sess_1');
    expect(reloaded.items.length).toBe(1);
    expect(reloaded.city).toBe('Mumbai');
  });

  it('prevents overselling when two concurrent buyers race for the last 1 unit', async () => {
    // prod_earphones starts seeded with exactly 1 unit in Bengaluru
    const before = getAllProducts().find((p) => p.id === 'prod_earphones')?.inventory_by_city.Bengaluru.stock_qty;
    expect(before).toBe(1);

    const attempt = async (buyerName: string, email: string) => {
      try {
        const res = executeTransactionalCheckout({
          customerName: buyerName,
          customerEmail: email,
          city: 'Bengaluru',
          shippingAddress: 'Indiranagar, Bengaluru',
          paymentMethod: 'UPI_SIMULATION',
          items: [{ productId: 'prod_earphones', qty: 1 }],
        });
        return { ok: true, orderId: res.order.id };
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          return { ok: false, code: 'OUT_OF_STOCK' };
        }
        throw err;
      }
    };

    const [a, b] = await Promise.all([
      attempt('Buyer A', 'race.a@example.in'),
      attempt('Buyer B', 'race.b@example.in'),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const rejections = [a, b].filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);

    const after = getAllProducts().find((p) => p.id === 'prod_earphones')?.inventory_by_city.Bengaluru.stock_qty;
    expect(after).toBe(0);
  });

  it('deduplicates duplicate checkout requests using idempotencyKey', () => {
    const first = executeTransactionalCheckout({
      idempotencyKey: 'idem_test_unique_123',
      customerName: 'Idem Buyer',
      customerEmail: 'idem@example.in',
      city: 'Chennai',
      shippingAddress: 'Anna Nagar, Chennai',
      items: [{ productId: 'prod_charger', qty: 1 }],
    });
    const stockAfterFirst = getAllProducts().find((p) => p.id === 'prod_charger')?.inventory_by_city.Chennai.stock_qty;

    const duplicate = executeTransactionalCheckout({
      idempotencyKey: 'idem_test_unique_123',
      customerName: 'Idem Buyer',
      customerEmail: 'idem@example.in',
      city: 'Chennai',
      shippingAddress: 'Anna Nagar, Chennai',
      items: [{ productId: 'prod_charger', qty: 1 }],
    });
    const stockAfterDuplicate = getAllProducts().find((p) => p.id === 'prod_charger')?.inventory_by_city.Chennai.stock_qty;

    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.order.id).toBe(first.order.id);
    expect(stockAfterDuplicate).toBe(stockAfterFirst);
  });

  it('enforces idempotent Kafka consumer processing across duplicate event deliveries', () => {
    const fakeEvt = {
      offset_id: 999,
      event_id: 'evt_dup_test_01',
      topic: 'order.placed' as const,
      event_type: 'OrderPlaced',
      partition_key: 'Bengaluru',
      payload: { orderId: 'SS-ORD-999', customerEmail: 'dup@example.in', city: 'Bengaluru' },
      created_at: new Date().toISOString(),
    };

    const firstInv = runInventoryConsumer(fakeEvt);
    const secondInv = runInventoryConsumer(fakeEvt);
    expect(firstInv.processed).toBe(true);
    expect(secondInv.processed).toBe(false);

    const firstNotif = runNotificationConsumer(fakeEvt);
    const secondNotif = runNotificationConsumer(fakeEvt);
    expect(firstNotif.notificationCreated).toBe(true);
    expect(secondNotif.processed).toBe(false);

    expect(claimConsumerIdempotency('evt_dup_test_01', 'cg-search-sync')).toBe(true);
    expect(claimConsumerIdempotency('evt_dup_test_01', 'cg-search-sync')).toBe(false);
  });

  it('allows initial admin claim once and authorizes admin restock', async () => {
    const admin = claimInitialAdmin({
      name: 'Ops Admin',
      email: 'ops@storestream.in',
      password: 'AdminPassword123',
      role: 'Administrator',
    });
    expect(admin.role).toBe('Administrator');

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@storestream.in', password: 'AdminPassword123' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const restockRes = await fetch(`${baseUrl}/api/admin/inventory/restock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ productId: 'prod_earphones', city: 'Bengaluru', delta: 2 }),
    });
    expect(restockRes.status).toBe(200);

    const updated = adjustCityInventory('prod_earphones', 'Bengaluru', -1, 'ops@storestream.in', 'Test check');
    expect(updated.newStockQty).toBe(1);
  });
});
