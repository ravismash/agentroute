import { describe, expect, it } from "vitest";
import { compilePolicy, loadPolicy } from "./compile.js";
import { BASELINE_SOURCE } from "./test-support/fixtures.js";

const minimal = {
  apiVersion: "agentroute/v1",
  id: "minimal",
  version: "1.0.0",
  tenant: "*",
  agents: ["supportops"],
  default: "deny",
  tools: {},
};

function errorsOf(raw: unknown): string[] {
  const result = compilePolicy(raw);
  return result.ok ? [] : result.errors;
}

describe("loadPolicy", () => {
  it("compiles the baseline policy", () => {
    const result = loadPolicy(BASELINE_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.tools.size).toBe(5);
    expect(result.policy.blockedTools.has("export_customer_data")).toBe(true);
  });

  it("P-15 rejects invalid YAML", () => {
    const result = loadPolicy("apiVersion: [unclosed");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors[0]).toMatch(/invalid YAML/);
  });

  it("rejects duplicate YAML keys", () => {
    expect(loadPolicy("id: a\nid: b\n").ok).toBe(false);
  });

  it("rejects oversized policies", () => {
    expect(loadPolicy(`# ${"x".repeat(300 * 1024)}`).ok).toBe(false);
  });

  it("produces a stable checksum", () => {
    const a = loadPolicy(BASELINE_SOURCE);
    const b = loadPolicy(BASELINE_SOURCE);
    expect(a.ok && b.ok && a.policy.checksum === b.policy.checksum).toBe(true);
  });
});

describe("compilePolicy validation (P-15)", () => {
  it("accepts a minimal policy", () => {
    expect(errorsOf(minimal)).toEqual([]);
  });

  it.each([
    ["wrong apiVersion", { ...minimal, apiVersion: "v2" }, "apiVersion"],
    ["default allow", { ...minimal, default: "allow" }, "default"],
    ["non-semver version", { ...minimal, version: "latest" }, "version"],
    ["no agents", { ...minimal, agents: [] }, "agents"],
    ["unknown top-level key", { ...minimal, extra: true }, "(root)"],
  ])("rejects %s", (_label, raw, path) => {
    expect(errorsOf(raw).join("\n")).toContain(path);
  });

  it("rejects tools not defined in contracts", () => {
    expect(errorsOf({ ...minimal, tools: { launch_rocket: { effect: "allow" } } })).toEqual([
      "tools.launch_rocket: unknown tool (not defined in @agentroute/contracts)",
    ]);
  });

  it("rejects a tool that is both blocked and permitted", () => {
    const raw = { ...minimal, blocked_tools: ["get_customer"], tools: { get_customer: { effect: "allow" } } };
    expect(errorsOf(raw)[0]).toMatch(/also listed in blocked_tools/);
  });

  it("rejects rules that reference arguments the tool does not have", () => {
    const raw = {
      ...minimal,
      tools: {
        get_customer: {
          effect: "allow",
          require: [{ id: "x", type: "context_equals", arg: "amount_minor", field: "case.id" }],
        },
      },
    };
    expect(errorsOf(raw)[0]).toMatch(/has no argument "amount_minor"/);
  });

  it("rejects thresholds on non-numeric arguments", () => {
    const raw = {
      ...minimal,
      tools: {
        create_refund_request: {
          effect: "allow",
          escalate: [{ id: "t", type: "threshold", arg: "currency", gt: 1, effect: "deny" }],
        },
      },
    };
    expect(errorsOf(raw)[0]).toMatch(/is not numeric/);
  });

  it("rejects duplicate rule ids within a tool", () => {
    const rule = { id: "same", type: "context_equals", arg: "customer_id", field: "case.customer_id" };
    const raw = { ...minimal, tools: { get_customer: { effect: "allow", require: [rule, rule] } } };
    expect(errorsOf(raw)[0]).toMatch(/duplicate rule id/);
  });

  it("rejects context fields outside the allowed roots", () => {
    const raw = {
      ...minimal,
      tools: {
        get_customer: {
          effect: "allow",
          require: [{ id: "x", type: "context_equals", arg: "customer_id", field: "process.env" }],
        },
      },
    };
    expect(errorsOf(raw).length).toBeGreaterThan(0);
  });

  it("rejects malformed durations", () => {
    const raw = {
      ...minimal,
      tools: {
        create_refund_request: {
          effect: "allow",
          escalate: [
            {
              id: "a",
              type: "aggregate",
              metric: "refund_count",
              scope: "case",
              window: "1week",
              gt: 1,
              effect: "deny",
            },
          ],
        },
      },
    };
    expect(errorsOf(raw).join()).toMatch(/duration/);
  });

  it("does not allow a tool's base effect to be deny (use blocked_tools)", () => {
    expect(errorsOf({ ...minimal, tools: { get_customer: { effect: "deny" } } }).length).toBeGreaterThan(0);
  });
});
