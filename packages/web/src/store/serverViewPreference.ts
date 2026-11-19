import { useCallback, useSyncExternalStore } from "react";

/**
 * A view choice kept per server in this browser's localStorage (the Members
 * page's tab and Agents grouping): createLocalViewPreference, keyed
 * `<storagePrefix><serverId>`. Read on every render through
 * useSyncExternalStore, followed across tabs by the `storage` event, and held
 * for the page alone when storage refuses it (blocked or full). A stored
 * value that is not one of `values` reads as `fallback`; so does a server not
 * known yet (no id). `legacyKey`, a browser-wide key an earlier build kept the
 * choice under, is read for a server with no choice of its own yet.
 */
export interface ServerViewPreference<T extends string> {
  readonly storagePrefix: string;
  storageKey: (serverId: string) => string;
  read: (serverId: string | null | undefined) => T;
  write: (serverId: string | null | undefined, value: T) => void;
  useValue: (serverId: string | null | undefined) => T;
  /** Tests: forget the choices that storage refused. */
  resetForTests: () => void;
}

export function createServerViewPreference<T extends string>({ storagePrefix, values, fallback, legacyKey }: {
  storagePrefix: string;
  values: readonly T[];
  fallback: T;
  legacyKey?: string;
}): ServerViewPreference<T> {
  const listeners = new Set<() => void>();
  /** The choices made on this page, which win while storage refuses to keep them. */
  const pageValues = new Map<string, T>();

  const storageKey = (serverId: string) => storagePrefix + serverId;
  const parse = (raw: string | null): T | null => values.find((value) => value === raw) ?? null;

  const read = (serverId: string | null | undefined): T => {
    if (!serverId) return fallback;
    const pageValue = pageValues.get(serverId);
    if (pageValue !== undefined) return pageValue;
    try {
      const stored = parse(window.localStorage.getItem(storageKey(serverId)));
      if (stored !== null) return stored;
      return (legacyKey ? parse(window.localStorage.getItem(legacyKey)) : null) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const write = (serverId: string | null | undefined, value: T): void => {
    if (!serverId) return;
    try {
      window.localStorage.setItem(storageKey(serverId), value);
      pageValues.delete(serverId);
    } catch {
      // Storage blocked or full: the choice holds for this page only.
      pageValues.set(serverId, value);
    }
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(storagePrefix) || event.key === legacyKey) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };

  return {
    storagePrefix,
    storageKey,
    read,
    write,
    useValue: function useServerViewPreferenceValue(serverId) {
      const getSnapshot = useCallback(() => read(serverId), [serverId]);
      return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
    },
    resetForTests: () => pageValues.clear(),
  };
}
