import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-support/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const metricsText = async (): Promise<string> => {
  const res = await h.app.inject({ method: "GET", url: "/metrics" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  return res.body;
};

describe("observability: /metrics", () => {
  it("exposes the AgentRoute instruments in Prometheus format", async () => {
    const text = await metricsText();
    expect(text).toContain("agentroute_decisions_total");
    expect(text).toContain("agentroute_decision_duration_seconds");
    expect(text).toContain("agentroute_http_request_duration_seconds");
  });

  it("counts a decision by effect and records its latency after a proposal", async () => {
    // An auto-allowed refund: one allow decision for create_refund_request.
    const res = await h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "create_refund_request",
      args: { customer_id: "cus_ada", amount_minor: 1500, currency: "USD", reason_code: "duplicate_charge" },
    });
    expect(res.body.effect).toBe("allow");

    const text = await metricsText();
    expect(text).toMatch(/agentroute_decisions_total\{effect="allow",tool="create_refund_request"\} [1-9]/);
    // The decision-latency histogram recorded at least one observation.
    expect(text).toMatch(/agentroute_decision_duration_seconds_count\{effect="allow"\} [1-9]/);
    // An allowed refund executes; its outcome is counted.
    expect(text).toMatch(/agentroute_executions_total\{outcome="(succeeded|failed)"\} [1-9]/);
  });

  it("counts a denied decision", async () => {
    await h.propose({
      agent_id: "supportops",
      case_id: "case_1",
      tool: "export_customer_data",
      args: { customer_id: "cus_ada" },
    });
    const text = await metricsText();
    expect(text).toMatch(/agentroute_decisions_total\{effect="deny",tool="export_customer_data"\} [1-9]/);
  });
});
