import type { DecisionEffect } from "@agentroute/contracts";
import type { CompiledPolicy } from "./compile.js";
import {
  evaluate,
  type Decision,
  type EvaluationContext,
  type ToolProposal,
  type UsageSnapshot,
} from "./evaluate.js";

export interface DryRunCase {
  id: string;
  proposal: ToolProposal;
  context: EvaluationContext;
  usage?: UsageSnapshot;
}

export interface DryRunReport {
  policy: { id: string; version: string };
  total: number;
  by_effect: Record<DecisionEffect, number>;
  results: { id: string; decision: Decision }[];
}

/** "What would this policy decide for these proposals?" — used before activating a policy. */
export function dryRun(policy: CompiledPolicy, cases: readonly DryRunCase[]): DryRunReport {
  const by_effect: Record<DecisionEffect, number> = { allow: 0, approval_required: 0, deny: 0 };
  const results = cases.map((c) => {
    const decision = evaluate(policy, c.proposal, c.context, c.usage);
    by_effect[decision.effect]++;
    return { id: c.id, decision };
  });
  return { policy: { id: policy.id, version: policy.version }, total: cases.length, by_effect, results };
}

export interface PolicyComparison {
  total: number;
  changed: { id: string; from: DecisionEffect; to: DecisionEffect }[];
  /** Cases that become less restrictive — review these first. */
  loosened: number;
  tightened: number;
}

const RANK: Readonly<Record<DecisionEffect, number>> = { allow: 0, approval_required: 1, deny: 2 };

/** Compare a candidate policy with the current one over the same cases (shadow evaluation). */
export function comparePolicies(
  current: CompiledPolicy,
  candidate: CompiledPolicy,
  cases: readonly DryRunCase[],
): PolicyComparison {
  const changed: PolicyComparison["changed"] = [];
  let loosened = 0;
  let tightened = 0;
  for (const c of cases) {
    const from = evaluate(current, c.proposal, c.context, c.usage).effect;
    const to = evaluate(candidate, c.proposal, c.context, c.usage).effect;
    if (from === to) continue;
    changed.push({ id: c.id, from, to });
    if (RANK[to] < RANK[from]) loosened++;
    else tightened++;
  }
  return { total: cases.length, changed, loosened, tightened };
}
