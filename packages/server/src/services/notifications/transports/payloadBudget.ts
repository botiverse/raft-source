/**
 * Byte budgets of the push providers. Every provider rejects an oversized
 * request outright (Web Push 413, APNs 413 PayloadTooLarge, FCM
 * INVALID_ARGUMENT), so the notification is lost on that device. The text the
 * envelope carries is bounded in characters, not bytes: a 512-character CJK
 * notice body is 1.5 KB of UTF-8 before the title, subtitle and identity
 * fields, so each transport fits its serialized payload here.
 *
 * - Web Push: the encrypted body is at most 4096 bytes; aes128gcm adds an
 *   86-byte header, a 16-byte tag and a 1-byte delimiter, so the plaintext
 *   JSON may be 3993 bytes. The budget keeps a margin under that.
 * - APNs: the whole JSON body is at most 4096 bytes.
 * - FCM: `message.data` is at most 4096 bytes (keys and values). The JSON
 *   size over-counts it (quotes, separators), so measuring JSON is safe.
 */

export const WEB_PUSH_PAYLOAD_MAX_BYTES = 3_800;
export const APNS_PAYLOAD_MAX_BYTES = 4_000;
export const FCM_DATA_MAX_BYTES = 4_000;

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * `text` cut to at most `maxBytes` of UTF-8 on a code point boundary, ending
 * in "…" when it was cut. Never splits a surrogate pair.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = maxBytes - ELLIPSIS_BYTES;
  if (budget <= 0) return "";
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * Shortens one text field until `measure()` fits `maxBytes`. Removing a
 * character removes at least its UTF-8 size from the JSON (escapes only make
 * it larger), so one cut by the overflow is enough; the loop is a guard.
 */
export function shrinkTextToFit(
  measure: () => number,
  maxBytes: number,
  get: () => string,
  set: (value: string) => void,
): void {
  for (let pass = 0; pass < 3; pass += 1) {
    const overflow = measure() - maxBytes;
    if (overflow <= 0) return;
    const current = get();
    const currentBytes = Buffer.byteLength(current, "utf8");
    if (currentBytes === 0) return;
    set(truncateUtf8(current, Math.max(0, currentBytes - overflow)));
  }
}
