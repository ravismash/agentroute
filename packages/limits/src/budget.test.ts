import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { BudgetLedger } from "./budget.js";

type Client = ReturnType<typeof createClient>;
let client: Client;

beforeAll(async () => {
  client = createClient({ url: inject("redisUrl") });
  await client.connect();
});
afterAll(() => {
  client.destroy();
});

/** A unique tenant id per test so day-keys never collide across tests. */
const tenant = () => `t_${randomBytes(5).toString("hex")}`;

describe("BudgetLedger", () => {
  it("R-02: reserves under the ceiling and denies once it would be exceeded", async () => {
    const ledger = new BudgetLedger(client);
    const t = tenant();
    // Ceiling 200 ($2.00). Reserve 150, then 40 (ok, total 190), then 20 (would be 210 → deny).
    expect(await ledger.reserve(t, 150, 200)).toMatchObject({ ok: true, spentMinor: 150 });
    expect(await ledger.reserve(t, 40, 200)).toMatchObject({ ok: true, spentMinor: 190 });
    const denied = await ledger.reserve(t, 20, 200);
    expect(denied).toMatchObject({ ok: false, reason: "over_budget", spentMinor: 190 });
    // A denied reservation does not consume budget: a 10 that fits still passes.
    expect(await ledger.reserve(t, 10, 200)).toMatchObject({ ok: true, spentMinor: 200 });
  });

  it("R-03: concurrent reservations never exceed the ceiling", async () => {
    const ledger = new BudgetLedger(client);
    const t = tenant();
    // Ceiling 100, each reservation 10 → at most 10 may succeed, no matter the race.
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve(t, 10, 100)));
    const granted = results.filter((r) => r.ok).length;
    expect(granted).toBe(10);
    const max = Math.max(...results.map((r) => r.spentMinor));
    expect(max).toBeLessThanOrEqual(100);
  });

  it("reconcile corrects the day's counter by actual minus estimate", async () => {
    const ledger = new BudgetLedger(client);
    const t = tenant();
    await ledger.reserve(t, 100, 1000); // reserved an over-estimate
    await ledger.reconcile(t, 100, 30); // actual was only 30 → refund 70
    // A further reservation sees spend at 30, so 900 still fits (30 + 900 <= 1000).
    expect(await ledger.reserve(t, 900, 1000)).toMatchObject({ ok: true, spentMinor: 930 });
  });

  it("fails closed when Redis is unavailable", async () => {
    const broken = new BudgetLedger({ eval: () => Promise.reject(new Error("redis down")) });
    expect(await broken.reserve(tenant(), 1, 1000)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
