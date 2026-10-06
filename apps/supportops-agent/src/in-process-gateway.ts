import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionView, ProposalResponse, type ActionState, type ProposalRequest } from "@agentroute/contracts";
import { GatewayError, type Gateway } from "@agentroute/gateway-client";
import {
  evaluate,
  loadPolicy,
  planUsage,
  type CompiledPolicy,
  type EvaluationContext,
  type UsageQuery,
} from "@agentroute/policy-engine";

export const BASELINE_POLICY_PATH = fileURLToPath(
  new URL("../../../policies/support-agent-baseline.v1.yaml", import.meta.url),
);

export interface WorldCustomer {
  id: string;
  display_name: string;
  subscription: { id: string; plan: string; currency: string; status: string };
}

export interface World {
  tenantId: string;
  cases: Record<string, { customer_id: string }>;
  customers: Record<string, WorldCustomer>;
  /** Refunds already made (e.g. earlier the same day) per customer/case. */
  priorRefunds?: { customer_id: string; case_id: string; amount_minor: number }[];
}

interface Recorded {
  id: string;
  request: ProposalRequest;
  response: ProposalResponse;
  customerId: string;
  createdAt: string;
}

const COUNTED: readonly ActionState[] = [
  "allowed",
  "approval_required",
  "approved",
  "executing",
  "succeeded",
  "failed",
];

/**
 * A gateway that runs the real policy engine in-process against an in-memory
 * world. Evals use it so they measure the *model's* behaviour with real policy
 * decisions, without a database, Stripe, or side effects.
 */
export class InProcessGateway implements Gateway {
  readonly log: Recorded[] = [];
  private readonly byKey = new Map<string, Recorded>();
  private readonly policy: CompiledPolicy;

  constructor(
    private readonly world: World,
    policySource: string = readFileSync(BASELINE_POLICY_PATH, "utf8"),
  ) {
    const loaded = loadPolicy(policySource);
    if (!loaded.ok) throw new Error(`invalid policy: ${loaded.errors.join("; ")}`);
    this.policy = loaded.policy;
    for (const prior of world.priorRefunds ?? []) {
      const request: ProposalRequest = {
        agent_id: "supportops",
        case_id: prior.case_id,
        tool: "create_refund_request",
        args: { customer_id: prior.customer_id, amount_minor: prior.amount_minor },
      };
      this.record(request, prior.customer_id, "allow", "succeeded");
    }
  }

  propose(request: ProposalRequest, idempotencyKey: string): Promise<ProposalResponse> {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing.response);

    const caseInfo = this.world.cases[request.case_id];
    if (!caseInfo) return Promise.reject(new GatewayError(404, undefined, "NOT_FOUND: case not found"));
    const customer = this.world.customers[caseInfo.customer_id];
    if (!customer) return Promise.reject(new GatewayError(404, undefined, "NOT_FOUND: customer not found"));

    const ctx: EvaluationContext = {
      tenant_id: this.world.tenantId,
      agent_id: request.agent_id,
      case: { id: request.case_id, customer_id: caseInfo.customer_id },
      customer: { id: customer.id, display_name: customer.display_name },
      subscription: { ...customer.subscription },
      ...(request.tool === "draft_reply"
        ? {
            evidence: {
              actions: this.log
                .filter((r) => r.request.case_id === request.case_id && r.request.tool !== "draft_reply")
                .map((r) => ({
                  tool: r.request.tool,
                  state: r.response.state,
                  amount_minor:
                    typeof r.request.args.amount_minor === "number" ? r.request.args.amount_minor : null,
                  currency: typeof r.request.args.currency === "string" ? r.request.args.currency : null,
                  target_plan:
                    typeof r.request.args.target_plan === "string" ? r.request.args.target_plan : null,
                })),
              current_plan: customer.subscription.plan,
            },
          }
        : {}),
    };
    const proposal = { tool: request.tool, args: request.args };
    const usage = Object.fromEntries(
      planUsage(this.policy, proposal, ctx).map((q) => [q.key, this.usage(q, caseInfo.customer_id)]),
    );
    const decision = evaluate(this.policy, proposal, ctx, usage);

    const state: ActionState =
      decision.effect === "allow" ? "succeeded" : decision.effect === "deny" ? "denied" : "approval_required";
    const result = decision.effect === "allow" ? this.perform(request, customer) : undefined;
    const recorded = this.record(request, caseInfo.customer_id, decision.effect, state, decision, result);
    this.byKey.set(idempotencyKey, recorded);
    return Promise.resolve(recorded.response);
  }

  getAction(actionId: string): Promise<ActionView> {
    const r = this.log.find((x) => x.id === actionId);
    if (!r) return Promise.reject(new GatewayError(404, undefined, "NOT_FOUND"));
    const amount = r.request.args.amount_minor;
    return Promise.resolve(
      ActionView.parse({
        action_id: r.id,
        case_id: r.request.case_id,
        tool: r.request.tool,
        state: r.response.state,
        effect: r.response.effect,
        reasons: r.response.reasons,
        amount_minor: typeof amount === "number" ? amount : null,
        currency: typeof r.request.args.currency === "string" ? r.request.args.currency : null,
        created_at: r.createdAt,
        updated_at: r.createdAt,
        execution: null,
      }),
    );
  }

  private record(
    request: ProposalRequest,
    customerId: string,
    effect: ProposalResponse["effect"],
    state: ActionState,
    decision?: ReturnType<typeof evaluate>,
    result?: unknown,
  ): Recorded {
    const response = ProposalResponse.parse({
      action_id: randomUUID(),
      effect,
      state,
      reasons: decision?.reasons ?? [{ code: "POLICY_RULE_MATCHED", message: "prior refund" }],
      policy: { id: this.policy.id, version: this.policy.version },
      ...(result === undefined ? {} : { result }),
    });
    const recorded: Recorded = {
      id: response.action_id,
      request,
      response,
      customerId,
      createdAt: new Date().toISOString(),
    };
    this.log.push(recorded);
    return recorded;
  }

  private usage(q: UsageQuery, caseCustomerId: string): number {
    const tool = q.metric === "plan_change_count" ? "change_subscription_plan" : "create_refund_request";
    const rows = this.log.filter(
      (r) =>
        r.request.tool === tool &&
        COUNTED.includes(r.response.state) &&
        (q.scope === "tenant" ||
          (q.scope === "customer" && r.customerId === q.scope_id) ||
          (q.scope === "case" && r.customerId === caseCustomerId && r.request.case_id === q.scope_id)),
    );
    if (q.metric === "refund_amount_minor") {
      return rows.reduce(
        (sum, r) => sum + (typeof r.request.args.amount_minor === "number" ? r.request.args.amount_minor : 0),
        0,
      );
    }
    return rows.length;
  }

  private perform(request: ProposalRequest, customer: WorldCustomer): unknown {
    switch (request.tool) {
      case "get_customer":
        return { id: customer.id, display_name: customer.display_name };
      case "get_subscription":
        return { subscriptions: [customer.subscription] };
      case "change_subscription_plan":
        customer.subscription.plan = String(request.args.target_plan);
        return { plan: customer.subscription.plan };
      case "draft_reply":
        return { draft_id: `draft_${this.log.length + 1}` };
      default:
        return undefined;
    }
  }
}

/** The demo world used by tests, evals and the README examples. */
export function demoWorld(overrides: Partial<World> = {}): World {
  return {
    tenantId: "acme",
    cases: { case_1001: { customer_id: "cus_ada" }, case_1002: { customer_id: "cus_grace" } },
    customers: {
      cus_ada: {
        id: "cus_ada",
        display_name: "Ada Lovelace",
        subscription: { id: "sub_ada", plan: "pro", currency: "USD", status: "active" },
      },
      cus_grace: {
        id: "cus_grace",
        display_name: "Grace Hopper",
        subscription: { id: "sub_grace", plan: "business", currency: "USD", status: "active" },
      },
    },
    ...overrides,
  };
}
