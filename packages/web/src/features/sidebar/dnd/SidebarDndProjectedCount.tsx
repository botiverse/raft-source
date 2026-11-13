import type { ReactNode } from "react";
import { useSidebarDndProjectedCount } from "./sidebarDndProjectionStore";
import type { SidebarDndProjectionStore } from "./sidebarDndProjectionStore";

// Stryker disable all: the live drag projection is exercised by tests/sidebarDragRenders.behavior.test.tsx (removed in the 2026-11 web DOM test prune) and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * Renders a section (its visibility and its head's count) from the number of
 * rows the drag projection gives its container: a reorder inside a section,
 * or a move between two others, doesn't render it.
 */
export function SidebarDndProjectedCount({
  store,
  containerId,
  baseItemIds,
  children,
}: {
  store: SidebarDndProjectionStore;
  containerId: string;
  baseItemIds: string[];
  children: (count: number) => ReactNode;
}) {
  return children(useSidebarDndProjectedCount(store, containerId, baseItemIds));
}
// Stryker restore all
