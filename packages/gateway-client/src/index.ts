import { ActionView, ProblemDetails, ProposalResponse, type ProposalRequest } from "@agentroute/contracts";

/** What agents need from the gateway. Implemented over HTTP here and in-process for evals. */
export interface Gateway {
  propose(request: ProposalRequest, idempotencyKey: string): Promise<ProposalResponse>;
  getAction(actionId: string): Promise<ActionView>;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  /** Worth retrying with the same idempotency key. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface HttpGatewayOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Extra attempts for network errors / 5xx. Safe because proposals carry an idempotency key. */
  retries?: number;
  fetch?: typeof fetch;
}

export class HttpGateway implements Gateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async propose(request: ProposalRequest, idempotencyKey: string): Promise<ProposalResponse> {
    const body = await this.call("POST", "/v1/proposals", request, { "idempotency-key": idempotencyKey });
    return ProposalResponse.parse(body);
  }

  async getAction(actionId: string): Promise<ActionView> {
    const body = await this.call("GET", `/v1/actions/${encodeURIComponent(actionId)}`);
    return ActionView.parse(body);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    let lastError: GatewayError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(2000, 200 * 2 ** attempt) * (0.5 + Math.random() / 2));
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const json: unknown = await response.json().catch(() => undefined);
        if (response.ok) return json;
        const problem = ProblemDetails.safeParse(json);
        lastError = new GatewayError(
          response.status,
          problem.success ? problem.data : undefined,
          problem.success
            ? `${problem.data.code}: ${problem.data.detail ?? problem.data.title}`
            : `HTTP ${response.status}`,
        );
      } catch (err) {
        lastError = new GatewayError(0, undefined, `gateway unreachable: ${(err as Error).message}`);
      }
      if (!lastError.retryable) throw lastError;
    }
    throw lastError ?? new GatewayError(0, undefined, "gateway call failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
