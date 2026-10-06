import { describe, expect, it, vi } from "vitest";
import { GatewayError, HttpGateway } from "./index.js";

const decision = {
  action_id: "01a10fe0-0000-7000-8000-000000000001",
  effect: "allow",
  state: "succeeded",
  reasons: [{ code: "POLICY_RULE_MATCHED", message: "ok" }],
  policy: { id: "p", version: "1.0.0" },
};

const request = {
  agent_id: "supportops",
  case_id: "case_1",
  tool: "get_customer",
  args: { customer_id: "cus_1" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpGateway", () => {
  it("sends the API key and idempotency key and parses the decision", async () => {
    const fetch = vi.fn(() => Promise.resolve(json(201, decision)));
    const gw = new HttpGateway({ baseUrl: "http://gw/", apiKey: "k", fetch });
    await expect(gw.propose(request, "run:call_1")).resolves.toEqual(decision);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw/v1/proposals");
    expect(init.headers).toMatchObject({ authorization: "Bearer k", "idempotency-key": "run:call_1" });
  });

  it("retries network errors and 5xx with the same idempotency key", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(json(503, { type: "about:blank", title: "x", status: 503, code: "INTERNAL" }))
      .mockResolvedValueOnce(json(200, decision));
    const gw = new HttpGateway({ baseUrl: "http://gw", apiKey: "k", fetch, retries: 2 });
    await expect(gw.propose(request, "same-key-1")).resolves.toEqual(decision);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].headers).toMatchObject({ "idempotency-key": "same-key-1" });
    }
  });

  it("does not retry client errors and surfaces the problem code", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        json(409, {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          detail: "reused",
        }),
      ),
    );
    const gw = new HttpGateway({ baseUrl: "http://gw", apiKey: "k", fetch });
    const error = await gw.propose(request, "k-12345678").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).problem?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects responses that do not match the contract", async () => {
    const fetch = vi.fn(() => Promise.resolve(json(201, { unexpected: true })));
    const gw = new HttpGateway({ baseUrl: "http://gw", apiKey: "k", fetch });
    await expect(gw.propose(request, "k-12345678")).rejects.toThrow();
  });
});
