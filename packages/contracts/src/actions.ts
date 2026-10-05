import { z } from "zod";

export const ACTION_STATES = [
  "proposed",
  "denied",
  "allowed",
  "approval_required",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "executing",
  "succeeded",
  "failed",
] as const;

export const ActionState = z.enum(ACTION_STATES);
export type ActionState = z.infer<typeof ActionState>;

/**
 * The only legal transitions. Everything else must be rejected with
 * ACTION_INVALID_STATE. `failed → executing` is a bounded retry that
 * reuses the same downstream idempotency key.
 */
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  proposed: ["denied", "allowed", "approval_required"],
  allowed: ["executing"],
  approval_required: ["approved", "rejected", "expired", "cancelled"],
  approved: ["executing"],
  executing: ["succeeded", "failed"],
  failed: ["executing"],
  denied: [],
  rejected: [],
  expired: [],
  cancelled: [],
  succeeded: [],
};

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ActionState): boolean {
  return ACTION_TRANSITIONS[state].length === 0;
}
