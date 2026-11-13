// The users-first rule as checked on one recorded transaction (its statements
// and parameter values, in order): used by the real-PG guard
// (services/jointUsersFirstLockOrder.realPg.test.ts) and unit-tested on
// counterexamples (jointUsersFirstGuard.test.ts).

export type Statement = { text: string; values: readonly unknown[] };

/** A statement that takes a lock: a row lock, an advisory lock, a write. */
export const LOCK = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b|pg_advisory_xact_lock|pg_try_advisory_xact_lock|^\s*(?:insert|update|delete)\b|^\s*lock\s+table/i;
/** lockJointUsersFirst's lock statement. */
export const USERS_FIRST = /^\s*select\s+u\.id\s+from\s+users\s+u\s+where\s+u\.id\s+in\s*\([\s\S]*\)\s*order\s+by\s+u\.id\s+for\s+key\s+share\s+of\s+u\s*$/i;
/** Any statement locking users rows: the helper, raw FOR KEY SHARE / FOR UPDATE, lockReferencedRows, a drizzle .for() on users. */
export const USERS_ROW_LOCK = /\bfrom\s+"?users"?(?=[\s,;)]|$)[\s\S]*\bfor\s+(?:key\s+share|share|no\s+key\s+update|update)\b/i;
/** The channel conversion writer fence (withChannelWriterFence): the only lock allowed before the users rows. */
export const FENCE = /^\s*select\s+pg_advisory_xact_lock_shared\(\$1,\s*\$2\)\s*$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The user ids a users-row lock statement names (its uuid parameters). */
export const lockedIds = (statement: Statement): string[] => statement.values.map(String).filter((value) => UUID.test(value));

const brief = (statement: Statement) => statement.text.replace(/\s+/g, " ").slice(0, 160);

/**
 * What breaks the rule in a recorded transaction that writes joint rows, or
 * null: its first lock (after the conversion fence at most, `fenceKeys`: the
 * fence's resource keys) is lockJointUsersFirst's, naming every one of
 * `users` (the people its writes name, whose FK checks are not statements);
 * and no later statement locks a users row outside that first set
 * (re-locking a held one is fine).
 */
export function usersFirstViolation(tx: readonly Statement[], users: readonly string[], fenceKeys: ReadonlySet<number>): string | null {
  const locks = tx.filter((statement) => LOCK.test(statement.text));
  let index = 0;
  while (locks[index] && FENCE.test(locks[index]!.text) && fenceKeys.has(Number(locks[index]!.values[1]))) index += 1;
  const first = locks[index];
  if (!first || !USERS_FIRST.test(first.text)) return `first lock is not the users rows: ${first ? brief(first) : "(none)"}`;
  const held = new Set(lockedIds(first));
  const missing = users.filter((id) => !held.has(id));
  if (missing.length) return `users lock misses ${missing.join(", ")}`;
  for (const statement of locks.slice(index + 1)) {
    if (!USERS_ROW_LOCK.test(statement.text)) continue;
    const added = lockedIds(statement).filter((id) => !held.has(id));
    // Taken after a server or channel row, it can wait behind a deletion holding it FOR UPDATE that waits on those.
    if (added.length) return `users row ${added.join(", ")} locked after the first lock: ${brief(statement)}`;
  }
  return null;
}
