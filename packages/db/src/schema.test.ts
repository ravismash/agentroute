import { ACTION_STATES, ACTION_TRANSITIONS, DecisionEffect, EVENT_TYPES } from "@agentroute/contracts";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "./ids.js";
import { createTestDatabase, sqlState, SQLSTATE, type TestDatabase } from "./test-support/db.js";

let db: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = db.client;
});
afterAll(() => db.drop());

// Each test runs in a transaction that is rolled back, so tests stay independent.
beforeEach(async () => {
  await client.query("BEGIN");
  await seed();
});
afterEach(async () => {
  await client.query("ROLLBACK");
});

async function seed(): Promise<void> {
  await client.query(`
    INSERT INTO tenants (id, name) VALUES ('tenant_a', 'Acme'), ('tenant_b', 'Globex');
    INSERT INTO customers (tenant_id, id, display_name) VALUES
      ('tenant_a', 'cus_1', 'Ada'), ('tenant_a', 'cus_2', 'Grace'), ('tenant_b', 'cus_1', 'Linus');
    INSERT INTO subscriptions (tenant_id, id, customer_id, plan, currency) VALUES
      ('tenant_a', 'sub_1', 'cus_1', 'pro', 'USD'), ('tenant_a', 'sub_2', 'cus_2', 'starter', 'USD');
    INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES
      ('tenant_a', 'case_1', 'cus_1', 'sub_1', 'Double charged'),
      ('tenant_b', 'case_9', 'cus_1', NULL, 'Other tenant');
  `);
}

interface ActionOverrides {
  id?: string;
  tenant_id?: string;
  case_id?: string;
  customer_id?: string;
  state?: string;
  amount_minor?: number | null;
  currency?: string | null;
  args?: unknown;
  idempotency_key?: string;
}

function insertAction(o: ActionOverrides = {}): [string, unknown[]] {
  const values = [
    o.id ?? uuidv7(),
    o.tenant_id ?? "tenant_a",
    o.case_id ?? "case_1",
    o.customer_id ?? "cus_1",
    JSON.stringify(o.args ?? { customer_id: "cus_1", amount_minor: 1500 }),
    o.amount_minor === undefined ? 1500 : o.amount_minor,
    o.currency === undefined ? "USD" : o.currency,
    o.state ?? "allowed",
    o.idempotency_key ?? `idem-${uuidv7()}`,
    "a".repeat(64),
  ];
  return [
    `INSERT INTO actions (id, tenant_id, case_id, customer_id, agent_id, tool, args, amount_minor, currency,
       state, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, 'supportops', 'create_refund_request', $5, $6, $7, $8, $9, $10)`,
    values,
  ];
}

async function createAction(o: ActionOverrides = {}): Promise<string> {
  const id = o.id ?? uuidv7();
  const [text, values] = insertAction({ ...o, id });
  await client.query(text, values);
  return id;
}

const probe = (text: string, values: unknown[] = []) => sqlState(client, text, values);

// ─── Catalog checks: conventions enforced by test, not by memory ────────────

describe("schema conventions", () => {
  it("indexes every foreign key (leading columns of a non-partial index)", async () => {
    const { rows } = await client.query<{ fk: string }>(`
      SELECT c.conrelid::regclass || '.' || c.conname AS fk
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indpred IS NULL
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
        )`);
    expect(rows.map((r) => r.fk)).toEqual([]);
  });

  it("gives every table a primary key", async () => {
    const { rows } = await client.query<{ table_name: string }>(`
      SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          WHERE tc.table_schema = 'public' AND tc.table_name = t.table_name AND tc.constraint_type = 'PRIMARY KEY'
        )`);
    expect(rows).toEqual([]);
  });

  it("puts tenant_id on every business table", async () => {
    const global = [
      "tenants",
      "action_state_transitions",
      "processed_events",
      "dead_letters",
      "schema_migrations",
      "operator_tokens",
    ];
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND t.table_name <> ALL($1)
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'tenant_id'
         )`,
      [global],
    );
    expect(rows).toEqual([]);
  });

  it("names constraints with pk_/fk_/uq_/ck_ prefixes", async () => {
    const { rows } = await client.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 AND contype IN ('p', 'f', 'u', 'c')
        AND conname !~ '^(pk|fk|uq|ck)_'`);
    expect(rows).toEqual([]);
  });

  it("uses timestamptz and jsonb only (no naive timestamps or json)", async () => {
    const { rows } = await client.query<{ col: string }>(`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('timestamp without time zone', 'json')`);
    expect(rows).toEqual([]);
  });
});

// ─── Drift: database enumerations must match @agentroute/contracts ──────────

async function checkValues(constraint: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1",
    [constraint],
  );
  return [...(rows[0]?.def ?? "").matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] ?? "").sort();
}

describe("drift against contracts", () => {
  it("action states", async () => {
    expect(await checkValues("ck_actions_state")).toEqual([...ACTION_STATES].sort());
  });

  it("action state transitions", async () => {
    const { rows } = await client.query<{ from_state: string; to_state: string }>(
      "SELECT from_state, to_state FROM action_state_transitions",
    );
    const fromDb = rows.map((r) => `${r.from_state}->${r.to_state}`).sort();
    const fromContracts = Object.entries(ACTION_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
      .sort();
    expect(fromDb).toEqual(fromContracts);
  });

  it("event types", async () => {
    expect(await checkValues("ck_outbox_event_type")).toEqual([...EVENT_TYPES].sort());
  });

  it("decision effects", async () => {
    expect(await checkValues("ck_decisions_effect")).toEqual([...DecisionEffect.options].sort());
  });
});

// ─── Tenant isolation and referential integrity ─────────────────────────────

describe("referential integrity", () => {
  it("rejects an action that references another tenant's case", async () => {
    const [text, values] = insertAction({ tenant_id: "tenant_b", case_id: "case_1" });
    expect(await probe(text, values)).toBe(SQLSTATE.foreignKeyViolation);
  });

  it("rejects an action whose customer does not own the case", async () => {
    const [text, values] = insertAction({ customer_id: "cus_2" });
    expect(await probe(text, values)).toBe(SQLSTATE.foreignKeyViolation);
  });

  it("rejects a case whose subscription belongs to a different customer", async () => {
    expect(
      await probe(
        "INSERT INTO cases (tenant_id, id, customer_id, subscription_id, subject) VALUES ('tenant_a', 'case_x', 'cus_1', 'sub_2', 's')",
      ),
    ).toBe(SQLSTATE.foreignKeyViolation);
  });

  it("allows the same external id in different tenants", async () => {
    const { rows } = await client.query("SELECT 1 FROM customers WHERE id = 'cus_1'");
    expect(rows).toHaveLength(2);
  });
});

// ─── Value constraints ──────────────────────────────────────────────────────

describe("value constraints", () => {
  it.each([
    ["negative amount", { amount_minor: -1 }],
    ["zero amount", { amount_minor: 0 }],
    ["lowercase currency", { currency: "usd" }],
    ["amount without currency", { currency: null }],
    ["args that are not an object", { args: [1, 2] }],
    ["short idempotency key", { idempotency_key: "short" }],
  ])("rejects %s", async (_label, overrides) => {
    const [text, values] = insertAction(overrides);
    expect(await probe(text, values)).toBe(SQLSTATE.checkViolation);
  });

  it("rejects malformed external ids", async () => {
    expect(await probe("INSERT INTO tenants (id, name) VALUES ('bad id; --', 'x')")).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it("deduplicates idempotency keys per tenant only", async () => {
    await createAction({ idempotency_key: "same-key-123" });
    const [dup, dupValues] = insertAction({ idempotency_key: "same-key-123" });
    expect(await probe(dup, dupValues)).toBe(SQLSTATE.uniqueViolation);
    const [other, otherValues] = insertAction({
      tenant_id: "tenant_b",
      case_id: "case_9",
      idempotency_key: "same-key-123",
    });
    expect(await probe(other, otherValues)).toBe("ok");
  });
});

// ─── Action lifecycle enforced in the database ──────────────────────────────

describe("action lifecycle", () => {
  it("only allows creation in a decision state", async () => {
    const [text, values] = insertAction({ state: "executing" });
    expect(await probe(text, values)).toBe(SQLSTATE.checkViolation);
  });

  it("allows legal transitions and bumps the version", async () => {
    const id = await createAction({ state: "allowed" });
    await client.query("UPDATE actions SET state = 'executing' WHERE id = $1", [id]);
    const { rows } = await client.query<{ state: string; version: number }>(
      "SELECT state, version FROM actions WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ state: "executing", version: 2 });
  });

  it.each([
    ["denied", "executing"],
    ["approval_required", "executing"],
    ["allowed", "succeeded"],
  ])("rejects %s → %s", async (from, to) => {
    const id = await createAction({ state: from });
    expect(await probe("UPDATE actions SET state = $2 WHERE id = $1", [id, to])).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it("supports optimistic concurrency: a stale version updates nothing", async () => {
    const id = await createAction({ state: "approval_required" });
    const first = await client.query(
      "UPDATE actions SET state = 'approved' WHERE id = $1 AND state = 'approval_required' AND version = 1",
      [id],
    );
    const second = await client.query(
      "UPDATE actions SET state = 'rejected' WHERE id = $1 AND state = 'approval_required' AND version = 1",
      [id],
    );
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
  });

  it("forbids changing what was decided (amount, args, customer)", async () => {
    const id = await createAction({ state: "approval_required" });
    expect(await probe("UPDATE actions SET amount_minor = 999999 WHERE id = $1", [id])).toBe(
      SQLSTATE.restrictViolation,
    );
    expect(await probe(`UPDATE actions SET args = '{"customer_id":"cus_2"}' WHERE id = $1`, [id])).toBe(
      SQLSTATE.restrictViolation,
    );
  });

  it("forbids deleting actions", async () => {
    const id = await createAction();
    expect(await probe("DELETE FROM actions WHERE id = $1", [id])).toBe(SQLSTATE.restrictViolation);
  });
});

// ─── Execution guarantees ───────────────────────────────────────────────────

describe("executions", () => {
  const insertExecution = (actionId: string, attempt: number, status: string) =>
    probe(
      `INSERT INTO executions (tenant_id, action_id, attempt, status, provider, provider_idempotency_key,
         provider_ref, finished_at)
       VALUES ('tenant_a', $1::uuid, $2::smallint, $3::text, 'stripe', $1::text,
         CASE WHEN $3::text = 'succeeded' THEN 're_' || $2::text END,
         CASE WHEN $3::text = 'started' THEN NULL ELSE now() END)`,
      [actionId, attempt, status],
    );

  it("allows at most one successful execution per action", async () => {
    const id = await createAction();
    expect(await insertExecution(id, 1, "succeeded")).toBe("ok");
    expect(await insertExecution(id, 2, "succeeded")).toBe(SQLSTATE.uniqueViolation);
  });

  it("blocks a new attempt while an outcome is unknown", async () => {
    const id = await createAction();
    expect(await insertExecution(id, 1, "unknown")).toBe("ok");
    expect(await insertExecution(id, 2, "started")).toBe(SQLSTATE.uniqueViolation);
  });

  it("allows a retry after a definite failure", async () => {
    const id = await createAction();
    expect(await insertExecution(id, 1, "failed")).toBe("ok");
    expect(await insertExecution(id, 2, "started")).toBe("ok");
  });

  it("requires a provider reference for a success", async () => {
    const id = await createAction();
    expect(
      await probe(
        `INSERT INTO executions (tenant_id, action_id, attempt, status, provider, provider_idempotency_key, finished_at)
         VALUES ('tenant_a', $1, 1, 'succeeded', 'stripe', 'k', now())`,
        [id],
      ),
    ).toBe(SQLSTATE.checkViolation);
  });
});

// ─── Append-only and immutable data ─────────────────────────────────────────

describe("append-only data", () => {
  async function insertDecision(actionId: string, effect = "deny", withPolicy = false): Promise<string> {
    return probe(
      `INSERT INTO decisions (tenant_id, action_id, effect, reasons, policy_id, policy_key, policy_version, policy_checksum)
       VALUES ('tenant_a', $1, $2, '[{"code":"POLICY_DEFAULT_DENY"}]', NULL,
         CASE WHEN $3 THEN 'k' END, CASE WHEN $3 THEN '1.0.0' END, NULL)`,
      [actionId, effect, withPolicy],
    );
  }

  it("decisions cannot be changed or deleted", async () => {
    const id = await createAction({ state: "denied" });
    expect(await insertDecision(id)).toBe("ok");
    expect(await probe("UPDATE decisions SET effect = 'allow' WHERE action_id = $1", [id])).toBe(
      SQLSTATE.restrictViolation,
    );
    expect(await probe("DELETE FROM decisions WHERE action_id = $1", [id])).toBe(SQLSTATE.restrictViolation);
  });

  it("only a deny may be recorded without a policy", async () => {
    const id = await createAction({ state: "allowed" });
    expect(await insertDecision(id, "allow")).toBe(SQLSTATE.checkViolation);
  });

  it("audit_log cannot be updated, deleted or truncated", async () => {
    await client.query(
      `INSERT INTO audit_log (event_id, tenant_id, event_type, payload, occurred_at)
       VALUES ($1, 'tenant_a', 'decision.made', '{}', now())`,
      [uuidv7()],
    );
    expect(await probe("UPDATE audit_log SET payload = '{\"x\":1}'")).toBe(SQLSTATE.restrictViolation);
    expect(await probe("DELETE FROM audit_log")).toBe(SQLSTATE.restrictViolation);
    expect(await probe("TRUNCATE audit_log")).toBe(SQLSTATE.restrictViolation);
  });
});

// ─── Policies ───────────────────────────────────────────────────────────────

describe("policies", () => {
  const insertPolicy = (tenant: string | null, version: string, active: boolean) =>
    probe(
      `INSERT INTO policies (tenant_id, policy_key, version, source, checksum, is_active, activated_at)
       VALUES ($1, 'support-agent-baseline', $2, 'yaml', $3, $4, CASE WHEN $4 THEN now() END)`,
      [tenant, version, "b".repeat(64), active],
    );

  it("allows only one active version per tenant (including the global policy)", async () => {
    expect(await insertPolicy(null, "1.0.0", true)).toBe("ok");
    expect(await insertPolicy(null, "1.1.0", true)).toBe(SQLSTATE.uniqueViolation);
    expect(await insertPolicy("tenant_a", "1.0.0", true)).toBe("ok");
  });

  it("rejects a duplicate version for the global policy", async () => {
    expect(await insertPolicy(null, "1.0.0", false)).toBe("ok");
    expect(await insertPolicy(null, "1.0.0", false)).toBe(SQLSTATE.uniqueViolation);
  });

  it("keeps policy content immutable but allows activation changes", async () => {
    await insertPolicy("tenant_a", "1.0.0", false);
    expect(
      await probe("UPDATE policies SET is_active = true, activated_at = now() WHERE tenant_id = 'tenant_a'"),
    ).toBe("ok");
    expect(await probe("UPDATE policies SET source = 'changed' WHERE tenant_id = 'tenant_a'")).toBe(
      SQLSTATE.restrictViolation,
    );
  });
});

// ─── Approvals ──────────────────────────────────────────────────────────────

describe("approvals", () => {
  it("requires a decider for approved or rejected approvals", async () => {
    const id = await createAction({ state: "approval_required" });
    await client.query(
      "INSERT INTO approvals (tenant_id, action_id, expires_at) VALUES ('tenant_a', $1, now() + interval '1 hour')",
      [id],
    );
    expect(
      await probe("UPDATE approvals SET status = 'approved', decided_at = now() WHERE action_id = $1", [id]),
    ).toBe(SQLSTATE.checkViolation);
  });

  it("rejects an expiry before the request time", async () => {
    const id = await createAction({ state: "approval_required" });
    expect(
      await probe(
        "INSERT INTO approvals (tenant_id, action_id, expires_at) VALUES ('tenant_a', $1, now() - interval '1 minute')",
        [id],
      ),
    ).toBe(SQLSTATE.checkViolation);
  });
});

describe("timestamps", () => {
  it("maintains updated_at on update", async () => {
    await client.query("UPDATE cases SET updated_at = '2000-01-01' WHERE id = 'case_1'");
    const { rows } = await client.query<{ fresh: boolean }>(
      "SELECT updated_at > now() - interval '1 minute' AS fresh FROM cases WHERE id = 'case_1'",
    );
    expect(rows[0]?.fresh).toBe(true);
  });
});
