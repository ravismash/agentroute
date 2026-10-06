import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { baselinePolicy, context, refund, usageFor } from "./test-support/fixtures.js";

const policy = baselinePolicy();
const ctx = context();

function decide(amount: number, usage: Partial<Record<string, number>> = {}, extra = {}) {
  const proposal = refund(amount, extra);
  return evaluate(policy, proposal, ctx, usageFor(policy, proposal, ctx, usage)).effect;
}

describe("P-18 policy invariants", () => {
  it("a valid refund at or below $25 with no prior usage is always allowed", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2500 }), (amount) => decide(amount) === "allow"));
  });

  it("a refund above $25 is never auto-allowed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2501, max: 100_000_000 }), (amount) => decide(amount) !== "allow"),
    );
  });

  it("split refunds on one case can never exceed $25 in total without approval", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 2500 }),
        (prior, amount) => {
          const effect = decide(amount, { "refund_amount_minor:case": prior });
          return prior + amount <= 2500 ? effect === "allow" : effect !== "allow";
        },
      ),
    );
  });

  it("a refund for any other customer is always denied", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_]{1,20}$/).filter((id) => id !== "cus_1"),
        fc.integer({ min: 1, max: 100_000 }),
        (customer_id, amount) => decide(amount, {}, { customer_id }) === "deny",
      ),
    );
  });

  it("a blocked tool is always denied whatever its arguments", () => {
    fc.assert(
      fc.property(fc.constantFrom("export_customer_data", "delete_account"), fc.jsonValue(), (tool, args) => {
        return evaluate(policy, { tool, args }, ctx).effect === "deny";
      }),
    );
  });

  it("arbitrary tool names and arguments never throw and are never allowed unless listed", () => {
    fc.assert(
      fc.property(fc.string(), fc.jsonValue(), (tool, args) => {
        const decision = evaluate(policy, { tool, args }, ctx);
        return policy.tools.has(tool) || decision.effect === "deny";
      }),
    );
  });
});

describe("P-19 performance", () => {
  it("evaluates a 1,000-rule policy quickly", () => {
    const escalate = Array.from({ length: 1000 }, (_, i) => ({
      id: `rule-${i}`,
      type: "threshold",
      arg: "amount_minor",
      gt: 10_000_000 + i,
      effect: "approval_required",
    }));
    const big = compilePolicy({
      apiVersion: "agentroute/v1",
      id: "big",
      version: "1.0.0",
      tenant: "*",
      agents: ["supportops"],
      default: "deny",
      tools: { create_refund_request: { effect: "allow", escalate } },
    });
    if (!big.ok) throw new Error(big.errors.join());

    const iterations = 500;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const decision = evaluate(big.policy, refund(1500), ctx);
      durations.push(performance.now() - start);
      expect(decision.effect).toBe("allow");
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(iterations * 0.95)] ?? Infinity;
    // Design target is p95 < 25 ms for the whole decision path; the engine alone must be far below it.
    expect(p95).toBeLessThan(5);
  });
});
