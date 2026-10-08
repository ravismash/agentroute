import type { ErrorCode, ProblemDetails } from "@agentroute/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

/** An error that maps to an RFC 7807 response. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  detail?: string,
): FastifyReply {
  const body: ProblemDetails = {
    type: "about:blank",
    title: TITLES[status] ?? "Error",
    status,
    code,
    instance: request.url,
    trace_id: request.id,
    ...(detail ? { detail } : {}),
  };
  if (status === 401) reply.header("www-authenticate", 'Bearer realm="agentroute"');
  return reply.code(status).type("application/problem+json").send(body);
}

/** Parse with Zod or throw a 400 listing every issue. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
      .join("; ");
    throw new ApiError(400, "VALIDATION_FAILED", detail);
  }
  return parsed.data;
}
