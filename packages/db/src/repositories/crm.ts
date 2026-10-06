import type { Queryable } from "../database.js";

/** Server-side facts the policy engine binds tool arguments to. */
export interface CaseContext {
  tenant: { id: string; kill_switch: boolean };
  case: { id: string; customer_id: string; subscription_id: string | null; status: string };
  customer: { id: string; display_name: string };
  subscription: { id: string; plan: string; currency: string; status: string } | null;
}

export async function loadCaseContext(
  q: Queryable,
  tenantId: string,
  caseId: string,
): Promise<CaseContext | undefined> {
  const { rows } = await q.query<{
    kill_switch: boolean;
    case_id: string;
    customer_id: string;
    subscription_id: string | null;
    case_status: string;
    display_name: string;
    sub_plan: string | null;
    sub_currency: string | null;
    sub_status: string | null;
  }>(
    `SELECT t.kill_switch, c.id AS case_id, c.customer_id, c.subscription_id, c.status AS case_status,
            cu.display_name, s.plan AS sub_plan, s.currency AS sub_currency, s.status AS sub_status
       FROM cases c
       JOIN tenants t ON t.id = c.tenant_id
       JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.id = c.customer_id
       LEFT JOIN subscriptions s ON s.tenant_id = c.tenant_id AND s.id = c.subscription_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, caseId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    tenant: { id: tenantId, kill_switch: r.kill_switch },
    case: {
      id: r.case_id,
      customer_id: r.customer_id,
      subscription_id: r.subscription_id,
      status: r.case_status,
    },
    customer: { id: r.customer_id, display_name: r.display_name },
    subscription:
      r.subscription_id && r.sub_plan && r.sub_currency && r.sub_status
        ? { id: r.subscription_id, plan: r.sub_plan, currency: r.sub_currency, status: r.sub_status }
        : null,
  };
}

export async function getCustomer(q: Queryable, tenantId: string, customerId: string) {
  const { rows } = await q.query<{
    id: string;
    display_name: string;
    email: string | null;
    created_at: Date;
  }>("SELECT id, display_name, email, created_at FROM customers WHERE tenant_id = $1 AND id = $2", [
    tenantId,
    customerId,
  ]);
  return rows[0];
}

export async function getSubscriptions(q: Queryable, tenantId: string, customerId: string) {
  const { rows } = await q.query<{
    id: string;
    plan: string;
    currency: string;
    status: string;
    current_period_end: Date | null;
  }>(
    `SELECT id, plan, currency, status, current_period_end FROM subscriptions
      WHERE tenant_id = $1 AND customer_id = $2 ORDER BY created_at`,
    [tenantId, customerId],
  );
  return rows;
}

export async function changeSubscriptionPlan(
  q: Queryable,
  tenantId: string,
  customerId: string,
  subscriptionId: string,
  plan: string,
): Promise<boolean> {
  const { rowCount } = await q.query(
    "UPDATE subscriptions SET plan = $4 WHERE tenant_id = $1 AND customer_id = $2 AND id = $3",
    [tenantId, customerId, subscriptionId, plan],
  );
  return rowCount === 1;
}

/**
 * Reserve `amount` against the customer's most recent payment that can still
 * cover it. The CHECK on payments.refunded_minor makes over-refunding impossible.
 */
export async function reserveRefund(
  q: Queryable,
  tenantId: string,
  customerId: string,
  currency: string,
  amountMinor: number,
): Promise<{ providerPaymentId: string } | undefined> {
  const { rows } = await q.query<{ provider_payment_id: string }>(
    `UPDATE payments p SET refunded_minor = p.refunded_minor + $4
      WHERE (p.tenant_id, p.id) = (
        SELECT tenant_id, id FROM payments
         WHERE tenant_id = $1 AND customer_id = $2 AND currency = $3 AND provider = 'stripe'
           AND amount_minor - refunded_minor >= $4
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE)
      RETURNING p.provider_payment_id`,
    [tenantId, customerId, currency, amountMinor],
  );
  return rows[0] ? { providerPaymentId: rows[0].provider_payment_id } : undefined;
}

/** Undo a reservation after a refund definitely did not happen. */
export async function releaseRefund(
  q: Queryable,
  tenantId: string,
  providerPaymentId: string,
  amountMinor: number,
): Promise<void> {
  const { rowCount } = await q.query(
    `UPDATE payments SET refunded_minor = refunded_minor - $3
      WHERE tenant_id = $1 AND provider = 'stripe' AND provider_payment_id = $2`,
    [tenantId, providerPaymentId, amountMinor],
  );
  if (rowCount !== 1) throw new Error(`payment ${providerPaymentId} not found while releasing refund`);
}
