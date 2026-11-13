import { useSyncExternalStore } from "react";
import { clampColumnWidth, COLUMN_BOUNDS } from "../lib/panelBounds";
import type { ColumnId } from "../lib/panelBounds";

/**
 * Remembered column widths (task #139), one value per column kind in lib/panelBounds.ts.
 *
 * - Persisted to localStorage, so a width is per browser profile (not per account or server).
 * - Every reader of a column sees the same value, live: dragging the sidebar on Members is the width Chat shows,
 *   and another tab picks the change up through the `storage` event.
 * - A stored value outside the bounds is clamped into them on read, never reset to the default.
 * - Keys earlier builds wrote for the same column are read as a fallback and moved to the column's key once.
 * - `previewColumnWidth` updates the value while a drag is in progress without writing storage;
 *   `commitColumnWidth` (drag end, keyboard, double click) writes it.
 */

const widths = new Map<ColumnId, number>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseStoredWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The stored value for a column: its own key, else the first key an earlier build wrote for it. Never writes. */
function readStoredValue(store: Storage, column: ColumnId): number | null {
  const { storageKey, legacyStorageKeys } = COLUMN_BOUNDS[column];
  const own = parseStoredWidth(store.getItem(storageKey));
  if (own !== null) return own;
  for (const legacyKey of legacyStorageKeys) {
    const legacy = parseStoredWidth(store.getItem(legacyKey));
    if (legacy !== null) return legacy;
  }
  return null;
}

function readStoredWidth(column: ColumnId): number {
  const { defaultWidth } = COLUMN_BOUNDS[column];
  const store = storage();
  if (!store) return defaultWidth;
  try {
    const stored = readStoredValue(store, column);
    return stored === null ? defaultWidth : clampColumnWidth(column, stored);
  } catch {
    return defaultWidth;
  }
}

let legacyKeysMigrated = false;

/**
 * Moves widths earlier builds kept under other keys (`legacyStorageKeys`) to the column's own key, once per page
 * load, when the first component subscribes: reads stay side-effect free. The value read is unchanged by it.
 * Remove `legacyStorageKeys` and this step after 2027-01-31 (about three months after task #139 shipped); anyone
 * who has not opened Raft since then starts from the defaults.
 */
function migrateLegacyKeys(): void {
  if (legacyKeysMigrated) return;
  legacyKeysMigrated = true;
  const store = storage();
  if (!store) return;
  try {
    for (const column of Object.keys(COLUMN_BOUNDS) as ColumnId[]) {
      const { storageKey, legacyStorageKeys } = COLUMN_BOUNDS[column];
      if (legacyStorageKeys.length === 0) continue;
      const stored = readStoredValue(store, column);
      if (stored !== null && store.getItem(storageKey) === null) {
        store.setItem(storageKey, String(clampColumnWidth(column, stored)));
      }
      for (const legacyKey of legacyStorageKeys) store.removeItem(legacyKey);
    }
  } catch {
    // Storage unavailable: nothing to move.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getColumnWidth(column: ColumnId): number {
  let width = widths.get(column);
  if (width === undefined) {
    width = readStoredWidth(column);
    widths.set(column, width);
  }
  return width;
}

function setWidth(column: ColumnId, width: number): number {
  const next = clampColumnWidth(column, width);
  if (widths.get(column) !== next) {
    widths.set(column, next);
    emit();
  }
  return next;
}

/** Live width during a drag; not persisted until `commitColumnWidth`. */
export function previewColumnWidth(column: ColumnId, width: number): void {
  setWidth(column, width);
}

/** Sets (clamped) and persists a column's width. */
export function commitColumnWidth(column: ColumnId, width: number = getColumnWidth(column)): void {
  const next = setWidth(column, width);
  try {
    storage()?.setItem(COLUMN_BOUNDS[column].storageKey, String(next));
  } catch {
    // Storage unavailable: the width still applies for this session.
  }
}

export function resetColumnWidth(column: ColumnId): void {
  commitColumnWidth(column, COLUMN_BOUNDS[column].defaultWidth);
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== storage()) return;
  // `key === null` is localStorage.clear() in another tab.
  const columns = (Object.keys(COLUMN_BOUNDS) as ColumnId[])
    .filter((column) => event.key === null || COLUMN_BOUNDS[column].storageKey === event.key);
  if (columns.length === 0) return;
  for (const column of columns) widths.delete(column);
  emit();
}

function subscribe(listener: () => void): () => void {
  migrateLegacyKeys();
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** The remembered width of a column, shared by every component that shows it. */
export function useColumnWidth(column: ColumnId): number {
  return useSyncExternalStore(
    subscribe,
    () => getColumnWidth(column),
    () => COLUMN_BOUNDS[column].defaultWidth,
  );
}

/** Tests only: forget the in-memory widths so the next read goes back to storage. */
export function resetColumnWidthStoreForTest(): void {
  widths.clear();
  legacyKeysMigrated = false;
  emit();
}
