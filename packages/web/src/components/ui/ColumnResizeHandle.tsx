import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useIntl } from "react-intl";
import { clampColumnWidth, COLUMN_BOUNDS, growToMainMinMax } from "../../lib/panelBounds";
import type { ColumnBounds, ColumnId } from "../../lib/panelBounds";
import { dragStep, releasedDragWidth } from "./columnDragRoom";
import { markClipped, registerSeamColumn, startSeamDrag } from "./rowSeams";
import type { SeamColumnEntry, SeamDrag } from "./rowSeams";
import { useDomMeasureEffect } from "../../hooks/effectPrimitives";
import {
  commitColumnWidth,
  getColumnWidth,
  previewColumnWidth,
  resetColumnWidth,
  useColumnWidth,
} from "../../store/columnWidthStore";

/** Arrow keys move the seam by this much; with Shift, by `KEYBOARD_STEP_LARGE`. */
export const KEYBOARD_STEP = 16;
export const KEYBOARD_STEP_LARGE = 64;
/**
 * A pointer drag this far past the end of a column's range snaps it to its next state (DS Resizable, "Dragging past
 * the end"): far enough that a drag which only reaches the end does not snap by accident.
 */
export const SNAP_PAST_END = 40;

// Tailwind only sees literal class names, so these are lookups rather than interpolated prefixes.
const EDGE_CLASS = {
  // The column's own right border is the seam: the handle lies wholly past it, over the start of the next column,
  // and its line on the pixel left of the boundary. Not centered on it: this column's scrollbar runs along that
  // border, and a handle over it took the thumb's drag (DS Resizable).
  right: "-right-3 pointer-coarse:-right-6 before:-left-px",
  // The column's own left border is the seam: the handle lies inside this column, its line on the pixel right of
  // the boundary, off the scrollbar of the column before it.
  left: "left-0 before:left-0",
} as const;

// The column draws that border itself (`ownBorder`): the handle is placed from inside it, so it stands its 1px
// further out and the line lies on the border, as everywhere else, rather than beside it (2px on hover).
const OWN_BORDER_EDGE_CLASS = {
  right: "-right-[13px] pointer-coarse:-right-[25px] before:-left-px",
  left: "-left-px before:left-0",
} as const;

// On a seam (DS Resizable): nothing at rest, a 1px foreground-muted line on hover and drag, 2px foreground on
// keyboard focus. `highlight` lights it the same way from elsewhere: the crossing of two seams (the Task v2 side
// sections), where one drag moves both.
const SEAM_CLASS = "before:inset-y-0 before:w-px hover:before:bg-foreground-muted data-[dragging=true]:before:bg-foreground-muted data-[highlight]:before:bg-foreground-muted focus-visible:keyboard:before:w-0.5 focus-visible:keyboard:before:bg-foreground";

const VISIBLE_FROM_CLASS = {
  sm: "hidden sm:block",
  md: "hidden md:block",
  lg: "hidden lg:block",
} as const;

const LABEL_ID = {
  sidebar: "layout.columnResize.sidebar",
  list: "layout.columnResize.list",
  thread: "layout.columnResize.thread",
  detail: "layout.columnResize.detail",
  workspaceTree: "layout.columnResize.workspaceTree",
  sideCards: "layout.columnResize.sideCards",
} as const satisfies Record<ColumnId, string>;

/**
 * Put on the conversation (the flexible column a `growsToMainMin` column takes its room from): ChatPanel's message
 * column for the side cards, MainLayout's channel column (and the thread, where it takes the channel's place) for the
 * thread and detail columns, the public server page's main slot for its thread.
 */
export const MAIN_COLUMN_ATTRIBUTE = "data-main-column";

function shownWidth(element: Element): number {
  return element.getBoundingClientRect().width;
}

/**
 * The conversation beside a column: the nearest element marked `MAIN_COLUMN_ATTRIBUTE` that shares a row with it,
 * that is a sibling of the column or of one of its ancestors (a `display: contents` wrapper, as the profile's, is
 * such an ancestor) and is on screen. Null when none is (no layout, as in jsdom, or the column covers the row).
 */
export function findMainColumn(columnElement: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = columnElement; node?.parentElement; node = node.parentElement) {
    let found: HTMLElement | null = null;
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || !sibling.hasAttribute(MAIN_COLUMN_ATTRIBUTE)) continue;
      if (shownWidth(sibling) > 0 && (!found || shownWidth(sibling) > shownWidth(found))) found = sibling;
    }
    if (found) return found;
  }
  return null;
}

/** The conversation a column takes its width from: `mainColumn` when given (the column knows it), else found. */
export type MainColumnLookup = (columnElement: HTMLElement) => HTMLElement | null;

/**
 * The widest `column` may be dragged now (task #74). A `growsToMainMin` column grows until the conversation beside
 * it is down to MAIN_COLUMN_MIN_WIDTH; any other column, and one whose conversation cannot be measured, stops at
 * its bounds' max. `maxWidth` tightens it further (ColumnResizeHandle's prop). Never below the column's minimum.
 */
export function columnDragMax(column: ColumnId, columnElement: HTMLElement | null | undefined, maxWidth?: number, mainColumn: MainColumnLookup = findMainColumn): number {
  const bounds: ColumnBounds = COLUMN_BOUNDS[column];
  let max: number = bounds.max;
  if (bounds.growsToMainMin && columnElement) {
    const columnWidth = shownWidth(columnElement);
    const main = columnWidth > 0 ? mainColumn(columnElement) : null;
    if (main) max = growToMainMinMax(column, columnWidth, shownWidth(main));
  }
  return maxWidth === undefined ? max : Math.max(bounds.min, Math.min(max, maxWidth));
}

export interface ColumnResizeHandleProps {
  /** Which column (lib/panelBounds.ts) this handle resizes. */
  column: ColumnId;
  /** The column edge the handle sits on: `right` for a column left of the conversation, `left` for one right of it. */
  edge: keyof typeof EDGE_CLASS;
  /**
   * Breakpoint from which the column's width applies; the handle is not rendered (or focusable) below it. Omit when
   * the caller's own CSS decides (the thread column's container query).
   */
  visibleFrom?: keyof typeof VISIBLE_FROM_CLASS;
  /** A tighter maximum than the column's own for now (Activity's list beside an open item): drags, keys and
   *  `aria-valuemax` stop there. A thread, detail or side cards column's own maximum is what the conversation beside
   *  it can give up down to its 360px (`columnDragMax`), worked out from the layout. */
  maxWidth?: number;
  className?: string;
  /** The handle's accessible name, where the column's own (`layout.columnResize.*`) is not specific enough. */
  label?: string;
  /** Where the width lives, when not in the column table's store (one of several task v2 section columns, whose
   *  widths are the section layout's). `column` still gives the bounds' maximum and how the column grows. */
  source?: ColumnWidthSource;
  /** The conversation this column takes its width from, where the nearest marked sibling is not it (task v2's
   *  Tasks and Files column in the row right of a thread: the channel, not the wider thread). */
  mainColumn?: MainColumnLookup;
  /** Lit from outside, as by a corner handle that drags this edge along with another: as if hovered, or dragged. */
  highlight?: "hover" | "drag";
  /**
   * The column (the handle's parent) draws its edge's 1px border itself, rather than a panel inside it does: the
   * handle is positioned from inside that border, so it is moved out by it, and the hover line covers the border.
   */
  ownBorder?: boolean;
  /**
   * Dragging past the end changes the layout's state instead of stopping (DS Resizable, "Dragging past the end"):
   * `collapse` for a column left of the conversation (40px under its minimum: the sidebar collapses), `focus` for one
   * right of it (40px past its maximum, where the conversation is down to 360px: the thread's Focus Mode). It switches
   * during the drag, and back when the drag returns across the line; the release keeps what shows. Enter toggles it.
   * Omit where the layout has no such state: the side cards and the detail column just stop at their end (Jasper, no
   * new focus modes), as do phones and the public server page; the Tasks page's task, the detail column beside its
   * list, has the thread's Focus Mode (TasksRoute).
   */
  snap?: ColumnSnap;
  "data-testid"?: string;
}

/** A width kept outside the column table's store (ColumnResizeHandle `source`). */
export interface ColumnWidthSource {
  /** The remembered width, as rendered state. */
  width: number;
  /** The narrowest the column may be. */
  min: number;
  /** Its content's minimum: narrower, the column clips it (#189, rule 2). */
  contentMin?: number;
  /** The remembered width now (outside render). */
  get: () => number;
  /** Show `width` while dragging, without saving it. */
  preview: (width: number) => void;
  /** Save the width shown, or `width`. */
  commit: (width?: number) => void;
  /** Back to the default width. */
  reset: () => void;
}

export interface ColumnSnap {
  kind: "collapse" | "focus";
  /** The column is collapsed / in focus mode now. */
  snapped: boolean;
  /** Switch the state; return false where it cannot switch now (the drag then goes on as without `snap`). */
  onSnappedChange: (snapped: boolean, via: "pointer" | "keyboard") => boolean | void;
}

/**
 * The drag handle on the seam between a column and its neighbour (Raft Design System › Resizable). It is the
 * DS ResizableHandle's look and behaviour without react-resizable-panels, whose Group would own the layout these
 * columns already have: 12px wide (24px on a touch screen), centred on the boundary so it takes no room; nothing at
 * rest (the column's own border is the seam), a 1px foreground-muted line on hover and while dragging, a 2px
 * foreground line on keyboard focus. A focusable `separator`: Left/Right move the seam 16px (Shift: 64px),
 * Home/End go to the minimum/maximum, and a double click restores the default width. In MainLayout's row a drag or
 * a key trades width between the two columns beside the seam and cascades further out once one is at its 160
 * (rowSeams, #proj-raft-ui:#189 rule 1), and what shows on release is what every column saves; the column registers
 * itself there, and is marked clipped while narrower than its content (rule 2). Elsewhere it drags its own column
 * alone: for one right of the conversation the maximum leaves the conversation its 360px (`columnDragMax`, task #74),
 * read from the layout when a drag or a key starts and again on release. A drag or a key that does not move the seam
 * saves nothing. With `snap`, a drag 40px past the end collapses the column or puts it in focus mode during the drag, and
 * Enter toggles that (DS Resizable, "Dragging past the end"); the drag then follows the pointer on the window, since
 * snapping can hide the handle.
 *
 * The parent must be the column itself: positioned, not clipping its own edge. Drags, arrow keys and
 * `aria-valuenow` use the parent's rendered width, which can be narrower than the remembered one when the window is
 * narrow; `aria-controls` points at the parent (given an id if it has none).
 */
export default function ColumnResizeHandle({
  column,
  edge,
  visibleFrom,
  maxWidth,
  className = "",
  label,
  source,
  mainColumn = findMainColumn,
  highlight,
  ownBorder = false,
  snap,
  "data-testid": testId,
}: ColumnResizeHandleProps) {
  const { formatMessage } = useIntl();
  const storeWidth = useColumnWidth(column);
  const width = source ? source.width : storeWidth;
  const min = source ? source.min : COLUMN_BOUNDS[column].min;
  const clampWidth = (value: number) => (source ? Math.max(source.min, Math.min(COLUMN_BOUNDS[column].max, value)) : clampColumnWidth(column, value));
  const rememberedWidth = () => (source ? source.get() : getColumnWidth(column));
  const previewWidth = (value: number) => (source ? source.preview(value) : previewColumnWidth(column, value));
  const commitWidth = (value?: number) => (source ? source.commit(value) : commitColumnWidth(column, value));
  const resetWidth = () => (source ? source.reset() : resetColumnWidth(column));
  const contentMin = source ? source.contentMin : (COLUMN_BOUNDS[column] as ColumnBounds).contentMin;
  // How the column keeps its width, for a drag on any seam of the row (rowSeams); read when that drag starts.
  const seamEntry = useRef<SeamColumnEntry | null>(null);
  seamEntry.current = { key: source ? undefined : column, min, get: rememberedWidth, preview: previewWidth, commit: (value) => commitWidth(value), reset: resetWidth };
  const contentMinRef = useRef(contentMin);
  contentMinRef.current = contentMin;
  // Without a layout (and before the first measure), the column's own bounds.
  const staticMax = columnDragMax(column, null, maxWidth);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    max: number;
    /** The remembered width when the drag started: where a snapped column comes back to. */
    restoreWidth: number;
    /** The drag has the column collapsed / in focus mode now. */
    snapped: boolean;
    /** The last width the drag showed beside the conversation; null until it moved the seam. */
    last: number | null;
    /** In MainLayout's row: the trade along it (rowSeams). */
    seam: SeamDrag | null;
  } | null>(null);
  // The drag follows the pointer on the window, not the handle: snapping can hide the handle (thread focus mode) or
  // make it inert (a collapsed sidebar) while the drag is still held.
  const detachDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => detachDrag.current?.(), []);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const fallbackColumnId = useId();
  const [columnElementId, setColumnElementId] = useState<string | undefined>(undefined);
  // The column's width on screen; null until measured (and wherever there is no layout, as in jsdom).
  const [renderedColumnWidth, setRenderedColumnWidth] = useState<number | null>(null);
  // The maximum as of the last measure, for `aria-valuemax`; drags and keys read the layout again when they start.
  const [measuredMax, setMeasuredMax] = useState<number | null>(null);
  useDomMeasureEffect(() => {
    const columnElement = handleRef.current?.parentElement;
    if (!columnElement) return;
    if (!columnElement.id) columnElement.id = fallbackColumnId;
    setColumnElementId(columnElement.id);
    const unregister = registerSeamColumn(columnElement, () => seamEntry.current!);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    // The conversation can change width while the column does not (a window resize), so it is watched too.
    let observedMain: HTMLElement | null = null;
    const measure = () => {
      const measured = shownWidth(columnElement);
      setRenderedColumnWidth(measured > 0 ? Math.round(measured) : null);
      const seam = measured > 0 ? startSeamDrag(columnElement, edge, mainColumn(columnElement)) : null;
      setMeasuredMax(measured > 0 ? seam?.max ?? columnDragMax(column, columnElement, maxWidth, mainColumn) : null);
      markClipped(columnElement, handleRef.current, contentMinRef.current);
      const growsToMainMin = (COLUMN_BOUNDS[column] as ColumnBounds).growsToMainMin === true;
      const main = growsToMainMin && measured > 0 ? mainColumn(columnElement) : null;
      if (observer && main !== observedMain) {
        if (observedMain) observer.unobserve(observedMain);
        if (main) observer.observe(main);
        observedMain = main;
      }
    };
    measure();
    observer?.observe(columnElement);
    return () => {
      observer?.disconnect();
      unregister();
      markClipped(columnElement, null, undefined);
    };
  }, [fallbackColumnId, column, edge, maxWidth, mainColumn]);
  const max = measuredMax ?? staticMax;
  // Moving the pointer right by 1px changes the width by this much.
  const grow = edge === "right" ? 1 : -1;

  const renderedWidth = (handle: HTMLElement) => {
    const measured = handle.parentElement?.getBoundingClientRect().width;
    return clampWidth(measured && measured > 0 ? measured : rememberedWidth());
  };
  const maxNow = (handle: HTMLElement) => columnDragMax(column, handle.parentElement, maxWidth, mainColumn);
  const rowSeam = (handle: HTMLElement) => (handle.parentElement ? startSeamDrag(handle.parentElement, edge, mainColumn(handle.parentElement)) : null);

  const setSnapped = (next: boolean, via: "pointer" | "keyboard"): boolean => {
    const current = snapRef.current;
    if (!current) return false;
    return current.onSnappedChange(next, via) !== false;
  };
  const moveDrag = (clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Where the seam would be with no end to the range.
    const reach = drag.startWidth + grow * (clientX - drag.startX);
    const kind = snapRef.current?.kind;
    const past = kind === "focus" ? reach > drag.max + SNAP_PAST_END : kind === "collapse" ? reach < min - SNAP_PAST_END : false;
    if (past !== drag.snapped && setSnapped(past, "pointer")) drag.snapped = past;
    // Snapped, the column keeps the width it had before the drag (shown again when it comes back); in the row, every column does.
    if (drag.snapped) {
      if (drag.seam) drag.seam.restore();
      else previewWidth(drag.restoreWidth);
      return;
    }
    if (drag.seam) {
      drag.seam.move(clientX - drag.startX);
      return;
    }
    const next = Math.max(min, Math.min(drag.max, reach));
    // Until the seam moves, nothing new shows: a squeezed column keeps its remembered width.
    dragStep(drag, drag.startWidth, next, previewWidth);
  };
  const endDrag = () => {
    detachDrag.current?.();
    detachDrag.current = null;
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    // The width past the end is never saved: snapped, the preview is already back at the width from before the drag.
    if (drag.snapped) {
      if (drag.seam) drag.seam.restore();
      else commitWidth();
      return;
    }
    if (drag.seam) {
      drag.seam.release();
      return;
    }
    const columnElement = handleRef.current?.parentElement;
    const released = releasedDragWidth(drag.startWidth, drag.last, columnElement ? columnDragMax(column, columnElement, maxWidth, mainColumn) : drag.max, min);
    if (released !== null) commitWidth(released);
    // Dragged back to where it started: the remembered width comes back, rather than the squeezed one being saved.
    else if (drag.last !== null) previewWidth(drag.restoreWidth);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Primary button only (a right click opens the context menu, not a drag).
    if (event.button > 0) return;
    event.preventDefault();
    const handleElement = event.currentTarget;
    const snapped = snap?.snapped === true;
    // In a snapped state the handle is hidden or inert (a collapsed sidebar, the thread's Focus Mode), so a drag
    // starts beside the conversation.
    const seam = rowSeam(handleElement);
    const dragMax = seam ? seam.max : maxNow(handleElement);
    const startWidth = seam ? seam.width : Math.min(dragMax, renderedWidth(handleElement));
    setMeasuredMax(dragMax);
    dragRef.current = { startX: event.clientX, startWidth, max: dragMax, restoreWidth: rememberedWidth(), snapped, last: null, seam };
    setDragging(true);
    handleElement.setPointerCapture?.(event.pointerId);
    detachDrag.current?.();
    const pointerId = event.pointerId;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId === pointerId) moveDrag(moveEvent.clientX);
    };
    const onEnd = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId === pointerId) endDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    // The window losing focus can swallow the pointerup.
    window.addEventListener("blur", endDrag);
    detachDrag.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", endDrag);
    };
  };
  // Capture can also end without a pointerup reaching the handle (the element moves, the window loses focus). A
  // snapped drag goes on: snapping can hide the handle or make it inert, which may drop the capture.
  const onLostPointerCapture = () => {
    if (dragRef.current?.snapped) return;
    endDrag();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const keyMax = maxNow(event.currentTarget);
    if (event.key === "Enter") {
      if (!snap) return;
      event.preventDefault();
      setSnapped(!snap.snapped, "keyboard");
      return;
    }
    // Collapsed or in focus mode, the width on screen is not the column's: the arrows wait until it is back.
    if (snap?.snapped) return;
    const seam = rowSeam(event.currentTarget);
    if (seam) {
      // The same trade as a drag: the seam moves `dx`, saved at once (nothing where it cannot move).
      const toward = (target: number) => (target - seam.width) * grow;
      const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : event.key === "Home" ? toward(seam.min) : event.key === "End" ? toward(seam.max) : null;
      if (dx === null) return;
      event.preventDefault();
      setMeasuredMax(seam.max);
      seam.move(dx);
      seam.release();
      return;
    }
    let next: number;
    if (event.key === "ArrowRight") next = renderedWidth(event.currentTarget) + grow * step;
    else if (event.key === "ArrowLeft") next = renderedWidth(event.currentTarget) - grow * step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = keyMax;
    else return;
    event.preventDefault();
    setMeasuredMax(keyMax);
    const value = Math.max(min, Math.min(keyMax, next));
    // A key that cannot move the seam (at its end, or a squeezed column whose maximum is its minimum) saves nothing.
    if (Math.round(value) === Math.round(renderedWidth(event.currentTarget))) return;
    commitWidth(value);
  };

  const handle = (
    <div
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={label ?? formatMessage({ id: LABEL_ID[column] })}
        aria-valuenow={Math.min(max, clampWidth(renderedColumnWidth ?? width))}
        aria-controls={columnElementId}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        data-slot="column-resize-handle"
        data-dragging={dragging ? "true" : undefined}
        data-highlight={highlight}
        data-testid={testId}
        className={`absolute top-0 bottom-0 z-control w-3 cursor-col-resize touch-none select-none outline-none pointer-coarse:w-6 before:pointer-events-none before:absolute before:bg-transparent before:transition-colors before:content-[''] ${SEAM_CLASS} ${(ownBorder ? OWN_BORDER_EDGE_CLASS : EDGE_CLASS)[edge]} ${visibleFrom ? VISIBLE_FROM_CLASS[visibleFrom] : ""} ${className}`.trim()}
        onPointerDown={onPointerDown}
        onLostPointerCapture={onLostPointerCapture}
        onKeyDown={onKeyDown}
        onDoubleClick={resetWidth}
      />
  );
  return handle;
}
