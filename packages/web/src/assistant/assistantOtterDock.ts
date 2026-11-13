// Where the person put the assistant's otter (#proj-assistant:#24): dragged
// off its composer, it snaps to the nearest edge of the layout's panes (the
// rail, the sidebar, the main area, a conversation, the thread and profile
// columns; not the top bar, where it would cover navigation and search) and
// stays there on this device. Unset, it lies on the composer used last (AssistantOtter.tsx).
//
// An edge is one side of a pane's box. On a bottom side it lies on top of it
// (`up`), as on a composer; under a top side it hangs into the pane (`down`);
// on a vertical side it leans out to the left or the right of it, whichever
// side it was dropped on. Each has its own pose (assistantOtterEdgeArt.tsx). A side is offered only where the otter
// fits: long enough for it, and with room for it between the side and the
// window's edge.

import { create } from "zustand";

/**
 * Panes the otter can lie on mark themselves with this attribute; its value
 * names the pane (MainLayout: `conversation`, `thread`; ShellFrame: `main`;
 * ShellSidebarColumn; LeftRail: `rail`; ProfilePanel: `profile`).
 */
export const OTTER_DOCK_ATTR = "data-otter-dock";
/** A composer's frame: dropped on its top edge, the otter goes back to lying on the composer. */
const COMPOSER_FRAME = "[data-composer-frame-edge]";

export type OtterFacing = "up" | "down" | "left" | "right";
export type DockSide = "top" | "bottom" | "left" | "right";

/** A pane's side and where along it (0 = its start: left end or top end, 1 = its end). */
export type OtterDock = { pane: string; side: DockSide; t: number; facing: OtterFacing };

export type Box = { left: number; top: number; right: number; bottom: number };
type PaneBox = Box & { pane: string };

/** The otter's size lying on an edge: `w` along the edge, `h` out of it (CSS px). */
export type OtterSize = { w: number; h: number };

/**
 * Where on a vertical edge the otter may lean out (Kirby, #24): between the
 * conversation's content top (under the top bar and the channel header) and
 * its composer's top edge, never over either.
 */
export type Band = { top: number; bottom: number };

/** The point on the edge the otter lies on (its anchor), and which way it faces. */
export type DockPlacement = { x: number; y: number; facing: OtterFacing };

export type SnapTarget =
  | { kind: "composer"; line: SnapLine }
  | { kind: "dock"; dock: OtterDock; line: SnapLine };

/** The edge a drop would land on, drawn while dragging. */
export type SnapLine = { x1: number; y1: number; x2: number; y2: number };


function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** How far along a side of `length` the otter's middle may sit: never past either end. */
function alongRange(length: number, size: OtterSize): [number, number] {
  const half = size.w / 2;
  if (length <= size.w) return [0.5, 0.5];
  return [half / length, 1 - half / length];
}

/** Where on `box` a dock puts the otter's anchor. */
export function placeDock(dock: OtterDock, box: Box, size: OtterSize, band: Band | null = null): DockPlacement {
  const horizontal = dock.side === "top" || dock.side === "bottom";
  const length = horizontal ? box.right - box.left : box.bottom - box.top;
  const [min, max] = alongRange(length, size);
  const t = clamp(dock.t, min, max);
  if (horizontal) {
    return dock.side === "top"
      ? { x: box.left + t * length, y: topLine(box, band), facing: "down" }
      : { x: box.left + t * length, y: box.bottom, facing: "up" };
  }
  const [top, bottom] = verticalSpan(box, band);
  const y = bottom - top >= size.w ? clamp(box.top + t * length, top + size.w / 2, bottom - size.w / 2) : (top + bottom) / 2;
  return { x: dock.side === "left" ? box.left : box.right, y, facing: dock.facing };
}

/**
 * Where it hangs under a pane's top side: the pane's top, or, for the
 * conversation the band is in, the top of its message list, below the
 * channel header (it never hangs over a header or the top bar).
 */
function topLine(box: Box, band: Band | null): number {
  return band && band.top > box.top && band.top < box.bottom ? band.top : box.top;
}

/** The part of a vertical side inside the band. */
function verticalSpan(box: Box, band: Band | null): [number, number] {
  return band ? [Math.max(box.top, band.top), Math.min(box.bottom, band.bottom)] : [box.top, box.bottom];
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): { d: number; t: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return { d: Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)), t };
}

/**
 * The edge a drop at `point` snaps to: the nearest one the otter fits on,
 * however far (Artea, #24: a drop in the middle of the page still lands by
 * the hand, never back where it was). Null only when no edge is offered.
 * `panes` are the marked panes' boxes, `composer` the frame of the composer
 * the otter would lie on (its top edge means "back to the composer"),
 * `viewport` the window.
 */
export function snapOtter(point: { x: number; y: number }, panes: readonly PaneBox[], composer: Box | null, viewport: Box, size: OtterSize, band: Band | null = null): SnapTarget | null {
  let best: { d: number; target: SnapTarget } | null = null;
  const consider = (d: number, target: SnapTarget) => {
    if (best === null || d < best.d) best = { d, target };
  };

  if (composer && composer.right - composer.left >= size.w && composer.top - viewport.top >= size.h) {
    consider(distanceToSegment(point.x, point.y, composer.left, composer.top, composer.right, composer.top).d, { kind: "composer", line: { x1: composer.left, y1: composer.top, x2: composer.right, y2: composer.top } });
  }

  for (const box of panes) {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    // A horizontal side: it lies on a bottom side, inside the pane, and hangs
    // under a top side (Artea, #24), into the pane; either needs the pane's
    // height for it, inside the window.
    if (width >= size.w) {
      for (const side of ["top", "bottom"] as const) {
        const y = side === "top" ? topLine(box, band) : box.bottom;
        const room = side === "top" ? box.bottom - y : height;
        if (room < size.h || y > viewport.bottom || y < viewport.top) continue;
        const { d, t } = distanceToSegment(point.x, point.y, box.left, y, box.right, y);
        const [min, max] = alongRange(width, size);
        consider(d, { kind: "dock", dock: { pane: box.pane, side, t: clamp(t, min, max), facing: side === "top" ? "down" : "up" }, line: { x1: box.left, y1: y, x2: box.right, y2: y } });
      }
    }
    // Leaning out of a vertical side, to the side it was dropped on, where there is room,
    // and only along the part of it inside the band.
    const [top, bottom] = verticalSpan(box, band);
    if (height >= size.w && bottom - top >= size.w) {
      for (const side of ["left", "right"] as const) {
        const x = side === "left" ? box.left : box.right;
        const facing: OtterFacing = point.x < x ? "left" : "right";
        const room = facing === "left" ? x - viewport.left : viewport.right - x;
        if (room < size.h) continue;
        const { d } = distanceToSegment(point.x, point.y, x, top, x, bottom);
        const y = clamp(point.y, top + size.w / 2, bottom - size.w / 2);
        consider(d, { kind: "dock", dock: { pane: box.pane, side, t: (y - box.top) / height, facing }, line: { x1: x, y1: top, x2: x, y2: bottom } });
      }
    }
  }
  return (best as { d: number; target: SnapTarget } | null)?.target ?? null;
}

/** The marked panes on screen now, with their boxes (empty ones, hidden ones left out). */
export function readPaneBoxes(): PaneBox[] {
  if (typeof document === "undefined") return [];
  const boxes: PaneBox[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(`[${OTTER_DOCK_ATTR}]`)) {
    const pane = element.getAttribute(OTTER_DOCK_ATTR);
    const rect = element.getBoundingClientRect();
    if (!pane || rect.width <= 0 || rect.height <= 0) continue;
    boxes.push({ pane, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return boxes;
}

/** The pane a dock names, if it is on screen. */
export function findDockPane(pane: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const element of document.querySelectorAll<HTMLElement>(`[${OTTER_DOCK_ATTR}]`)) {
    if (element.getAttribute(OTTER_DOCK_ATTR) !== pane) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return element;
  }
  return null;
}

/**
 * A stack of notices right above a composer (the notification banner) marks
 * itself with this. The otter lies on top of it, not over its buttons
 * (Artea, #24).
 */
export const COMPOSER_NOTICES_ATTR = "data-composer-notices";

/** Notices this close above a frame count as sitting on it (ChatPanel's gap-2). */
const NOTICES_GAP_PX = 24;

/** The notice stacks that sit on `frame`, nearest first. */
export function composerNoticesOf(frame: HTMLElement): HTMLElement[] {
  for (let el = frame.parentElement, depth = 0; el && depth < 4; el = el.parentElement, depth++) {
    const found = [...el.querySelectorAll<HTMLElement>(`[${COMPOSER_NOTICES_ATTR}]`)].filter((n) => !n.contains(frame) && !frame.contains(n));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Where the otter lies on a composer: the frame's top edge, or the top of the
 * notices showing right above it.
 */
export function composerTopEdge(frame: HTMLElement): number {
  const box = frame.getBoundingClientRect();
  let top = box.top;
  for (const notices of composerNoticesOf(frame)) {
    const r = notices.getBoundingClientRect();
    if (r.height <= 0 || r.bottom > box.top + 1 || box.top - r.bottom > NOTICES_GAP_PX) continue;
    if (r.right <= box.left || r.left >= box.right) continue;
    top = Math.min(top, r.top);
  }
  return top;
}

/** The frame of the composer around `from`, if any. */
export function composerFrameOf(from: Element | null): HTMLElement | null {
  return from?.closest<HTMLElement>(COMPOSER_FRAME) ?? null;
}

/**
 * The band for the composer around `from`: from the top of its conversation's
 * message list (below the top bar and the channel header) to the composer's
 * top edge (above its notices, composerTopEdge). With no composer (a page with none), the conversation column's
 * box, else the window.
 */
export function contentBand(from: Element | null): Band | null {
  const frame = composerFrameOf(from);
  if (!frame) return null;
  let timeline: HTMLElement | null = null;
  for (let el = frame.parentElement; el && !timeline; el = el.parentElement) {
    if (el.querySelectorAll(COMPOSER_FRAME).length > 1) break;
    timeline = el.querySelector<HTMLElement>("[data-virtual-timeline]");
  }
  const frameTop = composerTopEdge(frame);
  const top = timeline ? timeline.getBoundingClientRect().top : frameTop - 10_000;
  return { top, bottom: frameTop };
}

export function viewportBox(): Box {
  const width = typeof document === "undefined" ? 0 : document.documentElement.clientWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  return { left: 0, top: 0, right: width, bottom: height };
}

// ---- Remembered on this device --------------------------------------------------
//
// One place per form factor: a phone's layout has other panes than a desktop's.

const STORAGE_PREFIX = "raft.assistantOtter.dock.";

function isDock(value: unknown): value is OtterDock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.pane === "string"
    && (v.side === "top" || v.side === "bottom" || v.side === "left" || v.side === "right")
    && typeof v.t === "number" && Number.isFinite(v.t)
    && (v.facing === "up" || v.facing === "down" || v.facing === "left" || v.facing === "right");
}

function readDock(form: "phone" | "wide"): OtterDock | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_PREFIX + form);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isDock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const useOtterDockStore = create<{ phone: OtterDock | null; wide: OtterDock | null }>(() => ({
  phone: readDock("phone"),
  wide: readDock("wide"),
}));

/** Where the otter lies on this form factor; null: on the composer used last. */
export function useOtterDock(phone: boolean): OtterDock | null {
  return useOtterDockStore((state) => (phone ? state.phone : state.wide));
}

export function setOtterDock(phone: boolean, dock: OtterDock | null): void {
  const form = phone ? "phone" : "wide";
  useOtterDockStore.setState({ [form]: dock });
  try {
    if (dock) localStorage.setItem(STORAGE_PREFIX + form, JSON.stringify(dock));
    else localStorage.removeItem(STORAGE_PREFIX + form);
  } catch {
    // Storage blocked: the place holds until the page reloads.
  }
}

export function resetOtterDockForTests(): void {
  useOtterDockStore.setState({ phone: null, wide: null });
}
