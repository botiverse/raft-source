import type { Server as SocketServer } from "socket.io";
import { agentActivityCapableServerRoom } from "@botiverse/raft-shared";

export const SOCKET_CLIENT_KINDS = ["web", "mobile", "desktop", "cli"] as const;

export type SocketClientKind = typeof SOCKET_CLIENT_KINDS[number];

export type SocketEventPlatformScope = readonly SocketClientKind[];

const SOCKET_EVENT_PLATFORM_SCOPES: Record<string, SocketEventPlatformScope | undefined> = {
  "notification:push": ["mobile"],
  // Server-authored desktop notifications (packages/shared desktopNotifications.ts).
  "notification:desktop": ["desktop"],
  // Read-position retraction reaches every notifying client, never cli (docs/contracts/notifications.md §5).
  "notification:retract": ["desktop", "web", "mobile"],
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

/**
 * The room for every server-wide event about one agent: directory events
 * (`agent:created`, `agent:updated`, `agent:deleted`, the archive's update),
 * `agent:activity`, `agent:session` and `agent:seen`. The whole server's
 * members, except for a personal assistant, whose events reach only its
 * owner's sockets on this server. Nobody else may find another person's
 * assistant (agentFindableBy), not even by an id in an event, nor learn when
 * its owner is using it.
 */
export function agentEventRoom(serverId: string, assistantOwnerUserId: string | null | undefined): string {
  return assistantOwnerUserId ? socketUserServerRoom(assistantOwnerUserId, serverId) : `server:${serverId}`;
}

/**
 * agentEventRoom for the coarse activity state (AGENT_ACTIVITY_STATE_EVENT),
 * which goes to the capable clients only: the server's capable room, or for a
 * personal assistant its owner's sockets on this server (Socket.IO has no
 * intersection of rooms; a client without the capability ignores the event).
 */
export function agentActivityStateRoom(serverId: string, assistantOwnerUserId: string | null | undefined): string {
  return assistantOwnerUserId ? agentEventRoom(serverId, assistantOwnerUserId) : agentActivityCapableServerRoom(serverId);
}

/** Guest connections of a server. Guests stay out of `server:<id>` because that
 * room carries metadata they may not read; per-socket authorized publication
 * addresses both rooms to reach every connection of the server. */
export function socketServerGuestsRoom(serverId: string): string {
  return `server:${serverId}:guests`;
}

/** Every connection attached to a server: members plus guests. Pass to a single
 * `in()` call (an array is one union target, not a chained target). */
export function socketServerAllRooms(serverId: string): string[] {
  return [`server:${serverId}`, socketServerGuestsRoom(serverId)];
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
