/**
 * Which mounted chat owns `currentChannelId` (#triage:#483). Live appends are
 * read when they land in the current channel near its bottom, so the current
 * channel must be one the person sees. A ChatPanel takes it over when it loads
 * (messageStore.loadMessages and friends), but nothing gave it back when that
 * panel went away: open the assistant popover over #general and close it, and
 * the hidden assistant DM stayed current (its new messages read unseen) while
 * #general's new messages piled up unread in view, because #general's panel
 * never reloaded (its channel did not change).
 *
 * Every mounted ChatPanel registers here. When one unmounts while its channel
 * is still current, and no other mounted panel shows that channel, the window
 * goes back to the most recently registered panel still mounted, from its own
 * cached bucket and window meta, without reloading it (its scroll position and
 * context window stay as they were). When that cache cannot stand in (the
 * panel's own load was cut off by the takeover, or live rows left a hole in
 * its list), the panel reopens its window the way it opened it (`reopen`: a
 * `?msg=` jump, a remembered position or the latest page), not the latest page.
 *
 * The hand-back runs on a microtask: a StrictMode remount, or a panel whose
 * channel changes (cleanup, then a load that takes the window), has registered
 * again or taken the window by then, and nothing changes. A window someone
 * else took meanwhile (a route preload for the next page) is left alone.
 */
import { selectChannelMessageBucket, selectChannelWindowMeta, useMessageStore } from "./messageStore";

interface ChatReadOwner {
  channelId: string;
  isNearBottom: () => boolean;
  /** Opens this panel's window again, as its own channel load does. */
  reopen: () => void;
}

const owners: ChatReadOwner[] = [];

/** Registers a shown chat for `channelId`; the returned function unregisters it. */
export function claimChatReadOwner(
  channelId: string,
  hooks: { isNearBottom: () => boolean; reopen: () => void },
): () => void {
  const owner: ChatReadOwner = { channelId, ...hooks };
  owners.push(owner);
  return () => {
    const index = owners.indexOf(owner);
    if (index < 0) return;
    owners.splice(index, 1);
    queueMicrotask(() => handBack(channelId));
  };
}

function handBack(leftChannelId: string): void {
  const store = useMessageStore.getState();
  if (store.currentChannelId !== leftChannelId) return;
  if (owners.some((owner) => owner.channelId === leftChannelId)) return;
  const next = owners.at(-1);
  if (!next) return;
  const meta = selectChannelWindowMeta(store, next.channelId);
  if (meta.loading || !store.historyFetchedChannels[next.channelId]) {
    // The takeover superseded its load (a latest page still lands on the
    // bucket, but a context or remembered window would not be shown), or live
    // rows left a hole in its list: its cache is not its window, so reopen it.
    next.reopen();
    return;
  }
  useMessageStore.setState({
    currentChannelId: next.channelId,
    messages: selectChannelMessageBucket(store, next.channelId),
    loading: false,
    loadingOlder: meta.loadingOlder,
    loadingNewer: meta.loadingNewer,
    loadingGap: meta.loadingGap ?? false,
    hasMore: meta.hasMore,
    hasNewer: meta.hasNewer,
    hasGap: meta.hasGap ?? false,
    historyLimited: meta.historyLimited,
    contextLoadError: meta.contextLoadError,
    isNearBottom: next.isNearBottom(),
  });
  // What arrived while the other chat held the window is in view now.
  useMessageStore.getState().markCurrentChannelRead();
}
