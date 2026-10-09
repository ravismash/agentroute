/**
 * A Redis-backed token bucket. Refill and take happen atomically inside a Lua
 * script, so concurrent callers can never over-draw the bucket (R-03 analogue
 * for rate limiting). One round trip per check.
 */

/** The slice of a Redis client this module needs (matches node-redis `eval`). */
export interface RedisEval {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface TokenBucketConfig {
  /** Maximum tokens the bucket holds (the burst size). */
  capacity: number;
  /** Tokens added per second (the sustained rate). */
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Tokens left after this take (floored). */
  remaining: number;
  /** When denied, whole seconds the caller should wait before retrying. */
  retryAfterSeconds: number;
}

// Refill based on elapsed wall-clock, then take `cost` if available. Returns
// {allowed, remaining, retryAfterMs}. Keys are hash-tagged by the caller so a
// bucket lives on one Redis Cluster node.
const TAKE = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / refill) * 1000)
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)
return {allowed, math.floor(tokens), retry}
`;

/** Atomically take `cost` tokens from `key`. Throws if Redis is unreachable. */
export async function takeToken(
  redis: RedisEval,
  key: string,
  config: TokenBucketConfig,
  cost = 1,
  now: number = Date.now(),
): Promise<TakeResult> {
  const raw = (await redis.eval(TAKE, {
    keys: [key],
    arguments: [String(config.capacity), String(config.refillPerSecond), String(now), String(cost)],
  })) as [number, number, number];
  return {
    allowed: raw[0] === 1,
    remaining: raw[1],
    retryAfterSeconds: Math.ceil(raw[2] / 1000),
  };
}
