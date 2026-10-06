import { RefundReasonCode, type ProposalResponse } from "@agentroute/contracts";
import { GatewayError, type Gateway } from "@agentroute/gateway-client";
import { searchArticles, type Retriever } from "@agentroute/knowledge";
import { tool } from "@openai/agents";
import { z } from "zod";
import type { EmitFn, ProposedAction } from "./events.js";

export interface ToolRunContext {
  runId: string;
  agentId: string;
  /** Bound by the caller, never chosen by the model. */
  caseId: string;
  gateway: Gateway;
  emit: EmitFn;
  /** Every proposal made during the run, for the summary and evals. */
  actions: ProposedAction[];
  /** Help-center search; undefined disables the tool. */
  knowledge?: Retriever | undefined;
  /** Article slugs retrieved during the run. */
  sources: Set<string>;
}

/** What the model sees after proposing an action. Short, explicit, and actionable. */
interface ToolOutcome {
  status: "completed" | "pending_approval" | "denied" | "failed" | "processing" | "error";
  message: string;
  action_id?: string;
  reasons?: string[];
  data?: unknown;
}

const GUIDANCE: Record<Exclude<ToolOutcome["status"], "error">, string> = {
  completed: "Done.",
  pending_approval:
    "This needs human approval. Tell the customer it is being reviewed; do not promise the outcome or say it is done.",
  denied:
    "Not permitted by policy. Do not retry with different values to get around this. Explain politely or offer to escalate.",
  failed: "The action failed. Apologise and say a support specialist will follow up.",
  processing: "Still processing. Tell the customer it is in progress; do not say it is complete.",
};

function outcomeOf(decision: ProposalResponse): ToolOutcome {
  const reasons = decision.reasons.map((r) => r.message);
  const base = { action_id: decision.action_id };
  if (decision.effect === "deny") return { ...base, status: "denied", message: GUIDANCE.denied, reasons };
  if (decision.effect === "approval_required") {
    return { ...base, status: "pending_approval", message: GUIDANCE.pending_approval, reasons };
  }
  switch (decision.state) {
    case "succeeded":
      return {
        ...base,
        status: "completed",
        message: GUIDANCE.completed,
        ...(decision.result === undefined ? {} : { data: decision.result }),
      };
    case "failed":
      return { ...base, status: "failed", message: GUIDANCE.failed };
    default:
      return { ...base, status: "processing", message: GUIDANCE.processing };
  }
}

/**
 * Submit a proposal on the agent's behalf. The idempotency key is derived from
 * the run and the model's tool-call id, so a retried call can never create a
 * second action.
 */
export async function proposeAction(
  ctx: ToolRunContext,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const record: ProposedAction = {
    call_id: callId,
    tool: toolName,
    args,
    action_id: null,
    effect: null,
    state: null,
  };
  ctx.actions.push(record);
  ctx.emit({ type: "tool.proposed", call_id: callId, tool: toolName, args });
  try {
    const decision = await ctx.gateway.propose(
      { agent_id: ctx.agentId, case_id: ctx.caseId, tool: toolName, args },
      `${ctx.runId}:${callId}`,
    );
    Object.assign(record, { action_id: decision.action_id, effect: decision.effect, state: decision.state });
    ctx.emit({
      type: "decision.made",
      call_id: callId,
      action_id: decision.action_id,
      tool: toolName,
      effect: decision.effect,
      state: decision.state,
      reasons: decision.reasons,
    });
    if (decision.effect === "approval_required") {
      ctx.emit({ type: "approval.pending", action_id: decision.action_id, tool: toolName });
    } else if (decision.state === "succeeded" || decision.state === "failed") {
      ctx.emit({
        type: "action.completed",
        action_id: decision.action_id,
        tool: toolName,
        state: decision.state,
      });
    }
    return outcomeOf(decision);
  } catch (err) {
    const message =
      err instanceof GatewayError
        ? err.message
        : `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    ctx.emit({ type: "tool.error", call_id: callId, tool: toolName, message });
    return {
      status: "error",
      message:
        "The request could not be completed. Do not retry; tell the customer a specialist will follow up.",
    };
  }
}

const CustomerId = z.string().describe("The customer's id, e.g. cus_ada");

/** Agent-facing tool schemas. All fields required (nullable instead of optional) for strict tool calling. */
export function createSupportTools(ctx: ToolRunContext) {
  const wrap =
    (name: string, toArgs: (input: Record<string, unknown>) => Record<string, unknown> = (i) => i) =>
    async (input: unknown, _runContext: unknown, details?: { toolCall?: { callId: string } }) => {
      const callId = details?.toolCall?.callId ?? `local_${ctx.actions.length + 1}`;
      return JSON.stringify(await proposeAction(ctx, callId, name, toArgs(input as Record<string, unknown>)));
    };

  const knowledge = ctx.knowledge;
  const searchTool = knowledge
    ? [
        tool({
          name: "search_help_center",
          description:
            "Search the help center for policies, timelines, pricing and how-to answers. " +
            "Answer policy questions only from the returned snippets, and link the article you used.",
          parameters: z.object({
            query: z.string().min(2).max(200).describe("What to look up, in plain words"),
          }),
          // Public help content: read locally. Customer data and actions still go through the gateway.
          execute: async (input, _runContext, details) => {
            const results = await searchArticles(knowledge, input.query, 3);
            for (const r of results) ctx.sources.add(r.slug);
            ctx.emit({
              type: "knowledge.retrieved",
              call_id: details?.toolCall?.callId ?? "local",
              query: input.query,
              articles: results.map((r) => r.slug),
            });
            return JSON.stringify(
              results.length
                ? {
                    status: "completed",
                    articles: results.map(({ title, url, snippet }) => ({ title, url, snippet })),
                  }
                : {
                    status: "completed",
                    articles: [],
                    message: "Nothing found. Say you'll check with the team; don't guess.",
                  },
            );
          },
        }),
      ]
    : [];

  return [
    ...searchTool,
    tool({
      name: "get_customer",
      description: "Look up the customer's profile. Use before acting if you need their name or details.",
      parameters: z.object({ customer_id: CustomerId }),
      execute: wrap("get_customer"),
    }),
    tool({
      name: "get_subscription",
      description: "Look up the customer's subscriptions: plan, currency and status.",
      parameters: z.object({ customer_id: CustomerId }),
      execute: wrap("get_subscription"),
    }),
    tool({
      name: "create_refund_request",
      description:
        "Propose a refund to the customer's original payment. Amounts are integer minor units: $15.00 is 1500. " +
        "Use the subscription's currency. The policy gateway decides whether it runs, needs approval, or is denied.",
      parameters: z.object({
        customer_id: CustomerId,
        amount_minor: z.number().int().positive().describe("Amount in minor units, e.g. 1500 for $15.00"),
        currency: z.string().describe("ISO 4217 code in upper case, e.g. USD"),
        reason_code: RefundReasonCode,
        note: z.string().max(500).nullable().describe("Short internal note, or null"),
      }),
      execute: wrap("create_refund_request", ({ note, ...rest }) => (note ? { ...rest, note } : rest)),
    }),
    tool({
      name: "change_subscription_plan",
      description: "Propose moving the customer's subscription to another plan (starter, pro or business).",
      parameters: z.object({
        customer_id: CustomerId,
        subscription_id: z.string().describe("Subscription id from get_subscription, e.g. sub_ada"),
        target_plan: z.string().describe("starter, pro or business"),
        effective: z.enum(["immediately", "next_cycle"]),
      }),
      execute: wrap("change_subscription_plan"),
    }),
  ];
}
