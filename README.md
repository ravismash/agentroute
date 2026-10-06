# AgentRoute

**Let AI agents take real business actions, without trusting the AI with the final decision.**

AgentRoute is a policy gateway for AI agents. The agent _proposes_ an action, such as a refund. AgentRoute _decides_, using the company's versioned rules:

| Proposal                                                    | Decision                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| $15 refund, valid reason, right customer                    | **allow**: executed automatically, exactly once   |
| $299 refund                                                 | **approval_required**: waits for a human operator |
| Refund for a different customer, split refunds, data export | **deny**: blocked and audited                     |

Every decision is logged with the policy version and rules that produced it, and every tenant is rate-limited and budget-capped.

**SupportOps Agent** is the reference customer-support agent that runs through AgentRoute.

> Status: **Phase 1: policy engine complete** (thresholds, context binding, aggregate limits, fail-closed, dry-run). See the [roadmap](#roadmap).

## Architecture

```
supportops-agent ──POST /v1/proposals──▶ gateway-api ──▶ policy-engine (pure, in-process)
      ▲                                      │
      │ SSE                                  ├─ Postgres: actions, decisions, outbox (one txn)
      │                                      ├─ Redis: rate limits, budget reservations
      │                                      └─ executor ──▶ Stripe (test mode) / mock CRM
approval-ui ──approve/reject──▶ gateway-api
outbox-relay ──▶ Redis Streams ──▶ worker (audit, budget) ──▶ Postgres / DLQ
```

Design rules:

1. The LLM is never the authority; execution uses the stored, policy-approved proposal.
2. Policy is default-deny, deny-overrides, fail-closed.
3. Tool arguments are checked against server-side case data, not LLM claims.
4. Money is integer minor units plus an ISO currency code.
5. The Postgres outbox is the source of truth; Redis Streams is a replayable transport.

Full details are in [docs/design.md](docs/design.md): requirements, SLOs, capacity, API, data model, consistency trade-offs and failure modes.

## Repository layout

```
apps/gateway-api/       Fastify gateway (health/readiness, RFC 7807 errors)
packages/policy-engine/ YAML policies → validated, pure, fail-closed evaluator; dry-run and policy comparison
packages/contracts/     Zod schemas: tools, proposals, action state machine, events, error codes
packages/telemetry/     pino logger with PII redaction, OpenTelemetry bootstrap
policies/               Versioned policy files (support-agent-baseline.v1.yaml)
infrastructure/         docker-compose (Postgres 16, Redis 7 with AOF)
docs/                   design doc, ADRs
.github/workflows/      CI: format, lint, typecheck, build, test, audit
```

## Quickstart

Requirements: Node 22+, Docker. pnpm is provided through Corepack.

```bash
corepack enable
pnpm install
pnpm infra:up        # Postgres on :5433, Redis on :6380
pnpm build
pnpm test
```

Run the gateway:

```bash
cp .env.example .env
pnpm --filter @agentroute/gateway-api start
curl localhost:8080/healthz
```

## Quality gates

| Command             | What it checks                                                     |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm lint`         | ESLint `strictTypeChecked`, no `any`, packages may not import apps |
| `pnpm typecheck`    | TypeScript strict mode, `noUncheckedIndexedAccess`                 |
| `pnpm test`         | Vitest unit tests                                                  |
| `pnpm format:check` | Prettier                                                           |

A Husky pre-commit hook runs ESLint and Prettier on staged files. CI runs all of the above plus `pnpm audit`.

## Policies

Policies are YAML files that support-ops staff can read and change. See the [policy reference](docs/policy-reference.md) for the evaluation order, rule types and how to dry-run a change.

## Architecture decisions

- [ADR-0001: TypeScript monorepo and core stack](docs/adr/0001-monorepo-and-stack.md)
- [ADR-0002: Custom YAML policy engine instead of OPA or Cedar](docs/adr/0002-custom-policy-engine-vs-opa-cedar.md)

## Roadmap

| Phase | Days  | Scope                                                                            |
| ----- | ----- | -------------------------------------------------------------------------------- |
| 0     | 1–2   | ✅ Foundations: monorepo, contracts, telemetry, gateway skeleton, CI, design doc |
| 1     | 3–6   | ✅ Policy engine: thresholds, context binding, aggregate limits, dry-run         |
| 2     | 7–10  | Action store, state machine, idempotent execution, approvals                     |
| 3     | 11–13 | SupportOps agent, SSE, evals, Python SDK                                         |
| 4     | 14–16 | Outbox relay, Redis Streams consumers, DLQ, replay                               |
| 5     | 17–18 | Rate limits, budgets, circuit breakers, kill switch                              |
| 6     | 19–20 | Fault injection, load tests, dashboards, threat model                            |
| 7     | 21–22 | Cloud Run deployment, Helm chart                                                 |
| 8     | 23–24 | Buffer and design-partner beta                                                   |
| 9     | 25    | Proof package: docs, video, article, `v0.1.0-beta`                               |
