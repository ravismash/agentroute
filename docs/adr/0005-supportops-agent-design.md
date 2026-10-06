# ADR-0005: SupportOps agent design: tools as proposals, provider-agnostic, offline evals

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

SupportOps is the reference agent that shows AgentRoute in use. It must be realistic (an LLM with tools, streaming progress) but must never hold execution authority. It also has to be testable without paying for model calls, and must not lock the project into one model vendor.

## Decision

**Tools are proposals.** Each tool in the OpenAI Agents SDK (`apps/supportops-agent/src/tools.ts`) calls `POST /v1/proposals` and returns a short, explicit outcome to the model: `completed`, `pending_approval`, `denied`, `failed`, `processing` or `error`, with guidance such as "don't retry around a denial". The model never calls Stripe or the database.

**The caller binds the identifiers.** The case id comes from the run request, not the model. The customer id is a tool argument on purpose: the gateway checks it against the case, which is what the injection demos show.

**Idempotency comes from the model's call id.** The proposal key is `<run_id>:<tool_call_id>`, so a retried tool call or HTTP retry can't create a second action. The final reply is submitted by the runner as a `draft_reply` proposal (`<run_id>:reply`), so every customer-facing message is audited and policy-checked.

**Containment:** `maxTurns` stops tool loops and the customer still gets a safe fallback reply. The customer message is wrapped and labelled as untrusted data.

**SSE exposes actions, not thoughts.** Events are emitted from the tool layer (`tool.proposed`, `decision.made`, `approval.pending`, …), never from raw model output, so internal reasoning can't leak to clients.

**Provider-agnostic.** OpenAI (Responses API) or OpenRouter (OpenAI-compatible Chat Completions) is chosen by configuration. The SDK's trace export to OpenAI is **disabled**, because traces would contain customer messages; observability uses our own OpenTelemetry pipeline.

**Evals run in-process against the real policy.** `InProcessGateway` runs the real policy engine and baseline policy over an in-memory world. The 20 scenarios measure _model behaviour_ (what it proposes, what it tells the customer) with real policy decisions, but with no database, Stripe or side effects. Every scenario also has a script, so CI runs the whole pipeline offline with a `ScriptedModel`. With a key configured, the same suite runs against the live model.

## Consequences

- Evals report **policy saves**: proposals the gateway denied or escalated. A scenario can pass even when the model misbehaves, because the gateway contained it. That is the product's central claim, and it's measured explicitly.
- The scripted suite checks plumbing and scoring, not model quality. Model quality needs a live run (`pnpm evals`), which costs a few cents per run on the default model.
- Approval completion is reported by polling `GET /v1/actions/:id` (both SDKs provide it). A push channel from the gateway is deferred until the event pipeline exists (Phase 4).
- Python agents integrate through `sdk-python` (standard library only), which shows the gateway isn't tied to the TypeScript SDK.
