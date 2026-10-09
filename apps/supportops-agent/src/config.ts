import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_CREDENTIALS_FILE = fileURLToPath(new URL("../../../.dev-credentials.json", import.meta.url));
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  HOST: z.string().default("0.0.0.0"),
  GATEWAY_URL: z.url().default("http://localhost:8080"),
  /** Tenant API key the agent uses to submit proposals. */
  GATEWAY_API_KEY: optionalString,
  /** Bearer token callers (e.g. a helpdesk) present to start runs. */
  AGENT_SERVICE_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["openai", "openrouter"]).optional()),
  OPENAI_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  AGENT_MODEL: optionalString,
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(20).default(8),
  CREDENTIALS_FILE: z.string().default(DEFAULT_CREDENTIALS_FILE),
  // Phase 5 cost control: when REDIS_URL is set, each model call reserves
  // LLM_EST_COST_MINOR against a daily ceiling (AGENT_LLM_BUDGET_MINOR) in the
  // shared Redis ledger, keyed by AGENT_BUDGET_ID. Fail-closed when Redis is down.
  REDIS_URL: z.preprocess(emptyToUndefined, z.string().startsWith("redis").optional()),
  AGENT_LLM_BUDGET_MINOR: z.coerce.number().int().positive().default(200),
  AGENT_BUDGET_ID: z.string().min(1).default("supportops"),
  LLM_EST_COST_MINOR: z.coerce.number().int().positive().default(1),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface LlmConfig {
  provider: "openai" | "openrouter";
  apiKey: string;
  model: string;
}

export interface Config extends RawConfig {
  llm: LlmConfig | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;

  // Local development convenience: fall back to the seed's git-ignored credentials file.
  if (config.NODE_ENV === "development" && existsSync(config.CREDENTIALS_FILE)) {
    const creds = z
      .object({ api_key: z.string().optional(), agent_service_token: z.string().optional() })
      .parse(JSON.parse(readFileSync(config.CREDENTIALS_FILE, "utf8")));
    config.GATEWAY_API_KEY ??= creds.api_key;
    config.AGENT_SERVICE_TOKEN ??= creds.agent_service_token;
  }

  return { ...config, llm: resolveLlm(config) };
}

function resolveLlm(c: RawConfig): LlmConfig | undefined {
  const provider =
    c.LLM_PROVIDER ?? (c.OPENROUTER_API_KEY ? "openrouter" : c.OPENAI_API_KEY ? "openai" : undefined);
  if (!provider) return undefined;
  const apiKey = provider === "openrouter" ? c.OPENROUTER_API_KEY : c.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`LLM_PROVIDER=${provider} but its API key is not set`);
  const model =
    c.AGENT_MODEL ??
    (provider === "openrouter"
      ? DEFAULT_OPENROUTER_MODEL
      : DEFAULT_OPENROUTER_MODEL.replace(/^openai\//, ""));
  return { provider, apiKey, model };
}
