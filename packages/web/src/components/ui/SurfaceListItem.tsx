import type { HTMLAttributes, ReactNode } from "react";
import { Card } from "@botiverse/raft-ui";

/** An item on its own card surface (raft-ui Card: the card fill, a hairline,
 *  the container radius, no shadow): a reminder, a connected app, a form, the
 *  channel files card. A list ROW is not this — rows are raft-ui `ListRow`
 *  inside a `ListRowGroup` (Raft Design System › ListRow `rf-list--inset`).
 *  Content, so no ink line and no lift; an interactive card lays the pressed
 *  wash on hover and press, and a selected one is the cyan-soft selection. */
export default function SurfaceListItem({
  children,
  selected = false,
  interactive = true,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  selected?: boolean;
  interactive?: boolean;
}) {
  return (
    <Card
      variant="default"
      className={[
        "min-w-0 w-full px-4 py-3 transition-colors",
        selected ? "bg-info-soft" : "bg-layer-card",
        interactive && !selected ? "hover:overlay-subtle active:overlay-medium" : "",
        className,
      ].join(" ")}
      {...props}
      data-selected={selected ? "true" : undefined}
    >
      {children}
    </Card>
  );
}
