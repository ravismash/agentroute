# AgentRoute — System Design

> Living document. Update it in the same PR as any change to requirements, APIs, data model, or failure behaviour.

## Purpose

AgentRoute is a policy gateway for AI agents. Agents **propose** tool actions; AgentRoute **decides** (allow / deny / approval-required) using versioned, deterministic tenant policies, executes approved actions effectively-once, and records an audit trail. SupportOps Agent is the reference customer-support agent.

## 1. Functional requirements

1. Agents submit **tool proposals** (tool, args, case context); gateway returns `allow | deny | approval_required` with reasons.
2. Allowed actions execute **exactly once in effect** against downstream systems (Stripe test mode, mock CRM).
3. Operators list, approve, reject pending actions; pending actions expire after a TTL.
4. Tenants have versioned YAML policies; policies can be validated and dry-run before activation.
5. Every proposal, decision, approval, and execution is audit-logged with policy version.
6. Per-tenant rate limits, daily LLM budget ceilings, and a kill switch.
7. Agent run progress streamed to clients over SSE.

## 2. Non-functional requirements (SLOs)

| Property                                  | Target                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Availability (gateway decision API)       | 99.9% monthly                                                                                  |
| Decision latency (excl. LLM + downstream) | p95 < 25 ms, p99 < 75 ms                                                                       |
| Money-action correctness                  | 0 duplicate executions; 0 executions without an allow/approved decision                        |
| Audit durability                          | 0 lost audit events (RPO = 0 for decisions; audit stream eventually consistent, lag p95 < 5 s) |
| Recovery                                  | RTO < 30 min (redeploy + DB restore runbook)                                                   |
| Tenant isolation                          | No cross-tenant reads/writes (enforced in queries + tests)                                     |
| Security posture                          | Fail-closed on policy/budget errors; secrets never in code/logs                                |

## 3. Out of scope (v0.1)

Real CRM integrations, SSO for operators, multi-region active-active, billing customers, custom policy DSL beyond YAML conditions.

## 4. Capacity estimation (design target vs beta reality)

- **Design target:** 50 tenants × 10k support cases/day × ~3 proposals/case ≈ **1.5M proposals/day ≈ 17 RPS avg, ~175 RPS peak (10×)**. Load-test to **500 RPS** for headroom.
- **Storage:** ~3 KB per proposal (action + decision + outbox + audit) ≈ 4.5 GB/day → ~400 GB for 90-day hot retention → **monthly partitioning** of `audit_log` and `outbox`; archive older partitions to object storage.
- **Redis:** rate-limit + budget keys per tenant/key, ~KBs per tenant; streams trimmed with `MAXLEN ~` after consumer ack.
- **Beta reality:** 3–5 tenants, < 1 RPS. Single-node Postgres + single Redis are sufficient; the design documents how to scale (§11).

## 5. API design (versioned `/v1`, JSON, RFC 7807 errors)

| Method & path                               | Purpose                              | Auth             | Notes                                                                                  |
| ------------------------------------------- | ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------- |
| `POST /v1/proposals`                        | Submit tool proposal, get decision   | Tenant API key   | `Idempotency-Key` required; returns `action_id`, `effect`, `reasons`, `policy_version` |
| `GET /v1/actions/:id`                       | Action status                        | Tenant API key   | Tenant-scoped                                                                          |
| `GET /v1/actions/:id/events`                | SSE action status stream             | Tenant API key   |                                                                                        |
| `GET /v1/cases/:id/context`                 | Read customer/subscription for agent | Tenant API key   | Read tools go through here                                                             |
| `GET /v1/approvals?status=pending`          | Approval queue                       | Operator session | Cursor pagination                                                                      |
| `POST /v1/approvals/:id/approve` / `reject` | Decide                               | Operator session | Atomic; 409 on wrong state                                                             |
| `POST /v1/policies:validate` / `:dryRun`    | Validate / simulate policy           | Operator         | Dry-run against stored proposals                                                       |
| `PUT /v1/policies/:tenant/active`           | Activate policy version              | Operator         | Audited                                                                                |
| `POST /v1/admin/kill-switch`                | Global / tenant kill switch          | Admin            | Audited                                                                                |
| `GET /healthz`, `/readyz`, `/metrics`       | Ops                                  | Internal         | readyz checks DB + Redis                                                               |

Pagination: cursor-based. Rate-limit headers: `RateLimit-Limit/Remaining`, `Retry-After`.

## 6. Data model (Postgres)

| Table                                   | Key columns                                                                                      | Indexes / constraints                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `tenants`                               | id, name, status, daily_budget_minor                                                             |                                                                          |
| `api_keys`                              | id, tenant_id, prefix, hash, revoked_at                                                          | unique(prefix)                                                           |
| `policies`                              | id, tenant_id, version, yaml, checksum, active                                                   | unique(tenant_id, version); one active per tenant (partial unique index) |
| `cases` / `customers` / `subscriptions` | tenant_id, ids, currency                                                                         | FK + tenant_id on all                                                    |
| `actions`                               | id, tenant_id, case_id, tool, args_json, amount_minor, currency, state, idempotency_key, version | unique(tenant_id, idempotency_key); index(tenant_id, state, created_at)  |
| `decisions`                             | action_id, effect, matched_rules, reasons, policy_version                                        | FK actions                                                               |
| `approvals`                             | action_id, operator_id, decision, decided_at, expires_at                                         | index(expires_at) where pending                                          |
| `executions`                            | action_id, attempt, provider_ref, status                                                         | **unique(action_id) for success row**                                    |
| `outbox`                                | id, tenant_id, type, payload, created_at, published_at                                           | index where published_at is null; partitioned monthly                    |
| `audit_log`                             | event_id, tenant_id, type, payload, ts                                                           | unique(event_id); partitioned monthly                                    |
| `processed_events` / `dead_letters`     | consumer, event_id / payload, error, attempts                                                    | unique(consumer, event_id)                                               |

Optimistic concurrency via `actions.version`; state changes via `UPDATE … WHERE id=$1 AND state=$expected`.

## 7. High-level architecture

```
Client / support case
      │
      ▼
supportops-agent ──(POST /v1/proposals)──▶ gateway-api ──▶ policy-engine (pure, in-process)
      ▲                                       │
      │  SSE status                           ├─ Postgres: actions, decisions, outbox (same txn)
      │                                       ├─ Redis: rate limits, budget reservations (Lua)
      │                                       └─ executor ──▶ Stripe (test mode) / mock CRM
      │
approval-ui ──(approve/reject)──▶ gateway-api
outbox-relay ──▶ Redis Streams ──▶ worker (audit + budget consumer groups) ──▶ Postgres / DLQ
```

**Key design rules**

1. The LLM is never the authority. Execution uses the **stored, policy-approved proposal**; the LLM is never re-run to decide parameters after approval.
2. Policy is **default-deny, deny-overrides, fail-closed**. Every decision records `policy_id`, `policy_version`, and matched rule IDs.
3. Tool arguments are validated against **server-side case data** (customer ID, subscription), not LLM claims.
4. Money is **integer minor units + ISO currency** (`amount_minor`, `currency`).
5. Postgres outbox is the **source of truth**; Redis Streams is a replayable transport.

## 8. Request flows

**A. Auto-allow ($15 refund)**
agent → `POST /v1/proposals` → authN (key hash) → rate limit (Redis) → load case context (PG) → usage aggregates (PG) → `evaluate()` → **txn{ insert action(allowed), decision, outbox }** → CAS `allowed→executing` → Stripe refund (idempotency key = action_id) → CAS `executing→succeeded` + outbox → 200 / SSE `action.succeeded`.

**B. Approval ($299 refund)**
… `evaluate()` = approval_required → txn{ action(approval_required), decision, approval(expires_at), outbox } → 202 → operator approves → CAS `approval_required→approved` (409 if lost race) → executor as in A → agent re-invoked only to draft follow-up reply.

**C. Deny (injection: wrong customer)**
… context binding fails → txn{ action(denied), decision(POLICY_CONTEXT_MISMATCH), outbox } → 403-style decision body (HTTP 200 with `effect: deny`; HTTP errors reserved for transport/auth errors).

## 9. Deep dives

- **Policy evaluation:** policies compiled at load into an index by `tool` → evaluation is O(rules for that tool); compiled policy cached per tenant+version in memory, invalidated by version change (pub/sub). Pure function → trivially unit/property tested.
- **Exactly-once effect:** at-least-once execution attempts + idempotent downstream (Stripe idempotency key) + CAS state transitions + unique success execution row = effectively-once.
- **Aggregate limits:** usage sums read inside the decision txn with `SELECT … FOR UPDATE` on a per-case/customer counter row to prevent two concurrent $24 refunds both passing.
- **Outbox:** relay uses `FOR UPDATE SKIP LOCKED` batches; consumers dedupe via `processed_events`; DLQ after N attempts; replay CLI.
- **Budget:** Redis Lua reserve (check + increment atomically) before LLM call; reconcile actual tokens async; ledger persisted to PG by budget consumer.

## 10. Consistency & CAP trade-offs

| Data                                      | Model                                                           | Why                                         |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| Actions, decisions, approvals, executions | **Strong** (single Postgres primary, serializable-safe CAS)     | Money correctness                           |
| Audit log, spend ledger, metrics          | **Eventual** via outbox → streams                               | Doesn't block the decision path; replayable |
| Rate limits                               | Best-effort (Redis) — **fail-open** with local fallback limiter | Availability over precision                 |
| Budget ceiling                            | **Fail-closed** if Redis unavailable                            | Cost safety over availability               |
| Policy                                    | **Fail-closed**                                                 | Safety over availability                    |

Under partition, the system chooses **consistency (CP)** for money actions and **availability (AP)** for rate limiting/telemetry.

## 11. Scalability plan

- Gateway, agent: **stateless**, horizontal autoscale (Cloud Run concurrency / K8s HPA on CPU + RPS).
- Postgres: connection pooling (PgBouncer / Cloud SQL connector), read replicas for approval UI & audit queries, time partitioning for `audit_log`/`outbox`, tenant_id-leading indexes; future sharding key = `tenant_id`.
- Redis: keys hash-tagged by tenant (`{tenant}:rl:…`) → Redis Cluster-ready.
- Consumers: scale via consumer groups; partition streams per event type.
- Hot-tenant protection: per-tenant rate limit + concurrency cap (bulkhead).

## 12. Availability & failure modes

| Failure             | Behavior                                                                                                      | Detection                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Postgres down       | Proposals rejected 503 (fail closed); readyz fails                                                            | DB error rate alert               |
| Redis down          | Rate limit falls back to in-process limiter; budget-gated LLM calls blocked; relay pauses, outbox accumulates | readyz degraded, outbox lag alert |
| Stripe timeout      | Retry w/ same idempotency key, bounded; then `failed` + alert                                                 | execution failure metric          |
| LLM 429/timeout     | Retry w/ jitter, circuit breaker opens, agent returns "escalated to human"                                    | breaker state metric              |
| Worker crash        | Pending messages reclaimed via XCLAIM                                                                         | consumer lag alert                |
| Bad policy deployed | Rejected at validation; if logic bad → instant rollback to previous version                                   | deny-rate spike alert             |
| Runaway agent loop  | Max-turns cap + budget ceiling + kill switch                                                                  | budget burn alert                 |

Deployments: rolling with health checks; DB migrations **expand → migrate → contract** (backward compatible).

## 13. Security design

- **AuthN:** tenant API keys (prefix + SHA-256 hash, shown once, rotatable); operators via session auth (or Cloud IAP); service-to-service via signed tokens / private networking.
- **AuthZ:** RBAC — `tenant_agent`, `operator`, `admin`; every query scoped by `tenant_id` (repository layer enforces; optional Postgres RLS).
- **Data:** TLS everywhere; PII redaction in logs/audit; minimal data sent to LLM; secrets in Secret Manager.
- **Threat model (STRIDE)** in `docs/threat-model.md`: prompt injection, confused deputy, replay, privilege escalation, key leakage, DoS, policy tampering.
- **Supply chain:** lockfile, `pnpm audit`, image scanning, pinned base images, Dependabot.

## 14. Observability

- **SLIs:** decision availability, decision latency, execution success rate, audit lag, approval queue age.
- **Alerts:** SLO burn rate (multi-window), DLQ > 0, outbox lag > 60 s, deny-rate anomaly, budget > 80%, breaker open.
- **Tracing:** one trace per proposal spanning gateway → policy → DB → executor → relay → consumer.
- **Logs:** structured, correlated, redacted. **Dashboards** committed as code.

## 15. Data lifecycle

Audit retention 90 days hot, then archive; daily automated backups + PITR (RPO ≤ 5 min for managed PG); restore drill documented in runbook; tenant data deletion procedure.

## 16. Key trade-offs (each becomes an ADR)

ADR-001 Monorepo & stack · ADR-002 Custom YAML engine vs OPA/Cedar · ADR-003 Outbox + Redis Streams vs managed queue (Pub/Sub) · ADR-004 Cloud Run vs Kubernetes (+Helm for portability) · ADR-005 No LLM re-run after approval · ADR-006 Fail-open rate limits vs fail-closed budget/policy · ADR-007 Effectively-once execution via idempotency keys.
