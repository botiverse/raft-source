import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { FileText, ListTodo, Paperclip, UserRound } from "lucide-react";
import { create } from "zustand";
import { DndContext, getClientRect, useDndContext, useDraggable } from "@dnd-kit/core";
import type { Announcements, ClientRect, DragMoveEvent, DragStartEvent, KeyboardCoordinateGetter } from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { ThreadIcon } from "@botiverse/ricons";
import { cancelDrag, DRAG_SETTLE, DragLift, DragRefusalHint, DropPlaceholder, keepGrabInside, useDragSensors } from "@botiverse/raft-ui/wip";
import { channelSideSectionWidth, moveChannelSideSection } from "@botiverse/raft-shared";
import type { ChannelSideDrop, ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

import Tooltip from "../ui/Tooltip";
import { useChannelSideLayoutStore } from "../../store/channelSideLayoutStore";
import { rowTabsOf, useRowPlanStore } from "../layout/rowPlanStore";
import { ROW_SELECTOR } from "./sideCardsLayout";
import { useDropGiveWay } from "./dropGiveWay";
import type { MessageId } from "../../i18n/messages";

/**
 * Moving a section between and within the side columns (task #165), by the
 * one drag model (raft-ui's drag layer, `@botiverse/raft-ui/wip`): a pointer
 * or a finger picks a section up by the grip at the top of its head (stdrc:
 * the rest of the head keeps its clicks, the thread's head and channel jumps);
 * the grip's bar shows on hovering the head, and the grip is the keyboard's
 * handle too (Space picks it up, the arrows go through the places it can land, Space drops it
 * there, Escape cancels; a screen reader hears each step by the section's
 * name). The hand holds a compact copy of the head (icon and title); the
 * section stays where it is, faded, and nothing is drawn over it until the
 * drop. Over a place in a column, that column makes room: a gap opens there
 * with a dashed area in it, the sections around giving it their height (in
 * the section's own column, only those it moves past); at a column's edge a
 * full-height strip shows the new column, and the columns stay as they are
 * until the drop. On the drop the copy glides in, the other
 * sections slide to their places in step, and the layout is saved, once.
 *
 * Every section moves this way, the Artifact and the profile too (#189 rule
 * 7). A column a drop makes stands in the row whatever its width (the row's
 * plan clips it or makes it a tab, rules 4 and 7); only a fifth side column is
 * not a place. The conversation isn't moved; dropped on, it means a new column
 * right after the thread (or first, with the thread folded over it or none).
 *
 * The geometry is read from the DOM when the drag starts (nothing moves until
 * the drop): each column standing in the row is marked `data-side-col` (its
 * layout index), each section in it `data-side-box` (its name), each movable
 * head `data-side-head`.
 */

const EDGE_ZONE = 24;
/** A new column's strip on its edge: 24px, its dashed area 16px inside the 4px inset. */
const EDGE_STRIP = 24;
/** A section head's height where it can't be measured (and a folded one's): raft-ui's header height, 44 with a mouse, 56 on touch. */
export const headHeight = () =>
  typeof matchMedia === "function" && matchMedia("(width >= 48rem) and (pointer: fine)").matches ? 44 : 56;
/** The compact copy's widest (spec 3). */
const PROXY_MAX_WIDTH = 240;

/** A box in viewport px. */
export interface SideBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SideDropTarget {
  drop: ChannelSideDrop;
  /** For a new column: the column edge the pointer must be near (the line can stand elsewhere, where the boundary will be). */
  edge?: number;
  /** The place's line, in viewport px: what the pointer is matched against. */
  line: { x: number; y: number; width: number; height: number };
  /** Anywhere in it is this place too: the conversation, for the new column after the thread (#189 rule 7). */
  zone?: SideBox;
  /** A new column's edge (vertical line) or a place in a column (horizontal). */
  orientation: "vertical" | "horizontal";
  /** A new column the row doesn't hold (no place: the edge says why). */
  fit?: Exclude<SideFit, "fits">;
  /** For a screen reader: the section it lands above, or the column it lands at the bottom of or beside. */
  description: { kind: "above"; section: ChannelSideSection } | { kind: "bottom"; sections: ChannelSideSection[] } | { kind: "newColumn"; side: "left" | "right"; sections: ChannelSideSection[] };
  /** The dashed area: where the section will stand in a column, or the full-height strip at the edge for a new column. */
  area: SideBox;
  /** Where its head will stand once dropped: what the lifted copy glides onto while the row reflows. */
  landing: SideBox;
  /** A place in a column: how the column makes room for it while the hand is here (none for a new column's strip). */
  room?: SideRoom;
  /** A new column past the last: that column (`data-side-col`) gives the strip its width meanwhile (useDropGiveWay). */
  giveWay?: number;
}

/**
 * How a column makes room for a place in it (Kirby: in the section's own
 * column and in any other alike): a gap opens there, holding the dashed
 * area, and the column's sections give it their height, so nothing is drawn
 * over them. In the section's own column only the sections it moves past
 * give way: it stays in its place, at its size, faded, until the drop.
 */
export interface SideRoom {
  /** The box the gap opens next to. */
  anchor: { section: ChannelSideSection; side: "before" | "after" };
  /** The gap's flex in the column. */
  gap: string;
  /** Each section's flex in the column while the gap is open. */
  flex: Array<{ section: ChannelSideSection; flex: string }>;
  /**
   * The gap's edge that draws the seam between it and the section next to it (`gapSeam`), none where a folded
   * head's own line or the column's end is already there.
   */
  seam: "above" | "below" | null;
}

/**
 * Which edge of a gap draws the seam (Kirby, #11400: in a narrow stacked thread column the gap's lower edge had
 * none). Above a section, its lower edge: the seam above that section, or a folded head's own line, is already
 * on its upper one. Below an open section, its upper edge: the seam under that section now stands under the gap.
 * Below a folded head, which draws its own line and has no seam under it, its lower edge, if a section follows.
 */
export function gapSeam(side: "before" | "after", anchorFolded: boolean, followed: boolean): SideRoom["seam"] {
  if (side === "before") return "below";
  if (!anchorFolded) return "above";
  return followed ? "below" : null;
}

/** Whether a layout's columns all stand in the row (a planned row: always), or not. */
export type SideFit = "fits" | "none";

/** How a column shares its height among `sections`, top to bottom: each one's share, null for one folded to its head. */
export type SideStackShares = (sections: readonly ChannelSideSection[]) => Array<number | null>;

const evenShares: SideStackShares = (sections) => sections.map(() => 1);

interface DragState {
  section: ChannelSideSection | null;
  via: "pointer" | "keyboard" | null;
  targets: SideDropTarget[];
  target: SideDropTarget | null;
  announcement: string;
  /** The row the section is moved in, and where it stood when the drag started: the dashed area is drawn in it. */
  row: { element: HTMLElement; x: number; y: number } | null;
  /** How a layout would fit the row now (the side area keeps it current); null outside one. */
  fit: ((layout: ChannelSideLayout) => SideFit) | null;
  /** How a column would share its height (the side area's splits and folds); null outside one. */
  shares: SideStackShares | null;
  /** Whether sections can be moved now: standing in the row, with more than one open. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  announce: (text: string) => void;
}

const IDLE: Pick<DragState, "section" | "via" | "targets" | "target" | "row"> = { section: null, via: null, targets: [], target: null, row: null };

export const useSideDrag = create<DragState>((set) => ({
  ...IDLE,
  announcement: "",
  fit: null,
  shares: null,
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
  announce: (announcement) => set({ announcement }),
}));

// ---------------------------------------------------------------- the places

/** The sections' boxes in a column, top to bottom. */
const THREAD_BOX = ':scope > [data-slot="thread-panel-root"]';

function sectionOfBox(element: HTMLElement): ChannelSideSection {
  return element.matches('[data-slot="thread-panel-root"]') ? "thread" : (element.dataset.sideBox as ChannelSideSection);
}

function boxesOf(column: HTMLElement): Array<{ section: ChannelSideSection; box: DOMRect }> {
  // The thread's box is its panel, a direct child of its column.
  return Array.from(column.querySelectorAll<HTMLElement>(`[data-side-box], ${THREAD_BOX}`))
    .filter((element) => element.closest("[data-side-col]") === column)
    .map((element) => ({ section: sectionOfBox(element), box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.height > 0)
    .sort((a, b) => a.box.top - b.box.top);
}

/**
 * A column's own width, which the row squeezes it under where it runs short
 * (ChannelSideArea's `width`; the thread's `--thread-panel-width`): what it
 * grows back to once there is room. No wider than it stands where it has none.
 */
function ownWidth(column: HTMLElement, standing: number): number {
  const own = parseFloat(column.style.width) || parseFloat(column.style.getPropertyValue("--thread-panel-width"));
  return Number.isFinite(own) && own > standing ? own : standing;
}

/**
 * Where `section` stands in a column of `sections` `height` tall: the open
 * ones split what the folded heads and the 1px seams leave (none under a
 * folded head, which draws its own), as the column lays them out.
 */
function stackBox(sections: readonly ChannelSideSection[], section: ChannelSideSection, shares: Array<number | null>, top: number, height: number, head: number): { y: number; height: number } {
  let fixed = 0;
  let open = 0;
  sections.forEach((_, i) => {
    if (i > 0 && shares[i - 1] !== null) fixed += 1;
    const share = shares[i];
    if (share === null) fixed += head;
    else open += share;
  });
  const rest = Math.max(0, height - fixed);
  let y = top;
  for (let i = 0; i < sections.length; i += 1) {
    if (i > 0 && shares[i - 1] !== null) y += 1;
    const share = shares[i];
    const h = share === null ? head : (rest * share) / (open || 1);
    if (sections[i] === section) return { y, height: h };
    y += h;
  }
  return { y: top, height };
}

/**
 * A place in the section's own column (Kirby: within its column as into
 * another, the section stays in its place, faded, and nothing covers it
 * until the drop, so the person always sees where it came from and where a
 * cancel puts it back). The gap opens at the place, and only the sections it
 * moves past give it room: they and the gap share their height, by their
 * heights and the section's own; the section and the rest keep theirs.
 * Measured from the column before the drag, so the places and what the
 * pointer is matched against don't move while the column makes room.
 */
function sameColumnPlace(boxes: Array<{ section: ChannelSideSection; box: DOMRect }>, section: ChannelSideSection, before: ChannelSideSection | null, current: Array<number | null>): { y: number; height: number; room: SideRoom } | null {
  const from = boxes.findIndex((b) => b.section === section);
  if (from < 0) return null;
  const others = boxes.filter((b) => b.section !== section);
  const to = before === null ? others.length : others.findIndex((b) => b.section === before);
  if (to < 0 || to === from) return null;
  const up = to < from;
  // Up: the ones from its new place to just above its own; down: the ones just below its own to its new place.
  const past = up ? boxes.slice(to, from) : boxes.slice(from + 1, to + 1);
  const gives = (i: number) => past.includes(boxes[i]) && current[i] !== null;
  const own = boxes[from].box.height;
  const open = boxes.reduce((sum, b, i) => sum + (gives(i) ? b.box.height : 0), 0);
  // Past folded heads alone, a head's height (the others give that much).
  const height = open > 0 ? Math.max(headHeight(), (open * own) / (own + open)) : headHeight();
  // Who gives the gap's head where the sections it moves past can't (folded heads alone): the open ones outside the
  // span; its own box only where there is none, so the column never runs over its height.
  const othersOpen = boxes.some((b, i) => i !== from && !past.includes(b) && current[i] !== null);
  const shrinks = (i: number) => current[i] !== null && (i !== from || (open === 0 && !othersOpen));
  return {
    y: up ? boxes[to].box.top : boxes[to].box.bottom - height,
    height,
    room: {
      anchor: up ? { section: boxes[to].section, side: "before" } : { section: boxes[to].section, side: "after" },
      gap: `${own} 1 0px`,
      seam: gapSeam(up ? "before" : "after", current[to] === null, to < boxes.length - 1),
      // A folded head keeps its height whatever happens (Kirby, #11400), and so does its own box (`shrinks`); the
      // open ones outside the span keep theirs unless the gap's head needs it.
      flex: boxes.map((b, i) => ({ section: b.section, flex: gives(i) ? `${b.box.height} 1 0px` : `0 ${shrinks(i) ? 1 : 0} ${b.box.height}px` })),
    },
  };
}

/**
 * A place in another column: it makes room as the column will stand once
 * dropped, each section at its share of the stack with the section in it
 * (`stack`, its `split`), the gap at the section's.
 */
function columnRoom(boxes: Array<{ section: ChannelSideSection }>, stack: readonly ChannelSideSection[], split: Array<number | null>, section: ChannelSideSection, before: ChannelSideSection | null, top: number, height: number, head: number): SideRoom | undefined {
  const last = boxes[boxes.length - 1];
  if (!last) return undefined;
  const flexOf = (s: ChannelSideSection) => {
    const h = stackBox(stack, s, split, top, height, head).height;
    return split[stack.indexOf(s)] === null ? `0 0 ${h}px` : `${h} 1 0px`;
  };
  return {
    anchor: before === null ? { section: last.section, side: "after" } : { section: before, side: "before" },
    gap: flexOf(section),
    seam: gapSeam(before === null ? "after" : "before", split[stack.indexOf(last.section)] === null, false),
    flex: boxes.map((b) => ({ section: b.section, flex: flexOf(b.section) })),
  };
}

/**
 * Every place `section` can land, read from the row: before each section of
 * each column and at its bottom, and a new column at each column's edges,
 * marked when the row holds it only with the sidebar collapsed or not at all
 * (`fit`, the side area's; none known, not at all). Places where it already
 * is are left out, and so, for a section alone in its column, are that
 * column's two edges: a new column there is the row as it is.
 *
 * Each place carries the area the section will take (`shares`, the side
 * area's, split a column's height), how its column makes room for it
 * (`room`), and where its head will stand once the row has reflowed,
 * for the lifted copy to glide onto. The columns are anchored to the row's
 * right edge (the channel takes the rest), so a column a section leaves empty
 * moves the ones left of it right, and the room it frees lets columns the
 * row had squeezed grow back to their own widths.
 */
export function sideDropTargets(row: HTMLElement, layout: ChannelSideLayout, section: ChannelSideSection, fit: ((layout: ChannelSideLayout) => SideFit) | null, shares: SideStackShares = evenShares): SideDropTarget[] {
  const columns = Array.from(row.querySelectorAll<HTMLElement>("[data-side-col]"))
    .filter((element) => element.closest(ROW_SELECTOR) === row && element.getBoundingClientRect().width > 0)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { index: Number(element.dataset.sideCol), rect, own: ownWidth(element, rect.width), boxes: boxesOf(element) };
    })
    .sort((a, b) => a.rect.left - b.rect.left);
  const ownAt = columns.findIndex((column) => column.boxes.some((b) => b.section === section));
  const alone = ownAt >= 0 && columns[ownAt].boxes.length === 1;
  const rowRight = columns.length > 0 ? columns[columns.length - 1].rect.right : 0;
  // Alone in its column, the section takes the column with it. Dropped into another column, the room it frees
  // goes first to the columns the row had squeezed (back toward their own widths), the rest to the channel.
  const freed = alone ? columns[ownAt].rect.width : 0;
  const short = columns.reduce((sum, column, position) => sum + (alone && position === ownAt ? 0 : column.own - column.rect.width), 0);
  const grow = short > 0 ? Math.min(1, freed / short) : 0;
  const widthAfter = (position: number) => columns[position].rect.width + (columns[position].own - columns[position].rect.width) * grow;
  // Where the column at `position` (past the last: the row's right edge) will start once dropped.
  const leftAfter = (position: number, width: (position: number) => number) => columns.reduce((x, _, q) => (q >= position && !(alone && q === ownAt) ? x - width(q) : x), rowRight);
  const head = row.querySelector<HTMLElement>(`[data-side-head="${section}"]`)?.getBoundingClientRect().height || headHeight();
  const rowLeft = row.getBoundingClientRect().left;
  // A new column: a full-height dashed strip on its edge's seam (drag-and-drop.md, #189), over no column's content.
  const edgeStrip = (edge: number, top: number, height: number): SideBox => ({ x: Math.max(rowLeft, Math.min(rowRight - EDGE_STRIP, edge - EDGE_STRIP / 2)), y: top, width: EDGE_STRIP, height });
  const targets: SideDropTarget[] = [];
  const keep = (target: SideDropTarget) => {
    const moved = moveChannelSideSection(layout, section, target.drop);
    if (moved === layout) return;
    // Unknown room (no side area measuring the row) offers no new column: one the person makes must never float.
    const room = target.drop.kind !== "newColumn" ? "fits" : fit ? fit(moved) : "none";
    targets.push(room === "fits" ? target : { ...target, fit: room });
  };
  // A new column at the left edge of the column at `position`; past the last one, at the row's last edge.
  const newColumn = (position: number) => {
    if (alone && (position === ownAt || position === ownAt + 1)) return;
    const column = columns[position];
    const beside = column ?? columns[columns.length - 1];
    const edge = column ? column.rect.left : beside.rect.right;
    const { top, height } = beside.rect;
    // Alone, it moves its column (as wide as it is) to the edge; otherwise the new column takes its own default width.
    const width = alone ? columns[ownAt].rect.width : channelSideSectionWidth(section);
    const landingX = alone ? leftAfter(position, (q) => columns[q].rect.width) - width : edge - width;
    keep({
      drop: { kind: "newColumn", at: column ? column.index : beside.index + 1 },
      edge,
      orientation: "vertical",
      line: { x: edge - 1, y: top, width: 2, height },
      area: edgeStrip(edge, top, height),
      ...(column ? null : { giveWay: beside.index }),
      landing: { x: landingX, y: top, width, height: head },
      // Described without the section being moved.
      description: { kind: "newColumn", side: column ? "left" : "right", sections: beside.boxes.map((b) => b.section).filter((s) => s !== section) },
    });
  };
  columns.forEach((column, position) => {
    const { rect, boxes } = column;
    const others = boxes.map((b) => b.section).filter((s) => s !== section);
    const into = (before: ChannelSideSection | null, lineY: number, description: SideDropTarget["description"]) => {
      const stack = [...others];
      stack.splice(before === null ? stack.length : Math.max(0, stack.indexOf(before)), 0, section);
      const split = shares(stack);
      const { y, height } = stackBox(stack, section, split, rect.top, rect.height, head);
      const own = position === ownAt ? sameColumnPlace(boxes, section, before, shares(boxes.map((b) => b.section))) : null;
      keep({
        drop: { kind: "into", column: column.index, before },
        orientation: "horizontal",
        line: { x: rect.left, y: lineY, width: rect.width, height: 2 },
        // Where the gap opens as the column makes room (its own: past the sections it moves past); the head lands
        // where the column will stand once the row has reflowed.
        area: own ? { x: rect.left, y: own.y, width: rect.width, height: own.height } : { x: rect.left, y, width: rect.width, height },
        landing: { x: alone ? leftAfter(position, widthAfter) : rect.left, y, width: widthAfter(position), height: head },
        description,
        room: own ? own.room : columnRoom(boxes, stack, split, section, before, rect.top, rect.height, head),
      });
    };
    newColumn(position);
    for (const { section: before, box } of boxes) into(before, box.top - 1, { kind: "above", section: before });
    const last = boxes[boxes.length - 1];
    if (last) into(null, last.box.bottom - 1, { kind: "bottom", sections: others });
  });
  if (columns.length > 0) newColumn(columns.length);
  // The conversation doesn't move (#189 rule 7): dropped anywhere on it (or the thread folded over it), a section
  // makes a new column right after the thread (its column in the row, else its place in the layout: folded, it is
  // the conversation's), or first where no thread is open. That place's target takes the conversation as its zone.
  const conversation = row.querySelector<HTMLElement>(":scope > .thread-main-column");
  const thread = columns.find((column) => column.boxes.some((b) => b.section === "thread"));
  const threadAt = layout.columns.findIndex((column) => column.sections.includes("thread"));
  const threadOpen = !!thread || row.querySelector(":scope > .thread-side-column") !== null;
  if (conversation && section !== "thread" && columns.length > 0) {
    const zone = conversation.getBoundingClientRect();
    const at = thread ? thread.index + 1 : threadOpen && threadAt >= 0 ? threadAt + 1 : 0;
    const same = targets.find((t) => t.drop.kind === "newColumn" && t.drop.at === at);
    if (same) same.zone = { x: zone.left, y: zone.top, width: zone.width, height: zone.height };
    else {
      const edge = thread ? thread.rect.right : zone.right;
      keep({
        drop: { kind: "newColumn", at },
        orientation: "vertical",
        edge,
        zone: { x: zone.left, y: zone.top, width: zone.width, height: zone.height },
        line: { x: edge - 1, y: zone.top, width: 2, height: zone.height },
        area: edgeStrip(edge, zone.top, zone.height),
        landing: { x: edge, y: zone.top, width: alone ? columns[ownAt].rect.width : channelSideSectionWidth(section), height: head },
        description: { kind: "newColumn", side: "left", sections: columns[0]!.boxes.map((b) => b.section).filter((s) => s !== section) },
      });
    }
  }
  return targets;
}

/** The place under the pointer: a column's edge zone first, else the nearest place in the column it is over. */
export function targetAt(targets: SideDropTarget[], x: number, y: number): SideDropTarget | null {
  const edge = targets
    .filter((t) => t.orientation === "vertical" && Math.abs(x - (t.edge ?? t.line.x)) <= EDGE_ZONE && y >= t.line.y && y <= t.line.y + t.line.height)
    .sort((a, b) => Math.abs(x - (a.edge ?? a.line.x)) - Math.abs(x - (b.edge ?? b.line.x)))[0];
  if (edge) return edge;
  const zoned = targets.find((t) => t.zone && x >= t.zone.x && x <= t.zone.x + t.zone.width && y >= t.zone.y && y <= t.zone.y + t.zone.height);
  if (zoned) return zoned;
  const inColumn = targets.filter((t) => t.orientation === "horizontal" && x >= t.line.x && x <= t.line.x + t.line.width);
  if (inColumn.length === 0) return null;
  return inColumn.sort((a, b) => Math.abs(y - a.line.y) - Math.abs(y - b.line.y))[0];
}

const SECTION_TITLE: Record<ChannelSideSection, MessageId> = {
  thread: "message.threadPanel.thread",
  tasks: "task.panel.heading",
  files: "message.chatPanel.tabFiles",
  artifact: "artifacts.viewer.regionLabel",
  profile: "agent.detail.tab.profile", context: "agentContextView.title", details: "channel.details.title",
};

function sectionTitleId(section: ChannelSideSection): MessageId {
  return SECTION_TITLE[section];
}

/** The dragged section's box: what stays behind, faded, while it is moved. */
function boxOf(row: HTMLElement, section: ChannelSideSection): HTMLElement | null {
  if (section === "thread") return row.querySelector<HTMLElement>(':scope > .thread-side-column > [data-slot="thread-panel-root"]');
  return row.querySelector<HTMLElement>(`[data-side-box="${section}"]`);
}

/** The grip a keyboard drop has just put the focus back on: its tooltip stays shut until the focus leaves it. */
let quietGrip: ChannelSideSection | null = null;

const headOf = (section: ChannelSideSection) => document.querySelector<HTMLElement>(`[data-side-head="${section}"]`);
const gripOf = (section: ChannelSideSection) => document.querySelector<HTMLElement>(`[data-testid="side-section-grip-${section}"]`);

// ---------------------------------------------------------------- the drop

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The gap a column opened for the place under the hand, and the sections' styles it changed: put back as they were. */
let openRoomState: { gap: HTMLElement; boxes: Array<{ element: HTMLElement; flex: string; height: string; minHeight: string }> } | null = null;

/** Closes the gap: the column's sections take their own heights back. */
function closeRoom() {
  if (!openRoomState) return;
  openRoomState.gap.remove();
  for (const { element, flex, height, minHeight } of openRoomState.boxes) {
    element.style.flex = flex;
    element.style.height = height;
    element.style.minHeight = minHeight;
  }
  openRoomState = null;
}

/**
 * Opens the gap for a place in a column (its `room`): an element in the
 * column's stack, next to its anchor's box, that the dashed area is drawn in;
 * the column's sections take the flex the place gives them. Any gap open
 * before closes first. Returns the gap, to draw the dashed area in.
 */
function openRoom(row: HTMLElement | null, target: SideDropTarget | null): HTMLElement | null {
  closeRoom();
  const room = target?.room;
  if (!row || !room) return null;
  const anchor = boxOf(row, room.anchor.section);
  if (!anchor) return null;
  const gap = document.createElement("div");
  gap.dataset.testid = "side-section-drop-slot";
  gap.dataset.place = "section";
  // The seam between the gap and its neighbour (gapSeam): the column's 1px line-seam, as between its sections.
  gap.className = `pointer-events-none relative shrink${room.seam === "above" ? " border-t border-line-seam" : room.seam === "below" ? " border-b border-line-seam" : ""}`;
  if (room.seam) gap.dataset.seam = room.seam;
  gap.style.flex = room.gap;
  gap.style.minHeight = `${headHeight()}px`;
  const boxes: NonNullable<typeof openRoomState>["boxes"] = [];
  for (const { section, flex } of room.flex) {
    const element = boxOf(row, section);
    if (!element) continue;
    boxes.push({ element, flex: element.style.flex, height: element.style.height, minHeight: element.style.minHeight });
    element.style.flex = flex;
    // The thread's panel stands at its column's height where it is alone: here it gives its height too.
    element.style.height = "auto";
    element.style.minHeight = "0px";
  }
  anchor.insertAdjacentElement(room.anchor.side === "before" ? "beforebegin" : "afterend", gap);
  openRoomState = { gap, boxes };
  return gap;
}

/** The sections' content, which a move keeps (their boxes are made anew): what slides to its new place on the drop. */
function contentsOf(row: HTMLElement): Array<{ section: ChannelSideSection; element: HTMLElement }> {
  const cards = Array.from(row.querySelectorAll<HTMLElement>("[data-side-section] > *"))
    .map((element) => ({ section: element.parentElement!.dataset.sideSection as ChannelSideSection, element }));
  const thread = boxOf(row, "thread");
  return thread ? [...cards, { section: "thread", element: thread }] : cards;
}

/**
 * The reflow on the drop (Kirby, decision 6): each section other than the
 * moved one slides from where it stood to its new place, in the glide's
 * 160ms and easing, while the lifted copy glides onto the moved one's head.
 * Measured now; returns what plays once the dropped layout is in the DOM
 * (the next frame, before it paints).
 */
function slideSections(row: HTMLElement, moved: ChannelSideSection): () => void {
  const before = contentsOf(row).filter((c) => c.section !== moved).map((c) => ({ ...c, rect: c.element.getBoundingClientRect() }));
  return () => {
    for (const { element, rect } of before) {
      if (!element.isConnected || typeof element.animate !== "function" || reducedMotion()) continue;
      const now = element.getBoundingClientRect();
      const dx = rect.left - now.left;
      const dy = rect.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: DRAG_SETTLE.duration, easing: DRAG_SETTLE.easing });
    }
  };
}

const toClientRect = (box: SideBox): ClientRect => ({ left: box.x, top: box.y, width: box.width, height: box.height, right: box.x + box.width, bottom: box.y + box.height });

// ---------------------------------------------------------------- the drag

/** What a drag says, in the section's language, fixed when it starts. */
interface DragTexts {
  pickedUp: string;
  over: (target: SideDropTarget) => string;
  dropped: (target: SideDropTarget) => string;
  cancelled: string;
  noRoom: string;
}

/** dnd-kit stays quiet: the side area speaks by the section's name through its own live region. */
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/**
 * Cancel any drag in progress: the area calls it when sections can no longer
 * be moved (a phone's width, Focus Mode, one section left) and when it goes,
 * so no drag outlives the row it was over.
 */
export function cancelSideDrag() {
  if (useSideDrag.getState().section) cancelDrag();
}

/** Tests: drop any drag left over. */
export function __resetSideDragForTests() {
  quietGrip = null;
  closeRoom();
  useSideDrag.setState({ ...IDLE, announcement: "" });
  document.documentElement.removeAttribute("data-dragging");
  document.documentElement.removeAttribute("data-drag-refused");
  document.querySelector("[data-side-dragging]")?.removeAttribute("data-side-dragging");
}

/**
 * Around the layout row (MainLayout): the sections' heads are its draggables,
 * wherever they render (Tasks and Files in the channel panel's portals, the
 * thread in its column). It holds the drag: the places, the lifted copy, the
 * refused place's reason, and the drop.
 */
export function SideSectionDnd({ children }: { children: ReactNode }) {
  const { formatMessage } = useIntl();
  const describe = useDescribe();
  const refused = useSideDrag((s) => s.target?.fit === "none");
  const texts = useRef<DragTexts | null>(null);
  // While the dropped copy glides, its head's predicted place: the reflow hasn't put it there yet when the glide measures.
  const landing = useRef<{ node: HTMLElement; rect: ClientRect } | null>(null);
  const measuring = useMemo(() => ({
    draggable: { measure: (element: HTMLElement) => (landing.current?.node === element ? landing.current.rect : getClientRect(element)) },
  }), []);

  // By keyboard the arrows go through the places (a new column with no room is not one); the copy is drawn in the place.
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>((event) => {
    const state = useSideDrag.getState();
    const step = event.code === "ArrowDown" || event.code === "ArrowRight" ? 1 : event.code === "ArrowUp" || event.code === "ArrowLeft" ? -1 : 0;
    const places = state.targets.filter((t) => t.fit !== "none");
    if (!step || !state.section || places.length === 0) return undefined;
    event.preventDefault();
    // Picked up, it is over its own place: the arrows then go through the others.
    const at = state.target ? places.indexOf(state.target) : step > 0 ? -1 : places.length;
    const next = places[(at + step + places.length) % places.length];
    useSideDrag.setState({ target: next, announcement: texts.current?.over(next) ?? "" });
    // At the place's corner: DragLift sets a keyboard drag's copy 6px in, so the dashed outline still shows.
    return { x: next.area.x, y: next.area.y };
  }, []);
  const sensors = useDragSensors(coordinateGetter);

  const onDragStart = useCallback(({ active, activatorEvent }: DragStartEvent) => {
    const section = active.id as ChannelSideSection;
    const row = headOf(section)?.closest<HTMLElement>(ROW_SELECTOR);
    if (!row) return;
    const title = formatMessage({ id: sectionTitleId(section) });
    const said: DragTexts = {
      pickedUp: formatMessage({ id: "layout.sideSection.dragPickedUp" }, { name: title }),
      over: (target) => formatMessage({ id: "layout.sideSection.dragOver" }, { name: title, target: describe(target) }),
      dropped: (target) => formatMessage({ id: "layout.sideSection.dragDropped" }, { name: title, target: describe(target) }),
      cancelled: formatMessage({ id: "layout.sideSection.dragCancelled" }, { name: title }),
      noRoom: formatMessage({ id: "layout.sideSection.noRoomForColumn" }),
    };
    texts.current = said;
    const state = useSideDrag.getState();
    const targets = sideDropTargets(row, useChannelSideLayoutStore.getState().layout, section, state.fit, state.shares ?? undefined);
    const origin = row.getBoundingClientRect();
    boxOf(row, section)?.setAttribute("data-drag-origin", "");
    // Nothing in the row answers the pointer until the drop (index.css): no hover under the hand. The drag reads the pointer from the document.
    row.setAttribute("data-side-dragging", "");
    // An edge too narrow for a new column isn't offered to the keyboard: it hears why once, here.
    const announcement = targets.some((t) => t.fit === "none") ? `${said.pickedUp} ${said.noRoom}` : said.pickedUp;
    useSideDrag.setState({ section, via: activatorEvent instanceof KeyboardEvent ? "keyboard" : "pointer", targets, target: null, row: { element: row, x: origin.left, y: origin.top }, announcement });
  }, [describe, formatMessage]);

  const onDragMove = useCallback(({ activatorEvent, delta }: DragMoveEvent) => {
    const state = useSideDrag.getState();
    if (state.via !== "pointer") return;
    const start = getEventCoordinates(activatorEvent);
    if (!start) return;
    // The place under the pointer.
    const target = targetAt(state.targets, start.x + delta.x, start.y + delta.y);
    if (target === state.target) return;
    useSideDrag.setState(target?.fit === "none" ? { target, announcement: texts.current?.noRoom ?? "" } : { target });
  }, []);

  const finish = useCallback((commit: boolean) => {
    const { section, target, via, row } = useSideDrag.getState();
    if (!section) return;
    if (row) {
      boxOf(row.element, section)?.removeAttribute("data-drag-origin");
      row.element.removeAttribute("data-side-dragging");
    }
    const said = texts.current;
    if (!commit || !target || target.fit === "none" || !row) {
      closeRoom();
      // Put back where it was (Escape, a refused place, or released over no place): a screen reader hears so.
      useSideDrag.setState({ ...IDLE, announcement: said?.cancelled ?? "" });
      return;
    }
    const head = headOf(section);
    if (head) {
      landing.current = { node: head, rect: toClientRect(target.landing) };
      setTimeout(() => {
        if (landing.current?.node === head) landing.current = null;
      }, DRAG_SETTLE.duration + 100);
    }
    // Measured as drawn now (giving the gap room), then the gap closes: the reflow slides them on from there.
    const slide = slideSections(row.element, section);
    closeRoom();
    useChannelSideLayoutStore.getState().moveSection(section, target.drop);
    requestAnimationFrame(slide);
    // A move can put the section's head into another element: the keyboard stays on its grip, without its tooltip
    // popping up over the row (the person didn't move there; the drop is announced).
    if (via === "keyboard") {
      requestAnimationFrame(() => {
        const grip = gripOf(section);
        if (!grip) return;
        quietGrip = section;
        grip.focus();
      });
    }
    useSideDrag.setState({ ...IDLE, announcement: said?.dropped(target) ?? "" });
  }, []);
  const onDragEnd = useCallback(() => finish(true), [finish]);
  const onDragCancel = useCallback(() => finish(false), [finish]);

  const accessibility = useMemo(() => ({
    announcements: SILENT,
    screenReaderInstructions: { draggable: formatMessage({ id: "layout.sideSection.dragInstructions" }) },
  }), [formatMessage]);

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      measuring={measuring}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <SideSectionLift />
      {refused ? <DragRefusalHint>{formatMessage({ id: "layout.sideSection.noRoomForColumn" })}</DragRefusalHint> : null}
    </DndContext>
  );
}

/**
 * What the hand holds: a compact copy of the head, its icon and title, at most
 * 240px, the grab point kept inside it. Follows dnd-kit's active section, so
 * the copy is still there to glide in after the drop.
 */
function SideSectionLift() {
  const { formatMessage } = useIntl();
  const { active } = useDndContext();
  const section = (active?.id ?? null) as ChannelSideSection | null;
  const [width, setWidth] = useState(PROXY_MAX_WIDTH);
  const modifiers = useMemo(() => [keepGrabInside(width)], [width]);
  const measure = useCallback((element: HTMLElement | null) => {
    const measured = element?.parentElement?.offsetWidth;
    if (measured) setWidth(measured);
  }, []);
  return (
    // No auto-scroll: the places are measured once, when the drag starts, and nothing under them may move.
    <DragLift container={document.body} modifiers={modifiers} autoScroll={false} className="inline-flex size-auto min-h-10 max-w-60 items-center gap-2 px-3">
      {section ? (
        <>
          <span ref={measure} className="flex shrink-0 text-foreground-muted [&_svg]:size-4">
            {section === "thread" ? <ThreadIcon /> : section === "tasks" ? <ListTodo /> : section === "files" ? <Paperclip /> : section === "artifact" ? <FileText /> : <UserRound />}
          </span>
          <span className="truncate text-subhead font-semibold text-foreground" data-testid="side-section-proxy">{formatMessage({ id: sectionTitleId(section) })}</span>
        </>
      ) : null}
    </DragLift>
  );
}

// ---------------------------------------------------------------- the head

/** What a section's head needs to carry its handle: spread on its PanelHeader, the grip inside it. */
export interface SideSectionHead {
  props: { className?: string; "data-side-head"?: string };
  grip: ReactNode;
}

// Only the grip is the handle (raft-design drag-and-drop.md, The handle: a content panel is picked up by its grip;
// its head keeps its clicks); hovering the head shows the grip's bar.
const HEAD_CLASS = "group/head relative";
// The thread's head is also a size container, so its grip can narrow when the head does (THREAD_GRIP_NARROW_CLASS).
const THREAD_HEAD_CLASS = `${HEAD_CLASS} @container/thread-head`;
// Kirby: a thread head under 448px takes a 48x24 grip, not 96x24; the bar narrows to 32px with it, so the target
// stays wider than the bar on both sides (drag-and-drop.md, The handle). A container query measures the content
// box: 408px is a 448px head less its 20px sides (PanelHeader's px-5). Tasks' and Files' heads keep the 96x24 grip.
const THREAD_GRIP_NARROW_CLASS = "@max-[408px]/thread-head:w-12 @max-[408px]/thread-head:before:w-8";
const NO_HEAD: SideSectionHead = { props: {}, grip: null };

/**
 * A section's head with its drag handle, where sections can be moved and this
 * one stands in the row (`movable`): the grip at the top of the head, for a
 * pointer, a finger and the keyboard; the rest of the head is not a handle.
 * The draggable is the grip's: dnd-kit renders its holder on every pointer
 * move, which the hosts (the thread's whole panel, a card, a region) must not.
 */
export function useSideSectionHead(section: ChannelSideSection | null, movable: boolean): SideSectionHead {
  const enabled = useSideDrag((s) => s.enabled) && movable && section !== null;
  return useMemo<SideSectionHead>(() => (enabled ? {
    props: { className: section === "thread" ? THREAD_HEAD_CLASS : HEAD_CLASS, "data-side-head": section! },
    grip: <SideSectionGrip section={section!} />,
  } : NO_HEAD), [enabled, section]);
}

/**
 * The grip on a section's head, its only handle: a 96×24 target centred on
 * the head's top edge (WCAG's 24px minimum, wider than the bar so it needn't
 * be aimed at), starting below the band of the seam above it (6px, 12px by
 * touch: ChannelSideArea's StackSeam), so a press on the line between two
 * stacked sections resizes them and never picks the lower one up; the bar is
 * drawn inside it (2px from its top), so pressing the bar one sees picks the
 * section up rather than resizing; hovering the head shows the 56×4 bar, "Drag to move". On a
 * thread head under 448px the target is 48×24 and the bar 32×4. The
 * grab cursor is here only. Space picks the section up from the keyboard.
 *
 * It holds the section's draggable: the grip is its activator, the head it
 * stands in (`[data-side-head]`, what the drag measures and the glide lands)
 * its node. Memoized: only this leaf renders while it is dragged. A head with
 * its column's tabs (#189 rule 4) has no grip but stays the draggable node, so
 * a drop that leaves it so still glides onto it.
 */
const SideSectionGrip = memo(function SideSectionGrip({ section }: { section: ChannelSideSection }) {
  const { formatMessage } = useIntl();
  const dragging = useSideDrag((s) => s.section === section);
  const tabs = useRowPlanStore((s) => rowTabsOf(s.plan, s.active, section) !== null);
  const { setNodeRef, setActivatorNodeRef, listeners } = useDraggable({ id: section });
  const headRef = useCallback((element: HTMLElement | null) => {
    setNodeRef(element?.closest<HTMLElement>("[data-side-head]") ?? null);
  }, [setNodeRef]);
  const gripRef = useCallback((element: HTMLElement | null) => {
    setActivatorNodeRef(element);
    headRef(element);
  }, [headRef, setActivatorNodeRef]);
  const title = formatMessage({ id: sectionTitleId(section) });
  // Picked up by keyboard and the focus moves away: the drag is cancelled, not left armed.
  const onBlur = useCallback(() => {
    if (quietGrip === section) quietGrip = null;
    const state = useSideDrag.getState();
    if (state.section === section && state.via === "keyboard") cancelDrag();
  }, [section]);
  // Focused back by a keyboard drop: no tooltip (a hover still shows it).
  const onOpenChange = useCallback((open: boolean, details: { reason: string; cancel: () => void }) => {
    if (open && details.reason === "trigger-focus" && quietGrip === section) details.cancel();
  }, [section]);
  if (tabs) return <span hidden ref={headRef} />;
  return (
    // No tooltip while it is held: an open one would take the Escape that cancels the drag.
    <Tooltip content={formatMessage({ id: "layout.sideSection.move" })} trackCursorAxis="x" disabled={dragging} onOpenChange={onOpenChange}>
      <div
        ref={gripRef}
        role="button"
        tabIndex={0}
        aria-label={formatMessage({ id: "layout.sideSection.moveNamed" }, { name: title })}
        aria-roledescription={formatMessage({ id: "layout.sideSection.roleDescription" })}
        aria-pressed={dragging}
        aria-describedby="side-section-drag-instructions"
        data-testid={`side-section-grip-${section}`}
        data-side-grip=""
        data-dragging={dragging ? "true" : undefined}
        className={`absolute top-1.5 left-1/2 z-float h-6 w-24 -translate-x-1/2 cursor-grab touch-none select-none outline-none pointer-coarse:top-3 before:pointer-events-none before:absolute before:top-[2px] before:left-1/2 before:h-1 before:w-14 before:-translate-x-1/2 before:rounded-full before:bg-transparent before:transition-colors before:duration-150 before:content-[''] group-hover/head:before:delay-150 group-hover/head:before:bg-line-seam data-[dragging=true]:before:bg-foreground-muted focus-visible:keyboard:before:bg-foreground${section === "thread" ? ` ${THREAD_GRIP_NARROW_CLASS}` : ""}`}
        onPointerDown={listeners?.onPointerDown as ((event: ReactPointerEvent<HTMLDivElement>) => void) | undefined}
        onTouchStart={listeners?.onTouchStart as ((event: ReactTouchEvent<HTMLDivElement>) => void) | undefined}
        onKeyDown={listeners?.onKeyDown as ((event: ReactKeyboardEvent<HTMLDivElement>) => void) | undefined}
        onBlur={onBlur}
      />
    </Tooltip>
  );
});

/** How a place reads to a screen reader. */
function useDescribe() {
  const { formatMessage, formatList } = useIntl();
  return useCallback((target: SideDropTarget) => {
    const name = (section: ChannelSideSection) => formatMessage({ id: sectionTitleId(section) });
    const d = target.description;
    if (d.kind === "above") return formatMessage({ id: "layout.sideSection.targetAbove" }, { section: name(d.section) });
    const sections = formatList(d.sections.map(name), { type: "conjunction" });
    if (d.kind === "bottom") return formatMessage({ id: "layout.sideSection.targetBottom" }, { sections });
    return formatMessage({ id: d.side === "left" ? "layout.sideSection.targetNewLeft" : "layout.sideSection.targetNewRight" }, { sections });
  }, [formatList, formatMessage]);
}

/** What a screen reader hears, and the dashed area where the dragged section will stand. */
export function SideDragLayer() {
  const { formatMessage } = useIntl();
  const target = useSideDrag((s) => s.target);
  const row = useSideDrag((s) => s.row);
  const announcement = useSideDrag((s) => s.announcement);
  // A place in a column: the column makes room for it, and the dashed area is drawn in the gap it opens.
  const [gap, setGap] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setGap(openRoom(row?.element ?? null, target)), [row, target]);
  useLayoutEffect(() => closeRoom, []);
  useDropGiveWay(row?.element ?? null, target && target.fit !== "none" ? target.giveWay : undefined);
  // A new column's strip at the edge; a refused place shows none (the reason by the pointer says why).
  const area = target && target.fit !== "none" && !target.room ? target.area : null;
  return (
    <>
      <span id="side-section-drag-instructions" hidden>{formatMessage({ id: "layout.sideSection.dragInstructions" })}</span>
      <span className="sr-only" aria-live="assertive" data-testid="side-section-drag-status">{announcement}</span>
      {area && row ? createPortal(
        // In the row (`relative`), in its px at the drag's start, 4px inside the place so the lines read; opaque.
        <div
          data-testid="side-section-drop-slot"
          data-place={target!.drop.kind === "newColumn" ? "column" : "section"}
          // Over the heads' buttons (index.css lifts them to z-chrome for the grip), so nothing live stands on it.
          className="pointer-events-none absolute z-cover"
          style={{ left: area.x - row.x + 4, top: area.y - row.y + 4, width: Math.max(0, area.width - 8), height: Math.max(0, area.height - 8) }}
        >
          <DropPlaceholder opaque className="absolute inset-0 rounded-none" />
        </div>,
        row.element,
      ) : null}
      {gap ? createPortal(<DropPlaceholder opaque className="absolute inset-1 rounded-none" />, gap) : null}
    </>
  );
}
