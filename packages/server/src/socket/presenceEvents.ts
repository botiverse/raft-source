import type { Socket } from "socket.io";
import {
  ACTIVE_INPUT_WINDOW_MS,
  DESKTOP_INPUT_PRESENCE_EVENT,
  PRESENCE_ACTIVITY_EVENT,
  parsePresenceActivityReport,
  type PresenceActivityReport,
} from "@botiverse/raft-shared";
import {
  recordPresenceActivity,
  removePresenceSocket,
  reportShowsActive,
} from "../services/notifications/presence";
import type { NotificationDeviceKind } from "../services/notifications/types";
import type { SocketClientKind } from "./platformScope";

// Clients re-report about once a minute and at once when the user starts or
// stops using the device. A repeat of the same state faster than this from one
// socket is dropped; a change of state to "stopped" never is (a lost one would
// keep other devices quiet), and a change back to "active" is limited to one
// per PRESENCE_ACTIVITY_MIN_CHANGE_MS.
export const PRESENCE_ACTIVITY_MIN_INTERVAL_MS = 20 * 1000;
export const PRESENCE_ACTIVITY_MIN_CHANGE_MS = 1000;

export type PresenceActivityDeps = {
  /** Records this socket's own entry (presence.ts recordPresenceActivity). */
  record?: (userId: string, kind: NotificationDeviceKind, report: PresenceActivityReport, now: number, socketId: string) => Promise<void>;
  /** Drops this socket's entry (presence.ts removePresenceSocket). */
  remove?: (userId: string, kind: NotificationDeviceKind, socketId: string) => Promise<void>;
  now?: () => number;
};

// Sockets without an id (unit fakes) still need an entry of their own.
let syntheticSocketSeq = 0;

function presenceKind(clientKind: SocketClientKind): NotificationDeviceKind | null {
  return clientKind === "desktop" || clientKind === "web" || clientKind === "mobile" ? clientKind : null;
}

/**
 * The legacy desktop report: attended with a recent, well-formed idle time is
 * "active"; anything else (not attended, idle unknown, too old or garbage) is
 * "not active", so other devices are notified.
 */
export function desktopInputPresenceToReport(payload: unknown): PresenceActivityReport | null {
  if (!payload || typeof payload !== "object") return null;
  const { attended, idleSeconds } = payload as { attended?: unknown; idleSeconds?: unknown };
  const idle = typeof idleSeconds === "number" && Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds : null;
  return {
    active: attended === true && idle !== null && idle < ACTIVE_INPUT_WINDOW_MS / 1000,
    idleSeconds: idle,
  };
}

/**
 * Accepts `presence:activity {active, idleSeconds, locked?, attended?}` from desktop, web and
 * mobile sockets (never cli), and the older desktop alias
 * `desktop:input-presence {attended, idleSeconds}` from desktop sockets only.
 * The socket's own user and client kind are always the subject, and each
 * socket writes only its own entry, so an idle tab or second computer never
 * clears the one in use. A disconnect drops this socket's entry (the kind goes
 * offline and inactive when it was the last one).
 */
export function attachPresenceActivityHandler(
  socket: Pick<Socket, "on"> & { id?: string },
  identity: { userId: string; clientKind: SocketClientKind },
  deps: PresenceActivityDeps = {},
): void {
  const kind = presenceKind(identity.clientKind);
  if (!kind) return;
  const record = deps.record ?? recordPresenceActivity;
  const now = deps.now ?? Date.now;
  const remove = deps.remove ?? ((userId: string, deviceKind: NotificationDeviceKind, id: string) => removePresenceSocket(userId, deviceKind, id, now()));
  const socketId = socket.id || `presence-local-${++syntheticSocketSeq}`;
  let last: { active: boolean; locked: boolean; capability: string; at: number } | null = null;
  let recorded = false;
  const warn = (what: string) => (err: unknown) => {
    // Losing one write only means a device is notified (or not) for a minute.
    console.warn(`[Socket] presence ${what} failed:`, err instanceof Error ? err.message : String(err));
  };

  const handle = (report: PresenceActivityReport | null) => {
    if (!report) return;
    const at = now();
    // A report whose input is already past the window, or locked, is "stopped".
    const active = reportShowsActive(report, at);
    const locked = report.locked === true;
    // What decides deliverability: the ack capability and this browser's push subscription.
    const capability = `${report.ackAlerts === true}:${report.pushSubscribed === false ? "" : report.pushEndpointHash ?? ""}`;
    if (last) {
      const elapsed = at - last.at;
      // Stopping, a change of lock, and a change of what can deliver here
      // (ack capability, push subscription) are never dropped: a lost one
      // would keep the phone quiet, or route on stale facts.
      const urgent = (!active && last.active) || locked !== last.locked || capability !== last.capability;
      const minimum = last.active === active ? PRESENCE_ACTIVITY_MIN_INTERVAL_MS : PRESENCE_ACTIVITY_MIN_CHANGE_MS;
      if (!urgent && elapsed < minimum) return;
    }
    last = { active, locked, capability, at };
    recorded = true;
    record(identity.userId, kind, report, at, socketId).catch(warn("activity record"));
  };

  socket.on(PRESENCE_ACTIVITY_EVENT, (payload: unknown) => handle(parsePresenceActivityReport(payload)));
  if (kind === "desktop") {
    socket.on(DESKTOP_INPUT_PRESENCE_EVENT, (payload: unknown) => handle(desktopInputPresenceToReport(payload)));
  }
  socket.on("disconnect", () => {
    last = null;
    if (!recorded) return;
    recorded = false;
    // On failure the entry lapses by itself within PRESENCE_ONLINE_TTL_MS.
    remove(identity.userId, kind, socketId).catch(warn("socket remove"));
  });
}
