import type { ActionState, DecisionEffect, DecisionReason } from "@agentroute/contracts";

/**
 * Events streamed to clients over SSE while a run is in progress. They expose
 * what the agent *did* (tool proposals and gateway decisions), never the
 * model's internal reasoning.
 */
export type RunEvent =
  | { type: "run.started"; run_id: string; case_id: string }
  | { type: "tool.proposed"; call_id: string; tool: string; args: Record<string, unknown> }
  | {
      type: "decision.made";
      call_id: string;
      action_id: string;
      tool: string;
      effect: DecisionEffect;
      state: ActionState;
      reasons: DecisionReason[];
    }
  | { type: "approval.pending"; action_id: string; tool: string }
  | { type: "action.completed"; action_id: string; tool: string; state: ActionState }
  | { type: "tool.error"; call_id: string; tool: string; message: string }
  | { type: "knowledge.retrieved"; call_id: string; query: string; articles: string[] }
  | { type: "reply.drafted"; text: string; action_id: string | null; effect: DecisionEffect | null }
  | { type: "run.completed"; run_id: string; summary: RunSummary }
  | { type: "run.failed"; run_id: string; error: string };

export interface ProposedAction {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  action_id: string | null;
  effect: DecisionEffect | null;
  state: ActionState | null;
}

export interface RunSummary {
  reply: string;
  reply_effect: DecisionEffect | null;
  actions: ProposedAction[];
  /** Help-center articles retrieved during the run (citations must come from here). */
  sources: string[];
  usage: { requests: number; input_tokens: number; output_tokens: number };
}

export type EmitFn = (event: RunEvent) => void;
