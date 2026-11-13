/**
 * A list route's `offset` query parameter: a whole number from 0 up to
 * Number.MAX_SAFE_INTEGER. Missing, non-numeric or negative reads as 0, as
 * before. An offset past the cap is clamped to it, so it returns no rows
 * instead of failing (some reads still fetch offset + limit rows to slice the
 * page, so it is not free). Unbounded, `offset=1e20` reached SQL as an OFFSET outside bigint, and the
 * statement failed to prepare (RisingWave's inbox read, 11-04 10:24Z).
 */
export function parseOffsetQueryParam(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0;
  return Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER);
}
