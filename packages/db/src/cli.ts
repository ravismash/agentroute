import pg from "pg";
import { migrate } from "./migrate.js";

const [command] = process.argv.slice(2);
const url = process.env.DATABASE_URL;

if (command !== "migrate") {
  console.error("usage: agentroute-db migrate   (reads DATABASE_URL)");
  process.exit(2);
}
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, application_name: "agentroute-migrate" });
await client.connect();
try {
  const result = await migrate(client, {
    log: (m) => {
      console.log(m);
    },
  });
  console.log(
    `migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already up to date`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
