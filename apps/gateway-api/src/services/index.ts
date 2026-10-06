import { Database } from "@agentroute/db";
import type { Logger } from "@agentroute/telemetry";
import { buildExecutors } from "../executors.js";
import { FakePaymentGateway, StripePaymentGateway, type PaymentGateway } from "../payments.js";
import type { V1Services } from "../routes/v1.js";
import { ExecutionService } from "./execution.js";
import { PolicyCatalog } from "./policy-catalog.js";
import { ProposalService } from "./proposals.js";

export interface ServiceOptions {
  databaseUrl: string;
  policiesDir: string;
  approvalTtlSeconds: number;
  stripeSecretKey?: string | undefined;
  /** Inject a payment gateway (tests). */
  payments?: PaymentGateway;
}

export interface Services extends V1Services {
  payments: PaymentGateway;
  policies: PolicyCatalog;
}

export async function createServices(options: ServiceOptions, log: Logger): Promise<Services> {
  const db = new Database({ connectionString: options.databaseUrl, applicationName: "agentroute-gateway" });
  const payments =
    options.payments ??
    (options.stripeSecretKey ? new StripePaymentGateway(options.stripeSecretKey) : new FakePaymentGateway());
  if (payments.mode === "fake") log.warn("STRIPE_SECRET_KEY not set: refunds use an in-memory fake");

  const policies = await PolicyCatalog.load(db, options.policiesDir, log);
  const execution = new ExecutionService(db, buildExecutors(db, payments), log);
  const proposals = new ProposalService(db, policies, execution, log, options.approvalTtlSeconds);
  return { db, payments, policies, execution, proposals };
}
