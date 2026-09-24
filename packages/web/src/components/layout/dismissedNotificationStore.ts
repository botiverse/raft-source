import { create } from "zustand";

const STORAGE_PREFIX = "slock:notification-center:dismissed";
const MAX_PERSISTED_KEYS = 100;

// Per-server record of notifications the user has dismissed via the Dismiss
// action on a single row in the notification center. Keys are state-
// fingerprints, not notification ids:
// `useSystemNotifications` rebuilds the key from the current world (which machines
// are offline, what the excess-agent count is) so the dismissal is auto-
// invalidated whenever that fingerprint changes ("直到状态又发生变化", per
// stdrc 2026-05-02 #proj-uiux:f87f6eb9 msg=308efc48).
//
// Dismissal persistence is local and per server: a page refresh should not bring
// back the same fingerprint, but switching servers should load that server's
// own dismissed fingerprints. New fingerprints still resurface naturally.

interface DismissedNotificationState {
  dismissedKeys: Set<string>;
  storageKey: string | null;
  dismiss: (key: string) => void;
  /** Load dismissals for the active server. Passing null clears memory only. */
  loadForServer: (serverId: string | null) => void;
  /** Clear all in-memory dismissals — used on logout. */
  reset: () => void;
}

export const useDismissedNotificationStore = create<DismissedNotificationState>((set) => ({
  dismissedKeys: new Set(),
  storageKey: null,
  dismiss: (key) =>
    set((s) => {
      if (s.dismissedKeys.has(key)) return s;
      const next = new Set(s.dismissedKeys);
      next.add(key);
      persistDismissedKeys(s.storageKey, next);
      return { dismissedKeys: next };
    }),
  loadForServer: (serverId) => {
    const storageKey = serverId ? dismissedStorageKey(serverId) : null;
    set({
      storageKey,
      dismissedKeys: storageKey ? readDismissedKeys(storageKey) : new Set(),
    });
  },
  reset: () => set({ storageKey: null, dismissedKeys: new Set() }),
}));

function dismissedStorageKey(serverId: string): string {
  return `${STORAGE_PREFIX}:${serverId}`;
}

function readDismissedKeys(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function persistDismissedKeys(storageKey: string | null, keys: Set<string>) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...keys].slice(-MAX_PERSISTED_KEYS)));
  } catch {
    // Dismissal persistence is best-effort; the UI state has already updated.
  }
}
