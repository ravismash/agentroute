/**
 * Local demo data + credentials for development.
 *
 *   node apps/gateway-api/dist/scripts/seed.js [--rotate]
 *
 * Writes credentials to .dev-credentials.json (git-ignored, mode 600).
 * On platforms without a shell, use the gateway's SEED_ON_START env flag instead.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Database, randomBase62, runMigrations } from "@agentroute/db";
import { FakePaymentGateway, StripePaymentGateway, type PaymentGateway } from "@agentroute/execution";
import { loadConfig } from "../config.js";
import { seedDemoData } from "../seed.js";

const CREDENTIALS_FILE = fileURLToPath(new URL("../../../../.dev-credentials.json", import.meta.url));

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new Database({ connectionString: config.DATABASE_URL, applicationName: "agentroute-seed" });
const payments: PaymentGateway = config.STRIPE_SECRET_KEY
  ? new StripePaymentGateway(config.STRIPE_SECRET_KEY)
  : new FakePaymentGateway();

try {
  await runMigrations(config.DATABASE_URL, { log: console.log });
  const issue = !existsSync(CREDENTIALS_FILE) || process.argv.includes("--rotate");
  const creds = await seedDemoData(db, payments, { issueCredentials: issue, log: console.log });
  if (creds) {
    await writeFile(CREDENTIALS_FILE, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
    console.log(`wrote credentials to ${CREDENTIALS_FILE} (git-ignored)`);
  } else {
    const existing = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, unknown>;
    if (typeof existing.agent_service_token !== "string") {
      existing.agent_service_token = randomBase62(40);
      await writeFile(CREDENTIALS_FILE, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(`credentials already in ${CREDENTIALS_FILE}; use --rotate to issue new ones`);
  }
  console.log("seed complete");
} finally {
  await db.close();
}
