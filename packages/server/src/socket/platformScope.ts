import type { Server as SocketServer } from "socket.io";

export const SOCKET_CLIENT_KINDS = ["web", "mobile", "desktop", "cli"] as const;

export type SocketClientKind = typeof SOCKET_CLIENT_KINDS[number];

export type SocketEventPlatformScope = readonly SocketClientKind[];

const SOCKET_EVENT_PLATFORM_SCOPES: Record<string, SocketEventPlatformScope | undefined> = {
  "notification:push": ["mobile"],
};

export function isSocketClientKind(value: unknown): value is SocketClientKind {
  return typeof value === "string" && (SOCKET_CLIENT_KINDS as readonly string[]).includes(value);
}

export function parseSocketClientKind(value: unknown): SocketClientKind | null {
  if (value === undefined || value === null) return "web";
  return isSocketClientKind(value) ? value : null;
}

export function socketClientKindRoom(userId: string, clientKind: SocketClientKind): string {
  return `user:${userId}:clientKind:${clientKind}`;
}

/** The sockets of one user that are attached to one server. Send-time room
 * grants (DM participants, thread followers) must target exactly this set.
 * Socket.IO `in(a).in(b)` is a UNION, so chaining `user:` and `server:` rooms
 * would grant every socket in the server. */
export function socketUserServerRoom(userId: string, serverId: string): string {
  return `user:${userId}:server:${serverId}`;
}

export function getSocketEventPlatformScope(event: string): SocketEventPlatformScope | null {
  return SOCKET_EVENT_PLATFORM_SCOPES[event] ?? null;
}

export function emitPlatformScopedUserEvent(
  io: SocketServer,
  userId: string,
  event: string,
  payload: unknown,
): void {
  const platformScope = getSocketEventPlatformScope(event);
  if (!platformScope) {
    io.to(`user:${userId}`).emit(event, payload);
    return;
  }

  for (const clientKind of platformScope) {
    io.to(socketClientKindRoom(userId, clientKind)).emit(event, payload);
  }
}
