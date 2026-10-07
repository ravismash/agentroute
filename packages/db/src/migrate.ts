import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Bundled migrations directory (`packages/db/migrations`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Arbitrary constant: serialises concurrent migrators (e.g. two pods starting at once). */
const MIGRATION_LOCK_ID = 7_431_902_116;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_DIRECTIVE = "-- agentroute:no-transaction";

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1] || !match[2])
      throw new Error(`invalid migration file name "${file}" (expected NNNN_name.sql)`);
    const [, version, name] = match;
    if (seen.has(version)) throw new Error(`duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(join(dir, file), "utf8");
    migrations.push({
      version,
      name,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
      transactional: !sql.trimStart().startsWith(NO_TRANSACTION_DIRECTIVE),
    });
  }
  return migrations;
}

/**
 * Apply pending migrations in order.
 *
 * - Forward-only; each migration runs in its own transaction unless it opts
 *   out (needed for e.g. CREATE INDEX CONCURRENTLY).
 * - A session advisory lock prevents concurrent runs.
 * - Applied migrations are checksummed: editing one after release fails fast.
 * - A migration recorded in the database but missing on disk fails fast
 *   (protects against running an older build against a newer schema).
 */
export async function migrate(client: pg.ClientBase, options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.dir);

  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version      text        NOT NULL,
        name         text        NOT NULL,
        checksum     text        NOT NULL,
        applied_at   timestamptz NOT NULL DEFAULT now(),
        execution_ms integer     NOT NULL,
        CONSTRAINT pk_schema_migrations PRIMARY KEY (version)
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const onDisk = new Set(migrations.map((m) => m.version));

    for (const version of applied.keys()) {
      if (!onDisk.has(version)) {
        throw new Error(`migration ${version} is applied in the database but missing from this build`);
      }
    }

    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const recorded = applied.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) {
          throw new Error(
            `migration ${m.version}_${m.name} was modified after being applied; add a new migration instead`,
          );
        }
        result.alreadyApplied.push(m.version);
        continue;
      }
      const started = performance.now();
      if (m.transactional) await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)",
          [m.version, m.name, m.checksum, Math.round(performance.now() - started)],
        );
        if (m.transactional) await client.query("COMMIT");
      } catch (err) {
        if (m.transactional) await client.query("ROLLBACK");
        throw new Error(`migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      log(`applied ${m.version}_${m.name}`);
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }
}

/** Open a short-lived connection, run pending migrations, and close it. */
export async function runMigrations(
  connectionString: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString, application_name: "agentroute-migrate" });
  await client.connect();
  try {
    return await migrate(client, options);
  } finally {
    await client.end();
  }
}
