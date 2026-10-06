import type { Database } from "@agentroute/db";
import { toEnvelope, type RedisClient } from "./relay.js";

/**
 * Recovery operations. All are safe to repeat: consumers deduplicate by
 * event_id, so re-sending an already-processed event has no effect.
 */

export interface DeadLetterRow {
  id: number;
  consumer: string;
  stream_id: string;
  event_id: string | null;
  error: string;
  attempts: number;
  created_at: Date;
}

export async function listDeadLetters(db: Database, limit = 100): Promise<DeadLetterRow[]> {
  const { rows } = await db.query<DeadLetterRow>(
    `SELECT id, consumer, stream_id, event_id, error, attempts, created_at
       FROM dead_letters WHERE replayed_at IS NULL ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Re-publish dead-lettered events (after the bug that broke them is fixed).
 * Messages are re-sent from the outbox (the source of truth) when possible.
 */
export async function replayDeadLetters(
  db: Database,
  redis: RedisClient,
  stream: string,
  ids?: readonly number[],
): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; event_id: string | null; payload: unknown }>(
      `SELECT id, event_id, payload FROM dead_letters
        WHERE replayed_at IS NULL AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))
        ORDER BY id FOR UPDATE`,
      [ids ?? null],
    );
    let replayed = 0;
    for (const row of rows) {
      const outbox = row.event_id ? await outboxEnvelope(tx, row.event_id) : undefined;
      if (!outbox) continue; // Malformed messages have no outbox origin: fix the producer, not the message.
      await redis.xAdd(stream, "*", { envelope: outbox });
      await tx.query("UPDATE dead_letters SET replayed_at = now() WHERE id = $1", [row.id]);
      replayed++;
    }
    return replayed;
  });
}

/**
 * Re-publish outbox events from a point in time, e.g. after Redis lost data.
 * Postgres is the source of truth, so the stream can always be rebuilt.
 */
export async function replayOutbox(
  db: Database,
  redis: RedisClient,
  stream: string,
  since: Date,
): Promise<number> {
  let lastId = 0;
  let total = 0;
  for (;;) {
    const { rows } = await db.query<Parameters<typeof toEnvelope>[0]>(
      `SELECT id, event_id, tenant_id, action_id, event_type, payload, trace_id, occurred_at
         FROM outbox WHERE occurred_at >= $1 AND id > $2 ORDER BY id LIMIT 500`,
      [since, lastId],
    );
    if (rows.length === 0) return total;
    const pipeline = redis.multi();
    for (const row of rows) pipeline.xAdd(stream, "*", { envelope: JSON.stringify(toEnvelope(row)) });
    await pipeline.exec();
    total += rows.length;
    lastId = rows.at(-1)?.id ?? lastId;
  }
}

async function outboxEnvelope(
  tx: { query: Database["query"] },
  eventId: string,
): Promise<string | undefined> {
  const { rows } = await tx.query<Parameters<typeof toEnvelope>[0]>(
    `SELECT id, event_id, tenant_id, action_id, event_type, payload, trace_id, occurred_at
       FROM outbox WHERE event_id = $1`,
    [eventId],
  );
  const row = rows[0];
  return row ? JSON.stringify(toEnvelope(row)) : undefined;
}
