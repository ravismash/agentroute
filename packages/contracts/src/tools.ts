import { z } from "zod";
import { AmountMinor, CurrencyCode, Id } from "./primitives.js";

export const RefundReasonCode = z.enum([
  "duplicate_charge",
  "billing_error",
  "service_outage",
  "goodwill",
  "cancellation",
]);
export type RefundReasonCode = z.infer<typeof RefundReasonCode>;

export const GetCustomerArgs = z.strictObject({
  customer_id: Id,
});

export const GetSubscriptionArgs = z.strictObject({
  customer_id: Id,
});

export const DraftReplyArgs = z.strictObject({
  case_id: Id,
  body: z.string().min(1).max(5000),
});

export const CreateRefundRequestArgs = z.strictObject({
  customer_id: Id,
  amount_minor: AmountMinor,
  currency: CurrencyCode,
  reason_code: RefundReasonCode,
  note: z.string().max(500).optional(),
});

export const ChangeSubscriptionPlanArgs = z.strictObject({
  customer_id: Id,
  subscription_id: Id,
  target_plan: z.string().min(1).max(64),
  effective: z.enum(["immediately", "next_cycle"]),
});

/** The tools the SupportOps reference agent is allowed to propose. */
export const TOOL_ARG_SCHEMAS = {
  get_customer: GetCustomerArgs,
  get_subscription: GetSubscriptionArgs,
  draft_reply: DraftReplyArgs,
  create_refund_request: CreateRefundRequestArgs,
  change_subscription_plan: ChangeSubscriptionPlanArgs,
} as const;

export type KnownToolName = keyof typeof TOOL_ARG_SCHEMAS;
export type ToolArgs<T extends KnownToolName> = z.infer<(typeof TOOL_ARG_SCHEMAS)[T]>;

export const TOOL_KIND: Readonly<Record<KnownToolName, "read" | "write">> = {
  get_customer: "read",
  get_subscription: "read",
  draft_reply: "write",
  create_refund_request: "write",
  change_subscription_plan: "write",
};

export function isKnownTool(tool: string): tool is KnownToolName {
  return Object.hasOwn(TOOL_ARG_SCHEMAS, tool);
}

export type ToolArgsParseResult =
  | { ok: true; tool: KnownToolName; args: Record<string, unknown> }
  | { ok: false; reason: "unknown_tool" }
  | { ok: false; reason: "invalid_args"; issues: z.core.$ZodIssue[] };

/**
 * Validate a proposal's arguments against the tool's schema.
 * Unknown tools are reported rather than thrown: the gateway must still
 * record and deny them (e.g. `export_customer_data`).
 */
export function parseToolArgs(tool: string, args: unknown): ToolArgsParseResult {
  if (!isKnownTool(tool)) return { ok: false, reason: "unknown_tool" };
  const result = TOOL_ARG_SCHEMAS[tool].safeParse(args);
  if (!result.success) return { ok: false, reason: "invalid_args", issues: result.error.issues };
  return { ok: true, tool, args: result.data };
}
