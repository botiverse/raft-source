/**
 * Raft links in a desktop browser always ask (stdrc, 2026-11-17,
 * #raft-feature-flag:9a4baa11): the "Open in Raft Desktop" banner shows for
 * every Raft link that lands from outside, and nothing remembers the answer,
 * because the point is to bring people to Raft Desktop. Settings › Appearance ›
 * How links open, the banner's "Remember my choice" and the 7 days of quiet
 * after Continue on Web are gone.
 *
 * Their old values in this browser are no longer read; this clears them, so a
 * past "In this browser" doesn't linger in storage.
 */
const LEGACY_LINK_OPEN_STORAGE_KEYS = ["raft_link_open_preference", "raft_link_open_quiet_until"] as const;

export function forgetLegacyLinkOpenChoice(): void {
  try {
    for (const key of LEGACY_LINK_OPEN_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was stored either.
  }
}
