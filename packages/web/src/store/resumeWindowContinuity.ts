/**
 * #triage:#244: a conversation's loaded messages are one continuous segment
 * only while this tab received every message for it. While the socket is
 * down it receives none, and `sync:resume` brings them back; if the resume is
 * cut short (`hasMore`: past the server's page limit, or `horizonReset`),
 * only the scopes on screen are re-read (socketBridge syncVisibleScopes) and
 * every other loaded list keeps a hole. A live message landing after that
 * hole would make the list look complete (oldest loaded at the read, no
 * newer page), and its projection would count only what is loaded: an
 * Activity row served with 53 unread was lowered to 1 (projectionProvesLowering
 * takes a complete window holding the row's activity message as proof).
 *
 * So on each connect the loaded lists not on screen are marked as having a
 * gap (channelWindowMeta `hasGap`, which fails canProjectCompleteReadState)
 * until the resume answers: complete, the marks are lifted and the lists
 * projected again; cut short, they stay, and the list is no longer taken as
 * fetched history, so opening it reads the latest page (which clears the
 * gap). The open conversation is not marked: its own gap tracking and the
 * visible-scope re-read cover it.
 */
import { selectChannelWindowMeta, useMessageStore } from "./messageStore";
import type { MessageState } from "./messageStore";

/** Lists this connect marked (they had no gap before), awaiting the resume. */
const heldForResume = new Set<string>();

function withGap(state: MessageState, channelIds: readonly string[], hasGap: boolean): Partial<MessageState> {
  const channelWindowMeta = { ...state.channelWindowMeta };
  for (const channelId of channelIds) channelWindowMeta[channelId] = { ...selectChannelWindowMeta(state, channelId), hasGap };
  return { channelWindowMeta };
}

/** A (re)connect: no message reached this tab since the socket dropped, until the resume answers. */
export function holdLoadedWindowsForResume(): void {
  const state = useMessageStore.getState();
  if (state.lastSeq <= 0) return; // no sync:resume is sent (socketBridge roomsJoined): nothing would lift the marks
  const marked = Object.keys(state.channelMessages).filter((channelId) => channelId !== state.currentChannelId
    && state.channelMessages[channelId]!.length > 0 && !selectChannelWindowMeta(state, channelId).hasGap);
  if (marked.length === 0) return;
  for (const channelId of marked) heldForResume.add(channelId);
  useMessageStore.setState((current) => withGap(current, marked, true));
}

/** The resume answered (after its messages were added): `complete` when it brought everything missed. */
export function settleLoadedWindowsAfterResume(complete: boolean): void {
  const held = [...heldForResume];
  heldForResume.clear();
  const state = useMessageStore.getState();
  if (!complete) {
    const gapped = Object.keys(state.channelMessages).filter((channelId) => channelId !== state.currentChannelId);
    if (gapped.length === 0) return;
    useMessageStore.setState((current) => {
      const historyFetchedChannels = { ...current.historyFetchedChannels };
      for (const channelId of gapped) delete historyFetchedChannels[channelId];
      return { ...withGap(current, gapped, true), historyFetchedChannels };
    });
    return;
  }
  // Only the marks this connect set, on lists not opened (and so re-read) since.
  const lifted = held.filter((channelId) => channelId !== state.currentChannelId && selectChannelWindowMeta(state, channelId).hasGap);
  if (lifted.length === 0) return;
  useMessageStore.setState((current) => withGap(current, lifted, false));
  for (const channelId of lifted) useMessageStore.getState().applyReadStateProjection(channelId);
}

export function __resetResumeWindowContinuityForTests(): void {
  heldForResume.clear();
}
