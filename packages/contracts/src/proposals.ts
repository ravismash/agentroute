import { z } from "zod";
import { ActionState } from "./actions.js";
import { ErrorCode } from "./errors.js";
import { Id } from "./primitives.js";

export const DecisionEffect = z.enum(["allow", "deny", "approval_required"]);
export type DecisionEffect = z.infer<typeof DecisionEffect>;

/**
 * Body of `POST /v1/proposals`. `tool` is a free string on purpose:
 * unknown or blocked tools must reach the policy engine so the denial
 * is recorded in the audit trail.
 */
export const ProposalRequest = z.strictObject({
  agent_id: Id,
  case_id: Id,
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});
export type ProposalRequest = z.infer<typeof ProposalRequest>;

export const DecisionReason = z.object({
  code: ErrorCode,
  message: z.string(),
  rule_id: z.string().optional(),
});
export type DecisionReason = z.infer<typeof DecisionReason>;

export const PolicyRef = z.object({
  id: z.string(),
  version: z.string(),
});
export type PolicyRef = z.infer<typeof PolicyRef>;

export const ProposalResponse = z.object({
  action_id: Id,
  effect: DecisionEffect,
  state: ActionState,
  reasons: z.array(DecisionReason),
  policy: PolicyRef,
});
export type ProposalResponse = z.infer<typeof ProposalResponse>;

/** Header carrying the client's idempotency key on mutating requests. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IdempotencyKey = z.string().min(8).max(128);
