import { expireDueApprovals, type Database } from "@agentroute/db";
import type { Logger } from "@agentroute/telemetry";
import type { ExecutionService } from "./services/execution.js";

export interface BackgroundJobs {
  stop: () => Promise<void>;
}

/**
 * Periodic maintenance: expire overdue approvals and reconcile unknown
 * executions. Both are safe on multiple instances (SKIP LOCKED / conditional
 * updates). These move to the worker service in Phase 4.
 */
export function startBackgroundJobs(
  db: Database,
  execution: ExecutionService,
  log: Logger,
  intervalMs = 15_000,
): BackgroundJobs {
  let running: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    try {
      const expired = await db.transaction((tx) => expireDueApprovals(tx, 100));
      if (expired > 0) log.info({ expired }, "expired approvals");
      await execution.reconcile();
    } catch (err) {
      log.error({ err }, "background job failed");
    }
  };

  const timer = setInterval(() => {
    running ??= tick().finally(() => {
      running = undefined;
    });
  }, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
