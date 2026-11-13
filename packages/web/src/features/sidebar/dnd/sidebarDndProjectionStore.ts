import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type { SidebarDndProjection } from "../../../components/layout/sidebarDnd";

// Stryker disable all: the live drag projection is exercised by tests/sidebarDragRenders.behavior.test.tsx (removed in the 2026-11 web DOM test prune) and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * The live drag projection (which rows each section shows while a row is
 * held), one store per Sidebar. It changes on each change of the row under
 * the pointer; as Sidebar state it re-rendered the whole Sidebar (every
 * section's head and controls, every row wrapper) each time. Each section subscribes to its own container instead, so a
 * move re-renders only the sections whose rows it changes
 * (`moveSidebarDndItem` keeps every other container's array).
 */
export type SidebarDndProjectionStore = StoreApi<{ projection: SidebarDndProjection | null }>;

const EMPTY_ITEM_IDS: string[] = [];

export function createSidebarDndProjectionStore(): SidebarDndProjectionStore {
  return createStore<{ projection: SidebarDndProjection | null }>(() => ({ projection: null }));
}

/** The projection while a row is held, null otherwise. */
export function useSidebarDndProjection(store: SidebarDndProjectionStore): SidebarDndProjection | null {
  return useStore(store, (state) => state.projection);
}

/** The row ids a container shows: the drag's projection while a row is held, else `baseItemIds`. */
export function useSidebarDndProjectedItemIds(
  store: SidebarDndProjectionStore,
  containerId: string,
  baseItemIds: string[],
): string[] {
  return useStore(store, (state) => projectedItemIds(state.projection, containerId, baseItemIds));
}

/** How many rows a container shows (re-renders only when the number changes). */
export function useSidebarDndProjectedCount(
  store: SidebarDndProjectionStore,
  containerId: string,
  baseItemIds: string[],
): number {
  return useStore(store, (state) => projectedItemIds(state.projection, containerId, baseItemIds).length);
}

function projectedItemIds(projection: SidebarDndProjection | null, containerId: string, baseItemIds: string[]): string[] {
  return projection ? projection[containerId] ?? EMPTY_ITEM_IDS : baseItemIds;
}
// Stryker restore all
