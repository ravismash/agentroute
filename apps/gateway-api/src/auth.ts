import {
  authenticateApiKey,
  authenticateOperator,
  type Queryable,
  type OperatorPrincipal,
  type TenantPrincipal,
} from "@agentroute/db";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./problem.js";

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/** Tenant API key → principal, or 401. Operator tokens are not accepted here. */
export async function requireTenant(db: Queryable, request: FastifyRequest): Promise<TenantPrincipal> {
  const token = bearer(request);
  const principal = token ? await authenticateApiKey(db, token) : undefined;
  if (!principal) throw new ApiError(401, "AUTH_INVALID_KEY", "a valid tenant API key is required");
  return principal;
}

/** Operator token → principal, or 401. Tenant API keys are not accepted here. */
export async function requireOperator(db: Queryable, request: FastifyRequest): Promise<OperatorPrincipal> {
  const token = bearer(request);
  const principal = token ? await authenticateOperator(db, token) : undefined;
  if (!principal) throw new ApiError(401, "AUTH_INVALID_KEY", "a valid operator token is required");
  return principal;
}
