/** Where the last page of each server, and of each of its rail tabs, is remembered (useTabRouteMemory). */
export const TAB_MEMORY_STORAGE_PREFIX = "slock:tabMemory:v2";
export const SERVER_SURFACE_STORAGE_PREFIX = "slock:serverSurface:v1";

/**
 * Forgets every remembered page, so the next start lands on a server's own
 * first page, not the conversation it was last on. The root error screen's
 * way out (#triage:#351): Raft Desktop reopened a conversation that crashed
 * the app, and Reload went straight back to it. Dependency-free, as that
 * screen must be.
 */
export function forgetRememberedPlaces(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && (key.startsWith(`${TAB_MEMORY_STORAGE_PREFIX}:`) || key.startsWith(`${SERVER_SURFACE_STORAGE_PREFIX}:`))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // localStorage may be unavailable (private mode): nothing remembered to forget.
  }
}
