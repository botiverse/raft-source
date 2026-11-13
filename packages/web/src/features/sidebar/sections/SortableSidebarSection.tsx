import { useMemo } from "react";
import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getSidebarSortableItemTransform } from "../dnd/sidebarDragTransform";
import { SidebarSectionDragHandleContext } from "./sidebarSectionDragHandleContext";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function SortableSidebarSection({
  id,
  testId,
  order,
  children,
}: {
  id: string;
  testId: string;
  order: number;
  children: ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(getSidebarSortableItemTransform(transform)),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? "var(--z-index-raised)" : undefined,
    order,
  };
  const dragHandle = useMemo(
    () => ({ attributes, listeners, setActivatorNodeRef }),
    [attributes, listeners, setActivatorNodeRef],
  );

  return (
    <SidebarSectionDragHandleContext.Provider value={dragHandle}>
      <div ref={setNodeRef} style={style} data-testid={testId}>
        {children}
      </div>
    </SidebarSectionDragHandleContext.Provider>
  );
}
// Stryker restore all
