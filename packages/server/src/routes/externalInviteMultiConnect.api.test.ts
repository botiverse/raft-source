import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channelExternalInvites,
  channelHumans,
  channelServerConnectRequests,
  channels,
  featureFlagRules,
  jointChannelServers,
  serverMembers,
  servers,
} from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { withdrawUnusedDirectConnectInvite } from "../services/externalInviteConnectService";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { captureEmails, enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";

// One external invite connects several servers (#wg-rbac:#16 multi-connect):
// the invite page's multi-select (POST /api/external-invites/:token/connect-servers)
// and a host owner/admin's own servers ("Your servers",
// POST /api/channels/:id/external-connect-servers) share connectSelectedServers.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const NEUTRAL = { error: "This invite link is not valid" };

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

/** A paid host server with the flag on, its owner (the inviter) and a private channel without Guests. */
async function seedHost(baseUrl: string) {
  const owner = await person(baseUrl, "mc-host-owner");
  const member = await person(baseUrl, "mc-host-member");
  const server = await createServer("Multi Host", `mc-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await enableExternalChannelsFlag(server.id);
  const room = async (type: "private" | "channel" = "private") => {
    const channel = await createChannel(server.id, `mc-room-${randomBytes(4).toString("hex")}`, undefined, type, { type: "user", id: owner.id });
    await addHuman(channel.id, member.id);
    return channel;
  };
  return { owner, member, server, room };
}

/** A server `owner` owns (free unless `plan`), with members added at the given roles. */
async function seedTarget(owner: Person, members: Array<[Person, "admin" | "member" | "guest"]> = [], options: { plan?: "pro"; kind?: "joint_storage" } = {}) {
  const server = await createServer("Target", `mc-target-${randomBytes(4).toString("hex")}`, owner.id);
  for (const [member, role] of members) {
    // A Guest is bound to its one channel (#wg-rbac:#15): a new private channel of the server.
    if (role === "guest") await seedBoundGuest({ serverId: server.id, userId: member.id });
    else await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role });
  }
  if (options.plan || options.kind) await getDb().update(servers).set({ ...(options.plan ? { plan: options.plan } : {}), ...(options.kind ? { kind: options.kind } : {}) }).where(eq(servers.id, server.id));
  return server;
}

/** The free plan's one external channel, taken: a channel of the server with a bound Guest. */
async function makeExternal(baseUrl: string, server: { id: string }, ownerId: string) {
  const channel = await createChannel(server.id, `mc-used-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: ownerId });
  const guest = await person(baseUrl, "mc-used-guest");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
}

async function seedInvite(host: Awaited<ReturnType<typeof seedHost>>, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId,
    hostServerId: host.server.id,
    email,
    tokenHash: sha256(token),
    invitedByUserId: host.owner.id,
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

function call(baseUrl: string, as: Person, method: string, path: string, body?: unknown, serverId?: string) {
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json", ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const page = (baseUrl: string, as: Person, token: string) => call(baseUrl, as, "GET", `external-invites/${token}`);
const connectServers = (baseUrl: string, as: Person, token: string, selections: unknown) =>
  call(baseUrl, as, "POST", `external-invites/${token}/connect-servers`, { servers: selections });
const connectOwn = (baseUrl: string, as: Person, hostId: string, channelId: string, serverIds: unknown, makePrivate?: boolean) =>
  call(baseUrl, as, "POST", `channels/${channelId}/external-connect-servers`, makePrivate === undefined ? { serverIds } : { serverIds, makePrivate }, hostId);
const ownServers = (baseUrl: string, as: Person, hostId: string) => call(baseUrl, as, "GET", "channels/external-connect-servers", undefined, hostId);

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

type Outcome = { serverId: string; state: string; code?: string; channelId?: string; requestId?: string; limitSide?: string };
const outcomesOf = (body: Record<string, unknown>) => Object.fromEntries((body.servers as Outcome[]).map((outcome) => [outcome.serverId, outcome]));

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

async function requestRow(id: string) {
  const [row] = await getDb().select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, id));
  return row!;
}

async function projectionOn(hostChannelId: string, serverId: string) {
  const [host] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  if (!host) return null;
  const [row] = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, host.jointChannelId), eq(jointChannelServers.serverId, serverId)));
  return row ?? null;
}

async function isChannelMember(channelId: string, userId: string) {
  const rows = await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return rows.length > 0;
}

async function convertToJoint(host: Awaited<ReturnType<typeof seedHost>>, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

async function driveWorker(inviteId: string) {
  for (let pass = 0; pass < 40 && (await inviteRow(inviteId)).status === "connecting"; pass += 1) await runChannelConversionWorkerPass();
}

test("multi-select on a joint channel: one connected now, one waiting for its approver, one refused by its limit; the invite stays open until the approval is done", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-invitee");
  const approver = await person(app.baseUrl, "mc-approver");
  const owned = await seedTarget(invitee, [], { plan: "pro" });
  const memberOf = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const atLimit = await seedTarget(invitee);
  await makeExternal(app.baseUrl, atLimit, invitee.id);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const mail = captureEmails();
  let body: Record<string, unknown>;
  try {
    body = await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
      { serverId: owned.id },
      { serverId: memberOf.id, approverUserId: approver.id },
      { serverId: atLimit.id },
    ]), 200);
  } finally {
    mail.stop();
  }
  assert.deepEqual((body.servers as Outcome[]).map((outcome) => outcome.serverId), [owned.id, memberOf.id, atLimit.id], "in the order chosen");
  const outcomes = outcomesOf(body);
  assert.equal(outcomes[owned.id]!.state, "connected");
  assert.equal(outcomes[memberOf.id]!.state, "awaiting_approval");
  assert.deepEqual({ state: outcomes[atLimit.id]!.state, code: outcomes[atLimit.id]!.code, limitSide: outcomes[atLimit.id]!.limitSide }, { state: "refused", code: "free_external_limit", limitSide: "connecting" });
  const projection = await projectionOn(room.id, owned.id);
  assert.equal(projection?.status, "active");
  assert.equal(outcomes[owned.id]!.channelId, projection!.localChannelId);
  assert.equal(await isChannelMember(projection!.localChannelId, invitee.id), true);
  assert.equal(await projectionOn(room.id, atLimit.id), null, "the refused one is not connected");
  assert.equal(mail.deliveries.filter((delivery) => delivery.to === approver.email).length, 1, "the approver is emailed");

  // Open until every server is done: awaiting the approval, the connected server recorded.
  const waiting = await inviteRow(invite.id);
  assert.deepEqual({ status: waiting.status, acceptedServerId: waiting.acceptedServerId }, { status: "awaiting_approval", acceptedServerId: owned.id });
  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as { status: string; servers: Array<{ serverId: string; state: string }>; pendingRequests: unknown[] };
  assert.equal(shown.status, "awaiting_approval");
  assert.deepEqual(shown.servers.map((server) => [server.serverId, server.state]), [[owned.id, "connected"], [memberOf.id, "awaiting_approval"]]);
  assert.equal(shown.pendingRequests.length, 1);
  // Nothing more is chosen with it while it waits.
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: atLimit.id }]), 409, "approval_in_progress");

  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${outcomes[memberOf.id]!.requestId}/approve`), 200);
  assert.equal((await projectionOn(room.id, memberOf.id))?.status, "active");
  const done = await inviteRow(invite.id);
  assert.deepEqual(
    { status: done.status, outcome: done.outcome, acceptedServerId: done.acceptedServerId },
    { status: "accepted", outcome: "server", acceptedServerId: owned.id },
    "accepted once the last one is done, with the first server connected",
  );
});

test("a declined approval leaves the invite accepted when another server connected, pending to choose again when none did; cancel takes one request", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-decline");
  const approver = await person(app.baseUrl, "mc-decline-approver");
  const first = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const second = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: first.id, approverUserId: approver.id },
    { serverId: second.id, approverUserId: approver.id },
  ]), 200));
  assert.equal(outcomes[first.id]!.state, "awaiting_approval");
  assert.equal(outcomes[second.id]!.state, "awaiting_approval");

  // Withdrawing one leaves the other waiting.
  await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/cancel-request`, { requestId: outcomes[first.id]!.requestId }), 200);
  assert.equal((await requestRow(outcomes[first.id]!.requestId!)).status, "cancelled");
  assert.equal((await inviteRow(invite.id)).status, "awaiting_approval");
  // Declining the last: nothing connected, pending again.
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${outcomes[second.id]!.requestId}/reject`), 200);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("a private channel: the servers the invitee administers connect one after another once it is converted; the invite is accepted only after the last", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-queue");
  const otherOwner = await person(app.baseUrl, "mc-queue-other");
  const a = await seedTarget(invitee, [], { plan: "pro" });
  const b = await seedTarget(otherOwner, [[invitee, "admin"]], { plan: "pro" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);

  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: a.id }, { serverId: b.id }]), 200));
  assert.deepEqual([outcomes[a.id]!.state, outcomes[b.id]!.state], ["connecting", "connecting"]);
  const reserved = await inviteRow(invite.id);
  assert.deepEqual(
    { status: reserved.status, phase: reserved.connectPhase, head: reserved.connectServerId, queue: reserved.connectQueuedServerIds },
    { status: "connecting", phase: "conversion", head: a.id, queue: [b.id] },
  );
  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as { servers: Array<{ serverId: string; state: string }> };
  assert.deepEqual(shown.servers.map((server) => [server.serverId, server.state]), [[a.id, "connecting"], [b.id, "connecting"]]);

  await driveWorker(invite.id);
  assert.equal((await projectionOn(room.id, a.id))?.status, "active");
  assert.equal((await projectionOn(room.id, b.id))?.status, "active");
  const done = await inviteRow(invite.id);
  assert.deepEqual(
    { status: done.status, outcome: done.outcome, acceptedServerId: done.acceptedServerId, queue: done.connectQueuedServerIds },
    { status: "accepted", outcome: "server", acceptedServerId: a.id, queue: [] },
  );
});

test("a queued server refused when its turn comes is skipped: the next one still connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-skip");
  const otherOwner = await person(app.baseUrl, "mc-skip-other");
  const a = await seedTarget(invitee, [], { plan: "pro" });
  const lost = await seedTarget(otherOwner, [[invitee, "admin"]], { plan: "pro" });
  const c = await seedTarget(invitee, [], { plan: "pro" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);

  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: a.id }, { serverId: lost.id }, { serverId: c.id }]), 200);
  // Demoted while queued: re-checked when its turn comes.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, lost.id), eq(serverMembers.userId, invitee.id)));
  const mail = captureEmails();
  try {
    await driveWorker(invite.id);
  } finally {
    mail.stop();
  }
  assert.equal((await projectionOn(room.id, a.id))?.status, "active");
  assert.equal(await projectionOn(room.id, lost.id), null);
  assert.equal((await projectionOn(room.id, c.id))?.status, "active");
  assert.equal((await inviteRow(invite.id)).status, "accepted");
  assert.equal(mail.deliveries.filter((delivery) => delivery.to === invitee.email).length, 1, "the invitee hears about the one that didn't connect");
});

test("expiry: approvals not back by then lapse; an invite that connected a server reads as accepted, one that connected none as not valid", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-expiry");
  const approver = await person(app.baseUrl, "mc-expiry-approver");
  const owned = await seedTarget(invitee, [], { plan: "pro" });
  const memberOf = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: owned.id },
    { serverId: memberOf.id, approverUserId: approver.id },
  ]), 200));
  const requestId = outcomes[memberOf.id]!.requestId!;

  // The 14 days run out with the approval still out.
  const past = new Date(Date.now() - 1000);
  await getDb().update(channelExternalInvites).set({ expiresAt: past }).where(eq(channelExternalInvites.id, invite.id));
  await getDb().update(channelServerConnectRequests).set({ expiresAt: past }).where(eq(channelServerConnectRequests.id, requestId));

  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as { status: string; accepted?: { serverId: string } };
  assert.deepEqual({ status: shown.status, server: shown.accepted?.serverId }, { status: "accepted", server: owned.id });
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409, "request_expired");
  assert.equal((await requestRow(requestId)).status, "expired");
  const lapsed = await inviteRow(invite.id);
  assert.deepEqual({ status: lapsed.status, outcome: lapsed.outcome }, { status: "accepted", outcome: "server" });
  assert.equal(await projectionOn(room.id, memberOf.id), null, "the lapsed approval connects nothing");

  // Nothing connected before the expiry: expired, and the page's neutral answer.
  const other = await person(app.baseUrl, "mc-expiry-none");
  const otherServer = await seedTarget(approver, [[other, "member"]], { plan: "pro" });
  const second = await seedInvite(host, room.id, other.email);
  const secondOutcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, other, second.token, [{ serverId: otherServer.id, approverUserId: approver.id }]), 200));
  await getDb().update(channelExternalInvites).set({ expiresAt: past }).where(eq(channelExternalInvites.id, second.id));
  await getDb().update(channelServerConnectRequests).set({ expiresAt: past }).where(eq(channelServerConnectRequests.id, secondOutcomes[otherServer.id]!.requestId!));
  assert.deepEqual(await expectStatus(await page(app.baseUrl, other, second.token), 404), NEUTRAL);
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${secondOutcomes[otherServer.id]!.requestId}/approve`), 409, "request_expired");
  assert.equal((await inviteRow(second.id)).status, "expired");
});

test("the server decides what may be chosen: a server not offered (not an ordinary server, not theirs, the host), an approver who isn't its owner or admin", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-refuse");
  const stranger = await person(app.baseUrl, "mc-refuse-stranger");
  const storage = await seedTarget(invitee, [], { kind: "joint_storage" });
  const notMine = await seedTarget(stranger);
  const guestOf = await seedTarget(stranger, [[invitee, "guest"]]);
  const memberOf = await seedTarget(stranger, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: storage.id },
    { serverId: notMine.id },
    { serverId: guestOf.id },
    { serverId: host.server.id },
    { serverId: memberOf.id, approverUserId: invitee.id },
  ]), 200));
  for (const id of [storage.id, notMine.id, guestOf.id, host.server.id]) assert.deepEqual([outcomes[id]!.state, outcomes[id]!.code], ["refused", "invalid_server"], id);
  assert.deepEqual([outcomes[memberOf.id]!.state, outcomes[memberOf.id]!.code], ["refused", "invalid_approver"]);
  for (const id of [storage.id, notMine.id, guestOf.id, memberOf.id]) assert.equal(await projectionOn(room.id, id), null);
  assert.equal((await inviteRow(invite.id)).status, "pending", "nothing chosen went through: pending to choose again");

  // Malformed choices are refused before anything.
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, []), 400, "invalid_server");
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: memberOf.id }, { serverId: memberOf.id }]), 400, "invalid_server");
  // Only the invitee at the invited address.
  assert.deepEqual(await expectStatus(await connectServers(app.baseUrl, stranger, invite.token, [{ serverId: notMine.id }]), 404), NEUTRAL);
});

test("Your servers: the host owner/admin's own servers they own or administer connect at once, no email or approval; others are refused server-side", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const otherOwner = await person(app.baseUrl, "mc-own-other");
  const owned = await seedTarget(host.owner, [], { plan: "pro" });
  const administered = await seedTarget(otherOwner, [[host.owner, "admin"]], { plan: "pro" });
  const memberOf = await seedTarget(otherOwner, [[host.owner, "member"]], { plan: "pro" });
  const storage = await seedTarget(host.owner, [], { kind: "joint_storage" });
  const room = await host.room("channel");

  // The list: only the ones they own or administer, never the host, a member-only or a storage server.
  const listed = await expectStatus(await ownServers(app.baseUrl, host.owner, host.server.id), 200) as { servers: Array<{ id: string }> };
  assert.deepEqual(listed.servers.map((server) => server.id).sort(), [owned.id, administered.id].sort());
  await expectStatus(await ownServers(app.baseUrl, host.member, host.server.id), 403, "forbidden");

  // A public channel needs makePrivate, as a send does; a host member may not.
  await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [owned.id]), 400, "make_private_required");
  await expectStatus(await connectOwn(app.baseUrl, host.member, host.server.id, room.id, [owned.id], true), 403, "forbidden");

  const mail = captureEmails();
  let body: Record<string, unknown>;
  try {
    body = await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [owned.id, administered.id, memberOf.id, storage.id], true), 200);
  } finally {
    mail.stop();
  }
  const outcomes = outcomesOf(body);
  assert.deepEqual([outcomes[owned.id]!.state, outcomes[administered.id]!.state], ["connecting", "connecting"], "the channel is converted first");
  assert.deepEqual([outcomes[memberOf.id]!.state, outcomes[memberOf.id]!.code], ["refused", "server_admin_required"]);
  assert.deepEqual([outcomes[storage.id]!.state, outcomes[storage.id]!.code], ["refused", "invalid_server"]);
  assert.equal(mail.deliveries.length, 0, "no email");
  const [channel] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, room.id));
  assert.equal(channel?.type, "private");

  const [direct] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, room.id));
  assert.equal(direct?.invitedByUserId, host.owner.id);
  await driveWorker(direct!.id);
  assert.equal((await projectionOn(room.id, owned.id))?.status, "active");
  assert.equal((await projectionOn(room.id, administered.id))?.status, "active");
  assert.equal(await projectionOn(room.id, memberOf.id), null);
  assert.equal((await inviteRow(direct!.id)).status, "accepted");
});

test("Your servers: nothing that can connect leaves no invite behind; a non-owner/admin target is refused even when the client sends it", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const otherOwner = await person(app.baseUrl, "mc-own-none");
  const memberOf = await seedTarget(otherOwner, [[host.owner, "member"]], { plan: "pro" });
  const room = await host.room();
  const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [memberOf.id]), 200));
  assert.deepEqual([outcomes[memberOf.id]!.state, outcomes[memberOf.id]!.code], ["refused", "server_admin_required"]);
  const open = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, room.id));
  assert.deepEqual(open.map((row) => row.status), ["revoked"], "the unused invite is withdrawn");
  await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, "nope"), 400, "invalid_input");
});

test("flag off: the multi-connect and Your servers routes answer as every other external route does (404), nothing is written", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-flag");
  const owned = await seedTarget(invitee, [], { plan: "pro" });
  const mine = await seedTarget(host.owner, [], { plan: "pro" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));

  assert.deepEqual(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: owned.id }]), 404), NEUTRAL);
  await expectStatus(await ownServers(app.baseUrl, host.owner, host.server.id), 404);
  await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [mine.id]), 404);
  assert.equal((await inviteRow(invite.id)).status, "pending");
  const rows = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, room.id));
  assert.equal(rows.length, 1, "no invite of the host's own");
});

test("the page lists only the servers this invite connected, is connecting or waits on, never the invitee's servers that joined another way", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-scope");
  const approver = await person(app.baseUrl, "mc-scope-approver");
  const earlier = await seedTarget(invitee, [], { plan: "pro" });
  const memberOf = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const owned = await seedTarget(invitee, [], { plan: "pro" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  // Their server joined with an earlier invite of theirs.
  const first = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connectServers(app.baseUrl, invitee, first.token, [{ serverId: earlier.id }]), 200);
  assert.equal((await inviteRow(first.id)).status, "accepted");

  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: memberOf.id, approverUserId: approver.id },
    { serverId: owned.id },
  ]), 200);
  assert.deepEqual((await inviteRow(invite.id)).connectedServerIds, [owned.id], "the servers this invite connected are recorded on it");
  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as { servers: Array<{ serverId: string; state: string }> };
  assert.deepEqual(
    shown.servers.map((server) => [server.serverId, server.state]),
    [[owned.id, "connected"], [memberOf.id, "awaiting_approval"]],
    "not the server that joined with the earlier invite",
  );
});

test("a queued server deleted while it waits is refused when its turn comes; the one before it connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-deleted");
  const a = await seedTarget(invitee, [], { plan: "pro" });
  const b = await seedTarget(invitee, [], { plan: "pro" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: a.id }, { serverId: b.id }]), 200);
  assert.deepEqual((await inviteRow(invite.id)).connectQueuedServerIds, [b.id]);
  // Deleted during the conversion.
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, b.id));
  await driveWorker(invite.id);
  assert.equal((await projectionOn(room.id, a.id))?.status, "active");
  assert.equal(await projectionOn(room.id, b.id), null, "no projection on a deleted server");
  const done = await inviteRow(invite.id);
  assert.deepEqual({ status: done.status, connected: done.connectedServerIds }, { status: "accepted", connected: [a.id] });
});

test("a choice's approvers are emailed only once its own servers are in or reserved: on a private channel the conversion is theirs; the approval waits for the channel, then connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "mc-order");
  const approver = await person(app.baseUrl, "mc-order-approver");
  const memberOf = await seedTarget(approver, [[invitee, "member"]], { plan: "pro" });
  const owned = await seedTarget(invitee, [], { plan: "pro" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  // What the invite is when the approver's email goes out (the only way they can act).
  const emailed: { invite: Promise<Awaited<ReturnType<typeof inviteRow>>> | null } = { invite: null };
  const mail = captureEmails();
  let body: Record<string, unknown>;
  try {
    __setEmailDeliveryObserverForTests((delivery) => {
      if (delivery.to === approver.email) emailed.invite = inviteRow(invite.id);
    });
    body = await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
      { serverId: memberOf.id, approverUserId: approver.id },
      { serverId: owned.id },
    ]), 200);
  } finally {
    mail.stop();
  }
  const outcomes = outcomesOf(body);
  assert.deepEqual([outcomes[owned.id]!.state, outcomes[memberOf.id]!.state], ["connecting", "awaiting_approval"], JSON.stringify(outcomes));
  assert.ok(emailed.invite, "the approver is emailed");
  const whenEmailed = await emailed.invite;
  assert.deepEqual({ status: whenEmailed.status, head: whenEmailed.connectServerId }, { status: "connecting", head: owned.id }, "emailed after the reservation");
  // While the channel is converted the approver waits.
  const requestId = outcomes[memberOf.id]!.requestId!;
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409, "connect_in_progress");
  await driveWorker(invite.id);
  assert.equal((await projectionOn(room.id, owned.id))?.status, "active");
  assert.equal((await inviteRow(invite.id)).status, "awaiting_approval", "rests on the request");
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 200);
  assert.equal((await projectionOn(room.id, memberOf.id))?.status, "active");
  assert.equal((await inviteRow(invite.id)).status, "accepted");
});

test("Your servers: an invite of theirs is withdrawn only when nothing connected, is reserved or waits with it", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const owned = await seedTarget(host.owner, [], { plan: "pro" });
  const room = await host.room();
  const seed = async (state: Partial<typeof channelExternalInvites.$inferInsert>) => {
    await getDb().update(channelExternalInvites).set({ status: "revoked" }).where(eq(channelExternalInvites.channelId, room.id));
    const invite = await seedInvite(host, room.id, host.owner.email);
    if (Object.keys(state).length > 0) await getDb().update(channelExternalInvites).set(state).where(eq(channelExternalInvites.id, invite.id));
    return invite.id;
  };
  // Another call of theirs connected a server with it and holds it open for the next.
  const connected = await seed({ acceptedServerId: owned.id, acceptedUserId: host.owner.id, connectedServerIds: [owned.id] });
  assert.equal(await withdrawUnusedDirectConnectInvite(connected, host.owner.id), false);
  assert.equal((await inviteRow(connected)).status, "pending");
  const unused = await seed({});
  assert.equal(await withdrawUnusedDirectConnectInvite(unused, host.owner.id), true);
  assert.equal((await inviteRow(unused)).status, "revoked");
});

test("Your servers: the host's own owner at its hosting limit is still told the plan and the channel using the slot; an invitee on the same channel is not (#wg-rbac:#61)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const usedRoom = await host.room();
  await convertToJoint(host, usedRoom.id);
  const firstOwner = await person(app.baseUrl, "mc-detail-first");
  const firstServer = await seedTarget(firstOwner, [], { plan: "pro" });
  const first = await expectStatus(await connectServers(app.baseUrl, firstOwner, (await seedInvite(host, usedRoom.id, firstOwner.email)).token, [{ serverId: firstServer.id }]), 200);
  assert.equal(outcomesOf(first)[firstServer.id]?.state, "connected");
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, host.server.id));
  const room = await host.room();
  type Refused = Outcome & { error?: string; status?: number; limitServerId?: string };

  const owned = await seedTarget(host.owner, [], { plan: "pro" });
  const own = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [owned.id]), 200))[owned.id] as Refused;
  assert.deepEqual({ state: own.state, status: own.status, code: own.code, side: own.limitSide, server: own.limitServerId },
    { state: "refused", status: 409, code: "joint_channel_free_limit_reached", side: "host", server: host.server.id });
  assert.equal(own.error, `This server is on the Free plan and already hosts a Joint Channel another server has joined (#${usedRoom.name}). Upgrade to connect another one.`);

  // The same channel, the same limit, an invitee: neutral.
  const invitee = await person(app.baseUrl, "mc-detail-invitee");
  const target = await seedTarget(invitee, [], { plan: "pro" });
  const theirs = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, (await seedInvite(host, room.id, invitee.email)).token, [{ serverId: target.id }]), 200))[target.id] as Refused;
  assert.equal(theirs.code, "joint_channel_free_limit_reached");
  assert.equal(theirs.error, "This channel's server can't share another channel with people outside it right now. Ask the person who invited you.");
  assert.equal(JSON.stringify(theirs).includes(usedRoom.name), false);
});
