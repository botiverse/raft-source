import type { RuntimeLimitResetIdempotencyKey } from "@botiverse/raft-shared";

// One limit-reset attempt's idempotency key, kept in this tab's
// sessionStorage: after an outcome nobody learned, the person may reload
// before retrying, and a freshly minted key could spend a second reset.
// Dropped once the Computer answers for good.
const STORAGE_PREFIX = "raft:runtime-limit-reset-attempt:";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// The page's own copy, for when storage is unavailable (private mode, quota).
const keptInPage = new Map<string, RuntimeLimitResetIdempotencyKey>();

function storageName(subject: string): string {
  return STORAGE_PREFIX + encodeURIComponent(subject);
}

export function limitResetAttemptKey(
  subject: string,
  storage: AttemptStorage | undefined = globalThis.sessionStorage,
): RuntimeLimitResetIdempotencyKey {
  const name = storageName(subject);
  try {
    const kept = storage?.getItem(name);
    if (kept) return kept as RuntimeLimitResetIdempotencyKey;
  } catch {
    // Unavailable: fall back to the page's copy.
  }
  const key = keptInPage.get(name) ?? (crypto.randomUUID() as RuntimeLimitResetIdempotencyKey);
  keptInPage.set(name, key);
  try {
    storage?.setItem(name, key);
  } catch {
    // As above.
  }
  return key;
}

export function forgetLimitResetAttemptKey(
  subject: string,
  storage: AttemptStorage | undefined = globalThis.sessionStorage,
): void {
  keptInPage.delete(storageName(subject));
  try {
    storage?.removeItem(storageName(subject));
  } catch {
    // Nothing kept there.
  }
}
