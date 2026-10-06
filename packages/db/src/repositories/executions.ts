import type { ActionState } from "@agentroute/contracts";
import type { Queryable } from "../database.js";
import { appendOutbox } from "./outbox.js";

export interface ExecutableAction {
  id: string;
  tenantId: string;
  caseId: string;
  customerId: string;
  tool: string;
  args: Record<string, unknown>;
  amountMinor: number | null;
  currency: string | null;
  state: ActionState;
}

const EXECUTABLE: readonly ActionState[] = ["allowed", "approved", "failed"];

/** Lock the action row for the rest of the transaction. */
export async function lockAction(
  tx: Queryable,
  tenantId: string,
  actionId: string,
): Promise<ExecutableAction | undefined> {
  const { rows } = await tx.query<{
    id: string;
    tenant_id: string;
    case_id: string;
    customer_id: string;
    tool: string;
    args: Record<string, unknown>;
    amount_minor: number | null;
    currency: string | null;
    state: ActionState;
  }>(
    `SELECT id, tenant_id, case_id, customer_id, tool, args, amount_minor, currency, state
       FROM actions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, actionId],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        tenantId: r.tenant_id,
        caseId: r.case_id,
        customerId: r.customer_id,
        tool: r.tool,
        args: r.args,
        amountMinor: r.amount_minor,
        currency: r.currency,
        state: r.state,
      }
    : undefined;
}

export function isExecutable(state: ActionState): boolean {
  return EXECUTABLE.includes(state);
}

/** Start an attempt: action → executing, execution row 'started'. Call with the action locked. */
export async function beginExecution(
  tx: Queryable,
  input: {
    action: ExecutableAction;
    provider: "stripe" | "mock_crm";
    providerTarget: string | null;
    traceId?: string | undefined;
  },
): Promise<{ executionId: string; attempt: number; idempotencyKey: string }> {
  const { action } = input;
  // One provider idempotency key per attempt: a retry after a *definite* failure must
  // not replay the cached failure, while an unknown outcome is reconciled, never retried.
  const { rows } = await tx.query<{ id: string; attempt: number; provider_idempotency_key: string }>(
    `INSERT INTO executions (tenant_id, action_id, attempt, provider, provider_idempotency_key, provider_target)
     SELECT $1, $2::uuid, n, $3, 'agentroute:' || $2 || ':' || n, $4
       FROM (SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM executions WHERE action_id = $2::uuid) next
     RETURNING id, attempt, provider_idempotency_key`,
    [action.tenantId, action.id, input.provider, input.providerTarget],
  );
  const row = rows[0];
  if (!row) throw new Error("failed to create execution");
  await transition(tx, action.tenantId, action.id, action.state, "executing");
  await appendOutbox(tx, [
    {
      tenantId: action.tenantId,
      actionId: action.id,
      type: "action.executing",
      payload: { attempt: row.attempt, provider: input.provider },
      traceId: input.traceId,
    },
  ]);
  return { executionId: row.id, attempt: row.attempt, idempotencyKey: row.provider_idempotency_key };
}

export type ExecutionOutcome =
  | { status: "succeeded"; providerRef: string }
  | { status: "failed"; code: string; message: string }
  | { status: "unknown"; message: string };

/**
 * Record an attempt's outcome. `succeeded`/`failed` finish the action;
 * `unknown` leaves it `executing` until reconciliation resolves it.
 */
export async function finishExecution(
  tx: Queryable,
  input: {
    tenantId: string;
    actionId: string;
    executionId: string;
    from: "started" | "unknown";
    outcome: ExecutionOutcome;
    traceId?: string | undefined;
  },
): Promise<void> {
  const o = input.outcome;
  const { rowCount } = await tx.query(
    `UPDATE executions
        SET status = $3, provider_ref = $4, error_code = $5, error_message = $6, finished_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = $7`,
    [
      input.executionId,
      input.tenantId,
      o.status,
      o.status === "succeeded" ? o.providerRef : null,
      o.status === "failed" ? o.code : o.status === "unknown" ? "OUTCOME_UNKNOWN" : null,
      o.status === "succeeded" ? null : o.message.slice(0, 2000),
      input.from,
    ],
  );
  if (rowCount !== 1) throw new Error(`execution ${input.executionId} is not in state ${input.from}`);
  if (o.status === "unknown") return;

  await transition(tx, input.tenantId, input.actionId, "executing", o.status);
  await appendOutbox(tx, [
    {
      tenantId: input.tenantId,
      actionId: input.actionId,
      type: o.status === "succeeded" ? "action.succeeded" : "action.failed",
      payload: o.status === "succeeded" ? { provider_ref: o.providerRef } : { error_code: o.code },
      traceId: input.traceId,
    },
  ]);
}

export interface UnresolvedExecution {
  executionId: string;
  status: "started" | "unknown";
  tenantId: string;
  actionId: string;
  provider: "stripe" | "mock_crm";
  providerIdempotencyKey: string;
  providerTarget: string | null;
  amountMinor: number | null;
}

/**
 * Attempts needing reconciliation: outcome `unknown`, or stuck in `started`
 * (process died between the provider call and recording the result).
 */
export async function findUnresolvedExecutions(
  q: Queryable,
  options: { unknownOlderThanSeconds: number; startedOlderThanSeconds: number; limit: number },
): Promise<UnresolvedExecution[]> {
  const { rows } = await q.query<{
    id: string;
    status: "started" | "unknown";
    tenant_id: string;
    action_id: string;
    provider: "stripe" | "mock_crm";
    provider_idempotency_key: string;
    provider_target: string | null;
    amount_minor: number | null;
  }>(
    `SELECT e.id, e.status, e.tenant_id, e.action_id, e.provider, e.provider_idempotency_key,
            e.provider_target, a.amount_minor
       FROM executions e JOIN actions a ON a.tenant_id = e.tenant_id AND a.id = e.action_id
      WHERE (e.status = 'unknown' AND e.finished_at < now() - make_interval(secs => $1))
         OR (e.status = 'started' AND e.started_at < now() - make_interval(secs => $2))
      ORDER BY e.started_at
      LIMIT $3`,
    [options.unknownOlderThanSeconds, options.startedOlderThanSeconds, options.limit],
  );
  return rows.map((r) => ({
    executionId: r.id,
    status: r.status,
    tenantId: r.tenant_id,
    actionId: r.action_id,
    provider: r.provider,
    providerIdempotencyKey: r.provider_idempotency_key,
    providerTarget: r.provider_target,
    amountMinor: r.amount_minor,
  }));
}

async function transition(
  tx: Queryable,
  tenantId: string,
  actionId: string,
  from: ActionState,
  to: ActionState,
): Promise<void> {
  const { rowCount } = await tx.query(
    "UPDATE actions SET state = $4 WHERE tenant_id = $1 AND id = $2 AND state = $3",
    [tenantId, actionId, from, to],
  );
  if (rowCount !== 1) throw new Error(`action ${actionId} is not in state ${from}`);
}
