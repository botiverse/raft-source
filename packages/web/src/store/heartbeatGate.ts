/**
 * The visible scopes' gap sync (socketBridge): a heartbeat seq above
 * `lastSeq`, a reconnect's rooms:joined and a sync:resume that needs a
 * re-read all read the visible scopes again through this.
 *
 * Not while the page is hidden: each scope's GET /messages/sync is owed
 * instead (messageStore syncGap -> hiddenOwedReads.ts), once per scope from
 * the lowest seq asked, and read once when the page shows. A hidden beat
 * owes from what the scope holds, decided at the beat: lastSeq is the max
 * seq of any channel, so a later message elsewhere does not prove the scope's
 * gap was filled.
 *
 * Every visible beat still reads while the seq is above lastSeq: the seq is
 * server-wide, so activity in channels this person cannot see keeps it there.
 * The fix for that is a per-user/per-scope seq in the heartbeat (server).
 */

import { getDesktopBridge } from "../utils/desktopBridge";
import { traceLiveSession } from "./hiddenOwedReads";
import { getGapFillSinceSeq } from "./liveGapFill";
import { selectChannelWindowMeta, useMessageStore } from "./messageStore";
import { threadConversationsOnScreen } from "./visibleConversations";

type ScopeTarget = { channelId: string; sinceSeq: number };

/** Read the visible scopes one at a time; a call during a read reruns once after it. */
export function createVisibleScopeSync(
  getTargets: () => ScopeTarget[],
  syncScope: (channelId: string, sinceSeq: number) => Promise<void>,
) {
  let inFlight = false;
  let rerun = false;
  const sync = async (): Promise<void> => {
    if (inFlight) {
      rerun = true;
      return;
    }
    const targets = getTargets();
    if (targets.length === 0) return;
    inFlight = true;
    try {
      for (const { channelId, sinceSeq } of targets) await syncScope(channelId, sinceSeq);
    } finally {
      inFlight = false;
    }
    if (rerun) {
      rerun = false;
      await sync();
    }
  };
  return sync;
}

/**
 * A visible scope still showing live rows whose hole is unconfirmed
 * (messageStore channelOwesGapFill): the heartbeat re-reads it whatever its
 * seq says. lastSeq already counts those rows, so `seq > lastSeq` alone would
 * never ask again after a fill that failed or answered before they landed.
 */
export function heartbeatNeedsScopeSync(
  serverSeq: number,
  lastSeq: number,
  visibleScopeIds: string[],
  owesGapFill: (channelId: string) => boolean,
): boolean {
  if (serverSeq > lastSeq || roomsJoinDegraded) return true;
  return visibleScopeIds.some(owesGapFill);
}

let roomsJoinDegraded = false;

/**
 * The server could not join this socket's channel rooms (`rooms:join_failed`)
 * and retries on its own until `rooms:joined`: until then no channel
 * message:new arrives, so every heartbeat re-reads the visible scopes.
 */
export function noteRoomsJoinDegraded(degraded: boolean): void {
  if (degraded === roomsJoinDegraded) return;
  roomsJoinDegraded = degraded;
  traceLiveSession(degraded ? "hold" : "recover", "rooms_join", degraded ? "degraded" : "joined");
}

/** Recovery re-reads of the visible scopes (focus, visibility, online) at most once per this. */
export const RECOVERY_SCOPE_SYNC_MIN_INTERVAL_MS = 5_000;

/**
 * The visible scopes re-read on a page coming back (focus, visibilitychange
 * to visible, online, a desktop resume / unlock): leading-edge, at most once
 * per `minIntervalMs`, so a burst of these events reads once. `noteRead` counts a
 * read the recovery already did another way (the reads a hidden page owed).
 */
export function createRecoveryScopeSync(
  sync: () => Promise<void>,
  minIntervalMs = RECOVERY_SCOPE_SYNC_MIN_INTERVAL_MS,
  now: () => number = Date.now,
) {
  let lastReadAt = -Infinity;
  return {
    request(): void {
      const at = now();
      if (at - lastReadAt < minIntervalMs) return;
      lastReadAt = at;
      void sync();
    },
    noteRead(): void {
      lastReadAt = now();
    },
  };
}

/** The conversations on screen: the open thread panel's (and a task modal's) first, then the channel. */
export function visibleScopeIds(currentChannelId: string | null): string[] {
  const ids = [...threadConversationsOnScreen()];
  if (currentChannelId && !ids.includes(currentChannelId)) ids.push(currentChannelId);
  return ids;
}

/**
 * Re-read the visible scopes (GET /messages/sync each, messageStore syncGap)
 * from what each holds, or lower where a live row shown across a seq jump
 * still has its hole unconfirmed (liveGapFill.ts).
 */
export function createConversationScopeSync(getCurrentChannelId: () => string | null) {
  return createVisibleScopeSync(() => {
    const state = useMessageStore.getState();
    const { channelMessages } = state;
    const targets: ScopeTarget[] = [];
    for (const channelId of visibleScopeIds(getCurrentChannelId())) {
      // A jumped-to history window (newer pages not loaded): reading from its
      // tail would page it up to the latest message.
      const hasNewer = state.currentChannelId === channelId ? state.hasNewer : selectChannelWindowMeta(state, channelId).hasNewer;
      if (hasNewer) continue;
      const tail = Math.max(...(channelMessages[channelId] ?? []).map((message) => message.seq || 0), 0);
      const owed = getGapFillSinceSeq(channelId);
      const sinceSeq = owed === null ? tail : Math.min(owed, tail);
      if (sinceSeq > 0) targets.push({ channelId, sinceSeq });
    }
    return targets;
  }, (channelId, sinceSeq) => useMessageStore.getState().syncGap(channelId, { sinceSeq }));
}

/** A wake usually brings resume and unlock together: one recovery for both. */
export const SYSTEM_RESUME_COALESCE_MS = 1_000;

/**
 * Raft Desktop resume / unlock-screen (raftDesktop.onSystemResume): run
 * `recover` once per burst (after `coalesceMs`), and if the machine is still
 * offline then, once it is back online instead of dropping it. A closed
 * window only hides, so no focus or visibilitychange may follow a wake.
 * Returns the uninstall; a no-op outside Raft Desktop.
 */
export function installSystemResumeRecovery(
  recover: () => void,
  isOnline: () => boolean = () => navigator.onLine,
  coalesceMs = SYSTEM_RESUME_COALESCE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitingForOnline = false;
  const onOnline = () => {
    waitingForOnline = false;
    recover();
  };
  const run = () => {
    timer = null;
    if (isOnline()) {
      recover();
    } else if (!waitingForOnline) {
      waitingForOnline = true;
      window.addEventListener("online", onOnline, { once: true });
    }
  };
  const unsubscribe = getDesktopBridge()?.onSystemResume?.(() => {
    if (timer === null) timer = setTimeout(run, coalesceMs);
  });
  return () => {
    unsubscribe?.();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (waitingForOnline) window.removeEventListener("online", onOnline);
    waitingForOnline = false;
  };
}
