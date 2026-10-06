# ADR-0007: Event pipeline: transactional outbox → Redis Streams → idempotent consumers

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Every decision, approval and execution must reach the audit trail and other consumers (stats today; budgets and notifications later) **without**:

- slowing down or failing the decision API when Redis or a consumer is down,
- losing an event if a process crashes at the wrong moment,
- applying an event twice when it is redelivered,
- letting one bad event block everything behind it.

## Options considered

1. **Write to Redis inside the request** ("dual write"): a crash between the database commit and the publish loses the event, or publishes an event for a rolled-back change. Rejected.
2. **Managed queue (Google Pub/Sub, SQS):** good durability, but it's another cloud dependency for local development and tests, and we'd still need an outbox to avoid dual writes.
3. **Transactional outbox in Postgres + relay to Redis Streams + consumer groups:** chosen.

## Decision

**Producers** write events to `outbox` in the _same transaction_ as the state change (Phase 2). An event exists if and only if the change committed.

**Relay** (`apps/worker/src/relay.ts`):

- Locks a batch of unpublished rows with `FOR UPDATE SKIP LOCKED`, `XADD`s them in one pipeline, marks them published, and commits. Several relays can run without double-publishing (test E-05).
- It is woken by Postgres `LISTEN/NOTIFY` (migration 0003, measured 157 ms proposal-to-audit locally), with polling as the fallback because `NOTIFY` isn't durable.
- A crash after `XADD` and before `COMMIT` republishes the batch: delivery is **at-least-once**.

**Consumers** (`apps/worker/src/consumer.ts`) use Redis consumer groups:

- **Effectively-once effect:** the handler runs in one Postgres transaction together with `INSERT INTO processed_events (consumer, event_id)`. A redelivered event finds the row and is skipped (E-01: duplicate publish still gives one audit row; stats counters are not double-counted).
- **Ack after commit.** A crashed consumer's messages stay pending, and another consumer takes them over with `XAUTOCLAIM` after `CLAIM_IDLE_MS` (E-02).
- **Dead-letter queue:** after `MAX_DELIVERIES`, or immediately for malformed messages, the message is stored in `dead_letters`, copied to a DLQ stream and acknowledged, so a poison message never blocks the group (E-03).

**Recovery** (`pnpm --filter @agentroute/worker replay …`):

- `dlq retry` re-publishes dead letters _from the outbox_ (the source of truth) after a fix.
- `outbox --since` rebuilds the stream after Redis data loss (E-04).
- Both are safe to repeat because consumers deduplicate.

**Monitoring:** `GET /status` on the worker (and `replay status`) reports the outbox backlog and oldest unpublished age, stream length, per-group pending and lag, and unreplayed dead letters: the signals an on-call engineer needs first. These become metrics and alerts in Phase 6.

**Background jobs** (approval expiry, execution reconciliation) moved from the gateway into the worker, so the request-serving tier is stateless. Execution code moved to `packages/execution`, so both processes share it. The gateway can still run the jobs with `RUN_BACKGROUND_JOBS=true` for single-process setups.

## Consequences

- The decision API's availability doesn't depend on Redis or the worker: verified live by `kill -9` on the worker under traffic, with 12 events buffered and every one delivered after restart (62 outbox events → 62 audit rows).
- Ordering is per relay batch, not global across relays. Consumers must not rely on cross-event order; the audit log orders by `occurred_at`.
- The stream is capped (`MAXLEN ~ 100000`); history beyond that lives in Postgres.
- Redis 8.2's idempotent `XADD` (`IDMP`) could remove relay-side duplicates. We target Redis 7, so consumer-side dedupe remains the guarantee either way.
- Outbox and audit tables grow without bound; monthly partitioning and archiving are planned (design doc §4).
