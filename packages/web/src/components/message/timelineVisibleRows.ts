import { useCallback, useEffect, useRef } from "react";
import type { VirtualListApi } from "@botiverse/raft-ui";
import { messageTimelineRowKey, VISIBLE_ROW_MIN_PX } from "./messageTimelineShared";
import type { MessageTimelineRow } from "./messageTimelineShared";

// What is in a timeline's view (MessageTimelineHandle getVisibleMessageIds,
// getMessageViewportPosition), from the list's own geometry: each row's offset
// in the spacer (raft-ui VirtualList `getOffsetTopOfKey`: measured, or
// estimated for a row never mounted) against the scroller's scroll position.
// No row is looked up in the DOM, so a row the list has not mounted still
// counts. A row is in view once VISIBLE_ROW_MIN_PX of it (or all of a shorter
// one) is, above the `bottomOcclusion` px the view's bottom has covered.

type View = {
  viewTop: number;
  viewBottom: number;
  /** Where row `index` starts in the scroller's content; past the last row, where the rows end. */
  topOf: (index: number) => number;
};

function viewOf(api: VirtualListApi | null, rows: readonly MessageTimelineRow[], bottomOcclusion: number): View | null {
  const el = api?.listElRef.current;
  const itemsEl = api?.itemsElRef.current;
  if (!api || !el || !itemsEl || rows.length === 0) return null;
  // Where the spacer starts in the scroller's content (below the list's
  // header; lower when a short channel rests on the composer).
  const origin = itemsEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  const viewTop = el.scrollTop;
  const viewBottom = viewTop + el.clientHeight - Math.max(0, bottomOcclusion);
  if (viewBottom <= viewTop) return null;
  const topOf = (index: number): number => (
    index >= rows.length
      ? itemsEl.offsetHeight
      : api.getOffsetTopOfKey(messageTimelineRowKey(rows[index]!)) ?? Number.NaN
  ) + origin;
  return { viewTop, viewBottom, topOf };
}

/** Whether row `index` is in view: enough of it inside the view. */
function inView({ viewTop, viewBottom, topOf }: View, index: number): boolean {
  const top = topOf(index);
  const bottom = topOf(index + 1);
  return Math.min(bottom, viewBottom) - Math.max(top, viewTop) >= Math.min(VISIBLE_ROW_MIN_PX, bottom - top);
}

/** The messages in view, top to bottom. A message folded into another's row is not listed. */
export function visibleMessageIdsOfList(
  api: VirtualListApi | null,
  rows: readonly MessageTimelineRow[],
  bottomOcclusion = 0,
): string[] {
  const view = viewOf(api, rows, bottomOcclusion);
  if (!view) return [];
  // The first row whose bottom (the next row's top) is below the view's top.
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (view.topOf(mid + 1) > view.viewTop) high = mid;
    else low = mid + 1;
  }
  const ids: string[] = [];
  for (let index = low; index < rows.length; index += 1) {
    const top = view.topOf(index);
    if (Number.isNaN(top) || top >= view.viewBottom) break;
    if (!inView(view, index)) continue;
    const row = rows[index]!;
    if (row.kind === "message") ids.push(row.message.id);
    else if (row.kind === "parent" && row.message) ids.push(row.message.id);
  }
  return ids;
}

// Each rows array's row index by key, built once per array (rows are immutable).
const rowIndexes = new WeakMap<readonly MessageTimelineRow[], Map<string, number>>();
function rowIndexOf(rows: readonly MessageTimelineRow[], key: string): number | undefined {
  let byKey = rowIndexes.get(rows);
  if (!byKey) {
    byKey = new Map(rows.map((row, index) => [messageTimelineRowKey(row), index]));
    rowIndexes.set(rows, byKey);
  }
  return byKey.get(key);
}

/**
 * Where the row with `key` is from the view: "above", "below", or "in-view".
 * Null without a view or for no such row. One row's offsets, whatever the
 * length of the list: cheap enough for every scroll frame.
 */
export function rowViewportPositionOfList(
  api: VirtualListApi | null,
  rows: readonly MessageTimelineRow[],
  key: string,
  bottomOcclusion = 0,
): "above" | "below" | "in-view" | null {
  const index = rowIndexOf(rows, key);
  if (index === undefined) return null;
  const view = viewOf(api, rows, bottomOcclusion);
  if (!view) return null;
  const top = view.topOf(index);
  if (Number.isNaN(top)) return null;
  if (inView(view, index)) return "in-view";
  return top < view.viewTop ? "above" : "below";
}

/**
 * The timeline's `onViewportChange` (MessageTimelineProps), as a stable
 * `notify` it calls after a scroll or a resize; called too when `rows` change,
 * when the timeline mounts and when it unmounts.
 */
export function useViewportChangeNotifier(
  onViewportChange: (() => void) | undefined,
  rows: readonly MessageTimelineRow[],
): () => void {
  const callbackRef = useRef(onViewportChange);
  callbackRef.current = onViewportChange;
  const notify = useCallback(() => callbackRef.current?.(), []);
  useEffect(() => { notify(); }, [rows, notify]);
  useEffect(() => notify, [notify]);
  return notify;
}
