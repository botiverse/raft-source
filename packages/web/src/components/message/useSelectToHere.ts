import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useSelectionStore } from "../../store/selectionStore";
import type { MessageTimelineHandle } from "./MessageTimeline";
import { idsToViewportEdge, rangeSelectablePredicate } from "./messageRangeSelection";

export type SelectToHereDirection = "up" | "down";

export interface SelectToHere {
  /** Where the anchor is from the view while it is out of it (the pill's arrow); null: no pill. */
  direction: SelectToHereDirection | null;
  /** The pill's tap: every selectable message from the anchor to the view's far edge; that one is the next anchor. */
  select: () => void;
  /** The timeline's `onViewportChange`: what is in view may have changed. */
  onViewportChange: () => void;
  /**
   * On BottomJumpControls' inset probe: where the controls' line rests, i.e.
   * what of the list's bottom is covered (the toolbar's room with the home
   * indicator, the agent typing line), read when the view is.
   */
  insetProbeRef: RefObject<HTMLSpanElement | null>;
}

/** The covered bottom of the list, in px: from the probe's containing block's bottom to the probe. */
function coveredBottom(probe: HTMLElement | null): number {
  const container = probe?.offsetParent;
  if (!probe || !container) return 0;
  return Math.max(0, container.getBoundingClientRect().bottom - probe.getBoundingClientRect().bottom);
}

/**
 * Select to here (task #235, the WeChat pattern), for the surface that owns a
 * timeline (ChatPanel, the thread's replies): while select mode is on there
 * (`active`) and its anchor (the message last added) is scrolled out of view,
 * `direction` says which way it is, and the surface shows SelectToHerePill in
 * its BottomJumpControls. `select` adds every selectable message from the
 * anchor to the edge of the view furthest from it (idsToViewportEdge).
 *
 * The anchor is the selection store's; what is in view is the timeline's
 * (MessageTimelineHandle). On every view change only the anchor's position is
 * read (one row's offsets), at most once a frame; the range only on a tap.
 * The surface passes `onViewportChange` to its MessageTimeline, so a timeline
 * that remounts (a context window swapped in, loading again) keeps reporting.
 */
export function useSelectToHere({
  timelineRef,
  active,
  selectableIds,
}: {
  timelineRef: RefObject<MessageTimelineHandle | null>;
  /** Select mode is on in this surface's timeline, with its floating toolbar. */
  active: boolean;
  /** What a range takes here (a thread: its select-all's ids); default isRangeSelectableMessage. */
  selectableIds?: readonly string[];
}): SelectToHere {
  const anchorId = useSelectionStore((s) => (active && s.isActive ? s.anchorId : null));
  const activeRef = useRef(active);
  activeRef.current = active;
  const isSelectable = useMemo(() => rangeSelectablePredicate(selectableIds), [selectableIds]);
  const isSelectableRef = useRef(isSelectable);
  isSelectableRef.current = isSelectable;
  const insetProbeRef = useRef<HTMLSpanElement>(null);

  // Read for one anchor: a new anchor (or none) shows nothing until read for it.
  const [seen, setSeen] = useState<{ anchorId: string; direction: SelectToHereDirection | null } | null>(null);
  const direction = anchorId && seen?.anchorId === anchorId ? seen.direction : null;

  const frameRef = useRef(0);
  const read = useCallback(() => {
    frameRef.current = 0;
    const { isActive, anchorId: anchor } = useSelectionStore.getState();
    if (!activeRef.current || !isActive || !anchor) return;
    const position = timelineRef.current?.getMessageViewportPosition(anchor, {
      bottomOcclusion: coveredBottom(insetProbeRef.current),
    }) ?? null;
    const next = position === "above" ? "up" : position === "below" ? "down" : null;
    setSeen((prev) => (prev?.anchorId === anchor && prev.direction === next ? prev : { anchorId: anchor, direction: next }));
  }, [timelineRef]);
  const onViewportChange = useCallback(() => {
    // Outside select mode here there is nothing to read: no frame.
    if (!activeRef.current || frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(read);
  }, [read]);
  // A new anchor is read in the next frame, as a view change is.
  useEffect(() => {
    if (!active) return undefined;
    onViewportChange();
    return useSelectionStore.subscribe((state, prev) => {
      if (state.anchorId !== prev.anchorId || state.isActive !== prev.isActive) onViewportChange();
    });
  }, [active, onViewportChange]);
  useEffect(() => () => {
    if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
  }, []);

  const select = useCallback(() => {
    const handle = timelineRef.current;
    const anchor = useSelectionStore.getState().anchorId;
    if (!handle || !anchor) return;
    const messages = handle.getMessages();
    const byId = new Map(messages.map((message) => [message.id, message]));
    const range = idsToViewportEdge(
      messages.map((message) => message.id),
      anchor,
      handle.getVisibleMessageIds({ bottomOcclusion: coveredBottom(insetProbeRef.current) }),
      (id) => {
        const message = byId.get(id);
        return !!message && isSelectableRef.current(message);
      },
    );
    if (range) useSelectionStore.getState().selectRange(range.ids, range.edgeId);
  }, [timelineRef]);

  return useMemo(
    () => ({ direction, select, onViewportChange, insetProbeRef }),
    [direction, onViewportChange, select],
  );
}
