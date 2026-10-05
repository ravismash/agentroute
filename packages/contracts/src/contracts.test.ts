import { describe, expect, it } from "vitest";
import {
  ACTION_STATES,
  ACTION_TRANSITIONS,
  canTransition,
  isTerminal,
  parseToolArgs,
  ProposalRequest,
} from "./index.js";

const validRefund = {
  customer_id: "cus_123",
  amount_minor: 1500,
  currency: "USD",
  reason_code: "duplicate_charge",
};

describe("parseToolArgs", () => {
  it("accepts a valid refund request", () => {
    expect(parseToolArgs("create_refund_request", validRefund)).toMatchObject({ ok: true });
  });

  it.each([
    ["negative amount", { ...validRefund, amount_minor: -100 }],
    ["zero amount", { ...validRefund, amount_minor: 0 }],
    ["fractional amount", { ...validRefund, amount_minor: 15.5 }],
    ["lowercase currency", { ...validRefund, currency: "usd" }],
    ["unknown reason code", { ...validRefund, reason_code: "because" }],
    ["extra field", { ...validRefund, customer_override: "cus_999" }],
    ["missing customer", { amount_minor: 1500, currency: "USD", reason_code: "goodwill" }],
  ])("rejects %s", (_label, args) => {
    expect(parseToolArgs("create_refund_request", args)).toMatchObject({ ok: false, reason: "invalid_args" });
  });

  it("reports unknown tools instead of throwing", () => {
    expect(parseToolArgs("export_customer_data", {})).toEqual({ ok: false, reason: "unknown_tool" });
  });

  it("does not treat prototype keys as tools", () => {
    expect(parseToolArgs("constructor", {})).toEqual({ ok: false, reason: "unknown_tool" });
  });
});

describe("ProposalRequest", () => {
  it("accepts unknown tool names so they can be denied and audited", () => {
    const parsed = ProposalRequest.safeParse({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "delete_account",
      args: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects ids with unsafe characters", () => {
    const parsed = ProposalRequest.safeParse({
      agent_id: "supportops",
      case_id: "case_1; DROP TABLE",
      tool: "get_customer",
      args: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe("action state machine", () => {
  it("allows the happy paths", () => {
    expect(canTransition("proposed", "allowed")).toBe(true);
    expect(canTransition("allowed", "executing")).toBe(true);
    expect(canTransition("executing", "succeeded")).toBe(true);
    expect(canTransition("proposed", "approval_required")).toBe(true);
    expect(canTransition("approval_required", "approved")).toBe(true);
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("failed", "executing")).toBe(true);
  });

  it.each([
    ["denied", "executing"],
    ["approval_required", "executing"],
    ["rejected", "approved"],
    ["expired", "approved"],
    ["succeeded", "executing"],
    ["proposed", "executing"],
  ] as const)("forbids %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("defines transitions for every state and only targets known states", () => {
    for (const state of ACTION_STATES) {
      for (const target of ACTION_TRANSITIONS[state]) {
        expect(ACTION_STATES).toContain(target);
      }
    }
  });

  it("marks terminal states", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("denied")).toBe(true);
    expect(isTerminal("failed")).toBe(false);
  });
});
