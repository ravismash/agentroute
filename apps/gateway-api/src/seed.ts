import { issueApiKey, issueOperatorToken, randomBase62, type Database } from "@agentroute/db";
import type { PaymentGateway } from "@agentroute/execution";

export const DEMO_TENANT = "acme";

export interface DemoCredentials {
  tenant_id: string;
  api_key: string;
  operator_token: string;
  agent_service_token: string;
  payments_mode: string;
}

/**
 * Insert the demo world (idempotently): one tenant, two customers with
 * subscriptions, two open cases, and a payment per customer to refund against.
 * Returns issued credentials when `issueCredentials` is set.
 */
export async function seedDemoData(
  db: Database,
  payments: PaymentGateway,
  options: { issueCredentials?: boolean; log?: (message: string) => void } = {},
): Promise<DemoCredentials | undefined> {
  const log = options.log ?? (() => undefined);
  const t = DEMO_TENANT;

  await db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Acme Support') ON CONFLICT DO NOTHING`, [t]);
  await db.query(
    `INSERT INTO customers (tenant_id, id, display_name, email) VALUES
       ($1, 'cus_ada', 'Ada Lovelace', 'ada@example.test'),
       ($1, 'cus_grace', 'Grace Hopper', 'grace@example.test')
     ON CONFLICT DO NOTHING`,
    [t],
  );
  await db.query(
    `INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency) VALUES
       ($1, 'sub_ada', 'cus_ada', 'pro', 'USD'),
       ($1, 'sub_grace', 'cus_grace', 'business', 'USD')
     ON CONFLICT DO NOTHING`,
    [t],
  );
  await db.query(
    `INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES
       ($1, 'case_1001', 'cus_ada', 'sub_ada', 'Charged twice for March'),
       ($1, 'case_1002', 'cus_grace', 'sub_grace', 'Wants a refund for unused annual seats')
     ON CONFLICT DO NOTHING`,
    [t],
  );

  for (const customer of ["cus_ada", "cus_grace"]) {
    const existing = await db.query("SELECT 1 FROM payments WHERE tenant_id = $1 AND customer_id = $2", [
      t,
      customer,
    ]);
    if (existing.rowCount) continue;
    const ref = await payments.createTestPayment(50_000, "USD", `AgentRoute demo payment for ${customer}`);
    await db.query(
      `INSERT INTO payments (tenant_id, id, customer_id, provider, provider_payment_id, amount_minor, currency)
       VALUES ($1, $2, $3, 'stripe', $4, 50000, 'USD')`,
      [t, `pay_${customer}`, customer, ref],
    );
    log(`created ${payments.mode} payment ${ref} ($500.00) for ${customer}`);
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO operators (tenant_id, email, display_name, role)
     VALUES ($1, 'ops@acme.test', 'Acme Ops', 'operator')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [t],
  );
  const operatorId = rows[0]?.id;
  if (!operatorId) throw new Error("operator upsert failed");

  if (!options.issueCredentials) return undefined;
  return {
    tenant_id: t,
    api_key: await issueApiKey(db, t, "demo"),
    operator_token: await issueOperatorToken(db, operatorId),
    agent_service_token: randomBase62(40),
    payments_mode: payments.mode,
  };
}
