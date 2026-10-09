import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import { BudgetLedger, CircuitBreaker, withRetry, type RetryOptions } from "@agentroute/limits";

/**
 * A per-model-call budget gate. `reserve` is called before a model request and
 * blocks it when the tenant is over budget (or the ledger is unavailable);
 * `reconcile` corrects the reservation to the actual token cost afterwards.
 */
export interface BudgetGate {
  reserve(): Promise<{ ok: boolean; reason?: string }>;
  reconcile(usage: { inputTokens: number; outputTokens: number }): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(reason = "over_budget") {
    super(`LLM budget exceeded (${reason})`);
    this.name = "BudgetExceededError";
  }
}

export interface GuardedModelOptions {
  /** Opens after repeated provider failures so the agent fast-fails to a human. */
  breaker?: CircuitBreaker;
  /** Bounded, jittered retries with a per-attempt timeout around provider calls. */
  retry?: RetryOptions;
  /** Per-tenant daily LLM budget; reserved before the call, reconciled after. */
  budget?: BudgetGate;
}

/**
 * Wraps a Model with cost and resilience controls (Phase 5):
 * - budget: reserve before the call (fail-closed → BudgetExceededError, so no
 *   provider call is made when over budget), reconcile actual usage after;
 * - circuit breaker: fast-fail while the provider is unhealthy;
 * - retry: bounded jittered backoff with a per-attempt timeout.
 *
 * The non-streaming tool-decision loop (`getResponse`) is fully guarded. The
 * streaming path (final narration) applies the budget reserve then delegates;
 * breaker/retry are not applied mid-stream.
 */
export class GuardedModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly options: GuardedModelOptions,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    await this.reserveOrThrow();
    const { retry, breaker } = this.options;
    const base = (): Promise<ModelResponse> => this.inner.getResponse(request);
    const withRetries = retry ? (): Promise<ModelResponse> => withRetry(base, retry) : base;
    const run = breaker ? (): Promise<ModelResponse> => breaker.exec(withRetries) : withRetries;
    const response = await run();
    await this.options.budget?.reconcile({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    return response;
  }

  getStreamedResponse(request: ModelRequest): ReturnType<Model["getStreamedResponse"]> {
    const inner = this.inner;
    const reserve = this.reserveOrThrow.bind(this);
    async function* gen() {
      await reserve();
      yield* inner.getStreamedResponse(request);
    }
    return gen();
  }

  private async reserveOrThrow(): Promise<void> {
    if (!this.options.budget) return;
    const result = await this.options.budget.reserve();
    if (!result.ok) throw new BudgetExceededError(result.reason);
  }
}

export interface LedgerBudgetOptions {
  /** The budget bucket id (a tenant id, or the agent's own id for a single-tenant agent). */
  budgetId: string;
  /** Daily ceiling in minor units. */
  ceilingMinor: number;
  /** Estimated cost reserved per model call, in minor units. */
  estimateMinor: number;
}

/**
 * A BudgetGate backed by the shared Redis ledger. Reserves a flat per-call
 * estimate against the daily ceiling (fail-closed) and, since the estimate is
 * the charge, reconciliation is a no-op — a conservative ceiling on spend.
 */
export function ledgerBudgetGate(ledger: BudgetLedger, options: LedgerBudgetOptions): BudgetGate {
  return {
    async reserve() {
      const result = await ledger.reserve(options.budgetId, options.estimateMinor, options.ceilingMinor);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    reconcile() {
      return Promise.resolve();
    },
  };
}
