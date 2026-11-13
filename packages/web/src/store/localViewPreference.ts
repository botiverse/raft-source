import { useSyncExternalStore } from "react";

/**
 * A view choice kept in this browser's localStorage (the Computers overview's
 * grid / list, the Members page's Agents grouping): read on every render
 * through useSyncExternalStore, followed across tabs by the `storage` event,
 * and held for the page alone when storage refuses it (blocked or full).
 * A stored value that is not one of `values` reads as `fallback`.
 */
export interface LocalViewPreference<T extends string> {
  readonly storageKey: string;
  read: () => T;
  write: (value: T) => void;
  useValue: () => T;
  /** Tests: forget a choice that storage refused. */
  resetForTests: () => void;
}

export function createLocalViewPreference<T extends string>({ storageKey, values, fallback }: {
  storageKey: string;
  values: readonly T[];
  fallback: T;
}): LocalViewPreference<T> {
  const listeners = new Set<() => void>();
  /** The choice made on this page, which wins while storage refuses to keep it. */
  let pageValue: T = fallback;
  let storageFailed = false;

  const parse = (raw: string | null): T => values.find((value) => value === raw) ?? fallback;

  const read = (): T => {
    if (storageFailed) return pageValue;
    try {
      return parse(window.localStorage.getItem(storageKey));
    } catch {
      return pageValue;
    }
  };

  const write = (value: T): void => {
    pageValue = value;
    try {
      window.localStorage.setItem(storageKey, value);
      storageFailed = false;
    } catch {
      // Storage blocked or full: the choice holds for this page only.
      storageFailed = true;
    }
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };

  return {
    storageKey,
    read,
    write,
    useValue: () => useSyncExternalStore(subscribe, read, () => fallback),
    resetForTests: () => {
      pageValue = fallback;
      storageFailed = false;
    },
  };
}
