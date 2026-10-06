import { createClient } from "redis";

/** The single place Redis clients are created, so every module shares one client type. */
export function createRedis(url: string) {
  return createClient({ url });
}

export type RedisClient = ReturnType<typeof createRedis>;
