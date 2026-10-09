import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface MetricsOptions {
  /** Collect Node process/GC metrics too. Default true; off in tests for stable output. */
  defaultMetrics?: boolean;
  prefix?: string;
}

/**
 * The AgentRoute metrics registry and instruments, exposed at `/metrics` in
 * Prometheus text format. One per process. The decision-duration buckets
 * straddle the p95 < 25 ms SLO (design doc §1.2) so the target is visible on a
 * dashboard without post-processing.
 */
export class Metrics {
  readonly registry = new Registry();

  /** Policy decisions, by effect (allow/deny/approval_required) and tool. */
  readonly decisions: Counter<"effect" | "tool">;
  /** Policy decision latency (the gateway overhead, excluding the LLM). */
  readonly decisionDuration: Histogram<"effect">;
  /** Requests rejected by the rate limiter, by scope (key/tenant). */
  readonly rateLimited: Counter<"scope">;
  /** Executions attempted, by outcome (succeeded/failed/…). */
  readonly executions: Counter<"outcome">;
  /** HTTP request latency, by method, route and status class. */
  readonly httpDuration: Histogram<"method" | "route" | "status">;

  constructor(options: MetricsOptions = {}) {
    const prefix = options.prefix ?? "agentroute_";
    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix });
    }
    this.decisions = new Counter({
      name: `${prefix}decisions_total`,
      help: "Policy decisions by effect and tool.",
      labelNames: ["effect", "tool"],
      registers: [this.registry],
    });
    this.decisionDuration = new Histogram({
      name: `${prefix}decision_duration_seconds`,
      help: "Gateway decision overhead (policy evaluation + persistence), excluding the LLM.",
      labelNames: ["effect"],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [this.registry],
    });
    this.rateLimited = new Counter({
      name: `${prefix}rate_limited_total`,
      help: "Requests rejected by the rate limiter.",
      labelNames: ["scope"],
      registers: [this.registry],
    });
    this.executions = new Counter({
      name: `${prefix}executions_total`,
      help: "Execution attempts by terminal outcome.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration.",
      labelNames: ["method", "route", "status"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
  }

  /** Prometheus text exposition for the `/metrics` endpoint. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
