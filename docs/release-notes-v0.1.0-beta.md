# AgentRoute v0.1.0-beta

First public beta. A policy gateway for AI agents: the agent **proposes** an action, a deterministic policy layer **decides** (allow / approval_required / deny), approved actions execute **exactly once**, and everything is audited.

**Live demo:** https://agentroute-gateway.onrender.com/ui/ (Render free tier; first request after idle cold-starts ~30 s).

## Highlights

- **Deterministic policy engine** — versioned YAML, default-deny, deny-overrides, fail-closed. Context binding (arguments checked against server-side case data, not the model's claims), numeric thresholds, and aggregate limits (per case / customer / tenant over a window). Pure and unit/property-tested.
- **Effectively-once execution** — per-attempt provider idempotency keys, reconciliation of indeterminate (timed-out) outcomes against the provider by `metadata.action_id`, CAS state transitions, and a one-successful-execution-per-action database constraint. Stripe test-mode integration with an in-memory fake fallback.
- **Human-in-the-loop approvals** — large or unusual actions escalate; the operator approves the **stored, immutable** proposal, and the model is never re-asked after approval. Double-approve is a 409.
- **Event pipeline** — transactional outbox → Redis Streams → idempotent consumers (audit, stats), dead-letter queue, and a replay CLI. The Postgres outbox is the source of truth; Redis is a replayable transport.
- **Reference agent + SDKs** — SupportOps agent (OpenAI Agents SDK) whose tools are gateway proposals, SSE run streaming, a typed TypeScript client, and a dependency-free Python client.
- **AI-engineering concerns addressed with tests** — reply grounding (claims checked against actual actions), help-center RAG (BM25 + embeddings + RRF), LLM-as-judge calibrated against hand labels, offline scenario evals in CI.

## Verified results (local, reproducible)

- End-to-end checks **30/30**; defensive red-team **32/32 attacks blocked**.
- Load: **476 req/s, p95 153 ms, 0% errors**, with every event accounted for in the audit log.
- Reliability: `kill -9` on the worker under live traffic — 12 events buffered, all 62 delivered exactly once after restart, zero lost or duplicated.
- Retrieval: held-out recall@5 **0.75 (BM25) → 0.92 (hybrid)**; LLM judge calibrates at **Cohen's κ 0.92** vs hand labels.

Agent-level results are **directional, not a benchmark** (24 scenarios, one run per model). The hard invariants hold across models because they're enforced in deterministic code below the model — see [docs/eval-results.md](docs/eval-results.md).

## Deploy it yourself

Render blueprint (`render.yaml`) or `docker compose`. See [docs/deploy.md](docs/deploy.md). Requires a Stripe **test-mode** key (optional — omit it to use the in-memory fake) and, for the agent, an OpenRouter or OpenAI key.

## Not yet in this beta

Rate limits / per-tenant LLM budgets / circuit breakers (Phase 5), full OpenTelemetry tracing + dashboards + k6 load suite (Phase 6), and design-partner feedback (Phase 8).

## Docs

Design doc, 7 ADRs, threat model, policy reference, and database schema under [`docs/`](.).
