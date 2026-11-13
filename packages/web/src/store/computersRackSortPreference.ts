import { useSyncExternalStore } from "react";
import { RUNTIME_ACCOUNT_USAGE_PROVIDERS } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";

/**
 * What the Computers overview is sorted by in this browser, and which way
 * (the toolbar's Sort and the list's headings): kept in this browser's
 * localStorage, beside the list / cards choice (computersRackViewPreference).
 * `null` (nothing kept, or a value this build can't read) is the default:
 * no sort, the list's own order, the viewer's computers first
 * (computersRackSort.ts › effectiveRackSort).
 * A runtime is `remaining:<provider>`: what its accounts have left
 * (computersRackSort.ts › rackRemaining), its column's sort too.
 */
export type ComputersRackSortKey = "name" | "disk" | "memory" | `remaining:${RuntimeAccountUsageProvider}`;
export type ComputersRackSortDirection = "asc" | "desc";
export interface ComputersRackSort {
  key: ComputersRackSortKey;
  direction: ComputersRackSortDirection;
}

export const COMPUTERS_RACK_SORT_STORAGE_KEY = "raft_computers_rack_sort";

const listeners = new Set<() => void>();
/** The choice made on this page, which wins while storage refuses to keep it. */
let pageRaw: string | null = null;
let storageFailed = false;
/** The last raw value read and what it parsed to, so a snapshot stays the same object. */
let cached: { raw: string | null; sort: ComputersRackSort | null } = { raw: null, sort: null };

function isSortKey(value: unknown): value is ComputersRackSortKey {
  return value === "name" || value === "disk" || value === "memory"
    || RUNTIME_ACCOUNT_USAGE_PROVIDERS.some((provider) => value === `remaining:${provider}`);
}

function parse(raw: string | null): ComputersRackSort | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { key, direction } = value as Record<string, unknown>;
    if (!isSortKey(key) || (direction !== "asc" && direction !== "desc")) return null;
    return { key, direction };
  } catch {
    // An old or hand-edited value reads as no sort.
    return null;
  }
}

function readRaw(): string | null {
  if (storageFailed) return pageRaw;
  try {
    return window.localStorage.getItem(COMPUTERS_RACK_SORT_STORAGE_KEY);
  } catch {
    return pageRaw;
  }
}

export function readComputersRackSort(): ComputersRackSort | null {
  const raw = readRaw();
  if (raw !== cached.raw) cached = { raw, sort: parse(raw) };
  return cached.sort;
}

/** Keeps `sort`; null goes back to the default (no sort), forgetting the choice. */
export function writeComputersRackSort(sort: ComputersRackSort | null): void {
  pageRaw = sort ? JSON.stringify(sort) : null;
  try {
    if (pageRaw === null) window.localStorage.removeItem(COMPUTERS_RACK_SORT_STORAGE_KEY);
    else window.localStorage.setItem(COMPUTERS_RACK_SORT_STORAGE_KEY, pageRaw);
    storageFailed = false;
  } catch {
    // Storage blocked or full: the choice holds for this page only.
    storageFailed = true;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === COMPUTERS_RACK_SORT_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Tests: forget a choice that storage refused. */
export function resetComputersRackSortForTests(): void {
  pageRaw = null;
  storageFailed = false;
  cached = { raw: null, sort: null };
}

export function useComputersRackSort(): ComputersRackSort | null {
  return useSyncExternalStore(subscribe, readComputersRackSort, () => null);
}
