import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import { takeToken } from "./token-bucket.js";

type Client = ReturnType<typeof createClient>;
let client: Client;

beforeAll(async () => {
  client = createClient({ url: inject("redisUrl") });
  await client.connect();
});
afterAll(() => {
  client.destroy();
});

const tenant = () => `t_${randomBytes(5).toString("hex")}`;

describe("token bucket", () => {
  it("allows a burst up to capacity, then denies with a retry-after", async () => {
    const key = `{${tenant()}}:b`;
    const config = { capacity: 5, refillPerSecond: 1 };
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect((await takeToken(client, key, config, 1, now)).allowed).toBe(true);
    }
    const denied = await takeToken(client, key, config, 1, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills over time", async () => {
    const key = `{${tenant()}}:b`;
    const config = { capacity: 2, refillPerSecond: 1 };
    const t0 = 2_000_000;
    await takeToken(client, key, config, 2, t0); // drain
    expect((await takeToken(client, key, config, 1, t0)).allowed).toBe(false);
    // 2 seconds later, 2 tokens have refilled.
    expect((await takeToken(client, key, config, 1, t0 + 2000)).allowed).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("R-01: a burst above the per-key bucket is limited with a Retry-After", async () => {
    const limiter = new RateLimiter(client, {
      perKey: { capacity: 3, refillPerSecond: 1 },
      perTenant: { capacity: 100, refillPerSecond: 100 },
    });
    const t = tenant();
    const now = 3_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.check(t, "key1", now)).allowed).toBe(true);
    }
    const limited = await limiter.check(t, "key1", now);
    expect(limited).toMatchObject({ allowed: false, source: "redis" });
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("the per-tenant bucket limits across multiple keys", async () => {
    const limiter = new RateLimiter(client, {
      perKey: { capacity: 100, refillPerSecond: 100 },
      perTenant: { capacity: 2, refillPerSecond: 1 },
    });
    const t = tenant();
    const now = 4_000_000;
    expect((await limiter.check(t, "keyA", now)).allowed).toBe(true);
    expect((await limiter.check(t, "keyB", now)).allowed).toBe(true);
    // Third request on a third key still trips the shared tenant bucket.
    expect((await limiter.check(t, "keyC", now)).allowed).toBe(false);
  });

  it("fails open to a local limiter when Redis errors", async () => {
    let fellOpen = false;
    const limiter = new RateLimiter(
      { eval: () => Promise.reject(new Error("redis down")) },
      {
        perKey: { capacity: 2, refillPerSecond: 1 },
        perTenant: { capacity: 100, refillPerSecond: 100 },
        onRedisError: () => {
          fellOpen = true;
        },
      },
    );
    const t = tenant();
    const now = 5_000_000;
    const first = await limiter.check(t, "key1", now);
    expect(first).toMatchObject({ allowed: true, source: "local" });
    expect(fellOpen).toBe(true);
    // The local fallback still enforces a bound (capacity 2).
    await limiter.check(t, "key1", now);
    expect((await limiter.check(t, "key1", now)).allowed).toBe(false);
  });
});
