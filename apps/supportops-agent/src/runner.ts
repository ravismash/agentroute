import { randomUUID } from "node:crypto";
import type { Gateway } from "@agentroute/gateway-client";
import { MaxTurnsExceededError, run, type Model } from "@openai/agents";
import { AGENT_ID, buildInput, createSupportAgent } from "./agent.js";
import type { EmitFn, RunSummary } from "./events.js";
import { proposeAction, type ToolRunContext } from "./tools.js";

export interface SupportRequest {
  caseId: string;
  customerId: string;
  message: string;
}

export interface RunnerOptions {
  gateway: Gateway;
  /** A fresh model per run (scripted models are stateful). */
  modelFactory: () => Model;
  maxTurns: number;
}

const FALLBACK_REPLY =
  "Thanks for your patience. A support specialist will review your request and get back to you shortly.";

/**
 * One agent run: tool calls become gateway proposals; the final text is
 * submitted as a `draft_reply` proposal too, so replies are audited and
 * policy-checked like any other action.
 */
export async function runSupportCase(
  request: SupportRequest,
  options: RunnerOptions,
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const runId = randomUUID();
  const ctx: ToolRunContext = {
    runId,
    agentId: AGENT_ID,
    caseId: request.caseId,
    gateway: options.gateway,
    emit,
    actions: [],
  };
  emit({ type: "run.started", run_id: runId, case_id: request.caseId });

  try {
    const agent = createSupportAgent(options.modelFactory(), ctx);
    let reply = FALLBACK_REPLY;
    let usage = { requests: 0, input_tokens: 0, output_tokens: 0 };
    try {
      const result = await run(agent, buildInput(request.caseId, request.customerId, request.message), {
        maxTurns: options.maxTurns,
        ...(signal ? { signal } : {}),
      });
      const text = typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
      if (text) reply = text.slice(0, 5000);
      const u = result.state.usage;
      usage = { requests: u.requests, input_tokens: u.inputTokens, output_tokens: u.outputTokens };
    } catch (err) {
      // A runaway tool loop is stopped by maxTurns; the customer still gets a safe reply.
      if (!(err instanceof MaxTurnsExceededError)) throw err;
    }

    const outcome = await proposeAction(ctx, "reply", "draft_reply", {
      case_id: request.caseId,
      body: reply,
    });
    const replyAction = ctx.actions.at(-1);
    emit({
      type: "reply.drafted",
      text: reply,
      action_id: outcome.action_id ?? null,
      effect: replyAction?.effect ?? null,
    });

    const summary: RunSummary = {
      reply,
      reply_effect: replyAction?.effect ?? null,
      actions: ctx.actions,
      usage,
    };
    emit({ type: "run.completed", run_id: runId, summary });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "run.failed", run_id: runId, error: message });
    throw err;
  }
}
