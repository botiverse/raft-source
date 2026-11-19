import { markBootMilestone } from "../boot/bootTiming";
import { forgetScroll, recallPersistedScrollMessageId } from "../components/message/messageTimelineShared";
import { currentMessageWindowRequestGeneration, latestPageLanded, useMessageStore } from "./messageStore";
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
type OpenWindow = { key: string; load: Promise<void>; preload: boolean; joined: boolean; generation: number };
let latest: OpenWindow | null = null;

/**
 * How long the route preload's settled latest page stands in for ChatPanel's
 * own opening (openChannelWindow, `preload`). The preload and the mount it
 * runs ahead of are one boot, a second or two apart; a mount later than this
 * loads the page itself, so a tab left on the route never shows a page this
 * old as fresh.
 */
export const PRELOAD_WINDOW_KEPT_MS = 10_000;

/**
 * The route preload's latest page, once loaded, until the first opening of
 * the same window takes it (or another window is opened, or it is older than
 * PRELOAD_WINDOW_KEPT_MS). Without it a ChatPanel that mounts just after the
 * preload settled finds nothing in flight and reads the same page again.
 */
let settledPreload: { key: string; channelId: string; load: Promise<void>; settledAt: number; generation: number } | null = null;
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
 *
 * The route preload's opening (`preload`) is also joined once it has loaded:
 * the first opening of the same window after it, within
 * PRELOAD_WINDOW_KEPT_MS of its page landing, takes that page instead of
 * reading it again (ChatPanel often mounts just after the preload settled).
 * The rule: same server epoch, person, conversation and window (a server
 * switch bumps the epoch, so it never matches), the page actually loaded and
 * the conversation still the current one, nothing else opened in between
 * (here, or straight through the message store: any other window load, a
 * channel switch or a server reset claims a new window request generation),
 * and at most PRELOAD_WINDOW_KEPT_MS since it landed. Taken once; ordinary
 * openings are never kept. Rows that arrive after the page come through the
 * socket into the store (message:new; on (re)join, sync:resume from the
 * page's own sync horizon and the visible scopes' gap sync), as they would
 * after ChatPanel's own load.
 */
export function openChannelWindow(channelId: string, focusMessageId: string | null, options: { preload?: boolean } = {}): Promise<void> {
  const store = useMessageStore.getState();
  // A load is read for one person (receiver-private ingress): another person's is not joined.
  const key = `${useServerStore.getState().serverEpoch}:${store.currentUserId ?? ""}:${channelId}:${focusMessageId ?? ""}`;
  if (latest?.key === key) {
    latest.joined = true;
    return latest.load;
  }
  const choice = channelWindowChoice(channelId, focusMessageId);
  const kept = settledPreload;
  settledPreload = null;
  if (kept?.key === key && choice.kind === "latest" && !options.preload && keptPreloadUsable(kept)) return kept.load;
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
  const preload = !!options.preload && choice.kind === "latest";
  // loadMessages claims its window request synchronously, before its first await: this is the preload's own.
  const generation = currentMessageWindowRequestGeneration();
  const entry: OpenWindow = { key, preload, joined: false, generation, load: load.finally(() => {
    if (latest !== entry) return;
    latest = null;
    // Kept only if nothing joined it while it loaded: that opening was the one it ran ahead of.
    if (entry.preload && !entry.joined) settledPreload = { key, channelId, load: entry.load, settledAt: Date.now(), generation };
  }) };
  latest = entry;
  return entry.load;
}

function keptPreloadUsable(kept: { channelId: string; settledAt: number; generation: number }): boolean {
  if (Date.now() - kept.settledAt > PRELOAD_WINDOW_KEPT_MS) return false;
  // Another window load since (a context jump, a socket- or reconnect-driven reload, a server reset): the page is no longer the window shown.
  if (currentMessageWindowRequestGeneration() !== kept.generation) return false;
  // loadMessages settles on a failed read too (over a cached list as well): only its page that landed, in the conversation still open, stands in.
  return useMessageStore.getState().currentChannelId === kept.channelId && latestPageLanded(kept.channelId, kept.generation);
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
  settledPreload = null;
  firstOpenTimed = false;
}
