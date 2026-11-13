// The ONE reader of the server's Raft Desktop notification stream
// (`notification:desktop`, contract v1 in packages/shared
// desktopNotifications.ts).
//
// The server authors every Raft Desktop notification (all of the user's
// servers, the same audience as web and mobile push, the text) and sends it to
// this user's desktop sockets only. Raft Desktop has no notification path of
// its own: an unread count going up never raises one. Ids are deduped in the
// gate (notificationGate.ts) and again in the shell.
//
// This file only adds the device-local checks: a non-empty title, the route
// guard, staleness and membership, and puts the server's fixed phrases in the
// display language (localizeNotification.ts). It listens on the app's
// current socket and on every socket that replaces it (followSocket.ts).

import {
  DESKTOP_NOTIFICATION_EVENT,
  isDesktopNotificationRoute,
  parseDesktopNotificationV1,
  parseNotificationEnvelopeFields,
} from "@botiverse/raft-shared";
import type { DesktopNotificationRequest } from "@botiverse/raft-shared";
import { localizeNotificationKey, localizeNotificationText } from "../localizeNotification";
import type { NotificationKeyLocalizer } from "../localizeNotification";
import { followSocket } from "./followSocket";
import type { EventSocketLike, SocketSource } from "./followSocket";

// The server also drops events older than 10 minutes at claim time; this is
// the client's tighter check against a socket that delivered late. A test
// notification is never dropped as stale (the settings card waits for it).
export const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Validate a `notification:desktop` payload and turn it into the main-process
 * request, or null to drop it (unknown version, malformed, stale, or for a
 * server this user is not in). The envelope additions (contract §4.4) carry
 * through: `silent` (the account sound setting), `seq` (retraction closes
 * seq <= throughSeq) and `testId`; `localization` turns the server's English
 * title / subtitle / body into the display language where it has a key.
 */
export function adaptServerNotification(
  payload: unknown,
  ctx: { now: number; isMemberOf(serverId: string): boolean; localize?: NotificationKeyLocalizer },
): DesktopNotificationRequest | null {
  const p = parseDesktopNotificationV1(payload);
  if (!p) return null;
  if (!p.id || !p.title.trim() || !p.serverId || !p.groupKey) return null;
  if (!isDesktopNotificationRoute(p.url)) return null;
  const envelope = parseNotificationEnvelopeFields(payload);
  const createdAt = Date.parse(p.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  if (!envelope.testId && ctx.now - createdAt > STALE_AFTER_MS) return null;
  if (!ctx.isMemberOf(p.serverId)) return null;
  const text = localizeNotificationText(
    { title: p.title, ...(p.subtitle ? { subtitle: p.subtitle } : {}), body: p.body },
    envelope.localization,
    ctx.localize ?? localizeNotificationKey,
  );
  return {
    id: p.id,
    kind: p.kind,
    title: text.title,
    ...(text.subtitle ? { subtitle: text.subtitle } : {}),
    body: text.body,
    ...(p.serverName ? { groupTitle: p.serverName } : {}),
    groupKey: p.groupKey,
    ...(p.replaceKey ? { replaceKey: p.replaceKey } : {}),
    route: p.url,
    mentioned: p.mentioned,
    source: "server",
    ...(envelope.silent !== undefined ? { silent: envelope.silent } : {}),
    ...(envelope.seq !== undefined ? { seq: envelope.seq } : {}),
    // `test` lets the shell skip its throttle, so the ack is truthful.
    ...(envelope.testId ? { testId: envelope.testId, test: true } : {}),
  };
}

/**
 * Hands every valid server notification to `onRequest`, on the app's current
 * socket and on every socket that replaces it. Returns the unsubscribe.
 *
 * `onRequest` returns whether the notification was delivered here (posted,
 * or held back on purpose). Only then is the server's ack answered, with
 * this socket's id: the server keeps the phone quiet on an ack from the
 * computer in use (contract §1.3). A payload this app drops, or a show()
 * that threw, is not acked, so the phone alerts.
 */
export function createServerNotificationSource(deps: {
  sockets: SocketSource<EventSocketLike>;
  now(): number;
  isMemberOf(serverId: string): boolean;
  onRequest(request: DesktopNotificationRequest): boolean | void;
}): () => void {
  return followSocket(deps.sockets, (socket) => {
    const handler = (payload: unknown, ack?: unknown) => {
      const request = adaptServerNotification(payload, { now: deps.now(), isMemberOf: deps.isMemberOf });
      if (!request) return;
      const delivered = deps.onRequest(request) === true;
      if (delivered && typeof ack === "function") ack({ received: true, socketId: socket.id ?? null });
    };
    socket.on(DESKTOP_NOTIFICATION_EVENT, handler as (...args: unknown[]) => void);
    return () => { socket.off(DESKTOP_NOTIFICATION_EVENT, handler as (...args: unknown[]) => void); };
  });
}
