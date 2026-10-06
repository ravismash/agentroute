import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Id } from "@agentroute/contracts";
import type { Logger } from "@agentroute/telemetry";
import Fastify, { type FastifyInstance, type FastifyRequest, type RawServerDefault } from "fastify";
import { z } from "zod";
import type { RunEvent } from "./events.js";
import { runSupportCase, type RunnerOptions } from "./runner.js";

export const RunRequest = z.strictObject({
  case_id: Id,
  customer_id: Id,
  message: z.string().trim().min(1).max(4000),
});

export interface AgentAppDeps {
  logger: Logger;
  /** Bearer token callers must present. */
  serviceToken: string;
  /** Undefined when no LLM is configured: runs return 503. */
  runner: RunnerOptions | undefined;
  heartbeatMs?: number;
}

type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

function problem(status: number, code: string, detail: string) {
  return { type: "about:blank", title: detail, status, code, detail };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function buildAgentApp({ logger, serviceToken, runner, heartbeatMs = 15_000 }: AgentAppDeps): App {
  const app: App = Fastify({
    loggerInstance: logger,
    bodyLimit: 16 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });
  const expected = digest(serviceToken);

  const authorized = (request: FastifyRequest): boolean => {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
    // Compare fixed-length digests so timing reveals nothing about the token.
    return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected);
  };

  app.get("/healthz", () => ({ status: "ok", llm: runner ? "configured" : "not_configured" }));

  app.post("/v1/runs", async (request, reply) => {
    if (!authorized(request)) {
      return reply
        .code(401)
        .type("application/problem+json")
        .send(problem(401, "AUTH_INVALID_KEY", "invalid token"));
    }
    const parsed = RunRequest.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply
        .code(400)
        .type("application/problem+json")
        .send(problem(400, "VALIDATION_FAILED", detail));
    }
    if (!runner) {
      return reply
        .code(503)
        .type("application/problem+json")
        .send(problem(503, "LLM_NOT_CONFIGURED", "no LLM provider is configured (set OPENROUTER_API_KEY)"));
    }
    const input = {
      caseId: parsed.data.case_id,
      customerId: parsed.data.customer_id,
      message: parsed.data.message,
    };

    // JSON mode: run to completion and return the summary.
    if (!(request.headers.accept ?? "").includes("text/event-stream")) {
      const summary = await runSupportCase(input, runner, () => undefined);
      return reply.send(summary);
    }

    // SSE mode: stream events as they happen.
    const abort = new AbortController();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": request.id,
    });
    let open = true;
    const send = (event: RunEvent) => {
      if (open) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (open) res.write(": keep-alive\n\n");
    }, heartbeatMs);
    request.raw.on("close", () => {
      if (!res.writableEnded) {
        open = false;
        abort.abort();
      }
    });
    try {
      await runSupportCase(input, runner, send, abort.signal);
    } catch (err) {
      request.log.error({ err }, "run failed");
    } finally {
      clearInterval(heartbeat);
      open = false;
      res.end();
    }
  });

  return app;
}
