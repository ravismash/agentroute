# Operations runbook

Practical procedures for running AgentRoute: deploy, roll back, restore, rotate secrets, and respond to the failure modes the design anticipates. Targets the reference deployment (Render: gateway web service + worker + Postgres + Redis). Adapt hostnames/commands for other platforms.

Recovery objective: **RTO < 30 min** (redeploy + restore). RPO = 0 for decisions (committed synchronously); the audit/stats stream is eventually consistent (lag p95 < 5 s).

---

## Service map

| Component         | Role                                                                 | If it's down                                                                       |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| gateway-api (web) | Decision API + approval dashboard `/ui/`                             | No proposals accepted; `/readyz` fails                                             |
| worker            | Outbox relay, audit/stats consumers, approval expiry, reconciliation | Audit/stats lag grows; approvals don't auto-expire; outbox backs up (no data lost) |
| Postgres          | Source of truth (actions, decisions, outbox, audit)                  | Gateway rejects writes (fail-closed); `/readyz` fails                              |
| Redis             | Stream transport, rate/budget keys                                   | Relay pauses, outbox accumulates; rebuild stream from outbox on recovery           |

Health: `GET /healthz` (liveness), `GET /readyz` (checks Postgres). Worker status: `GET :8082/status` (backlog, lag, pending, dead letters).

---

## Deploy

Pushing to `main` triggers Render to build the image and deploy. Migrations run **at startup** (`MIGRATE_ON_START=true`, advisory-locked and idempotent — safe with multiple instances). No separate migration step is needed on the free tier.

**Verify a deploy:**

```bash
BASE=https://agentroute-gateway.onrender.com
curl -s $BASE/healthz      # {"status":"ok"}
curl -s $BASE/readyz       # {"status":"ready","checks":{"postgres":"ok"}}
```

Migrations follow **expand → migrate → contract**: each release's schema is backward compatible with the previous running version, so a rolling deploy never has old and new code fighting over the schema.

## Roll back

1. In Render, open the service → **Deploys** → pick the last known-good deploy → **Redeploy**. (Or revert the offending commit on `main` and let auto-deploy run.)
2. Because migrations are expand/contract, the previous image runs against the current schema without a down-migration. **Do not** write destructive down-migrations for a rollback; add a corrective forward migration instead.
3. Confirm with `/readyz` and a smoke proposal (see below).

## Restore from backup (disaster recovery)

Postgres backups are managed by the platform (Render/managed PG provides daily backups + PITR).

1. Provision a restored database instance from the most recent backup (or a PITR timestamp).
2. Point `DATABASE_URL` at the restored instance; redeploy gateway + worker.
3. **Rebuild the event stream** if Redis also lost data:
   ```bash
   pnpm --filter @agentroute/worker replay outbox --since <ISO-timestamp>
   ```
   The Postgres outbox is the source of truth, so the audit log and stats are reconstructable even after total Redis loss.
4. **Reconcile in-flight money actions** — any action left in `executing` at the crash is resolved by the reconciler (query the provider by `metadata.action_id`); confirm none remain stuck:
   ```sql
   SELECT id, state, updated_at FROM actions WHERE state = 'executing' ORDER BY updated_at;
   ```
5. **Drill check (D-06):** after restore, audit row count should match decision count for the restored window.

## Rotate secrets

1. Create the new secret at the provider (Stripe test key, OpenRouter/OpenAI key).
2. Update it in Render → service → **Environment** for **both** gateway and worker, and in local `.env`.
3. Save → Render redeploys. Verify `/readyz`.
4. Revoke the old secret at the provider.
5. Secrets never appear in code or logs (pino redaction); if one leaks in chat or a log, treat it as compromised and rotate immediately.

> After seeding a demo, set `SEED_ON_START=false` so the gateway doesn't reseed/relog credentials on every boot.

---

## Incident playbooks

### Postgres down / `/readyz` failing

Expected behavior: gateway rejects proposals with 503 (fail-closed) — **no action executes without a stored decision**. Fix: restore DB connectivity or failover; redeploy. No replay needed for decisions (synchronous). Backlogged audit events drain from the outbox once the worker reconnects.

### Redis down

Relay pauses; the outbox accumulates unpublished rows (nothing lost). Budget-gated LLM calls are blocked (fail-closed on cost). On recovery the relay resumes; if Redis lost data, run the `replay outbox` command above. Check `:8082/status` for backlog draining.

### Worker crashed / audit lag climbing

Pending stream messages are reclaimed via `XCLAIM` on restart; consumers are idempotent so redelivery is harmless. Redeploy the worker. Verify lag recovers at `:8082/status`. Proven: `kill -9` under load lost zero events.

### Dead letters > 0

```bash
pnpm --filter @agentroute/worker replay dlq list     # inspect poison messages
# fix the root cause, then:
pnpm --filter @agentroute/worker replay dlq retry     # re-publish
```

### Stripe timeout / indeterminate refund

Do **not** blindly retry. The reconciler queries the provider for a refund tagged with the action's `action_id`; if found → `succeeded`, else it's safe to retry as a new attempt. A unique-success DB constraint prevents a double success. Check the action's executions:

```sql
SELECT * FROM executions WHERE action_id = '<id>' ORDER BY attempt;
```

### Suspected bad policy deployed

Deny-rate spike or wrong decisions. Policies are versioned; activate the previous version (one active policy per tenant, enforced by a partial unique index). Validate before reactivating:

```bash
# dry-run the candidate against stored proposals before activating
```

See [policy-reference.md](policy-reference.md).

### Runaway agent / abuse

Interim: the gateway contains wrong _actions_ (policy/approvals) and wrong _claims_ (grounding). Hard stop via kill switch and per-tenant budget ceiling are **Phase 5** — until then, revoke the tenant's API key to halt proposals:

```sql
UPDATE api_keys SET revoked_at = now() WHERE tenant_id = '<tenant>' AND revoked_at IS NULL;
```

---

## Smoke test (post-deploy / post-restore)

```bash
BASE=https://agentroute-gateway.onrender.com
API_KEY=<tenant api key>
# allowed $15 refund → expect effect:"allow"
curl -s -X POST $BASE/v1/proposals \
  -H "authorization: Bearer $API_KEY" -H "idempotency-key: $(uuidgen)" -H "content-type: application/json" \
  -d '{"agent_id":"supportops","case_id":"case_1001","tool":"create_refund_request",
       "args":{"customer_id":"cus_ada","amount_minor":1500,"currency":"USD","reason_code":"duplicate_charge"}}' | jq .effect
# wrong-customer → expect effect:"deny", code POLICY_CONTEXT_MISMATCH
```
