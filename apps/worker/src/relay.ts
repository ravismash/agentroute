import { EventEnvelope } from "@agentroute/contracts";
import type { Database } from "@agentroute/db";
import type { Logger } from "@agentroute/telemetry";
import pg from "pg";
import type { RedisClient } from "./redis.js";

export type { RedisClient } from "./redis.js";

export interface RelayOptions {
  stream: string;
  batchSize: number;
  pollMs: number;
  maxLen: number;
}

interface OutboxRow {
  id: number;
  event_id: string;
  tenant_id: string;
  action_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  trace_id: string | null;
  occurred_at: Date;
}

export function toEnvelope(row: OutboxRow): EventEnvelope {
  return EventEnvelope.parse({
    event_id: row.event_id,
    type: row.event_type,
    tenant_id: row.tenant_id,
    action_id: row.action_id,
    occurred_at: row.occurred_at.toISOString(),
    ...(row.trace_id ? { trace_id: row.trace_id } : {}),
    payload: row.payload,
  });
}

/**
 * Transactional-outbox relay: Postgres → Redis Streams.
 *
 * Each batch locks unpublished rows (FOR UPDATE SKIP LOCKED, so several relays
 * can run without double-publishing), XADDs them in one pipeline, then marks
 * them published in the same transaction. If the process dies after XADD but
 * before COMMIT, the rows are published again later: delivery is
 * at-least-once and consumers deduplicate by event_id.
 */
export class OutboxRelay {
  private running = false;
  private wake: (() => void) | undefined;
  private listener: pg.Client | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    private readonly redis: RedisClient,
    private readonly options: RelayOptions,
    private readonly log: Logger,
  ) {}

  /** Publish one batch. Returns the number of events published. */
  async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, event_id, tenant_id, action_id, event_type, payload, trace_id, occurred_at
           FROM outbox WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize],
      );
      if (rows.length === 0) return 0;
      const pipeline = this.redis.multi();
      for (const row of rows) {
        pipeline.xAdd(
          this.options.stream,
          "*",
          { envelope: JSON.stringify(toEnvelope(row)) },
          { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.options.maxLen } },
        );
      }
      await pipeline.exec();
      await tx.query(
        "UPDATE outbox SET published_at = now(), publish_attempts = publish_attempts + 1 WHERE id = ANY($1::bigint[])",
        [rows.map((r) => r.id)],
      );
      return rows.length;
    });
  }

  /** Publish until the outbox is empty. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.publishBatch();
      total += n;
      if (n < this.options.batchSize) return total;
    }
  }

  /**
   * Run continuously: woken by Postgres NOTIFY on insert, with polling as the
   * fallback (NOTIFY is best-effort and lost while disconnected).
   */
  async start(connectionString: string): Promise<void> {
    this.running = true;
    this.listener = new pg.Client({ connectionString, application_name: "agentroute-relay-listener" });
    this.listener.on("notification", () => this.wake?.());
    this.listener.on("error", (err) => {
      this.log.warn({ err }, "relay listener error; falling back to polling");
    });
    await this.listener.connect();
    await this.listener.query("LISTEN agentroute_outbox");

    this.loop = (async () => {
      while (this.running) {
        try {
          const published = await this.drain();
          if (published > 0) this.log.debug({ published }, "outbox relayed");
        } catch (err) {
          this.log.error({ err }, "outbox relay failed; will retry");
        }
        await new Promise<void>((resolve) => {
          // Close the race with stop(): if stop() flipped `running` and fired
          // the previous (already-settled) wake before this executor installed
          // the new one, resolve now instead of sleeping a full poll interval.
          if (!this.running) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, this.options.pollMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    await this.listener?.end().catch(() => undefined);
  }
}
