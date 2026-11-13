/**
 * Desktop Activity reopens, on arrival, the conversation opened last time on
 * this server, when it is still listed. Without one (a first visit, or it was
 * marked Done) the right side stays empty, as with no channel open; it never
 * picks the top row (stdrc, #proj-chat 0b6ad97d). The last one is kept in
 * localStorage, so a reload or a new tab comes back to the same conversation.
 */
const STORAGE_PREFIX = "raft.activity.lastOpened.";

export function readLastOpenedActivityKey(serverId: string | undefined): string | null {
  if (!serverId) return null;
  try {
    return localStorage.getItem(STORAGE_PREFIX + serverId);
  } catch {
    return null;
  }
}

export function writeLastOpenedActivityKey(serverId: string | undefined, key: string): void {
  if (!serverId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + serverId, key);
  } catch {
    // Storage full or blocked: the next visit opens nothing.
  }
}

/** The row to reopen: the one opened last time, when it is still listed; otherwise none. */
export function pickReopen<T>(items: readonly T[], keyOf: (item: T) => string, last: string | null): T | null {
  if (last === null) return null;
  return items.find((item) => keyOf(item) === last) ?? null;
}
