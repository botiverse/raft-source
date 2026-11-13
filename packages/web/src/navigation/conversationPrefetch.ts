/**
 * Fetch-at-click for a conversation (#triage:8c0d2318): a navigation to a
 * channel, a DM or a message in one (useAppNavigate) sends the read for the
 * window the conversation's view (ChatPanel) is about to open, with the same
 * choice (chatPanelHelpers' `msg=` focus, channelWindowOpen's window), so it
 * goes out at the click, in parallel with rendering. The view's loader takes
 * it (messagePagePrefetch.ts); nothing in the store changes at the click.
 *
 * Only for a view that will read: a conversation already in the channel list
 * (one still to be resolved may not open, see ChannelById / DmById), not the
 * one already on screen (its view does not load again). A cached latest page
 * is read too: the view shows it at once and refreshes it with that read
 * (loadMessages takes it either way), so the refresh no longer waits for the
 * render. A linked message already in a fetched list is not: its view reads
 * nothing (loadMessageContext's cache hit).
 *
 * A thread link (`thread=`) opens through threadStore.openThread, which the
 * URL sync calls only after the route rendered: its replies' read is sent
 * here at the click when the thread's channel is known, and openThread's own
 * send of the same read joins it (threadRepliesPrefetch.ts).
 */
import { resolveChatPanelQueryFocusMessageId } from "../features/channel/chatPanelHelpers";
import { channelWindowChoice } from "../store/channelWindowOpen";
import type { ChannelWindowChoice } from "../store/channelWindowOpen";
import { useChannelStore } from "../store/channelStore";
import { useMessageStore } from "../store/messageStore";
import { latestPageRequest, messageWindowRequest, prefetchMessagePage } from "../store/messagePagePrefetch";
import { prefetchThreadReplies } from "../store/threadRepliesPrefetch";
import { useThreadStore } from "../store/threadStore";
import { addViewSwitchMatch, threadView } from "../observability/viewSwitchSpan";

const CONVERSATION_ROUTE = /\/(channel|dm)\/([^/]+)\/?$/;

function conversationOf(pathname: string): string | null {
  const route = CONVERSATION_ROUTE.exec(pathname);
  return route ? decodeURIComponent(route[2]!) : null;
}

function knownConversation(kind: "channel" | "dm", conversationId: string): boolean {
  const { channels, dmChannels, loungeChannels } = useChannelStore.getState();
  const has = (list: readonly { id: string }[] | undefined) => !!list?.some((row) => row.id === conversationId);
  return kind === "dm" ? has(dmChannels) : has(channels) || has(dmChannels) || has(loungeChannels);
}

/**
 * Whether the loader opening this window reads: always for the latest page
 * (a fetched tail is shown and refreshed) and a remembered position; for a
 * linked message only when it is not in a fetched list (loadMessageContext).
 */
function windowReads(channelId: string, choice: ChannelWindowChoice): boolean {
  if (choice.kind !== "message") return true;
  const state = useMessageStore.getState();
  const cached = state.channelMessages[channelId];
  const fetched = !!state.historyFetchedChannels[channelId] && !!cached && cached.length > 0;
  return !(fetched && cached.some((message) => message.id === choice.messageId));
}

/**
 * `thread=<parent channel>:<parent message>` (as rightPanelUrlSync reads it):
 * the replies' first read, when the thread's channel is known and it is not
 * the thread already open (whose panel does not load again). Not a task
 * dialog's (`task=1`), which opens its own slot.
 */
function prefetchThreadForLink(params: URLSearchParams): void {
  const thread = params.get("thread");
  const separator = thread ? thread.indexOf(":") : -1;
  if (!thread || separator <= 0 || params.get("task") === "1") return;
  const parentChannelId = thread.slice(0, separator);
  const parentMessageId = thread.slice(separator + 1);
  if (!parentMessageId) return;
  const threads = useThreadStore.getState();
  if (threads.openParentChannelId === parentChannelId && threads.openParentMessageId === parentMessageId) return;
  const threadChannelId = threads.summaries[parentMessageId]?.threadChannelId
    ?? threads.followedThreads.find((row) => row.parentMessageId === parentMessageId)?.threadChannelId
    ?? null;
  if (!threadChannelId) return;
  const focusedMessageId = params.get("msg");
  // Counted for the thread's switch (begun by the navigation) before it is sent.
  addViewSwitchMatch(threadView(parentMessageId), threadChannelId);
  prefetchThreadReplies(threadChannelId, parentMessageId, focusedMessageId && focusedMessageId !== parentMessageId ? focusedMessageId : null);
}

/** Called with the app path a navigation is about to commit, and the path on screen, before it renders. */
export function prefetchConversationForPath(path: string, currentPathname: string): void {
  try {
    const url = new URL(path, "http://raft.invalid");
    const route = CONVERSATION_ROUTE.exec(url.pathname);
    if (!route) return;
    const kind = route[1] as "channel" | "dm";
    const conversationId = decodeURIComponent(route[2]!);
    if (!useMessageStore.getState().currentUserId) return;
    prefetchThreadForLink(url.searchParams);
    if (conversationOf(currentPathname) === conversationId) return;
    if (!knownConversation(kind, conversationId)) return;
    const store = useMessageStore.getState();
    if (!store.currentUserId) return;
    const focusMessageId = resolveChatPanelQueryFocusMessageId(url.searchParams);
    // ChatPanel's transient focus (a jump queued for this conversation) loads its own window instead.
    if (!url.searchParams.get("thread") && !focusMessageId && store.transientFocusRequest?.channelId === conversationId) return;
    const choice = channelWindowChoice(conversationId, focusMessageId);
    if (!windowReads(conversationId, choice)) return;
    prefetchMessagePage(
      choice.kind === "latest" ? latestPageRequest(conversationId) : messageWindowRequest(conversationId, choice.messageId),
      store.currentUserId,
      store.channelMessages[conversationId],
    );
  } catch {
    // The view loads on mount, as before.
  }
}
