import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const TRACER_NAME = "agentroute";

/** The AgentRoute tracer. No-ops unless tracing was started with an OTLP endpoint. */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a span named `name`, recording exceptions and setting an error
 * status on throw. A trace per proposal spans gateway → policy → DB → executor
 * (design doc §1.14) by nesting these.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface TracingHandle {
  shutdown: () => Promise<void>;
}

/**
 * Start OpenTelemetry tracing when an OTLP endpoint is configured.
 * Returns a no-op handle otherwise so local dev and tests need no collector.
 */
export function startTracing(serviceName: string, otlpEndpoint?: string): TracingHandle {
  if (!otlpEndpoint) return { shutdown: () => Promise.resolve() };

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces` }),
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
