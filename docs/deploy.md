# Deploying AgentRoute

The production image is one multi-stage Docker build (`infrastructure/Dockerfile`) that builds the whole monorepo; the start command selects the service:

- gateway + approval UI: `node apps/gateway-api/dist/server.js` (port 8080)
- worker (relay, consumers, jobs): `node apps/worker/dist/main.js` (port 8082)

It needs `DATABASE_URL` (Postgres) and `REDIS_URL`, plus an optional `STRIPE_SECRET_KEY` (test mode; omit to use the in-memory fake).

## Demo deploy — Render (recommended, no CLI)

1. Dashboard → **New → Blueprint** → connect `github.com/ravismash/agentroute` → **Apply**. Render reads [`render.yaml`](../render.yaml) and provisions the gateway (web), the worker, managed Postgres and Redis.
2. Paste a Stripe **test** key for `STRIPE_SECRET_KEY` when prompted (or leave blank for the fake refund gateway).
3. Migrations run automatically before the gateway deploys (`preDeployCommand`).
4. In the gateway service's **Shell**, seed demo data and credentials:
   ```
   node apps/gateway-api/dist/scripts/seed.js
   ```
   Open `https://<your-gateway>.onrender.com/ui/` and log in with the printed operator token.

Free tier notes: services sleep when idle (first request wakes them, ~30 s); free Postgres is dropped after 90 days. Fine for a demo; not for production.

## Local production image

```bash
docker build -f infrastructure/Dockerfile -t agentroute .
docker run -e DATABASE_URL=... -e REDIS_URL=... -p 8080:8080 agentroute        # gateway
docker run -e DATABASE_URL=... -e REDIS_URL=... agentroute node apps/worker/dist/main.js  # worker
```

## Production target (per ADR-0004)

The system is designed for **Google Cloud Run** (gateway scales to zero; worker with min-instances=1 and CPU always allocated) backed by Cloud SQL and Memorystore, with secrets in Secret Manager — plus a Helm chart (`infrastructure/helm/`, planned) so a customer can run it in their own VPC. Render is used for the public demo for cost and simplicity.
