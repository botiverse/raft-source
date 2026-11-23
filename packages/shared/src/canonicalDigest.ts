// Canonical JSON, isomorphic SHA-256 and UTF-8 byte length. Left from the
// removed Computer provider probes (saved provider connections), still used
// by the Web and by other shared code.

/** Stable, key-order-insensitive JSON serialization used by every digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Isomorphic SHA-256 (WebCrypto) so this module stays loadable from the Web
 * bundle; digest helpers are async everywhere for the same reason.
 */
export async function sha256Hex(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
