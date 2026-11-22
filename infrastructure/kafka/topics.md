# StoreStream Kafka Topics & Consumer Group Architecture

| Topic | Partition Key | Partitions | Purpose | Consumers |
| --- | --- | --- | --- | --- |
| `order.placed` | `city` | 6 | Published via transactional outbox when an order commits atomically | `cg-inventory`, `cg-search-sync`, `cg-notifications` |
| `inventory.changed` | `productId:city` | 6 | Emitted on stock decrement, restock, or order cancellation | `cg-search-sync`, `cg-inventory` |
| `order.confirmed` | `orderId` | 3 | Emitted after notification & confirmation receipt are persisted | `cg-notifications` |
| `order.cancelled` | `orderId` | 3 | Emitted when admin/customer cancels order and restores stock | `cg-inventory`, `cg-search-sync`, `cg-notifications` |
| `product.updated` | `productId` | 3 | Emitted when admin creates, edits, or deletes catalog products | `cg-search-sync` |
| `storestream.dlq` | `topic:eventId` | 1 | Dead-letter queue for events failing after max retries | Ops inspection |

## Idempotency Contract
All consumers enforce application-level idempotency via the `processed_events(event_id, consumer_group)` primary key before applying side effects.
