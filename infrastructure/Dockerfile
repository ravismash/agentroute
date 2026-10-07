# Production image for the AgentRoute monorepo.
# One image builds every workspace package; the platform picks which service to
# run via the start command (e.g. `node apps/gateway-api/dist/server.js`).
#
#   docker build -f infrastructure/Dockerfile -t agentroute .
#   docker run -e DATABASE_URL=... -e REDIS_URL=... -p 8080:8080 agentroute \
#     node apps/gateway-api/dist/server.js

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# Install dependencies first (cached unless manifests change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
COPY policies ./policies
RUN pnpm build

# Drop dev dependencies for a smaller runtime.
RUN pnpm prune --prod

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root for safety.
RUN useradd --system --uid 10001 --create-home appuser

COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/packages ./packages
COPY --from=builder --chown=appuser:appuser /app/apps ./apps
COPY --from=builder --chown=appuser:appuser /app/policies ./policies
COPY --from=builder --chown=appuser:appuser /app/package.json ./package.json

USER appuser
# Default: the gateway API. Override the command for the worker.
EXPOSE 8080
CMD ["node", "apps/gateway-api/dist/server.js"]
