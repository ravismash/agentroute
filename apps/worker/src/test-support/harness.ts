import { randomBytes } from "node:crypto";
import { appendOutbox, Database, migrate, uuidv7, type OutboxEvent } from "@agentroute/db";
import { createLogger, type Logger } from "@agentroute/telemetry";
import pg from "pg";
import { inject } from "vitest";
import { StreamConsumer, type ConsumerOptions, type EventHandler } from "../consumer.js";
import { createRedis, type RedisClient } from "../redis.js";
import { OutboxRelay } from "../relay.js";

export const logger: Logger = createLogger({ service: "test", level: "silent" });

export interface WorkerHarness {
  db: Database;
  dbUrl: string;
  redis: RedisClient;
  stream: string;
  dlq: string;
  relay: (overrides?: Partial<{ batchSize: number; pollMs: number }>) => OutboxRelay;
  consumer: (handler: EventHandler, overrides?: Partial<ConsumerOptions>) => Promise<StreamConsumer>;
  /** Insert `n` outbox events for tenant "acme". */
  emit: (n: number, overrides?: Partial<OutboxEvent>) => Promise<void>;
  /** Run a consumer until no new or reclaimable messages remain. */
  drain: (consumer: StreamConsumer) => Promise<void>;
  count: (sql: string, values?: unknown[]) => Promise<number>;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<WorkerHarness> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `wk_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();

  const migrator = new pg.Client({ connectionString: dbUrl });
  await migrator.connect();
  await migrate(migrator);
  await migrator.query("INSERT INTO tenants (id, name) VALUES ('acme', 'Acme')");
  await migrator.end();

  const db = new Database({ connectionString: dbUrl, applicationName: "worker-test" });
  const redis = createRedis(inject("redisUrl"));
  await redis.connect();
  const clients: RedisClient[] = [redis];
  const prefix = `test:${name}`;
  const stream = `${prefix}:events`;
  const dlq = `${prefix}:dlq`;

  const count = async (sql: string, values: unknown[] = []) => {
    const { rows } = await db.query<{ n: number }>(sql, values);
    return rows[0]?.n ?? 0;
  };

  return {
    db,
    dbUrl,
    redis,
    stream,
    dlq,
    count,
    relay: (overrides = {}) =>
      new OutboxRelay(
        db,
        redis,
        { stream, batchSize: 50, pollMs: 60_000, maxLen: 10_000, ...overrides },
        logger,
      ),
    consumer: async (handler, overrides = {}) => {
      const connection = createRedis(inject("redisUrl"));
      await connection.connect();
      clients.push(connection);
      const consumer = new StreamConsumer(
        db,
        connection,
        handler,
        {
          stream,
          dlqStream: dlq,
          consumerName: `c-${randomBytes(3).toString("hex")}`,
          batchSize: 50,
          blockMs: 50,
          claimIdleMs: 0,
          maxDeliveries: 3,
          ...overrides,
        },
        logger,
      );
      await consumer.ensureGroup();
      return consumer;
    },
    emit: async (n, overrides = {}) => {
      await appendOutbox(
        db,
        Array.from({ length: n }, (_, i) => ({
          tenantId: "acme",
          actionId: uuidv7(),
          type: "decision.made" as const,
          payload: { tool: "create_refund_request", effect: "allow", seq: i },
          traceId: `trace-${i}`,
          ...overrides,
        })),
      );
    },
    drain: async (consumer) => {
      for (let i = 0; i < 20; i++) {
        const read = await consumer.pollOnce(10);
        const reclaimed = await consumer.reclaimOnce(0);
        if (read === 0 && reclaimed === 0) return;
      }
    },
    close: async () => {
      for (const c of clients) await c.quit().catch(() => undefined);
      await db.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
