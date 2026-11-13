// `presence:activity` (docs/contracts/notifications.md §1.3, §5): tells the
// server whether the user is using THIS computer, so a phone stays quiet while
// they are (account setting "Phone alerts"). Two separate signals:
//
//   active   = "computer active": the last input is under
//              ACTIVE_INPUT_WINDOW_MS (3 minutes) old and the screen is not
//              locked. Focus plays no part: Raft in the background on a
//              computer in use still counts.
//   attended = the Raft window / tab is in front of the user. Sent alongside
//              for the record; only the device's own display gate uses it,
//              the server never routes on it.
//   locked   = the screen is locked. Always sent, so the server derives the
//              last input from `idleSeconds` (for mobileDelay 5m / 10m too).
//
//   - Desktop: the shell's system-wide last input (any app; sampled by main
//     every 30 s and on window / lock events) and its screen lock.
//   - Web: input in this tab (pointer / key / wheel / touch). A browser
//     cannot see the rest of the system, so a person working in another app
//     counts as away 3 minutes after their last input here (the approximation
//     the contract documents); `locked` is always false.
//
// Cadence (one core for both, createPresenceReporter):
//   - a change of active, locked or the push subscription is sent at once,
//     including the moment the last input turns 3 minutes old (a timer fires
//     on it);
//   - so is input that moved on by PRESENCE_INPUT_REPORT_STEP_MS (30 s) since
//     the last report, and a heartbeat a throttled background timer held back
//     (checked on every update);
//   - Raft Desktop says it acks alerts (`ackAlerts`); a web tab names its own
//     Web Push subscription (`pushSubscribed`, `pushEndpointHash`), so the
//     server counts the browser only when that subscription is stored;
//   - while connected, the current state is re-sent every PRESENCE_HEARTBEAT_MS
//     (the server's "online" TTL is 150 s, its "active" test is lastInputAt);
//     newer input while already active is NOT sent per event: the heartbeat
//     carries it (at most 60 s stale against a 3-minute window);
//   - on every (re)connect, of the current socket or one that replaced it, the
//     current state is sent again. Nothing is queued while disconnected.

import {
  ACTIVE_INPUT_WINDOW_MS,
  PRESENCE_ACTIVITY_EVENT,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_INPUT_REPORT_STEP_MS,
  PUSH_ENDPOINT_HASH_LENGTH,
} from "@botiverse/raft-shared";
import type { DesktopWindowActivity, PresenceActivityReport } from "@botiverse/raft-shared";
import { followSocket } from "./desktopNative/followSocket";
import type { NotificationSocket, SocketSource } from "./desktopNative/followSocket";
import { observeWindowAttention } from "./desktopNative/windowAttention";
import { desktopAlertConsumerRunning, onDesktopAlertConsumerChange } from "./desktopNative/alertAckCapability";
import type { WindowActivityBridge } from "./desktopNative/windowAttention";

export interface PresenceTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: PresenceTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface PresenceState {
  /** The window / tab is in front of the user (display gate only). */
  attended: boolean;
  /** Epoch ms of the last input on this computer; null when unknown. */
  lastInputAt: number | null | undefined;
  /** The screen is locked. */
  locked: boolean;
  /**
   * Web: pushEndpointHashOf() of this browser's Web Push subscription, null
   * when it has none. Undefined: not tracked (desktop), nothing is sent.
   */
  pushEndpointHash?: string | null;
  /** Raft Desktop: the alert consumer runs here, so `notification:desktop` is acked (alertAckCapability.ts). */
  ackAlerts?: boolean;
}

export interface PresenceReporterDeps {
  sockets: SocketSource<NotificationSocket>;
  timers?: PresenceTimers;
  now?: () => number;
}

export interface PresenceReporter {
  update(state: PresenceState): void;
  dispose(): void;
}

export function createPresenceReporter(deps: PresenceReporterDeps): PresenceReporter {
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  let attended = false;
  let locked = false;
  let lastInputAt: number | null = null;
  let pushEndpointHash: string | null | undefined;
  let ackAlerts = false;
  let disposed = false;
  // What the current connection last heard (active / locked / push); null = nothing yet on it.
  let reported: string | null = null;
  // The input time and the moment of the last report on this connection.
  let reportedInputAt: number | null = null;
  let sentAt: number | null = null;
  let heartbeat: unknown = null;
  let crossing: unknown = null;

  const idleMs = () => (lastInputAt === null ? null : Math.max(0, now() - lastInputAt));
  const isActive = () => {
    const idle = idleMs();
    return !locked && idle !== null && idle < ACTIVE_INPUT_WINDOW_MS;
  };
  const stateKey = () => `${isActive()}:${locked}:${pushEndpointHash ?? ""}:${ackAlerts}`;
  const stopHeartbeat = () => {
    if (heartbeat !== null) timers.clearTimeout(heartbeat);
    heartbeat = null;
  };
  const stopCrossing = () => {
    if (crossing !== null) timers.clearTimeout(crossing);
    crossing = null;
  };

  const send = () => {
    stopHeartbeat();
    if (disposed) return;
    const socket = deps.sockets.current();
    if (!socket.connected) {
      // Never queued; the next connect re-reports.
      reported = null;
      sentAt = null;
      return;
    }
    const idle = idleMs();
    const payload: PresenceActivityReport = {
      active: isActive(),
      // Rounded up: never claim input more recent than it was.
      idleSeconds: idle === null ? null : Math.ceil(idle / 1000),
      locked,
      attended,
      ...(ackAlerts ? { ackAlerts: true } : {}),
      ...(pushEndpointHash !== undefined ? { pushSubscribed: pushEndpointHash !== null, pushEndpointHash } : {}),
    };
    socket.emit(PRESENCE_ACTIVITY_EVENT, payload);
    reported = stateKey();
    reportedInputAt = lastInputAt;
    sentAt = now();
    heartbeat = timers.setTimeout(() => {
      heartbeat = null;
      send();
    }, PRESENCE_HEARTBEAT_MS);
  };

  const evaluate = () => {
    if (disposed) return;
    const active = isActive();
    if (!active) stopCrossing();
    else if (crossing === null && lastInputAt !== null) {
      // Fires as the last input turns 3 minutes old. Newer input meanwhile
      // just moves the next check (no timer churn per input event).
      crossing = timers.setTimeout(() => {
        crossing = null;
        evaluate();
      }, lastInputAt + ACTIVE_INPUT_WINDOW_MS - now());
    }
    if (reported !== stateKey()) send();
    // The input moved on by PRESENCE_INPUT_REPORT_STEP_MS since the last
    // report: tell the server, so its input time (and the same-computer test)
    // stays within that of the truth even when timers are throttled.
    else if (lastInputAt !== null && reportedInputAt !== null && lastInputAt - reportedInputAt >= PRESENCE_INPUT_REPORT_STEP_MS) send();
    // A heartbeat a throttled background timer is holding back goes now.
    else if (sentAt !== null && now() - sentAt >= PRESENCE_HEARTBEAT_MS) send();
  };

  const onConnect = () => {
    reported = null;
    evaluate();
  };
  const onDisconnect = () => {
    reported = null;
    sentAt = null;
    stopHeartbeat();
  };
  const stopFollowing = followSocket(deps.sockets, (socket) => {
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    // A replacement that is already connected never fires "connect" for us.
    if (socket.connected) onConnect();
    else onDisconnect();
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  });

  return {
    update(state) {
      if (disposed) return;
      attended = state.attended;
      locked = state.locked;
      if (state.pushEndpointHash !== undefined) pushEndpointHash = state.pushEndpointHash;
      ackAlerts = state.ackAlerts === true;
      lastInputAt = typeof state.lastInputAt === "number" && Number.isFinite(state.lastInputAt) ? state.lastInputAt : null;
      evaluate();
    },
    dispose() {
      disposed = true;
      stopHeartbeat();
      stopCrossing();
      stopFollowing();
    },
  };
}

// ---------------------------------------------------------------------------
// Web: input in the tab (computer active), its visibility and focus (attended)
// ---------------------------------------------------------------------------

// Only what a person does: a press, a key, a wheel turn, a touch. Not
// `scroll` (the timeline auto-scrolls to new messages, which would keep an
// unattended tab "active" and the phone silent) and not `pointermove` (a
// cursor resting under a moving layout, or a nudged mouse, is not using Raft).
export const WEB_PRESENCE_INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export interface WebPresenceEnvironment {
  document: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** pushEndpointHash: base64url SHA-256 of the endpoint, cut to PUSH_ENDPOINT_HASH_LENGTH (the server's rule). */
export async function pushEndpointHashOf(endpoint: string, subtle: Pick<SubtleCrypto, "digest"> = crypto.subtle): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, PUSH_ENDPOINT_HASH_LENGTH);
}

/** This browser's Web Push endpoint, or null without a subscription (or support). */
export async function currentPushEndpoint(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.getRegistration) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  return subscription?.endpoint ?? null;
}

export function startWebPresenceReport(
  deps: PresenceReporterDeps & { env?: WebPresenceEnvironment; pushEndpoint?: () => Promise<string | null> },
): () => void {
  const env = deps.env ?? { document, window };
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;
  const reporter = createPresenceReporter(deps);
  const attended = () => env.document.visibilityState === "visible" && env.document.hasFocus();
  // Opening or reloading the tab is itself an interaction.
  let lastInputAt: number | null = attended() ? now() : null;
  // Unknown until first read: reported as none.
  let pushEndpointHash: string | null = null;
  // A browser cannot see a screen lock: a locked computer goes quiet here by
  // its idle time.
  const report = () => reporter.update({ attended: attended(), lastInputAt, locked: false, pushEndpointHash });
  // The subscription can appear (permission granted) or go (revoked) any
  // time: re-read on focus / visibility and once a heartbeat.
  let stopped = false;
  let refreshTimer: unknown = null;
  const refreshPush = () => {
    const read = deps.pushEndpoint ?? currentPushEndpoint;
    void read()
      .then((endpoint) => (endpoint ? pushEndpointHashOf(endpoint) : null))
      .catch(() => null)
      .then((hash) => {
        if (stopped || hash === pushEndpointHash) return;
        pushEndpointHash = hash;
        report();
      });
  };
  const scheduleRefresh = () => {
    refreshTimer = timers.setTimeout(() => {
      refreshPush();
      scheduleRefresh();
    }, PRESENCE_HEARTBEAT_MS);
  };
  const onInput = () => {
    lastInputAt = now();
    report();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const event of WEB_PRESENCE_INPUT_EVENTS) env.document.addEventListener(event, onInput, options);
  const onAttention = () => {
    report();
    refreshPush();
  };
  env.document.addEventListener("visibilitychange", onAttention);
  env.window.addEventListener("focus", onAttention);
  env.window.addEventListener("blur", report);
  report();
  refreshPush();
  scheduleRefresh();
  return () => {
    stopped = true;
    if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
    for (const event of WEB_PRESENCE_INPUT_EVENTS) env.document.removeEventListener(event, onInput, options);
    env.document.removeEventListener("visibilitychange", onAttention);
    env.window.removeEventListener("focus", onAttention);
    env.window.removeEventListener("blur", report);
    reporter.dispose();
  };
}

// ---------------------------------------------------------------------------
// Desktop: the shell's system presence (computer active) and window (attended)
// ---------------------------------------------------------------------------

/**
 * The screen lock from the shell. Shells before the computer-active protocol
 * send no `locked`; their `away` (10 minutes idle, or locked) is read as
 * possibly locked, which only ever lets a phone alert through.
 */
export function desktopScreenLocked(state: Pick<DesktopWindowActivity, "away" | "locked">): boolean {
  return typeof state.locked === "boolean" ? state.locked : state.away === true;
}

export function startDesktopPresenceReport(
  bridge: WindowActivityBridge,
  deps: PresenceReporterDeps,
): () => void {
  const reporter = createPresenceReporter(deps);
  // `ackAlerts` only while the desktop alert consumer runs in this page
  // (alertAckCapability.ts): the server then waits for its acks.
  let last: Omit<PresenceState, "ackAlerts"> | null = null;
  const report = () => {
    if (last) reporter.update({ ...last, ackAlerts: desktopAlertConsumerRunning() });
  };
  const stopCapability = onDesktopAlertConsumerChange(report);
  // observeWindowAttention only reports real native states, never its
  // "unknown" default, so nothing active is claimed before the snapshot.
  const attention = observeWindowAttention(bridge, (attended, _away, state) => {
    last = { attended, lastInputAt: state.lastInputAt, locked: desktopScreenLocked(state) };
    report();
  });
  return () => {
    stopCapability();
    attention.dispose();
    reporter.dispose();
  };
}
