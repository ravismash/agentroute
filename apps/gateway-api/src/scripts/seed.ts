/**
 * Local demo data: one tenant, two customers with subscriptions, open cases,
 * Stripe test-mode payments to refund against, an operator, and credentials.
 *
 * Idempotent. Credentials are written once to `.dev-credentials.json`
 * (git-ignored, mode 600) instead of being printed; pass --rotate for new ones.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Database, issueApiKey, issueOperatorToken, migrate, randomBase62 } from "@agentroute/db";
import { loadConfig } from "../config.js";
import { FakePaymentGateway, StripePaymentGateway, type PaymentGateway } from "@agentroute/execution";

const CREDENTIALS_FILE = fileURLToPath(new URL("../../../../.dev-credentials.json", import.meta.url));
const TENANT = "acme";

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new Database({ connectionString: config.DATABASE_URL, applicationName: "agentroute-seed" });
const payments: PaymentGateway = config.STRIPE_SECRET_KEY
  ? new StripePaymentGateway(config.STRIPE_SECRET_KEY)
  : new FakePaymentGateway();

try {
  const client = await db.pool.connect();
  try {
    await migrate(client, { log: console.log });
  } finally {
    client.release();
  }

  await db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Acme Support') ON CONFLICT DO NOTHING`, [
    TENANT,
  ]);
  await db.query(
    `INSERT INTO customers (tenant_id, id, display_name, email) VALUES
       ($1, 'cus_ada', 'Ada Lovelace', 'ada@example.test'),
       ($1, 'cus_grace', 'Grace Hopper', 'grace@example.test')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await db.query(
    `INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency) VALUES
       ($1, 'sub_ada', 'cus_ada', 'pro', 'USD'),
       ($1, 'sub_grace', 'cus_grace', 'business', 'USD')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await db.query(
    `INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES
       ($1, 'case_1001', 'cus_ada', 'sub_ada', 'Charged twice for March'),
       ($1, 'case_1002', 'cus_grace', 'sub_grace', 'Wants a refund for unused annual seats')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );

  for (const customer of ["cus_ada", "cus_grace"]) {
    const existing = await db.query("SELECT 1 FROM payments WHERE tenant_id = $1 AND customer_id = $2", [
      TENANT,
      customer,
    ]);
    if (existing.rowCount) continue;
    const intent = await payments.createTestPayment(50_000, "USD", `AgentRoute demo payment for ${customer}`);
    await db.query(
      `INSERT INTO payments (tenant_id, id, customer_id, provider, provider_payment_id, amount_minor, currency)
       VALUES ($1, $2, $3, 'stripe', $4, 50000, 'USD')`,
      [TENANT, `pay_${customer}`, customer, intent],
    );
    console.log(`created ${payments.mode} payment ${intent} ($500.00) for ${customer}`);
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO operators (tenant_id, email, display_name, role)
     VALUES ($1, 'ops@acme.test', 'Acme Ops', 'operator')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [TENANT],
  );
  const operatorId = rows[0]?.id;
  if (!operatorId) throw new Error("operator upsert failed");

  if (!existsSync(CREDENTIALS_FILE) || process.argv.includes("--rotate")) {
    const credentials = {
      tenant_id: TENANT,
      api_key: await issueApiKey(db, TENANT, "local dev"),
      operator_token: await issueOperatorToken(db, operatorId),
      agent_service_token: randomBase62(40),
      payments_mode: payments.mode,
    };
    await writeFile(CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    console.log(`wrote credentials to ${CREDENTIALS_FILE} (git-ignored)`);
  } else {
    // Add fields introduced after the file was first written.
    const existing = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, unknown>;
    if (typeof existing.agent_service_token !== "string") {
      existing.agent_service_token = randomBase62(40);
      await writeFile(CREDENTIALS_FILE, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
      console.log("added agent_service_token to credentials file");
    }
    console.log(`credentials already in ${CREDENTIALS_FILE}; use --rotate to issue new ones`);
  }
  console.log("seed complete");
} finally {
  await db.close();
}
