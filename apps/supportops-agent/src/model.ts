import {
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import OpenAI from "openai";
import type { LlmConfig } from "./config.js";

/**
 * Build the model for the configured provider.
 *
 * - openai: Responses API.
 * - openrouter: OpenAI-compatible Chat Completions at openrouter.ai.
 *
 * (The SDK's trace export is disabled in agent.ts.)
 */
export function createModel(llm: LlmConfig): Model {
  if (llm.provider === "openrouter") {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 60_000,
      maxRetries: 2,
      defaultHeaders: { "X-Title": "AgentRoute SupportOps" },
    });
    return new OpenAIChatCompletionsModel(client, llm.model);
  }
  return new OpenAIResponsesModel(
    new OpenAI({ apiKey: llm.apiKey, timeout: 60_000, maxRetries: 2 }),
    llm.model,
  );
}

// ─── Scripted model (tests and offline evals) ───────────────────────────────

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One model turn: call tools, or reply with final text (optionally derived from tool results). */
export type ScriptedTurn =
  { calls: ScriptedToolCall[] } | { say: string | ((toolOutputs: unknown[]) => string) };

export const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
  calls: [{ name, args }],
});
export const say = (text: string | ((toolOutputs: unknown[]) => string)): ScriptedTurn => ({ say: text });

/**
 * A deterministic `Model` that plays back a script. It lets the agent loop,
 * tools, gateway integration and eval scoring run with no LLM and no cost.
 */
export class ScriptedModel implements Model {
  private turn = 0;
  private callCounter = 0;

  constructor(private readonly script: readonly ScriptedTurn[]) {}

  getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.script[this.turn++] ?? { say: "I'm sorry, I can't help with that right now." };
    const usage = new Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    if ("calls" in step) {
      return Promise.resolve({
        usage,
        output: step.calls.map((c) => ({
          type: "function_call" as const,
          callId: `call_${++this.callCounter}`,
          name: c.name,
          arguments: JSON.stringify(c.args),
          status: "completed" as const,
        })),
      });
    }
    const text = typeof step.say === "function" ? step.say(toolOutputs(request)) : step.say;
    return Promise.resolve({
      usage,
      output: [
        {
          type: "message" as const,
          role: "assistant" as const,
          status: "completed" as const,
          content: [{ type: "output_text" as const, text }],
        },
      ],
    });
  }

  getStreamedResponse(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("ScriptedModel does not stream")),
      }),
    };
  }
}

/** Parsed outputs of the tool calls so far, newest last. */
function toolOutputs(request: ModelRequest): unknown[] {
  if (typeof request.input === "string") return [];
  return request.input
    .filter((item) => item.type === "function_call_result")
    .map((item): unknown => {
      const output: unknown = "output" in item ? item.output : undefined;
      const text =
        typeof output === "string"
          ? output
          : typeof output === "object" &&
              output !== null &&
              "text" in output &&
              typeof output.text === "string"
            ? output.text
            : JSON.stringify(output);
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        return text;
      }
    });
}
