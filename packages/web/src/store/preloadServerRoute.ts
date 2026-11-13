import { channelWindowChoice, openChannelWindow } from "./channelWindowOpen";
import { useChannelStore } from "./channelStore";
import { recallRootConversation } from "./rootConversation";
import { useServerStore } from "./serverStore";

/**
 * Render-as-you-fetch for the conversation a server URL opens: as soon as the
 * server is current, ask for the conversation and its latest messages
 * together, through the stores' own actions, instead of one after the other
 * as MainLayout, ChannelById and ChatPanel mount. They then find the channel
 * in the store and join the messages load under way (openChannelWindow).
 *
 * The messages only when their window is the latest page: that page reports
 * its own sync horizon, which starts the first sync:resume as the socket's
 * starting horizon would (docs/frontend/boot-requests.md). A `thread=` link's
 * read-marking depends on the thread state MainLayout seeds and a `msg=` link
 * is checked first (useMessageLinkLandingBlock): those only get the
 * conversation, and load their messages as before.
 *
 * The server's root (`/s/<slug>`) gets the conversation it last landed on
 * (rootConversation.ts), and only the conversation: it is a guess until the
 * channel list confirms it, and loading a window opens it in the message
 * store (current conversation, marked read). Its messages come from the boot
 * script's prefetch, which ChatPanel takes once the redirect lands there.
 */
export function preloadServerRoute(pathname: string, search: string, userId: string | null): void {
  const match = /^\/s\/[^/]+(?:\/(?:channel|dm)\/([^/?#]+))?\/?$/.exec(pathname);
  if (!match) return;
  if (match[1] === undefined) {
    const serverId = useServerStore.getState().current?.id;
    const guess = userId && serverId ? recallRootConversation(userId, serverId) : null;
    if (guess) void useChannelStore.getState().ensureChannel(guess, { reason: "preload" });
    return;
  }
  const conversationId = decodeURIComponent(match[1]);
  void useChannelStore.getState().ensureChannel(conversationId, { reason: "preload" });
  const params = new URLSearchParams(search);
  if (!userId || params.has("thread") || params.has("msg")) return;
  if (channelWindowChoice(conversationId, null).kind !== "latest") return;
  void openChannelWindow(conversationId, null);
}
