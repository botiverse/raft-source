/**
 * Desktop socket transport (docs/contracts/notifications.md §4.4):
 * `notification:desktop` with the DesktopNotificationV1 envelope, emitted to
 * the user's desktop sockets only (socket/platformScope.ts scopes the event).
 */
import type { Server as SocketServer } from "socket.io";
import { DESKTOP_NOTIFICATION_EVENT, type NotificationEnvelope } from "@botiverse/raft-shared";
import { emitPlatformScopedUserEvent, getSocketEventPlatformScope, socketClientKindRoom } from "../../../socket/platformScope";

export function emitDesktopNotification(io: SocketServer, userId: string, envelope: NotificationEnvelope): void {
  emitPlatformScopedUserEvent(io, userId, DESKTOP_NOTIFICATION_EVENT, envelope);
}

/**
 * The same emit, asking each desktop socket to ack on receipt (Raft Desktop
 * does, presenceReport `ackAlerts`, with its socket id once it posted or
 * deliberately held the alert). Resolves within `timeoutMs` with the socket
 * ids that acked, across replicas (the Redis adapter carries broadcast acks).
 * The caller counts only the sockets it believes active: an idle desktop
 * elsewhere acking does not prove the computer in use got it.
 */
export function emitDesktopNotificationWithAck(io: SocketServer, userId: string, envelope: NotificationEnvelope, timeoutMs: number): Promise<string[]> {
  const scope = getSocketEventPlatformScope(DESKTOP_NOTIFICATION_EVENT);
  const rooms = scope ? scope.map((clientKind) => socketClientKindRoom(userId, clientKind)) : [`user:${userId}`];
  return new Promise((resolve) => {
    io.timeout(timeoutMs).to(rooms).emit(DESKTOP_NOTIFICATION_EVENT, envelope, (_err: Error | null, responses?: unknown[]) => {
      // On a timeout `_err` is set and `responses` holds the acks that did arrive.
      resolve((Array.isArray(responses) ? responses : []).flatMap((response) => {
        const socketId = (response as { socketId?: unknown } | null)?.socketId;
        return typeof socketId === "string" ? [socketId] : [];
      }));
    });
  });
}
