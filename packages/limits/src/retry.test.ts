import { describe, expect, it, vi } from "vitest";
import { TimeoutError, withRetry } from "./retry.js";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(() => Promise.resolve(42));
    await expect(withRetry(fn, { retries: 3, baseMs: 1, maxMs: 10, sleep: noSleep })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures up to the limit, then throws the last error", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("429")));
    await expect(
      withRetry(fn, { retries: 2, baseMs: 1, maxMs: 10, sleep: noSleep, random: () => 0 }),
    ).rejects.toThrow("429");
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("recovers when a later attempt succeeds", async () => {
    let n = 0;
    const fn = vi.fn(() => (++n < 3 ? Promise.reject(new Error("flaky")) : Promise.resolve("ok")));
    await expect(
      withRetry(fn, { retries: 5, baseMs: 1, maxMs: 10, sleep: noSleep, random: () => 0 }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("400")));
    await expect(
      withRetry(fn, {
        retries: 5,
        baseMs: 1,
        maxMs: 10,
        sleep: noSleep,
        isRetryable: (e) => !(e as Error).message.startsWith("4"),
      }),
    ).rejects.toThrow("400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("times out a slow attempt", async () => {
    const fn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("late");
        }, 50);
      });
    await expect(
      withRetry(fn, { retries: 0, baseMs: 1, maxMs: 10, timeoutMs: 10, sleep: noSleep }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("backoff window grows but is capped by maxMs", async () => {
    const waits: number[] = [];
    const fn = () => Promise.reject(new Error("x"));
    await expect(
      withRetry(fn, {
        retries: 4,
        baseMs: 10,
        maxMs: 40,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 1, // take the full window each time
      }),
    ).rejects.toThrow();
    // windows: 10, 20, 40, 40 (capped) — full-jitter with random()=1 hits the cap
    expect(waits).toEqual([10, 20, 40, 40]);
  });
});
