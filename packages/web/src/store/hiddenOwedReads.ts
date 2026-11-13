/**
 * Reads a hidden page owes until it shows again (slock #12928 hidden pause).
 *
 * A background tab whose socket the OS keeps dropping used to read on every
 * reconnect as if it were on screen: GET /messages/sync (the heartbeat,
 * rooms:joined and sync:resume re-reading the visible scopes, a live seq
 * gap), the jittered reconnect reload batch (machines, agents, servers,
 * channels, ...) and the Activity reset. While hidden each of these is owed
 * instead and runs once when the page shows: on visibilitychange, or on a
 * visible focus / online / pageshow (recoverLiveSession), whichever is first.
 * The socket reconnect, sync:resume and room joins are not deferred. (The
 * pinged lists defer in their hooks: visiblePoll.ts createVisiblePoll.)
 */
import { registerServerReset } from "./serverResetRegistry";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { createOwedReads, isPageHidden } from "../utils/visiblePoll";

type SyncGap = (channelId: string | undefined, options: { sinceSeq: number }) => unknown;
let syncGapOnShow: SyncGap | null = null;
let onOwedGapReadsPaid: (() => void) | null = null;

/** Told when a show pays the owed gap reads (the recovery re-read counts them as its own). */
export function setOwedGapReadsPaidListener(listener: (() => void) | null): void {
  onOwedGapReadsPaid = listener;
}

// One per scope, from the lowest seq asked: a live row appended meanwhile (a
// thread on screen) can move the scope's max past the hole.
const owedGapSyncs = createOwedReads<number>(
  (channelId, sinceSeq) => {
    onOwedGapReadsPaid?.();
    void syncGapOnShow?.(channelId || undefined, { sinceSeq });
  },
  Math.min,
);
registerServerReset(() => owedGapSyncs.clear());

/**
 * messageStore.syncGap, the only GET /messages/sync: while hidden, owe it
 * (true: read nothing now); visible, false: read now.
 */
export function gapSyncWaitsForShow(channelId: string | undefined, sinceSeq: number, syncGap: SyncGap): boolean {
  if (!isPageHidden()) return false;
  syncGapOnShow = syncGap;
  owedGapSyncs.owe(channelId ?? "", sinceSeq);
  return true;
}

const heldReconnectReads = createOwedReads<() => void>((_key, run) => run(), (_owed, next) => next);

/**
 * A reconnect's reload while hidden: hold `run` (the latest per key) until
 * the page shows and return true; visible, false: run it now.
 */
export function heldWhileHidden(key: "reload_batch" | "inbox_reset", run: () => void): boolean {
  if (!isPageHidden()) return false;
  // An owed realtime re-read already pays the Activity reset (one reason: visibility).
  if (!(key === "inbox_reset" && inboxRealtimeHeld)) heldReconnectReads.owe(key, run);
  traceLiveSession("hold", key, "held_hidden");
  return true;
}

// A realtime re-read is owed; traced once per hidden spell, not per event.
let inboxRealtimeHeld = false;

/**
 * #243: a realtime Activity re-read (inboxStore requestInboxBackgroundRefresh)
 * asked for while hidden reads nothing: it is owed as the same `inbox_reset` a
 * held reconnect read is, so showing the page pays both with one read (`run`,
 * the `visibility` re-read, whichever came first). Visible, false: the caller
 * reads as before.
 */
export function inboxRefreshWaitsForShow(run: () => void): boolean {
  if (!isPageHidden()) return false;
  if (inboxRealtimeHeld) return true;
  traceLiveSession("hold", "inbox_realtime", "held_hidden");
  inboxRealtimeHeld = true;
  heldReconnectReads.owe("inbox_reset", () => {
    inboxRealtimeHeld = false;
    run();
  });
  return true;
}

/** Logout or the bridge torn down: nothing owed survives it. */
export function dropOwedReads(): void {
  owedGapSyncs.clear();
  heldReconnectReads.clear();
  inboxRealtimeHeld = false;
}

/**
 * recoverLiveSession (visibilitychange, focus, online, pageshow): a visible
 * page pays what it owes (a PWA can come back without a visibilitychange);
 * a recovery that reloads is traced.
 */
export function noteLiveSessionRecovery(trigger: string, plan: { reconnectSocket: boolean; reloadLiveData: boolean }): void {
  if (!isPageHidden()) {
    owedGapSyncs.flush();
    heldReconnectReads.flush();
  }
  if (plan.reloadLiveData) traceLiveSession("recover", trigger, plan.reconnectSocket ? "reconnect_and_reload" : "reload");
}

/**
 * `slock.state.transition`, domain live_session: a socket reconnect, a
 * recovery that reloads, or a reload held while hidden; entityId = the
 * trigger, plus `tab.visibility` at the time (docs/observability/reading-telemetry.md).
 */
export function traceLiveSession(event: "reconnect" | "recover" | "hold", trigger: string, did: string): void {
  emitStateTransitionTrace(
    { domain: "live_session", event, entityId: trigger, outcome: "applied", outcomeDetail: did, touched: 1 },
    { "tab.visibility": typeof document === "undefined" ? "unknown" : document.visibilityState },
  );
}
