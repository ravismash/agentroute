import { fileURLToPath } from "node:url";
import { HttpGateway } from "@agentroute/gateway-client";
import { createRetriever, embeddingsFromEnv } from "@agentroute/knowledge";
import { BudgetLedger, CircuitBreaker } from "@agentroute/limits";
import { createLogger } from "@agentroute/telemetry";
import { createClient, type RedisClientType } from "redis";
import { buildAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GuardedModel, ledgerBudgetGate, type BudgetGate } from "./guarded-model.js";
import { createModel } from "./model.js";

const config = loadConfig();
const logger = createLogger({ service: "supportops-agent", level: config.LOG_LEVEL });

if (!config.GATEWAY_API_KEY || !config.AGENT_SERVICE_TOKEN) {
  logger.fatal(
    "GATEWAY_API_KEY and AGENT_SERVICE_TOKEN are required (run `pnpm db:seed` for local credentials)",
  );
  process.exit(1);
}

const gateway = new HttpGateway({ baseUrl: config.GATEWAY_URL, apiKey: config.GATEWAY_API_KEY });
const knowledge = createRetriever(
  embeddingsFromEnv(process.env, fileURLToPath(new URL("../../../.cache/embeddings.json", import.meta.url))),
);
logger.info({ retrieval: knowledge.name }, "help-center retrieval ready");
const llm = config.llm;
if (!llm) logger.warn("no LLM configured: set OPENROUTER_API_KEY or OPENAI_API_KEY; runs will return 503");
else logger.info({ provider: llm.provider, model: llm.model }, "LLM configured");

// Phase 5 cost control: a shared daily LLM budget in Redis (fail-closed). Off
// unless REDIS_URL is set, so local runs and tests are unaffected.
let redis: RedisClientType | undefined;
let budget: BudgetGate | undefined;
if (llm && config.REDIS_URL) {
  try {
    redis = createClient({ url: config.REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
    budget = ledgerBudgetGate(new BudgetLedger(redis), {
      budgetId: config.AGENT_BUDGET_ID,
      ceilingMinor: config.AGENT_LLM_BUDGET_MINOR,
      estimateMinor: config.LLM_EST_COST_MINOR,
    });
    logger.info({ ceilingMinor: config.AGENT_LLM_BUDGET_MINOR }, "LLM budget enabled");
  } catch (err) {
    logger.warn({ err }, "LLM budget disabled: could not connect to Redis at boot");
    redis = undefined;
  }
}

// Open the circuit after repeated provider failures so a flaky LLM degrades to a
// human handoff rather than hammering the provider.
const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000, name: "llm" });
const retry = { retries: 2, baseMs: 250, maxMs: 2000, timeoutMs: 60_000 };

const app = buildAgentApp({
  logger,
  serviceToken: config.AGENT_SERVICE_TOKEN,
  runner: llm
    ? {
        gateway,
        modelFactory: () => new GuardedModel(createModel(llm), { breaker, retry, budget }),
        maxTurns: config.AGENT_MAX_TURNS,
        knowledge,
      }
    : undefined,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      if (redis) await redis.close();
      process.exit(0);
    })();
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
