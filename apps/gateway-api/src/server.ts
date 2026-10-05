import { createLogger, startTracing } from "@agentroute/telemetry";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const SERVICE = "gateway-api";

const config = loadConfig();
const tracing = startTracing(SERVICE, config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
const app = buildApp({ logger });

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await app.close();
  await tracing.shutdown();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (s) => void shutdown(s));
}

await app.listen({ port: config.PORT, host: config.HOST });
