import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Unbiased random base62 string (rejection sampling). */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += ALPHABET.charAt(byte % 62);
      if (out.length === length) break;
    }
  }
  return out;
}

export type CredentialKind = "api_key" | "operator_token";

/**
 * Credentials look like `<prefix>_<secret>`:
 *   tenant API key:  ar_test_AbC12345_<32 chars>  (or ar_live_…)
 *   operator token:  ar_op_AbC12345_<32 chars>
 * The prefix is stored for lookup; only the SHA-256 of the whole credential is stored.
 */
const PATTERNS: Record<CredentialKind, RegExp> = {
  api_key: /^(ar_(?:test|live)_[A-Za-z0-9]{8})_[A-Za-z0-9]{32}$/,
  operator_token: /^(ar_op_[A-Za-z0-9]{8})_[A-Za-z0-9]{32}$/,
};

export function parseCredential(kind: CredentialKind, credential: string): { prefix: string } | undefined {
  const match = PATTERNS[kind].exec(credential);
  return match?.[1] ? { prefix: match[1] } : undefined;
}

export function hashCredential(credential: string): Buffer {
  return createHash("sha256").update(credential, "utf8").digest();
}

export function hashesMatch(stored: Buffer, credential: string): boolean {
  const candidate = hashCredential(credential);
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

export interface GeneratedCredential {
  /** Shown to the user exactly once; never stored. */
  plaintext: string;
  prefix: string;
  hash: Buffer;
}

export function generateCredential(kind: CredentialKind, env: "test" | "live" = "test"): GeneratedCredential {
  const prefix = kind === "api_key" ? `ar_${env}_${randomBase62(8)}` : `ar_op_${randomBase62(8)}`;
  const plaintext = `${prefix}_${randomBase62(32)}`;
  return { plaintext, prefix, hash: hashCredential(plaintext) };
}
