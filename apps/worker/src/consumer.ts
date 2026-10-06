import { EventEnvelope } from "@agentroute/contracts";
import type { Database } from "@agentroute/db";
import type { Logger } from "@agentroute/telemetry";
import type pg from "pg";
import type { RedisClient } from "./relay.js";

/** A consumer's business logic. Runs inside a transaction that also records the event as processed. */
export interface EventHandler {
  /** Consumer-group name; also the dedupe namespace in processed_events. */
  readonly name: string;
  handle(tx: pg.PoolClient, event: EventEnvelope): Promise<void>;
}

export interface ConsumerOptions {
  stream: string;
  dlqStream: string;
  consumerName: string;
  batchSize: number;
  blockMs: number;
  claimIdleMs: number;
  maxDeliveries: number;
}

type Fields = Record<string, string>;
export type Outcome = "processed" | "duplicate" | "failed" | "dead_lettered";

/**
 * Redis Streams consumer-group runner with an *effectively-once* effect:
 *
 * - The handler and an insert into processed_events(consumer, event_id) run in
 *   one Postgres transaction: a duplicate delivery finds the row already there
 *   and is skipped, so redelivery never applies an effect twice.
 * - Messages are acknowledged only after that transaction commits. A crash
 *   leaves them pending; another consumer reclaims them with XAUTOCLAIM once
 *   idle for `claimIdleMs`.
 * - After `maxDeliveries` attempts (or immediately, for malformed messages) a
 *   message is dead-lettered: stored in Postgres, copied to the DLQ stream,
 *   and acknowledged, so one poison message can't block the group.
 */
export class StreamConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly lastErrors = new Map<string, string>();

  constructor(
    private readonly db: Database,
    /** Must be a dedicated connection: XREADGROUP BLOCK holds it. */
    private readonly redis: RedisClient,
    private readonly handler: EventHandler,
    private readonly options: ConsumerOptions,
    private readonly log: Logger,
  ) {}

  /** Read through a getter so the loop sees stop() (TS would narrow the field). */
  private get active(): boolean {
    return this.running;
  }

  get group(): string {
    return this.handler.name;
  }

  async ensureGroup(): Promise<void> {
    try {
      // Start from the beginning of the stream so a new group sees retained history.
      await this.redis.xGroupCreate(this.options.stream, this.group, "0", { MKSTREAM: true });
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
  }

  /** Read and process new messages once. Returns how many were read. */
  async pollOnce(blockMs = this.options.blockMs): Promise<number> {
    const reply = await this.redis.xReadGroup(
      this.group,
      this.options.consumerName,
      { key: this.options.stream, id: ">" },
      { COUNT: this.options.batchSize, BLOCK: blockMs },
    );
    const raw: unknown = reply;
    const streams = (Array.isArray(raw) ? raw : []) as { messages: { id: string; message: Fields }[] }[];
    const messages = streams.flatMap((s) => s.messages);
    for (const m of messages) await this.process(m.id, m.message);
    return messages.length;
  }

  /** Take over messages left pending by crashed consumers (or our own failures). */
  async reclaimOnce(minIdleMs = this.options.claimIdleMs): Promise<number> {
    const claimed = await this.redis.xAutoClaim(
      this.options.stream,
      this.group,
      this.options.consumerName,
      minIdleMs,
      "0-0",
      { COUNT: this.options.batchSize },
    );
    let n = 0;
    for (const m of claimed.messages) {
      if (!m) continue;
      n++;
      const [pending] = await this.redis.xPendingRange(this.options.stream, this.group, m.id, m.id, 1);
      const deliveries = pending?.deliveriesCounter ?? 1;
      if (deliveries > this.options.maxDeliveries) {
        await this.deadLetter(
          m.id,
          m.message,
          this.lastErrors.get(m.id) ?? "max deliveries exceeded",
          deliveries,
        );
      } else {
        await this.process(m.id, m.message);
      }
    }
    return n;
  }

  /** Process one message. Exposed for tests. */
  async process(id: string, fields: Fields): Promise<Outcome> {
    let event: EventEnvelope;
    try {
      event = EventEnvelope.parse(JSON.parse(fields.envelope ?? ""));
    } catch (err) {
      // Malformed messages can never succeed: dead-letter immediately.
      await this.deadLetter(id, fields, `malformed envelope: ${(err as Error).message}`, 1);
      return "dead_lettered";
    }
    try {
      const applied = await this.db.transaction(async (tx) => {
        const { rowCount } = await tx.query(
          "INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [this.group, event.event_id],
        );
        if (rowCount === 0) return false;
        await this.handler.handle(tx, event);
        return true;
      });
      await this.redis.xAck(this.options.stream, this.group, id);
      this.lastErrors.delete(id);
      return applied ? "processed" : "duplicate";
    } catch (err) {
      // Left unacknowledged: retried after claimIdleMs, dead-lettered after maxDeliveries.
      this.lastErrors.set(id, (err as Error).message);
      this.log.warn(
        { err, consumer: this.group, stream_id: id, event_id: event.event_id, trace_id: event.trace_id },
        "event handling failed",
      );
      return "failed";
    }
  }

  private async deadLetter(id: string, fields: Fields, error: string, attempts: number): Promise<void> {
    let eventId: string | null = null;
    let payload: unknown = fields;
    try {
      const parsed = JSON.parse(fields.envelope ?? "") as { event_id?: unknown };
      payload = parsed;
      if (typeof parsed.event_id === "string" && /^[0-9a-f-]{36}$/.test(parsed.event_id))
        eventId = parsed.event_id;
    } catch {
      /* keep raw fields */
    }
    await this.db.query(
      `INSERT INTO dead_letters (consumer, stream_id, event_id, payload, error, attempts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.group, id, eventId, JSON.stringify(payload), error.slice(0, 4000), Math.max(1, attempts)],
    );
    await this.redis.xAdd(this.options.dlqStream, "*", {
      consumer: this.group,
      stream_id: id,
      error: error.slice(0, 500),
      ...(fields.envelope ? { envelope: fields.envelope } : {}),
    });
    await this.redis.xAck(this.options.stream, this.group, id);
    this.lastErrors.delete(id);
    this.log.error({ consumer: this.group, stream_id: id, event_id: eventId, error }, "event dead-lettered");
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    let lastReclaim = 0;
    this.loop = (async () => {
      while (this.running) {
        try {
          if (Date.now() - lastReclaim >= this.options.claimIdleMs / 2) {
            lastReclaim = Date.now();
            await this.reclaimOnce();
          }
          await this.pollOnce();
        } catch (err) {
          if (this.active) {
            this.log.error({ err, consumer: this.group }, "consumer loop error");
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
