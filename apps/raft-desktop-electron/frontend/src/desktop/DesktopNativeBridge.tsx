// Native desktop integration, wired against the reused web stores without
// forking any web component. Renders nothing; it just bridges the running app
// to the Electron shell:
//   - dock unread badge (sum of the active server's unread counts)
//   - OS notifications for live incoming messages while the window is unfocused
//   - raft:// deep links routed into the in-app router
//
// It reads the web's own stores (messageStore/channelStore/authStore/
// serverStore) and its canonical navigation builder (useAppNavigate), so it
// stays correct as those evolve. Everything is a no-op when window.raftDesktop
// is absent (e.g. a browser preview build).

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMessageStore } from "@web/store/messageStore";
import { useChannelStore } from "@web/store/channelStore";
import { useThreadStore } from "@web/store/threadStore";
import { useAuthStore } from "@web/store/authStore";
import { useAppNavigate } from "@web/hooks/useAppNavigate";
import { decideNotification } from "./notificationDecision";

type RaftDesktopBridge = {
  isDesktop?: boolean;
  setBadgeCount?: (count: number) => void;
  focusWindow?: () => void;
  isFocused?: () => Promise<boolean>;
  onFocusChange?: (handler: (focused: boolean) => void) => () => void;
  onDeepLink?: (handler: (uri: string) => void) => () => void;
};

// raft:// deep links only ever target in-app routes. Validate the decoded path
// against the known route prefixes before navigating, so a link crafted by an
// outside party (any web page can trigger raft://…) can't drive arbitrary
// navigation.
const DEEP_LINK_ROUTE_PREFIXES = ["/s/", "/servers"];
function deepLinkPath(uri: string): string | null {
  if (!uri.startsWith("raft://")) return null;
  let path = uri.slice("raft://".length);
  if (!path.startsWith("/")) path = `/${path}`;
  const ok = path === "/" || DEEP_LINK_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p));
  return ok ? path : null;
}

function bridge(): RaftDesktopBridge | undefined {
  return (globalThis as { raftDesktop?: RaftDesktopBridge }).raftDesktop;
}

function totalUnread(counts: Record<string, number>): number {
  let sum = 0;
  for (const n of Object.values(counts)) sum += n;
  return sum;
}

function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

// Bulk read-state loads (on login / server switch) populate unreadCounts in one
// burst; without a warmup we'd fire a notification for every pre-existing unread
// channel. Only notify for increases that land after the store has settled.
const NOTIFY_WARMUP_MS = 4000;

export function DesktopNativeBridge(): null {
  const nav = useAppNavigate();
  const navigate = useNavigate();

  // Dock badge + OS notifications, both driven off the message store.
  useEffect(() => {
    const b = bridge();
    if (!b) return;

    // Prefer the shell's native focus signal over document.hasFocus(), which is
    // unreliable in Electron (DevTools focus, transitions). Keep it live.
    let focused = typeof document !== "undefined" ? document.hasFocus() : true;
    void b.isFocused?.().then((f) => {
      focused = f;
    });
    const offFocus = b.onFocusChange?.((f) => {
      focused = f;
    });

    const lastMessageId = (channelId: string): string | undefined => {
      const messages = useMessageStore.getState().channelMessages[channelId];
      return messages?.[messages.length - 1]?.id;
    };

    const readyAt = Date.now() + NOTIFY_WARMUP_MS;
    let prevCounts: Record<string, number> = { ...useMessageStore.getState().unreadCounts };
    // Track the newest message id we've observed per channel. A reconnect
    // read-state snapshot bumps unreadCounts WITHOUT loading new bucket
    // messages, so the last message id is unchanged there — that's how we tell
    // a genuine live message apart from a stale snapshot and avoid notifying
    // with old content (or notifying the same message twice).
    const seenMessageId: Record<string, string | undefined> = {};
    for (const channelId of Object.keys(prevCounts)) seenMessageId[channelId] = lastMessageId(channelId);
    b.setBadgeCount?.(totalUnread(prevCounts));

    const notifyFor = (
      channelId: string,
      decision: Extract<ReturnType<typeof decideNotification>, { notify: true }>,
    ) => {
      if (typeof Notification === "undefined") return;
      const messages = useMessageStore.getState().channelMessages[channelId];
      const last = messages?.[messages.length - 1];
      if (!last) return;
      if (last.senderId === useAuthStore.getState().user?.id) return; // our own

      const title = last.senderDisplayName || last.senderName || "New message";
      const body = previewOf(last.content);
      const open = () => {
        b.focusWindow?.();
        if (decision.kind === "thread") {
          // Navigate to the PARENT channel with the thread panel open + the new
          // reply focused — NOT nav.toChannel(threadChannelId), which renders a
          // bare "#thread-<id>" pseudo-channel. This sets both the underlying
          // route and the thread overlay, wherever the app currently is.
          nav.toThreadMessage(decision.parentChannelId, decision.parentMessageId, last.id);
        } else if (decision.kind === "dm") {
          nav.toDm(channelId);
        } else {
          nav.toChannel(channelId);
        }
      };
      const fire = () => {
        const n = new Notification(title, { body });
        n.onclick = open;
      };
      if (Notification.permission === "granted") fire();
      else if (Notification.permission !== "denied") {
        void Notification.requestPermission().then((p) => {
          if (p === "granted") fire();
        });
      }
    };

    // Only the unreadCounts slice drives the badge and notifications, but zustand
    // fires this subscription on EVERY message-store change — every incoming
    // message, optimistic send, edit, reaction, read-cursor move. Bail on a cheap
    // reference check unless the unread map actually changed, so the badge sum +
    // the per-channel notification loop don't run on the hot path for unrelated
    // updates. The store replaces unreadCounts immutably, so a new reference is a
    // real change (and the badge + the "is this a new unread?" trigger both
    // depend on nothing else).
    let prevUnreadRef = useMessageStore.getState().unreadCounts;
    const unsubscribe = useMessageStore.subscribe(() => {
      const state = useMessageStore.getState();
      const counts = state.unreadCounts;
      if (counts === prevUnreadRef) return;
      prevUnreadRef = counts;
      b.setBadgeCount?.(totalUnread(counts));

      const canNotify = !focused && Date.now() >= readyAt;
      const openChannelId = state.currentChannelId;
      for (const [channelId, n] of Object.entries(counts)) {
        const newestId = lastMessageId(channelId);
        const isLiveNew =
          n > (prevCounts[channelId] ?? 0) && // more unread
          !!newestId &&
          newestId !== seenMessageId[channelId] && // an actually-new message, not a snapshot bump
          channelId !== openChannelId; // don't buzz for the channel already on screen
        if (canNotify && isLiveNew) {
          // Only notify for channels the user actually follows/joined and hasn't
          // muted (and open threads with parent context) — unreadCounts also
          // carries unfollowed thread channels and muted channels.
          const cs = useChannelStore.getState();
          const decision = decideNotification(
            channelId,
            cs.channels,
            cs.dmChannels,
            useThreadStore.getState().followedThreads,
          );
          if (decision.notify) notifyFor(channelId, decision);
        }
        seenMessageId[channelId] = newestId;
      }
      prevCounts = { ...counts };
    });

    return () => {
      unsubscribe();
      offFocus?.();
      // Clear the dock badge when this bridge tears down (logout / server
      // switch re-init) so a stale count doesn't linger.
      b.setBadgeCount?.(0);
    };
  }, [nav]);

  // Request notification permission once, the first time the user is signed in
  // — not lazily on the first missed message (which would be consumed by the
  // prompt) and not on the login screen (premature).
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    let requested = false;
    const maybeRequest = () => {
      if (requested) return;
      if (useAuthStore.getState().user && Notification.permission === "default") {
        requested = true;
        void Notification.requestPermission();
      }
    };
    maybeRequest();
    return useAuthStore.subscribe(maybeRequest);
  }, []);

  // raft:// deep links → in-app navigation (validated against known routes).
  // The preload buffers links that arrive before this subscription (cold start
  // / pre-login) and replays them.
  useEffect(() => {
    const b = bridge();
    if (!b?.onDeepLink) return;
    return b.onDeepLink((uri) => {
      const path = deepLinkPath(uri);
      if (path) navigate(path);
    });
  }, [navigate]);

  return null;
}
