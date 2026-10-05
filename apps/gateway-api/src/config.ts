import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parse and validate configuration once at boot; fail fast with a readable error. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
