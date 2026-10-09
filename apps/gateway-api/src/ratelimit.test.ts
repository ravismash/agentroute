import { RateLimiter } from "@agentroute/limits";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-support/harness.js";

// A RateLimiter whose Redis always errors falls open to its per-process local
// buckets, which still enforce the configured capacity — enough to drive the
// HTTP 429 path deterministically without a Redis container.
function tinyLimiter(): RateLimiter {
  return new RateLimiter(
    { eval: () => Promise.reject(new Error("no redis in this test")) },
    {
      perKey: { capacity: 3, refillPerSecond: 0.0001 }, // ~no refill during the test
      perTenant: { capacity: 1000, refillPerSecond: 1000 },
    },
  );
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ rateLimiter: tinyLimiter() });
});
afterAll(() => h.close());

const refund = {
  agent_id: "supportops",
  case_id: "case_1",
  tool: "create_refund_request",
  args: { customer_id: "cus_ada", amount_minor: 1500, currency: "USD", reason_code: "duplicate_charge" },
};

describe("rate limiting", () => {
  it("R-01: a burst above the per-key bucket returns 429 with Retry-After", async () => {
    // First 3 (the bucket capacity) are admitted.
    for (let i = 0; i < 3; i += 1) {
      const res = await h.propose(refund);
      expect(res.status).toBeLessThan(429);
    }
    // The 4th is rate limited.
    const limited = await h.app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { authorization: `Bearer ${h.keys.acme}`, "idempotency-key": "rl-burst-1" },
      payload: refund,
    });
    expect(limited.statusCode).toBe(429);
    const body = limited.json<{ code?: string }>();
    expect(body.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("does not rate limit when no limiter is configured", async () => {
    const plain = await createHarness();
    try {
      for (let i = 0; i < 6; i += 1) {
        const res = await plain.propose(refund);
        expect(res.status).toBeLessThan(429);
      }
    } finally {
      await plain.close();
    }
  });
});
