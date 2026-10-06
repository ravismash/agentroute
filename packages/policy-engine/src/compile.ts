import { createHash } from "node:crypto";
import { isKnownTool, TOOL_ARG_SCHEMAS, type KnownToolName } from "@agentroute/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PolicyDocument, type Escalation, type Requirement } from "./schema.js";

const MAX_POLICY_BYTES = 256 * 1024;

export interface CompiledToolPolicy {
  tool: KnownToolName;
  effect: "allow" | "approval_required";
  require: readonly Requirement[];
  escalate: readonly Escalation[];
}

/** A validated, indexed, immutable policy ready for evaluation. */
export interface CompiledPolicy {
  id: string;
  version: string;
  tenant: string;
  agents: ReadonlySet<string>;
  blockedTools: ReadonlySet<string>;
  tools: ReadonlyMap<string, CompiledToolPolicy>;
  /** SHA-256 of the policy source, recorded with every decision for audit. */
  checksum: string;
}

export type PolicyLoadResult = { ok: true; policy: CompiledPolicy } | { ok: false; errors: string[] };

/** Parse YAML text and compile it. Never throws. */
export function loadPolicy(source: string): PolicyLoadResult {
  if (Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES) {
    return { ok: false, errors: [`policy exceeds ${MAX_POLICY_BYTES} bytes`] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(source, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (err) {
    return { ok: false, errors: [`invalid YAML: ${(err as Error).message}`] };
  }
  return compilePolicy(raw, source);
}

/** Validate an already-parsed policy document and build its evaluation index. */
export function compilePolicy(raw: unknown, source = JSON.stringify(raw)): PolicyLoadResult {
  const parsed = PolicyDocument.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`) };
  }
  const doc = parsed.data;
  const errors: string[] = [];
  const tools = new Map<string, CompiledToolPolicy>();

  for (const [tool, toolPolicy] of Object.entries(doc.tools)) {
    const at = `tools.${tool}`;
    if (!isKnownTool(tool)) {
      errors.push(`${at}: unknown tool (not defined in @agentroute/contracts)`);
      continue;
    }
    if (doc.blocked_tools.includes(tool)) {
      errors.push(`${at}: tool is also listed in blocked_tools`);
    }
    const shape = TOOL_ARG_SCHEMAS[tool].shape as Record<string, z.ZodType>;
    const ids = new Set<string>();
    for (const rule of [...toolPolicy.require, ...toolPolicy.escalate]) {
      if (ids.has(rule.id)) errors.push(`${at}: duplicate rule id "${rule.id}"`);
      ids.add(rule.id);
      if ("arg" in rule && !Object.hasOwn(shape, rule.arg)) {
        errors.push(`${at}.${rule.id}: tool has no argument "${rule.arg}"`);
      }
      if (rule.type === "threshold" && Object.hasOwn(shape, rule.arg) && !isNumberSchema(shape[rule.arg])) {
        errors.push(`${at}.${rule.id}: threshold argument "${rule.arg}" is not numeric`);
      }
    }
    tools.set(tool, {
      tool,
      effect: toolPolicy.effect,
      require: Object.freeze([...toolPolicy.require]),
      escalate: Object.freeze([...toolPolicy.escalate]),
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    policy: Object.freeze({
      id: doc.id,
      version: doc.version,
      tenant: doc.tenant,
      agents: new Set(doc.agents),
      blockedTools: new Set(doc.blocked_tools),
      tools,
      checksum: fingerprint(source),
    }),
  };
}

function isNumberSchema(schema: z.ZodType | undefined): boolean {
  let current: unknown = schema;
  while (current instanceof z.ZodOptional) current = current.unwrap();
  return current instanceof z.ZodNumber;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map(String).join(".");
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
