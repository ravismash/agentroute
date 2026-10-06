import type { EventEnvelope } from "@agentroute/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventHandler } from "./consumer.js";
import { auditHandler } from "./handlers/audit.js";
import { incrementsFor, statsHandler } from "./handlers/stats.js";
import { pipelineStatus } from "./maintenance.js";
import { listDeadLetters, replayDeadLetters, replayOutbox } from "./recovery.js";
import { createHarness, type WorkerHarness } from "./test-support/harness.js";

let h: WorkerHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.close());

const auditRows = () => h.count("SELECT count(*) AS n FROM audit_log");
const unpublished = () => h.count("SELECT count(*) AS n FROM outbox WHERE published_at IS NULL");

describe("outbox relay", () => {
  it("publishes unpublished events in order and marks them published", async () => {
    await h.emit(5);
    const relay = h.relay({ batchSize: 2 });
    expect(await relay.drain()).toBe(5);
    expect(await unpublished()).toBe(0);
    expect(await h.redis.xLen(h.stream)).toBe(5);
    const entries = (await h.redis.xRange(h.stream, "-", "+")) ?? [];
    const seqs = entries.map((e) => (JSON.parse(e.message.envelope ?? "{}") as EventEnvelope).payload.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(await relay.drain()).toBe(0);
  });

  it("E-05: two relays running concurrently never double-publish", async () => {
    await h.emit(200);
    const [a, b] = [h.relay({ batchSize: 10 }), h.relay({ batchSize: 10 })];
    const [na, nb] = await Promise.all([a.drain(), b.drain()]);
    expect(na + nb).toBe(200);
    expect(await h.redis.xLen(h.stream)).toBe(200);
  });

  it("wakes on Postgres NOTIFY instead of waiting for the poll interval", async () => {
    const relay = h.relay({ pollMs: 60_000 });
    await relay.start(h.dbUrl);
    try {
      await new Promise((r) => setTimeout(r, 200)); // let the initial drain finish
      const started = Date.now();
      await h.emit(1);
      while ((await h.redis.xLen(h.stream)) === 0 && Date.now() - started < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await h.redis.xLen(h.stream)).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await relay.stop();
    }
  });
});

describe("consumers: effectively-once processing", () => {
  it("writes each event to the audit log with its trace id (E-06)", async () => {
    await h.emit(3);
    await h.relay().drain();
    const audit = await h.consumer(auditHandler);
    await h.drain(audit);
    expect(await auditRows()).toBe(3);
    const { rows } = await h.db.query<{ trace_id: string }>(
      "SELECT trace_id FROM audit_log ORDER BY occurred_at",
    );
    expect(rows.map((r) => r.trace_id).sort()).toEqual(["trace-0", "trace-1", "trace-2"]);
    const groups = await h.redis.xInfoGroups(h.stream);
    expect((groups[0] as { pending: number }).pending).toBe(0);
  });

  it("E-01: a relay crash after XADD (duplicate publish) still yields one audit row per event", async () => {
    await h.emit(4);
    const relay = h.relay();
    await relay.drain();
    // Simulate a crash between XADD and COMMIT: the rows look unpublished and go out again.
    await h.db.query("UPDATE outbox SET published_at = NULL");
    await relay.drain();
    expect(await h.redis.xLen(h.stream)).toBe(8);
    const audit = await h.consumer(auditHandler);
    await h.drain(audit);
    expect(await auditRows()).toBe(4);
    expect(await h.count("SELECT count(*) AS n FROM processed_events WHERE consumer = 'audit'")).toBe(4);
  });

  it("E-02: a consumer that crashes before XACK has its messages reclaimed and processed once", async () => {
    await h.emit(3);
    await h.relay().drain();
    const survivor = await h.consumer(auditHandler);
    // A consumer reads the messages and dies without acknowledging them.
    await h.redis.xReadGroup("audit", "crashed-consumer", { key: h.stream, id: ">" }, { COUNT: 10 });
    expect(await survivor.pollOnce(10)).toBe(0); // nothing new: all pending on the dead consumer
    expect(await survivor.reclaimOnce(0)).toBe(3);
    expect(await auditRows()).toBe(3);
    const [pending] = await h.redis.xPendingRange(h.stream, "audit", "-", "+", 10);
    expect(pending).toBeUndefined();
  });

  it("keeps stats correct under redelivery (counters are not double-counted)", async () => {
    await h.emit(2, { payload: { tool: "create_refund_request", effect: "allow" } });
    await h.emit(1, { payload: { tool: "create_refund_request", effect: "deny" } });
    const relay = h.relay();
    await relay.drain();
    await h.db.query("UPDATE outbox SET published_at = NULL");
    await relay.drain(); // every event delivered twice
    const stats = await h.consumer(statsHandler);
    await h.drain(stats);
    const { rows } = await h.db.query<{ metric: string; value: number }>(
      "SELECT metric, value FROM daily_action_stats ORDER BY metric",
    );
    expect(rows).toEqual([
      { metric: "decision_allow", value: 2 },
      { metric: "decision_deny", value: 1 },
    ]);
  });

  it("redacts PII from audit payloads", async () => {
    await h.emit(1, { payload: { tool: "draft_reply", note: "card 4242 4242 4242 4242" } });
    await h.relay().drain();
    await h.drain(await h.consumer(auditHandler));
    const { rows } = await h.db.query<{ payload: { note: string } }>("SELECT payload FROM audit_log");
    expect(rows[0]?.payload.note).toBe("card [REDACTED:card]");
  });
});

describe("failures, dead letters and replay", () => {
  const flaky = (failFor: Set<number>): EventHandler => ({
    name: "flaky",
    async handle(tx, event) {
      if (failFor.has(Number(event.payload.seq)))
        throw new Error(`cannot handle seq ${String(event.payload.seq)}`);
      await auditHandler.handle(tx, event);
    },
  });

  it("E-03: a poison message is dead-lettered after max deliveries without blocking the rest", async () => {
    await h.emit(3);
    await h.relay().drain();
    const broken = new Set([1]);
    const consumer = await h.consumer(flaky(broken), { maxDeliveries: 3 });
    await h.drain(consumer);

    expect(await auditRows()).toBe(2); // seq 0 and 2 processed
    const dead = await listDeadLetters(h.db);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ consumer: "flaky", attempts: 4, error: "cannot handle seq 1" });
    expect(await h.redis.xLen(h.dlq)).toBe(1);
    expect(await h.redis.xPendingRange(h.stream, "flaky", "-", "+", 10)).toEqual([]);

    // Fix the bug, replay the dead letter: processed exactly once.
    broken.clear();
    expect(await replayDeadLetters(h.db, h.redis, h.stream)).toBe(1);
    await h.drain(consumer);
    expect(await auditRows()).toBe(3);
    expect(await listDeadLetters(h.db)).toEqual([]);
    expect(await replayDeadLetters(h.db, h.redis, h.stream)).toBe(0);
  });

  it("dead-letters malformed messages immediately", async () => {
    const consumer = await h.consumer(auditHandler);
    await h.redis.xAdd(h.stream, "*", { envelope: "{not json" });
    await h.redis.xAdd(h.stream, "*", { something: "else" });
    await h.drain(consumer);
    const dead = await listDeadLetters(h.db);
    expect(dead).toHaveLength(2);
    expect(dead.every((d) => d.error.startsWith("malformed envelope") && d.event_id === null)).toBe(true);
  });

  it("E-04: after Redis loses the stream, replaying the outbox restores the audit trail", async () => {
    await h.emit(5);
    await h.relay().drain();
    const before = new Date(Date.now() - 60_000);
    // Redis loses everything before the consumer ran.
    await h.redis.del(h.stream);
    const consumer = await h.consumer(auditHandler); // recreates the stream and group
    await h.drain(consumer);
    expect(await auditRows()).toBe(0);

    expect(await replayOutbox(h.db, h.redis, h.stream, before)).toBe(5);
    await h.drain(consumer);
    expect(await auditRows()).toBe(5);
    // Replaying again is harmless.
    await replayOutbox(h.db, h.redis, h.stream, before);
    await h.drain(consumer);
    expect(await auditRows()).toBe(5);
  });
});

describe("pipeline status", () => {
  it("reports outbox backlog, stream length, consumer lag and dead letters", async () => {
    await h.emit(3);
    let status = await pipelineStatus(h.db, h.redis, h.stream);
    expect(status.outbox.unpublished).toBe(3);
    expect(status.outbox.oldest_unpublished_age_s).not.toBeNull();

    await h.relay().drain();
    await h.consumer(auditHandler);
    status = await pipelineStatus(h.db, h.redis, h.stream);
    expect(status).toMatchObject({
      outbox: { unpublished: 0, oldest_unpublished_age_s: null },
      stream: { length: 3 },
      groups: [{ name: "audit", pending: 0, lag: 3 }],
      dead_letters: { unreplayed: 0 },
    });
  });
});

describe("incrementsFor", () => {
  const event = (type: EventEnvelope["type"], payload: Record<string, unknown>): EventEnvelope => ({
    event_id: "01a10fe0-0000-7000-8000-000000000001",
    type,
    tenant_id: "acme",
    action_id: null,
    occurred_at: "2026-10-06T12:00:00.000Z",
    payload,
  });

  it("maps events to counters", () => {
    expect(
      incrementsFor(event("decision.made", { tool: "draft_reply", effect: "approval_required" })),
    ).toEqual([{ tool: "draft_reply", metric: "decision_approval_required", value: 1 }]);
    expect(
      incrementsFor(
        event("action.succeeded", { tool: "create_refund_request", amount_minor: 1500, currency: "USD" }),
      ),
    ).toEqual([
      { tool: "create_refund_request", metric: "executions_succeeded", value: 1 },
      { tool: "create_refund_request", metric: "amount_minor_usd", value: 1500 },
    ]);
  });

  it("ignores events without a valid tool", () => {
    expect(incrementsFor(event("action.expired", {}))).toEqual([]);
    expect(incrementsFor(event("decision.made", { tool: "DROP TABLE", effect: "allow" }))).toEqual([]);
  });
});
