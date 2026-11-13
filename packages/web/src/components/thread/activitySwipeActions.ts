import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { toast } from "@botiverse/raft-ui";
import { getInboxItemKey, useInboxStore } from "../../store/inboxStore";
import type { InboxItem, MarkDoneOptions, ObjectActivityItem } from "../../store/inboxStore";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { hasToastManager } from "../toastBridge";
import { onSameServer, serverIdentity, toggleActivityMuteReporting, unfollowActivityThreadOn } from "./inboxRowActions";
import type { ThreadInboxItem } from "./inboxRowActions";
import { trackUndoOffered, trackUndoUsed } from "../../analytics/confirmUndo";

// What a phone's swipe buttons do, and the row's button and menu (Raft DS › Responsive layout › Touch
// screens, raft-design #785), each with an Undo toast (raft-ui's toast with an
// action: 8 seconds, one at a time). As in the App (raft-design #790), an
// action with an exact reverse is applied at once and its Undo applies the
// reverse; Done and Unfollow have none, so they wait for their toast.
//
// Done takes the row out of the list at once. It has no exact reverse in the
// inbox store (a write arms the store's local suppression of the row, which
// only the server can lift), so it waits: the row is hidden and Done is
// written when the toast closes (its 8 seconds, paused while touched or
// focused; swiped away), when another row's action is applied (its toast
// replaces this one), when the page is hidden or left (`visibilitychange`
// to hidden, `pagehide`), or when the list unmounts. Undo only shows the
// row again. A row that gets newer activity while it waits has its Done
// called off at once: the toast goes and the row comes back with its news.
// The write carries the row as it was swiped and its server, so it lands
// though the list changed meanwhile (another filter, scope, sort or search)
// or the person switched servers.
//
// Unfollow takes the row out of the list at once and waits as Done does (the
// same closes write it; Undo only shows the row again). Following again is no
// exact reverse: the server marks a thread read as it unfollows it, and a
// Follow can't make it unread again. Newer activity doesn't call an Unfollow
// off: the person stops following the thread whatever it says next. It is
// written as the menu's is, on the server it was asked on
// (`unfollowActivityThreadOn`). An Unfollow that fails brings the row back.
// An unfollowed thread stays out of this list while it is shown, unless it is
// followed again meanwhile (elsewhere); the store keeps the row in Activity
// history, marked unfollowed, for the next visit.
//
// Mute keeps the row, marked muted: it is applied at once and Undo unmutes,
// after the mute's own save.
//
// An object row's Done (an Artifact's; shared activityObjectsContract) has
// an exact reverse, the contract's undo Done: it is written at once, and its
// Undo writes the undo, after the Done's own save, and shows the row again.
//
// The same Done and Unfollow, with the same Undo, are what the row's Mark as
// Done button and the row menu (right click, press and hold) do: an action
// that takes a row out of the list offers Undo on every route (Raft DS ›
// Feedback, "Confirming"). The menu's other items stay immediate.

/** A swiped Done or Unfollow waiting out its Undo. */
type Pending = {
  action: "done" | "unfollow";
  item: InboxItem;
  key: string;
  token: number;
  toastId: string | null;
  serverId: string | null;
  serverEpoch: number;
};

function listedRow(key: string): InboxItem | undefined {
  return useInboxStore.getState().items.find((candidate) => getInboxItemKey(candidate) === key);
}

/**
 * The row to write a waiting Done for, or null to write nothing. The
 * person acted on what they saw: a row that has moved on since (newer
 * activity) is not written and comes back with its news. A row the store no
 * longer lists is still written, as it was swiped.
 */
export function swipeDoneCommitItem(swiped: InboxItem, current: InboxItem | undefined): InboxItem | null {
  if (!current) return swiped;
  if (current.kind === "mention_action" || swiped.kind === "mention_action") return current;
  if (current.kind === "object" || swiped.kind === "object") {
    return current.kind === "object" && swiped.kind === "object" && current.doneFrontierSeq === swiped.doneFrontierSeq ? current : null;
  }
  const moved = current.latestActivitySeq !== swiped.latestActivitySeq
    || current.doneFrontierSeq !== swiped.doneFrontierSeq;
  return moved ? null : current;
}

export type ActivitySwipeActions = {
  /** Rows out of the list: a Done or Unfollow waiting out its Undo, or unfollowed while it is shown. */
  hiddenKeys: ReadonlySet<string>;
  done: (item: InboxItem) => void;
  unfollow: (item: ThreadInboxItem, conversation: string) => void;
  mute: (channel: Channel, conversation: string) => void;
};

export function useActivitySwipeActions(markDone: (item: InboxItem, options: MarkDoneOptions) => void | Promise<void>): ActivitySwipeActions {
  const { formatMessage } = useIntl();
  /** The row whose Done or Unfollow is waiting out its Undo, if any. */
  const [waitingKey, setWaitingKey] = useState<string | null>(null);
  /** Rows unfollowed by a swipe while this list is shown. */
  const [unfollowedKeys, setUnfollowedKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** Of those, the ones whose Unfollow was saved: a row of theirs followed again (Undo, elsewhere) is shown again. */
  const confirmedUnfollowsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Pending | null>(null);
  const tokenRef = useRef(0);
  const unmountedRef = useRef(false);
  const markDoneRef = useRef(markDone);
  useEffect(() => {
    markDoneRef.current = markDone;
  });

  const showUnfollowedRow = useCallback((key: string) => {
    confirmedUnfollowsRef.current.delete(key);
    setUnfollowedKeys((keys) => {
      if (!keys.has(key)) return keys;
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
  }, []);

  /** Write a waited-out Unfollow. The row stays out while it saves, and comes back if the save fails. */
  const commitUnfollow = useCallback((pending: Pending) => {
    const { item, key } = pending;
    if (item.kind !== "thread") return;
    const sameServer = onSameServer(pending);
    // Out in the same render as it stops waiting, so it never shows in between.
    if (sameServer && !unmountedRef.current) setUnfollowedKeys((keys) => new Set(keys).add(key));
    void unfollowActivityThreadOn(item, pending).then((unfollowed) => {
      if (unmountedRef.current || !onSameServer(pending)) return;
      if (unfollowed) confirmedUnfollowsRef.current.add(key);
      // Still followed (the save failed): the row comes back.
      else showUnfollowedRow(key);
    });
  }, [showUnfollowedRow]);

  /** End the waiting action of `token`: write it, or (Undo, newer activity on a Done) drop it. */
  const settle = useCallback((token: number, write: boolean) => {
    const pending = pendingRef.current;
    if (!pending || pending.token !== token) return;
    pendingRef.current = null;
    // Shown again in the same render as markDone drops it from the store.
    setWaitingKey(null);
    if (!write) return;
    if (pending.action === "unfollow") {
      commitUnfollow(pending);
      return;
    }
    // On another server now, the list there says nothing about this row.
    const sameServer = onSameServer(pending);
    const current = sameServer ? listedRow(pending.key) : undefined;
    const item = swipeDoneCommitItem(pending.item, current);
    if (!item) return;
    markDoneRef.current(item, { accepted: pending.item, serverId: pending.serverId });
  }, [commitUnfollow]);

  const end = useCallback((write: boolean) => {
    const pending = pendingRef.current;
    if (!pending) return;
    settle(pending.token, write);
    if (pending.toastId) toast.dismiss(pending.toastId);
  }, [settle]);

  const flush = useCallback(() => end(true), [end]);

  const wait = useCallback((action: Pending["action"], item: InboxItem, title: string) => {
    // One toast at a time (raft-ui 0.28): a newer action writes the older
    // row and its toast gives way to this one.
    flush();
    const token = ++tokenRef.current;
    const pending: Pending = { action, item, key: getInboxItemKey(item), token, toastId: null, ...serverIdentity() };
    pendingRef.current = pending;
    setWaitingKey(pending.key);
    // No Undo can be offered: no toast viewport (a host without one), or the
    // list is already gone (a row that finished sliding as it unmounted). Write now.
    if (unmountedRef.current || !hasToastManager()) {
      settle(token, true);
      return;
    }
    // `toast.*` with an action stays 8 seconds (raft-ui's actionTimeout): no duration here.
    const undoable = action === "done" ? "activity_done" : "activity_unfollow";
    const toastId = toast.success(title, {
      action: {
        label: formatMessage({ id: "thread.row.swipeDoneUndo" }),
        onClick: () => {
          trackUndoUsed(undoable, "undone", pending.serverId ?? undefined);
          settle(token, false);
          toast.dismiss(toastId);
        },
      },
      onClose: () => settle(token, true),
    });
    pending.toastId = toastId;
    trackUndoOffered(undoable, pending.serverId ?? undefined);
  }, [flush, formatMessage, settle]);

  const doneObject = useCallback((item: ObjectActivityItem) => {
    flush();
    const { serverId } = serverIdentity();
    const saving = Promise.resolve(markDoneRef.current(item, { accepted: item, serverId }));
    if (unmountedRef.current || !hasToastManager()) return;
    trackUndoOffered("activity_done", serverId ?? undefined);
    const toastId = toast.success(formatMessage({ id: "thread.row.swipeDoneToast" }), {
      action: {
        label: formatMessage({ id: "thread.row.swipeDoneUndo" }),
        onClick: () => {
          trackUndoUsed("activity_done", "undone", serverId ?? undefined);
          toast.dismiss(toastId);
          // After the Done's own save, so the undo can't land before it.
          void saving.then(() => useInboxStore.getState().undoObjectDone(item, { serverId }));
        },
      },
    });
  }, [flush, formatMessage]);

  const done = useCallback((item: InboxItem) => {
    if (item.kind === "object") {
      doneObject(item);
      return;
    }
    wait("done", item, formatMessage({ id: "thread.row.swipeDoneToast" }));
  }, [doneObject, formatMessage, wait]);

  const unfollow = useCallback((item: ThreadInboxItem, conversation: string) => {
    wait("unfollow", item, formatMessage({ id: "thread.row.swipeUnfollowedToast" }, { conversation }));
  }, [formatMessage, wait]);

  const mute = useCallback((channel: Channel, conversation: string) => {
    flush();
    let toastId: string | null = null;
    const identity = serverIdentity();
    // Applied at once, so the row shows muted; a failed save rolls back and
    // says so with its own toast, in place of this one.
    const saving = toggleActivityMuteReporting(channel, formatMessage).then((saved) => {
      if (!saved && toastId) toast.dismiss(toastId);
      return saved;
    });
    if (unmountedRef.current || !hasToastManager()) return;
    trackUndoOffered("activity_mute", identity.serverId ?? undefined);
    toastId = toast.success(formatMessage({ id: "thread.row.swipeMutedToast" }, { conversation }), {
      action: {
        label: formatMessage({ id: "thread.row.swipeDoneUndo" }),
        onClick: () => {
          trackUndoUsed("activity_mute", "undone", identity.serverId ?? undefined);
          if (toastId) toast.dismiss(toastId);
          // After the mute's own save, so the unmute can't land before it;
          // a mute that failed has rolled back already, with nothing to undo.
          void saving.then((saved) => {
            if (!saved || !onSameServer(identity)) return;
            const state = useChannelStore.getState();
            const current = findStoredChannel(state, channel.id);
            if (current?.activityMuted === true) void toggleActivityMuteReporting(current, formatMessage);
          });
        },
      },
    });
  }, [flush, formatMessage]);

  // Newer activity on a row waiting to be Done: the Done it would write no
  // longer covers what is there, so call it off now rather than leave the row
  // hidden under a toast that says it is done. (A waiting Unfollow stays.)
  useEffect(() => useInboxStore.subscribe((state) => {
    // A thread unfollowed here and followed again since (its menu in another
    // view, another device): the store's row says so, and it shows again.
    for (const key of confirmedUnfollowsRef.current) {
      const row = state.items.find((candidate) => getInboxItemKey(candidate) === key);
      if (row?.kind === "thread" && row.isFollowing === true) showUnfollowedRow(key);
    }
    const pending = pendingRef.current;
    if (!pending || pending.action !== "done" || !onSameServer(pending)) return;
    const current = state.items.find((candidate) => getInboxItemKey(candidate) === pending.key);
    if (current && swipeDoneCommitItem(pending.item, current) === null) end(false);
  }), [end, showUnfollowedRow]);

  // The list goes away (another page, the app backgrounded, the tab closed or
  // put in the back-forward cache): write now rather than drop the person's
  // action. `pagehide` also covers a page that unloads without being hidden first.
  useEffect(() => {
    unmountedRef.current = false;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      unmountedRef.current = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // In the same render as the state that decides it, so a row leaves the
  // list in the render its action starts in.
  const hiddenKeys = useMemo(() => {
    if (!waitingKey) return unfollowedKeys;
    return new Set(unfollowedKeys).add(waitingKey);
  }, [unfollowedKeys, waitingKey]);
  return { hiddenKeys, done, unfollow, mute };
}
