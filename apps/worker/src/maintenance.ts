import { expireDueApprovals, type Database } from "@agentroute/db";
import type { ExecutionService } from "@agentroute/execution";
import type { Logger } from "@agentroute/telemetry";
import type { RedisClient } from "./relay.js";

/**
 * Periodic maintenance, moved out of the request-serving gateway:
 * expire overdue approvals and reconcile unknown/stuck executions. Both are
 * safe on several worker instances (SKIP LOCKED / conditional updates).
 */
export class Maintenance {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    private readonly execution: ExecutionService,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<{ expired: number; reconciled: number }> {
    const expired = await this.db.transaction((tx) => expireDueApprovals(tx, 100));
    const reconciled = await this.execution.reconcile();
    if (expired || reconciled) this.log.info({ expired, reconciled }, "maintenance");
    return { expired, reconciled };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.running ??= this.tick()
        .then(() => undefined)
        .catch((err: unknown) => {
          this.log.error({ err }, "maintenance failed");
        })
        .finally(() => {
          this.running = undefined;
        });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}

export interface PipelineStatus {
  outbox: { unpublished: number; oldest_unpublished_age_s: number | null };
  stream: { key: string; length: number };
  groups: { name: string; pending: number; lag: number | null; consumers: number }[];
  dead_letters: { unreplayed: number };
}

/** Health signals for the event pipeline: what an on-call engineer looks at first. */
export async function pipelineStatus(
  db: Database,
  redis: RedisClient,
  stream: string,
): Promise<PipelineStatus> {
  const outbox = await db.query<{ unpublished: number; oldest: number | null }>(
    `SELECT count(*) AS unpublished,
            extract(epoch FROM now() - min(occurred_at))::int AS oldest
       FROM outbox WHERE published_at IS NULL`,
  );
  const dead = await db.query<{ n: number }>(
    "SELECT count(*) AS n FROM dead_letters WHERE replayed_at IS NULL",
  );
  const length = await redis.xLen(stream);
  let groups: PipelineStatus["groups"] = [];
  try {
    const info = await redis.xInfoGroups(stream);
    groups = (
      info as unknown as { name: string; pending: number; lag: number | null; consumers: number }[]
    ).map((g) => ({
      name: g.name,
      pending: g.pending,
      lag: g.lag,
      consumers: g.consumers,
    }));
  } catch {
    // Stream doesn't exist yet.
  }
  return {
    outbox: {
      unpublished: outbox.rows[0]?.unpublished ?? 0,
      oldest_unpublished_age_s: outbox.rows[0]?.oldest ?? null,
    },
    stream: { key: stream, length },
    groups,
    dead_letters: { unreplayed: dead.rows[0]?.n ?? 0 },
  };
}
