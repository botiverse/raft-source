import { useCallback, useMemo } from "react";
import type { InboxItem } from "../../store/inboxStore";
import { useThreadStore } from "../../store/threadStore";

export interface ActiveThreadTarget {
  openParentChannelId: string | null;
  openParentMessageId: string | null;
  openThreadChannelId: string | null;
}

export function isInboxItemActive(
  item: InboxItem,
  thread: ActiveThreadTarget,
): boolean {
  if (item.kind === "thread") {
    // `openThread()` sets the parent anchor immediately, before the
    // create-or-get call resolves a concrete threadChannelId. Keep the row
    // active during that optimistic window; threads are parent-message scoped,
    // so parentChannelId + parentMessageId is the stable fallback key.
    return item.threadChannelId === thread.openThreadChannelId
      || (item.parentChannelId === thread.openParentChannelId && item.parentMessageId === thread.openParentMessageId);
  }
  // Channel, DM, and mention-action rows navigate away from the Activity route
  // when opened, so there is no Activity row left on screen to keep active.
  return false;
}

export function useIsItemActive() {
  const openParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const openParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const openThreadChannelId = useThreadStore((s) => s.openThreadChannelId);

  const thread = useMemo(
    () => ({ openParentChannelId, openParentMessageId, openThreadChannelId }),
    [openParentChannelId, openParentMessageId, openThreadChannelId],
  );

  return useCallback((item: InboxItem) => isInboxItemActive(item, thread), [thread]);
}
