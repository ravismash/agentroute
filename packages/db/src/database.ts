import pg from "pg";

/** Anything that can run a parameterised query: the pool or a transaction client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

// int8 (bigint, COUNT, SUM) arrives as a string by default. Our money values are
// bounded far below 2^53, so convert to number — but refuse to lose precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${value} exceeds safe integer range`);
  return n;
});
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value));

export interface DatabaseOptions {
  connectionString: string;
  applicationName: string;
  maxConnections?: number;
  /** Server-side cap on any single statement. */
  statementTimeoutMs?: number;
}

export class Database implements Queryable {
  readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      application_name: options.applicationName,
      max: options.maxConnections ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 5_000,
      idle_in_transaction_session_timeout: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /** Run `fn` in a READ COMMITTED transaction; rolls back on any error. */
  async transaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError;
  return e.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
