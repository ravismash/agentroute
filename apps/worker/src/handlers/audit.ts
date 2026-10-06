import type { EventEnvelope } from "@agentroute/contracts";
import { redactDeep } from "@agentroute/telemetry";
import type pg from "pg";
import type { EventHandler } from "../consumer.js";

/**
 * Writes every event to the append-only audit_log. Payloads are PII-redacted
 * before storage; the audit trail keeps decisions and reasons, not card numbers.
 */
export const auditHandler: EventHandler = {
  name: "audit",
  async handle(tx: pg.PoolClient, event: EventEnvelope): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log (event_id, tenant_id, action_id, event_type, payload, occurred_at, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        event.tenant_id,
        event.action_id,
        event.type,
        JSON.stringify(redactDeep(event.payload)),
        event.occurred_at,
        event.trace_id ?? null,
      ],
    );
  },
};
