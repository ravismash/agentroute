import { loadPolicy, type CompiledPolicy } from "./compile.js";

export type RegisterResult =
  | { ok: true; policy: CompiledPolicy; replaced?: { id: string; version: string } }
  | { ok: false; errors: string[] };

/**
 * In-memory set of active policies, keyed by tenant and policy id.
 * A policy that fails validation is rejected and the previously active
 * version stays in force. Phase 2 backs this with the `policies` table.
 */
export class PolicyRegistry {
  private readonly byTenant = new Map<string, Map<string, CompiledPolicy>>();

  register(source: string): RegisterResult {
    const loaded = loadPolicy(source);
    if (!loaded.ok) return loaded;
    const { policy } = loaded;
    const policies = this.byTenant.get(policy.tenant) ?? new Map<string, CompiledPolicy>();
    const previous = policies.get(policy.id);
    policies.set(policy.id, policy);
    this.byTenant.set(policy.tenant, policies);
    return previous
      ? { ok: true, policy, replaced: { id: previous.id, version: previous.version } }
      : { ok: true, policy };
  }

  /**
   * The policy governing this tenant and agent: a tenant-specific policy
   * wins over the global (`*`) one. Undefined means no policy — callers
   * must deny.
   */
  resolve(tenantId: string, agentId: string): CompiledPolicy | undefined {
    return this.find(tenantId, agentId) ?? this.find("*", agentId);
  }

  private find(tenant: string, agentId: string): CompiledPolicy | undefined {
    const policies = this.byTenant.get(tenant);
    if (!policies) return undefined;
    for (const policy of policies.values()) {
      if (policy.agents.has(agentId)) return policy;
    }
    return undefined;
  }
}
