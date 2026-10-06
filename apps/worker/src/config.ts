import { hostname } from "node:os";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8082),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().startsWith("postgres"),
  REDIS_URL: z.string().startsWith("redis"),
  STRIPE_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^(sk|rk)_test_/)
      .optional(),
  ),
  STREAM_KEY: z.string().default("agentroute:events"),
  DLQ_STREAM_KEY: z.string().default("agentroute:events:dlq"),
  /** Approximate cap on stream length; the Postgres outbox remains the source of truth. */
  STREAM_MAXLEN: z.coerce.number().int().min(1000).default(100_000),
  RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  RELAY_POLL_MS: z.coerce.number().int().min(50).default(1000),
  CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  CONSUMER_BLOCK_MS: z.coerce.number().int().min(10).default(2000),
  /** A message unacknowledged this long is assumed abandoned by a crashed consumer. */
  CLAIM_IDLE_MS: z.coerce.number().int().min(100).default(30_000),
  MAX_DELIVERIES: z.coerce.number().int().min(1).max(100).default(5),
  JOBS_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  CONSUMER_NAME: z.string().default(`${hostname()}-${process.pid}`),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
