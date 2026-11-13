import assert from "node:assert/strict";

/**
 * The most a migration may wait for a lock: every conflicting request queues
 * behind it while it waits, so a migration that can't get its lock should
 * fail and let the deploy runner retry it (#12960 lowered the hot-table ones
 * to 2 s for this reason).
 */
const MAX_MIGRATION_LOCK_TIMEOUT_MS = 5_000;

/**
 * Asserts `statement` is `SET LOCAL lock_timeout = '<n>s'` (or `'<n>ms'`) with
 * a wait above zero and at most `maxMs` (default 5 s). A test pins the bound
 * a migration must stay within, not its exact number: a migration that was
 * lowered on purpose passes its own lower `maxMs`.
 */
export function assertBoundedLockTimeout(
  statement: string | undefined,
  message?: string,
  { maxMs = MAX_MIGRATION_LOCK_TIMEOUT_MS }: { maxMs?: number } = {},
): void {
  const match = /^SET LOCAL lock_timeout = '(\d+)(ms|s)';$/.exec(statement ?? "");
  assert.ok(match, `${message ?? "a lock timeout"}, got: ${statement}`);
  const ms = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  assert.ok(ms > 0 && ms <= maxMs, `${message ?? "lock timeout"}: ${ms} ms is not within (0, ${maxMs}] ms, got: ${statement}`);
}
