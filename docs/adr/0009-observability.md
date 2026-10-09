# ADR-0009: Observability — metrics, tracing, dashboards and alerts

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Phase 6 makes the system observable in production: answer "is it healthy, fast, and behaving?" from signals, not guesswork, and alert before users notice. The design doc (§1.14) names the SLIs (decision availability and latency, execution success, audit lag, approval-queue age) and the alerts (SLO burn, DLQ, deny-rate anomaly, breaker open). The gateway already had an OTLP tracing bootstrap but emitted no spans, and there were no metrics.

## Decision

**Metrics (`prom-client`, in `@agentroute/telemetry`).** A single `Metrics` registry per process, exposed at **`GET /metrics`** in Prometheus text format, with:

- `agentroute_decisions_total{effect,tool}` — decision mix;
- `agentroute_decision_duration_seconds{effect}` — the **decision overhead** (policy evaluation + persistence, _excluding_ the LLM), with buckets straddling the **p95 < 25 ms SLO** so the target is visible without post-processing;
- `agentroute_executions_total{outcome}` — money-action outcomes;
- `agentroute_rate_limited_total{scope}` — rate-limit rejections;
- `agentroute_http_request_duration_seconds{method,route,status}` — HTTP latency by low-cardinality route;
- Node process/GC defaults.

The registry is created in `server.ts` and shared by the HTTP layer (the `/metrics` endpoint and an `onResponse` hook) and the `ProposalService` (decision and execution instrumentation), so there is one source of truth and no global singleton to leak across tests.

**Tracing (OpenTelemetry).** A `withSpan` helper wraps the decision path so a proposal produces a trace: `proposal.decide` (the policy-evaluation-and-persist transaction) and, for allowed actions, `proposal.execute`. Spans export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local dev and tests need no collector; exceptions set the span status to error.

**Dashboards and alerts as code.** `infrastructure/observability/` holds a Grafana dashboard (`grafana-dashboard.json`), a Prometheus scrape config (`prometheus.yml`) and alert rules (`alerts.yml`: decision-latency SLO breach, execution failures, deny-rate spike, rate-limit pressure, 5xx). `infrastructure/k6/proposals.js` is a k6 ramp whose thresholds assert the p95 < 25 ms / p99 < 75 ms decision SLO.

## Consequences

- Metrics and `/metrics` are **always on** and cheap; tracing is opt-in via the OTLP endpoint, so there's no hard collector dependency.
- The SLO is now a **measured number** (`decision_duration` p95), not a claim — the dashboard and the k6 threshold both check it.
- Instrumentation is confined to the gateway's decision path and HTTP layer. **Not yet done:** agent-side LLM metrics (provider errors/latency, `maxTurns` hits, fallback replies, budget denials) and a dedicated provider-fault-injection suite — the circuit-breaker/retry tests (Phase 5) already simulate provider 503/timeout, but surfacing those as agent metrics is follow-on work.
- Cardinality is kept low on purpose: `tool` and `effect` are bounded; HTTP uses the route template, never the raw URL.
