/**
 * The list-changed pings (shared listChangedEvents.ts): `{ serverId }` only,
 * telling a client to read one of the lists it polls again. Each announce
 * is sent once the ambient transaction COMMITS (afterAmbientCommit), never
 * after a rollback, and at most once per room and event in one transaction,
 * so a writer may announce from inside its transaction, its caller's, or with
 * none open (sent at once). Callers announce where the change is written:
 *
 * - permission-updates:changed (`server:<id>`): App installs (an official
 *   App's auto-install included), grants, text confirmations and uninstalls
 *   (that server); a server-local App made shareable (its server); an App's
 *   permission request, its prompt text and its deletion (every server it is
 *   installed on). A marketplace review decision (publish/offline, permission
 *   approval) is announced by the decision function's own
 *   marketplace_review_outbox rows, whoever decided, which
 *   services/marketplaceReviewOutbox.ts sends with
 *   announcePermissionUpdatesCommitted.
 * - joint-invites:changed (the invitee's `user:<id>:server:<id>`): an invite
 *   created, resent, accepted or expired on accept; the joint's source copy
 *   deleted or disconnected, or the joint undone (every pending invitee).
 * - seat-join-blocks:changed (`server:<id>`): a block recorded or ended; a
 *   member joined, left or changed role on a server with an active block
 *   (seats taken or freed, or who is shown which notice).
 *
 * Feature flags that gate a list (pro_seat_add, app_prompt_text_consent)
 * are written by Feature Flag Admin straight to Postgres, with no writer
 * here: the web asks the gated list again on `server:features-changed`.
 *
 * An operation that commits more than one transaction (a joint invite and
 * its same-admin accept) runs in coalesceListChanges: what its transactions
 * announce is sent once each when it ends.
 *
 * A send never throws: an emit error is logged, so a committed write never
 * turns into a failed request and never stops the other pings.
 *
 * Every write to a table behind these lists either announces in its function
 * or says why it needs none: listChangedWriters.contract.test.ts.
 *
 * The socket server is set once by server.ts (as activityRealtime's), and by
 * the test app; with none set (a job runner, a unit test) nothing is sent.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  JOINT_INVITES_CHANGED_EVENT,
  PERMISSION_UPDATES_CHANGED_EVENT,
  SEAT_JOIN_BLOCKS_CHANGED_EVENT,
  type ListChangedEvent,
  type ListChangedEventName,
} from "@botiverse/raft-shared";
import { afterAmbientCommit } from "../db/ambientTransaction";
import type { DatabaseExecutor } from "../db/index";
import { jointChannelInvites, oauthClientInstalls, seatJoinBlocks } from "../db/schema";
import { socketUserServerRoom } from "../socket/platformScope";

type ListChangedEmitter = Pick<SocketServer, "to">;

let emitter: ListChangedEmitter | null = null;

/** Set by server.ts once Socket.io is up (and by the test app); null stops sending. */
export function setListChangedRealtimeIO(io: ListChangedEmitter | null): void {
  emitter = io;
}

/**
 * Sends held by a running coalesceListChanges, by event and room. `closed`
 * once it has ended: work it started that outlives it (a detached promise
 * keeps the store) sends directly instead of into a map already flushed.
 */
type HeldSends = { sends: Map<string, () => void>; closed: boolean };
const heldSends = new AsyncLocalStorage<HeldSends>();

function send(event: ListChangedEventName, room: string, serverId: string): void {
  const payload: ListChangedEvent = { serverId };
  try {
    emitter?.to(room).emit(event, payload);
  } catch (error) {
    console.error(`[listChanged] ${event} to ${room} failed:`, error);
  }
}

function announce(event: ListChangedEventName, room: string, serverId: string): void {
  afterAmbientCommit(`${event}|${room}`, () => sendOrHold(event, room, serverId));
}

function sendOrHold(event: ListChangedEventName, room: string, serverId: string): void {
  const key = `${event}|${room}`;
  const held = heldSends.getStore();
  if (held && !held.closed) held.sends.set(key, () => send(event, room, serverId));
  else send(event, room, serverId);
}

/**
 * Runs an operation of several transactions, holding what they announce
 * (once committed) until it ends, then sending each event and room once,
 * whether it ended in success or an error (what committed has changed).
 */
export async function coalesceListChanges<T>(operation: () => Promise<T>): Promise<T> {
  const outer = heldSends.getStore();
  if (outer && !outer.closed) return operation();
  const held: HeldSends = { sends: new Map(), closed: false };
  try {
    return await heldSends.run(held, operation);
  } finally {
    held.closed = true;
    for (const flush of held.sends.values()) flush();
  }
}

/** The App permission updates of these servers may have changed. */
export function announcePermissionUpdatesChanged(serverIds: Iterable<string>): void {
  for (const serverId of new Set(serverIds)) announce(PERMISSION_UPDATES_CHANGED_EVENT, `server:${serverId}`, serverId);
}

/**
 * For an outbox's deliverer: the change was committed by another transaction
 * (its outbox row says so), so the ping goes now, even from inside the
 * deliverer's own transaction (which only marks the row delivered, after the
 * send). Held by a running coalesceListChanges like any announce.
 */
export function announcePermissionUpdatesCommitted(serverIds: Iterable<string>): void {
  for (const serverId of new Set(serverIds)) sendOrHold(PERMISSION_UPDATES_CHANGED_EVENT, `server:${serverId}`, serverId);
}

/**
 * An App changed in a way every server it is installed on may need to
 * review (its permission request, review, prompt text, deletion): announce
 * permission-updates:changed to each of them. Reads the installs now, through
 * `executor` (the writer's transaction, so a deletion calls this before it
 * deletes); sends after the commit.
 */
export async function announcePermissionUpdatesForApp(executor: DatabaseExecutor, clientId: string): Promise<void> {
  if (!emitter) return;
  const rows = await executor.selectDistinct({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, clientId));
  announcePermissionUpdatesChanged(rows.map((row) => row.serverId));
}

/** Pending joint invites changed for these invitees on these (invited) servers. */
export function announceJointInvitesChanged(invites: Iterable<{ toServerId: string; invitedUserId: string }>): void {
  for (const invite of invites) {
    announce(JOINT_INVITES_CHANGED_EVENT, socketUserServerRoom(invite.invitedUserId, invite.toServerId), invite.toServerId);
  }
}

/**
 * These joints' pending invites may have left their invitees' lists without
 * an invite row being written: the source copy was deleted or disconnected,
 * or the joint went away (the list reads only invites whose source copy is
 * active and not deleted). Reads the invitees now, through `executor` (the
 * writer's transaction); sends after the commit.
 */
export async function announceJointInvitesForJoints(executor: DatabaseExecutor, jointChannelIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(jointChannelIds)];
  if (!emitter || ids.length === 0) return;
  const rows = await executor.select({ toServerId: jointChannelInvites.toServerId, invitedUserId: jointChannelInvites.invitedUserId })
    .from(jointChannelInvites)
    .where(and(inArray(jointChannelInvites.jointChannelId, ids), eq(jointChannelInvites.status, "pending")));
  announceJointInvitesChanged(rows);
}

/** Who a full link turned away from these servers may have changed. */
export function announceSeatJoinBlocksChanged(serverIds: Iterable<string>): void {
  for (const serverId of new Set(serverIds)) announce(SEAT_JOIN_BLOCKS_CHANGED_EVENT, `server:${serverId}`, serverId);
}

/**
 * A server's seats were taken or freed (a member joined or left), or a
 * member's role changed (an owner or admin is shown every notice, anyone else
 * only those they invited): its list is shown only while the seats are full,
 * so it may have appeared, gone or changed for someone. Only
 * a server with an active notice is told (read through `executor`, the
 * writer's transaction); sends after the commit.
 */
export async function announceSeatJoinBlocksForSeatChange(executor: DatabaseExecutor, serverId: string): Promise<void> {
  if (!emitter) return;
  const [active] = await executor.select({ id: seatJoinBlocks.id }).from(seatJoinBlocks)
    .where(and(eq(seatJoinBlocks.serverId, serverId), eq(seatJoinBlocks.state, "active")))
    .limit(1);
  if (active) announceSeatJoinBlocksChanged([serverId]);
}
