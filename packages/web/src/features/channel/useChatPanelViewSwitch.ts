import { useMessageStore } from "../../store/messageStore";
import { conversationView, useViewSwitchPaint } from "../../observability/viewSwitchSpan";
import type { ViewListState } from "../../observability/viewSwitchSpan";

export interface ChatPanelListShown {
  /** A landed message link whose message can't be shown. */
  unavailable: boolean;
  /** The list is held back for a landed message link (a skeleton). */
  held: boolean;
  loading: boolean;
  hasMessages: boolean;
  forumMode: boolean;
}

/** What the channel's list shows, for `web.view.switch`: a page fetched for it (or its forum activity), not a skeleton or only live rows. */
export function chatPanelListState(shown: ChatPanelListShown, historyFetched: boolean): ViewListState {
  if (shown.unavailable) return "error";
  if (shown.held || (shown.loading && !shown.hasMessages)) return "pending";
  return historyFetched || (shown.forumMode && !shown.loading) ? "data" : "pending";
}

/** End hook of `web.view.switch` for a channel's or DM's message list (observability/viewSwitchSpan.ts). */
export function useChatPanelViewSwitch(channelId: string | null, shown: ChatPanelListShown): void {
  const historyFetched = useMessageStore((s) => (channelId ? Boolean(s.historyFetchedChannels[channelId]) : false));
  useViewSwitchPaint(channelId ? conversationView(channelId) : null, chatPanelListState(shown, historyFetched));
}
