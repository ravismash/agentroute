import { Database } from "@agentroute/db";
import {
  buildExecutors,
  ExecutionService,
  FakePaymentGateway,
  StripePaymentGateway,
} from "@agentroute/execution";
import { createLogger } from "@agentroute/telemetry";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { StreamConsumer, type ConsumerOptions } from "./consumer.js";
import { auditHandler } from "./handlers/audit.js";
import { statsHandler } from "./handlers/stats.js";
import { Maintenance, pipelineStatus } from "./maintenance.js";
import { createRedis } from "./redis.js";
import { OutboxRelay } from "./relay.js";

const config = loadConfig();
const log = createLogger({ service: "worker", level: config.LOG_LEVEL });
const db = new Database({ connectionString: config.DATABASE_URL, applicationName: "agentroute-worker" });

const redis = createRedis(config.REDIS_URL);
redis.on("error", (err: unknown) => {
  log.error({ err }, "redis error");
});
await redis.connect();

const relay = new OutboxRelay(
  db,
  redis,
  {
    stream: config.STREAM_KEY,
    batchSize: config.RELAY_BATCH_SIZE,
    pollMs: config.RELAY_POLL_MS,
    maxLen: config.STREAM_MAXLEN,
  },
  log,
);

const consumerOptions: ConsumerOptions = {
  stream: config.STREAM_KEY,
  dlqStream: config.DLQ_STREAM_KEY,
  consumerName: config.CONSUMER_NAME,
  batchSize: config.CONSUMER_BATCH_SIZE,
  blockMs: config.CONSUMER_BLOCK_MS,
  claimIdleMs: config.CLAIM_IDLE_MS,
  maxDeliveries: config.MAX_DELIVERIES,
};
// Each consumer blocks on XREADGROUP, so each gets its own connection.
const consumers = await Promise.all(
  [auditHandler, statsHandler].map(async (handler) => {
    const connection = createRedis(config.REDIS_URL);
    connection.on("error", (err: unknown) => {
      log.error({ err, consumer: handler.name }, "redis error");
    });
    await connection.connect();
    return { consumer: new StreamConsumer(db, connection, handler, consumerOptions, log), connection };
  }),
);

const payments = config.STRIPE_SECRET_KEY
  ? new StripePaymentGateway(config.STRIPE_SECRET_KEY)
  : new FakePaymentGateway();
const maintenance = new Maintenance(db, new ExecutionService(db, buildExecutors(db, payments), log), log);

await relay.start(config.DATABASE_URL);
for (const { consumer } of consumers) await consumer.start();
maintenance.start(config.JOBS_INTERVAL_MS);

const http = Fastify({ loggerInstance: log, disableRequestLogging: true });
http.get("/healthz", () => ({ status: "ok" }));
http.get("/readyz", async (_req, reply) => {
  try {
    await Promise.all([db.ping(), redis.ping()]);
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});
http.get("/status", () => pipelineStatus(db, redis, config.STREAM_KEY));
await http.listen({ port: config.PORT, host: config.HOST });
log.info(
  { consumers: consumers.map((c) => c.consumer.group), consumer_name: config.CONSUMER_NAME },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "worker shutting down");
  await http.close();
  await relay.stop();
  for (const { consumer } of consumers) await consumer.stop();
  await maintenance.stop();
  for (const { connection } of consumers) await connection.quit().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await db.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (s) => void shutdown(s));
}
