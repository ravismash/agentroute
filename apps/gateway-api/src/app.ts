import { randomUUID } from "node:crypto";
import type { Logger } from "@agentroute/telemetry";
import Fastify from "fastify";
import { ApiError, sendProblem } from "./problem.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerV1Routes, type V1Services } from "./routes/v1.js";

export interface AppDeps {
  logger: Logger;
  /** Readiness probes for downstream dependencies (Postgres, Redis). */
  readinessChecks?: Record<string, () => Promise<void>>;
  /** API services; omitted in tests that only exercise the HTTP shell. */
  services?: V1Services;
}

const BODY_LIMIT_BYTES = 64 * 1024;

export function buildApp({ logger, readinessChecks = {}, services }: AppDeps) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
  });

  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, 404, "NOT_FOUND"));

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof ApiError)
      return sendProblem(request, reply, error.status, error.code, error.message);
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return sendProblem(request, reply, 500, "INTERNAL");
    }
    // Framework errors: malformed JSON, body too large, wrong content type.
    return sendProblem(request, reply, status, "VALIDATION_FAILED", error.message);
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

  if (services) {
    registerV1Routes(app, services);
    registerUiRoutes(app);
  }

  return app;
}
export type GatewayApp = ReturnType<typeof buildApp>;
