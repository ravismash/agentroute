import type { ActionState, ActionView, DecisionEffect, DecisionReason } from "@agentroute/contracts";
import type { Queryable } from "../database.js";
import { appendOutbox } from "./outbox.js";

/** States whose actions count towards aggregate limits (pending and in-flight count: conservative). */
export const COUNTED_STATES: readonly ActionState[] = [
  "allowed",
  "approval_required",
  "approved",
  "executing",
  "succeeded",
  "failed",
];

/** Structural copy of the policy engine's UsageQuery (db does not depend on the engine). */
export interface UsageQuery {
  key: string;
  metric: "refund_amount_minor" | "refund_count" | "plan_change_count";
  scope: "case" | "customer" | "tenant";
  scope_id: string;
  window_seconds: number;
}

const METRIC_SQL: Record<UsageQuery["metric"], { tool: string; aggregate: string }> = {
  refund_amount_minor: { tool: "create_refund_request", aggregate: "COALESCE(SUM(amount_minor), 0)" },
  refund_count: { tool: "create_refund_request", aggregate: "COUNT(*)" },
  plan_change_count: { tool: "change_subscription_plan", aggregate: "COUNT(*)" },
};

/**
 * Serialise decisions that share usage counters. Must be called inside the
 * decision transaction, before reading usage. Locks are taken in a fixed
 * order (tenant, then customer) to avoid deadlocks.
 */
export async function lockUsageScope(
  q: Queryable,
  tenantId: string,
  customerId: string,
  queries: readonly UsageQuery[],
): Promise<void> {
  if (queries.length === 0) return;
  if (queries.some((u) => u.scope === "tenant")) {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`usage:${tenantId}`]);
  }
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`usage:${tenantId}:${customerId}`]);
}

export async function readUsage(
  q: Queryable,
  tenantId: string,
  customerId: string,
  queries: readonly UsageQuery[],
): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  for (const u of queries) {
    const { tool, aggregate } = METRIC_SQL[u.metric];
    const values: unknown[] = [tenantId, tool, u.window_seconds, COUNTED_STATES];
    let scopeFilter = "";
    if (u.scope === "case") {
      values.push(customerId, u.scope_id);
      scopeFilter = "AND customer_id = $5 AND case_id = $6";
    } else if (u.scope === "customer") {
      values.push(u.scope_id);
      scopeFilter = "AND customer_id = $5";
    }
    const { rows } = await q.query<{ value: number }>(
      `SELECT ${aggregate} AS value FROM actions
        WHERE tenant_id = $1 AND tool = $2
          AND created_at > now() - make_interval(secs => $3)
          AND state = ANY($4::text[]) ${scopeFilter}`,
      values,
    );
    usage[u.key] = rows[0]?.value ?? 0;
  }
  return usage;
}

export interface NewProposal {
  id: string;
  tenantId: string;
  caseId: string;
  customerId: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  amountMinor: number | null;
  currency: string | null;
  state: Extract<ActionState, "denied" | "allowed" | "approval_required">;
  idempotencyKey: string;
  requestHash: string;
  decision: {
    effect: DecisionEffect;
    reasons: DecisionReason[];
    matchedRules: string[];
    policy: { dbId: string; key: string; version: string; checksum: string } | null;
  };
  approvalTtlSeconds: number;
  traceId?: string | undefined;
}

/** Insert action + decision (+ approval) + outbox events. Call inside one transaction. */
export async function insertProposal(tx: Queryable, p: NewProposal): Promise<void> {
  await tx.query(
    `INSERT INTO actions (id, tenant_id, case_id, customer_id, agent_id, tool, args, amount_minor, currency,
                          state, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      p.id,
      p.tenantId,
      p.caseId,
      p.customerId,
      p.agentId,
      p.tool,
      JSON.stringify(p.args),
      p.amountMinor,
      p.currency,
      p.state,
      p.idempotencyKey,
      p.requestHash,
    ],
  );
  const pol = p.decision.policy;
  await tx.query(
    `INSERT INTO decisions (tenant_id, action_id, effect, reasons, matched_rules,
                            policy_id, policy_key, policy_version, policy_checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      p.tenantId,
      p.id,
      p.decision.effect,
      JSON.stringify(p.decision.reasons),
      p.decision.matchedRules,
      pol?.dbId ?? null,
      pol?.key ?? null,
      pol?.version ?? null,
      pol?.checksum ?? null,
    ],
  );
  if (p.state === "approval_required") {
    await tx.query(
      `INSERT INTO approvals (tenant_id, action_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [p.tenantId, p.id, p.approvalTtlSeconds],
    );
  }
  const summary = {
    tool: p.tool,
    agent_id: p.agentId,
    case_id: p.caseId,
    amount_minor: p.amountMinor,
    currency: p.currency,
  };
  await appendOutbox(tx, [
    { tenantId: p.tenantId, actionId: p.id, type: "action.proposed", payload: summary, traceId: p.traceId },
    {
      tenantId: p.tenantId,
      actionId: p.id,
      type: "decision.made",
      payload: {
        tool: p.tool,
        effect: p.decision.effect,
        state: p.state,
        reasons: p.decision.reasons,
        matched_rules: p.decision.matchedRules,
        policy: pol ? { key: pol.key, version: pol.version, checksum: pol.checksum } : null,
      },
      traceId: p.traceId,
    },
    ...(p.state === "approval_required"
      ? [
          {
            tenantId: p.tenantId,
            actionId: p.id,
            type: "approval.requested" as const,
            payload: summary,
            traceId: p.traceId,
          },
        ]
      : []),
  ]);
}

export interface StoredProposal {
  id: string;
  requestHash: string;
  state: ActionState;
  effect: DecisionEffect;
  reasons: DecisionReason[];
  policy: { id: string; version: string } | null;
}

export async function findByIdempotencyKey(
  q: Queryable,
  tenantId: string,
  idempotencyKey: string,
): Promise<StoredProposal | undefined> {
  const { rows } = await q.query<{
    id: string;
    request_hash: string;
    state: ActionState;
    effect: DecisionEffect;
    reasons: DecisionReason[];
    policy_key: string | null;
    policy_version: string | null;
  }>(
    `SELECT a.id, a.request_hash, a.state, d.effect, d.reasons, d.policy_key, d.policy_version
       FROM actions a JOIN decisions d ON d.tenant_id = a.tenant_id AND d.action_id = a.id
      WHERE a.tenant_id = $1 AND a.idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    requestHash: r.request_hash,
    state: r.state,
    effect: r.effect,
    reasons: r.reasons,
    policy: r.policy_key && r.policy_version ? { id: r.policy_key, version: r.policy_version } : null,
  };
}

export async function getActionState(q: Queryable, tenantId: string, actionId: string) {
  const { rows } = await q.query<{ state: ActionState }>(
    "SELECT state FROM actions WHERE tenant_id = $1 AND id = $2",
    [tenantId, actionId],
  );
  return rows[0]?.state;
}

export async function getActionView(
  q: Queryable,
  tenantId: string,
  actionId: string,
): Promise<ActionView | undefined> {
  const { rows } = await q.query<{
    id: string;
    case_id: string;
    tool: string;
    state: ActionState;
    effect: DecisionEffect;
    reasons: DecisionReason[];
    amount_minor: number | null;
    currency: string | null;
    created_at: Date;
    updated_at: Date;
    ex_status: "started" | "succeeded" | "failed" | "unknown" | null;
    ex_attempt: number | null;
    ex_ref: string | null;
    ex_error: string | null;
  }>(
    `SELECT a.id, a.case_id, a.tool, a.state, d.effect, d.reasons, a.amount_minor, a.currency,
            a.created_at, a.updated_at,
            e.status AS ex_status, e.attempt AS ex_attempt, e.provider_ref AS ex_ref, e.error_code AS ex_error
       FROM actions a
       JOIN decisions d ON d.tenant_id = a.tenant_id AND d.action_id = a.id
       LEFT JOIN LATERAL (
         SELECT status, attempt, provider_ref, error_code FROM executions
          WHERE tenant_id = a.tenant_id AND action_id = a.id ORDER BY attempt DESC LIMIT 1
       ) e ON true
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, actionId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    action_id: r.id,
    case_id: r.case_id,
    tool: r.tool,
    state: r.state,
    effect: r.effect,
    reasons: r.reasons,
    amount_minor: r.amount_minor,
    currency: r.currency,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    execution:
      r.ex_status && r.ex_attempt !== null
        ? { status: r.ex_status, attempt: r.ex_attempt, provider_ref: r.ex_ref, error_code: r.ex_error }
        : null,
  };
}

export interface EvidenceRow {
  tool: string;
  state: ActionState;
  amount_minor: number | null;
  currency: string | null;
  target_plan: string | null;
}

/**
 * What actually happened on a case in the last 30 days (replies excluded), used
 * to check that a reply's claims are grounded. Filters on the leading columns
 * of ix_actions_case.
 */
export async function loadCaseEvidence(
  q: Queryable,
  tenantId: string,
  customerId: string,
  caseId: string,
): Promise<EvidenceRow[]> {
  const { rows } = await q.query<EvidenceRow>(
    `SELECT tool, state, amount_minor, currency, args->>'target_plan' AS target_plan
       FROM actions
      WHERE tenant_id = $1 AND customer_id = $2 AND case_id = $3
        AND tool <> 'draft_reply' AND created_at > now() - interval '30 days'
      ORDER BY created_at`,
    [tenantId, customerId, caseId],
  );
  return rows;
}
