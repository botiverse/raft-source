/**
 * Server persistent client preferences.
 *
 * RFC 037 class 4 state lives behind a named registry instead of scattered
 * raw localStorage calls. The T5-server slice owns the last-server pointer;
 * auth/session storage remains in auth-owned modules.
 */

export const LAST_SERVER_SLUG_STORAGE_KEY = "slock_last_server_slug";
export const LEGACY_SERVER_ID_STORAGE_KEY = "slock_server_id";

function localStorageOrNull(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

export const serverPersistence = {
  readLastServerSlug(): string | null {
    try {
      return localStorageOrNull()?.getItem(LAST_SERVER_SLUG_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },

  writeLastServerSlug(slug: string): void {
    try {
      localStorageOrNull()?.setItem(LAST_SERVER_SLUG_STORAGE_KEY, slug);
    } catch {
      // Ignore storage failures; navigation still uses in-memory state.
    }
  },

  clearLastServerSlug(expectedSlug?: string | null): void {
    try {
      const storage = localStorageOrNull();
      if (!storage) return;
      if (expectedSlug && storage.getItem(LAST_SERVER_SLUG_STORAGE_KEY) !== expectedSlug) return;
      storage.removeItem(LAST_SERVER_SLUG_STORAGE_KEY);
    } catch {
      // Ignore storage failures; this is a preference cleanup.
    }
  },

  clearLegacyServerId(): void {
    try {
      localStorageOrNull()?.removeItem(LEGACY_SERVER_ID_STORAGE_KEY);
    } catch {
      // Ignore storage failures; this is a best-effort legacy cleanup.
    }
  },
};
