import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

import { resetColumnAfter, startSeamDrag } from "../ui/rowSeams";
import type { SeamDrag } from "../ui/rowSeams";

/**
 * A crossing being hovered or dragged lights the seams that meet there: `column`'s StackSeam `seam` (ChannelSideArea)
 * and the left seam of column `edge`, that column's own (a crossing at its left) or the next one's (at its right).
 */
export const useSideHighlight = create<{ column: number | null; seam: number | null; edge: number | null; state: "hover" | "drag" | undefined }>(() => ({ column: null, seam: null, edge: null, state: undefined }));

const NO_HIGHLIGHT = { column: null, seam: null, edge: null, state: undefined } as const;

/** Which side of the column a crossing is on: its left seam, or its right one, the next column's left seam. */
export type CornerEdge = "left" | "right";

/** The split a corner drags with the column's width (ChannelSideArea `useStack`). */
interface CornerStack {
  start: (seam: number, y: number) => void;
  move: (y: number) => void;
  end: () => void;
  reset: () => void;
}

/** What StackCorner needs: its handlers, and where its drag lights the seams. */
export interface StackCornerDrag {
  start: (seam: number, edge: CornerEdge) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  move: (event: ReactPointerEvent<HTMLDivElement>) => void;
  end: () => void;
  reset: (edge: CornerEdge) => void;
  hover: (seam: number, edge: CornerEdge, on: boolean) => void;
}

/**
 * The crossing of a column's left or right seam with a seam between the sections stacked in it (StackCorner): one
 * drag moves both, the seam by the row's seam drag (rowSeams, as the resize handle on it: the column's own at its
 * left, the next column's at its right) and the split; a double click resets both (`resetWidth` at the left, the next
 * column's default width at the right). `column`: the side layout's column it lights (useSideHighlight); `after`: the
 * one right of it (useColumnAfter), whose left seam a crossing at the right lights; `element`: the column; `main`: the
 * row's conversation for it (ChannelSideArea `rowMainColumn`). An ordinary side column's and the thread's column's alike.
 */
export function useStackCorner(column: number | undefined, after: number | null, element: () => HTMLElement | null, main: (column: HTMLElement) => HTMLElement | null, stack: CornerStack, resetWidth: () => void): StackCornerDrag {
  const ref = useRef<{ x: number; seam: SeamDrag | null } | null>(null);
  const { start: stackStart, move: stackMove, end: stackEnd, reset: stackReset } = stack;
  return useMemo<StackCornerDrag>(() => {
    // The seams a crossing lights: the split, and the left seam of this column (at its left) or the next (its right).
    const lit = (seam: number, edge: CornerEdge) => ({ column: column ?? null, seam, edge: edge === "left" ? column ?? null : after });
    return {
      start: (seam, edge) => (event) => {
        const columnElement = element();
        if (!columnElement || event.button > 0) return;
        event.preventDefault();
        ref.current = { x: event.clientX, seam: startSeamDrag(columnElement, edge, main(columnElement)) };
        stackStart(seam, event.clientY);
        useSideHighlight.setState({ ...lit(seam, edge), state: "drag" });
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      move: (event) => {
        const drag = ref.current;
        if (!drag) return;
        stackMove(event.clientY);
        drag.seam?.move(event.clientX - drag.x);
      },
      end: () => {
        const drag = ref.current;
        if (!drag) return;
        ref.current = null;
        drag.seam?.release();
        stackEnd();
        useSideHighlight.setState(NO_HIGHLIGHT);
      },
      reset: (edge) => {
        stackReset();
        if (edge === "left") resetWidth();
        else resetColumnAfter(element());
      },
      hover: (seam, edge, on) => {
        if (ref.current) return;
        useSideHighlight.setState(on ? { ...lit(seam, edge), state: "hover" } : NO_HIGHLIGHT);
      },
    };
  }, [after, column, element, main, resetWidth, stackEnd, stackMove, stackReset, stackStart]);
}
