/**
 * Canonical decimal-string uint64 primitives.
 *
 * These live in their OWN module, not in `domains/activity.ts`, because they are
 * consumed by the read-state path on the web startup chunk. Importing them from
 * the Activity domain drags that whole domain into the startup closure and trips
 * the module-identity chunk gate — that is exactly what happened when #632 C1
 * (carrier `cdc8e7c90`) began importing `isUInt64String` from the barrel.
 *
 * Keep this module free of domain imports so it stays cheap to depend on.
 */

/** Canonical decimal-string uint64, per the frozen `UInt64String` scalar. */
export type UInt64String = string;

const DECIMAL_UINT64 = /^(0|[1-9][0-9]*)$/;

export function isUInt64String(value: unknown): value is UInt64String {
  return typeof value === "string" && DECIMAL_UINT64.test(value);
}

/**
 * Compare two canonical decimal uint64 strings.
 *
 * This exists because BOTH obvious shortcuts are wrong:
 *
 *   Number(a) - Number(b)   loses precision above 2^53 — which is the entire
 *                           reason these are strings on the wire.
 *   a < b                   lexicographic: "9" > "10", so ordering breaks
 *                           across digit lengths.
 *
 * Canonical form (no leading zeros) makes length the primary key, so this is
 * exact for the full uint64 range without BigInt.
 */
export function compareUInt64String(left: UInt64String, right: UInt64String): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
