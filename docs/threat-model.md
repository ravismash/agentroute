# Threat model

AgentRoute's job is to let AI agents take real actions **without trusting the agent**. The agent is treated as a potentially-compromised client: its instructions may have been hijacked by prompt injection, and its tool arguments are hostile input. Security is enforced by the gateway, policy engine and database, never by the model.

The adversarial test suite `apps/gateway-api/src/scripts/redteam.ts` (`pnpm redteam`) runs these attacks against a local instance and asserts each is blocked. It is a defensive regression test for the guarantees below.

## Trust boundaries

| Component                          | Trust                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| LLM / agent                        | **Untrusted.** May be prompt-injected; its outputs are proposals, never commands |
| Customer message                   | **Untrusted data**, delimited and never interpreted as instructions              |
| Tenant API client                  | Authenticated per tenant; scoped to its own data                                 |
| Operator                           | Authenticated; scoped to its own tenant (admins cross-tenant)                    |
| Gateway / policy engine / database | **Trusted enforcement layer**                                                    |
| Stripe (test mode)                 | Trusted provider, reached with idempotency keys                                  |

## STRIDE

| Threat                     | Risk                                                    | Mitigation                                                                                                                    | Test                                                    |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Spoofing**               | Forged or stolen API keys                               | Keys stored as SHA-256 + prefix; constant-time compare; revocation checked per request; operator vs tenant surfaces separated | `authentication`                                        |
| **Tampering**              | Altering an approved action, or the audit trail         | Action business fields immutable (trigger); decisions and `audit_log` append-only; policy versions immutable                  | db `schema.test.ts`                                     |
| **Repudiation**            | "The agent did X, not me"                               | Every proposal, decision, approval and execution is audit-logged with policy version, checksum and trace id                   | `event pipeline`                                        |
| **Information disclosure** | PII/secrets in logs; cross-tenant reads; path traversal | PII redaction in logs and audit; tenant_id scoping + composite FKs (IDOR blocked); static UI served from a fixed allow-list   | `data protection`, `tenant isolation`, `path traversal` |
| **Denial of service**      | Oversized/nested payloads; runaway agents; cost loops   | 64 KB body limit; JSON depth limits; per-tenant kill switch; rate limits & budgets (Phase 5)                                  | `resource exhaustion`, `kill switch`                    |
| **Elevation of privilege** | Confused deputy: agent acts beyond policy               | Default-deny policy; server-side context binding; aggregate limits; approval for risky actions; blocked-tool list             | `prompt injection → action`                             |

## Agent-specific threats

- **Prompt injection → action.** The classic attack is text in a customer message that tells the agent to refund someone else, export data, or skip review. **Defense:** the gateway re-derives the truth server-side. Refund `customer_id` must match the case's customer; amounts over threshold escalate; totals across split refunds aggregate; blocked and unlisted tools are denied. The model cannot talk its way past policy because policy never reads the model's justification.
- **Confused deputy via identifiers.** The agent passes a victim's id. **Defense:** every row is tenant-scoped; cross-tenant ids return 404, not another tenant's data.
- **Hallucinated confirmations.** The agent tells the customer an action happened when it didn't. **Defense:** the `grounded_reply` policy rule checks reply claims against actual case actions and escalates unbacked ones.
- **Fake authority.** "I'm an admin / this is pre-approved." **Defense:** authority comes only from authenticated credentials and policy, never from message or argument text.
- **Idempotency abuse.** Reusing a key to swap in a bigger action. **Defense:** the stored request hash makes a reused key with a different body a 409 conflict; keys are namespaced per tenant.

## Injection and application security

- **SQL injection:** all queries are parameterized; identifiers are additionally constrained by the `external_id` domain regex. Malicious ids are rejected at the schema boundary.
- **Prototype pollution:** `__proto__`/`constructor` keys in JSON do not pollute the global prototype; tool lookups use `Object.hasOwn`.
- **Stored XSS:** the gateway stores reply text as data; the approval UI renders everything with `textContent` and ships a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), so stored payloads cannot execute.
- **Supply chain:** lockfile, `pnpm audit` in CI, no secrets in the repo, secret scan on every commit.

## Residual risks / out of scope (today)

- **No rate limiting or LLM budget caps yet** (Phase 5): a valid key can still issue many requests. Mitigated only by the kill switch.
- **No tracing/alerting in production yet** (Phase 6): detection relies on the `/status` endpoint and logs.
- **Grounding is heuristic:** it catches common false claims, not all semantic lies.
- **Operator auth is bearer-token:** no SSO/MFA yet; tokens are hashed and revocable.
- **Secrets at rest** depend on the deployment (Secret Manager in Phase 7).
