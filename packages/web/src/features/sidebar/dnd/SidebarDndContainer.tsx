import { useCallback, useLayoutEffect, useRef, useMemo } from "react";
import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  isSidebarDndData,
  nextSidebarDndReservedHeight,
  sidebarDndNeedsReservedHeightMeasure,
} from "../../../components/layout/sidebarDnd";
import type { SidebarDndContainerData } from "../../../components/layout/sidebarDnd";
import { SIDEBAR_SECTION_EMPTY_ROWS_CLASS, SIDEBAR_SECTION_ROWS_CLASS } from "../rows/sidebarRowClasses";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
const SIDEBAR_DND_OVER_FILL_CLASS = "before:pointer-events-none before:absolute before:inset-y-0 before:left-2 before:right-2 before:z-below before:rounded-control before:bg-fill-medium";

export function SidebarDndContainer({
  id,
  kind,
  manual,
  itemIds,
  children,
  empty,
}: {
  id: string;
  kind: SidebarDndContainerData["kind"];
  manual: boolean;
  itemIds: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  const data = useMemo<SidebarDndContainerData>(
    () => ({ type: "container", containerId: id, kind, manual }),
    [id, kind, manual],
  );
  const { setNodeRef, isOver, active } = useDroppable({ id, data });
  const activeData = active?.data.current;
  const itemDragActive = isSidebarDndData(activeData) && activeData.type === "item";
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const reservedHeightRef = useRef<number | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);
  // Never let a drop zone shrink while an item drag is in flight (see
  // nextSidebarDndReservedHeight): projecting the row into/out of this
  // container must not move the pointer onto a different container. Runs after
  // every render, before dnd-kit's (parent) measuring effects read the rect.
  // Written straight to the node so reserving height never re-renders.
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // No drag and nothing reserved: the answer is "none" without measuring.
    // Measuring here forced a full layout after every sidebar render (the
    // largest single cost of a heavy account's boot, web perf).
    if (!sidebarDndNeedsReservedHeightMeasure(itemDragActive, reservedHeightRef.current)) return;
    const next = nextSidebarDndReservedHeight(
      itemDragActive,
      reservedHeightRef.current,
      node.getBoundingClientRect().height,
    );
    if (next === reservedHeightRef.current) return;
    reservedHeightRef.current = next;
    node.style.minHeight = next === null ? "" : `${next}px`;
  });
  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <div
        ref={setContainerRef}
        data-sidebar-dnd-container={id}
        // A section's rows are a list of cells (raft-ui SidebarList's column):
        // 2px apart, 8px at its ends, so 8px under the section's heading.
        // The 8px strips stay in the drop zone (a row dropped there is placed
        // by the pointer: sidebarDndContainerDropIndex). Its drop fill is a
        // cell's shape, 8px in from the sides, under the rows (isolate keeps
        // the z-below inside the zone).
        className={`relative isolate ${SIDEBAR_SECTION_ROWS_CLASS} ${empty ? SIDEBAR_SECTION_EMPTY_ROWS_CLASS : ""} ${isOver ? SIDEBAR_DND_OVER_FILL_CLASS : ""}`}
      >
        {children}
      </div>
    </SortableContext>
  );
}
// Stryker restore all
