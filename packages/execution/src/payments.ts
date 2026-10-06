import type { ExecutionOutcome } from "@agentroute/db";
import Stripe from "stripe";

export interface RefundRequest {
  paymentIntentId: string;
  amountMinor: number;
  reason: "duplicate" | "requested_by_customer";
  idempotencyKey: string;
  metadata: { action_id: string; tenant_id: string };
}

/**
 * The narrow slice of Stripe AgentRoute needs. Keeping it behind an interface
 * lets tests (and local dev without a key) use a deterministic fake.
 */
export interface PaymentGateway {
  readonly mode: "stripe" | "fake";
  createRefund(request: RefundRequest): Promise<ExecutionOutcome>;
  /** Look up a refund we may have created, by our action id. Used to resolve unknown outcomes. */
  findRefund(paymentIntentId: string, actionId: string): Promise<ExecutionOutcome>;
  createTestPayment(amountMinor: number, currency: string, description: string): Promise<string>;
}

interface StripeLikeError {
  type?: string;
  statusCode?: number;
  code?: string;
  message?: string;
}

/**
 * Map a Stripe failure to an outcome. Network failures and 5xx are *unknown*
 * (the refund may have happened); 4xx and rate limits are definite failures.
 */
export function classifyStripeError(err: unknown): ExecutionOutcome {
  const e = err as StripeLikeError;
  const message = e.message ?? String(err);
  if (e.type === "StripeConnectionError" || (e.statusCode !== undefined && e.statusCode >= 500)) {
    return { status: "unknown", message };
  }
  if (e.type === "StripeAPIError" && e.statusCode === undefined) return { status: "unknown", message };
  if (e.type === "StripeRateLimitError") return { status: "failed", code: "PROVIDER_RATE_LIMITED", message };
  return { status: "failed", code: e.code ?? e.type ?? "PROVIDER_ERROR", message };
}

function refundOutcome(refund: { id: string; status: string | null }): ExecutionOutcome {
  return refund.status === "failed" || refund.status === "canceled"
    ? {
        status: "failed",
        code: `REFUND_${refund.status.toUpperCase()}`,
        message: `refund ${refund.id} ${refund.status}`,
      }
    : { status: "succeeded", providerRef: refund.id };
}

export class StripePaymentGateway implements PaymentGateway {
  readonly mode = "stripe" as const;
  private readonly client: Stripe;

  constructor(secretKey: string) {
    if (!/^(sk|rk)_test_/.test(secretKey)) {
      throw new Error("refusing to start: only Stripe test-mode keys (sk_test_/rk_test_) are allowed");
    }
    this.client = new Stripe(secretKey, {
      timeout: 10_000,
      // Safe: every mutating call carries our idempotency key.
      maxNetworkRetries: 2,
      appInfo: { name: "agentroute", version: "0.1.0" },
    });
  }

  async createRefund(r: RefundRequest): Promise<ExecutionOutcome> {
    try {
      const refund = await this.client.refunds.create(
        { payment_intent: r.paymentIntentId, amount: r.amountMinor, reason: r.reason, metadata: r.metadata },
        { idempotencyKey: r.idempotencyKey },
      );
      return refundOutcome(refund);
    } catch (err) {
      return classifyStripeError(err);
    }
  }

  async findRefund(paymentIntentId: string, actionId: string): Promise<ExecutionOutcome> {
    try {
      for await (const refund of this.client.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
        if (refund.metadata?.action_id === actionId) return refundOutcome(refund);
      }
      return { status: "failed", code: "REFUND_NOT_FOUND", message: "no refund was created for this action" };
    } catch (err) {
      const outcome = classifyStripeError(err);
      return outcome.status === "failed" ? { status: "unknown", message: outcome.message } : outcome;
    }
  }

  async createTestPayment(amountMinor: number, currency: string, description: string): Promise<string> {
    const intent = await this.client.paymentIntents.create({
      amount: amountMinor,
      currency: currency.toLowerCase(),
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description,
    });
    if (intent.status !== "succeeded") throw new Error(`test payment ${intent.id} is ${intent.status}`);
    return intent.id;
  }
}

type FakeBehaviour = "succeed" | "timeout" | "decline";

/**
 * In-memory Stripe stand-in with real idempotency semantics: the same key
 * returns the same refund. Tests script failures with `nextBehaviours`.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly mode = "fake" as const;
  readonly refunds = new Map<
    string,
    { id: string; paymentIntentId: string; amountMinor: number; actionId: string }
  >();
  readonly nextBehaviours: FakeBehaviour[] = [];
  /** Refunds that happened at the provider even though the caller saw a timeout. */
  timeoutsStillRefund = true;
  createRefundCalls = 0;
  private counter = 0;

  createRefund(r: RefundRequest): Promise<ExecutionOutcome> {
    this.createRefundCalls++;
    const behaviour = this.nextBehaviours.shift() ?? "succeed";
    const existing = this.refunds.get(r.idempotencyKey);
    if (existing) return Promise.resolve({ status: "succeeded", providerRef: existing.id });
    if (behaviour === "decline") {
      return Promise.resolve({
        status: "failed",
        code: "charge_already_refunded",
        message: "declined (fake)",
      });
    }
    if (behaviour === "timeout" && !this.timeoutsStillRefund) {
      return Promise.resolve({ status: "unknown", message: "timeout (fake)" });
    }
    const refund = {
      id: `re_fake_${++this.counter}`,
      paymentIntentId: r.paymentIntentId,
      amountMinor: r.amountMinor,
      actionId: r.metadata.action_id,
    };
    this.refunds.set(r.idempotencyKey, refund);
    return Promise.resolve(
      behaviour === "timeout"
        ? { status: "unknown", message: "timeout (fake)" }
        : { status: "succeeded", providerRef: refund.id },
    );
  }

  findRefund(paymentIntentId: string, actionId: string): Promise<ExecutionOutcome> {
    for (const r of this.refunds.values()) {
      if (r.paymentIntentId === paymentIntentId && r.actionId === actionId) {
        return Promise.resolve({ status: "succeeded", providerRef: r.id });
      }
    }
    return Promise.resolve({ status: "failed", code: "REFUND_NOT_FOUND", message: "not found (fake)" });
  }

  createTestPayment(): Promise<string> {
    return Promise.resolve(`pi_fake_${++this.counter}`);
  }
}
