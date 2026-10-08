# ADR-0008: Rate limits (fail-open), LLM budgets (fail-closed), and circuit breakers

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

Phase 5 adds the abuse, cost and resilience controls. Three concerns, each with a different correctness/availability trade-off:

1. **Rate limiting** — stop a single key or tenant (a runaway agent loop, a buggy integration) from flooding the gateway.
2. **LLM budget** — cap a tenant's daily model spend so a loop can't run up an unbounded bill.
3. **Provider failures** — a flaky or slow LLM/Stripe must not be hammered or allowed to stall the agent indefinitely.

The kill switch (deny all proposals for a tenant) already exists from Phase 2; `maxTurns` already bounds an agent run.

## Decision

A new pure package, `@agentroute/limits`, holds four primitives so the policy matches the plan's CAP choices (design doc §1.10) exactly:

**Token-bucket rate limiter (`RateLimiter`) — fail-open.** An atomic Lua token bucket in Redis, checked per API key and per tenant (keys hash-tagged by tenant so a bucket lives on one Redis Cluster slot). Refill and take happen in one script, so concurrent callers can't over-draw. If Redis is unreachable, the limiter **falls open** to a per-process in-memory bucket and never blocks the request path — availability over precision. Wired into `POST /v1/proposals`; a limited request gets `429` + `Retry-After`. Active only when `REDIS_URL` is set; defaults sit above benchmark traffic and are tuned down per tenant.

**Budget ledger (`BudgetLedger`) — fail-closed.** An atomic Lua reserve/reconcile against a per-tenant daily counter (`tenants.daily_llm_budget_minor`). The estimated cost is reserved _before_ a model call; if it would exceed the ceiling the call is blocked (`BudgetExceededError`, so **no provider call is made**), and the actual cost is reconciled afterwards. If Redis is unavailable, `reserve` **denies** — cost safety over availability, the opposite choice from rate limiting. The counter expires at UTC midnight.

**Circuit breaker + bounded retry (`CircuitBreaker`, `withRetry`).** A three-state breaker fast-fails after N consecutive provider failures and half-opens after a cooldown; retries use full-jitter exponential backoff with a per-attempt timeout. The agent wraps its model in a `GuardedModel` that applies budget → breaker → retry around each tool-loop call, so a flaky LLM degrades to a human handoff instead of a hot loop.

## Why fail-open rate limits but fail-closed budgets

They protect different things. A missed rate-limit check costs a few extra requests — tolerable, and blocking all traffic because Redis blinked is worse than the overage. A missed budget check costs real money with no ceiling — so when the ledger is unavailable, the safe answer is "don't spend."

## Consequences

- Rate limiting and budgets are **Redis-dependent but degrade deliberately**: one fails open, the other fails closed. Neither can wedge the decision path.
- The primitives are provider-agnostic and unit/integration tested (token bucket, budget reserve/reconcile under concurrency, breaker state transitions, retry/backoff) plus an HTTP-level `429` test on the gateway and a `GuardedModel` test on the agent (tests R-01…R-04; R-05 `maxTurns` and R-06 kill switch predate this phase).
- Still out of scope: model routing (cheap model first, escalate) and surfacing budget/limit metrics — these land with the Phase 6 observability work.
