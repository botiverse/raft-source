/**
 * One-shot "there is a mobile app now" marker on the Help entry point.
 *
 * The dot exists to announce a *new capability* once, so its lifecycle is
 * "until seen", not "until the underlying state clears" — unlike
 * `dismissedNotificationStore`, whose keys are state fingerprints that
 * deliberately resurface when the world changes. Nothing about the mobile app
 * changes back, so a fingerprint here would either never re-fire (identical to
 * a boolean, but with more machinery) or re-fire forever.
 *
 * **Scope is per user, per device, and that is a real limitation, not a
 * shortcut.** `localStorage` cannot follow someone to another browser, so a
 * person who dismisses this on their laptop still sees it on their desktop.
 * The spec asked for user-scoped. Making that true needs a server-side
 * per-user flag (a column plus an endpoint) — worth it for something costly to
 * re-see, but this is a dot that disappears on first open. Keying by user id
 * buys the part that actually bites: on a shared device, B does not inherit
 * A's dismissal, and A does not get it back on logout/login.
 *
 * Reads are best-effort: Safari private mode throws on `localStorage` access,
 * and a throw here must not take out the rail. Failing closed (treat as seen)
 * would hide the entry point permanently for those users, so failures fall to
 * "unseen" — the worst case is a dot that reappears, not one that never shows.
 */

const STORAGE_PREFIX = "slock:mobile-app:seen";

export function mobileAppSeenStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

/**
 * Whether this person still needs the "we have a mobile app" nudge.
 *
 * Returns false with no user id: an anonymous/loading rail should not flash a
 * dot it cannot attribute, and it would be marked seen against the wrong key.
 */
export function shouldShowMobileAppBadge(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(mobileAppSeenStorageKey(userId)) !== "1";
  } catch {
    return true;
  }
}

export function markMobileAppSeen(userId: string | null | undefined): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(mobileAppSeenStorageKey(userId), "1");
  } catch {
    // Best-effort: the in-memory state has already hidden the dot for this
    // session, so the only cost is that it returns on the next page load.
  }
}
