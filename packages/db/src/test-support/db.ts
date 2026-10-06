import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { migrate } from "../migrate.js";

export interface TestDatabase {
  client: pg.Client;
  url: string;
  drop: () => Promise<void>;
}

/** Create an isolated, empty database inside the shared test container. */
export async function createTestDatabase({ migrated = true } = {}): Promise<TestDatabase> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  if (migrated) await migrate(client);

  return {
    client,
    url: url.toString(),
    drop: async () => {
      await client.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Run a statement and return the Postgres SQLSTATE it fails with (or "ok"). */
export async function sqlState(client: pg.ClientBase, text: string, values: unknown[] = []): Promise<string> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(text, values);
    await client.query("RELEASE SAVEPOINT probe");
    return "ok";
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code ?? "unknown";
  }
}

export const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  restrictViolation: "23001",
} as const;
