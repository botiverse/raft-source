import type { ArtifactCommentId } from "@botiverse/raft-shared";
import type { AnnotationRect, AnnotationReport, AnnotationScroll } from "@botiverse/porthole";

/**
 * Where the open thread card goes now (client px), as the frame follows its mark (`tracked`, up to
 * 60 a second), with the key of that move (it re-arms the card). Kept out of the context's value:
 * only the card reads it (`useTrackedPlace`), so a scroll re-renders nothing else.
 */
export interface TrackedPlace {
  threadId: ArtifactCommentId;
  rect: AnnotationRect;
  key: number;
}

export interface TrackedPlaces {
  get: () => TrackedPlace | null;
  subscribe: (listener: () => void) => () => void;
}

/** A value the frame's reports change many times a second, read only by what draws from it (`useSyncExternalStore`). */
export interface PlaceStore<T> {
  get: () => T | null;
  subscribe: (listener: () => void) => () => void;
}

export function trackedPlaces(): TrackedPlaces & { set: (place: TrackedPlace | null) => void } {
  return placeStore<TrackedPlace>();
}

/** A PlaceStore, and its `set` (the same value again tells no one). */
export function placeStore<T>(): PlaceStore<T> & { set: (place: T | null) => void } {
  let place: T | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => place,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next) => {
      if (next === place) return;
      place = next;
      for (const listener of listeners) listener();
    },
  };
}

/** The frame element's box (client px), the page's reports are placed by. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** An `activated` report's only: this frame, if it was the page's `document.activeElement` as the report arrived (P134). */
  focused?: HTMLIFrameElement | null;
}

export const sameRect = (a: AnnotationRect, b: AnnotationRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Where a card opened at `opened` (its marker, a landing's box) goes once its mark's box moved from
 * `base` to `now` (client px): moved as the mark moved, kept within the frame. The frame clamps a
 * mark's box to its edges (P104), so a side held at an edge, then or now, says nothing about the
 * move: where the start is held (a long passage half scrolled out above), the end moved; where the
 * end is held, the start did; where both are (a passage taller than the frame, or held at one
 * edge then and the other now), the card stays put until one side is free again.
 */
export function followedPlace(opened: AnnotationRect, base: AnnotationRect, now: AnnotationRect, frame: FrameBox | null): AnnotationRect {
  const moved = (start: number, size: number, baseStart: number, baseSize: number, edge: number, room: number) => {
    const far = edge + room;
    const startHeld = start <= edge || baseStart <= edge;
    const endHeld = start + size >= far || baseStart + baseSize >= far;
    if (startHeld && endHeld) return 0;
    return startHeld ? start + size - (baseStart + baseSize) : start - baseStart;
  };
  const x = opened.x + moved(now.x, now.width, base.x, base.width, frame?.left ?? 0, frame?.width ?? Infinity);
  const y = opened.y + moved(now.y, now.height, base.y, base.height, frame?.top ?? 0, frame?.height ?? Infinity);
  if (!frame) return { ...opened, x, y };
  const within = (at: number, size: number, start: number, room: number) => Math.max(start, Math.min(at, start + room - size));
  return { ...opened, x: within(x, opened.width, frame.left, frame.width), y: within(y, opened.height, frame.top, frame.height) };
}

/** A box reported in the frame's px, in client px (the frame element's offset added). */
export function inClient(rect: AnnotationRect, frameBox: { left: number; top: number } | null): AnnotationRect {
  return { x: rect.x + (frameBox?.left ?? 0), y: rect.y + (frameBox?.top ?? 0), width: rect.width, height: rect.height };
}

/**
 * Where what follows a selection goes (client px): its last line, so the Comment button comes after
 * the words rather than at the corner of their whole box, which ends at the widest line and is
 * clamped (`rect`). A newer frame says where that line is (Porthole 0.14.11's P133:
 * `lastLineDocumentRect`, in the document's coordinates, with the `scroll` it was read at). That
 * box is the page's word and unclamped, so it is clipped here to the frame's box, each edge, the way
 * Porthole clamps `rect`: wherever the page says the line is, nothing is drawn from it further than
 * `rect` could put it (THREAT_MODEL §6; Tenny). Keep the clip, and draw from these numbers through
 * nothing else. An older frame sends neither (the web and the content Worker deploy apart), and with
 * no frame box there is nothing to clip to: `rect`, as before.
 */
export function selectionPlace(
  selection: { rect: AnnotationRect; lastLineDocumentRect?: AnnotationRect; scroll?: AnnotationScroll },
  frameBox: FrameBox | null,
): AnnotationRect {
  const { rect, lastLineDocumentRect: line, scroll } = selection;
  if (!line || !scroll || !frameBox) return inClient(rect, frameBox);
  const clipped = (at: number, room: number) => Math.max(0, Math.min(at, room));
  const left = clipped(line.x - scroll.x, frameBox.width);
  const right = clipped(line.x + line.width - scroll.x, frameBox.width);
  const top = clipped(line.y - scroll.y, frameBox.height);
  const bottom = clipped(line.y + line.height - scroll.y, frameBox.height);
  return inClient({ x: left, y: top, width: right - left, height: bottom - top }, frameBox);
}

/** The frame's word on the selection a composer follows (Porthole P138 `selectionTracked`). */
export type SelectionTracked = Extract<AnnotationReport, { type: "selectionTracked" }>;

/**
 * The last `selectionTracked` the open composer's selection (`key`, ArtifactReviewSelection's) was
 * reported with, and the frame's box as it came (ArtifactReviewContext → SelectionBox). Kept out of
 * the context's value, as `TrackedPlace` is: a scroll re-renders the composer alone.
 */
export interface SelectionFollow {
  key: number;
  report: SelectionTracked;
  frameBox: FrameBox | null;
}

/** The size of the marker a hidden composer leaves at the frame's edge (SelectionBox), px. */
export const EDGE_MARKER_PX = 24;

/**
 * Where the marker of a composer whose selection is out of view goes (client px): at the frame's
 * top edge if the selection is above it, else at its bottom, level with the selection's start
 * across. From `documentRect` and `scroll` (the page's word, unclamped), so clipped to the frame's
 * box as `selectionPlace` clips: nothing is drawn from them outside the frame (THREAT_MODEL §6).
 */
export function edgeMarkerPlace(
  report: { documentRect: AnnotationRect; scroll: AnnotationScroll },
  frameBox: FrameBox,
): { x: number; y: number; edge: "top" | "bottom" } {
  const { documentRect: box, scroll } = report;
  const above = box.y + box.height - scroll.y <= 0;
  const room = (size: number) => Math.max(0, size - EDGE_MARKER_PX);
  const x = Math.max(0, Math.min(box.x - scroll.x, room(frameBox.width)));
  return { x: frameBox.left + x, y: frameBox.top + (above ? 0 : room(frameBox.height)), edge: above ? "top" : "bottom" };
}

/** The room a target keeps from the sheet's top, and from the frame's, while the frame is lifted (px). */
const SHEET_GAP_PX = 16;

/**
 * How far the frame is lifted (px, never below 0) so a selection at `target` (its top and bottom in
 * the frame's viewport, `documentRect` less `scroll`) is above a phone's bottom sheet, `room` px of
 * the frame showing above the sheet. The page can't be scrolled from here (another origin, and
 * Porthole has no call for it), so the frame itself moves up, as a keyboard pushes a page; its
 * viewport and the page's reports don't change with it. Never more than the frame's own height,
 * and never past the target's top (a target taller than the room keeps its top in view). The page's
 * word, unclamped: the lift is bounded by the frame's height, whatever it says.
 */
export function sheetLift(target: { top: number; bottom: number }, room: number, frameHeight: number): number {
  const needed = target.bottom + SHEET_GAP_PX - room;
  if (needed <= 0) return 0;
  return Math.max(0, Math.min(needed, target.top - SHEET_GAP_PX, frameHeight));
}
