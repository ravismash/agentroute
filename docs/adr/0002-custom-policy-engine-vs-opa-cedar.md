# ADR-0002: Custom YAML policy engine instead of OPA or Cedar

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

The policy engine decides whether an agent's proposed action is allowed, denied, or needs human approval. Requirements (see `docs/design.md` §1, §9):

- Deterministic, fail-closed, default-deny, deny-overrides.
- Domain conditions beyond attribute matching: **money thresholds in minor units**, **context binding** (tool argument must equal server-side case data), and **aggregate limits** (sum/count of refunds per case, customer or tenant over a time window).
- Policies editable by support-ops staff, not just engineers, with validation and dry-run.
- Every decision explains itself: matched rule IDs, reason codes, policy version.
- p95 decision overhead under 25 ms.

## Options considered

1. **Open Policy Agent (Rego)** — mature, general-purpose, widely deployed. But Rego is unfamiliar to ops staff, aggregate limits need external data plumbing, and explaining _why_ a decision was made needs extra work. Running it as a sidecar adds a network hop and another deployable.
2. **Cedar** — strong typed authorization with analysis tooling. But it is modelled around principal/action/resource permissions, not money thresholds and time-windowed aggregates; those would live outside the policy anyway.
3. **Custom engine: YAML policy → Zod-validated model → pure TypeScript evaluator** — narrow, domain-specific, in-process, easy to explain and test exhaustively.

## Decision

Option 3. Policies are YAML files validated by a Zod schema at load time; invalid policies are rejected and the previous active version stays in force. The evaluator is a **pure function** — `evaluate(policy, proposal, context, usage)` — with usage aggregates supplied through an injected interface, so it can be unit- and property-tested without I/O.

This builds on prior experience designing and optimising policy-expression engines (classic → advanced policy conversion, evaluation across 1,000+ policies) in a network-gateway product.

## Consequences

- We own correctness of the engine: requires ≥ 90% coverage, property tests and a 1,000-rule benchmark (test plan P-01 … P-19).
- Expressiveness is intentionally limited; new condition types are added deliberately with tests.
- Ops-friendly YAML enables a dry-run endpoint: "what would this policy have decided for the last N proposals?"
- **Escape hatch:** the evaluator sits behind an interface, so an OPA or Cedar adapter can be added later (enhancement backlog #10) if a customer standardises on one.
