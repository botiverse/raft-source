import { useLayoutEffect, useEffectEvent } from "react";
import { useDndContext } from "@dnd-kit/core";
import { useSidebarDndProjection } from "./sidebarDndProjectionStore";
import type { SidebarDndProjectionStore } from "./sidebarDndProjectionStore";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// Cross-container projection moves later drop zones without resizing them.
// Always permits measuring, but dnd-kit's resize observers do not invalidate
// those unchanged-size siblings. Remeasure after the projected DOM commits.
export function SidebarDndProjectionMeasurements({ store }: { store: SidebarDndProjectionStore }) {
  const projection = useSidebarDndProjection(store);
  const { droppableContainers, measureDroppableContainers } = useDndContext();
  const measureProjection = useEffectEvent(() => {
    // Explicit IDs also include siblings when dnd-kit already has a partial
    // resize measurement queued (an empty all-IDs request would be merged away).
    measureDroppableContainers([...droppableContainers.keys()]);
  });
  useLayoutEffect(() => {
    if (projection) measureProjection();
  }, [projection]);
  return null;
}
// Stryker restore all
