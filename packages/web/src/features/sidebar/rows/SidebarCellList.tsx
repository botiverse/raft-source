import type { HTMLAttributes } from "react";

// A list of sidebar rows outside a collapsible section (raft-ui SidebarList is
// a section's panel): the same column, 2px between the rows' shapes and 8px
// at its ends, so 8px under a heading (raft-design patterns/lists.md).
// The boot frame's skeleton (PendingServerLayout) sits in one too, so the
// loaded rows replace it without moving.
export function SidebarCellList({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className="flex flex-col gap-0.5 py-2">{children}</div>;
}
