import type { Message } from "../../store/messageStore";
import { isRetractedMessage } from "./delegatedMessage";
import { getForwardableMessages } from "./forwardSelectionUtils";

/**
 * The ids a range selection takes: every id in `orderedIds` from the anchor to
 * the target, both included, in list order, whichever comes first. Ids that
 * `isSelectable` rejects are skipped (system messages, action cards, ...).
 *
 * Null when there is no range to take: no anchor, or the anchor or the target
 * is not in `orderedIds` (scrolled out of a context window, another scope).
 * The caller then falls back to a plain toggle.
 *
 * Pure: the order comes from the timeline's data (MessageTimelineHandle
 * `getMessages`), never from which rows are mounted.
 */
export function messageIdsInRange(
  orderedIds: readonly string[],
  anchorId: string | null | undefined,
  targetId: string,
  isSelectable: (id: string) => boolean = () => true,
): string[] | null {
  if (!anchorId) return null;
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) return null;
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return orderedIds.slice(start, end + 1).filter((id) => isSelectable(id));
}

/**
 * A message a range or select-all takes: one the forward composer accepts
 * (not a system update, action card or forwarded bundle) that is not
 * retracted (a retracted row has no checkbox).
 */
export function isRangeSelectableMessage(message: Message): boolean {
  return !isRetractedMessage(message) && getForwardableMessages([message]).messages.length === 1;
}

/**
 * What a surface's range takes: given `selectableIds` (a thread: what its
 * select-all takes, no hidden parent), those messages; otherwise
 * isRangeSelectableMessage.
 */
export function rangeSelectablePredicate(selectableIds?: readonly string[]): (message: Message) => boolean {
  if (!selectableIds) return isRangeSelectableMessage;
  const ids = new Set(selectableIds);
  return (message: Message) => ids.has(message.id);
}

/**
 * Select to here (the floating pill in select mode, task #235): every
 * selectable message from the anchor to the edge of the view furthest from it.
 * The anchor above the view takes down to the last selectable message in view;
 * below it, up to the first. `edgeId` is that message: the next anchor.
 *
 * `direction` is where the anchor is from the view: "up" (above) or "down"
 * (below). Null when there is nothing to take: no anchor, the anchor not in
 * `orderedIds` (out of the loaded window), the anchor in view (`visibleIds`),
 * nothing in view, or no selectable message in view.
 *
 * Pure: `orderedIds` is the timeline's order (MessageTimelineHandle
 * `getMessages`), `visibleIds` what its list has in view
 * (`getVisibleMessageIds`), in any order.
 */
export function idsToViewportEdge(
  orderedIds: readonly string[],
  anchorId: string | null | undefined,
  visibleIds: readonly string[],
  isSelectable: (id: string) => boolean = () => true,
): { ids: string[]; edgeId: string; direction: "up" | "down" } | null {
  if (!anchorId || visibleIds.length === 0) return null;
  const anchorIndex = orderedIds.indexOf(anchorId);
  if (anchorIndex < 0) return null;
  const visible = new Set(visibleIds);
  if (visible.has(anchorId)) return null;
  let first = -1;
  let last = -1;
  orderedIds.forEach((id, index) => {
    if (!visible.has(id) || !isSelectable(id)) return;
    if (first < 0) first = index;
    last = index;
  });
  if (first < 0) return null;
  // The anchor is above the view when it comes before what is in view.
  const direction = anchorIndex < first ? "up" : anchorIndex > last ? "down" : null;
  // Between two rows in view (one hidden by a fold, an unmeasured gap): no
  // side of the view is furthest from it.
  if (!direction) return null;
  const edgeId = orderedIds[direction === "up" ? last : first]!;
  const ids = messageIdsInRange(orderedIds, anchorId, edgeId, isSelectable);
  return ids ? { ids, edgeId, direction } : null;
}
