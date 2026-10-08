import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

const fail = () => Promise.reject(new Error("boom"));
const ok = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("R-04: opens after the failure threshold and then fast-fails", async () => {
    const clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: () => clock });

    for (let i = 0; i < 3; i += 1) await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(breaker.currentState).toBe("open");

    // While open it fast-fails without calling through.
    let called = false;
    await expect(
      breaker.exec(() => {
        called = true;
        return ok();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("half-opens after the reset timeout and closes on a successful trial", async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => clock });

    await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe("open");

    clock = 1001; // past the reset window
    await expect(breaker.exec(ok)).resolves.toBe("ok");
    expect(breaker.currentState).toBe("closed");
  });

  it("re-opens if the half-open trial also fails", async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => clock });
    await expect(breaker.exec(fail)).rejects.toThrow();
    clock = 2000;
    await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(breaker.currentState).toBe("open");
  });

  it("a success resets the consecutive-failure count", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    await expect(breaker.exec(fail)).rejects.toThrow();
    await expect(breaker.exec(fail)).rejects.toThrow();
    await expect(breaker.exec(ok)).resolves.toBe("ok");
    await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe("closed"); // only 1 failure since the reset
  });
});
