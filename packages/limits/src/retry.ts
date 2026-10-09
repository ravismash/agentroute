/** A bounded retry with per-attempt timeout and full-jitter exponential backoff. */

export interface RetryOptions {
  /** Retries after the first attempt (so total attempts = retries + 1). */
  retries: number;
  /** Base backoff in ms; attempt n waits a random value in [0, base * 2^n]. */
  baseMs: number;
  /** Cap on the backoff window in ms. */
  maxMs: number;
  /** Per-attempt timeout in ms; 0 disables the timeout. */
  timeoutMs?: number;
  /** Whether an error is worth retrying. Defaults to always. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (!ms) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Call `fn`, retrying transient failures with jittered backoff. Re-throws the
 * last error once retries are exhausted or an error is deemed non-retryable.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await withTimeout(fn, options.timeoutMs ?? 0);
    } catch (err) {
      lastError = err;
      if (attempt === options.retries || !isRetryable(err)) break;
      const window = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
      await sleep(Math.floor(random() * window));
    }
  }
  throw lastError;
}
