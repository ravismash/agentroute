import type { RedisEval } from "./token-bucket.js";

/**
 * Per-tenant daily LLM spend ledger in Redis. The reserve step checks the
 * ceiling and increments the day's counter atomically (Lua), so concurrent
 * reservations can never push spend past the ceiling (R-03). Estimated cost is
 * reserved before a model call and reconciled to the actual cost afterwards.
 *
 * Fail-closed: if Redis is unavailable, `reserve` denies. Cost safety is chosen
 * over availability (the plan's CP choice for budgets), unlike rate limiting.
 */

export interface ReserveResult {
  ok: boolean;
  /** Spend for the day after this reservation, in minor units. */
  spentMinor: number;
  /** Set when denied: 'over_budget' (ceiling) or 'unavailable' (Redis down). */
  reason?: "over_budget" | "unavailable";
}

// {ok, spend}. Reserve only if current + est <= ceiling.
const RESERVE = `
local key = KEYS[1]
local est = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', key) or '0')
if current + est > ceiling then
  return {0, current}
end
local updated = redis.call('INCRBY', key, est)
redis.call('EXPIRE', key, ttl)
return {1, updated}
`;

/** Seconds until the next UTC midnight, so a day's counter expires on its own. */
function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

function dayKey(tenantId: string, now: Date): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `{${tenantId}}:budget:${day}`;
}

export class BudgetLedger {
  constructor(private readonly redis: RedisEval) {}

  /**
   * Reserve `estimateMinor` against the tenant's daily `ceilingMinor`. Denies
   * (without reserving) if it would exceed the ceiling, or if Redis is down.
   */
  async reserve(
    tenantId: string,
    estimateMinor: number,
    ceilingMinor: number,
    now: Date = new Date(),
  ): Promise<ReserveResult> {
    const est = Math.max(0, Math.ceil(estimateMinor));
    try {
      const raw = (await this.redis.eval(RESERVE, {
        keys: [dayKey(tenantId, now)],
        arguments: [String(est), String(ceilingMinor), String(secondsUntilUtcMidnight(now))],
      })) as [number, number];
      if (raw[0] === 1) return { ok: true, spentMinor: raw[1] };
      return { ok: false, spentMinor: raw[1], reason: "over_budget" };
    } catch {
      // Fail closed: no reservation means no model call.
      return { ok: false, spentMinor: 0, reason: "unavailable" };
    }
  }

  /**
   * Correct a reservation once the actual cost is known: applies
   * (actual - estimate) to the day's counter. A negative delta refunds an
   * over-estimate; positive charges an under-estimate. Best-effort — a failure
   * here only skews accounting, never correctness, so it is swallowed.
   */
  async reconcile(
    tenantId: string,
    estimateMinor: number,
    actualMinor: number,
    now: Date = new Date(),
  ): Promise<void> {
    const delta = Math.ceil(actualMinor) - Math.ceil(estimateMinor);
    if (delta === 0) return;
    try {
      await this.redis.eval(
        `redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('EXPIRE', KEYS[1], ARGV[2]); return 1`,
        {
          keys: [dayKey(tenantId, now)],
          arguments: [String(delta), String(secondsUntilUtcMidnight(now))],
        },
      );
    } catch {
      // Accounting drift only; ignore.
    }
  }
}
