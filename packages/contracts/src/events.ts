import { z } from "zod";
import { Id, IsoTimestamp } from "./primitives.js";

export const EVENT_TYPES = [
  "action.proposed",
  "decision.made",
  "approval.requested",
  "approval.decided",
  "action.executing",
  "action.succeeded",
  "action.failed",
  "action.expired",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/**
 * Envelope written to the Postgres outbox and relayed to Redis Streams.
 * `event_id` is the consumer dedupe key.
 */
export const EventEnvelope = z.object({
  event_id: z.uuid(),
  type: EventType,
  tenant_id: Id,
  action_id: Id,
  occurred_at: IsoTimestamp,
  trace_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
