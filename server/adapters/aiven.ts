import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { Kafka, type Producer } from 'kafkajs';
import pg from 'pg';
import type { InfrastructureStatus } from '../../shared/types/storestream.ts';

class AivenInfrastructureBridge {
  private pgPool: pg.Pool | null = null;
  private pgConnected = false;

  private kafkaProducer: Producer | null = null;
  private kafkaConnected = false;

  private osClient: OpenSearchClient | null = null;
  private osConnected = false;

  public async initialize(): Promise<InfrastructureStatus> {
    // 1. Aiven PostgreSQL (optional live connection if DATABASE_URL is provided)
    const dbUrl = process.env.DATABASE_URL?.trim();
    if (dbUrl) {
      try {
        this.pgPool = new pg.Pool({
          connectionString: dbUrl,
          ssl: dbUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
          max: 10,
          connectionTimeoutMillis: 4000,
        });
        await this.pgPool.query('SELECT 1');
        this.pgConnected = true;
      } catch (err) {
        console.warn('[Aiven PG] Connection unavailable, falling back to local transactional engine:', (err as Error).message);
        this.pgConnected = false;
      }
    }

    // 2. Aiven Apache Kafka (optional live connection if KAFKA_BROKERS is provided)
    const brokersRaw = process.env.KAFKA_BROKERS?.trim();
    if (brokersRaw) {
      try {
        const brokers = brokersRaw.split(',').map((b) => b.trim()).filter(Boolean);
        const useSsl = process.env.KAFKA_SSL !== 'false';
        const username = process.env.KAFKA_USERNAME?.trim();
        const password = process.env.KAFKA_PASSWORD?.trim();
        const ca = process.env.KAFKA_SSL_CA?.trim();

        const kafka = new Kafka({
          clientId: 'storestream-backend',
          brokers,
          ssl: useSsl
            ? ca
              ? { rejectUnauthorized: true, ca: [ca] }
              : { rejectUnauthorized: false }
            : false,
          sasl:
            username && password
              ? { mechanism: 'scram-sha-256', username, password }
              : undefined,
          connectionTimeout: 4000,
        });

        this.kafkaProducer = kafka.producer();
        await this.kafkaProducer.connect();
        this.kafkaConnected = true;
      } catch (err) {
        console.warn('[Aiven Kafka] Broker unavailable, running embedded transactional outbox & consumers:', (err as Error).message);
        this.kafkaConnected = false;
      }
    }

    // 3. Aiven OpenSearch (optional live connection if OPENSEARCH_NODE is provided)
    const osNode = process.env.OPENSEARCH_NODE?.trim();
    if (osNode) {
      try {
        const username = process.env.OPENSEARCH_USERNAME?.trim();
        const password = process.env.OPENSEARCH_PASSWORD?.trim();
        this.osClient = new OpenSearchClient({
          node: osNode,
          auth: username && password ? { username, password } : undefined,
          ssl: { rejectUnauthorized: false },
        });
        await this.osClient.ping();
        this.osConnected = true;
      } catch (err) {
        console.warn('[Aiven OpenSearch] Cluster unavailable, running local fuzzy & faceted engine:', (err as Error).message);
        this.osConnected = false;
      }
    }

    return this.getStatus();
  }

  public getStatus(): InfrastructureStatus {
    const pgConfigured = Boolean(process.env.DATABASE_URL?.trim());
    const kafkaConfigured = Boolean(process.env.KAFKA_BROKERS?.trim());
    const osConfigured = Boolean(process.env.OPENSEARCH_NODE?.trim());
    const allLive = this.pgConnected && this.kafkaConnected && this.osConnected;

    return {
      mode: allLive ? 'AIVEN_LIVE' : 'DEMO_MODE',
      postgresql: {
        configured: pgConfigured,
        connected: this.pgConnected,
        label: this.pgConnected
          ? 'Aiven PostgreSQL Connected'
          : 'DEMO MODE · Local Transactional SQLite (WAL)',
      },
      kafka: {
        configured: kafkaConfigured,
        connected: this.kafkaConnected,
        label: this.kafkaConnected
          ? 'Aiven Apache Kafka Connected'
          : 'DEMO MODE · Transactional Outbox + Embedded Consumers',
      },
      opensearch: {
        configured: osConfigured,
        connected: this.osConnected,
        label: this.osConnected
          ? 'Aiven OpenSearch Connected'
          : 'DEMO MODE · Local Fuzzy & Faceted Index',
      },
    };
  }

  public async publishKafkaMessage(
    topic: string,
    key: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.kafkaConnected || !this.kafkaProducer) return false;
    try {
      await this.kafkaProducer.send({
        topic,
        messages: [{ key, value: JSON.stringify(payload) }],
      });
      return true;
    } catch (err) {
      console.warn(`[Aiven Kafka] Publish error on ${topic}:`, (err as Error).message);
      return false;
    }
  }

  public async indexOpenSearchDocument(
    productId: string,
    doc: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.osConnected || !this.osClient) return false;
    try {
      await this.osClient.index({
        index: 'storestream_products',
        id: productId,
        body: doc,
        refresh: true,
      });
      return true;
    } catch (err) {
      console.warn('[Aiven OpenSearch] Index sync warning:', (err as Error).message);
      return false;
    }
  }

  public getOpenSearchClient(): OpenSearchClient | null {
    return this.osConnected ? this.osClient : null;
  }

  public getPgPool(): pg.Pool | null {
    return this.pgConnected ? this.pgPool : null;
  }
}

export const aivenBridge = new AivenInfrastructureBridge();
