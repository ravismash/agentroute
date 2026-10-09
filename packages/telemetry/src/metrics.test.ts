import { describe, expect, it } from "vitest";
import { Metrics } from "./metrics.js";

/** defaultMetrics off so the output is deterministic (no process/GC series). */
const newMetrics = () => new Metrics({ defaultMetrics: false });

describe("Metrics", () => {
  it("renders Prometheus text with help and type lines for each instrument", async () => {
    const m = newMetrics();
    m.decisions.inc({ effect: "allow", tool: "create_refund_request" });
    const text = await m.render();
    expect(text).toContain("# TYPE agentroute_decisions_total counter");
    expect(text).toContain('agentroute_decisions_total{effect="allow",tool="create_refund_request"} 1');
    expect(text).toContain("agentroute_decision_duration_seconds");
    expect(text).toContain("agentroute_rate_limited_total");
    expect(text).toContain("agentroute_executions_total");
  });

  it("counts decisions by effect and tool", async () => {
    const m = newMetrics();
    m.decisions.inc({ effect: "deny", tool: "export_customer_data" });
    m.decisions.inc({ effect: "deny", tool: "export_customer_data" });
    m.decisions.inc({ effect: "allow", tool: "get_customer" });
    const text = await m.render();
    expect(text).toContain('agentroute_decisions_total{effect="deny",tool="export_customer_data"} 2');
    expect(text).toContain('agentroute_decisions_total{effect="allow",tool="get_customer"} 1');
  });

  it("records decision-duration observations into the histogram", async () => {
    const m = newMetrics();
    m.decisionDuration.observe({ effect: "allow" }, 0.003);
    const text = await m.render();
    // A 3ms decision falls under the 25ms SLO bucket.
    expect(text).toMatch(/agentroute_decision_duration_seconds_bucket\{le="0\.025",effect="allow"\} 1/);
    expect(text).toContain('agentroute_decision_duration_seconds_count{effect="allow"} 1');
  });

  it("counts rate-limit rejections and execution outcomes", async () => {
    const m = newMetrics();
    m.rateLimited.inc({ scope: "key" });
    m.executions.inc({ outcome: "succeeded" });
    const text = await m.render();
    expect(text).toContain('agentroute_rate_limited_total{scope="key"} 1');
    expect(text).toContain('agentroute_executions_total{outcome="succeeded"} 1');
  });

  it("exposes the Prometheus content type", () => {
    expect(newMetrics().contentType).toContain("text/plain");
  });
});
