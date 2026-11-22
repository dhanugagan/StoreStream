import crypto from 'node:crypto';
import type { CityName, EventTopic } from '../shared/types/storestream.ts';
import { searchIndex } from '../server/search-engine.ts';
import { recordOrderNotification, storeDb } from '../server/store-db.ts';

export interface OutboxEventMessage {
  offset_id: number;
  event_id: string;
  topic: EventTopic;
  event_type: string;
  partition_key: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Application-level idempotency check using processed_events(event_id, consumer_group).
 * Ensures duplicate Kafka deliveries or retries never execute duplicate business side effects.
 */
export function claimConsumerIdempotency(eventId: string, consumerGroup: string): boolean {
  const result = storeDb
    .prepare(
      'INSERT OR IGNORE INTO processed_events (event_id, consumer_group, processed_at) VALUES (?, ?, ?)'
    )
    .run(eventId, consumerGroup, new Date().toISOString());
  return result.changes > 0;
}

/**
 * Consumer 1: Inventory Consumer (cg-inventory)
 * Audits inventory ledger transitions and raises low-stock operational alerts when <= 3 units remain.
 */
export function runInventoryConsumer(event: OutboxEventMessage): {
  processed: boolean;
  lowStockAlert?: string;
} {
  if (!claimConsumerIdempotency(event.event_id, 'cg-inventory')) {
    return { processed: false };
  }

  let lowStockAlert: string | undefined;
  if (event.topic === 'inventory.changed') {
    const newQty = Number(event.payload.newStockQty ?? -1);
    const productId = String(event.payload.productId || '');
    const city = String(event.payload.city || '') as CityName;
    if (newQty >= 0 && newQty <= 3 && productId && city) {
      lowStockAlert = `Low-stock alert: ${productId} in ${city} has ${newQty} unit(s) left.`;
    }
  }
  return { processed: true, lowStockAlert };
}

/**
 * Consumer 2: Search Index Consumer (cg-search-sync)
 * Synchronizes OpenSearch product index incrementally from PostgreSQL/SQLite source of truth.
 */
export function runSearchIndexConsumer(event: OutboxEventMessage): {
  processed: boolean;
  indexedDocuments: number;
} {
  if (!claimConsumerIdempotency(event.event_id, 'cg-search-sync')) {
    return { processed: false, indexedDocuments: searchIndex.getDocumentCount() };
  }
  const indexedDocuments = searchIndex.rebuildFromDatabase();
  return { processed: true, indexedDocuments };
}

/**
 * Consumer 3: Order Notification Consumer (cg-notifications)
 * Persists customer notification receipts and records order.confirmed lifecycle events.
 */
export function runNotificationConsumer(event: OutboxEventMessage): {
  processed: boolean;
  notificationCreated: boolean;
} {
  if (!claimConsumerIdempotency(event.event_id, 'cg-notifications')) {
    return { processed: false, notificationCreated: false };
  }

  if (
    event.topic === 'order.placed' &&
    typeof event.payload.orderId === 'string' &&
    typeof event.payload.customerEmail === 'string' &&
    typeof event.payload.city === 'string'
  ) {
    const orderId = event.payload.orderId;
    const customerEmail = event.payload.customerEmail;
    const city = event.payload.city as CityName;

    recordOrderNotification(
      orderId,
      customerEmail,
      city,
      `Order ${orderId} confirmed · Stock reserved in ${city}.`
    );

    // Record order.confirmed lifecycle event idempotently
    const confirmEventId = `evt_conf_${event.event_id}`;
    storeDb
      .prepare(
        `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, created_at)
         VALUES (?, 'order.confirmed', 'OrderConfirmed', ?, ?, 'indexed_and_confirmed', 0, ?)`
      )
      .run(
        confirmEventId,
        orderId,
        JSON.stringify({ orderId, customerEmail, city, sourceEventId: event.event_id }),
        new Date().toISOString()
      );

    return { processed: true, notificationCreated: true };
  }

  if (
    event.topic === 'order.cancelled' &&
    typeof event.payload.orderId === 'string' &&
    typeof event.payload.customerEmail === 'string' &&
    typeof event.payload.city === 'string'
  ) {
    recordOrderNotification(
      event.payload.orderId,
      event.payload.customerEmail,
      event.payload.city as CityName,
      `Order ${event.payload.orderId} cancelled · Simulated payment refunded & ${event.payload.city} stock restored.`
    );
    return { processed: true, notificationCreated: true };
  }

  return { processed: true, notificationCreated: false };
}

export function routeEventToDeadLetter(event: OutboxEventMessage, reason: string): void {
  const dlqId = `dlq_${crypto.randomUUID().slice(0, 8)}`;
  storeDb
    .prepare("UPDATE event_log SET consumer_status = 'dlq', retry_count = retry_count + 1, last_error = ? WHERE event_id = ?")
    .run(reason, event.event_id);

  storeDb
    .prepare(
      `INSERT OR IGNORE INTO event_log (event_id, topic, event_type, partition_key, payload_json, consumer_status, retry_count, last_error, created_at)
       VALUES (?, 'storestream.dlq', 'DeadLetterRouted', ?, ?, 'dlq', 1, ?, ?)`
    )
    .run(
      dlqId,
      `${event.topic}:${event.event_id}`,
      JSON.stringify({ failedEventId: event.event_id, originalTopic: event.topic, reason }),
      reason,
      new Date().toISOString()
    );
}
