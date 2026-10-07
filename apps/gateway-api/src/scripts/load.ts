/**
 * Load test against a running gateway (+ worker for the pipeline check).
 *
 *   pnpm load -- --requests 3000 --concurrency 50
 *
 * Mix (no Stripe calls, so provider rate limits don't skew results):
 *   60% get_customer (allowed, executed)      → 4 events each
 *   25% refund to another customer (denied)    → 2 events each
 *   15% grounded draft_reply (allowed)         → 4 events each
 * Each virtual user works on its own case so per-customer locks don't
 * serialize the whole test. Afterwards, checks the audit log catches up.
 */
import { randomUUID } from "node:crypto";
import { Database, issueApiKey } from "@agentroute/db";
import { loadConfig } from "../config.js";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const TOTAL = arg("requests", 2000);
const CONCURRENCY = arg("concurrency", 50);

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new Database({
  connectionString: config.DATABASE_URL,
  applicationName: "agentroute-load",
  maxConnections: 4,
});

const T = `load_${Date.now().toString(36)}`;
await db.query("INSERT INTO tenants (id, name) VALUES ($1, 'Load test')", [T]);
await db.query(
  `INSERT INTO customers (tenant_id, id, display_name)
   SELECT $1, 'cus_' || g, 'Customer ' || g FROM generate_series(0, $2 - 1) g`,
  [T, CONCURRENCY + 1],
);
await db.query(
  `INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency)
   SELECT $1, 'sub_' || g, 'cus_' || g, 'pro', 'USD' FROM generate_series(0, $2 - 1) g`,
  [T, CONCURRENCY + 1],
);
await db.query(
  `INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject)
   SELECT $1, 'case_' || g, 'cus_' || g, 'sub_' || g, 'Load' FROM generate_series(0, $2 - 1) g`,
  [T, CONCURRENCY + 1],
);
const key = await issueApiKey(db, T, "load");

type Kind = "read" | "deny" | "reply";
function pick(i: number): Kind {
  const r = i % 20;
  return r < 12 ? "read" : r < 17 ? "deny" : "reply";
}
const EVENTS: Record<Kind, number> = { read: 4, deny: 2, reply: 4 };

function body(kind: Kind, user: number) {
  const c = `case_${user}`;
  const customer = `cus_${user}`;
  switch (kind) {
    case "read":
      return { agent_id: "supportops", case_id: c, tool: "get_customer", args: { customer_id: customer } };
    case "deny":
      return {
        agent_id: "supportops",
        case_id: c,
        tool: "create_refund_request",
        args: {
          customer_id: `cus_${CONCURRENCY}`,
          amount_minor: 500,
          currency: "USD",
          reason_code: "goodwill",
        },
      };
    case "reply":
      return {
        agent_id: "supportops",
        case_id: c,
        tool: "draft_reply",
        args: { case_id: c, body: "Thanks, we're looking into it." },
      };
  }
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
const wrongEffect: string[] = [];
let expectedEvents = 0;
let next = 0;

async function user(id: number): Promise<void> {
  for (;;) {
    const i = next++;
    if (i >= TOTAL) return;
    const kind = pick(i);
    const started = performance.now();
    try {
      const res = await fetch(`${GATEWAY}/v1/proposals`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "idempotency-key": `load-${randomUUID()}`,
        },
        body: JSON.stringify(body(kind, id)),
      });
      const json = (await res.json()) as { effect?: string };
      latencies.push(performance.now() - started);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status === 201) {
        expectedEvents += EVENTS[kind];
        const want = kind === "deny" ? "deny" : "allow";
        if (json.effect !== want) wrongEffect.push(`${kind} → ${String(json.effect)}`);
      }
    } catch {
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
    }
  }
}

console.log(`Load: ${TOTAL} requests, concurrency ${CONCURRENCY}, tenant ${T}`);
const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, u) => user(u)));
const seconds = (performance.now() - started) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)] ?? 0;
const errors = [...statuses.entries()].filter(([s]) => s !== 201).reduce((n, [, c]) => n + c, 0);
console.log(`throughput  ${(TOTAL / seconds).toFixed(0)} req/s over ${seconds.toFixed(1)} s`);
console.log(
  `latency     p50 ${p(50).toFixed(0)} ms · p95 ${p(95).toFixed(0)} ms · p99 ${p(99).toFixed(0)} ms · max ${p(100).toFixed(0)} ms`,
);
console.log(
  `statuses    ${[...statuses.entries()].map(([s, c]) => `${s}×${c}`).join(" ")} · error rate ${((errors / TOTAL) * 100).toFixed(2)}%`,
);
console.log(
  `decisions   ${wrongEffect.length === 0 ? "all as expected" : `${wrongEffect.length} unexpected: ${wrongEffect.slice(0, 3).join(", ")}`}`,
);

// Pipeline: every event must reach the audit log.
const count = async (sql: string) => (await db.query<{ n: number }>(sql, [T])).rows[0]?.n ?? 0;
const outbox = await count("SELECT count(*) AS n FROM outbox WHERE tenant_id = $1");
const pipelineStart = performance.now();
let audit = 0;
for (let i = 0; i < 240; i++) {
  audit = await count("SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1");
  if (audit >= outbox) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log(
  `pipeline    outbox ${outbox} (expected ${expectedEvents}) → audit ${audit} · caught up ${((performance.now() - pipelineStart) / 1000).toFixed(1)} s after load ended`,
);
await db.close();
process.exitCode =
  errors === 0 && wrongEffect.length === 0 && outbox === expectedEvents && audit === outbox ? 0 : 1;
