import { randomBytes } from "node:crypto";

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp + randomness.
 * Time-ordered ids keep B-tree inserts append-mostly (better index locality
 * than random v4) while remaining unguessable enough for identifiers.
 * Postgres 16 has no built-in v7, so ids are generated in the application;
 * column defaults (gen_random_uuid) are only a fallback.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
