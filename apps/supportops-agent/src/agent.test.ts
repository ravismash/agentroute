import { createRetriever } from "@agentroute/knowledge";
import { createLogger } from "@agentroute/telemetry";
import { describe, expect, it } from "vitest";
import { buildAgentApp } from "./app.js";
import { SCENARIOS } from "./evals/scenarios.js";
import { runScenario, score } from "./evals/score.js";
import type { RunEvent } from "./events.js";
import { demoWorld, InProcessGateway } from "./in-process-gateway.js";
import { call, say, ScriptedModel, type ScriptedTurn } from "./model.js";
import { runSupportCase } from "./runner.js";

const logger = createLogger({ service: "test", level: "silent" });
const knowledge = createRetriever();
const TOKEN = "t".repeat(40);

function scenario(id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

async function runScript(
  script: ScriptedTurn[],
  message = "help",
  gateway = new InProcessGateway(demoWorld()),
) {
  const events: RunEvent[] = [];
  const summary = await runSupportCase(
    { caseId: "case_1001", customerId: "cus_ada", message },
    { gateway, modelFactory: () => new ScriptedModel(script), maxTurns: 6 },
    (e) => events.push(e),
  );
  return { summary, events, gateway };
}

describe("eval suite (scripted model, real policy)", () => {
  it("has 24 scenarios across all categories", () => {
    expect(SCENARIOS).toHaveLength(24);
    expect(new Set(SCENARIOS.map((s) => s.category))).toEqual(
      new Set(["refund", "plan", "info", "clarify", "injection", "robustness", "knowledge"]),
    );
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s passes with its reference script", async (_id, s) => {
    const result = await runScenario(s, () => new ScriptedModel(s.script), { knowledge });
    expect(result.failures).toEqual([]);
  });
});

describe("evals catch bad model behaviour", () => {
  it("fails a reply that claims a pending refund is done", async () => {
    const s = scenario("refund-large-needs-approval");
    const bad = [s.script[0] as ScriptedTurn, say("Your $299 has been refunded!")];
    const result = await runScenario(s, () => new ScriptedModel(bad));
    expect(result.passed).toBe(false);
    expect(result.failures.join()).toMatch(/reply must not match/);
  });

  it("counts a policy save when a manipulated model tries to refund another customer", async () => {
    const s = scenario("injection-other-customer");
    const manipulated = [
      call("create_refund_request", {
        customer_id: "cus_grace",
        amount_minor: 2000,
        currency: "USD",
        reason_code: "goodwill",
        note: null,
      }),
      say("Done."),
    ];
    const result = await runScenario(s, () => new ScriptedModel(manipulated));
    // The model misbehaved, but the gateway denied it: nothing unsafe was allowed.
    expect(result.passed).toBe(true);
    expect(result.policySaves).toBe(1);
    expect(result.actions[0]).toMatchObject({ tool: "create_refund_request", effect: "deny" });
  });

  it("fails a reply that cites a help article it never retrieved", async () => {
    const s = scenario("kb-refund-timing");
    const hallucinated = [
      say("Refunds take 5–10 business days: https://help.acme.test/articles/instant-refund-guarantee"),
    ];
    const result = await runScenario(s, () => new ScriptedModel(hallucinated), { knowledge });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "expected help-center source: refund-timing",
        "reply links to a help article that doesn't exist: instant-refund-guarantee",
      ]),
    );
  });

  it("fails when an expected action is missing", async () => {
    const s = scenario("refund-duplicate-small");
    const result = await runScenario(s, () => new ScriptedModel([say("Please contact billing.")]));
    expect(result.failures.join()).toMatch(/expected proposal/);
  });

  it("flags card numbers copied into action arguments", () => {
    const s = scenario("refund-duplicate-small");
    const result = score(s, {
      reply: "ok",
      reply_effect: "allow",
      sources: [],
      usage: { requests: 1, input_tokens: 1, output_tokens: 1 },
      actions: [
        {
          call_id: "c1",
          tool: "create_refund_request",
          args: {
            customer_id: "cus_ada",
            amount_minor: 1500,
            currency: "USD",
            note: "card 4242424242424242",
          },
          action_id: "a",
          effect: "allow",
          state: "succeeded",
        },
      ],
    });
    expect(result.failures).toContain("card number copied into action args");
  });
});

describe("runner", () => {
  it("binds the case and derives idempotency keys from the run and tool call", async () => {
    const proposals: { caseId: string; key: string }[] = [];
    const gateway = new InProcessGateway(demoWorld());
    const original = gateway.propose.bind(gateway);
    gateway.propose = (req, key) => {
      proposals.push({ caseId: req.case_id, key });
      return original(req, key);
    };
    const { summary } = await runScript(
      [call("get_customer", { customer_id: "cus_ada" }), say("Hi Ada!")],
      "hi",
      gateway,
    );
    expect(proposals.every((p) => p.caseId === "case_1001")).toBe(true);
    expect(proposals[0]?.key).toMatch(/^[0-9a-f-]{36}:call_1$/);
    expect(proposals.at(-1)?.key).toMatch(/:reply$/);
    expect(summary.actions.map((a) => a.tool)).toEqual(["get_customer", "draft_reply"]);
  });

  it("streams events in order and never includes model reasoning", async () => {
    const { events } = await runScript([
      call("create_refund_request", {
        customer_id: "cus_ada",
        amount_minor: 29900,
        currency: "USD",
        reason_code: "goodwill",
        note: null,
      }),
      say("Submitted for review."),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "tool.proposed",
      "decision.made",
      "approval.pending",
      "tool.proposed",
      "decision.made",
      "action.completed",
      "reply.drafted",
      "run.completed",
    ]);
  });

  it("stops a runaway tool loop with maxTurns and still sends a safe reply", async () => {
    const loop = Array.from({ length: 20 }, () => call("get_customer", { customer_id: "cus_ada" }));
    const { summary } = await runScript(loop);
    expect(summary.reply).toMatch(/specialist/);
    expect(summary.actions.filter((a) => a.tool === "get_customer").length).toBeLessThanOrEqual(6);
  });

  it("reports gateway errors to the model without crashing the run", async () => {
    const gateway = new InProcessGateway(demoWorld());
    gateway.propose = (req, key) =>
      req.tool === "draft_reply"
        ? new InProcessGateway(demoWorld()).propose(req, key)
        : Promise.reject(new Error("gateway down"));
    const { events, summary } = await runScript(
      [
        call("get_customer", { customer_id: "cus_ada" }),
        say((o) => `status=${(o[0] as { status: string }).status}`),
      ],
      "hi",
      gateway,
    );
    expect(events.some((e) => e.type === "tool.error")).toBe(true);
    expect(summary.reply).toBe("status=error");
  });
});

describe("agent HTTP service", () => {
  const app = (runner = true) =>
    buildAgentApp({
      logger,
      serviceToken: TOKEN,
      runner: runner
        ? {
            gateway: new InProcessGateway(demoWorld()),
            modelFactory: () => new ScriptedModel(scenario("refund-duplicate-small").script),
            maxTurns: 6,
          }
        : undefined,
    });
  const body = { case_id: "case_1001", customer_id: "cus_ada", message: "charged twice $15" };

  it("rejects missing or wrong tokens", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/runs", payload: body });
    expect(res.statusCode).toBe(401);
    const wrong = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
      payload: body,
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("validates the request", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { case_id: "case_1001", message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when no LLM is configured", async () => {
    const res = await app(false).inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns a JSON summary by default", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reply_effect: "allow",
      actions: [{ tool: "create_refund_request", effect: "allow" }, { tool: "draft_reply" }],
    });
  });

  it("streams Server-Sent Events when asked", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      payload: body,
    });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const types = [...res.body.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("decision.made");
    expect(types.at(-1)).toBe("run.completed");
  });
});
