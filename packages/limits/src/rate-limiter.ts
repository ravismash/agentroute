import { takeToken, type RedisEval, type TokenBucketConfig } from "./token-bucket.js";

/**
 * In-process token bucket, used as a fail-open fallback when Redis is
 * unavailable. Per-instance (not shared across replicas), so it is a best-effort
 * safety net, not the primary limiter — which is the plan's deliberate choice:
 * availability over precision for rate limiting.
 */
class LocalBucket {
  private tokens: number;
  private ts: number;
  constructor(private readonly config: TokenBucketConfig) {
    this.tokens = config.capacity;
    this.ts = Date.now();
  }
  take(cost: number, now: number): boolean {
    const elapsed = Math.max(0, now - this.ts) / 1000;
    this.tokens = Math.min(this.config.capacity, this.tokens + elapsed * this.config.refillPerSecond);
    this.ts = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** Which limiter decided: the shared Redis bucket or the local fallback. */
  source: "redis" | "local";
}

export interface RateLimiterOptions {
  /** Per-API-key bucket (the tighter, per-caller limit). */
  perKey: TokenBucketConfig;
  /** Per-tenant bucket (the aggregate limit across a tenant's keys). */
  perTenant: TokenBucketConfig;
  /** Called once when a Redis error forces a fail-open fallback. */
  onRedisError?: (err: unknown) => void;
}

/**
 * Checks a per-key and a per-tenant token bucket in Redis. A request is limited
 * if either bucket is empty. If Redis errors, it falls open to per-process local
 * buckets and never blocks the request path on a Redis outage.
 */
export class RateLimiter {
  private readonly locals = new Map<string, LocalBucket>();

  constructor(
    private readonly redis: RedisEval,
    private readonly options: RateLimiterOptions,
  ) {}

  async check(tenantId: string, keyId: string, now: number = Date.now()): Promise<RateLimitDecision> {
    // Hash-tag by tenant so both buckets hash to the same Redis Cluster slot.
    const keyBucket = `{${tenantId}}:rl:key:${keyId}`;
    const tenantBucket = `{${tenantId}}:rl:tenant`;
    try {
      const [k, t] = await Promise.all([
        takeToken(this.redis, keyBucket, this.options.perKey, 1, now),
        takeToken(this.redis, tenantBucket, this.options.perTenant, 1, now),
      ]);
      if (k.allowed && t.allowed) {
        return { allowed: true, retryAfterSeconds: 0, source: "redis" };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(k.retryAfterSeconds, t.retryAfterSeconds, 1),
        source: "redis",
      };
    } catch (err) {
      this.options.onRedisError?.(err);
      return this.localCheck(tenantId, keyId, now);
    }
  }

  private localCheck(tenantId: string, keyId: string, now: number): RateLimitDecision {
    const key = this.localBucket(`key:${tenantId}:${keyId}`, this.options.perKey);
    const tenant = this.localBucket(`tenant:${tenantId}`, this.options.perTenant);
    // Take from both; limited if either is empty.
    const kOk = key.take(1, now);
    const tOk = tenant.take(1, now);
    const allowed = kOk && tOk;
    return { allowed, retryAfterSeconds: allowed ? 0 : 1, source: "local" };
  }

  private localBucket(id: string, config: TokenBucketConfig): LocalBucket {
    let bucket = this.locals.get(id);
    if (!bucket) {
      bucket = new LocalBucket(config);
      this.locals.set(id, bucket);
    }
    return bucket;
  }
}
