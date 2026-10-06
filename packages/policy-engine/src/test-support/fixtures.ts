import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPolicy, type CompiledPolicy } from "../compile.js";
import { planUsage, type EvaluationContext, type ToolProposal, type UsageSnapshot } from "../evaluate.js";

export const BASELINE_PATH = fileURLToPath(
  new URL("../../../../policies/support-agent-baseline.v1.yaml", import.meta.url),
);
export const BASELINE_SOURCE = readFileSync(BASELINE_PATH, "utf8");

export function baselinePolicy(): CompiledPolicy {
  const result = loadPolicy(BASELINE_SOURCE);
  if (!result.ok) throw new Error(`baseline policy invalid: ${result.errors.join(", ")}`);
  return result.policy;
}

export function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    tenant_id: "tenant_acme",
    agent_id: "supportops",
    case: { id: "case_1", customer_id: "cus_1" },
    customer: { id: "cus_1", email_verified: true },
    subscription: { id: "sub_1", currency: "USD", plan: "pro" },
    ...overrides,
  };
}

export function refund(amount_minor: number, extra: Record<string, unknown> = {}): ToolProposal {
  return {
    tool: "create_refund_request",
    args: { customer_id: "cus_1", amount_minor, currency: "USD", reason_code: "duplicate_charge", ...extra },
  };
}

/** Usage snapshot with every planned query set to `values[metric]` (default 0). */
export function usageFor(
  policy: CompiledPolicy,
  proposal: ToolProposal,
  ctx: EvaluationContext,
  values: Partial<Record<string, number>> = {},
): UsageSnapshot {
  const snapshot: Record<string, number> = {};
  for (const q of planUsage(policy, proposal, ctx)) snapshot[q.key] = values[`${q.metric}:${q.scope}`] ?? 0;
  return snapshot;
}
