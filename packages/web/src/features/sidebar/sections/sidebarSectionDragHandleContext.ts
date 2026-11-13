import { createContext } from "react";
import type { useSortable } from "@dnd-kit/sortable";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export interface SidebarSectionDragHandleContextValue {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
}

export const SidebarSectionDragHandleContext = createContext<SidebarSectionDragHandleContextValue | null>(null);
// Stryker restore all
