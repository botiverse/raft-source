import { useCallback, useRef } from "react";
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@botiverse/raft-ui";
import type { TooltipProps } from "@botiverse/raft-ui";

type OpenChange = NonNullable<TooltipProps["onOpenChange"]>;

/**
 * A toolbar button's name in a tooltip only while its words are hidden
 * (Raft DS › Button: an icon-only button has a tooltip with its name; a button
 * that shows its words needs none). For a row whose words give way
 * (useIconsOnlyWhenWrapped): the words are marked `data-toolbar-label`, and the
 * tooltip opens only while there are some and none is on screen, as raft-ui's
 * SegmentedControl does for its segments. A set filter that keeps its value
 * shows its words, so it gets none.
 */
export function ToolbarLabelTooltip({ label, children }: { label: string; children: ReactElement }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openChange = useCallback<OpenChange>((open, details) => {
    if (!open) return;
    const words = Array.from(triggerRef.current?.querySelectorAll("[data-toolbar-label]") ?? []);
    if (words.length === 0 || words.some((word) => word.getBoundingClientRect().width > 1)) details.cancel();
  }, []);
  return (
    <Tooltip onOpenChange={openChange}>
      <TooltipTrigger ref={triggerRef} render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
