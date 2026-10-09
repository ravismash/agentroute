import { runMigrations } from "@agentroute/db";
import { createLogger, Metrics, startTracing } from "@agentroute/telemetry";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startBackgroundJobs } from "./jobs.js";
import { seedDemoData } from "./seed.js";
import { createServices } from "./services/index.js";

const SERVICE = "gateway-api";

const config = loadConfig();
const tracing = startTracing(SERVICE, config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
const metrics = new Metrics();

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
    redisUrl: config.REDIS_URL,
    rateLimits: {
      perKey: { capacity: config.RATE_LIMIT_PER_KEY_BURST, refillPerSecond: config.RATE_LIMIT_PER_KEY_RPS },
      perTenant: {
        capacity: config.RATE_LIMIT_PER_TENANT_BURST,
        refillPerSecond: config.RATE_LIMIT_PER_TENANT_RPS,
      },
    },
    metrics,
  },
  logger,
);
if (config.SEED_ON_START) {
  // Demo convenience for platforms without a shell (e.g. Render free tier):
  // seed the demo world and log fresh credentials so they can be copied from
  // the service logs. Not for real deployments — it prints a usable token.
  try {
    const creds = await seedDemoData(services.db, services.payments, {
      issueCredentials: true,
      log: (m) => {
        logger.info({ seed: m }, "seed");
      },
    });
    if (creds) {
      // Intentional plaintext to the service logs (demo only). The structured
      // logger would redact key-shaped strings, so print directly.
      console.log("\n=== AgentRoute demo credentials (SEED_ON_START) ===");
      console.log(`operator_token : ${creds.operator_token}   ← paste into /ui/`);
      console.log(`api_key        : ${creds.api_key}`);
      console.log(`payments_mode  : ${creds.payments_mode}`);
      console.log("Copy these, then remove SEED_ON_START from the environment.\n");
    }
  } catch (err) {
    logger.error({ err }, "seed-on-start failed");
  }
}

const jobs = config.RUN_BACKGROUND_JOBS
  ? startBackgroundJobs(services.db, services.execution, logger, config.JOBS_INTERVAL_MS)
  : { stop: () => Promise.resolve() };
const app = buildApp({
  logger,
  services,
  metrics,
  readinessChecks: { postgres: () => services.db.ping() },
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await app.close();
  await jobs.stop();
  if (services.redis) await services.redis.close();
  await services.db.close();
  await tracing.shutdown();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (s) => void shutdown(s));
}

await app.listen({ port: config.PORT, host: config.HOST });
