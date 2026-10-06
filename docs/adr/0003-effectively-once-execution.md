# ADR-0003: Effectively-once execution of money actions

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

An approved refund must reach the customer **exactly once**. The failure modes are real:

- an operator double-clicks Approve, or two operators approve at the same moment;
- the gateway crashes after Stripe accepted the refund but before we recorded it;
- a network timeout leaves us not knowing whether Stripe processed the request;
- two refunds race against the same payment and together exceed what was paid.

True exactly-once delivery across a network is impossible. We need an _effect_ that happens once.

## Options considered

1. **Single transaction around the provider call:** holds a database transaction open during a slow network call and still cannot roll back Stripe. Rejected.
2. **Retry until success:** a timeout followed by a retry can refund twice when the first call actually succeeded. Rejected.
3. **Three-step execution with database guards, provider idempotency and reconciliation:** chosen.

## Decision

Execution is split into three steps (`apps/gateway-api/src/services/execution.ts`):

1. **Begin (transaction):** lock the action row (`SELECT … FOR UPDATE`), check it is executable, **reserve** the refund amount on the payment row, insert an execution attempt, and move the action to `executing`.
2. **Perform (no transaction):** call Stripe with an idempotency key `agentroute:<action_id>:<attempt>` and the action id in refund metadata.
3. **Finish (transaction):** record `succeeded`, `failed` (release the reservation) or `unknown`.

Guards enforced by the database (see `docs/database.md`):

| Guard                                                                         | Prevents                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Conditional `UPDATE approvals … WHERE status = 'pending'`                     | Two approvals of the same action                      |
| `uq_executions_one_open` (one `started`/`unknown` attempt per action)         | Concurrent or blind retries                           |
| `uq_executions_one_success`                                                   | Two successful executions                             |
| `ck_payments_refunded` (`refunded ≤ amount`) with reservation before the call | Over-refunding a payment                              |
| Immutable action fields (trigger)                                             | Executing different parameters from what was approved |

**Unknown outcomes are never retried.** A reconciler asks Stripe what happened (refunds for the payment intent whose metadata carries our action id) and records the real result. It also picks up attempts stuck in `started` after a crash.

## Consequences

- Concurrency is proven by tests: 10 simultaneous approvals lead to 1 Stripe call; concurrent identical proposals lead to 1 action; concurrent split refunds can't both pass the limit.
- An unknown outcome leaves the action in `executing` until reconciled (at least 30 s). That latency is the price of never double-refunding.
- A new provider must support either idempotency keys or a way to look up our operation by a reference we supply; otherwise it can't be integrated safely.
- The reconciler currently runs in the gateway on a timer; it moves to the worker in Phase 4.
