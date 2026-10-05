/**
 * Best-effort PII and secret redaction for logs and audit payloads.
 *
 * This is defence in depth, not a guarantee: regexes miss novel formats.
 * The threat model documents this limitation.
 */

export type RedactionKind = "card" | "secret" | "ssn" | "aadhaar" | "email";

interface Detector {
  kind: RedactionKind;
  pattern: RegExp;
  /** Optional extra check to cut false positives (e.g. Luhn for card numbers). */
  confirm?: (match: string) => boolean;
}

const DETECTORS: readonly Detector[] = [
  // Provider-style secrets: sk_live_..., sk_test_..., sk-..., rk_..., pk_live_..., ghp_..., AKIA...
  { kind: "secret", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g },
  { kind: "secret", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "secret", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { kind: "secret", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "secret", pattern: /\bar_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Payment card numbers (13–19 digits, optional space/dash separators), Luhn-checked.
  { kind: "card", pattern: /\b(?:\d[ -]?){12,18}\d\b/g, confirm: (m) => luhnValid(m.replace(/[ -]/g, "")) },
  // US SSN.
  { kind: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Indian Aadhaar (12 digits, usually grouped 4-4-4, first digit 2-9).
  { kind: "aadhaar", pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

export interface RedactOptions {
  /** Kinds to leave untouched, e.g. keep emails in operator-only views. */
  allow?: readonly RedactionKind[];
}

export function redactText(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const { kind, pattern, confirm } of DETECTORS) {
    if (options.allow?.includes(kind)) continue;
    out = out.replace(pattern, (match) => (confirm && !confirm(match) ? match : `[REDACTED:${kind}]`));
  }
  return out;
}

/** Recursively redact every string in a JSON-like value. Does not mutate the input. */
export function redactDeep<T>(value: T, options: RedactOptions = {}, depth = 0): T {
  if (depth > 20) return "[REDACTED:depth]" as T;
  if (typeof value === "string") return redactText(value, options) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, options, depth + 1)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, options, depth + 1);
    return out as T;
  }
  return value;
}

/**
 * Only plain objects are rebuilt. Class instances (framework request objects,
 * Errors, Dates) are left for their logger serializers, which would otherwise
 * receive an empty copy.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
