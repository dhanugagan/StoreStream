import type { StreamEventRecord } from '../shared/types/storestream.ts';
import {
  type OutboxEventMessage,
  routeEventToDeadLetter,
  runInventoryConsumer,
  runNotificationConsumer,
  runSearchIndexConsumer,
} from '../workers/event-consumers.ts';
import { aivenBridge } from './adapters/aiven.ts';
import { searchIndex } from './search-engine.ts';
import { getStoreSnapshot, storeDb } from './store-db.ts';
import type { OutboxCommitEntry } from './store-db.ts';

type EventBroadcastCallback = (eventName: string, payload: unknown) => void;

class StoreEventBus {
  private broadcaster: EventBroadcastCallback | null = null;

  public registerBroadcaster(fn: EventBroadcastCallback): void {
    this.broadcaster = fn;
  }

  public dispatchCommittedOutbox(entries: OutboxCommitEntry[]): void {
    for (const entry of entries) {
      const initialRecord: StreamEventRecord = {
        offset_id: entry.offset_id,
        event_id: entry.event_id,
        topic: entry.topic,
        event_type: entry.event_type,
        partition_key: entry.partition_key,
        payload: entry.payload,
        consumer_status: 'committed',
        retry_count: 0,
        last_error: null,
        consumer_groups_processed: [],
        created_at: entry.created_at,
      };

      this.broadcaster?.('stream:event', initialRecord);

      // Forward to live Aiven Kafka broker if configured
      void aivenBridge.publishKafkaMessage(entry.topic, entry.partition_key, {
        eventId: entry.event_id,
        eventType: entry.event_type,
        ...entry.payload,
      });

      // Execute independent asynchronous consumers cleanly after transaction commit
      queueMicrotask(() => {
        this.processWithRetry(entry, 0);
      });
    }
  }

  private processWithRetry(entry: OutboxEventMessage, attempt: number): void {
    try {
      const invRes = runInventoryConsumer(entry);
      const searchRes = runSearchIndexConsumer(entry);
      const notifRes = runNotificationConsumer(entry);

      storeDb
        .prepare("UPDATE event_log SET consumer_status = 'indexed_and_confirmed' WHERE event_id = ?")
        .run(entry.event_id);

      const finalized: StreamEventRecord = {
        offset_id: entry.offset_id,
        event_id: entry.event_id,
        topic: entry.topic,
        event_type: entry.event_type,
        partition_key: entry.partition_key,
        payload: entry.payload,
        consumer_status: 'indexed_and_confirmed',
        retry_count: attempt,
        last_error: null,
        consumer_groups_processed: ['cg-inventory', 'cg-search-sync', 'cg-notifications'],
        created_at: entry.created_at,
      };

      this.broadcaster?.('stream:consumer_ack', {
        event: finalized,
        indexedDocuments: searchRes.indexedDocuments,
        notificationCreated: notifRes.notificationCreated,
        lowStockAlert: invRes.lowStockAlert,
      });

      const snapshot = getStoreSnapshot(
        searchIndex.getDocumentCount(),
        searchIndex.getLastIndexedAt()
      );
      this.broadcaster?.('store:synced', snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Consumer execution failed';
      if (attempt < 2) {
        storeDb
          .prepare('UPDATE event_log SET retry_count = retry_count + 1, last_error = ? WHERE event_id = ?')
          .run(msg, entry.event_id);
        setTimeout(() => this.processWithRetry(entry, attempt + 1), 150 * (attempt + 1));
      } else {
        routeEventToDeadLetter(entry, msg);
      }
    }
  }
}

export const eventBus = new StoreEventBus();
