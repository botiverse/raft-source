import { MAIN_COLUMN_MIN_WIDTH } from "../../lib/panelBounds";
import { cascadeSeam, seamReach } from "./seamCascade";
import { expandedRegion, restoreRowExpand } from "../layout/rowPlanStore";
import type { SeamColumn } from "./seamCascade";

/**
 * The layout row's seams (#proj-raft-ui:#189, rule 1): every column in MainLayout's row registers how its width is
 * kept (ColumnResizeHandle for the thread, the section columns and the profile; rowLayout for the conversation), so
 * a drag on any seam can trade width between the two columns beside it and cascade further out (seamCascade). The
 * sidebar is outside the row and keeps its own drag.
 */

/** How one column in the row keeps its width. */
export interface SeamColumnEntry {
  /** `conversation` for the conversation (rowLayout), the column table's id for the others where they have one. */
  key?: string;
  /** The narrowest a drag may take it. */
  min: number;
  /** The width it is remembered at now. */
  get: () => number;
  /** Shows `width` without saving it. */
  preview: (width: number) => void;
  /** Saves `width`. */
  commit: (width: number) => void;
  /** Back to its default width (its seam's double click), where it has one. */
  reset?: () => void;
}

const registry = new Map<HTMLElement, () => SeamColumnEntry>();

/** `entry` is read when a drag starts, so it may close over the column's latest props. Returns the unregister. */
export function registerSeamColumn(element: HTMLElement, entry: () => SeamColumnEntry): () => void {
  registry.set(element, entry);
  return () => {
    if (registry.get(element) === entry) registry.delete(element);
  };
}

/** MainLayout's row (sideCardsLayout ROW_SELECTOR). */
const ROW_SELECTOR = '[data-testid="thread-layout-container"]';

const widthOf = (element: Element) => element.getBoundingClientRect().width;

/** A column standing in the row now: laid out in its flow, on screen, with a width. */
export function standsInRow(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed" && style.visibility !== "hidden" && widthOf(element) > 0;
}

/** The registered columns of `row` standing in it, with the ones registered under `key` only, when given. */
export function rowSeamColumns(row: HTMLElement, key?: string): Array<{ element: HTMLElement; entry: SeamColumnEntry }> {
  const found: Array<{ element: HTMLElement; entry: SeamColumnEntry }> = [];
  for (const [element, read] of registry) {
    if (!row.contains(element)) continue;
    const entry = read();
    if ((key === undefined || entry.key === key) && standsInRow(element)) found.push({ element, entry });
  }
  return found;
}

/** Left to right as they stand (a column and one inside it at the same left: the outer first). */
const byPlace = (a: { element: HTMLElement }, b: { element: HTMLElement }) => {
  const left = a.element.getBoundingClientRect().left - b.element.getBoundingClientRect().left;
  if (left !== 0) return left;
  return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
};

/**
 * Puts the column standing right of `column` in MainLayout's row back to its default width, as its own seam's double
 * click does: a crossing on that seam (StackCorner at a column's right) resets it with the split. Nothing where no
 * registered column stands there.
 */
export function resetColumnAfter(column: HTMLElement | null | undefined): void {
  const row = column?.closest<HTMLElement>(ROW_SELECTOR);
  if (!column || !row) return;
  const standing = rowSeamColumns(row).sort(byPlace);
  const own = standing.findIndex(({ element }) => element === column);
  if (own >= 0) standing[own + 1]?.entry.reset?.();
}

/** A drag (or a key) on one seam of the row. */
export interface SeamDrag {
  /** The dragged column's width when it started, the widest the trade can make it, and its minimum. */
  readonly width: number;
  readonly max: number;
  readonly min: number;
  /** Shows the row with the seam moved `dx` px (right is positive); nothing until the seam has moved. */
  move: (dx: number) => void;
  /** Shows every column at its remembered width again (a snap took over the drag). */
  restore: () => void;
  /** Saves every column's width as shown (rule 1: what shows is what is saved); false when the seam ended where it started. */
  release: () => boolean;
}

const sameWidths = (a: readonly number[], b: readonly number[]) => a.every((width, index) => Math.round(width) === Math.round(b[index]!));

/**
 * The drag on the seam at `edge` of `column`, among the columns standing in MainLayout's row; null outside such a row
 * (the public server page, a test without layout), where the handle drags its own column alone.
 *
 * Where rowLayout lays the row out it registered the conversation, which then trades like any column, down to 160.
 * Where it doesn't (a thread covering the channel, Thread | Profile with the channel folded), `main`, the column the
 * handle takes its width from, takes what the others leave and keeps its 360.
 */
export function startSeamDrag(column: HTMLElement | null | undefined, edge: "left" | "right", main: HTMLElement | null): SeamDrag | null {
  const row = column?.closest<HTMLElement>(ROW_SELECTOR);
  if (!column || !row || !standsInRow(column)) return null;
  const registered = rowSeamColumns(row);
  // The row laid out (rowLayout registered the conversation): it is the conversation, whatever `main` says. Else
  // `main` is the row's remainder: it keeps no width of its own.
  const conversation = registered.find(({ entry }) => entry.key === "conversation")?.element ?? null;
  const flexible = conversation ? null : main;
  const anchor = conversation ?? main;
  const outside = (element: HTMLElement) => !!anchor && element !== anchor && (anchor.contains(element) || element.contains(anchor));
  const members: Array<{ element: HTMLElement; entry: SeamColumnEntry | null }> = registered
    .filter(({ element }) => !outside(element))
    .map(({ element, entry }) => ({ element, entry: element === flexible ? null : entry }));
  if (flexible && row.contains(flexible) && standsInRow(flexible) && !members.some(({ element }) => element === flexible)) members.push({ element: flexible, entry: null });
  members.sort(byPlace);
  const own = members.findIndex(({ element }) => element === column);
  const seam = edge === "left" ? own - 1 : own;
  if (own < 0 || seam < 0 || seam + 1 >= members.length) return null;
  const columns: SeamColumn[] = members.map(({ element, entry }) => ({ width: widthOf(element), min: entry ? entry.min : MAIN_COLUMN_MIN_WIDTH }));
  const start = columns.map((c) => c.width);
  const remembered = members.map(({ entry }) => entry?.get() ?? 0);
  const reach = seamReach(columns, seam);
  let last: number[] | null = null;
  const show = (widths: readonly number[]) => members.forEach(({ entry }, index) => entry?.preview(widths[index]!));
  const restore = () => {
    if (last !== null) show(remembered);
  };
  return {
    width: start[own]!,
    max: start[own]! + (edge === "left" ? reach.left : reach.right),
    min: columns[own]!.min,
    move: (dx) => {
      const next = cascadeSeam(columns, seam, dx);
      if (last === null && sameWidths(next, start)) return;
      // A seam moved in an expanded row starts from the row as it shows (#189 rule 5, the prototype's settle):
      // every column at its shown width, nothing expanded any more.
      const settling = last === null && expandedRegion() !== null;
      last = next;
      show(next);
      if (settling) restoreRowExpand();
    },
    restore,
    release: () => {
      if (last === null) return false;
      if (sameWidths(last, start)) {
        restore();
        return false;
      }
      const shown = last;
      members.forEach(({ entry }, index) => entry?.commit(shown[index]!));
      return true;
    },
  };
}

/**
 * Rule 2: a column standing in the row narrower than its content's minimum is marked `data-clipped`, with its width
 * (`--clip-width`) and that minimum (`--content-min`, which a panel in it may set lower or higher for itself) for
 * index.css: its panels keep their content at that minimum against the column's start edge, clip the rest without a
 * scrollbar and fade over the cut; their heads fit the column. `handle` hidden outside a planned row (the column
 * covering the row on a phone) is not standing in it; in a planned row (rowLayout) the thread folded over the
 * conversation hides its handle and still clips at the conversation's width (rule 3).
 */
export function markClipped(column: HTMLElement, handle: HTMLElement | null, contentMin: number | undefined): void {
  const width = widthOf(column);
  const standing = !handle || getComputedStyle(handle).display !== "none" || column.closest("[data-row-plan]") !== null;
  const clipped = contentMin !== undefined && width > 0 && width < contentMin - 0.5 && standing;
  if (clipped) {
    column.setAttribute("data-clipped", "");
    column.style.setProperty("--clip-width", `${Math.round(width)}px`);
    column.style.setProperty("--content-min", `${contentMin}px`);
  } else if (column.hasAttribute("data-clipped")) {
    column.removeAttribute("data-clipped");
    column.style.removeProperty("--clip-width");
    column.style.removeProperty("--content-min");
  }
}
