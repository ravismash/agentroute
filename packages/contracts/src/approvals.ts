import { z } from "zod";
import { ActionState } from "./actions.js";
import { DecisionEffect, DecisionReason } from "./proposals.js";
import { Id, IsoTimestamp } from "./primitives.js";

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Body of `POST /v1/approvals/:actionId/approve|reject`. */
export const ApprovalDecisionRequest = z.strictObject({
  note: z.string().max(1000).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

/** One item in the operator approval queue. */
export const ApprovalItem = z.object({
  action_id: z.uuid(),
  tenant_id: Id,
  case_id: Id,
  customer_id: Id,
  agent_id: Id,
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  status: ApprovalStatus,
  reasons: z.array(DecisionReason),
  matched_rules: z.array(z.string()),
  requested_at: IsoTimestamp,
  expires_at: IsoTimestamp,
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const ApprovalPage = z.object({
  items: z.array(ApprovalItem),
  next_cursor: z.string().nullable(),
});
export type ApprovalPage = z.infer<typeof ApprovalPage>;

/** `GET /v1/actions/:id` */
export const ActionView = z.object({
  action_id: z.uuid(),
  case_id: Id,
  tool: z.string(),
  state: ActionState,
  effect: DecisionEffect,
  reasons: z.array(DecisionReason),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  execution: z
    .object({
      status: z.enum(["started", "succeeded", "failed", "unknown"]),
      attempt: z.number().int(),
      provider_ref: z.string().nullable(),
      error_code: z.string().nullable(),
    })
    .nullable(),
});
export type ActionView = z.infer<typeof ActionView>;
