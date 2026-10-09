import {
  ApprovalDecisionRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  ProposalRequest,
} from "@agentroute/contracts";
import { decideApproval, getActionView, listPendingApprovals, type Database } from "@agentroute/db";
import type { Metrics } from "@agentroute/telemetry";
import { z } from "zod";
import { requireOperator, requireTenant } from "../auth.js";
import { ApiError, parseOrThrow } from "../problem.js";
import type { ExecutionService } from "@agentroute/execution";
import type { ProposalService } from "../services/proposals.js";
import type { App } from "../types.js";

/** What the routes need from a rate limiter; satisfied by @agentroute/limits RateLimiter. */
export interface RateLimiting {
  check(tenantId: string, keyId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface V1Services {
  db: Database;
  proposals: ProposalService;
  execution: ExecutionService;
  /** Optional; when present, proposals are rate limited per key and per tenant. */
  rateLimiter?: RateLimiting | undefined;
  /** Optional metrics registry; records rate-limit rejections here. */
  metrics?: Metrics | undefined;
}

const ActionIdParams = z.object({ id: z.uuid() });
const ApprovalQuery = z.strictObject({
  status: z.literal("pending").default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export function registerV1Routes(app: App, services: V1Services): void {
  const { db } = services;

  // ─── Agents (tenant API key) ───────────────────────────────────────────────

  app.post("/v1/proposals", async (request, reply) => {
    const tenant = await requireTenant(db, request);
    if (services.rateLimiter) {
      const limit = await services.rateLimiter.check(tenant.tenantId, tenant.keyId);
      if (!limit.allowed) {
        services.metrics?.rateLimited.inc({ scope: "proposal" });
        reply.header("retry-after", String(limit.retryAfterSeconds));
        throw new ApiError(429, "RATE_LIMITED", "rate limit exceeded; retry after the indicated delay");
      }
    }
    const rawKey = request.headers[IDEMPOTENCY_HEADER];
    if (typeof rawKey !== "string") {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", `the ${IDEMPOTENCY_HEADER} header is required`);
    }
    const idempotencyKey = parseOrThrow(IdempotencyKey, rawKey);
    const body = parseOrThrow(ProposalRequest, request.body);
    const result = await services.proposals.submit(tenant.tenantId, body, idempotencyKey, request.id);
    return reply.code(result.created ? 201 : 200).send(result.response);
  });

  app.get("/v1/actions/:id", async (request) => {
    const tenant = await requireTenant(db, request);
    const params = ActionIdParams.safeParse(request.params);
    // Malformed ids and other tenants' ids look the same as missing ones.
    const view = params.success ? await getActionView(db, tenant.tenantId, params.data.id) : undefined;
    if (!view) throw new ApiError(404, "NOT_FOUND", "action not found");
    return view;
  });

  // ─── Operators (operator token) ────────────────────────────────────────────

  app.get("/v1/approvals", async (request) => {
    const operator = await requireOperator(db, request);
    const query = parseOrThrow(ApprovalQuery, request.query);
    return listPendingApprovals(db, operator.tenantId, { limit: query.limit, cursor: query.cursor });
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/v1/approvals/:id/${decision}`, async (request) => {
      const operator = await requireOperator(db, request);
      const params = ActionIdParams.safeParse(request.params);
      if (!params.success) throw new ApiError(404, "NOT_FOUND", "approval not found");
      const body = parseOrThrow(ApprovalDecisionRequest, request.body ?? {});
      const actionId = params.data.id;

      const result = await db.transaction((tx) =>
        decideApproval(tx, {
          scope: operator.tenantId,
          actionId,
          operatorId: operator.operatorId,
          decision: decision === "approve" ? "approved" : "rejected",
          note: body.note,
          traceId: request.id,
        }),
      );
      if (result.outcome === "not_found") throw new ApiError(404, "NOT_FOUND", "approval not found");
      if (result.outcome === "conflict") {
        throw new ApiError(409, "ACTION_INVALID_STATE", `approval is already ${result.status}`);
      }
      if (decision === "approve") await services.execution.execute(result.tenantId, actionId, request.id);
      const view = await getActionView(db, result.tenantId, actionId);
      if (!view) throw new Error(`action ${actionId} vanished after decision`);
      return view;
    });
  }
}
