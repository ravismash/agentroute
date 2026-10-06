import { Id } from "@agentroute/contracts";
import { z } from "zod";

/**
 * Policy document format (YAML, `apiVersion: agentroute/v1`).
 *
 * A policy lists blocked tools and, for each permitted tool, a base effect,
 * hard requirements (any failure ⇒ deny) and escalations (conditions that
 * raise the effect to approval_required or deny). Anything not listed is
 * denied: default-deny is not configurable.
 */

export const RuleId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "rule ids are lowercase kebab-case, max 64 chars");

export const ArgName = z.string().regex(/^[a-z_][a-z0-9_]*$/, "invalid argument name");

/** Dot path into the server-side evaluation context, e.g. `case.customer_id`. */
export const FieldPath = z
  .string()
  .regex(
    /^(tenant_id|agent_id|case|customer|subscription)(\.[a-z_][a-z0-9_]*)*$/,
    "field must start with tenant_id, agent_id, case, customer or subscription",
  );

export const Duration = z.string().regex(/^[1-9]\d{0,4}(m|h|d)$/, "duration like 30m, 24h or 7d");

const description = z.string().max(500).optional();

export const ContextEqualsRequirement = z.strictObject({
  id: RuleId,
  type: z.literal("context_equals"),
  arg: ArgName,
  field: FieldPath,
  description,
});

export const ArgInRequirement = z.strictObject({
  id: RuleId,
  type: z.literal("arg_in"),
  arg: ArgName,
  values: z.array(z.union([z.string(), z.number()])).min(1),
  description,
});

export const Requirement = z.discriminatedUnion("type", [ContextEqualsRequirement, ArgInRequirement]);
export type Requirement = z.infer<typeof Requirement>;

const EscalationEffect = z.enum(["approval_required", "deny"]);

export const ThresholdEscalation = z.strictObject({
  id: RuleId,
  type: z.literal("threshold"),
  arg: ArgName,
  gt: z.number().int().nonnegative(),
  effect: EscalationEffect,
  description,
});

export const AGGREGATE_METRICS = ["refund_amount_minor", "refund_count", "plan_change_count"] as const;
export const AggregateMetric = z.enum(AGGREGATE_METRICS);
export type AggregateMetric = z.infer<typeof AggregateMetric>;

export const AggregateScope = z.enum(["case", "customer", "tenant"]);
export type AggregateScope = z.infer<typeof AggregateScope>;

export const AggregateEscalation = z.strictObject({
  id: RuleId,
  type: z.literal("aggregate"),
  metric: AggregateMetric,
  scope: AggregateScope,
  window: Duration,
  /** Escalates when existing usage plus this proposal's contribution exceeds `gt`. */
  gt: z.number().int().nonnegative(),
  effect: EscalationEffect,
  description,
});

export const Escalation = z.discriminatedUnion("type", [ThresholdEscalation, AggregateEscalation]);
export type Escalation = z.infer<typeof Escalation>;

export const ToolPolicy = z.strictObject({
  effect: z.enum(["allow", "approval_required"]),
  require: z.array(Requirement).default([]),
  escalate: z.array(Escalation).default([]),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const PolicyDocument = z.strictObject({
  apiVersion: z.literal("agentroute/v1"),
  id: RuleId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver, e.g. 1.0.0"),
  tenant: z.union([z.literal("*"), Id]),
  agents: z.array(Id).min(1),
  default: z.literal("deny"),
  blocked_tools: z.array(z.string().min(1).max(64)).default([]),
  tools: z.record(z.string(), ToolPolicy),
  description,
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;
