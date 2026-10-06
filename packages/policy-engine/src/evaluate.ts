import {
  parseToolArgs,
  type DecisionEffect,
  type DecisionReason,
  type PolicyRef,
} from "@agentroute/contracts";
import type { CompiledPolicy, CompiledToolPolicy } from "./compile.js";
import { checkGrounding, type GroundingEvidence } from "./grounding.js";
import type { AggregateMetric, AggregateScope, Escalation, Requirement } from "./schema.js";

/** Server-side facts about the case. Never populated from LLM output. */
export interface EvaluationContext {
  tenant_id: string;
  agent_id: string;
  case: { id: string; customer_id: string } & Record<string, unknown>;
  customer?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
  /** What actually happened on the case; required by grounded_reply rules. */
  evidence?: GroundingEvidence;
}

export interface ToolProposal {
  tool: string;
  args: unknown;
}

export interface UsageQuery {
  /** Stable key used to look the value up in a UsageSnapshot. */
  key: string;
  metric: AggregateMetric;
  scope: AggregateScope;
  scope_id: string;
  window_seconds: number;
}

/** Existing usage per query key, read by the caller (inside the decision transaction). */
export type UsageSnapshot = Readonly<Record<string, number>>;

export interface Decision {
  effect: DecisionEffect;
  reasons: DecisionReason[];
  /** `<tool>/<rule-id>` for every rule that contributed to the decision. */
  matched_rules: string[];
  policy: PolicyRef & { checksum: string };
  /** Internal error detail for logs when the decision failed closed. Never shown to agents. */
  error?: string;
}

const SEVERITY: Readonly<Record<DecisionEffect, number>> = { allow: 0, approval_required: 1, deny: 2 };

/**
 * List the usage aggregates the caller must read before calling `evaluate`.
 * Returns [] when the proposal will be decided without aggregates.
 */
export function planUsage(
  policy: CompiledPolicy,
  proposal: ToolProposal,
  ctx: EvaluationContext,
): UsageQuery[] {
  const toolPolicy = policy.tools.get(proposal.tool);
  if (!toolPolicy || policy.blockedTools.has(proposal.tool)) return [];
  const queries = new Map<string, UsageQuery>();
  for (const rule of toolPolicy.escalate) {
    if (rule.type !== "aggregate") continue;
    const query = usageQuery(rule, ctx);
    queries.set(query.key, query);
  }
  return [...queries.values()];
}

/**
 * Decide a proposal. Pure and deterministic: same inputs, same decision.
 * Default-deny, deny-overrides, and fail-closed — any internal error
 * yields `deny` with POLICY_EVALUATION_ERROR.
 */
export function evaluate(
  policy: CompiledPolicy,
  proposal: ToolProposal,
  ctx: EvaluationContext,
  usage: UsageSnapshot = {},
): Decision {
  try {
    return decide(policy, proposal, ctx, usage);
  } catch (err) {
    return {
      ...base(policy),
      effect: "deny",
      reasons: [
        { code: "POLICY_EVALUATION_ERROR", message: "policy evaluation failed; denied (fail closed)" },
      ],
      matched_rules: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function decide(
  policy: CompiledPolicy,
  proposal: ToolProposal,
  ctx: EvaluationContext,
  usage: UsageSnapshot,
): Decision {
  const deny = (code: DecisionReason["code"], message: string, rule?: string): Decision => ({
    ...base(policy),
    effect: "deny",
    reasons: [{ code, message, ...(rule ? { rule_id: rule } : {}) }],
    matched_rules: rule ? [rule] : [],
  });

  if (policy.tenant !== "*" && policy.tenant !== ctx.tenant_id) {
    return deny("POLICY_DEFAULT_DENY", "policy does not apply to this tenant");
  }
  if (!policy.agents.has(ctx.agent_id)) {
    return deny("POLICY_DEFAULT_DENY", "policy does not apply to this agent");
  }
  if (policy.blockedTools.has(proposal.tool)) {
    return deny("POLICY_TOOL_NOT_ALLOWED", `tool "${proposal.tool}" is blocked`, `blocked/${proposal.tool}`);
  }
  const toolPolicy = policy.tools.get(proposal.tool);
  if (!toolPolicy) {
    return deny("POLICY_DEFAULT_DENY", `tool "${proposal.tool}" is not permitted by policy`);
  }

  const parsed = parseToolArgs(proposal.tool, proposal.args);
  if (!parsed.ok) {
    const detail =
      parsed.reason === "invalid_args"
        ? parsed.issues.map((i) => `${i.path.map(String).join(".") || "args"}: ${i.message}`).join("; ")
        : "unknown tool";
    return deny("POLICY_PARAM_INVALID", `invalid arguments: ${detail}`);
  }
  const args = parsed.args;

  // Hard requirements: evaluate all so the decision explains every failure.
  const failures: DecisionReason[] = [];
  for (const rule of toolPolicy.require) {
    const failure = checkRequirement(rule, args, ctx);
    if (failure) failures.push({ ...failure, rule_id: ruleRef(toolPolicy, rule) });
  }
  if (failures.length > 0) {
    return {
      ...base(policy),
      effect: "deny",
      reasons: failures,
      matched_rules: failures.map((f) => f.rule_id ?? ""),
    };
  }

  // Escalations raise the effect; the most severe wins.
  let effect: DecisionEffect = toolPolicy.effect;
  const reasons: DecisionReason[] = [];
  const matched: string[] = [`${toolPolicy.tool}/base`];
  for (const rule of toolPolicy.escalate) {
    const triggered = checkEscalation(rule, toolPolicy, args, ctx, usage);
    if (!triggered) continue;
    const ref = ruleRef(toolPolicy, rule);
    matched.push(ref);
    reasons.push({ ...triggered, rule_id: ref });
    if (SEVERITY[rule.effect] > SEVERITY[effect]) effect = rule.effect;
  }

  if (reasons.length === 0) {
    reasons.push({
      code: "POLICY_RULE_MATCHED",
      message: `${toolPolicy.effect} by policy for "${toolPolicy.tool}"`,
      rule_id: `${toolPolicy.tool}/base`,
    });
  }
  return { ...base(policy), effect, reasons, matched_rules: matched };
}

function checkRequirement(
  rule: Requirement,
  args: Record<string, unknown>,
  ctx: EvaluationContext,
): Omit<DecisionReason, "rule_id"> | undefined {
  const value = args[rule.arg];
  switch (rule.type) {
    case "context_equals": {
      const expected = resolveField(ctx, rule.field);
      if (value === undefined || expected === undefined || !isPrimitive(expected) || value !== expected) {
        return {
          code: "POLICY_CONTEXT_MISMATCH",
          message: `argument "${rule.arg}" must match ${rule.field}`,
        };
      }
      return undefined;
    }
    case "arg_in":
      if (!rule.values.some((allowed) => allowed === value)) {
        return { code: "POLICY_PARAM_INVALID", message: `argument "${rule.arg}" is not an allowed value` };
      }
      return undefined;
  }
}

function checkEscalation(
  rule: Escalation,
  toolPolicy: CompiledToolPolicy,
  args: Record<string, unknown>,
  ctx: EvaluationContext,
  usage: UsageSnapshot,
): Omit<DecisionReason, "rule_id"> | undefined {
  switch (rule.type) {
    case "threshold": {
      const value = args[rule.arg];
      if (value === undefined) return undefined;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`threshold argument "${rule.arg}" is not a finite number`);
      }
      return value > rule.gt
        ? { code: "POLICY_THRESHOLD_EXCEEDED", message: `${rule.arg} ${value} exceeds ${rule.gt}` }
        : undefined;
    }
    case "grounded_reply": {
      const value = args[rule.arg];
      if (typeof value !== "string") throw new Error(`grounded_reply argument "${rule.arg}" is not text`);
      if (!ctx.evidence) throw new Error("grounded_reply requires case evidence in the context");
      const result = checkGrounding(value, ctx.evidence);
      if (result.grounded) return undefined;
      const detail = result.findings
        .slice(0, 3)
        .map((f) => f.problem)
        .join("; ");
      return {
        code: "POLICY_REPLY_NOT_GROUNDED",
        message: `reply is not backed by the case's actions: ${detail}`,
      };
    }
    case "aggregate": {
      const query = usageQuery(rule, ctx);
      const existing = usage[query.key];
      if (existing === undefined || !Number.isFinite(existing) || existing < 0) {
        throw new Error(`missing or invalid usage for ${query.key}`);
      }
      const projected = existing + contribution(rule.metric, toolPolicy.tool, args);
      return projected > rule.gt
        ? {
            code: "POLICY_AGGREGATE_LIMIT",
            message: `${rule.metric} for ${rule.scope} over ${rule.window} would be ${projected} (limit ${rule.gt})`,
          }
        : undefined;
    }
  }
}

/** How much this proposal adds to a metric if it goes ahead. */
function contribution(metric: AggregateMetric, tool: string, args: Record<string, unknown>): number {
  switch (metric) {
    case "refund_amount_minor":
      return tool === "create_refund_request" && typeof args.amount_minor === "number"
        ? args.amount_minor
        : 0;
    case "refund_count":
      return tool === "create_refund_request" ? 1 : 0;
    case "plan_change_count":
      return tool === "change_subscription_plan" ? 1 : 0;
  }
}

function usageQuery(rule: Extract<Escalation, { type: "aggregate" }>, ctx: EvaluationContext): UsageQuery {
  const scope_id =
    rule.scope === "case" ? ctx.case.id : rule.scope === "customer" ? ctx.case.customer_id : ctx.tenant_id;
  const window_seconds = parseDuration(rule.window);
  return {
    key: `${rule.metric}:${rule.scope}:${scope_id}:${window_seconds}`,
    metric: rule.metric,
    scope: rule.scope,
    scope_id,
    window_seconds,
  };
}

const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 } as const;

export function parseDuration(window: string): number {
  const match = /^(\d+)([mhd])$/.exec(window);
  if (!match) throw new Error(`invalid duration "${window}"`);
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}

/** Walk own properties only, so paths like `case.__proto__` resolve to undefined. */
function resolveField(ctx: EvaluationContext, path: string): unknown {
  let current: unknown = ctx;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function ruleRef(toolPolicy: CompiledToolPolicy, rule: { id: string }): string {
  return `${toolPolicy.tool}/${rule.id}`;
}

function base(policy: CompiledPolicy): Pick<Decision, "policy"> {
  return { policy: { id: policy.id, version: policy.version, checksum: policy.checksum } };
}
