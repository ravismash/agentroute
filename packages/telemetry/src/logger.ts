import { pino, type Logger, type LoggerOptions } from "pino";
import { redactDeep } from "./redact.js";

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Override the destination (tests). */
  destination?: pino.DestinationStream;
}

/** Fields that must never be logged, regardless of content. */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "*.password",
  "*.api_key",
  "*.secret",
  "*.token",
];

/**
 * Structured JSON logger. Key paths are censored, and every logged object
 * is passed through PII redaction so free text (customer messages, LLM
 * output) cannot leak card numbers or secrets into log storage.
 */
export function createLogger({ service, level = "info", destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redactDeep(object),
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === "string" ? redactDeep(a) : a));
        method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
