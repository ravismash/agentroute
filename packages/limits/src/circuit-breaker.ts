/**
 * A standard three-state circuit breaker for calls to a flaky dependency
 * (the LLM provider, Stripe). After `failureThreshold` consecutive failures it
 * opens and fast-fails for `resetTimeoutMs`; the next call is a half-open trial
 * that either closes the breaker (success) or re-opens it (failure).
 */

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(readonly name_ = "circuit") {
    super(`circuit "${name_}" is open`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  /** A name for errors/metrics. */
  name?: string;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private state: BreakerState = "closed";
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  /** Run `fn` through the breaker. Throws CircuitOpenError while open. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.options.resetTimeoutMs) {
        throw new CircuitOpenError(this.options.name);
      }
      this.state = "half_open";
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
