/**
 * Black-box end-to-end test against a RUNNING stack (gateway + worker +
 * Postgres + Redis + Stripe test mode).
 *
 *   pnpm start & pnpm worker:start
 *   pnpm e2e
 *
 * Each run seeds a fresh tenant (customers, case, a $100 Stripe test payment,
 * operator, keys) directly in the database, then exercises the system only
 * through HTTP. Results are cross-checked against Stripe's API and the audit
 * trail. Exit code is non-zero if any check fails.
 */
import { randomUUID } from "node:crypto";
import { Database, issueApiKey, issueOperatorToken, type Queryable } from "@agentroute/db";
import Stripe from "stripe";
import { loadConfig } from "../config.js";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const WORKER = process.env.WORKER_URL ?? "http://localhost:8082";
const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!config.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY (test mode) is required for e2e");
const stripe = new Stripe(config.STRIPE_SECRET_KEY);
const db = new Database({ connectionString: config.DATABASE_URL, applicationName: "agentroute-e2e" });

// ─── tiny test runner ─────────────────────────────────────────────────────────

interface Result {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];
let section = "";

async function check(name: string, fn: () => Promise<string | undefined>): Promise<void> {
  const started = performance.now();
  try {
    const detail = (await fn()) ?? ""; // fn returns string | undefined
    results.push({ section, name, ok: true, detail, ms: performance.now() - started });
  } catch (err) {
    results.push({
      section,
      name,
      ok: false,
      detail: (err as Error).message,
      ms: performance.now() - started,
    });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Res {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Res> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined || options.raw !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    },
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, headers: response.headers, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── fixture: a fresh tenant per run ─────────────────────────────────────────

const run = Date.now().toString(36);
const T = `e2e_${run}`;
const T2 = `e2e_${run}_other`;

async function seed(q: Queryable) {
  await q.query("INSERT INTO tenants (id, name) VALUES ($1, 'E2E'), ($2, 'E2E other')", [T, T2]);
  await q.query(
    `INSERT INTO customers (tenant_id, id, display_name) VALUES
       ($1, 'cus_a', 'Alice'), ($1, 'cus_b', 'Bob'), ($2, 'cus_x', 'Xavier')`,
    [T, T2],
  );
  await q.query(
    `INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency) VALUES
       ($1, 'sub_a', 'cus_a', 'pro', 'USD'), ($1, 'sub_b', 'cus_b', 'starter', 'USD'),
       ($2, 'sub_x', 'cus_x', 'pro', 'USD')`,
    [T, T2],
  );
  await q.query(
    `INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES
       ($1, 'case_a', 'cus_a', 'sub_a', 'Charged twice'),
       ($1, 'case_a2', 'cus_a', 'sub_a', 'Annual refund'),
       ($1, 'case_b', 'cus_b', 'sub_b', 'Other customer'),
       ($2, 'case_x', 'cus_x', 'sub_x', 'Other tenant')`,
    [T, T2],
  );
  const intent = await stripe.paymentIntents.create({
    amount: 10_000,
    currency: "usd",
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    description: `AgentRoute e2e ${run}`,
  });
  await q.query(
    `INSERT INTO payments (tenant_id, id, customer_id, provider, provider_payment_id, amount_minor, currency)
     VALUES ($1, 'pay_a', 'cus_a', 'stripe', $2, 10000, 'USD')`,
    [T, intent.id],
  );
  const ops = await q.query<{ id: string; tenant_id: string }>(
    `INSERT INTO operators (tenant_id, email, display_name, role) VALUES
       ($1, $3, 'E2E Ops', 'operator'), ($2, $4, 'E2E Other Ops', 'operator')
     RETURNING id, tenant_id`,
    [T, T2, `ops+${run}@e2e.test`, `ops2+${run}@e2e.test`],
  );
  const opId = (tenant: string) => ops.rows.find((r) => r.tenant_id === tenant)?.id ?? "";
  return {
    paymentIntent: intent.id,
    key: await issueApiKey(q, T, "e2e"),
    otherKey: await issueApiKey(q, T2, "e2e"),
    operator: await issueOperatorToken(q, opId(T)),
    otherOperator: await issueOperatorToken(q, opId(T2)),
  };
}

// ─── the suite ───────────────────────────────────────────────────────────────

const f = await seed(db);
const propose = (body: Record<string, unknown>, opts: { key?: string; idem?: string } = {}) =>
  http("POST", "/v1/proposals", {
    token: opts.key ?? f.key,
    body,
    headers: { "idempotency-key": opts.idem ?? `e2e-${randomUUID()}` },
  });
const refund = (amount: number, extra: Record<string, unknown> = {}, caseId = "case_a") => ({
  agent_id: "supportops",
  case_id: caseId,
  tool: "create_refund_request",
  args: {
    customer_id: "cus_a",
    amount_minor: amount,
    currency: "USD",
    reason_code: "duplicate_charge",
    ...extra,
  },
});
const decide = (id: string, decision: "approve" | "reject", token = f.operator) =>
  http("POST", `/v1/approvals/${id}/${decision}`, { token, body: {} });

section = "health";
await check("gateway liveness and readiness", async () => {
  expect((await http("GET", "/healthz")).status === 200, "healthz");
  const ready = await http("GET", "/readyz");
  expect(ready.status === 200, `readyz ${ready.status}`);
});
await check("worker readiness and pipeline status", async () => {
  const r = await fetch(`${WORKER}/readyz`);
  expect(r.status === 200, `worker readyz ${r.status}`);
  const status = (await (await fetch(`${WORKER}/status`)).json()) as { groups: { name: string }[] };
  expect(
    status.groups.some((g) => g.name === "audit"),
    "audit consumer group missing",
  );
});

section = "authentication";
await check("missing, malformed and unknown keys → 401", async () => {
  for (const token of [undefined, "garbage", `ar_test_${"A".repeat(8)}_${"B".repeat(32)}`]) {
    const r = await http("POST", "/v1/proposals", {
      ...(token ? { token } : {}),
      body: refund(100),
      headers: { "idempotency-key": "k-12345678" },
    });
    expect(r.status === 401, `expected 401, got ${r.status}`);
    expect(r.headers.get("www-authenticate")?.includes("Bearer"), "missing WWW-Authenticate");
  }
});
await check("operator token rejected on agent API; tenant key rejected on operator API", async () => {
  expect(
    (await propose(refund(100), { key: f.operator })).status === 401,
    "operator token accepted by agent API",
  );
  expect(
    (await http("GET", "/v1/approvals", { token: f.key })).status === 401,
    "tenant key accepted by operator API",
  );
});

section = "validation";
await check("idempotency key required", async () => {
  const r = await http("POST", "/v1/proposals", { token: f.key, body: refund(100) });
  expect(
    r.status === 400 && r.body.code === "IDEMPOTENCY_KEY_REQUIRED",
    `got ${r.status} ${String(r.body.code)}`,
  );
});
await check("malformed JSON, schema violations, unsafe ids → 400 problem+json", async () => {
  const bad = await http("POST", "/v1/proposals", {
    token: f.key,
    raw: "{not json",
    headers: { "idempotency-key": "k-12345678" },
  });
  expect(bad.status === 400, `malformed JSON → ${bad.status}`);
  const schema = await propose({ agent_id: "supportops" });
  expect(schema.status === 400 && schema.body.code === "VALIDATION_FAILED", `schema → ${schema.status}`);
  const sqlish = await propose({ ...refund(100), case_id: "case_a'; DROP TABLE actions;--" });
  expect(sqlish.status === 400, `SQL-ish id → ${sqlish.status}`);
  expect(bad.headers.get("content-type")?.includes("application/problem+json"), "not problem+json");
});
await check("oversized body → 413", async () => {
  const r = await propose({ ...refund(100), args: { blob: "x".repeat(80_000) } });
  expect(r.status === 413, `got ${r.status}`);
});
await check("unknown route → 404 problem+json", async () => {
  const r = await http("GET", "/v1/does-not-exist");
  expect(r.status === 404 && r.body.code === "NOT_FOUND", `got ${r.status}`);
});

section = "policy decisions";
let firstRefundId = "";
await check("read tool allowed and returns data", async () => {
  const r = await propose({
    agent_id: "supportops",
    case_id: "case_a",
    tool: "get_customer",
    args: { customer_id: "cus_a" },
  });
  expect(r.status === 201 && r.body.state === "succeeded", `got ${r.status} ${String(r.body.state)}`);
  expect(
    (r.body.result as { display_name?: string } | undefined)?.display_name === "Alice",
    "missing result",
  );
});
await check("$15 refund → allowed and refunded in Stripe", async () => {
  const r = await propose(refund(1500));
  expect(
    r.body.effect === "allow" && r.body.state === "succeeded",
    `got ${String(r.body.effect)}/${String(r.body.state)}`,
  );
  firstRefundId = String(r.body.action_id);
  const view = await http("GET", `/v1/actions/${firstRefundId}`, { token: f.key });
  const ref = (view.body.execution as { provider_ref?: string } | null)?.provider_ref ?? "";
  const stripeRefund = await stripe.refunds.retrieve(ref);
  expect(
    stripeRefund.amount === 1500 && stripeRefund.metadata?.action_id === firstRefundId,
    "Stripe refund mismatch",
  );
  return `Stripe ${ref}`;
});
await check("second refund on the same case → approval (split-refund limit)", async () => {
  const r = await propose(refund(1500));
  expect(r.body.effect === "approval_required", `got ${String(r.body.effect)}`);
  const rules = (r.body.reasons as { rule_id?: string }[]).map((x) => x.rule_id);
  expect(rules.includes("create_refund_request/case-refund-total"), `rules ${rules.join(",")}`);
});
await check("refund to a different customer → denied (context binding)", async () => {
  const r = await propose(refund(500, { customer_id: "cus_b" }));
  expect(
    r.body.effect === "deny" && (r.body.reasons as { code: string }[])[0]?.code === "POLICY_CONTEXT_MISMATCH",
    "not denied",
  );
});
await check("blocked and unknown tools → denied", async () => {
  const blocked = await propose({
    agent_id: "supportops",
    case_id: "case_a",
    tool: "export_customer_data",
    args: {},
  });
  expect(blocked.body.effect === "deny", "blocked tool allowed");
  const unknown = await propose({
    agent_id: "supportops",
    case_id: "case_a",
    tool: "launch_rocket",
    args: {},
  });
  expect(unknown.body.effect === "deny", "unknown tool allowed");
});
await check("refund above the hard ceiling → denied", async () => {
  const r = await propose(refund(60_000, {}, "case_a2"));
  expect(r.body.effect === "deny", `got ${String(r.body.effect)}`);
});
await check("invalid arguments → denied with POLICY_PARAM_INVALID", async () => {
  const r = await propose(refund(-5));
  expect(
    r.body.effect === "deny" && (r.body.reasons as { code: string }[])[0]?.code === "POLICY_PARAM_INVALID",
    "not denied",
  );
});
await check("unknown agent → default deny, no policy", async () => {
  const r = await propose({ ...refund(100), agent_id: "rogue-bot" });
  expect(r.body.effect === "deny" && r.body.policy === null, "rogue agent not denied");
});

section = "tenant isolation";
await check("another tenant can't use this tenant's case or read its action", async () => {
  expect((await propose(refund(100), { key: f.otherKey })).status === 404, "cross-tenant case accepted");
  expect(
    (await http("GET", `/v1/actions/${firstRefundId}`, { token: f.otherKey })).status === 404,
    "cross-tenant read",
  );
});

section = "idempotency";
await check("same key + same body → replay; same key + different body → 409", async () => {
  const idem = `e2e-idem-${run}`;
  const a = await propose(
    { agent_id: "supportops", case_id: "case_a", tool: "get_subscription", args: { customer_id: "cus_a" } },
    { idem },
  );
  const b = await propose(
    { agent_id: "supportops", case_id: "case_a", tool: "get_subscription", args: { customer_id: "cus_a" } },
    { idem },
  );
  expect(a.status === 201 && b.status === 200 && a.body.action_id === b.body.action_id, "replay mismatch");
  const c = await propose(
    { agent_id: "supportops", case_id: "case_a", tool: "get_customer", args: { customer_id: "cus_a" } },
    { idem },
  );
  expect(c.status === 409 && c.body.code === "IDEMPOTENCY_CONFLICT", `got ${c.status}`);
});
await check("20 concurrent duplicates → one action", async () => {
  const idem = `e2e-race-${run}`;
  const rs = await Promise.all(
    Array.from({ length: 20 }, () =>
      propose(
        { agent_id: "supportops", case_id: "case_a", tool: "get_customer", args: { customer_id: "cus_a" } },
        { idem },
      ),
    ),
  );
  const ids = new Set(rs.map((r) => r.body.action_id));
  expect(ids.size === 1, `${ids.size} distinct actions`);
  expect(rs.filter((r) => r.status === 201).length === 1, "more than one 201");
});

section = "approvals";
let approvedId = "";
await check("$60 refund queued; operator sees it with reasons", async () => {
  const r = await propose(refund(6000, { reason_code: "cancellation" }, "case_a2"));
  expect(r.body.effect === "approval_required", `got ${String(r.body.effect)}`);
  approvedId = String(r.body.action_id);
  const q = await http("GET", "/v1/approvals?limit=100", { token: f.operator });
  const item = (q.body.items as { action_id: string; reasons: unknown[] }[]).find(
    (i) => i.action_id === approvedId,
  );
  expect(item && item.reasons.length > 0, "not in queue");
});
await check("other tenant's operator can't see or decide it", async () => {
  const q = await http("GET", "/v1/approvals?limit=100", { token: f.otherOperator });
  expect(
    !(q.body.items as { action_id: string }[]).some((i) => i.action_id === approvedId),
    "visible cross-tenant",
  );
  expect((await decide(approvedId, "approve", f.otherOperator)).status === 404, "decided cross-tenant");
});
await check("10 concurrent approvals → exactly one Stripe refund", async () => {
  const rs = await Promise.all(Array.from({ length: 10 }, () => decide(approvedId, "approve")));
  const ok = rs.filter((r) => r.status === 200).length;
  const conflicts = rs.filter((r) => r.status === 409).length;
  expect(ok === 1 && conflicts === 9, `200s=${ok} 409s=${conflicts}`);
  const refunds = await stripe.refunds.list({ payment_intent: f.paymentIntent, limit: 100 });
  const forAction = refunds.data.filter((x) => x.metadata?.action_id === approvedId);
  expect(
    forAction.length === 1 && forAction[0]?.amount === 6000,
    `${forAction.length} Stripe refunds for the action`,
  );
  return `1×200, 9×409, Stripe ${forAction[0].id}`;
});
await check("velocity rule: a customer's 4th refund in 24h is denied", async () => {
  // cus_a already has three counted refunds ($15 done, $15 pending, $60 done).
  const r = await propose(refund(2600, {}, "case_a2"));
  const rules = (r.body.reasons as { rule_id?: string }[]).map((x) => x.rule_id);
  expect(
    r.body.effect === "deny" && rules.includes("create_refund_request/customer-daily-refund-count"),
    `got ${String(r.body.effect)}`,
  );
});
await check("reject → no execution; deciding again → 409", async () => {
  const r = await propose(refund(7000, { reason_code: "goodwill", customer_id: "cus_b" }, "case_b"));
  expect(r.body.effect === "approval_required", `proposal → ${String(r.body.effect)}`);
  const rejected = await decide(String(r.body.action_id), "reject");
  expect(
    rejected.status === 200 && rejected.body.state === "rejected" && rejected.body.execution === null,
    "reject failed",
  );
  expect((await decide(String(r.body.action_id), "approve")).status === 409, "approved after reject");
});
await check("approval expiry: overdue approval → expired by the worker", async () => {
  const r = await propose(refund(2600, { customer_id: "cus_b" }, "case_b"));
  expect(r.body.effect === "approval_required", `proposal → ${String(r.body.effect)}`);
  const id = String(r.body.action_id);
  await db.query(
    "UPDATE approvals SET requested_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE action_id = $1",
    [id],
  );
  for (let i = 0; i < 40; i++) {
    const v = await http("GET", `/v1/actions/${id}`, { token: f.key });
    if (v.body.state === "expired") return "expired by worker maintenance";
    await sleep(250);
  }
  throw new Error("not expired within 10s (is the worker running?)");
});

section = "reply grounding";
await check("true claim allowed; false claim held for review", async () => {
  const reply = (body: string) =>
    propose({
      agent_id: "supportops",
      case_id: "case_a",
      tool: "draft_reply",
      args: { case_id: "case_a", body },
    });
  const good = await reply("I've refunded the duplicate $15 charge.");
  expect(good.body.effect === "allow", `true claim → ${String(good.body.effect)}`);
  const bad = await reply("Good news: your $90 refund has been processed!");
  expect(
    bad.body.effect === "approval_required" &&
      (bad.body.reasons as { code: string }[])[0]?.code === "POLICY_REPLY_NOT_GROUNDED",
    `false claim → ${String(bad.body.effect)}`,
  );
});

section = "kill switch";
await check("kill switch denies everything", async () => {
  await db.query("UPDATE tenants SET kill_switch = true WHERE id = $1", [T]);
  try {
    const r = await propose({
      agent_id: "supportops",
      case_id: "case_a",
      tool: "get_customer",
      args: { customer_id: "cus_a" },
    });
    expect(
      r.body.effect === "deny" && (r.body.reasons as { code: string }[])[0]?.code === "KILL_SWITCH_ACTIVE",
      "not denied",
    );
  } finally {
    await db.query("UPDATE tenants SET kill_switch = false WHERE id = $1", [T]);
  }
});

section = "approval UI";
await check("served with strict CSP; no path traversal", async () => {
  const ui = await fetch(`${GATEWAY}/ui/`);
  expect(
    ui.status === 200 && ui.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"),
    "CSP missing",
  );
  for (const path of ["/ui/../../.env", "/ui/%2e%2e/%2e%2e/.env", "/ui/..%2f..%2f.env"]) {
    const r = await fetch(`${GATEWAY}${path}`);
    const text = await r.text();
    expect(!text.includes("STRIPE_SECRET_KEY"), `traversal leaked via ${path}`);
  }
});

section = "money integrity";
await check("Stripe refunds match succeeded actions exactly (no duplicates)", async () => {
  const { rows } = await db.query<{ id: string; amount_minor: number }>(
    "SELECT id, amount_minor FROM actions WHERE tenant_id = $1 AND tool = 'create_refund_request' AND state = 'succeeded'",
    [T],
  );
  const refunds = await stripe.refunds.list({ payment_intent: f.paymentIntent, limit: 100 });
  const ours = refunds.data.filter((r) => typeof r.metadata?.action_id === "string");
  expect(ours.length === rows.length, `Stripe ${ours.length} refunds vs ${rows.length} succeeded actions`);
  for (const row of rows) {
    expect(
      ours.some((r) => r.metadata?.action_id === row.id && r.amount === row.amount_minor),
      `no Stripe refund for ${row.id}`,
    );
  }
  const ledger = await db.query<{ refunded_minor: number }>(
    "SELECT refunded_minor FROM payments WHERE tenant_id = $1",
    [T],
  );
  const total = rows.reduce((s, r) => s + r.amount_minor, 0);
  expect(
    ledger.rows[0]?.refunded_minor === total,
    `ledger ${String(ledger.rows[0]?.refunded_minor)} vs ${total}`,
  );
  return `${rows.length} refunds, $${(total / 100).toFixed(2)} total`;
});

section = "event pipeline";
await check("every outbox event reaches the audit log with its trace id", async () => {
  const count = async (sql: string) => (await db.query<{ n: number }>(sql, [T])).rows[0]?.n ?? 0;
  const outbox = await count("SELECT count(*) AS n FROM outbox WHERE tenant_id = $1");
  for (let i = 0; i < 40; i++) {
    const audit = await count("SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1");
    if (audit === outbox) {
      const missingTrace = await count(
        "SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND trace_id IS NULL AND event_type <> 'action.expired'",
      );
      expect(missingTrace === 0, `${missingTrace} audit rows without trace id`);
      const stats = await count("SELECT count(*) AS n FROM daily_action_stats WHERE tenant_id = $1");
      expect(stats > 0, "no stats rows");
      return `${outbox} events → ${audit} audit rows, ${stats} stats counters`;
    }
    await sleep(250);
  }
  throw new Error("audit log did not catch up within 10s");
});

// ─── report ──────────────────────────────────────────────────────────────────

let current = "";
for (const r of results) {
  if (r.section !== current) {
    current = r.section;
    console.log(`\n${current}`);
  }
  console.log(
    `  ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.ms.toFixed(0)} ms)${r.detail ? ` — ${r.detail}` : ""}`,
  );
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed · tenant ${T}`);
await db.close();
process.exitCode = failed ? 1 : 0;
