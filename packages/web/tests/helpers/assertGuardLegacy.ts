// What `node:assert` / `assert` resolve to in the web Vitest runs (vitest.config.ts
// alias): node:assert with bounded failure output. See assertGuard.ts.
import { assertGuardLegacy as guarded } from "./assertGuard";

export default guarded;
export const {
  AssertionError,
  CallTracker,
  ok,
  fail,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  partialDeepStrictEqual,
  match,
  doesNotMatch,
  throws,
  rejects,
  doesNotThrow,
  doesNotReject,
  ifError,
  strict,
  Assert,
} = guarded as typeof guarded & { CallTracker: unknown };
