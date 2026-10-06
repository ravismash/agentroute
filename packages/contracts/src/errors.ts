import { z } from "zod";

/**
 * Stable, machine-readable codes. Policy codes appear in decision reasons;
 * the rest are returned as RFC 7807 problem details.
 */
export const ErrorCode = z.enum([
  // Policy decisions
  "POLICY_TOOL_NOT_ALLOWED",
  "POLICY_DEFAULT_DENY",
  "POLICY_PARAM_INVALID",
  "POLICY_CONTEXT_MISMATCH",
  "POLICY_THRESHOLD_EXCEEDED",
  "POLICY_AGGREGATE_LIMIT",
  "POLICY_EVALUATION_ERROR",
  "POLICY_REPLY_NOT_GROUNDED",
  "POLICY_RULE_MATCHED",
  // Controls
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "KILL_SWITCH_ACTIVE",
  // Lifecycle / API
  "ACTION_INVALID_STATE",
  "AUTH_INVALID_KEY",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "EXECUTION_FAILED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 7807 problem details with an AgentRoute error code. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  trace_id: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
