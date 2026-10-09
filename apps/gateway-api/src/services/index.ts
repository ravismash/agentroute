import { Database } from "@agentroute/db";
import { RateLimiter } from "@agentroute/limits";
import type { Logger, Metrics } from "@agentroute/telemetry";
import {
  buildExecutors,
  ExecutionService,
  FakePaymentGateway,
  StripePaymentGateway,
  type PaymentGateway,
} from "@agentroute/execution";
import { createClient, type RedisClientType } from "redis";
import type { V1Services } from "../routes/v1.js";
import { PolicyCatalog } from "./policy-catalog.js";
import { ProposalService } from "./proposals.js";

export interface RateLimitSettings {
  perKey: { capacity: number; refillPerSecond: number };
  perTenant: { capacity: number; refillPerSecond: number };
}

export interface ServiceOptions {
  databaseUrl: string;
  policiesDir: string;
  approvalTtlSeconds: number;
  stripeSecretKey?: string | undefined;
  /** Enables per-key/per-tenant rate limiting on proposals when set. */
  redisUrl?: string | undefined;
  rateLimits?: RateLimitSettings;
  /** Inject a payment gateway (tests). */
  payments?: PaymentGateway;
  /** Inject a rate limiter (tests); overrides redisUrl. */
  rateLimiter?: V1Services["rateLimiter"];
  /** Metrics registry shared with the HTTP layer; instruments the decision path. */
  metrics?: Metrics;
}

export interface Services extends V1Services {
  payments: PaymentGateway;
  policies: PolicyCatalog;
  /** Open Redis client backing the rate limiter, if any; closed on shutdown. */
  redis?: RedisClientType;
}

export async function createServices(options: ServiceOptions, log: Logger): Promise<Services> {
  const db = new Database({ connectionString: options.databaseUrl, applicationName: "agentroute-gateway" });
  const payments =
    options.payments ??
    (options.stripeSecretKey ? new StripePaymentGateway(options.stripeSecretKey) : new FakePaymentGateway());
  if (payments.mode === "fake") log.warn("STRIPE_SECRET_KEY not set: refunds use an in-memory fake");

  let rateLimiter = options.rateLimiter;
  let redis: RedisClientType | undefined;
  if (!rateLimiter && options.redisUrl && options.rateLimits) {
    // Fail-open: if Redis can't be reached at boot, start without a limiter
    // rather than refusing to serve (availability over precision).
    try {
      redis = createClient({ url: options.redisUrl });
      redis.on("error", () => undefined); // handled per-call by the limiter's fail-open path
      await redis.connect();
      rateLimiter = new RateLimiter(redis, {
        perKey: options.rateLimits.perKey,
        perTenant: options.rateLimits.perTenant,
        onRedisError: (err) => {
          log.warn({ err }, "rate limiter falling open: Redis unavailable");
        },
      });
      log.info("rate limiting enabled");
    } catch (err) {
      log.warn({ err }, "rate limiting disabled: could not connect to Redis at boot");
      redis = undefined;
    }
  }

  const policies = await PolicyCatalog.load(db, options.policiesDir, log);
  const execution = new ExecutionService(db, buildExecutors(db, payments), log);
  const proposals = new ProposalService(
    db,
    policies,
    execution,
    log,
    options.approvalTtlSeconds,
    options.metrics,
  );
  return { db, payments, policies, execution, proposals, rateLimiter, redis, metrics: options.metrics };
}
