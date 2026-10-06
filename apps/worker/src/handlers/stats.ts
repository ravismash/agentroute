import type { EventEnvelope } from "@agentroute/contracts";
import type pg from "pg";
import type { EventHandler } from "../consumer.js";

interface Increment {
  tool: string;
  metric: string;
  value: number;
}

const TOOL = /^[a-z][a-z0-9_]{0,63}$/;

/** Map one event to counter increments. Pure, so it is unit-testable. */
export function incrementsFor(event: EventEnvelope): Increment[] {
  const p = event.payload;
  const tool = typeof p.tool === "string" && TOOL.test(p.tool) ? p.tool : undefined;
  if (!tool) return [];
  switch (event.type) {
    case "decision.made":
      return typeof p.effect === "string" ? [{ tool, metric: `decision_${p.effect}`, value: 1 }] : [];
    case "action.succeeded": {
      const out: Increment[] = [{ tool, metric: "executions_succeeded", value: 1 }];
      if (
        typeof p.amount_minor === "number" &&
        typeof p.currency === "string" &&
        /^[A-Z]{3}$/.test(p.currency)
      ) {
        out.push({ tool, metric: `amount_minor_${p.currency.toLowerCase()}`, value: p.amount_minor });
      }
      return out;
    }
    case "action.failed":
      return [{ tool, metric: "executions_failed", value: 1 }];
    default:
      return [];
  }
}

/**
 * Per-tenant daily counters (decisions by effect, executions, money moved),
 * the data behind an ops dashboard. Correct under redelivery because the
 * consumer runs it in the same transaction as the processed_events dedupe.
 */
export const statsHandler: EventHandler = {
  name: "stats",
  async handle(tx: pg.PoolClient, event: EventEnvelope): Promise<void> {
    for (const inc of incrementsFor(event)) {
      await tx.query(
        `INSERT INTO daily_action_stats (tenant_id, day, tool, metric, value)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, $3, $4, $5)
         ON CONFLICT (tenant_id, day, tool, metric)
         DO UPDATE SET value = daily_action_stats.value + EXCLUDED.value, updated_at = now()`,
        [event.tenant_id, event.occurred_at, inc.tool, inc.metric, inc.value],
      );
    }
  },
};
