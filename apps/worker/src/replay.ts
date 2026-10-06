/**
 * Operator CLI for the event pipeline.
 *
 *   pnpm --filter @agentroute/worker replay status
 *   pnpm --filter @agentroute/worker replay dlq list
 *   pnpm --filter @agentroute/worker replay dlq retry [--id 12 --id 13]   # all when no --id
 *   pnpm --filter @agentroute/worker replay outbox --since 2026-10-06T00:00:00Z
 */
import { Database } from "@agentroute/db";
import { loadConfig } from "./config.js";
import { pipelineStatus } from "./maintenance.js";
import { createRedis } from "./redis.js";
import { listDeadLetters, replayDeadLetters, replayOutbox } from "./recovery.js";

const [command, sub, ...rest] = process.argv.slice(2);
const config = loadConfig();
const db = new Database({ connectionString: config.DATABASE_URL, applicationName: "agentroute-replay" });
const redis = createRedis(config.REDIS_URL);
await redis.connect();

const flagValues = (name: string): string[] =>
  rest.flatMap((v, i) => (rest[i - 1] === `--${name}` ? [v] : []));

try {
  if (command === "status") {
    console.log(JSON.stringify(await pipelineStatus(db, redis, config.STREAM_KEY), null, 2));
  } else if (command === "dlq" && sub === "list") {
    for (const d of await listDeadLetters(db)) {
      console.log(`#${d.id} ${d.consumer} event=${d.event_id ?? "-"} attempts=${d.attempts} ${d.error}`);
    }
  } else if (command === "dlq" && sub === "retry") {
    const ids = flagValues("id").map(Number);
    const n = await replayDeadLetters(db, redis, config.STREAM_KEY, ids.length ? ids : undefined);
    console.log(`re-published ${n} dead-lettered event(s)`);
  } else if (command === "outbox") {
    const since = new Date([sub, ...rest].find((_, i, all) => all[i - 1] === "--since") ?? "");
    if (Number.isNaN(since.getTime())) throw new Error("usage: replay outbox --since <ISO timestamp>");
    console.log(`re-published ${await replayOutbox(db, redis, config.STREAM_KEY, since)} outbox event(s)`);
  } else {
    console.error("usage: replay status | dlq list | dlq retry [--id N] | outbox --since <ISO>");
    process.exitCode = 2;
  }
} finally {
  await redis.quit();
  await db.close();
}
