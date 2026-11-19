import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useChannelStore } from "../store/channelStore";
import { useServerStore } from "../store/serverStore";
import { findStoredChannel } from "../store/storedChannel";
import { movePageLanding } from "../utils/pageLanding";
import { openMessagePlace, taskConversationPlace } from "../utils/messagePlace";
import type { ConversationIdentity } from "../utils/messagePlace";
import { useAppNavigate } from "./useAppNavigate";

/**
 * `/channel/<task conversation>[?msg=…]` is no page of its own: it showed the
 * bare `#task-…` sub-conversation with only a Join that can't work (the
 * server refuses joining one, `thread_membership`). Such links come from a
 * task message's Copy link (the mobile app's, Saved's). Once the channel route
 * knows the conversation is a task's (its row from the fetch the route makes
 * anyway), it takes the task route instead, replacing the link's entry: the
 * task over its channel, the dialog at `msg`, as search and Saved open one.
 *
 * True while it redirects: the route shows its loading state, not the page.
 */
export function useTaskConversationRedirect(channelId: string | undefined): boolean {
  const row = useChannelStore((s) => findStoredChannel(s, channelId)) as ConversationIdentity | undefined;
  const { pathname, search } = useLocation();
  const nav = useAppNavigate();
  const slug = useServerStore((s) => s.current?.slug);
  const messageId = new URLSearchParams(search).get("msg");
  const type = row?.type ?? null;
  const parentChannelId = row?.parentChannelId ?? null;
  const taskId = row?.taskId ?? null;
  const place = useMemo(
    // oxlint-disable-next-line react-doctor/no-event-handler -- No handler sees this: the conversation's row arriving (the route's own fetch) is the event, on a page opened from a link.
    () => (channelId ? taskConversationPlace(channelId, { type, parentChannelId, taskId }, messageId) : null),
    [channelId, type, parentChannelId, taskId, messageId],
  );

  useEffect(() => {
    if (!place || place.kind !== "task") return;
    // The landed link keeps its open-in-app offer on the task route, as the
    // root redirect keeps it (`/s/<slug>` to its first channel).
    movePageLanding(pathname, `${slug ? `/s/${slug}` : ""}/${place.parentRouteKind}/${place.parentChannelId}`);
    openMessagePlace(place, nav, { replace: true });
  }, [place, nav, pathname, slug]);

  return place != null;
}
