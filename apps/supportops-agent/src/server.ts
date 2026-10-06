import { fileURLToPath } from "node:url";
import { HttpGateway } from "@agentroute/gateway-client";
import { createRetriever, embeddingsFromEnv } from "@agentroute/knowledge";
import { createLogger } from "@agentroute/telemetry";
import { buildAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
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

const app = buildAgentApp({
  logger,
  serviceToken: config.AGENT_SERVICE_TOKEN,
  runner: llm
    ? { gateway, modelFactory: () => createModel(llm), maxTurns: config.AGENT_MAX_TURNS, knowledge }
    : undefined,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
