import { generateCredential, hashesMatch, parseCredential } from "../credentials.js";
import type { Queryable } from "../database.js";

export interface TenantPrincipal {
  kind: "tenant";
  tenantId: string;
  keyId: string;
}

export interface OperatorPrincipal {
  kind: "operator";
  operatorId: string;
  /** null for platform admins, who may act across tenants. */
  tenantId: string | null;
  role: "operator" | "admin";
}

/** Resolve a tenant API key. Returns undefined for anything invalid, revoked, expired or suspended. */
export async function authenticateApiKey(
  q: Queryable,
  credential: string,
): Promise<TenantPrincipal | undefined> {
  const parsed = parseCredential("api_key", credential);
  if (!parsed) return undefined;
  const { rows } = await q.query<{ id: string; tenant_id: string; key_hash: Buffer }>(
    `SELECT k.id, k.tenant_id, k.key_hash
       FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.prefix = $1 AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
        AND t.status = 'active'`,
    [parsed.prefix],
  );
  const row = rows[0];
  if (!row || !hashesMatch(row.key_hash, credential)) return undefined;
  // Throttled so authentication doesn't write on every request.
  await q.query(
    `UPDATE api_keys SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [row.id],
  );
  return { kind: "tenant", tenantId: row.tenant_id, keyId: row.id };
}

export async function authenticateOperator(
  q: Queryable,
  credential: string,
): Promise<OperatorPrincipal | undefined> {
  const parsed = parseCredential("operator_token", credential);
  if (!parsed) return undefined;
  const { rows } = await q.query<{
    token_id: string;
    key_hash: Buffer;
    operator_id: string;
    tenant_id: string | null;
    role: "operator" | "admin";
  }>(
    `SELECT t.id AS token_id, t.key_hash, o.id AS operator_id, o.tenant_id, o.role
       FROM operator_tokens t JOIN operators o ON o.id = t.operator_id
      WHERE t.prefix = $1 AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND o.disabled_at IS NULL`,
    [parsed.prefix],
  );
  const row = rows[0];
  if (!row || !hashesMatch(row.key_hash, credential)) return undefined;
  await q.query(
    `UPDATE operator_tokens SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [row.token_id],
  );
  return { kind: "operator", operatorId: row.operator_id, tenantId: row.tenant_id, role: row.role };
}

/** Create a tenant API key. The plaintext is returned once and never stored. */
export async function issueApiKey(q: Queryable, tenantId: string, label: string): Promise<string> {
  const cred = generateCredential("api_key", "test");
  await q.query("INSERT INTO api_keys (tenant_id, prefix, key_hash, label) VALUES ($1, $2, $3, $4)", [
    tenantId,
    cred.prefix,
    cred.hash,
    label,
  ]);
  return cred.plaintext;
}

export async function issueOperatorToken(q: Queryable, operatorId: string): Promise<string> {
  const cred = generateCredential("operator_token");
  await q.query("INSERT INTO operator_tokens (operator_id, prefix, key_hash) VALUES ($1, $2, $3)", [
    operatorId,
    cred.prefix,
    cred.hash,
  ]);
  return cred.plaintext;
}

export async function revokeApiKey(q: Queryable, tenantId: string, prefix: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND prefix = $2 AND revoked_at IS NULL",
    [tenantId, prefix],
  );
  return rowCount === 1;
}
