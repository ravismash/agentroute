import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@agentroute/telemetry";
import type { FastifyInstance, RawServerDefault } from "fastify";

/** The gateway's Fastify instance type (uses our pino logger). */
export type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;
