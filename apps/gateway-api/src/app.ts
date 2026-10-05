import { randomUUID } from "node:crypto";
import type { ProblemDetails } from "@agentroute/contracts";
import type { Logger } from "@agentroute/telemetry";
import Fastify from "fastify";

export interface AppDeps {
  logger: Logger;
  /** Readiness probes for downstream dependencies (Postgres, Redis) — added in Phase 2. */
  readinessChecks?: Record<string, () => Promise<void>>;
}

const BODY_LIMIT_BYTES = 64 * 1024;

export function buildApp({ logger, readinessChecks = {} }: AppDeps) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ProblemDetails = {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      instance: request.url,
    };
    return reply.code(404).type("application/problem+json").send(body);
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    const body: ProblemDetails = {
      type: "about:blank",
      title: status >= 500 ? "Internal Server Error" : error.message,
      status,
      code: status >= 500 ? "INTERNAL" : "VALIDATION_FAILED",
      instance: request.url,
    };
    return reply.code(status).type("application/problem+json").send(body);
  });

  app.get("/healthz", () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const results: Record<string, "ok" | "fail"> = {};
    await Promise.all(
      Object.entries(readinessChecks).map(async ([name, check]) => {
        try {
          await check();
          results[name] = "ok";
        } catch {
          results[name] = "fail";
        }
      }),
    );
    const ready = Object.values(results).every((r) => r === "ok");
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks: results });
  });

  return app;
}
export type GatewayApp = ReturnType<typeof buildApp>;
