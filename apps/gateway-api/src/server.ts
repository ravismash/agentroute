import { runMigrations } from "@agentroute/db";
import { createLogger, startTracing } from "@agentroute/telemetry";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startBackgroundJobs } from "./jobs.js";
import { createServices } from "./services/index.js";

const SERVICE = "gateway-api";

const config = loadConfig();
const tracing = startTracing(SERVICE, config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

if (!config.DATABASE_URL) {
  logger.fatal("DATABASE_URL is required");
  process.exit(1);
}

if (config.MIGRATE_ON_START) {
  // Idempotent and advisory-locked, so it is safe to run on every boot and
  // across concurrent instances. Used where there is no separate migrate step.
  const result = await runMigrations(config.DATABASE_URL, {
    log: (m) => {
      logger.info({ migration: m }, "migrated");
    },
  });
  logger.info({ applied: result.applied.length }, "migrations up to date");
}

const services = await createServices(
  {
    databaseUrl: config.DATABASE_URL,
    policiesDir: config.POLICIES_DIR,
    approvalTtlSeconds: config.APPROVAL_TTL_SECONDS,
    stripeSecretKey: config.STRIPE_SECRET_KEY,
  },
  logger,
);
const jobs = config.RUN_BACKGROUND_JOBS
  ? startBackgroundJobs(services.db, services.execution, logger, config.JOBS_INTERVAL_MS)
  : { stop: () => Promise.resolve() };
const app = buildApp({ logger, services, readinessChecks: { postgres: () => services.db.ping() } });

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await app.close();
  await jobs.stop();
  await services.db.close();
  await tracing.shutdown();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (s) => void shutdown(s));
}

await app.listen({ port: config.PORT, host: config.HOST });
