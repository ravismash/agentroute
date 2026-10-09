import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProposalResponse } from "@agentroute/contracts";
import { issueApiKey, issueOperatorToken, migrate } from "@agentroute/db";
import { createLogger } from "@agentroute/telemetry";
import pg from "pg";
import { inject } from "vitest";
import { buildApp, type GatewayApp } from "../app.js";
import { FakePaymentGateway } from "@agentroute/execution";
import type { V1Services } from "../routes/v1.js";
import { createServices, type Services } from "../services/index.js";

const POLICIES_DIR = fileURLToPath(new URL("../../../../policies", import.meta.url));

export interface Harness {
  app: GatewayApp;
  services: Services;
  payments: FakePaymentGateway;
  sql: pg.Client;
  keys: { acme: string; globex: string; acmeOperator: string; globexOperator: string; admin: string };
  propose: (
    body: Record<string, unknown>,
    options?: { key?: string; idempotencyKey?: string },
  ) => Promise<{ status: number; body: ProposalResponse & { code?: string } }>;
  decide: (
    actionId: string,
    decision: "approve" | "reject",
    token?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Clear actions and restore fixtures between tests (TRUNCATE bypasses the no-delete row triggers). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

const FIXTURES = `
  INSERT INTO tenants (id, name) VALUES ('acme', 'Acme'), ('globex', 'Globex');
  INSERT INTO customers (tenant_id, id, display_name, email) VALUES
    ('acme', 'cus_ada', 'Ada Lovelace', 'ada@example.test'),
    ('acme', 'cus_grace', 'Grace Hopper', NULL),
    ('acme', 'cus_nopay', 'No Payments', NULL),
    ('globex', 'cus_hank', 'Hank Scorpio', NULL);
  INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency) VALUES
    ('acme', 'sub_ada', 'cus_ada', 'pro', 'USD'),
    ('acme', 'sub_grace', 'cus_grace', 'starter', 'USD'),
    ('acme', 'sub_nopay', 'cus_nopay', 'starter', 'USD'),
    ('globex', 'sub_hank', 'cus_hank', 'business', 'USD');
  INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES
    ('acme', 'case_1', 'cus_ada', 'sub_ada', 'Double charged'),
    ('acme', 'case_2', 'cus_grace', 'sub_grace', 'Refund request'),
    ('acme', 'case_3', 'cus_nopay', 'sub_nopay', 'No payment to refund'),
    ('globex', 'case_9', 'cus_hank', 'sub_hank', 'Other tenant');
  INSERT INTO payments (tenant_id, id, customer_id, provider, provider_payment_id, amount_minor, currency) VALUES
    ('acme', 'pay_ada', 'cus_ada', 'stripe', 'pi_test_ada', 50000, 'USD'),
    ('acme', 'pay_grace', 'cus_grace', 'stripe', 'pi_test_grace', 50000, 'USD'),
    ('globex', 'pay_hank', 'cus_hank', 'stripe', 'pi_test_hank', 50000, 'USD');
`;

export interface HarnessOptions {
  /** Inject a rate limiter to exercise the 429 path; off by default. */
  rateLimiter?: V1Services["rateLimiter"];
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `gw_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  const sql = new pg.Client({ connectionString: url.toString() });
  await sql.connect();
  await migrate(sql);
  await sql.query(FIXTURES);
  const operators = await sql.query<{ id: string; email: string }>(`
    INSERT INTO operators (tenant_id, email, display_name, role) VALUES
      ('acme', 'ops@acme.test', 'Acme Ops', 'operator'),
      ('globex', 'ops@globex.test', 'Globex Ops', 'operator'),
      (NULL, 'admin@agentroute.test', 'Platform Admin', 'admin')
    RETURNING id, email`);
  const operatorId = (email: string) => {
    const id = operators.rows.find((r) => r.email === email)?.id;
    if (!id) throw new Error(`missing operator ${email}`);
    return id;
  };
  const keys = {
    acme: await issueApiKey(sql, "acme", "test"),
    globex: await issueApiKey(sql, "globex", "test"),
    acmeOperator: await issueOperatorToken(sql, operatorId("ops@acme.test")),
    globexOperator: await issueOperatorToken(sql, operatorId("ops@globex.test")),
    admin: await issueOperatorToken(sql, operatorId("admin@agentroute.test")),
  };

  const logger = createLogger({ service: "test", level: "silent" });
  const payments = new FakePaymentGateway();
  const services = await createServices(
    {
      databaseUrl: url.toString(),
      policiesDir: POLICIES_DIR,
      approvalTtlSeconds: 3600,
      payments,
      rateLimiter: options.rateLimiter,
    },
    logger,
  );
  const app = buildApp({ logger, services });

  let counter = 0;
  return {
    app,
    services,
    payments,
    sql,
    keys,
    propose: async (body, options = {}) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/proposals",
        headers: {
          authorization: `Bearer ${options.key ?? keys.acme}`,
          "idempotency-key":
            options.idempotencyKey ?? `test-key-${++counter}-${randomBytes(4).toString("hex")}`,
        },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() };
    },
    decide: async (actionId, decision, token = keys.acmeOperator) => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/approvals/${actionId}/${decision}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      return { status: res.statusCode, body: res.json() };
    },
    reset: async () => {
      await sql.query(`
        TRUNCATE outbox, executions, approvals, decisions, actions;
        UPDATE payments SET refunded_minor = 0;
        UPDATE tenants SET kill_switch = false;
        UPDATE subscriptions SET plan = 'pro' WHERE id = 'sub_ada';`);
      payments.refunds.clear();
      payments.nextBehaviours.length = 0;
      payments.timeoutsStillRefund = true;
      payments.createRefundCalls = 0;
    },
    close: async () => {
      await app.close();
      await services.db.close();
      await sql.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function refund(amountMinor: number, overrides: Record<string, unknown> = {}) {
  const { case_id = "case_1", ...args } = overrides;
  return {
    agent_id: "supportops",
    case_id,
    tool: "create_refund_request",
    args: {
      customer_id: "cus_ada",
      amount_minor: amountMinor,
      currency: "USD",
      reason_code: "duplicate_charge",
      ...args,
    },
  };
}
