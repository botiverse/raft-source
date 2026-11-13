import { useInboxStore } from "./inboxStore";
import { readLastCounts } from "./lastCounts";
import { useMessageStore } from "./messageStore";
import { getCurrentPrincipalId } from "./principalRuntime";
import {
  RW_SURFACES,
  markRwSeeded,
  resetRwFreshness,
  useRwFreshnessStore,
} from "./rwFreshness";
import type { RwSurface } from "./rwFreshness";
import { registerAfterServerReset } from "./serverResetRegistry";
import { useServerStore } from "./serverStore";
import { useThreadStore } from "./threadStore";

// Task #164: what the client does while the unread and Activity reads are
// stale or unavailable (store/rwFreshness.ts).
//
// Seed: at boot and on a server switch, before the first answer, the stores
// show this user's last saved counts for this server (store/lastCounts.ts),
// marked stale until a clean answer. Only into empty slices: a value already
// loaded is newer than any saved copy.
//
// Recover: while a read is stale or unavailable, read it again: first after
// the server's Retry-After (5 s without one), then 5, 10, 20, 40, 60 s, with ±20%
// jitter so tabs do not line up; only while the page is visible. A return to
// the page (visible, focus) reads at once; a socket reconnect within a random
// 0-5 s, so clients reconnecting together after a deploy spread out. The first
// clean 200 marks it fresh and the timer stops.

const isEmpty = (record: Record<string, unknown>) => Object.keys(record).length === 0;

/** Fill the empty slices of the current server from this user's saved copy. */
export function seedLastCounts(): void {
  const serverId = useServerStore.getState().current?.id;
  // The store's user first: its subscribers run before the principal runtime is updated.
  const userId = useMessageStore.getState().currentUserId ?? getCurrentPrincipalId();
  const saved = readLastCounts(userId, serverId);
  if (!saved) return;
  const surfaces = useRwFreshnessStore.getState().surfaces;

  if (saved.summary && !surfaces.summary.confirmed && isEmpty(useServerStore.getState().serverUnreadCounts)) {
    useServerStore.setState({ serverUnreadCounts: saved.summary });
    markRwSeeded("summary");
  }

  const messages = useMessageStore.getState();
  if (
    saved.unread
    && !surfaces.unread.confirmed
    && isEmpty(messages.unreadCounts)
    && isEmpty(messages.mentionFlags)
    && isEmpty(messages.newFlags)
  ) {
    useMessageStore.setState({
      unreadCounts: saved.unread.unreadCounts,
      mentionFlags: saved.unread.mentionFlags,
      newFlags: saved.unread.newFlags,
    });
    markRwSeeded("unread");
  }

  if (saved.followed && !surfaces.followed.confirmed && useThreadStore.getState().followedThreads.length === 0) {
    useThreadStore.setState({ followedThreads: saved.followed });
    markRwSeeded("followed");
  }

  const inbox = useInboxStore.getState();
  if (
    saved.activity
    && !surfaces.inbox.confirmed
    && inbox.items.length === 0
    && !inbox.loaded
    && !inbox.loading
    && inbox.filter === "all"
    && inbox.channelFilterId === null
    && inbox.scope === null
    && inbox.searchQuery === ""
    && inbox.sortDirection === "desc"
  ) {
    // `loaded` stays false so opening Activity still loads it; the rows show
    // meanwhile instead of the skeleton (ThreadsInbox `firstLoad`).
    useInboxStore.setState({
      items: saved.activity.items,
      groups: saved.activity.groups,
      totalCount: saved.activity.totalCount,
      allCount: saved.activity.totalCount,
      totalUnreadCount: saved.activity.totalUnreadCount,
      activeUnreadCount: saved.activity.activeUnreadCount,
      hasMore: saved.activity.hasMore,
      savedWindow: true,
    });
    markRwSeeded("inbox");
  }
}

// A server switch: the server-scoped reads start over, then the new server's
// saved copy fills them. The cross-server summary is the same on every server.
registerAfterServerReset(() => {
  cancelRecovery(["unread", "inbox", "followed"]);
  resetRwFreshness(["unread", "inbox", "followed"]);
  seedLastCounts();
});

// Boot: the user can become known after the server did.
let seededPrincipalId = useMessageStore.getState().currentUserId;
useMessageStore.subscribe((state) => {
  if (state.currentUserId === seededPrincipalId) return;
  seededPrincipalId = state.currentUserId;
  if (state.currentUserId) seedLastCounts();
});

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const RW_RECOVERY_MAX_DELAY_MS = 60_000;
/** A visible + focus pair (one tab switch) reads once. */
const NUDGE_COALESCE_MS = 2_000;

/** The wait before the `attempt`-th re-read (0-based), before jitter. */
export function rwRecoveryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (attempt === 0) return Math.min(retryAfterMs ?? BACKOFF_MS[0], RW_RECOVERY_MAX_DELAY_MS);
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

function withJitter(ms: number, random: () => number = Math.random): number {
  return Math.min(RW_RECOVERY_MAX_DELAY_MS, Math.round(ms * (0.8 + 0.4 * random())));
}

function refetch(surface: RwSurface): Promise<void> {
  switch (surface) {
    case "summary":
      return useServerStore.getState().loadServerUnreadSummary();
    case "unread":
      return useMessageStore.getState().loadUnreadCounts();
    case "followed":
      return useThreadStore.getState().loadFollowedThreads();
    case "inbox": {
      const inbox = useInboxStore.getState();
      // Not loaded: Activity was never opened, and opening it loads it.
      if (!inbox.loaded || inbox.loading) return Promise.resolve();
      return inbox.loadInbox({ reset: true, background: true });
    }
  }
}

type Recovery = { attempt: number; timer: ReturnType<typeof setTimeout> | null; inFlight: boolean };
const recoveries = new Map<RwSurface, Recovery>();

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

function needsRecovery(surface: RwSurface): boolean {
  const state = useRwFreshnessStore.getState().surfaces[surface];
  return state.confirmed && state.freshness !== "fresh";
}

function cancelRecovery(surfaces: readonly RwSurface[] = RW_SURFACES): void {
  for (const surface of surfaces) {
    const recovery = recoveries.get(surface);
    if (recovery?.timer) clearTimeout(recovery.timer);
    recoveries.delete(surface);
  }
}

function runNow(surface: RwSurface): void {
  const recovery = recoveries.get(surface) ?? { attempt: 0, timer: null, inFlight: false };
  recoveries.set(surface, recovery);
  if (recovery.timer) clearTimeout(recovery.timer);
  recovery.timer = null;
  if (recovery.inFlight) return;
  recovery.inFlight = true;
  recovery.attempt += 1;
  void refetch(surface)
    .catch(() => undefined)
    .finally(() => {
      recovery.inFlight = false;
      // Still out of date (the state may not have changed, so no store
      // notification comes): schedule the next one.
      if (recoveries.get(surface) === recovery) schedule(surface);
    });
}

function schedule(surface: RwSurface): void {
  if (!started) return;
  if (!needsRecovery(surface)) {
    cancelRecovery([surface]);
    return;
  }
  const recovery = recoveries.get(surface) ?? { attempt: 0, timer: null, inFlight: false };
  recoveries.set(surface, recovery);
  if (recovery.timer || recovery.inFlight) return;
  const { retryAfterMs } = useRwFreshnessStore.getState().surfaces[surface];
  recovery.timer = setTimeout(() => {
    recovery.timer = null;
    // Hidden: wait; the page coming back reads at once.
    if (!isVisible()) return;
    runNow(surface);
  }, withJitter(rwRecoveryDelayMs(recovery.attempt, retryAfterMs)));
}

/** How far apart the reconnect reads of all clients spread. */
export const RECONNECT_SPREAD_MS = 5_000;

let started = false;
let lastNudgeAt = Number.NEGATIVE_INFINITY;

/** The page came back (visible, focus) or the socket reconnected: read what is out of date now. */
export function nudgeRwRecovery(surfaces: readonly RwSurface[] = RW_SURFACES): void {
  const now = Date.now();
  if (now - lastNudgeAt < NUDGE_COALESCE_MS) return;
  lastNudgeAt = now;
  for (const surface of surfaces) {
    if (needsRecovery(surface)) runNow(surface);
  }
}

/** Start the recovery loop (App, once signed in). Returns its stop. */
export function startRwRecovery(): () => void {
  if (started) return () => {};
  started = true;
  const unsubscribe = useRwFreshnessStore.subscribe((state, previous) => {
    for (const surface of RW_SURFACES) {
      if (state.surfaces[surface] !== previous.surfaces[surface]) schedule(surface);
    }
  });
  for (const surface of RW_SURFACES) schedule(surface);
  const onVisible = () => {
    if (isVisible()) nudgeRwRecovery();
  };
  // rooms:joined already re-reads the unread counts and Activity
  // (socketBridge); the summary and followed threads are not on it. A deploy
  // reconnects every client at once, and RisingWave may be just back, so the
  // reconnect read waits a random 0-5 s (Tenny) instead of all in one second.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const onRoomsJoined = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      nudgeRwRecovery(["summary", "followed"]);
    }, Math.random() * RECONNECT_SPREAD_MS);
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("slock:rooms-joined", onRoomsJoined);
  return () => {
    started = false;
    unsubscribe();
    cancelRecovery();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    window.removeEventListener("slock:rooms-joined", onRoomsJoined);
  };
}

/** TEST-ONLY: forget recovery and nudge state between tests. */
export function __resetRwStaleCountsForTests(): void {
  cancelRecovery();
  lastNudgeAt = Number.NEGATIVE_INFINITY;
}
