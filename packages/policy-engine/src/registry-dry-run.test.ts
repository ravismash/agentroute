import { describe, expect, it } from "vitest";
import { comparePolicies, dryRun, type DryRunCase } from "./dry-run.js";
import { loadPolicy } from "./compile.js";
import { PolicyRegistry } from "./registry.js";
import { BASELINE_SOURCE, baselinePolicy, context, refund, usageFor } from "./test-support/fixtures.js";

const tenantPolicy = (tenant: string, version = "1.0.0") =>
  BASELINE_SOURCE.replace('tenant: "*"', `tenant: ${tenant}`).replace(
    "version: 1.0.0",
    `version: ${version}`,
  );

describe("PolicyRegistry", () => {
  it("resolves the global policy for any tenant", () => {
    const registry = new PolicyRegistry();
    expect(registry.register(BASELINE_SOURCE).ok).toBe(true);
    expect(registry.resolve("tenant_a", "supportops")?.id).toBe("support-agent-baseline");
  });

  it("returns undefined for an agent no policy covers", () => {
    const registry = new PolicyRegistry();
    registry.register(BASELINE_SOURCE);
    expect(registry.resolve("tenant_a", "unknown-agent")).toBeUndefined();
  });

  it("P-14 never applies one tenant's policy to another tenant", () => {
    const registry = new PolicyRegistry();
    registry.register(tenantPolicy("tenant_a"));
    expect(registry.resolve("tenant_a", "supportops")?.tenant).toBe("tenant_a");
    expect(registry.resolve("tenant_b", "supportops")).toBeUndefined();
  });

  it("prefers a tenant-specific policy over the global one", () => {
    const registry = new PolicyRegistry();
    registry.register(BASELINE_SOURCE);
    registry.register(tenantPolicy("tenant_a", "2.0.0"));
    expect(registry.resolve("tenant_a", "supportops")?.version).toBe("2.0.0");
    expect(registry.resolve("tenant_b", "supportops")?.tenant).toBe("*");
  });

  it("P-15 keeps the previous version when a new one is invalid", () => {
    const registry = new PolicyRegistry();
    registry.register(BASELINE_SOURCE);
    const bad = registry.register(BASELINE_SOURCE.replace("default: deny", "default: allow"));
    expect(bad.ok).toBe(false);
    expect(registry.resolve("tenant_a", "supportops")?.version).toBe("1.0.0");
  });

  it("reports the version it replaced", () => {
    const registry = new PolicyRegistry();
    registry.register(BASELINE_SOURCE);
    const result = registry.register(BASELINE_SOURCE.replace("version: 1.0.0", "version: 1.1.0"));
    expect(result).toMatchObject({ ok: true, replaced: { version: "1.0.0" } });
  });
});

describe("dry run and comparison", () => {
  const current = baselinePolicy();
  const ctx = context();
  const cases: DryRunCase[] = [1500, 2500, 4000, 29900, 60000].map((amount) => {
    const proposal = refund(amount);
    return { id: `refund-${amount}`, proposal, context: ctx, usage: usageFor(current, proposal, ctx) };
  });

  it("summarises decisions by effect", () => {
    const report = dryRun(current, cases);
    expect(report.by_effect).toEqual({ allow: 2, approval_required: 2, deny: 1 });
    expect(report.results.map((r) => r.decision.effect)).toEqual([
      "allow",
      "allow",
      "approval_required",
      "approval_required",
      "deny",
    ]);
  });

  it("shows which cases a candidate policy would change", () => {
    const candidateSource = BASELINE_SOURCE.replace("version: 1.0.0", "version: 1.1.0").replaceAll(
      "gt: 2500",
      "gt: 5000",
    );
    const candidate = loadPolicy(candidateSource);
    if (!candidate.ok) throw new Error(candidate.errors.join());
    const comparison = comparePolicies(current, candidate.policy, cases);
    expect(comparison.changed).toEqual([{ id: "refund-4000", from: "approval_required", to: "allow" }]);
    expect(comparison.loosened).toBe(1);
    expect(comparison.tightened).toBe(0);
  });
});
