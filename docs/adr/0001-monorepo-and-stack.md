# ADR-0001: TypeScript monorepo and core stack

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

AgentRoute has several deployables (gateway, reference agent, approval UI, worker) that must share exactly the same tool schemas, API contracts, action states and event types. Drift between them is a correctness risk: a gateway and agent that disagree on a refund schema could approve something different from what was proposed. The project is built by one engineer on a 25-day schedule, so tooling must be low-ceremony.

## Options considered

1. **Polyrepo** — strong isolation, but contract changes need coordinated releases; too slow for one engineer.
2. **Monorepo, TypeScript, pnpm workspaces + Turborepo** — one PR changes contracts and all consumers; cached, dependency-ordered builds.
3. **Monorepo, mixed languages (e.g. Go gateway, TS agent)** — faster gateway, but contracts must be duplicated or code-generated across languages from day one.

## Decision

Option 2.

- **Language:** TypeScript in strict mode (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), ESM, Node 22+.
- **Workspace:** pnpm workspaces, Turborepo task graph (`build` → `typecheck`/`test`).
- **Contracts:** Zod 4 schemas in `packages/contracts` are the single source of truth; OpenAPI and the Python SDK are derived from them.
- **HTTP:** Fastify 5 (low overhead, built-in request IDs, `inject()` for fast tests).
- **Logging/tracing:** pino with PII redaction; OpenTelemetry, enabled only when an OTLP endpoint is configured.
- **Quality gates:** ESLint (`strictTypeChecked`), Prettier, Vitest, Husky + lint-staged, CI on every PR.
- **Boundary rule:** `packages/*` may never import from `apps/*` (enforced by ESLint).
- **TypeScript is pinned to 6.0.x** because typescript-eslint 8 does not yet support TypeScript 7.

## Consequences

- Contract changes are atomic across the system and caught by the type checker.
- Packages must be built before dependents type-check; Turborepo handles ordering and caching.
- A future high-throughput component can still be written in another language behind the HTTP contract; the OpenAPI spec makes that possible.
- Revisit the TypeScript pin when typescript-eslint supports TypeScript 7.
