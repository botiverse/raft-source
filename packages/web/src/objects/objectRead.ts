import { useEffect, useRef } from "react";
import type { ObjectInboxItem, SummarizedObjectKind } from "@botiverse/raft-shared";
import { showObjectReadHere, useInboxStore } from "../store/inboxStore";
import { canAutoMarkCurrentChannelRead } from "../store/messageStore";

/**
 * Core's side of "if I can see it, it's read" for an app's object
 * (#triage:#157): the app says what it shows, core owns the Activity row and
 * the rule for when shown means read (the same as a thread's: a page that is
 * visible and focused). An app never reads the Activity store itself.
 */

/**
 * The object was just read on the server where the app showed it (its viewer
 * route reads it): its Activity row shows read at once, as an Activity read
 * would, rather than at the next inbox answer. Writes nothing.
 */
export function showObjectReadWhereShown(objectKind: SummarizedObjectKind, objectId: string): void {
  showObjectReadHere(objectKind, objectId);
}

/**
 * While `enabled` (the app shows the object's newest content), its Activity
 * row turning unread is read when the page is seen, if `onScreen` says what
 * the row is unread for has rendered (an Artifact viewer: the row's comment,
 * in a thread it shows; never a new version it only offers). Never a row
 * with an unread mention: that is the person's to act on. Checked now, on
 * every Activity change, when the page is seen again (back to the tab, or
 * focus back from a frame), and after each render that gives a new
 * `onScreen` (keep it memoized on what is shown). A read can't go out twice:
 * `markRead` shows the row read (and holds it read) before its request, so
 * the next check finds it read. One that failed brings the row back unread;
 * that frontier is not tried again on Activity changes, only when a newer
 * event arrives or the page is seen again.
 */
export function useReadObjectWhileShown<K extends SummarizedObjectKind>(
  objectKind: K,
  objectId: string,
  enabled: boolean,
  onScreen: (row: ObjectInboxItem<K>) => boolean,
): void {
  // Kept across re-subscriptions (a new `onScreen` after each refresh): a failed frontier waits.
  const tried = useRef<{ objectId: string; frontier: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const readIfSeen = (seenAgain: boolean) => {
      const { items, markRead } = useInboxStore.getState();
      const row = items.find((item): item is ObjectInboxItem<K> => item.kind === "object" && item.objectKind === objectKind && item.objectId === objectId);
      if (!row || row.unreadCount <= 0 || row.hasMention || !onScreen(row)) return;
      if (!seenAgain && tried.current?.objectId === objectId && tried.current.frontier === row.doneFrontierSeq) return;
      if (!canAutoMarkCurrentChannelRead(document, undefined, "thread")) return;
      tried.current = { objectId, frontier: row.doneFrontierSeq };
      void markRead(row);
    };
    const onActivityChange = () => readIfSeen(false);
    const onSeenAgain = () => readIfSeen(true);
    onActivityChange();
    const unsubscribe = useInboxStore.subscribe(onActivityChange);
    document.addEventListener("visibilitychange", onSeenAgain);
    window.addEventListener("focus", onSeenAgain);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onSeenAgain);
      window.removeEventListener("focus", onSeenAgain);
    };
  }, [objectKind, objectId, enabled, onScreen]);
}
