// An Artifact's short id: the 16 bytes of its uuid in Base58 (the Bitcoin
// alphabet), always 22 characters, left-padded with "1". What every link
// Raft builds for an Artifact carries (`https://app.raft.build/artifacts/<short>`)
// instead of `pt_<uuid>`; the database, the API's `id` fields and every
// internal reference keep the uuid (docs/development/workspace-artifacts.md,
// "Short Artifact links"). parseArtifactRef (artifactRef.ts) reads both forms.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX: ReadonlyMap<string, number> = new Map(Array.from(ALPHABET, (char, index) => [char, index]));
/** 58^22 > 2^128 > 58^21: 22 digits always hold 16 bytes, and 21 never do. */
export const ARTIFACT_SHORT_ID_LENGTH = 22;
const UUID_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT = /^[1-9A-HJ-NP-Za-km-z]{22}$/;

/**
 * The short id of a uuid (any case, with its hyphens): exactly 22 characters
 * of the Bitcoin Base58 alphabet. Throws on anything that isn't a uuid.
 */
export function encodeArtifactShortId(uuid: string): string {
  if (!UUID.test(uuid)) throw new RangeError("not a uuid");
  const hex = uuid.replace(/-/g, "");
  // Base 256 to base 58, most significant digit first. 2^128 < 58^22, so the
  // carry is spent by the last digit; the leading zeros left are "1".
  const digits = new Array<number>(ARTIFACT_SHORT_ID_LENGTH).fill(0);
  for (let at = 0; at < hex.length; at += 2) {
    let carry = Number.parseInt(hex.slice(at, at + 2), 16);
    for (let i = ARTIFACT_SHORT_ID_LENGTH - 1; i >= 0; i -= 1) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
  }
  return digits.map((digit) => ALPHABET[digit]).join("");
}

/**
 * The uuid a short id names, lowercase with hyphens, or null: not exactly 22
 * characters of the alphabet, or a value over 16 bytes (anything above
 * `YcVfxkQb6JRzqk5kF2tNLv`, 2^128 - 1).
 */
export function decodeArtifactShortId(value: string): string | null {
  if (!SHORT.test(value)) return null;
  const bytes = new Array<number>(UUID_BYTES).fill(0);
  for (const char of value) {
    let carry = INDEX.get(char)!;
    for (let i = UUID_BYTES - 1; i >= 0; i -= 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    if (carry !== 0) return null;
  }
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
