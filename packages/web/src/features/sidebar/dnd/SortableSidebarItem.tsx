import { useMemo } from "react";
import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidebarDndItemData } from "../../../components/layout/sidebarDnd";
import { getSidebarDragItemTransform } from "./sidebarDragTransform";

const SORTABLE_DRAG_DISABLED = { draggable: true, droppable: false };

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function SortableSidebarItem({
  id,
  containerId,
  dragDisabled = false,
  children,
}: {
  id: string;
  containerId: string;
  /**
   * Not picked up (an Agent Lounge row), but still a place others drop
   * beside; no drag handle semantics (role, tab stop) either.
   */
  dragDisabled?: boolean;
  children: ReactNode;
}) {
  const data = useMemo<SidebarDndItemData>(
    () => ({ type: "item", itemId: id, containerId }),
    [containerId, id],
  );
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data, disabled: dragDisabled ? SORTABLE_DRAG_DISABLED : false });
  const style = {
    transform: CSS.Transform.toString(getSidebarDragItemTransform(transform, true)),
    transition,
    opacity: isDragging ? 0.12 : 1,
    zIndex: isDragging ? "var(--z-index-raised)" : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(dragDisabled ? undefined : attributes)}
      {...(dragDisabled ? undefined : listeners)}
      data-sidebar-drag-item={id}
      className={dragDisabled ? "relative" : "relative cursor-grab active:cursor-grabbing"}
    >
      {children}
    </div>
  );
}
// Stryker restore all
