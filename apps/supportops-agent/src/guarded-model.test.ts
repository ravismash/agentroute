import { CircuitBreaker, CircuitOpenError } from "@agentroute/limits";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Usage } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, GuardedModel, type BudgetGate } from "./guarded-model.js";

const REQUEST = {} as ModelRequest;

function response(): ModelResponse {
  return {
    usage: new Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  } as unknown as ModelResponse;
}

/** An inner model that fails `failures` times before succeeding, counting calls. */
function flakyModel(failures: number): Model & { calls: number } {
  const model = {
    calls: 0,
    getResponse(): Promise<ModelResponse> {
      model.calls += 1;
      if (model.calls <= failures) return Promise.reject(new Error("provider 503"));
      return Promise.resolve(response());
    },
    getStreamedResponse(): AsyncIterable<never> {
      throw new Error("not used");
    },
  };
  return model;
}

const noRetry = { retries: 0, baseMs: 0, maxMs: 0 };
const fastRetry = { retries: 3, baseMs: 0, maxMs: 0, sleep: () => Promise.resolve() };

describe("GuardedModel", () => {
  it("R-02: blocks the call when over budget — the provider is never called", async () => {
    const inner = flakyModel(0);
    const reconcile = vi.fn(() => Promise.resolve());
    const budget: BudgetGate = {
      reserve: () => Promise.resolve({ ok: false, reason: "over_budget" }),
      reconcile,
    };
    const guarded = new GuardedModel(inner, { budget });
    await expect(guarded.getResponse(REQUEST)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(inner.calls).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reserves before and reconciles actual usage after a successful call", async () => {
    const inner = flakyModel(0);
    const reconcile = vi.fn(() => Promise.resolve());
    const budget: BudgetGate = { reserve: () => Promise.resolve({ ok: true }), reconcile };
    const guarded = new GuardedModel(inner, { budget });
    await guarded.getResponse(REQUEST);
    expect(inner.calls).toBe(1);
    expect(reconcile).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 20 });
  });

  it("retries a transient provider failure and then succeeds", async () => {
    const inner = flakyModel(2);
    const guarded = new GuardedModel(inner, { retry: fastRetry });
    await expect(guarded.getResponse(REQUEST)).resolves.toBeDefined();
    expect(inner.calls).toBe(3); // 2 failures + 1 success
  });

  it("R-04: the breaker opens after repeated failures and then fast-fails", async () => {
    const inner = flakyModel(Number.POSITIVE_INFINITY); // always fails
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10_000 });
    const guarded = new GuardedModel(inner, { breaker, retry: noRetry });

    for (let i = 0; i < 3; i += 1) {
      await expect(guarded.getResponse(REQUEST)).rejects.toThrow("provider 503");
    }
    expect(breaker.currentState).toBe("open");

    const before = inner.calls;
    await expect(guarded.getResponse(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.calls).toBe(before); // open circuit did not call the provider
  });
});
