import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { checkGrounding, type EvidenceAction, type GroundingEvidence } from "./grounding.js";
import { baselinePolicy, context } from "./test-support/fixtures.js";

const refund = (amount_minor: number, state: string): EvidenceAction => ({
  tool: "create_refund_request",
  state,
  amount_minor,
  currency: "USD",
  target_plan: null,
});
const planChange = (target_plan: string, state = "succeeded"): EvidenceAction => ({
  tool: "change_subscription_plan",
  state,
  amount_minor: null,
  currency: null,
  target_plan,
});
const evidence = (actions: EvidenceAction[], current_plan = "pro"): GroundingEvidence => ({
  actions,
  current_plan,
});

describe("checkGrounding: claims backed by evidence", () => {
  it.each([
    ["completed refund with amount", "I've refunded the duplicate $15 charge.", [refund(1500, "succeeded")]],
    ["cents", "Done — I've refunded the $9.99 duplicate.", [refund(999, "succeeded")]],
    ["decimal formatting", "We refunded $25.00 to your card.", [refund(2500, "succeeded")]],
    [
      "total of several refunds",
      "In total $40 has been refunded.",
      [refund(2000, "succeeded"), refund(2000, "succeeded")],
    ],
    [
      "pending review",
      "Your $299 refund has been submitted for review.",
      [refund(29900, "approval_required")],
    ],
    [
      "mixed clauses",
      "I've refunded the first $20; the second $20 is with our team for review.",
      [refund(2000, "succeeded"), refund(2000, "approval_required")],
    ],
    ["Spanish", "Le hemos reembolsado el cargo duplicado de 15 dólares.", [refund(1500, "succeeded")]],
    ["negated claim", "I can't issue a refund of $800 here, but I've flagged it.", [refund(80000, "denied")]],
    ["no claims at all", "Which charge would you like refunded, and how much was it?", []],
    [
      "policy information",
      "Refunds up to $25 are usually processed within minutes.",
      [refund(1500, "succeeded")],
    ],
    [
      "plan change",
      "You'll move to the business plan from your next billing cycle.",
      [planChange("business")],
    ],
    ["current plan", "You're on the pro plan.", []],
  ])("accepts %s", (_label, text, actions) => {
    const result = checkGrounding(text, evidence(actions));
    expect(result.findings).toEqual([]);
  });
});

describe("checkGrounding: unsupported claims are caught", () => {
  it.each([
    [
      "refund claimed while pending approval",
      "Your $299 has been refunded!",
      [refund(29900, "approval_required")],
    ],
    ["refund claimed after a denial", "I've refunded $800 to your account.", [refund(80000, "denied")]],
    ["wrong amount", "I've refunded $50.", [refund(1500, "succeeded")]],
    ["completion with no refund at all", "Your refund has been processed.", []],
    ["review claim with no request", "Your $100 refund is pending review.", []],
    [
      "plan change that was denied",
      "I've switched you to the business plan.",
      [planChange("business", "denied")],
    ],
    ["question is not a claim, but the statement is", "Your refund has been issued. Anything else?", []],
    ["wrong current plan", "You're currently on the business plan.", []],
  ])("flags %s", (_label, text, actions) => {
    const result = checkGrounding(text, evidence(actions));
    expect(result.grounded).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("explains each finding", () => {
    const result = checkGrounding(
      "Your $299 has been refunded!",
      evidence([refund(29900, "approval_required")]),
    );
    expect(result.findings[0]).toEqual({
      claim: "Your $299 has been refunded!",
      problem: "claims $299.00 was refunded, but no completed refund matches",
    });
  });
});

describe("grounded_reply policy rule", () => {
  const policy = baselinePolicy();
  const reply = (body: string, actions: EvidenceAction[]) =>
    evaluate(
      policy,
      { tool: "draft_reply", args: { case_id: "case_1", body } },
      { ...context(), evidence: evidence(actions) },
    );

  it("allows a grounded reply", () => {
    expect(reply("I've refunded $15.", [refund(1500, "succeeded")]).effect).toBe("allow");
  });

  it("sends an ungrounded reply to human review with the reason", () => {
    const d = reply("Your $299 has been refunded!", [refund(29900, "approval_required")]);
    expect(d.effect).toBe("approval_required");
    expect(d.reasons[0]).toMatchObject({
      code: "POLICY_REPLY_NOT_GROUNDED",
      rule_id: "draft_reply/reply-grounded",
    });
    expect(d.reasons[0]?.message).toMatch(/\$299\.00/);
  });

  it("fails closed when the gateway supplies no evidence", () => {
    const d = evaluate(
      policy,
      { tool: "draft_reply", args: { case_id: "case_1", body: "Hello" } },
      context(),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]?.code).toBe("POLICY_EVALUATION_ERROR");
  });
});
