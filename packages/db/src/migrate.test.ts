import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "./ids.js";
import { loadMigrations, migrate, MIGRATIONS_DIR } from "./migrate.js";
import { createTestDatabase, type TestDatabase } from "./test-support/db.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function emptyDb(): Promise<TestDatabase> {
  const db = await createTestDatabase({ migrated: false });
  cleanups.push(db.drop);
  return db;
}

async function copyOfMigrations(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentroute-migrations-"));
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("migrate", () => {
  it("applies all migrations to an empty database, then is a no-op", async () => {
    const { client } = await emptyDb();
    const first = await migrate(client);
    expect(first.applied).toEqual(["0001", "0002", "0003"]);
    const second = await migrate(client);
    expect(second).toEqual({ applied: [], alreadyApplied: ["0001", "0002", "0003"] });
  });

  it("refuses to run when an applied migration was edited", async () => {
    const { client } = await emptyDb();
    const dir = await copyOfMigrations();
    await migrate(client, { dir });
    await writeFile(join(dir, "0001_init.sql"), "-- edited\n", { flag: "a" });
    await expect(migrate(client, { dir })).rejects.toThrow(/modified after being applied/);
  });

  it("refuses to run an older build against a newer schema", async () => {
    const { client } = await emptyDb();
    const dir = await copyOfMigrations();
    await writeFile(join(dir, "0099_extra.sql"), "CREATE TABLE extra_things (id int PRIMARY KEY);");
    await migrate(client, { dir });
    await expect(migrate(client)).rejects.toThrow(/missing from this build/);
  });

  it("rolls back a failing migration completely", async () => {
    const { client } = await emptyDb();
    const dir = await copyOfMigrations();
    await writeFile(join(dir, "0099_broken.sql"), "CREATE TABLE half_done (id int); SELECT 1/0;");
    await expect(migrate(client, { dir })).rejects.toThrow(/0099_broken failed/);
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.half_done') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);
    const versions = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(versions.rows.map((r) => r.version)).toEqual(["0001", "0002", "0003"]);
  });

  it("serialises concurrent migrators so each migration applies once", async () => {
    const db = await emptyDb();
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    cleanups.push(() => other.end());
    const results = await Promise.all([migrate(db.client), migrate(other)]);
    expect(results.map((r) => r.applied.length).sort()).toEqual([0, 3]);
  });

  it("rejects badly named migration files", async () => {
    const dir = await copyOfMigrations();
    await writeFile(join(dir, "2_Bad-Name.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toThrow(/invalid migration file name/);
  });
});

describe("uuidv7", () => {
  it("produces RFC 9562 version-7 UUIDs", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts by creation time", () => {
    const ids = [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });
});
