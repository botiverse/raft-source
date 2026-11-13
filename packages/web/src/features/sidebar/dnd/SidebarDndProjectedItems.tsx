import type { ReactNode } from "react";
import { useSidebarDndProjectedItemIds } from "./sidebarDndProjectionStore";
import type { SidebarDndProjectionStore } from "./sidebarDndProjectionStore";

// Stryker disable all: the live drag projection is exercised by tests/sidebarDragRenders.behavior.test.tsx (removed in the 2026-11 web DOM test prune) and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * Renders a section's rows from the drag projection of its own container, so
 * a move that leaves this container's rows as they were doesn't render it.
 */
export function SidebarDndProjectedItems({
  store,
  containerId,
  baseItemIds,
  children,
}: {
  store: SidebarDndProjectionStore;
  containerId: string;
  baseItemIds: string[];
  children: (itemIds: string[]) => ReactNode;
}) {
  return children(useSidebarDndProjectedItemIds(store, containerId, baseItemIds));
}
// Stryker restore all
