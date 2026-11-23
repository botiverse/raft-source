/** Where each server's places are remembered (placeMemory): its last rail tab and the last page of each tab. */
export const PLACE_STORAGE_PREFIX = "slock:place:v1";

/**
 * The memories it replaced: read once through the place allowlist, then
 * deleted (placeMemory's migration). `slock:last-location` was the cold `/`
 * start's own second memory, folded into the last server's place.
 */
export const LEGACY_TAB_MEMORY_PREFIX = "slock:tabMemory:v2";
export const LEGACY_SERVER_SURFACE_PREFIX = "slock:serverSurface:v1";
export const LEGACY_PLACE_STORAGE_PREFIXES = [LEGACY_TAB_MEMORY_PREFIX, LEGACY_SERVER_SURFACE_PREFIX] as const;
export const LEGACY_LAST_LOCATION_KEY = "slock:last-location";

/**
 * Forgets every remembered place, so the next start lands on a server's own
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
      if (key && (key === LEGACY_LAST_LOCATION_KEY || [PLACE_STORAGE_PREFIX, ...LEGACY_PLACE_STORAGE_PREFIXES].some((prefix) => key.startsWith(`${prefix}:`)))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // localStorage may be unavailable (private mode): nothing remembered to forget.
  }
}
