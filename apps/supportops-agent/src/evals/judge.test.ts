import { describe, expect, it } from "vitest";
import { buildJudgePrompt, judge, parseJudgeResponse, type ChatClient } from "./judge.js";
import { JUDGE_LABELS } from "./judge-labels.js";
import { agreement, costUsd, mean, percentile } from "./stats.js";

const scores = { faithfulness: 5, safety: 5, tone: 4, resolution: 4, rationale: "fine" };

class FakeChat implements ChatClient {
  prompts: string[] = [];
  constructor(private readonly responses: string[]) {}
  complete(_system: string, user: string): Promise<string> {
    this.prompts.push(user);
    return Promise.resolve(this.responses.shift() ?? "");
  }
}

describe("judge", () => {
  it("parses JSON wrapped in prose or code fences", () => {
    expect(parseJudgeResponse(`Here you go:\n\`\`\`json\n${JSON.stringify(scores)}\n\`\`\``)).toEqual(scores);
  });

  it("rejects out-of-range scores", () => {
    expect(() => parseJudgeResponse(JSON.stringify({ ...scores, tone: 9 }))).toThrow();
  });

  it("passes only when every dimension is at least 4", async () => {
    const input = JUDGE_LABELS[0];
    if (!input) throw new Error("no labels");
    expect((await judge(new FakeChat([JSON.stringify(scores)]), input)).pass).toBe(true);
    expect((await judge(new FakeChat([JSON.stringify({ ...scores, faithfulness: 2 })]), input)).pass).toBe(
      false,
    );
  });

  it("retries once on malformed output, then gives up", async () => {
    const input = JUDGE_LABELS[0];
    if (!input) throw new Error("no labels");
    const recovers = new FakeChat(["not json", JSON.stringify(scores)]);
    expect((await judge(recovers, input)).scores).toEqual(scores);
    await expect(judge(new FakeChat(["nope", "still nope"]), input)).rejects.toThrow(/judge failed/);
  });

  it("gives the judge the evidence: actions with state and the retrieved article text", () => {
    const prompt = buildJudgePrompt({
      message: "How long do refunds take?",
      actions: [
        {
          tool: "create_refund_request",
          args: { amount_minor: 29900 },
          effect: "approval_required",
          state: "approval_required",
        },
      ],
      sources: ["refund-timing"],
      reply: "Instant!",
    });
    expect(prompt).toContain("state=approval_required");
    expect(prompt).toContain("5–10 business days");
    expect(prompt).toContain("Instant!");
  });

  it("has a balanced calibration set with unique ids", () => {
    expect(new Set(JUDGE_LABELS.map((l) => l.id)).size).toBe(JUDGE_LABELS.length);
    const passes = JUDGE_LABELS.filter((l) => l.pass).length;
    expect(passes / JUDGE_LABELS.length).toBeGreaterThan(0.4);
    expect(passes / JUDGE_LABELS.length).toBeLessThan(0.6);
  });
});

describe("stats", () => {
  it("computes percentiles", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("computes Cohen's kappa", () => {
    const perfect = agreement([true, false, true, false], [true, false, true, false]);
    expect(perfect).toMatchObject({ accuracy: 1, kappa: 1 });
    // Agreement no better than chance → kappa ≈ 0.
    const chance = agreement([true, true, false, false], [true, false, true, false]);
    expect(chance.accuracy).toBe(0.5);
    expect(chance.kappa).toBeCloseTo(0);
    expect(agreement([true, true, false], [true, false, false]).confusion).toEqual({
      tp: 1,
      tn: 1,
      fp: 1,
      fn: 0,
    });
  });

  it("prices token usage", () => {
    expect(
      costUsd({ input_tokens: 1_000_000, output_tokens: 100_000 }, { prompt: 0.2e-6, completion: 1.2e-6 }),
    ).toBeCloseTo(0.32);
    expect(costUsd({ input_tokens: 1, output_tokens: 1 }, undefined)).toBeNaN();
  });
});
