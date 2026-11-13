/**
 * The `activity:changed` frame (shared ActivityChangedEvent): tells people
 * their Activity changed, so their clients refetch it. Sent to each person's
 * own room (`user:<id>`), after the change has committed; it carries no
 * content. Generic: object events name no app here.
 *
 * - announceObjectEvents (platform/activity): after the transaction that
 *   recorded object events commits, the people among their recipients. Reads
 *   the recipients back, so an event whose transaction rolled back announces
 *   nothing. A joint channel's object is announced for each of the person's
 *   servers in that joint too, where their row is listed (#68).
 * - announceActivityChanged: a person's own Done, undo or read of an object
 *   row, for their other tabs and devices; and the people whose rows went
 *   with a deleted object (platform/activity forgetObjectActivity).
 *
 * The socket server is set once by server.ts (as billingService's), and by
 * the test app; with none set (a job runner, a unit test) nothing is sent.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { ACTIVITY_CHANGED_EVENT, type ActivityChangedEvent } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { objectEventRecipients, objectEvents, serverMembers } from "../db/schema";
import { jointHomeProjections, jointHomeRecords, uuidArray } from "./visibilityService";

type ActivityEmitter = Pick<SocketServer, "to">;

let emitter: ActivityEmitter | null = null;

/** Set by server.ts once Socket.io is up (and by the test app); null stops sending. */
export function setActivityRealtimeIO(io: ActivityEmitter | null): void {
  emitter = io;
}

/** `activity:changed` to each of these people for `serverId`. */
export function announceActivityChanged(serverId: string, userIds: Iterable<string>): void {
  if (!emitter) return;
  const payload: ActivityChangedEvent = { serverId, source: "object" };
  for (const userId of new Set(userIds)) emitter.to(`user:${userId}`).emit(ACTIVITY_CHANGED_EVENT, payload);
}

/**
 * Of these recipients of events on objects homed in a joint channel, each
 * other server in that joint (an active projection) the person is a member
 * of: their row of the object is listed there too (services/objectActivity
 * jointRowsSeen, which decides whether it shows; the ping only asks the
 * client to read Activity again). Three queries when any is homed in a joint.
 */
async function jointServersHearing(rows: ReadonlyArray<{ serverId: string; userId: string; homeKind: string | null; homeChannelId: string | null }>): Promise<Array<{ serverId: string; userId: string }>> {
  const homeIds = [...new Set(rows.flatMap((row) => (row.homeKind === "conversation" && row.homeChannelId ? [row.homeChannelId] : [])))];
  if (homeIds.length === 0) return [];
  const canonicalOf = new Map((await jointHomeRecords("any", { localChannelIds: homeIds })).map((record) => [record.localChannelId, record.canonicalChannelId]));
  const canonical = (id: string) => canonicalOf.get(id) ?? id;
  const serversOf = new Map<string, string[]>();
  for (const projection of await jointHomeProjections("any", { canonicalChannelIds: [...new Set(homeIds.map(canonical))] })) {
    serversOf.set(projection.canonicalChannelId, [...(serversOf.get(projection.canonicalChannelId) ?? []), projection.serverId]);
  }
  if (serversOf.size === 0) return [];
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const servers = [...new Set([...serversOf.values()].flat())];
  const members = await getDb().select({ userId: serverMembers.userId, serverId: serverMembers.serverId }).from(serverMembers)
    .where(and(sql`${serverMembers.userId} = ANY(${uuidArray(userIds)})`, sql`${serverMembers.serverId} = ANY(${uuidArray(servers)})`));
  const memberOf = new Set(members.map((row) => `${row.userId}:${row.serverId}`));
  return rows.flatMap((row) => (row.homeKind === "conversation" && row.homeChannelId
    ? (serversOf.get(canonical(row.homeChannelId)) ?? [])
      .filter((serverId) => serverId !== row.serverId && memberOf.has(`${row.userId}:${serverId}`))
      .map((serverId) => ({ serverId, userId: row.userId }))
    : []));
}

/**
 * After the commit that took these rows away (platform/activity
 * forgetObjectActivity): `activity:changed` to each person for the object's
 * server at once, and, for an object homed in a joint, for their other
 * servers in it after (jointServersHearing; never throws).
 */
export function announceForgottenRows(rows: ReadonlyArray<{ userId: string; serverId: string; homeKind: string | null; homeChannelId: string | null }>): void {
  if (!emitter || rows.length === 0) return;
  for (const serverId of new Set(rows.map((row) => row.serverId))) {
    announceActivityChanged(serverId, rows.filter((row) => row.serverId === serverId).map((row) => row.userId));
  }
  void jointServersHearing(rows).then((more) => {
    for (const serverId of new Set(more.map((row) => row.serverId))) {
      announceActivityChanged(serverId, more.filter((row) => row.serverId === serverId).map((row) => row.userId));
    }
  }).catch((error: unknown) => {
    console.error("[activity] announcing forgotten rows failed", error instanceof Error ? error.message : error);
  });
}

/**
 * After the commit of the transaction that recorded these object events
 * (recordObjectEvent's ids): `activity:changed` to the people among their
 * recipients, once per person and server. One query; never throws (the frame
 * is a hint: a client that misses it refetches on its next load).
 */
export async function announceObjectEvents(eventIds: readonly string[]): Promise<void> {
  if (!emitter || eventIds.length === 0) return;
  try {
    const rows = await getDb()
      .select({ serverId: objectEvents.serverId, userId: objectEventRecipients.recipientId, homeKind: objectEvents.homeKind, homeChannelId: objectEvents.homeChannelId })
      .from(objectEventRecipients)
      .innerJoin(objectEvents, eq(objectEvents.id, objectEventRecipients.eventId))
      .where(and(inArray(objectEventRecipients.eventId, [...new Set(eventIds)]), eq(objectEventRecipients.recipientType, "user")));
    const byServer = new Map<string, string[]>();
    const add = (serverId: string, userId: string) => byServer.set(serverId, [...(byServer.get(serverId) ?? []), userId]);
    for (const row of rows) add(row.serverId, row.userId);
    for (const { serverId, userId } of await jointServersHearing(rows)) add(serverId, userId);
    for (const [serverId, userIds] of byServer) announceActivityChanged(serverId, userIds);
  } catch (error) {
    console.error("[activity] announcing object events failed", error instanceof Error ? error.message : error);
  }
}
