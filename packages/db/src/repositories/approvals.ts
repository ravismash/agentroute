import type { ApprovalItem, ApprovalStatus, DecisionReason } from "@agentroute/contracts";
import type { Queryable } from "../database.js";
import { appendOutbox } from "./outbox.js";

/** null = platform admin (all tenants). */
export type TenantScope = string | null;

interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    return typeof c.t === "string" && typeof c.id === "string" ? { t: c.t, id: c.id } : undefined;
  } catch {
    return undefined;
  }
}

/** Oldest-first approval queue with keyset (cursor) pagination. */
export async function listPendingApprovals(
  q: Queryable,
  scope: TenantScope,
  options: { limit: number; cursor?: string | undefined },
): Promise<{ items: ApprovalItem[]; next_cursor: string | null }> {
  const cursor = decodeCursor(options.cursor);
  const { rows } = await q.query<{
    action_id: string;
    tenant_id: string;
    case_id: string;
    customer_id: string;
    agent_id: string;
    tool: string;
    args: Record<string, unknown>;
    amount_minor: number | null;
    currency: string | null;
    status: ApprovalStatus;
    reasons: DecisionReason[];
    matched_rules: string[];
    requested_at: Date;
    expires_at: Date;
    cursor_ts: string;
  }>(
    // cursor_ts keeps Postgres' microsecond precision; a JS Date would truncate to
    // milliseconds and make the keyset comparison repeat rows across pages.
    `SELECT to_char(ap.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
            ap.action_id, ap.tenant_id, a.case_id, a.customer_id, a.agent_id, a.tool, a.args,
            a.amount_minor, a.currency, ap.status, d.reasons, d.matched_rules, ap.requested_at, ap.expires_at
       FROM approvals ap
       JOIN actions a ON a.tenant_id = ap.tenant_id AND a.id = ap.action_id
       JOIN decisions d ON d.tenant_id = ap.tenant_id AND d.action_id = ap.action_id
      WHERE ap.status = 'pending' AND ap.expires_at > now()
        AND ($1::text IS NULL OR ap.tenant_id = $1)
        AND ($2::timestamptz IS NULL OR (ap.requested_at, ap.action_id) > ($2::timestamptz, $3::uuid))
      ORDER BY ap.requested_at, ap.action_id
      LIMIT $4`,
    [scope, cursor?.t ?? null, cursor?.id ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ cursor_ts: _cursor, ...r }) => ({
      ...r,
      requested_at: r.requested_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
    })),
    next_cursor:
      rows.length > options.limit && last ? encodeCursor({ t: last.cursor_ts, id: last.action_id }) : null,
  };
}

export type ApprovalDecisionResult =
  | { outcome: "decided"; tenantId: string }
  | { outcome: "not_found" }
  | { outcome: "conflict"; status: ApprovalStatus | "expired" };

/**
 * Approve or reject atomically. The conditional UPDATE is the concurrency
 * control: of N simultaneous decisions exactly one sees status = 'pending'.
 */
export async function decideApproval(
  tx: Queryable,
  input: {
    scope: TenantScope;
    actionId: string;
    operatorId: string;
    decision: "approved" | "rejected";
    note?: string | undefined;
    traceId?: string | undefined;
  },
): Promise<ApprovalDecisionResult> {
  const { rows } = await tx.query<{ tenant_id: string }>(
    `UPDATE approvals
        SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE action_id = $1 AND ($2::text IS NULL OR tenant_id = $2)
        AND status = 'pending' AND expires_at > now()
      RETURNING tenant_id`,
    [input.actionId, input.scope, input.decision, input.operatorId, input.note ?? null],
  );
  const decided = rows[0];
  if (!decided) {
    const existing = await tx.query<{ status: ApprovalStatus; expired: boolean }>(
      `SELECT status, expires_at <= now() AS expired FROM approvals
        WHERE action_id = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
      [input.actionId, input.scope],
    );
    const row = existing.rows[0];
    if (!row) return { outcome: "not_found" };
    return { outcome: "conflict", status: row.status === "pending" && row.expired ? "expired" : row.status };
  }

  const { rowCount } = await tx.query(
    "UPDATE actions SET state = $3 WHERE tenant_id = $1 AND id = $2 AND state = 'approval_required'",
    [decided.tenant_id, input.actionId, input.decision],
  );
  if (rowCount !== 1) throw new Error(`action ${input.actionId} was not awaiting approval`);

  await appendOutbox(tx, [
    {
      tenantId: decided.tenant_id,
      actionId: input.actionId,
      type: "approval.decided",
      payload: { decision: input.decision, operator_id: input.operatorId },
      traceId: input.traceId,
    },
  ]);
  return { outcome: "decided", tenantId: decided.tenant_id };
}

/** Expire overdue approvals in batches. Safe to run on several instances (SKIP LOCKED). */
export async function expireDueApprovals(tx: Queryable, batchSize: number): Promise<number> {
  const { rows } = await tx.query<{ tenant_id: string; action_id: string }>(
    `WITH due AS (
       SELECT tenant_id, action_id FROM approvals
        WHERE status = 'pending' AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED)
     UPDATE approvals ap SET status = 'expired', decided_at = now()
       FROM due WHERE ap.tenant_id = due.tenant_id AND ap.action_id = due.action_id
     RETURNING ap.tenant_id, ap.action_id`,
    [batchSize],
  );
  if (rows.length === 0) return 0;
  await tx.query(
    "UPDATE actions SET state = 'expired' WHERE id = ANY($1::uuid[]) AND state = 'approval_required'",
    [rows.map((r) => r.action_id)],
  );
  await appendOutbox(
    tx,
    rows.map((r) => ({ tenantId: r.tenant_id, actionId: r.action_id, type: "action.expired", payload: {} })),
  );
  return rows.length;
}
