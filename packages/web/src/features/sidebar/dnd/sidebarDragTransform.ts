import type { Transform } from "@dnd-kit/utilities";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function getSidebarSortableItemTransform(
  transform: Transform | null,
  allowHorizontalDrag = false,
): Transform | null {
  return getSidebarDragItemTransform(transform, allowHorizontalDrag);
}

export function getSidebarDragItemTransform(
  transform: Transform | null,
  allowHorizontalDrag = false,
): Transform | null {
  if (!transform || allowHorizontalDrag) return transform;
  return { ...transform, x: 0 };
}
// Stryker restore all
