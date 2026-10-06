import type { ActionState } from "@agentroute/contracts";
import {
  beginExecution,
  finishExecution,
  findUnresolvedExecutions,
  isExecutable,
  lockAction,
  type Database,
  type ExecutableAction,
  type ExecutionOutcome,
} from "@agentroute/db";
import type { Logger } from "@agentroute/telemetry";
import type { Prepared, ToolExecutor } from "../executors.js";

export interface ExecutionReport {
  state: ActionState;
  result?: unknown;
}

export interface ExecutionServiceOptions {
  /** Upper bound on a provider call before we treat the outcome as unknown. */
  performTimeoutMs?: number;
}

/**
 * Runs approved actions with an *effectively-once* guarantee:
 *
 *  1. BEGIN tx: lock the action row, check it is executable, reserve
 *     resources, insert an execution attempt, action → executing. COMMIT.
 *     (DB constraints allow only one open attempt and one success per action.)
 *  2. Call the provider outside any transaction, with an idempotency key.
 *  3. BEGIN tx: record succeeded / failed (release reservations) / unknown. COMMIT.
 *
 * Unknown outcomes are never retried blindly; `reconcile()` asks the provider
 * what actually happened.
 */
export class ExecutionService {
  private readonly performTimeoutMs: number;

  constructor(
    private readonly db: Database,
    private readonly executors: ReadonlyMap<string, ToolExecutor>,
    private readonly log: Logger,
    options: ExecutionServiceOptions = {},
  ) {
    this.performTimeoutMs = options.performTimeoutMs ?? 30_000;
  }

  async execute(tenantId: string, actionId: string, traceId?: string): Promise<ExecutionReport> {
    const begun = await this.db.transaction(async (tx) => {
      const action = await lockAction(tx, tenantId, actionId);
      if (!action) throw new Error(`action ${actionId} not found`);
      if (!isExecutable(action.state)) return { kind: "skipped" as const, state: action.state };

      const executor = this.executors.get(action.tool);
      const prepared: Prepared = executor
        ? await executor.prepare(tx, action)
        : {
            provider: "mock_crm",
            target: null,
            failure: { code: "NO_EXECUTOR", message: "tool has no executor" },
          };
      const attempt = await beginExecution(tx, {
        action,
        provider: prepared.provider,
        providerTarget: prepared.target,
        traceId,
      });
      if (prepared.failure || !executor) {
        await finishExecution(tx, {
          tenantId,
          actionId,
          executionId: attempt.executionId,
          from: "started",
          outcome: {
            status: "failed",
            ...(prepared.failure ?? { code: "NO_EXECUTOR", message: "no executor" }),
          },
          traceId,
        });
        return { kind: "skipped" as const, state: "failed" as ActionState };
      }
      return { kind: "begun" as const, action, executor, prepared, ...attempt };
    });
    if (begun.kind === "skipped") return { state: begun.state };

    const { action, executor, prepared, executionId, idempotencyKey } = begun;
    let outcome: ExecutionOutcome;
    let result: unknown;
    try {
      const performed = await withTimeout(
        executor.perform(action, prepared, idempotencyKey),
        this.performTimeoutMs,
      );
      outcome = performed.outcome;
      result = performed.result;
    } catch (err) {
      // We cannot know whether the side effect happened: never assume it didn't.
      outcome = { status: "unknown", message: err instanceof Error ? err.message : String(err) };
    }

    await this.db.transaction(async (tx) => {
      await finishExecution(tx, { tenantId, actionId, executionId, from: "started", outcome, traceId });
      await executor.complete(
        tx,
        { tenantId, actionId, amountMinor: action.amountMinor, target: prepared.target },
        outcome,
      );
    });

    if (outcome.status === "unknown") {
      this.log.warn(
        { action_id: actionId, execution_id: executionId },
        "execution outcome unknown; will reconcile",
      );
    }
    return {
      state: outcome.status === "unknown" ? "executing" : outcome.status,
      ...(result === undefined ? {} : { result }),
    };
  }

  /** Resolve unknown or stuck attempts by asking the provider. Returns how many were resolved. */
  async reconcile(
    options = { unknownOlderThanSeconds: 30, startedOlderThanSeconds: 300, limit: 50 },
  ): Promise<number> {
    const pending = await findUnresolvedExecutions(this.db, options);
    let resolved = 0;
    for (const item of pending) {
      const action = await this.loadAction(item.tenantId, item.actionId);
      const executor = action && this.executors.get(action.tool);
      if (!action || !executor) continue;
      const ctx = {
        tenantId: item.tenantId,
        actionId: item.actionId,
        amountMinor: item.amountMinor,
        target: item.providerTarget,
      };
      const outcome = await executor.reconcile(action, ctx);
      if (outcome.status === "unknown") continue;
      try {
        await this.db.transaction(async (tx) => {
          await finishExecution(tx, {
            tenantId: item.tenantId,
            actionId: item.actionId,
            executionId: item.executionId,
            from: item.status,
            outcome,
          });
          await executor.complete(tx, ctx, outcome);
        });
        resolved++;
        this.log.info({ action_id: item.actionId, status: outcome.status }, "reconciled execution");
      } catch (err) {
        // Another instance resolved it first: the conditional update found nothing.
        this.log.debug({ err, action_id: item.actionId }, "reconcile skipped");
      }
    }
    return resolved;
  }

  private loadAction(tenantId: string, actionId: string): Promise<ExecutableAction | undefined> {
    return this.db.transaction((tx) => lockAction(tx, tenantId, actionId));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`provider call exceeded ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
