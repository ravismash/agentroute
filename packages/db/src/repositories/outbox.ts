import type { EventType } from "@agentroute/contracts";
import type { Queryable } from "../database.js";
import { uuidv7 } from "../ids.js";

export interface OutboxEvent {
  tenantId: string;
  actionId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  traceId?: string | undefined;
}

/**
 * Append events in the caller's transaction (transactional outbox): they are
 * committed if and only if the state change they describe is committed.
 */
export async function appendOutbox(q: Queryable, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const values: unknown[] = [];
  const rows = events.map((e, i) => {
    const o = i * 6;
    values.push(uuidv7(), e.tenantId, e.actionId, e.type, JSON.stringify(e.payload), e.traceId ?? null);
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
  });
  await q.query(
    `INSERT INTO outbox (event_id, tenant_id, action_id, event_type, payload, trace_id) VALUES ${rows.join(", ")}`,
    values,
  );
}
