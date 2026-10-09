import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  parseToolArgs,
  type ActionState,
  type DecisionEffect,
  type ProposalRequest,
  type ProposalResponse,
} from "@agentroute/contracts";
import {
  findByIdempotencyKey,
  insertProposal,
  loadCaseEvidence,
  isUniqueViolation,
  loadCaseContext,
  lockUsageScope,
  readUsage,
  uuidv7,
  type CaseContext,
  type Database,
  type NewProposal,
  type StoredProposal,
} from "@agentroute/db";
import {
  evaluate,
  planUsage,
  type CompiledPolicy,
  type Decision,
  type EvaluationContext,
} from "@agentroute/policy-engine";
import { withSpan, type Logger, type Metrics } from "@agentroute/telemetry";
import { ApiError } from "../problem.js";
import type { ExecutionService } from "@agentroute/execution";
import type { PolicyCatalog } from "./policy-catalog.js";

const STATE_FOR_EFFECT: Readonly<Record<DecisionEffect, NewProposal["state"]>> = {
  allow: "allowed",
  deny: "denied",
  approval_required: "approval_required",
};

export interface SubmitResult {
  /** true for a new proposal (201), false for an idempotent replay (200). */
  created: boolean;
  response: ProposalResponse;
}

export class ProposalService {
  constructor(
    private readonly db: Database,
    private readonly policies: PolicyCatalog,
    private readonly execution: ExecutionService,
    private readonly log: Logger,
    private readonly approvalTtlSeconds: number,
    private readonly metrics?: Metrics,
  ) {}

  async submit(
    tenantId: string,
    request: ProposalRequest,
    idempotencyKey: string,
    traceId: string,
  ): Promise<SubmitResult> {
    const requestHash = sha256(canonicalJson(request));

    let created: { id: string; state: ActionState; decision: Decision | NoPolicyDecision };
    const startedAt = performance.now();
    try {
      const outcome = await withSpan(
        "proposal.decide",
        () =>
          this.db.transaction(async (tx) => {
            const existing = await findByIdempotencyKey(tx, tenantId, idempotencyKey);
            if (existing) return { kind: "replay" as const, existing };

            const context = await loadCaseContext(tx, tenantId, request.case_id);
            if (!context) throw new ApiError(404, "NOT_FOUND", "case not found");

            const policy = this.policies.registry.resolve(tenantId, request.agent_id);
            const evalContext = toEvaluationContext(tenantId, request.agent_id, context);
            if (request.tool === "draft_reply") {
              // Replies are checked against what actually happened on the case.
              evalContext.evidence = {
                actions: await loadCaseEvidence(tx, tenantId, context.case.customer_id, request.case_id),
                current_plan: context.subscription?.plan ?? null,
              };
            }
            const proposal = { tool: request.tool, args: request.args };

            let decision: Decision | NoPolicyDecision;
            if (context.tenant.kill_switch) {
              decision = denyWithoutEvaluation("KILL_SWITCH_ACTIVE", "tenant kill switch is active", policy);
            } else if (!policy) {
              decision = denyWithoutEvaluation(
                "POLICY_DEFAULT_DENY",
                "no policy governs this tenant and agent",
              );
            } else {
              // Serialise concurrent proposals that share usage counters, then read them.
              const queries = planUsage(policy, proposal, evalContext);
              await lockUsageScope(tx, tenantId, context.case.customer_id, queries);
              const usage = await readUsage(tx, tenantId, context.case.customer_id, queries);
              decision = evaluate(policy, proposal, evalContext, usage);
              if (decision.error)
                this.log.error({ error: decision.error }, "policy evaluation failed closed");
            }

            const id = uuidv7();
            const state = STATE_FOR_EFFECT[decision.effect];
            await insertProposal(tx, {
              id,
              tenantId,
              caseId: request.case_id,
              customerId: context.case.customer_id,
              agentId: request.agent_id,
              tool: request.tool,
              args: request.args,
              ...moneyOf(request),
              state,
              idempotencyKey,
              requestHash,
              decision: {
                effect: decision.effect,
                reasons: decision.reasons,
                matchedRules: decision.matched_rules,
                policy: decision.policy ? this.policies.recordFor(decision.policy.checksum) : null,
              },
              approvalTtlSeconds: this.approvalTtlSeconds,
              traceId,
            });
            return { kind: "created" as const, created: { id, state, decision } };
          }),
        { tool: request.tool },
      );

      if (outcome.kind === "replay") return replay(outcome.existing, requestHash);
      created = outcome.created;
      // Decision overhead = policy evaluation + persistence, excluding execution.
      this.metrics?.decisions.inc({ effect: created.decision.effect, tool: request.tool });
      this.metrics?.decisionDuration.observe(
        { effect: created.decision.effect },
        (performance.now() - startedAt) / 1000,
      );
    } catch (err) {
      // Two identical requests raced: the loser replays the winner's result.
      if (isUniqueViolation(err, "uq_actions_idempotency")) {
        const existing = await findByIdempotencyKey(this.db, tenantId, idempotencyKey);
        if (existing) return replay(existing, requestHash);
      }
      throw err;
    }

    const response: ProposalResponse = {
      action_id: created.id,
      effect: created.decision.effect,
      state: created.state,
      reasons: created.decision.reasons,
      policy: created.decision.policy
        ? { id: created.decision.policy.id, version: created.decision.policy.version }
        : null,
    };
    if (created.state === "allowed") {
      const report = await withSpan(
        "proposal.execute",
        () => this.execution.execute(tenantId, created.id, traceId),
        { action_id: created.id },
      );
      response.state = report.state;
      this.metrics?.executions.inc({ outcome: report.state });
      if (report.result !== undefined) response.result = report.result;
    }
    return { created: true, response };
  }
}

type NoPolicyDecision = Omit<Decision, "policy"> & { policy: Decision["policy"] | null };

function denyWithoutEvaluation(
  code: "KILL_SWITCH_ACTIVE" | "POLICY_DEFAULT_DENY",
  message: string,
  policy?: CompiledPolicy,
): NoPolicyDecision {
  return {
    effect: "deny",
    reasons: [{ code, message }],
    matched_rules: [],
    policy: policy ? { id: policy.id, version: policy.version, checksum: policy.checksum } : null,
  };
}

function replay(existing: StoredProposal, requestHash: string): SubmitResult {
  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "idempotency key was already used with a different request",
    );
  }
  return {
    created: false,
    response: {
      action_id: existing.id,
      effect: existing.effect,
      state: existing.state,
      reasons: existing.reasons,
      policy: existing.policy,
    },
  };
}

function toEvaluationContext(tenantId: string, agentId: string, ctx: CaseContext): EvaluationContext {
  return {
    tenant_id: tenantId,
    agent_id: agentId,
    case: { ...ctx.case },
    customer: { ...ctx.customer },
    ...(ctx.subscription ? { subscription: { ...ctx.subscription } } : {}),
  };
}

/** Money columns are filled only when the arguments are schema-valid. */
function moneyOf(request: ProposalRequest): { amountMinor: number | null; currency: string | null } {
  if (request.tool !== "create_refund_request") return { amountMinor: null, currency: null };
  const parsed = parseToolArgs(request.tool, request.args);
  if (!parsed.ok) return { amountMinor: null, currency: null };
  const { amount_minor, currency } = parsed.args as { amount_minor: number; currency: string };
  return { amountMinor: amount_minor, currency };
}

/** Deterministic JSON (sorted keys) so equivalent requests hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
