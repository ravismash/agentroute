import { parseToolArgs, type KnownToolName, type ToolArgs } from "@agentroute/contracts";
import {
  changeSubscriptionPlan,
  getCustomer,
  getSubscriptions,
  releaseRefund,
  reserveRefund,
  type ExecutableAction,
  type ExecutionOutcome,
  type Queryable,
} from "@agentroute/db";
import type { PaymentGateway } from "./payments.js";

export interface Prepared {
  provider: "stripe" | "mock_crm";
  target: string | null;
  /** Set when the action can't be attempted at all (e.g. nothing to refund). */
  failure?: { code: string; message: string };
}

export interface ExecutionContext {
  tenantId: string;
  actionId: string;
  amountMinor: number | null;
  target: string | null;
}

export interface Performed {
  outcome: ExecutionOutcome;
  /** Data returned to the agent (read tools). */
  result?: unknown;
}

/**
 * Executes one tool. The service calls, in order:
 *   prepare  — inside the "begin" transaction (row locks held; reserve resources)
 *   perform  — outside any transaction (the side effect / provider call)
 *   complete — inside the "finish" transaction (release reservations on failure)
 *   reconcile — later, when the outcome was unknown
 */
export interface ToolExecutor {
  prepare(tx: Queryable, action: ExecutableAction): Promise<Prepared>;
  perform(action: ExecutableAction, prepared: Prepared, idempotencyKey: string): Promise<Performed>;
  complete(tx: Queryable, ctx: ExecutionContext, outcome: ExecutionOutcome): Promise<void>;
  reconcile(action: ExecutableAction, ctx: ExecutionContext): Promise<ExecutionOutcome>;
}

function argsOf<T extends KnownToolName>(tool: T, action: ExecutableAction): ToolArgs<T> {
  const parsed = parseToolArgs(tool, action.args);
  if (!parsed.ok) throw new Error(`stored args for ${action.id} no longer match the ${tool} schema`);
  return parsed.args as ToolArgs<T>;
}

export class RefundExecutor implements ToolExecutor {
  constructor(private readonly payments: PaymentGateway) {}

  async prepare(tx: Queryable, action: ExecutableAction): Promise<Prepared> {
    if (action.amountMinor === null || action.currency === null) {
      return {
        provider: "stripe",
        target: null,
        failure: { code: "INVALID_ACTION", message: "missing amount" },
      };
    }
    const reserved = await reserveRefund(
      tx,
      action.tenantId,
      action.customerId,
      action.currency,
      action.amountMinor,
    );
    if (!reserved) {
      return {
        provider: "stripe",
        target: null,
        failure: { code: "NO_REFUNDABLE_PAYMENT", message: "no payment can cover this refund" },
      };
    }
    return { provider: "stripe", target: reserved.providerPaymentId };
  }

  async perform(action: ExecutableAction, prepared: Prepared, idempotencyKey: string): Promise<Performed> {
    const args = argsOf("create_refund_request", action);
    if (!prepared.target || action.amountMinor === null) throw new Error("refund not prepared");
    const outcome = await this.payments.createRefund({
      paymentIntentId: prepared.target,
      amountMinor: action.amountMinor,
      reason: args.reason_code === "duplicate_charge" ? "duplicate" : "requested_by_customer",
      idempotencyKey,
      metadata: { action_id: action.id, tenant_id: action.tenantId },
    });
    return { outcome };
  }

  async complete(tx: Queryable, ctx: ExecutionContext, outcome: ExecutionOutcome): Promise<void> {
    // The refund definitely did not happen: give the reserved amount back.
    if (outcome.status === "failed" && ctx.target && ctx.amountMinor !== null) {
      await releaseRefund(tx, ctx.tenantId, ctx.target, ctx.amountMinor);
    }
  }

  reconcile(_action: ExecutableAction, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    if (!ctx.target)
      return Promise.resolve({ status: "failed", code: "INVALID_ACTION", message: "no target" });
    return this.payments.findRefund(ctx.target, ctx.actionId);
  }
}

/** Simulated CRM tools. Each operation is idempotent, so reconcile can simply re-run it. */
export class CrmExecutor implements ToolExecutor {
  constructor(
    private readonly db: Queryable,
    private readonly tool: Exclude<KnownToolName, "create_refund_request">,
  ) {}

  prepare(_tx: Queryable, action: ExecutableAction): Promise<Prepared> {
    return Promise.resolve({ provider: "mock_crm", target: action.customerId });
  }

  async perform(action: ExecutableAction): Promise<Performed> {
    const ref = `crm_${this.tool}_${action.id}`;
    switch (this.tool) {
      case "get_customer": {
        const customer = await getCustomer(this.db, action.tenantId, action.customerId);
        return customer
          ? { outcome: { status: "succeeded", providerRef: ref }, result: customer }
          : { outcome: { status: "failed", code: "CUSTOMER_NOT_FOUND", message: "customer not found" } };
      }
      case "get_subscription":
        return {
          outcome: { status: "succeeded", providerRef: ref },
          result: { subscriptions: await getSubscriptions(this.db, action.tenantId, action.customerId) },
        };
      case "draft_reply": {
        const args = argsOf("draft_reply", action);
        return {
          outcome: { status: "succeeded", providerRef: ref },
          result: { draft_id: ref, body: args.body },
        };
      }
      case "change_subscription_plan": {
        const args = argsOf("change_subscription_plan", action);
        const changed = await changeSubscriptionPlan(
          this.db,
          action.tenantId,
          action.customerId,
          args.subscription_id,
          args.target_plan,
        );
        return changed
          ? { outcome: { status: "succeeded", providerRef: ref }, result: { plan: args.target_plan } }
          : {
              outcome: {
                status: "failed",
                code: "SUBSCRIPTION_NOT_FOUND",
                message: "subscription not found",
              },
            };
      }
    }
  }

  complete(): Promise<void> {
    return Promise.resolve();
  }

  /** Simulated CRM operations are idempotent, so resolving an unknown outcome means re-running it. */
  async reconcile(action: ExecutableAction): Promise<ExecutionOutcome> {
    return (await this.perform(action)).outcome;
  }
}

export function buildExecutors(db: Queryable, payments: PaymentGateway): ReadonlyMap<string, ToolExecutor> {
  return new Map<string, ToolExecutor>([
    ["create_refund_request", new RefundExecutor(payments)],
    ["get_customer", new CrmExecutor(db, "get_customer")],
    ["get_subscription", new CrmExecutor(db, "get_subscription")],
    ["draft_reply", new CrmExecutor(db, "draft_reply")],
    ["change_subscription_plan", new CrmExecutor(db, "change_subscription_plan")],
  ]);
}
