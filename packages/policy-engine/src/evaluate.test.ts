import { describe, expect, it } from "vitest";
import { evaluate, parseDuration, planUsage } from "./evaluate.js";
import { baselinePolicy, context, refund, usageFor } from "./test-support/fixtures.js";

const policy = baselinePolicy();

function decideRefund(amount: number, usage: Partial<Record<string, number>> = {}, extra = {}) {
  const ctx = context();
  const proposal = refund(amount, extra);
  return evaluate(policy, proposal, ctx, usageFor(policy, proposal, ctx, usage));
}

describe("refund thresholds", () => {
  it("P-01 allows a $15 refund for the case's customer", () => {
    const d = decideRefund(1500);
    expect(d.effect).toBe("allow");
    expect(d.reasons).toEqual([
      expect.objectContaining({ code: "POLICY_RULE_MATCHED", rule_id: "create_refund_request/base" }),
    ]);
  });

  it("P-02 allows exactly $25.00 (boundary is inclusive)", () => {
    expect(decideRefund(2500).effect).toBe("allow");
  });

  it("P-03 requires approval at $25.01", () => {
    const d = decideRefund(2501);
    expect(d.effect).toBe("approval_required");
    expect(d.reasons[0]).toMatchObject({
      code: "POLICY_THRESHOLD_EXCEEDED",
      rule_id: "create_refund_request/refund-over-auto-limit",
    });
  });

  it("P-04 requires approval for $299", () => {
    expect(decideRefund(29900).effect).toBe("approval_required");
  });

  it("denies refunds above the hard ceiling even though approval rules also match (deny overrides)", () => {
    const d = decideRefund(50001);
    expect(d.effect).toBe("deny");
    expect(d.matched_rules).toEqual(
      expect.arrayContaining([
        "create_refund_request/refund-over-auto-limit",
        "create_refund_request/refund-hard-ceiling",
      ]),
    );
  });
});

describe("blocked and unknown tools", () => {
  it.each(["export_customer_data", "delete_account"])("P-05 denies blocked tool %s", (tool) => {
    const d = evaluate(policy, { tool, args: {} }, context());
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_TOOL_NOT_ALLOWED");
    expect(d.matched_rules).toEqual([`blocked/${tool}`]);
  });

  it("P-06 denies a tool no rule mentions (default deny)", () => {
    const d = evaluate(policy, { tool: "issue_gift_card", args: { amount: 1 } }, context());
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_DEFAULT_DENY");
  });
});

describe("argument validation", () => {
  it.each([
    ["missing reason code", { reason_code: undefined }],
    ["invalid reason code", { reason_code: "because_i_said_so" }],
  ])("P-07 denies %s", (_label, extra) => {
    const d = decideRefund(1500, {}, extra);
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_PARAM_INVALID");
  });

  it.each([
    ["negative", -100],
    ["zero", 0],
    ["fractional", 15.5],
  ])("P-11 denies a %s amount", (_label, amount) => {
    const d = decideRefund(amount);
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_PARAM_INVALID");
  });

  it("denies an unlisted plan via arg_in", () => {
    const ctx = context();
    const proposal = {
      tool: "change_subscription_plan",
      args: {
        customer_id: "cus_1",
        subscription_id: "sub_1",
        target_plan: "free_forever",
        effective: "next_cycle",
      },
    };
    const d = evaluate(policy, proposal, ctx, usageFor(policy, proposal, ctx));
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]).toMatchObject({
      code: "POLICY_PARAM_INVALID",
      rule_id: "change_subscription_plan/known-plan",
    });
  });
});

describe("context binding", () => {
  it("P-08 denies a refund for a customer other than the case's", () => {
    const d = decideRefund(1500, {}, { customer_id: "cus_999" });
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]).toMatchObject({
      code: "POLICY_CONTEXT_MISMATCH",
      rule_id: "create_refund_request/customer-matches-case",
    });
  });

  it("P-12 denies a currency that differs from the subscription", () => {
    const d = decideRefund(1500, {}, { currency: "EUR" });
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.rule_id).toBe("create_refund_request/currency-matches-subscription");
  });

  it("reports every failed requirement, not just the first", () => {
    const d = decideRefund(1500, {}, { customer_id: "cus_999", currency: "EUR" });
    expect(d.reasons.map((r) => r.rule_id)).toEqual([
      "create_refund_request/customer-matches-case",
      "create_refund_request/currency-matches-subscription",
    ]);
  });

  it("fails closed when the context field is missing", () => {
    const ctx = context({ subscription: undefined });
    const proposal = refund(1500);
    const d = evaluate(policy, proposal, ctx, usageFor(policy, proposal, ctx));
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_CONTEXT_MISMATCH");
  });

  it("does not resolve prototype properties as context fields", () => {
    const ctx = context({ case: { id: "case_1", customer_id: "cus_1" } });
    const proposal = { tool: "get_customer", args: { customer_id: "toString" } };
    expect(evaluate(policy, proposal, ctx).effect).toBe("deny");
  });
});

describe("aggregate limits", () => {
  it("P-09 requires approval for a second $24 refund on the same case", () => {
    const d = decideRefund(2400, { "refund_amount_minor:case": 2400 });
    expect(d.effect).toBe("approval_required");
    expect(d.reasons[0]).toMatchObject({
      code: "POLICY_AGGREGATE_LIMIT",
      rule_id: "create_refund_request/case-refund-total",
    });
  });

  it("P-10 denies the 4th refund for a customer in 24h", () => {
    const d = decideRefund(500, { "refund_count:customer": 3 });
    expect(d.effect).toBe("deny");
    expect(d.reasons.map((r) => r.rule_id)).toContain("create_refund_request/customer-daily-refund-count");
  });

  it("allows the 3rd refund in 24h", () => {
    expect(decideRefund(500, { "refund_count:customer": 2 }).effect).toBe("allow");
  });

  it("plans one usage query per distinct aggregate", () => {
    const queries = planUsage(policy, refund(100), context());
    expect(queries.map((q) => q.key)).toEqual([
      "refund_amount_minor:case:case_1:2592000",
      "refund_count:customer:cus_1:86400",
    ]);
  });

  it("plans no usage for blocked or unknown tools", () => {
    expect(planUsage(policy, { tool: "delete_account", args: {} }, context())).toEqual([]);
    expect(planUsage(policy, { tool: "nope", args: {} }, context())).toEqual([]);
  });
});

describe("applicability", () => {
  it("denies agents the policy does not cover", () => {
    const d = evaluate(policy, refund(100), context({ agent_id: "marketing-bot" }));
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_DEFAULT_DENY");
  });
});

describe("fail closed", () => {
  it("P-16 denies when usage data is missing", () => {
    const d = evaluate(policy, refund(1500), context(), {});
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_EVALUATION_ERROR");
    expect(d.error).toMatch(/missing or invalid usage/);
  });

  it("P-16 denies when usage data is corrupt", () => {
    const ctx = context();
    const proposal = refund(1500);
    const usage = Object.fromEntries(planUsage(policy, proposal, ctx).map((q) => [q.key, Number.NaN]));
    expect(evaluate(policy, proposal, ctx, usage).effect).toBe("deny");
  });

  it("does not leak internal error detail into agent-facing reasons", () => {
    const d = evaluate(policy, refund(1500), context(), {});
    expect(d.reasons[0]?.message).not.toMatch(/usage/);
  });
});

describe("audit fields", () => {
  it("P-17 records policy id, version, checksum and matched rules", () => {
    const d = decideRefund(29900);
    expect(d.policy).toEqual({
      id: "support-agent-baseline",
      version: "1.0.0",
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    // A single $299 refund also pushes the case total over $25, so both rules are reported.
    expect(d.matched_rules).toEqual([
      "create_refund_request/base",
      "create_refund_request/refund-over-auto-limit",
      "create_refund_request/case-refund-total",
    ]);
  });

  it("is deterministic", () => {
    expect(decideRefund(29900)).toEqual(decideRefund(29900));
  });
});

describe("parseDuration", () => {
  it.each([
    ["30m", 1800],
    ["24h", 86400],
    ["7d", 604800],
  ])("parses %s", (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDuration("1w")).toThrow();
  });
});
