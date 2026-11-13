import type { ReactNode } from "react";
import { cn } from "@botiverse/raft-ui";
import { MessageListJumpControls } from "@botiverse/raft-ui/wip";
import { ABOVE_AGENT_TYPING_LINE_CLASS } from "./AgentTypingLine";
import { SelectToHerePill } from "./SelectToHerePill";
import type { SelectToHere } from "./useSelectToHere";

/**
 * The jump controls on a message list's bottom edge (raft-ui
 * MessageListJumpControls, message-list.md "Jump controls"): Back to bottom
 * and the unread-thread pill, centred, above the agent typing line and the
 * select-mode toolbar's room (ABOVE_AGENT_TYPING_LINE_CLASS).
 *
 * With `selectToHere` (useSelectToHere), its pill (SelectToHerePill) goes
 * first while the selection's anchor is out of view, at the line's start: the controls
 * then span the list (less their 12px edge) and the rest stays centred in the
 * room beside it. Where the line is too narrow for all of them, the rest wraps
 * onto a line above it (the controls wrap upward), so they never overlap.
 *
 * Always mounted, shown with `hidden`: they sit right after the timeline, and
 * WebKit restyles the timeline's whole subtree when that child list changes.
 * So is the inset probe (`selectToHere.insetProbeRef`): a zero-size mark
 * where the controls' line rests, laid out while they are hidden too, and
 * after the agent typing line like them, so it rises with it.
 */
export function BottomJumpControls({
  selectToHere,
  hidden,
  children,
  "data-testid": testId,
}: {
  selectToHere?: SelectToHere;
  /** Nothing in `children` to show (the pill, when it shows, shows them anyway). */
  hidden: boolean;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const leading = selectToHere?.direction ? <SelectToHerePill selectToHere={selectToHere} /> : null;
  return (
    <>
      <span
        ref={selectToHere?.insetProbeRef}
        aria-hidden="true"
        data-slot="bottom-jump-controls-inset-probe"
        className={cn(
          ABOVE_AGENT_TYPING_LINE_CLASS,
          "pointer-events-none invisible absolute bottom-[var(--message-list-bottom-inset)] left-0 size-0",
        )}
      />
      <MessageListJumpControls
        // Stretched across the list with the pill, the box (and the centred
        // run's) must not take the taps and scrolls meant for the rows under
        // it: only the controls themselves do.
        className={cn(ABOVE_AGENT_TYPING_LINE_CLASS, leading ? "pointer-events-none inset-x-3 mx-0 w-auto max-w-none" : undefined)}
        data-testid={testId}
        hidden={hidden && !leading}
      >
        {leading}
        {/* The centred controls: one element whatever `leading` is, so they never remount. */}
        <div
          data-slot="bottom-jump-controls-main"
          className={cn(
            "flex min-w-fit flex-1 flex-wrap-reverse items-center justify-center gap-x-2 gap-y-3 empty:hidden *:pointer-events-auto",
            leading ? "pointer-events-none" : undefined,
          )}
        >
          {children}
        </div>
      </MessageListJumpControls>
    </>
  );
}
