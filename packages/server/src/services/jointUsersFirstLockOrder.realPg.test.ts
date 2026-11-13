// Real-PostgreSQL proofs of the users-first lock rule for joint membership and
// connection transactions (lockJointUsersFirst / lockJointActorFirst,
// jointHumanMembershipMirror.ts). Account deletion takes a person's `users`
// row FOR UPDATE, then the servers they own FOR UPDATE (requestAccountDeletion;
// retireDueAccounts -> handOverOwnedServers). A transaction that locks a server,
// channel, member or J first and takes that users row only later (an FK check
// on an insert naming the person, lockReferencedRows) closes a cycle with it.
// Caught three times in review (#13716, #13760, #13773).
//
// 1. Guard: every entry point in ENTRY_POINTS runs once with every SQL
//    statement recorded per transaction. Each of its transactions that writes
//    joint membership or connection rows (JOINT_WRITE) must take, as its first
//    lock (a row lock, an advisory lock or a write), the users rows FOR KEY
//    SHARE, including the people listed for it. The only lock allowed before
//    is the channel conversion writer fence (withChannelWriterFence), which
//    account deletion never takes. A new path that changes joint membership
//    or a server's connection: add it to ENTRY_POINTS.
// 2. Interleavings against the actor's own account deletion, in both orders
//    (the deletion paused holding the users row, the owned servers still
//    ahead; or the entry point paused past its first J lock): "Your servers"
//    (host_direct), a Guest's accept, a host's disconnect, a conversion start
//    (its command), Invite People Outside, creating a joint channel,
//    resending its invites, deleting a channel with a Guest, a role change,
//    a mention's add, resending and revoking an emailed invite, a channel
//    admin's add and removal, an archive with a Guest, inviting a server, an
//    approver's approval (against the approver's deletion), and (against a
//    person it writes for: no actor) the conversion's cutover and finalize.
//    Neither waits on the other in a cycle; with the deletion first the entry
//    point refuses (the worker waits, then finishes).
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { channelConversionJobs, channelExternalInvites, channelHumans, channels, channelServerConnectRequests, jointChannelInvites, jointChannelServers, messageMentions, serverMembers, servers } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { USERS_FIRST, usersFirstViolation, type Statement } from "../test/jointUsersFirstGuard";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { acceptJointChannelInvite, addHuman, archiveBoundGuestIds, archiveChannel, createChannel, createJointChannel, deleteChannel, disconnectJointChannel, disconnectParticipantServerByHost, getChannel, inviteServerToJointChannel, removeHuman, resendPendingJointChannelInvites, type EndedChannelGuest } from "./channelService";
import { withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import {
  JOINT_WRITE_TABLES,
  type JointUsersFirstEntryPoint,
  type JointUsersFirstKnownException,
} from "../test/jointUsersFirstEntryPoints";
import { retireDueAccounts } from "./accountDeletion/cleanup";
import { requestAccountDeletion } from "./accountDeletion/requests";
import { runChannelConversionJob } from "./channelConversionService";
import { CHANNEL_CONVERSION_LOCK_NAMESPACE } from "./channelConversionFenceService";
import {
  __setInviteSourcesStartedBarrierForTests,
  advanceExternalConnect,
  approveServerConnectRequest,
  connectOwnServersToChannel,
  connectServerWithInvite,
  requestServerConnectApproval,
} from "./externalInviteConnectService";
import { acceptExternalInviteAsGuest, resendExternalInvite, revokeExternalInvite, sendExternalInvites } from "./externalInviteService";
import { conversionCommandId, runConversionCommand } from "./channelConversionCommandService";
import { connectMyServersToChannel, resolveMemberConnectEntry } from "./jointMemberConnectService";
import { removeMember, transitionMemberRole } from "./serverService";
import { executeMentionActionId } from "./mentionActionService";
import { createMessage } from "./messageService";
import { JointActorUnavailableError } from "./jointHumanMembershipMirror";

// ── World ──

/**
 * Host H (owner hostOwner, co-owner coOwner so hostOwner's deletion can be
 * requested; admin A, in the joint through H, sole owner of S) and
 * participant P (owner peerOwner; members m, leaver, x, all in the joint
 * through P; x sole owner of S2). Joint J connected; computed membership.
 * g (sole owner of SG) holds an emailed invite to H's copy (Guest accept);
 * e (sole owner of E1) another (connect with an invite). A private channel of
 * H with A in it ("Your servers" reserving its conversion). r holds an
 * emailed invite too and is a plain member of T, owned by approver ap (with
 * co-owner coT, so ap's deletion can be requested; ap2 an admin of T). n: a
 * member of P not in the joint (the channel-level add).
 */
async function seedWorld(db: Database, label: string) {
  await setJointFlags(db, false);
  const seed = createSeed(db);
  const hostOwner = await seed.human(), coOwner = await seed.human(), a = await seed.human(), peerOwner = await seed.human();
  const m = await seed.human(), leaver = await seed.human(), x = await seed.human(), g = await seed.human(), e = await seed.human();
  const r = await seed.human(), ap = await seed.human(), coT = await seed.human(), ap2 = await seed.human(), n = await seed.human();
  const h = await seed.server({ owner: hostOwner }), p = await seed.server({ owner: peerOwner, members: [m, leaver, x, n] });
  const t = await seed.server({ owner: ap, members: [r] });
  const s = await seed.server({ owner: a }), s2 = await seed.server({ owner: x }), sg = await seed.server({ owner: g }), e1 = await seed.server({ owner: e });
  await db.insert(serverMembers).values([
    { serverId: h.id, userId: coOwner.id, role: "owner" },
    { serverId: h.id, userId: a.id, role: "admin" },
    { serverId: t.id, userId: coT.id, role: "owner" },
    { serverId: t.id, userId: ap2.id, role: "admin" },
  ]);
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, p.id, s.id, s2.id, sg.id, e1.id, t.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: label.slice(0, 40),
    targetServerSlug: p.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [a.id] });
  const pLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p.id, acceptedByUserId: peerOwner.id })).id;
  for (const person of [m, leaver, x]) await addHuman(pLocal, person.id);
  await enableExternalChannelsFlag(h.id);
  const hLocal = created.channel.id;
  const emailed = async (person: { email: string }) => {
    const token = randomBytes(32).toString("hex");
    await db.insert(channelExternalInvites).values({ channelId: hLocal, hostServerId: h.id, email: person.email.toLowerCase(),
      tokenHash: createHash("sha256").update(token).digest("hex"), invitedByUserId: hostOwner.id, expiresAt: new Date(Date.now() + 86_400_000), origin: "external_invite" });
    return token;
  };
  const guestToken = await emailed(g), connectToken = await emailed(e), requestToken = await emailed(r);
  const room = await createChannel(h.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: hostOwner.id });
  await addHuman(room.id, a.id);
  return { hostOwner, coOwner, a, peerOwner, m, leaver, x, g, e, r, ap, coT, ap2, n, h, p, s, s2, sg, e1, t,
    J: created.jointChannel.id, hLocal, pLocal, room: room.id, guestToken, connectToken, requestToken };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

function connected<T extends { servers: Array<{ state: string; error?: unknown }> }>(result: T): T {
  const [outcome] = result.servers;
  if (outcome?.state === "refused") throw outcome.error;
  return result;
}

async function selfConnect(w: World) {
  const channel = await getChannel(w.pLocal);
  const entry = await resolveMemberConnectEntry(channel!, w.x.id);
  if (!entry) throw new Error("not a member");
  return connected(await connectMyServersToChannel(entry, w.x.id, [w.s2.id]));
}

/** A conversion command (admitConversionCommand, then executeConversionCommand), by H's owner. */
async function convertRoom(w: World) {
  return runConversionCommand({ id: conversionCommandId(undefined), serverId: w.h.id, sourceChannelId: w.room, requestedByUserId: w.hostOwner.id, kind: "start" });
}
/** Invite People Outside on the private room, by H's owner. */
async function inviteOutside(w: World) {
  const result = await sendExternalInvites(w.room, w.hostOwner.id, [`outside-${randomUUID().slice(0, 8)}@example.com`]);
  assert.equal(result.sent.length, 1, JSON.stringify(result.skipped));
  return result;
}
/** An emailed invite to `channelId` by H's owner, for `email`: its token. */
async function emailedInvite(db: Database, w: World, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  await db.insert(channelExternalInvites).values({ channelId, hostServerId: w.h.id, email: email.toLowerCase(),
    tokenHash: createHash("sha256").update(token).digest("hex"), invitedByUserId: w.hostOwner.id, expiresAt: new Date(Date.now() + 86_400_000), origin: "external_invite" });
  return token;
}
async function inviteIdFor(db: Database, channelId: string, email: string) {
  const [invite] = await db.select({ id: channelExternalInvites.id }).from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, channelId), eq(channelExternalInvites.email, email.toLowerCase()), eq(channelExternalInvites.status, "pending")));
  return invite!.id;
}
/** A new joint channel of H, by H's owner, with A in it, inviting T's owner. */
async function createJoint(w: World) {
  return createJointChannel({ hostServerId: w.h.id, createdByUserId: w.hostOwner.id, name: `uf-new-${randomUUID().slice(0, 8)}`,
    targetServerSlug: w.t.slug, invitedPeople: [`@${w.ap.name}`], userIds: [w.a.id] });
}
/** A pending joint invite of the joint (H to T, for T's owner), to resend. */
async function inviteT(w: World) {
  await inviteServerToJointChannel({ localChannelId: w.hLocal, fromServerId: w.h.id, invitedByUserId: w.hostOwner.id,
    targetServerSlug: w.t.slug, invitedPeople: [`@${w.ap.name}`] });
}
async function resendJointInvites(w: World) {
  return resendPendingJointChannelInvites({ localChannelId: w.hLocal, fromServerId: w.h.id, requestedByUserId: w.hostOwner.id });
}
/** g a Guest of H bound to the private room. */
async function guestInRoom(w: World) {
  const token = await emailedInvite(getDb(), w, w.room, w.g.email);
  await acceptExternalInviteAsGuest(token, w.g.id);
}
/** H's owner makes A (an admin in the joint) a member. */
async function demoteA(w: World) {
  return transitionMemberRole({ serverId: w.h.id, actorUserId: w.hostOwner.id, targetUserId: w.a.id, nextRole: "member" });
}
/** A mention of H's co-owner, by H's owner, in a public channel of H they are not in, pending its add (adds are for public channels and threads). */
async function pendingMention(w: World) {
  const lobby = await createChannel(w.h.id, `lobby-${randomUUID().slice(0, 8)}`, undefined, "channel", { type: "user", id: w.hostOwner.id });
  const message = await createMessage(lobby.id, "user", w.hostOwner.id, `@${w.coOwner.name} pending add`);
  const [mention] = await getDb().insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq, serverId: w.h.id,
    channelId: lobby.id, targetType: "user", targetId: w.coOwner.id, handleAtSendTime: w.coOwner.name, notifiableAtSend: false }).returning();
  return { channelId: lobby.id, mentionId: mention!.id };
}
const pendingMentions = new WeakMap<World, Awaited<ReturnType<typeof pendingMention>>>();
async function mentionAdd(w: World, mention: { mentionId: string }) {
  return executeMentionActionId(mention.mentionId, w.h.id, "user", w.hostOwner.id, "add");
}
/** The room's conversion started and run up to its audience cutover (the worker's next transaction). */
async function conversionAtCutover(w: World) {
  const job = await convertRoom(w);
  for (let current = job; current.phase !== "audience_cutover"; current = await runChannelConversionJob(job.id, { maxPhases: 1 })) {
    assert.ok(current.status !== "failed" && current.phase !== "done", `the conversion stopped before its audience cutover: ${current.status} ${current.phase} ${current.error ?? ""}`);
  }
  return job.id;
}
async function finishConversion(jobId: string) {
  const job = await runChannelConversionJob(jobId);
  assert.equal(job.status, "done", job.error ?? "");
  return job;
}
/** As the route adds a person to a joint channel: under the actor's channel capability (humanSubjectIds: the person). */
async function addToJoint(channelId: string, serverId: string, actorId: string, userId: string) {
  return withLockedChannelActorCapability({ serverId, channelId, actorType: "user", actorId, capability: "addChannelMembers", humanSubjectIds: [userId] },
    (tx) => addHuman(channelId, userId, { executor: tx, actorUserId: actorId }));
}
/** As the route removes a person from a joint channel. */
async function removeFromJoint(channelId: string, serverId: string, actorId: string, userId: string) {
  return withLockedChannelActorCapability({ serverId, channelId, actorType: "user", actorId, capability: "removeChannelMembers", humanSubjectIds: [userId] },
    (tx, context) => removeHuman(channelId, userId, context, tx));
}
/** As POST /channels/:id/archive runs it, by H's owner: its bound Guests guessed, locked first. */
async function archiveRoom(w: World) {
  const endedGuests: EndedChannelGuest[] = [];
  return withLockedChannelActorCapability({ serverId: w.h.id, channelId: w.room, actorType: "user", actorId: w.hostOwner.id, capability: "archiveChannels",
    guessUserIds: () => archiveBoundGuestIds(w.room) }, (tx, _context, lockedUserIds) => {
    endedGuests.length = 0;
    return archiveChannel(w.room, w.hostOwner.id, tx, { endedGuests, lockedUserIds });
  });
}
/** g a Guest bound to the room, and an open emailed invite to it (the archive revokes it, naming the archiver). */
async function guestAndInviteInRoom(w: World) {
  await guestInRoom(w);
  await emailedInvite(getDb(), w, w.room, `open-${randomUUID().slice(0, 8)}@example.com`);
}
/** r's pending request for T to join the joint, asking T's owner ap: its id. */
async function pendingApproval(w: World) {
  return (await requestServerConnectApproval(w.requestToken, w.r.id, w.t.id, w.ap.id)).requestId;
}
const pendingApprovals = new WeakMap<World, string>();
async function requestRow(requestId: string) {
  const [request] = await getDb().select({ status: channelServerConnectRequests.status, cancelReason: channelServerConnectRequests.cancelReason })
    .from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, requestId));
  return request!;
}
async function tSide(w: World) {
  const [side] = await getDb().select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, w.J), eq(jointChannelServers.serverId, w.t.id)));
  return side?.status ?? null;
}

// ── 1. Guard ──

type Scenario = {
  /** The users the first lock must include (the actor first). */
  users: (w: World) => string[];
  /** Runs unrecorded: the path's own setup. */
  prepare?: (w: World) => Promise<void>;
  run: (w: World) => Promise<unknown>;
  /** Writes naming a user that JOINT_WRITE does not count (an invite's update), for this scenario. */
  writes?: RegExp;
};

/**
 * Every transaction entry point that changes joint channel human membership
 * or a server's connection and writes rows naming a user
 * (JOINT_USERS_FIRST_ENTRY_POINTS: a new one there fails to compile until it
 * has its scenario here). jointUsersFirstWriters.contract.test.ts ties every
 * writer of a JOINT_WRITE_TABLES table in the source to one of these, or to
 * its allowlist.
 */
const ENTRY_POINTS: Record<JointUsersFirstEntryPoint, Scenario> = {
  // createDirectConnectInvite, then connectJointChannel (host_direct).
  yourServersJoint: {
    users: (w) => [w.a.id],
    run: async (w) => connected(await connectOwnServersToChannel(w.hLocal, w.a.id, [w.s.id], {})),
  },
  // reserveConnection (host_direct): the conversion's start, the reservation.
  yourServersPrivate: {
    users: (w) => [w.a.id],
    run: async (w) => connected(await connectOwnServersToChannel(w.room, w.a.id, [w.s.id], {})),
  },
  connectWorker: {
    users: (w) => [w.a.id],
    prepare: async (w) => {
      connected(await connectOwnServersToChannel(w.room, w.a.id, [w.s.id], {}));
      const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, w.room));
      assert.equal((await runChannelConversionJob(invite!.connectConversionJobId!)).status, "done");
    },
    run: async (w) => {
      const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, w.room));
      assert.ok(await advanceExternalConnect(invite!.id), "connected");
    },
  },
  // An emailed invite (external_invite): joiner e, inviter hostOwner.
  emailedInviteConnect: {
    users: (w) => [w.e.id, w.hostOwner.id],
    run: async (w) => connectServerWithInvite(w.connectToken, w.e.id, w.e1.id),
  },
  // The requester r and the approver ap.
  requestApproval: {
    users: (w) => [w.r.id, w.ap.id],
    run: async (w) => requestServerConnectApproval(w.requestToken, w.r.id, w.t.id, w.ap.id),
  },
  // createSelfConnectInvite, then selfConnectInTransaction (#13773).
  selfConnect: { users: (w) => [w.x.id], run: selfConnect },
  guestAccept: { users: (w) => [w.g.id], run: async (w) => acceptExternalInviteAsGuest(w.guestToken, w.g.id) },
  hostDisconnect: { users: (w) => [w.hostOwner.id], run: async (w) => disconnectParticipantServerByHost(w.hLocal, w.p.id, w.hostOwner.id) },
  selfDisconnect: { users: (w) => [w.peerOwner.id], run: async (w) => disconnectJointChannel(w.pLocal, w.peerOwner.id) },
  removeMemberByAdmin: {
    users: (w) => [w.m.id, w.peerOwner.id],
    run: async (w) => removeMember(w.p.id, w.m.id, { reason: "removed", actorUserId: w.peerOwner.id }),
  },
  removeMemberLeave: {
    users: (w) => [w.leaver.id],
    run: async (w) => removeMember(w.p.id, w.leaver.id, { reason: "left", actorUserId: w.leaver.id }),
  },
  // The route's admission, then its execution (the start): the job names the requester.
  convertToJoint: { users: (w) => [w.hostOwner.id], run: convertRoom },
  // An emailed invite's row names its inviter.
  sendExternalInvites: { users: (w) => [w.hostOwner.id], run: inviteOutside },
  // The creator, the initial member and the invitee (T's owner).
  createJointChannel: { users: (w) => [w.hostOwner.id, w.a.id, w.ap.id], run: createJoint },
  // The pending invites name the resender.
  resendJointInvites: { users: (w) => [w.hostOwner.id], prepare: inviteT, run: resendJointInvites },
  // The deleter and the Guest the deletion removes.
  deleteChannel: {
    users: (w) => [w.hostOwner.id, w.g.id],
    prepare: guestInRoom,
    run: async (w) => deleteChannel(w.room, { deletedByUserId: w.hostOwner.id }),
  },
  // The actor and the target (the role audit, the joint mirror's revalidation).
  roleTransition: { users: (w) => [w.hostOwner.id, w.a.id], run: demoteA },
  // The adder and the person added.
  mentionAdd: {
    users: (w) => [w.hostOwner.id, w.coOwner.id],
    prepare: async (w) => { pendingMentions.set(w, await pendingMention(w)); },
    run: async (w) => {
      const result = await mentionAdd(w, pendingMentions.get(w)!);
      assert.equal(result.status, "delivered", JSON.stringify(result));
    },
  },
  // No actor: everyone in the room (its creator and A) joins the joint.
  conversionFinalize: {
    users: (w) => [w.hostOwner.id, w.a.id],
    prepare: async (w) => { await conversionAtCutover(w); },
    run: async (w) => {
      const [job] = await getDb().select({ id: channelConversionJobs.id }).from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, w.room));
      await finishConversion(job!.id);
    },
  },
  // The new row names its inviter.
  resendExternalInvite: {
    users: (w) => [w.hostOwner.id],
    run: async (w) => resendExternalInvite(w.hLocal, await inviteIdFor(getDb(), w.hLocal, w.g.email), w.hostOwner.id),
  },
  // The invite names its revoker (an update: not in JOINT_WRITE).
  revokeExternalInvite: {
    users: (w) => [w.hostOwner.id],
    run: async (w) => revokeExternalInvite(w.hLocal, await inviteIdFor(getDb(), w.hLocal, w.e.email), w.hostOwner.id),
    writes: /^\s*update\s+"channel_external_invites"\s+set\b[\s\S]*"revoked_by_user_id"/i,
  },
  // The adder and the person added (P's owner adds n, a member of P outside the joint).
  channelAddHuman: { users: (w) => [w.peerOwner.id, w.n.id], run: async (w) => addToJoint(w.pLocal, w.p.id, w.peerOwner.id, w.n.id) },
  // The remover and the person removed (H's owner removes A: only the host entry removes people).
  channelRemoveHuman: { users: (w) => [w.hostOwner.id, w.a.id], run: async (w) => removeFromJoint(w.hLocal, w.h.id, w.hostOwner.id, w.a.id) },
  // The person leaving.
  channelLeave: { users: (w) => [w.x.id], run: async (w) => removeHuman(w.pLocal, w.x.id, { self: true }) },
  // The archiver (the revoked invite names them) and the Guest it removes.
  archiveChannel: {
    users: (w) => [w.hostOwner.id, w.g.id],
    prepare: guestAndInviteInRoom,
    run: archiveRoom,
    writes: /^\s*update\s+"channel_external_invites"\s+set\b[\s\S]*"revoked_by_user_id"/i,
  },
  // The inviter and the invitee (T's owner).
  inviteServerToJoint: { users: (w) => [w.hostOwner.id, w.ap.id], run: inviteT },
  // The requester (joining), the approver (authorizing) and the invite's sender.
  approveConnectRequest: {
    users: (w) => [w.r.id, w.ap.id, w.hostOwner.id],
    prepare: async (w) => { pendingApprovals.set(w, await pendingApproval(w)); },
    run: async (w) => assert.equal((await approveServerConnectRequest(pendingApprovals.get(w)!, w.ap.id)).state, "connected"),
  },
};

/** JOINT_USERS_FIRST_KNOWN_EXCEPTIONS (none left): each an expected failure of the guard until fixed. */
const KNOWN_EXCEPTIONS: Record<JointUsersFirstKnownException, Scenario> = {};
// Not users-first and not scenarios yet (open follow-ups; the static check
// allowlists their writers with the reason): a joint invite's accept
// (acceptJointChannelInvite[s]), deleteServer and the departure worker. Account deletion's own retirement reaches softDeleteServerInTransaction
// and transitionMemberRoleInTransaction while it holds the users row itself.

const sqlTable = (name: string) => `"?${name}"?[\\s(]`;
const tables = Object.values(JOINT_WRITE_TABLES);
/** Rows a joint membership or connection transaction writes (JOINT_WRITE_TABLES). */
const JOINT_WRITE = new RegExp([
  `^\\s*(?:insert\\s+into|update|delete\\s+from)\\s+(?:${tables.filter((table) => !("insertsOnly" in table)).map((table) => sqlTable(table.sqlName)).join("|")})`,
  `^\\s*insert\\s+into\\s+(?:${tables.filter((table) => "insertsOnly" in table).map((table) => sqlTable(table.sqlName)).join("|")})`,
].join("|"), "i");
/** A DM's creation (a person's own DM, made on first use under its server's DM lock): never a joint write. */
const DM_CREATE = /^\s*insert\s+into\s+"?dm_channel_identities"?[\s(]/i;
type Recorder = { transactions: Statement[][]; open: Map<pg.Client, Statement[]> };
const recording = new AsyncLocalStorage<Recorder>();

/** Records, per transaction, every statement issued in `recording`'s context. Returns its uninstall. */
function installRecorder(): () => void {
  const previous = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const recorder = recording.getStore();
    const config = args[0] as string | { text?: string; values?: unknown[] } | undefined;
    const text = typeof config === "string" ? config : config?.text;
    if (recorder && text) {
      const values = Array.isArray(args[1]) ? args[1] as unknown[] : (typeof config === "object" && config?.values) || [];
      if (/^\s*begin\b/i.test(text)) {
        const tx: Statement[] = [];
        recorder.transactions.push(tx);
        recorder.open.set(this, tx);
      } else if (/^\s*(?:commit|rollback)\s*$/i.test(text)) {
        recorder.open.delete(this);
      } else {
        recorder.open.get(this)?.push({ text, values });
      }
    }
    return (previous as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof previous;
  return () => { pg.Client.prototype.query = previous; };
}

const conversionKey = (channelId: string) => createHash("sha256").update(`${CHANNEL_CONVERSION_LOCK_NAMESPACE}:${channelId}`).digest().readInt32BE(0);

/** Each scenario on a fresh world, its transactions recorded: what breaks the rule. */
async function guardFailures(label: string, scenarios: Record<string, Scenario>): Promise<string[]> {
  const db = getDb();
  const failures: string[] = [];
  {
    for (const [index, [name, scenario]] of Object.entries(scenarios).entries()) {
      const w = await seedWorld(db, `${label}-${index}`);
      await scenario.prepare?.(w);
      const recorder: Recorder = { transactions: [], open: new Map() };
      await recording.run(recorder, () => scenario.run(w));
      const channelIds = (await db.execute<{ id: string }>(sql`SELECT id FROM channels`)).rows.map((row) => row.id);
      const fenceKeys = new Set(channelIds.map(conversionKey));
      const writes = (statement: Statement) => JOINT_WRITE.test(statement.text) || scenario.writes?.test(statement.text) === true;
      const writers = recorder.transactions.filter((tx) => tx.some(writes)
        && !tx.some((statement) => DM_CREATE.test(statement.text)));
      if (writers.length === 0) failures.push(`${name}: no transaction wrote joint rows (the scenario no longer exercises it)`);
      for (const tx of writers) {
        const violation = usersFirstViolation(tx, scenario.users(w), fenceKeys);
        const wrote = tx.find(writes)!.text.replace(/\s+/g, " ").slice(0, 80);
        if (violation) failures.push(`${name} (transaction writing "${wrote}"): ${violation}`);
      }
    }
  }
  return failures;
}

async function withGuardDatabase(label: string, body: () => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    // Before any connection is checked out: the pool binds each one's query on its first checkout.
    const uninstall = installRecorder();
    try {
      await body();
    } finally {
      uninstall();
      await app.close();
    }
  });
}

test.skipIf(skipJointRealPg)("every joint membership / connection entry point takes its users rows as its first lock (ENTRY_POINTS)", async () => {
  await withGuardDatabase("joint_users_first_guard", async () => {
    assert.deepEqual(await guardFailures("uf-guard", ENTRY_POINTS), []);
  });
}, 300_000);

const knownExceptions: Record<string, Scenario> = KNOWN_EXCEPTIONS;
for (const [name, scenario] of Object.entries(knownExceptions)) {
  // Expected to fail (the reason: JOINT_USERS_FIRST_KNOWN_EXCEPTIONS). Passing turns this red: move the scenario to ENTRY_POINTS.
  (skipJointRealPg ? test.skip : test.fails)(`known exception, not users-first yet: ${name}`, async () => {
    await withGuardDatabase(`joint_users_first_known_${name}`.toLowerCase(), async () => {
      assert.deepEqual(await guardFailures(`uf-known-${name}`, { [name]: scenario }), []);
    });
  }, 120_000);
}

// ── 2. Against the actor's own account deletion ──

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>) => {
  const promise = outside(async () => {
    assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
    return run();
  });
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
};
type Settled<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };

async function until(observer: pg.Client, what: string, sqlText: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(sqlText);
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const lockWaiters = `SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}
function assertNoDeadlock(results: Record<string, Settled>) {
  for (const [name, result] of Object.entries(results)) {
    if (!result.ok && /deadlock|lock timeout|canceling statement/i.test(describeError(result.error))) {
      assert.fail(`${name}: ${describeError(result.error)}`);
    }
  }
}

const deadlocks = async (observer: pg.Client) => {
  await observer.query("SELECT pg_stat_clear_snapshot()");
  const { rows } = await observer.query<{ n: string }>("SELECT deadlocks::text n FROM pg_stat_database WHERE datname = current_database()");
  return Number(rows[0]?.n ?? 0);
};
/** No deadlock was detected in this database since `before` (the counter's flush can lag a backend's end: polled briefly). */
async function assertNoDeadlockSince(observer: pg.Client, before: number) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const now = await deadlocks(observer);
    assert.equal(now, before, `PostgreSQL detected ${now - before} deadlock(s): one side was rolled back`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withRealPg(label: string, body: (observer: pg.Client) => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    // After the pause hook, before any connection is checked out (each binds its query then): records only inside `recording`.
    const uninstallRecorder = installRecorder();
    try {
      await body(observer);
    } finally {
      __setInviteSourcesStartedBarrierForTests(null);
      uninstallRecorder();
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

/** Requested through the product path and made due now. */
async function requestDueDeletion(db: Database, userId: string) {
  const requested = await requestAccountDeletion({ userId, source: "self", actorUserId: userId });
  assert.equal(requested.kind, "scheduled", JSON.stringify(requested));
  await db.execute(sql`UPDATE account_deletion_requests SET scheduled_for = now() - interval '1 minute' WHERE user_id = ${userId}::uuid AND state = 'pending'`);
}
/** The whole deletion: requested (users row FOR UPDATE), then retired (users row, then the owned servers, FOR UPDATE). */
async function deleteAccount(db: Database, userId: string) {
  await requestDueDeletion(db, userId);
  return retireDueAccounts({ retirementsPerRun: 1 });
}
/** The retirement holding the users row FOR UPDATE, at its owned servers' lock (handOverOwnedServers). */
const atHandOver = (text: string) => /from "servers"[\s\S]*"owner_id"[\s\S]*for update/i.test(text);
const atFirstJointLock = (text: string, values: readonly unknown[]) => text.includes("pg_advisory_xact_lock(hashtextextended(")
  && values.some((value) => String(value).startsWith("joint-human-membership:"));

/** The entry point paused at `at` (its users row and more held), the deletion started and seen waiting, then both settle. */
async function entryFirst<T>(observer: pg.Client, at: Parameters<typeof pauseQuery>[0], entry: () => Promise<T>, deletion: () => Promise<unknown>) {
  const before = await deadlocks(observer);
  const pause = pauseQuery(at);
  try {
    const running = start(entry);
    await pause.atPause;
    const deleting = start(deletion);
    await until(observer, "the deletion to wait on the entry point", lockWaiters);
    pause.release();
    const results = { entry: await running, deletion: await deleting };
    assertNoDeadlock(results);
    await assertNoDeadlockSince(observer, before);
    return results;
  } finally {
    pause.restore();
  }
}

/**
 * The retirement paused at its owned servers (the users row FOR UPDATE held),
 * the entry point started and seen waiting, then both settle.
 */
async function deletionFirst<T>(observer: pg.Client, entry: () => Promise<T>) {
  const before = await deadlocks(observer);
  const pause = pauseQuery(atHandOver);
  try {
    const deleting = start(() => retireDueAccounts({ retirementsPerRun: 1 }));
    await pause.atPause;
    const running = start(entry);
    await until(observer, "the entry point to wait on the deletion", lockWaiters);
    pause.release();
    const results = { entry: await running, deletion: await deleting };
    assertNoDeadlock(results);
    await assertNoDeadlockSince(observer, before);
    return results;
  } finally {
    pause.restore();
  }
}

async function sSide(db: Database, w: World) {
  const [side] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, w.J), eq(jointChannelServers.serverId, w.s.id)));
  return side?.status ?? null;
}

test.skipIf(skipJointRealPg)("\"Your servers\" (host_direct) against its actor's account deletion: the users row is taken first, so either order settles", async () => {
  await withRealPg("uf_your_servers_deletion", async (observer) => {
    const db = getDb();
    // The connection first, past its first J (users row, S and the members held): the deletion request waits on the users row.
    const w = await seedWorld(db, "uf-ys-a");
    const held = await entryFirst(observer, atFirstJointLock,
      async () => connected(await connectOwnServersToChannel(w.hLocal, w.a.id, [w.s.id], {})), () => deleteAccount(db, w.a.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.a.id], "then retired");

    // The retirement first (users row FOR UPDATE, S still ahead), started once
    // the operation's invite exists: the connection waits on the users row,
    // then is refused, nothing connected.
    const w2 = await seedWorld(db, "uf-ys-b");
    let opened!: () => void;
    const operationStarted = new Promise<void>((resolve) => { opened = resolve; });
    let proceed!: () => void;
    const mayConnect = new Promise<void>((resolve) => { proceed = resolve; });
    __setInviteSourcesStartedBarrierForTests(async () => { opened(); await mayConnect; });
    const before = await deadlocks(observer);
    const pause = pauseQuery(atHandOver);
    try {
      const running = start(async () => connected(await connectOwnServersToChannel(w2.hLocal, w2.a.id, [w2.s.id], {})));
      await operationStarted;
      __setInviteSourcesStartedBarrierForTests(null);
      await requestDueDeletion(db, w2.a.id);
      const deleting = start(() => retireDueAccounts({ retirementsPerRun: 1 }));
      await pause.atPause;
      proceed();
      await until(observer, "the connection to wait on the deletion", lockWaiters);
      pause.release();
      const results = { entry: await running, deletion: await deleting };
      assertNoDeadlock(results);
      await assertNoDeadlockSince(observer, before);
      assert.ok(results.deletion.ok, describeError(!results.deletion.ok && results.deletion.error));
      assert.equal(results.entry.ok, false, "refused: the account is being deleted");
      assert.equal((results.entry as { error: { code?: string } }).error.code, "invalid", describeError(!results.entry.ok && results.entry.error));
    } finally {
      proceed();
      pause.restore();
    }
    assert.equal(await sSide(db, w2), null, "nothing connected");
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a Guest's accept against their own account deletion: the users row is taken first, so either order settles", async () => {
  await withRealPg("uf_guest_accept_deletion", async (observer) => {
    const db = getDb();
    // The accept first, at its membership insert (users row, H's admission, the channel row held): the deletion request waits.
    const w = await seedWorld(db, "uf-ga-a");
    const held = await entryFirst(observer, (text) => /^\s*insert into "server_members"/i.test(text),
      () => acceptExternalInviteAsGuest(w.guestToken, w.g.id), () => deleteAccount(db, w.g.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.g.id], "then retired");

    // The retirement first: the accept waits on the users row, then answers the neutral refusal, no seat written.
    const w2 = await seedWorld(db, "uf-ga-b");
    await requestDueDeletion(db, w2.g.id);
    const first = await deletionFirst(observer, () => acceptExternalInviteAsGuest(w2.guestToken, w2.g.id));
    assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
    assert.equal(first.entry.ok, false, "refused: the account is being deleted");
    assert.equal((first.entry as { error: { code?: string } }).error.code, "invalid", describeError(!first.entry.ok && first.entry.error));
    const [seat] = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, w2.h.id), eq(serverMembers.userId, w2.g.id)));
    assert.equal(seat, undefined, "no Guest seat");
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a host's disconnect against its actor's account deletion (an owner of the host): the users row is taken first, so either order settles", async () => {
  await withRealPg("uf_host_disconnect_deletion", async (observer) => {
    const db = getDb();
    // The disconnect first, at its first J (users row, both servers rows held): the deletion request waits.
    const w = await seedWorld(db, "uf-hd-a");
    const held = await entryFirst(observer, atFirstJointLock,
      () => disconnectParticipantServerByHost(w.hLocal, w.p.id, w.hostOwner.id), () => deleteAccount(db, w.hostOwner.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.hostOwner.id], "then retired");

    // The retirement first (users row FOR UPDATE, H still ahead): the disconnect waits on the users row, then answers as an unknown channel.
    const w2 = await seedWorld(db, "uf-hd-b");
    await requestDueDeletion(db, w2.hostOwner.id);
    const first = await deletionFirst(observer, () => disconnectParticipantServerByHost(w2.hLocal, w2.p.id, w2.hostOwner.id));
    assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
    assert.equal(first.entry.ok, false, "refused: the account is being deleted");
    assert.equal(describeError(!first.entry.ok && first.entry.error), "Channel not found");
    const [side] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, w2.J), eq(jointChannelServers.serverId, w2.p.id)));
    assert.equal(side?.status, "active", "still connected");
  });
}, 180_000);

test.skipIf(skipJointRealPg)("converting a channel to a joint channel against its requester's account deletion (an owner of the host): the users row is taken first, so either order settles", async () => {
  await withRealPg("uf_convert_deletion", async (observer) => {
    const db = getDb();
    // The start first, at its job insert (users row, the conversion lock, the channel row held): the deletion request waits.
    const w = await seedWorld(db, "uf-cv-a");
    const held = await entryFirst(observer, (text) => /^\s*insert into "channel_conversion_jobs"/i.test(text),
      () => convertRoom(w), () => deleteAccount(db, w.hostOwner.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.hostOwner.id], "then retired");

    // The retirement first (users row FOR UPDATE, H still ahead): the command waits on the users row, then is refused, no job.
    const w2 = await seedWorld(db, "uf-cv-b");
    await requestDueDeletion(db, w2.hostOwner.id);
    const first = await deletionFirst(observer, () => convertRoom(w2));
    assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
    assert.equal(first.entry.ok, false, "refused: the account is being deleted");
    assert.equal((first.entry as { error: { code?: string } }).error.code, "requester_unavailable", describeError(!first.entry.ok && first.entry.error));
    const jobs = await db.select({ id: channelConversionJobs.id }).from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, w2.room));
    assert.deepEqual(jobs, [], "no conversion job");
  });
}, 180_000);

test.skipIf(skipJointRealPg)("inviting people outside against the inviter's account deletion (an owner of the host): the users row is taken first, so either order settles", async () => {
  await withRealPg("uf_send_invites_deletion", async (observer) => {
    const db = getDb();
    // The send first, at its invite insert (users row, the channel row, the daily cap held): the deletion request waits.
    const w = await seedWorld(db, "uf-si-a");
    const held = await entryFirst(observer, (text) => /^\s*insert into "channel_external_invites"/i.test(text),
      () => inviteOutside(w), () => deleteAccount(db, w.hostOwner.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.hostOwner.id], "then retired");

    // The retirement first (users row FOR UPDATE, H still ahead): the send waits on the users row, then is refused, nothing sent.
    const w2 = await seedWorld(db, "uf-si-b");
    await requestDueDeletion(db, w2.hostOwner.id);
    const first = await deletionFirst(observer, () => inviteOutside(w2));
    assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
    assert.equal(first.entry.ok, false, "refused: the account is being deleted");
    assert.equal((first.entry as { error: { code?: string } }).error.code, "forbidden", describeError(!first.entry.ok && first.entry.error));
    const invites = await db.select({ id: channelExternalInvites.id }).from(channelExternalInvites).where(eq(channelExternalInvites.channelId, w2.room));
    assert.deepEqual(invites, [], "no invite");
  });
}, 180_000);

/** One entry point against the account deletion of a person it acts or writes for (an owner of H, with a co-owner), in both orders. */
type AgainstDeletion<C> = {
  label: string;
  person: (w: World) => string;
  /** Unrecorded setup, before any deletion is requested. */
  prepare?: (w: World) => Promise<C>;
  /** Where the entry point pauses, its users rows and more held, while the deletion request waits. */
  at: Parameters<typeof pauseQuery>[0];
  entry: (w: World, prepared: C) => Promise<unknown>;
  /** The entry point first: what it did (it succeeded). */
  entryFirst?: (w: World, value: unknown, prepared: C) => Promise<void> | void;
  /** The retirement first (the users row FOR UPDATE, H still ahead): the entry point waited on the users row; what it answered and left. */
  deletionFirst: (w: World, entry: Settled, prepared: C) => Promise<void>;
};

async function eitherOrderAgainstDeletion<C>(observer: pg.Client, spec: AgainstDeletion<C>) {
  const db = getDb();
  const w = await seedWorld(db, `${spec.label}-a`);
  const prepared = await spec.prepare?.(w) as C;
  const held = await entryFirst(observer, spec.at, () => spec.entry(w, prepared), () => deleteAccount(db, spec.person(w)));
  assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
  assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
  assert.deepEqual(held.deletion.value, [spec.person(w)], "then retired");
  await spec.entryFirst?.(w, held.entry.value, prepared);

  const w2 = await seedWorld(db, `${spec.label}-b`);
  const prepared2 = await spec.prepare?.(w2) as C;
  await requestDueDeletion(db, spec.person(w2));
  const first = await deletionFirst(observer, () => spec.entry(w2, prepared2));
  assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
  await spec.deletionFirst(w2, first.entry, prepared2);
}

/** Refused with `expected` (an error code, message or class), nothing else asserted. */
function assertRefused(entry: Settled, expected: { code?: string; message?: string; type?: new (...args: never[]) => Error }) {
  assert.equal(entry.ok, false, "refused: the account is being deleted");
  const error = (entry as { error: Error & { code?: string } }).error;
  if (expected.code) assert.equal(error.code, expected.code, describeError(error));
  if (expected.message) assert.equal(error.message, expected.message, describeError(error));
  if (expected.type) assert.ok(error instanceof expected.type, describeError(error));
}

const statementAt = (pattern: RegExp) => (text: string) => pattern.test(text);

test.skipIf(skipJointRealPg)("creating a joint channel against its creator's account deletion (an owner of the host): the users rows are taken first, so either order settles", async () => {
  await withRealPg("uf_create_joint_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-cj",
      person: (w) => w.hostOwner.id,
      // At the host projection's insert (users rows, the host's lock, the channel rows held).
      at: statementAt(/^\s*insert into "joint_channel_servers"/i),
      entry: createJoint,
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { type: JointActorUnavailableError });
        const projections = await getDb().select({ id: jointChannelServers.localChannelId }).from(jointChannelServers).where(eq(jointChannelServers.serverId, w.h.id));
        assert.equal(projections.length, 1, "no new joint channel");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("resending a joint channel's invites against the resender's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_resend_joint_deletion", async (observer) => {
    const sentAt = async (w: World) => (await getDb().select({ createdAt: jointChannelInvites.createdAt }).from(jointChannelInvites)
      .where(and(eq(jointChannelInvites.toServerId, w.t.id), eq(jointChannelInvites.status, "pending"))))[0]!.createdAt.getTime();
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-rj",
      person: (w) => w.hostOwner.id,
      prepare: async (w) => { await inviteT(w); return sentAt(w); },
      at: statementAt(/^\s*update "joint_channel_invites"/i),
      entry: resendJointInvites,
      deletionFirst: async (w, entry, before) => {
        assertRefused(entry, { message: "Channel not found" });
        assert.equal(await sentAt(w), before, "not resent");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("deleting a channel with a Guest against the deleter's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_delete_channel_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-dc",
      person: (w) => w.hostOwner.id,
      prepare: guestInRoom,
      // At the Guest's removal (users rows, the channel, H and the Guest's member rows held).
      at: statementAt(/^\s*delete from "channel_humans"/i),
      entry: async (w) => deleteChannel(w.room, { deletedByUserId: w.hostOwner.id }),
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { type: JointActorUnavailableError });
        const [room] = await getDb().select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, w.room));
        assert.equal(room?.deletedAt, null, "not deleted");
        const [seat] = await getDb().select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, w.h.id), eq(serverMembers.userId, w.g.id)));
        assert.equal(seat?.role, "guest", "the Guest stays");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a role change against its actor's account deletion (an owner of the server): either order settles", async () => {
  await withRealPg("uf_role_change_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-rt",
      person: (w) => w.hostOwner.id,
      // At the member row's update (users rows, H FOR UPDATE, both member rows held).
      at: statementAt(/^\s*update "server_members" set/i),
      entry: demoteA,
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { code: "transition_forbidden" });
        const [seat] = await getDb().select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, w.h.id), eq(serverMembers.userId, w.a.id)));
        assert.equal(seat?.role, "admin", "unchanged");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a mention's add against the adder's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_mention_add_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-ma",
      person: (w) => w.hostOwner.id,
      prepare: pendingMention,
      // At the channel row's insert (users rows, the channel row held).
      at: statementAt(/^\s*insert into "channel_humans"/i),
      entry: mentionAdd,
      entryFirst: (_w, result) => assert.equal((result as Awaited<ReturnType<typeof mentionAdd>>).status, "delivered", JSON.stringify(result)),
      deletionFirst: async (w, entry, mention) => {
        // As one without the authority to add.
        assert.ok(entry.ok, describeError(!entry.ok && entry.error));
        assert.equal((entry.value as Awaited<ReturnType<typeof mentionAdd>>).status, "no_permission");
        const [row] = await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, mention.channelId), eq(channelHumans.userId, w.coOwner.id)));
        assert.equal(row, undefined, "not added");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("the conversion's audience cutover and finalize (the worker: no actor) against the account deletion of a person in the channel (an owner of the host): either order settles", async () => {
  await withRealPg("uf_conversion_finalize_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-cf",
      person: (w) => w.hostOwner.id,
      prepare: conversionAtCutover,
      // Past the joint membership's insert (users rows, the conversion lock, the joint's lock held).
      at: statementAt(/^\s*update joint_channel_members m set joined_at/i),
      entry: async (_w, jobId) => finishConversion(jobId),
      // Never refused: it waited for the users rows, then finished.
      deletionFirst: async (_w, entry) => {
        assert.ok(entry.ok, describeError(!entry.ok && entry.error));
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("resending an emailed invite against the resender's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_resend_invite_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-ri",
      person: (w) => w.hostOwner.id,
      prepare: async (w) => inviteIdFor(getDb(), w.hLocal, w.g.email),
      at: statementAt(/^\s*insert into "channel_external_invites"/i),
      entry: async (w, inviteId) => resendExternalInvite(w.hLocal, inviteId, w.hostOwner.id),
      deletionFirst: async (w, entry, inviteId) => {
        assertRefused(entry, { code: "forbidden" });
        assert.equal(await inviteIdFor(getDb(), w.hLocal, w.g.email), inviteId, "the invite stays as it was");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("revoking an invite against the revoker's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_revoke_invite_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-rv",
      person: (w) => w.hostOwner.id,
      prepare: async (w) => inviteIdFor(getDb(), w.hLocal, w.e.email),
      at: statementAt(/^\s*update "channel_external_invites" set/i),
      entry: async (w, inviteId) => revokeExternalInvite(w.hLocal, inviteId, w.hostOwner.id),
      deletionFirst: async (w, entry, inviteId) => {
        assertRefused(entry, { code: "forbidden" });
        assert.equal(await inviteIdFor(getDb(), w.hLocal, w.e.email), inviteId, "still pending");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a channel admin adding a person to a joint channel against the adder's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_channel_add_deletion", async (observer) => {
    const inChannel = async (w: World) => (await getDb().select().from(channelHumans)
      .where(and(eq(channelHumans.channelId, w.hLocal), eq(channelHumans.userId, w.coOwner.id)))).length > 0;
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-ca",
      person: (w) => w.hostOwner.id,
      // At the channel row's insert (users rows, the channel row, H and the member rows held).
      at: statementAt(/^\s*insert into "channel_humans"/i),
      entry: async (w) => addToJoint(w.hLocal, w.h.id, w.hostOwner.id, w.coOwner.id),
      entryFirst: async (w) => assert.equal(await inChannel(w), true, "added"),
      deletionFirst: async (w, entry) => {
        // As one without the capability (the route's 403).
        assertRefused(entry, { message: "Channel capability required" });
        assert.equal(await inChannel(w), false, "not added");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("a channel admin removing a person from a joint channel against the remover's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_channel_remove_deletion", async (observer) => {
    const inChannel = async (w: World) => (await getDb().select().from(channelHumans)
      .where(and(eq(channelHumans.channelId, w.hLocal), eq(channelHumans.userId, w.a.id)))).length > 0;
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-cr",
      person: (w) => w.hostOwner.id,
      // At the channel row's delete (users rows, the channel row, H and the member rows held).
      at: statementAt(/^\s*delete from "channel_humans"/i),
      entry: async (w) => removeFromJoint(w.hLocal, w.h.id, w.hostOwner.id, w.a.id),
      entryFirst: async (w) => assert.equal(await inChannel(w), false, "removed"),
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { message: "Channel capability required" });
        assert.equal(await inChannel(w), true, "still in it");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("archiving a channel with a Guest and an open invite against the archiver's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_archive_deletion", async (observer) => {
    const guestSeat = async (w: World) => (await getDb().select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, w.h.id), eq(serverMembers.userId, w.g.id))))[0]?.role ?? null;
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-ar",
      person: (w) => w.hostOwner.id,
      prepare: guestAndInviteInRoom,
      // At the Guest's departure (users rows, the channel row, the invites, H and the Guest's member row held).
      at: statementAt(/^\s*insert into "server_membership_departures"/i),
      entry: archiveRoom,
      entryFirst: async (w) => assert.equal(await guestSeat(w), null, "the Guest left with the archive"),
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { message: "Channel capability required" });
        const [room] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, w.room));
        assert.equal(room?.archivedAt, null, "not archived");
        assert.equal(await guestSeat(w), "guest", "the Guest stays");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("an archive whose bound Guests grew between its guess and its locks restarts with them first", async () => {
  await withRealPg("uf_archive_guests_grew", async () => {
    const db = getDb();
    const w = await seedWorld(db, "uf-ag");
    await guestAndInviteInRoom(w);
    // The guess sees no Guest (g's seat is reported later): the archive finds g under the channel lock and restarts.
    let guesses = 0;
    const recorder: Recorder = { transactions: [], open: new Map() };
    const endedGuests: EndedChannelGuest[] = [];
    await recording.run(recorder, () => withLockedChannelActorCapability({ serverId: w.h.id, channelId: w.room, actorType: "user", actorId: w.hostOwner.id,
      capability: "archiveChannels", guessUserIds: async () => (guesses += 1) === 1 ? [] : archiveBoundGuestIds(w.room) }, (tx, _context, lockedUserIds) => {
      endedGuests.length = 0;
      return archiveChannel(w.room, w.hostOwner.id, tx, { endedGuests, lockedUserIds });
    }));
    assert.equal(guesses, 2, "guessed again");
    assert.deepEqual(endedGuests.map((guest) => guest.userId), [w.g.id], "the Guest removed once");
    const fenceKeys = new Set((await db.execute<{ id: string }>(sql`SELECT id FROM channels`)).rows.map((row) => conversionKey(row.id)));
    const committed = recorder.transactions.filter((tx) => tx.some((statement) => /^\s*insert\s+into\s+"server_membership_departures"/i.test(statement.text)));
    assert.equal(committed.length, 1);
    assert.equal(usersFirstViolation(committed[0]!, [w.hostOwner.id, w.g.id], fenceKeys), null);
  });
}, 120_000);

test.skipIf(skipJointRealPg)("inviting a server to a joint channel against the inviter's account deletion (an owner of the host): either order settles", async () => {
  await withRealPg("uf_invite_server_deletion", async (observer) => {
    const pendingToT = async (w: World) => (await getDb().select({ id: jointChannelInvites.id }).from(jointChannelInvites)
      .where(and(eq(jointChannelInvites.toServerId, w.t.id), eq(jointChannelInvites.status, "pending")))).length;
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-is",
      person: (w) => w.hostOwner.id,
      // At the invite's insert (users rows, H's ns-3 lock, the joint row held).
      at: statementAt(/^\s*insert into "joint_channel_invites"/i),
      entry: inviteT,
      entryFirst: async (w) => assert.equal(await pendingToT(w), 1, "invited"),
      deletionFirst: async (w, entry) => {
        assertRefused(entry, { type: JointActorUnavailableError });
        assert.equal(await pendingToT(w), 0, "not invited");
      },
    });
  });
}, 180_000);

test.skipIf(skipJointRealPg)("approving a connect request against the approver's own account deletion (an owner of the target): either order settles, and a deleting approver is refused", async () => {
  await withRealPg("uf_approve_deletion", async (observer) => {
    await eitherOrderAgainstDeletion(observer, {
      label: "uf-ap",
      person: (w) => w.ap.id,
      prepare: pendingApproval,
      // Past its first J (the users rows, both admissions, T's ns-3 and the joint's locks held).
      at: atFirstJointLock,
      entry: async (w, requestId) => approveServerConnectRequest(requestId, w.ap.id),
      entryFirst: async (w, value, requestId) => {
        assert.equal((value as Awaited<ReturnType<typeof approveServerConnectRequest>>).state, "connected");
        assert.equal(await tSide(w), "active", "connected");
        assert.equal((await requestRow(requestId)).status, "approved");
      },
      // The approval waited on the approver's users row, then was refused as anyone not the approver is (404).
      deletionFirst: async (w, entry, requestId) => {
        assertRefused(entry, { code: "request_not_found" });
        assert.equal(await tSide(w), null, "nothing connected");
        // Not ended by the approval (its own refusal leaves it pending); the retirement's cleanup ends it as the approver's.
        assert.notEqual((await requestRow(requestId)).status, "approved");
      },
    });

    // Only requested (pending, not retired yet): refused the same way, the request still pending.
    const db = getDb();
    const w = await seedWorld(db, "uf-ap-c");
    const requestId = await pendingApproval(w);
    await requestDueDeletion(db, w.ap.id);
    const refused = await start(() => approveServerConnectRequest(requestId, w.ap.id));
    assertRefused(refused, { code: "request_not_found" });
    assert.deepEqual(await requestRow(requestId), { status: "pending", cancelReason: null }, "still pending");
    assert.equal(await tSide(w), null, "nothing connected");
  });
}, 240_000);

// ── 3. A connect-approval request against its approver's account deletion ──

/** The request's own invite row lock (lockInviteFrom), past the target server and members (lockAndCheckParties), before lockReferencedRows: the second such statement (initializeInviteSources' transaction takes the first). */
function atRequestInviteLock(inviteId: () => string) {
  let seen = 0;
  return (text: string, values: readonly unknown[]) => /from "channel_external_invites" where "channel_external_invites"\."id" = \$1 for update/i.test(text)
    && values[0] === inviteId() && ++seen === 2;
}
async function inviteIdOf(db: Database, w: World) {
  const [invite] = await db.select({ id: channelExternalInvites.id }).from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, w.hLocal), eq(channelExternalInvites.email, w.r.email.toLowerCase())));
  return invite!.id;
}

test.skipIf(skipJointRealPg)("asking an approval of an approver (not the actor) who owns the target server, against that approver's account deletion: either order settles", async () => {
  await withRealPg("uf_request_approver_deletion", async (observer) => {
    const db = getDb();
    // The request first, past the target server's row (FOR SHARE) and before its referenced rows: the deletion request waits on ap's users row.
    const w = await seedWorld(db, "uf-ra-a");
    const inviteId = await inviteIdOf(db, w);
    const held = await entryFirst(observer, atRequestInviteLock(() => inviteId),
      () => requestServerConnectApproval(w.requestToken, w.r.id, w.t.id, w.ap.id), () => deleteAccount(db, w.ap.id));
    assert.ok(held.entry.ok, describeError(!held.entry.ok && held.entry.error));
    assert.ok(held.deletion.ok, describeError(!held.deletion.ok && held.deletion.error));
    assert.deepEqual(held.deletion.value, [w.ap.id], "then retired");

    // The retirement first (ap's users row FOR UPDATE, T still ahead): the request waits on ap's users row, then settles.
    // Only the requester (the actor) is re-checked: the approver's row is only locked.
    const w2 = await seedWorld(db, "uf-ra-b");
    await requestDueDeletion(db, w2.ap.id);
    const first = await deletionFirst(observer, () => requestServerConnectApproval(w2.requestToken, w2.r.id, w2.t.id, w2.ap.id));
    assert.ok(first.deletion.ok, describeError(!first.deletion.ok && first.deletion.error));
    assert.deepEqual(first.deletion.value, [w2.ap.id], "retired");
  });
}, 180_000);

test.skipIf(skipJointRealPg)("an approver demoted between the request's unlocked check and its locks: refused as before, and no users row is locked after the first lock", async () => {
  // The pool binds each connection's query on its first checkout: the recorder is on before the first (withRealPg).
  await withRealPg("uf_request_approver_changed", async () => {
    const db = getDb();
    const w = await seedWorld(db, "uf-rc");
    // Paused at the transaction's first lock (its users rows, not yet taken): ap2, checked an admin unlocked, is demoted meanwhile.
    const pause = pauseQuery((text, values) => USERS_FIRST.test(text) && values.includes(w.ap2.id));
    const recorder: Recorder = { transactions: [], open: new Map() };
    try {
      const running = start(() => recording.run(recorder, () => requestServerConnectApproval(w.requestToken, w.r.id, w.t.id, w.ap2.id)));
      await pause.atPause;
      await db.update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, w.t.id), eq(serverMembers.userId, w.ap2.id)));
      pause.release();
      const result = await running;
      assert.equal(result.ok, false, "refused");
      const error = (result as { error: { code?: string; message?: string } }).error;
      assert.deepEqual({ code: error.code, message: error.message }, { code: "invalid_approver", message: "Choose an owner or admin of the server to approve" });
    } finally {
      pause.restore();
    }
    const requestTx = recorder.transactions.find((tx) => tx.some((statement) => USERS_FIRST.test(statement.text) && statement.values.includes(w.ap2.id)));
    assert.ok(requestTx, "the request's transaction ran");
    const fenceKeys = new Set((await db.execute<{ id: string }>(sql`SELECT id FROM channels`)).rows.map((row) => conversionKey(row.id)));
    assert.equal(usersFirstViolation(requestTx, [w.r.id, w.ap2.id], fenceKeys), null);
    const [request] = await db.select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.approverUserId, w.ap2.id));
    assert.equal(request, undefined, "nothing asked");
  });
}, 120_000);
