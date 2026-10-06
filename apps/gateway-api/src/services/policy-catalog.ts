import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { storeAndActivatePolicy, type Database } from "@agentroute/db";
import { PolicyRegistry } from "@agentroute/policy-engine";
import type { Logger } from "@agentroute/telemetry";

export interface PolicyRecordRef {
  dbId: string;
  key: string;
  version: string;
  checksum: string;
}

/**
 * Active policies in memory (for fast, pure evaluation) plus the database row
 * each one is stored as (so every decision references the exact version).
 */
export class PolicyCatalog {
  readonly registry = new PolicyRegistry();
  private readonly records = new Map<string, PolicyRecordRef>();

  /** Load every *.yaml in `dir`, store new versions and activate them. Invalid files abort startup. */
  static async load(db: Database, dir: string, log: Logger): Promise<PolicyCatalog> {
    const catalog = new PolicyCatalog();
    const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      await catalog.register(db, source, file);
      log.info({ file }, "policy loaded");
    }
    return catalog;
  }

  async register(db: Database, source: string, label = "policy"): Promise<void> {
    const result = this.registry.register(source);
    if (!result.ok) throw new Error(`${label} is invalid:\n  ${result.errors.join("\n  ")}`);
    const { policy } = result;
    const dbId = await db.transaction((tx) =>
      storeAndActivatePolicy(tx, {
        tenantId: policy.tenant === "*" ? null : policy.tenant,
        key: policy.id,
        version: policy.version,
        source,
        checksum: policy.checksum,
      }),
    );
    this.records.set(policy.checksum, {
      dbId,
      key: policy.id,
      version: policy.version,
      checksum: policy.checksum,
    });
  }

  recordFor(checksum: string): PolicyRecordRef {
    const record = this.records.get(checksum);
    if (!record) throw new Error(`policy ${checksum} is not stored`);
    return record;
  }
}
