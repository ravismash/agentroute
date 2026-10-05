import { createLogger } from "@agentroute/telemetry";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const logger = createLogger({ service: "test", level: "silent" });

describe("gateway app", () => {
  it("reports liveness", async () => {
    const app = buildApp({ logger });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("propagates a caller-supplied request id", async () => {
    const app = buildApp({ logger });
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "req-abc" } });
    expect(res.headers["x-request-id"]).toBe("req-abc");
  });

  it("returns 503 when a readiness check fails", async () => {
    const app = buildApp({
      logger,
      readinessChecks: {
        postgres: () => Promise.resolve(),
        redis: () => Promise.reject(new Error("down")),
      },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready", checks: { postgres: "ok", redis: "fail" } });
  });

  it("returns RFC 7807 problem details for unknown routes", async () => {
    const app = buildApp({ logger });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("rejects oversized bodies", async () => {
    const app = buildApp({ logger });
    app.post("/echo", () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(70 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toMatchObject({ PORT: 8080, LOG_LEVEL: "info", NODE_ENV: "development" });
  });

  it("fails fast on invalid values", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/Invalid configuration/);
  });
});
