import { markBootMilestone } from "../boot/bootTiming";
import { forgetScroll, recallPersistedScrollMessageId } from "../components/message/messageTimelineShared";
import { useMessageStore } from "./messageStore";
import { useServerStore } from "./serverStore";

export type ChannelWindowChoice =
  | { kind: "message"; messageId: string }
  | { kind: "remembered"; messageId: string }
  | { kind: "latest" };

/** Which window opening this conversation loads: the linked message's, the remembered scroll position's, or the latest page. */
export function channelWindowChoice(channelId: string, focusMessageId: string | null): ChannelWindowChoice {
  if (focusMessageId) return { kind: "message", messageId: focusMessageId };
  const persistedId = recallPersistedScrollMessageId(`channel:${channelId}`);
  return persistedId ? { kind: "remembered", messageId: persistedId } : { kind: "latest" };
}

/** The window most recently opened, while its load is under way. */
let latest: { key: string; load: Promise<void> } | null = null;
/** The page load's first window open is timed (boot timing messages_sent / messages). */
let firstOpenTimed = false;

/**
 * Opening a conversation loads one window: around a linked message (`msg=`),
 * around the remembered scroll position, or the latest page. ChatPanel opens
 * it on mount; the route preload (preloadServerRoute) can open the same window
 * earlier. Both come here, so the choice is made once, and opening the window
 * that is still loading as the latest one joins that load instead of starting
 * (and discarding) another. Any other window opened in between, or a switch
 * of who is signed in, makes the next opening a new load (the store follows
 * the last opening).
 */
export function openChannelWindow(channelId: string, focusMessageId: string | null): Promise<void> {
  const store = useMessageStore.getState();
  // A load is read for one person (receiver-private ingress): another person's is not joined.
  const key = `${useServerStore.getState().serverEpoch}:${store.currentUserId ?? ""}:${channelId}:${focusMessageId ?? ""}`;
  if (latest?.key === key) return latest.load;
  const choice = channelWindowChoice(channelId, focusMessageId);
  const timed = !firstOpenTimed;
  firstOpenTimed = true;
  if (timed) markBootMilestone("messages_sent");
  const load = choice.kind === "message"
    ? store.loadMessageContext(channelId, choice.messageId)
    : choice.kind === "remembered"
      ? store.loadMessageWindowSilent(channelId, choice.messageId)
      : store.loadMessages(channelId);
  // Whichever window it is (latest, remembered, linked), and also when it failed.
  if (timed) void load.then(() => markBootMilestone("messages"), () => markBootMilestone("messages"));
  const entry = { key, load: load.finally(() => {
    if (latest === entry) latest = null;
  }) };
  latest = entry;
  return entry.load;
}

/**
 * Back to the latest page (Back to bottom): the remembered position is
 * forgotten first, so this opening and the ones that join it (ChatPanel's
 * load effect, rerun when the click drops `msg=`) are the latest page.
 */
export function openLatestChannelWindow(channelId: string): Promise<void> {
  forgetScroll(`channel:${channelId}`);
  return openChannelWindow(channelId, null);
}

export function __resetChannelWindowOpenForTest(): void {
  latest = null;
  firstOpenTimed = false;
}
