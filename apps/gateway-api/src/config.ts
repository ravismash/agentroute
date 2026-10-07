import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_POLICIES_DIR = fileURLToPath(new URL("../../../policies", import.meta.url));

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().startsWith("postgres").optional()),
  STRIPE_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^(sk|rk)_test_[A-Za-z0-9]+$/, "must be a Stripe *test-mode* secret or restricted key")
      .optional(),
  ),
  POLICIES_DIR: z.string().default(DEFAULT_POLICIES_DIR),
  APPROVAL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 86400)
    .default(86400),
  JOBS_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  /** Approval expiry and reconciliation normally run in the worker; enable only for single-process setups. */
  RUN_BACKGROUND_JOBS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Run DB migrations at startup (for platforms without a pre-deploy step, e.g. Render free tier). */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
// Note: without STRIPE_SECRET_KEY the gateway runs with an in-memory fake payment
// gateway (logged as a warning at startup). This keeps demo deploys bootable; a
// real deployment should always set a Stripe key.

export type Config = z.infer<typeof ConfigSchema>;

/** Parse and validate configuration once at boot; fail fast with a readable error. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
