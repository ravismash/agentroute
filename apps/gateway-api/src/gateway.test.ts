import { expireDueApprovals } from "@agentroute/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, refund, type Harness } from "./test-support/harness.js";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

async function outboxTypes(actionId: string): Promise<string[]> {
  const { rows } = await h.sql.query<{ event_type: string }>(
    "SELECT event_type FROM outbox WHERE action_id = $1 ORDER BY id",
    [actionId],
  );
  return rows.map((r) => r.event_type);
}

async function refundedMinor(paymentId: string): Promise<number> {
  const { rows } = await h.sql.query<{ refunded_minor: number }>(
    "SELECT refunded_minor FROM payments WHERE id = $1",
    [paymentId],
  );
  return rows[0]?.refunded_minor ?? -1;
}

async function executionStatus(actionId: string): Promise<string[]> {
  const { rows } = await h.sql.query<{ status: string }>(
    "SELECT status FROM executions WHERE action_id = $1 ORDER BY attempt",
    [actionId],
  );
  return rows.map((r) => r.status);
}

// ─── Demo scenario 1: auto-approved refund ──────────────────────────────────

describe("auto-allowed refund", () => {
  it("decides, executes once against Stripe, and records the full event trail", async () => {
    const res = await h.propose(refund(1500));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ effect: "allow", state: "succeeded" });
    expect(res.body.policy).toEqual({ id: "support-agent-baseline", version: "1.1.0" });

    expect(h.payments.createRefundCalls).toBe(1);
    const [stripeRefund] = [...h.payments.refunds.entries()];
    expect(stripeRefund?.[0]).toBe(`agentroute:${res.body.action_id}:1`);
    expect(stripeRefund?.[1]).toMatchObject({ paymentIntentId: "pi_test_ada", amountMinor: 1500 });
    expect(await refundedMinor("pay_ada")).toBe(1500);
    expect(await outboxTypes(res.body.action_id)).toEqual([
      "action.proposed",
      "decision.made",
      "action.executing",
      "action.succeeded",
    ]);
  });

  it("exposes status and execution details via GET /v1/actions/:id", async () => {
    const { body } = await h.propose(refund(1500));
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/actions/${body.action_id}`,
      headers: { authorization: `Bearer ${h.keys.acme}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: "succeeded",
      amount_minor: 1500,
      currency: "USD",
      execution: {
        status: "succeeded",
        attempt: 1,
        provider_ref: expect.stringMatching(/^re_fake_/) as unknown,
      },
    });
  });
});

// ─── Demo scenario 2: human approval ────────────────────────────────────────

describe("approval flow", () => {
  it("queues a $299 refund, shows it to the operator, and executes on approval", async () => {
    const proposed = await h.propose(refund(29900));
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ effect: "approval_required", state: "approval_required" });
    expect(h.payments.createRefundCalls).toBe(0);

    const queue = await h.app.inject({
      method: "GET",
      url: "/v1/approvals",
      headers: { authorization: `Bearer ${h.keys.acmeOperator}` },
    });
    expect(queue.statusCode).toBe(200);
    const items = queue.json<{ items: { action_id: string; reasons: { rule_id?: string }[] }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.action_id).toBe(proposed.body.action_id);
    expect(items[0]?.reasons.map((r) => r.rule_id)).toContain("create_refund_request/refund-over-auto-limit");

    const approved = await h.decide(proposed.body.action_id, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "succeeded", execution: { status: "succeeded" } });
    expect(h.payments.createRefundCalls).toBe(1);
    expect(await outboxTypes(proposed.body.action_id)).toEqual([
      "action.proposed",
      "decision.made",
      "approval.requested",
      "approval.decided",
      "action.executing",
      "action.succeeded",
    ]);
  });

  it("does not execute a rejected action", async () => {
    const { body } = await h.propose(refund(29900));
    const rejected = await h.decide(body.action_id, "reject");
    expect(rejected.body).toMatchObject({ state: "rejected", execution: null });
    expect(h.payments.createRefundCalls).toBe(0);
    expect((await h.decide(body.action_id, "approve")).status).toBe(409);
  });

  it("S-03: 10 concurrent approvals produce exactly one refund", async () => {
    const { body } = await h.propose(refund(29900));
    const results = await Promise.all(Array.from({ length: 10 }, () => h.decide(body.action_id, "approve")));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(h.payments.createRefundCalls).toBe(1);
    expect(await executionStatus(body.action_id)).toEqual(["succeeded"]);
    expect(await refundedMinor("pay_ada")).toBe(29900);
  });

  it("S-04: cannot approve after expiry; the sweeper marks it expired", async () => {
    const { body } = await h.propose(refund(29900));
    await h.sql.query(
      `UPDATE approvals SET requested_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE action_id = $1`,
      [body.action_id],
    );
    expect((await h.decide(body.action_id, "approve")).status).toBe(409);
    expect(await h.services.db.transaction((tx) => expireDueApprovals(tx, 10))).toBe(1);
    const view = await h.app.inject({
      method: "GET",
      url: `/v1/actions/${body.action_id}`,
      headers: { authorization: `Bearer ${h.keys.acme}` },
    });
    expect(view.json()).toMatchObject({ state: "expired" });
    expect(h.payments.createRefundCalls).toBe(0);
  });

  it("operators only see and decide their own tenant's approvals; admins see all", async () => {
    const { body } = await h.propose(refund(29900));
    expect((await h.decide(body.action_id, "approve", h.keys.globexOperator)).status).toBe(404);
    const globexQueue = await h.app.inject({
      method: "GET",
      url: "/v1/approvals",
      headers: { authorization: `Bearer ${h.keys.globexOperator}` },
    });
    expect(globexQueue.json<{ items: unknown[] }>().items).toEqual([]);
    expect((await h.decide(body.action_id, "approve", h.keys.admin)).status).toBe(200);
  });

  it("paginates the queue with a cursor", async () => {
    for (let i = 0; i < 3; i++) await h.propose(refund(29900 + i));
    const page = async (cursor?: string) =>
      (
        await h.app.inject({
          method: "GET",
          url: `/v1/approvals?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
          headers: { authorization: `Bearer ${h.keys.acmeOperator}` },
        })
      ).json<{ items: { action_id: string }[]; next_cursor: string | null }>();
    const first = await page();
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await page(first.next_cursor ?? undefined);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((i) => i.action_id));
    expect(ids.size).toBe(3);
  });
});

// ─── Demo scenario 3: attacks the policy must stop ─────────────────────────

describe("denials", () => {
  it("X-02: denies a refund redirected to another customer", async () => {
    const res = await h.propose(refund(1500, { customer_id: "cus_grace" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ effect: "deny", state: "denied" });
    expect(res.body.reasons[0]?.code).toBe("POLICY_CONTEXT_MISMATCH");
    expect(h.payments.createRefundCalls).toBe(0);
  });

  it("X-01: denies blocked tools and records the attempt", async () => {
    const res = await h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "export_customer_data",
      args: {},
    });
    expect(res.body).toMatchObject({ effect: "deny" });
    expect(res.body.reasons[0]?.code).toBe("POLICY_TOOL_NOT_ALLOWED");
    expect(await outboxTypes(res.body.action_id)).toEqual(["action.proposed", "decision.made"]);
  });

  it("X-03: split refunds on one case escalate once the total passes $25", async () => {
    expect((await h.propose(refund(2000))).body.effect).toBe("allow");
    const second = await h.propose(refund(2000));
    expect(second.body.effect).toBe("approval_required");
    expect(second.body.reasons.map((r) => r.rule_id)).toContain("create_refund_request/case-refund-total");
  });

  it("concurrent split refunds cannot both slip under the limit (usage lock)", async () => {
    const results = await Promise.all([h.propose(refund(2000)), h.propose(refund(2000))]);
    expect(results.map((r) => r.body.effect).sort()).toEqual(["allow", "approval_required"]);
    expect(h.payments.createRefundCalls).toBe(1);
  });

  it("denies everything while the tenant kill switch is on", async () => {
    await h.sql.query("UPDATE tenants SET kill_switch = true WHERE id = 'acme'");
    const res = await h.propose(refund(100));
    expect(res.body).toMatchObject({ effect: "deny" });
    expect(res.body.reasons[0]?.code).toBe("KILL_SWITCH_ACTIVE");
  });

  it("denies unknown agents by default", async () => {
    const res = await h.propose({ ...refund(100), agent_id: "rogue-bot" });
    expect(res.body).toMatchObject({ effect: "deny", policy: null });
  });

  it("returns 404 for a case that does not exist (or belongs to another tenant)", async () => {
    expect((await h.propose(refund(100, { case_id: "case_404" }))).status).toBe(404);
    expect((await h.propose(refund(100, { case_id: "case_9" }))).status).toBe(404);
  });
});

// ─── Reply grounding ─────────────────────────────────────────────────────────

describe("reply grounding", () => {
  const reply = (body: string) =>
    h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "draft_reply",
      args: { case_id: "case_1", body },
    });

  it("allows a reply whose claims match what happened on the case", async () => {
    await h.propose(refund(1500));
    const res = await reply("I've refunded the duplicate $15 charge.");
    expect(res.body).toMatchObject({ effect: "allow", state: "succeeded" });
  });

  it("holds a reply that claims a pending refund is done for human review", async () => {
    await h.propose(refund(29900));
    const res = await reply("Good news: your $299 has been refunded!");
    expect(res.body).toMatchObject({ effect: "approval_required" });
    expect(res.body.reasons[0]).toMatchObject({
      code: "POLICY_REPLY_NOT_GROUNDED",
      rule_id: "draft_reply/reply-grounded",
    });
  });

  it("does not count another case's refunds as evidence", async () => {
    await h.propose(refund(1500, { case_id: "case_2", customer_id: "cus_grace" }));
    const res = await reply("I've refunded $15.");
    expect(res.body.effect).toBe("approval_required");
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("S-08: replays the same result for a repeated request", async () => {
    const first = await h.propose(refund(1500), { idempotencyKey: "order-123-refund" });
    const second = await h.propose(refund(1500), { idempotencyKey: "order-123-refund" });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.action_id).toBe(first.body.action_id);
    expect(second.body.state).toBe("succeeded");
    expect(h.payments.createRefundCalls).toBe(1);
  });

  it("treats concurrent duplicates as one request", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.propose(refund(1500), { idempotencyKey: "same-key-race" })),
    );
    expect(new Set(results.map((r) => r.body.action_id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(h.payments.createRefundCalls).toBe(1);
  });

  it("rejects a reused key with a different request", async () => {
    await h.propose(refund(1500), { idempotencyKey: "order-456-refund" });
    const res = await h.propose(refund(2000), { idempotencyKey: "order-456-refund" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("requires an idempotency key", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { authorization: `Bearer ${h.keys.acme}` },
      payload: refund(1500),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });
});

// ─── Unknown outcomes and failures ──────────────────────────────────────────

describe("execution failures", () => {
  it("S-06: a timeout is recorded as unknown, never retried blindly, and reconciled", async () => {
    h.payments.nextBehaviours.push("timeout");
    const res = await h.propose(refund(1500));
    expect(res.body.state).toBe("executing");
    expect(await executionStatus(res.body.action_id)).toEqual(["unknown"]);

    // Retrying execution is refused while the outcome is unknown.
    expect(await h.services.execution.execute("acme", res.body.action_id)).toEqual({ state: "executing" });

    const resolved = await h.services.execution.reconcile({
      unknownOlderThanSeconds: 0,
      startedOlderThanSeconds: 3600,
      limit: 10,
    });
    expect(resolved).toBe(1);
    expect(await executionStatus(res.body.action_id)).toEqual(["succeeded"]);
    expect(h.payments.createRefundCalls).toBe(1);
    expect(await refundedMinor("pay_ada")).toBe(1500);
  });

  it("reconciles a timeout where the refund never happened, releasing the reservation", async () => {
    h.payments.nextBehaviours.push("timeout");
    h.payments.timeoutsStillRefund = false;
    const res = await h.propose(refund(1500));
    expect(await refundedMinor("pay_ada")).toBe(1500); // reserved while unknown
    await h.services.execution.reconcile({
      unknownOlderThanSeconds: 0,
      startedOlderThanSeconds: 3600,
      limit: 10,
    });
    expect(await executionStatus(res.body.action_id)).toEqual(["failed"]);
    expect(await refundedMinor("pay_ada")).toBe(0);
  });

  it("S-07: a provider decline fails the action and releases the reservation", async () => {
    h.payments.nextBehaviours.push("decline");
    const res = await h.propose(refund(1500));
    expect(res.body.state).toBe("failed");
    expect(await refundedMinor("pay_ada")).toBe(0);
    const view = await h.app.inject({
      method: "GET",
      url: `/v1/actions/${res.body.action_id}`,
      headers: { authorization: `Bearer ${h.keys.acme}` },
    });
    expect(view.json()).toMatchObject({
      execution: { status: "failed", error_code: "charge_already_refunded" },
    });
  });

  it("fails cleanly when no payment can cover the refund", async () => {
    const res = await h.propose(refund(1500, { case_id: "case_3", customer_id: "cus_nopay" }));
    expect(res.body.state).toBe("failed");
    expect(h.payments.createRefundCalls).toBe(0);
  });
});

// ─── Other tools ─────────────────────────────────────────────────────────────

describe("other tools", () => {
  it("returns read-tool results to the agent", async () => {
    const res = await h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "get_customer",
      args: { customer_id: "cus_ada" },
    });
    expect(res.body).toMatchObject({
      state: "succeeded",
      result: { id: "cus_ada", display_name: "Ada Lovelace" },
    });
  });

  it("applies an allowed plan change", async () => {
    const res = await h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "change_subscription_plan",
      args: {
        customer_id: "cus_ada",
        subscription_id: "sub_ada",
        target_plan: "business",
        effective: "next_cycle",
      },
    });
    expect(res.body.state).toBe("succeeded");
    const { rows } = await h.sql.query<{ plan: string }>(
      "SELECT plan FROM subscriptions WHERE id = 'sub_ada'",
    );
    expect(rows[0]?.plan).toBe("business");
  });
});

// ─── Authentication and isolation ────────────────────────────────────────────

describe("authentication and tenant isolation", () => {
  const post = (authorization?: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { ...(authorization ? { authorization } : {}), "idempotency-key": "auth-test-key" },
      payload: refund(100),
    });

  it.each([
    ["no credentials", undefined],
    ["a malformed key", "Bearer not-a-key"],
    ["a well-formed but unknown key", `Bearer ${["ar", "test", "A".repeat(8), "B".repeat(32)].join("_")}`],
  ])("X-06: rejects %s with 401", async (_label, authorization) => {
    const res = await post(authorization);
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("rejects an operator token on agent endpoints and a tenant key on operator endpoints", async () => {
    expect((await post(`Bearer ${h.keys.acmeOperator}`)).statusCode).toBe(401);
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/approvals",
      headers: { authorization: `Bearer ${h.keys.acme}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const prefix = h.keys.globex.slice(0, 16);
    await h.sql.query("UPDATE api_keys SET revoked_at = now() WHERE prefix = $1", [prefix]);
    try {
      expect((await post(`Bearer ${h.keys.globex}`)).statusCode).toBe(401);
    } finally {
      await h.sql.query("UPDATE api_keys SET revoked_at = NULL WHERE prefix = $1", [prefix]);
    }
  });

  it("X-07: a tenant cannot read another tenant's action", async () => {
    const { body } = await h.propose(refund(1500));
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/actions/${body.action_id}`,
      headers: { authorization: `Bearer ${h.keys.globex}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects malformed bodies with problem details", async () => {
    const res = await h.propose({ agent_id: "supportops", case_id: "case_1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

describe("approval UI", () => {
  it("is served with a strict content security policy", async () => {
    const res = await h.app.inject({ method: "GET", url: "/ui/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
