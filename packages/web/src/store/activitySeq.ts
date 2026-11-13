/** Activity row seqs: canonical decimal strings (task #361), shared by the inbox store and its helpers. */

/** Compare two canonical decimal seq strings as exact BigInt (task #361: full-chain
 * forbid Number() to avoid the 2^53 precision hole). Returns >0 if a>b, 0 if equal,
 * <0 if a<b. An absent/invalid seq (null, leading-zero, non-digit) loses to any valid
 * present seq; two absent/invalid seqs compare equal. Non-canonical input is treated
 * as absent rather than guessed. */
export function compareActivitySeq(a: string | null | undefined, b: string | null | undefined): number {
  const canonical = (s: string | null | undefined): string | null =>
    typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s) ? s : null;
  const av = canonical(a);
  const bv = canonical(b);
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  const ba = BigInt(av);
  const bb = BigInt(bv);
  return ba > bb ? 1 : ba < bb ? -1 : 0;
}

/** Convert a legacy socket Message.seq (number) to a canonical decimal string overlay.
 * Only a safe non-negative integer is convertible; missing/unsafe must not be guessed
 * (task #361 contract: missing/unsafe seq → wake/refetch, never a fabricated seq). */
export function safeSeqToDecimalString(seq: number | null | undefined): string | null {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  return String(seq);
}
