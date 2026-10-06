import type { Queryable } from "../database.js";

export interface PolicyRecord {
  tenantId: string | null;
  key: string;
  version: string;
  source: string;
  checksum: string;
}

/**
 * Store a policy version (if new) and make it the active one for its tenant.
 * Returns the row id. A version that already exists with different content
 * is rejected: versions are immutable, so a change needs a version bump.
 * Call inside a transaction.
 */
export async function storeAndActivatePolicy(tx: Queryable, p: PolicyRecord): Promise<string> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `policy:${p.tenantId ?? "*"}:${p.key}`,
  ]);
  const existing = await tx.query<{ id: string; checksum: string; is_active: boolean }>(
    `SELECT id, checksum, is_active FROM policies
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND policy_key = $2 AND version = $3`,
    [p.tenantId, p.key, p.version],
  );
  let row = existing.rows[0];
  if (row && row.checksum !== p.checksum) {
    throw new Error(
      `policy ${p.key}@${p.version} is already stored with different content; bump the version to change it`,
    );
  }
  if (!row) {
    const inserted = await tx.query<{ id: string; checksum: string; is_active: boolean }>(
      `INSERT INTO policies (tenant_id, policy_key, version, source, checksum)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, checksum, is_active`,
      [p.tenantId, p.key, p.version, p.source, p.checksum],
    );
    row = inserted.rows[0];
    if (!row) throw new Error("policy insert returned no row");
  }
  if (!row.is_active) {
    await tx.query(
      `UPDATE policies SET is_active = false
        WHERE tenant_id IS NOT DISTINCT FROM $1 AND policy_key = $2 AND is_active`,
      [p.tenantId, p.key],
    );
    await tx.query("UPDATE policies SET is_active = true, activated_at = now() WHERE id = $1", [row.id]);
  }
  return row.id;
}
