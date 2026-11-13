import { createContext, useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { Message } from "../../store/messageStore";
import { useSelectionStore } from "../../store/selectionStore";
import type { MessageTimelineHandle } from "./MessageTimeline";
import { isRangeSelectableMessage, messageIdsInRange } from "./messageRangeSelection";

export interface MessageSelectIntent {
  /**
   * Toggle the row, or (`range`: Shift+click) add every selectable message
   * from the anchor to it. A range that cannot be formed (no anchor, the
   * anchor no longer in the timeline) adds the row alone: a range gesture
   * never deselects.
   */
  select: (messageId: string, options?: { range?: boolean }) => void;
}

/**
 * What a row in select mode asks for. A row only states the intent; the
 * surface that owns the timeline (ChatPanel, the thread panel) answers it with
 * the timeline's order. Without a provider a row toggles itself, and a range
 * adds it alone.
 */
export const MessageSelectIntentContext = createContext<MessageSelectIntent | null>(null);

/**
 * The select intent of a surface: the order is its timeline's
 * (`MessageTimelineHandle.getMessages`), which counts every loaded message,
 * mounted or not. `isSelectable` narrows what a range takes (default:
 * isRangeSelectableMessage).
 */
export function useMessageSelectIntent(
  timelineRef: RefObject<MessageTimelineHandle | null>,
  isSelectable: (message: Message) => boolean = isRangeSelectableMessage,
): MessageSelectIntent {
  const isSelectableRef = useRef(isSelectable);
  isSelectableRef.current = isSelectable;
  const rangeTo = useCallback((messageId: string): string[] | null => {
    const store = useSelectionStore.getState();
    if (!store.isActive) return null;
    const messages = timelineRef.current?.getMessages() ?? [];
    const byId = new Map(messages.map((message) => [message.id, message]));
    return messageIdsInRange(
      messages.map((message) => message.id),
      store.anchorId,
      messageId,
      (id) => {
        const message = byId.get(id);
        return !!message && isSelectableRef.current(message);
      },
    );
  }, [timelineRef]);
  const select = useCallback((messageId: string, options?: { range?: boolean }) => {
    const store = useSelectionStore.getState();
    if (!store.isActive) return;
    if (!options?.range) {
      store.toggle(messageId);
      return;
    }
    store.selectRange(rangeTo(messageId) ?? [messageId], messageId);
  }, [rangeTo]);
  return useMemo(() => ({ select }), [select]);
}
