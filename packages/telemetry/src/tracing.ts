import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

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
