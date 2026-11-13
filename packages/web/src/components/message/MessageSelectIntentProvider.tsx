import { useMemo } from "react";
import type { ReactNode, RefObject } from "react";
import type { MessageTimelineHandle } from "./MessageTimeline";
import { rangeSelectablePredicate } from "./messageRangeSelection";
import { MessageSelectIntentContext, useMessageSelectIntent } from "./messageSelectIntent";

/**
 * Provides a surface's select intent to the rows of its timeline. A thread
 * gives `selectableIds` (what its select-all takes: no hidden parent); a
 * channel takes isRangeSelectableMessage.
 */
export function MessageSelectIntentProvider({
  timelineRef,
  selectableIds,
  children,
}: {
  timelineRef: RefObject<MessageTimelineHandle | null>;
  selectableIds?: readonly string[];
  children: ReactNode;
}) {
  const isSelectable = useMemo(() => rangeSelectablePredicate(selectableIds), [selectableIds]);
  const intent = useMessageSelectIntent(timelineRef, isSelectable);
  return <MessageSelectIntentContext.Provider value={intent}>{children}</MessageSelectIntentContext.Provider>;
}
