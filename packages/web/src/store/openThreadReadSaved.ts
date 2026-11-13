/**
 * #244: will a live reply in the open thread be read for good? The panel shows
 * it read ("if I can see it, it's read", visibleConversations), but the read
 * is saved only while the window is in use (canAutoMarkLiveAppendRead, as
 * queueThreadLiveReplyReadSync) and a panel showing the thread is at its
 * bottom with nothing newer loaded (useOpenThreadReadAgain's persistLiveRead).
 * Each panel showing a thread (the side panel, the task modal) reports where
 * it is here; the read is saved when any of them is at its bottom. A thread
 * no panel reports is not.
 */
import { canAutoMarkLiveAppendRead } from "./messageStore";

const panels = new Map<string, Set<() => boolean>>();

/** A panel showing the thread: `atBottom` says whether it is at its bottom with nothing newer loaded. Returns its unregister. */
export function registerOpenThreadPanel(threadChannelId: string, atBottom: () => boolean): () => void {
  // A wrapper of its own, so the same callback registered twice is two panels.
  const panel = () => atBottom();
  const shown = panels.get(threadChannelId) ?? new Set<() => boolean>();
  shown.add(panel);
  panels.set(threadChannelId, shown);
  return () => {
    shown.delete(panel);
    if (shown.size === 0 && panels.get(threadChannelId) === shown) panels.delete(threadChannelId);
  };
}

export function isOpenThreadReadSaved(threadChannelId: string): boolean {
  const shown = panels.get(threadChannelId);
  if (!shown || ![...shown].some((atBottom) => atBottom())) return false;
  return canAutoMarkLiveAppendRead(undefined, undefined, undefined, "thread");
}
