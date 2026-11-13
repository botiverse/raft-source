import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db/index";
import { channelExternalInvites, integrationAuditEvents, jointChannelServers, serverMembers, servers } from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";
import { assertNoDmNotice, channelSystemLines, storedSystemMessages, workerPublish } from "../test/externalChannelSystemMessages";

/**
 * The channel's own system messages for external channels (cindyz,
 * #wg-rbac:#40): "{server} connected to this channel." for every way a server
 * connects with an external invite, "@{handle} joined as a guest." for a
 * Guest's acceptance; each posted once, after its commit, and read on every
 * connected server's copy. No owner or admin is told in a DM any more
 * (#wg-rbac:#42 option A). A member's own servers (self_connect) are covered
 * in jointMemberConnect.api.test.ts, the host's disconnect in
 * channels.jointHostDisconnect.api.test.ts.
 *
 * Each of those connections also writes exactly one `channel.server_connected`
 * audit event, on the host (#wg-rbac:#62): asserted with the system message.
 */
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

/** A paid host with the flag on, its owner and a member, and a private channel they are both in. */
async function seedHost(baseUrl: string) {
  const owner = await person(baseUrl, "sm-host-owner");
  const member = await person(baseUrl, "sm-host-member");
  const server = await createServer("Hostco", `sm-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await enableExternalChannelsFlag(server.id);
  const room = await createChannel(server.id, `sm-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  await addHuman(room.id, member.id);
  return { owner, member, server, room };
}

type Host = Awaited<ReturnType<typeof seedHost>>;

async function seedTarget(owner: Person, name: string, members: Array<[Person, "admin" | "member"]> = []) {
  const server = await createServer(name, `sm-target-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  for (const [member, role] of members) await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role });
  return server;
}

async function seedInvite(host: Host, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId: host.room.id,
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

async function expectStatus(response: Response, status: number) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

async function convertToJoint(host: Host) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: host.room.id, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

async function localCopyOn(host: Host, serverId: string): Promise<string> {
  const [hostSide] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, host.room.id));
  const [row] = await getDb().select({ localChannelId: jointChannelServers.localChannelId, status: jointChannelServers.status }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, hostSide!.jointChannelId), eq(jointChannelServers.serverId, serverId)));
  assert.equal(row?.status, "active", "connected");
  return row!.localChannelId;
}

const db = () => getDb() as unknown as Database;

const connectedAudits = () => getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_connected"));

/**
 * Exactly one `channel.server_connected` for the server, a row of the host's
 * naming the host's own copy, with how it connected and who authorized it;
 * nothing of the connected server's copy, and no row on the connected server.
 */
async function assertAuditedOnce(host: Host, targetServerId: string, mode: "invite" | "approval" | "host_direct", actor: Person) {
  const all = await connectedAudits();
  assert.deepEqual(all.filter((row) => row.serverId === targetServerId), [], "no row on the connected server");
  const rows = all.filter((row) => row.metadata.connectedServerId === targetServerId);
  assert.equal(rows.length, 1, "one event per connection");
  const [row] = rows;
  const [hostSide] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, host.room.id));
  assert.deepEqual(
    { serverId: row!.serverId, actorType: row!.actorType, actorId: row!.actorId, targetType: row!.targetType, targetId: row!.targetId, category: row!.eventCategory },
    { serverId: host.server.id, actorType: "human", actorId: actor.id, targetType: "server", targetId: targetServerId, category: "membership" },
  );
  const { operationId, ...metadata } = row!.metadata as Record<string, unknown>;
  assert.equal(typeof operationId, "string");
  assert.deepEqual(metadata, { mode, jointChannelId: hostSide!.jointChannelId, hostServerId: host.server.id, channelId: host.room.id, connectedServerId: targetServerId });
}

/**
 * Exactly one "{server} connected to this channel." stored, read by the host's
 * member on the host's copy and by `reader` on the connected server's copy;
 * no DM notice anywhere.
 */
async function assertConnectedOnce(baseUrl: string, host: Host, target: { id: string; name: string }, reader: Person, audit: { mode: "invite" | "approval" | "host_direct"; actor: Person }) {
  await assertAuditedOnce(host, target.id, audit.mode, audit.actor);
  const line = `${target.name} connected to this channel.`;
  assert.deepEqual((await storedSystemMessages(db(), "channel.joint_connect")).map((row) => row.content).filter((content) => content === line), [line], "stored once");
  assert.deepEqual((await channelSystemLines(baseUrl, host.member, host.server, host.room.id)).filter((entry) => entry === line), [line], "read on the host");
  assert.deepEqual((await channelSystemLines(baseUrl, reader, target, await localCopyOn(host, target.id))).filter((entry) => entry === line), [line], "read on the connected server");
  await assertNoDmNotice(db());
}

test("an existing server connects with the invite (a joint channel): one system message, read on the host and the connected server; the used link posts nothing more", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  await convertToJoint(host);
  const invitee = await person(app.baseUrl, "sm-invitee");
  const target = await seedTarget(invitee, "Bravo Labs");
  const invite = await seedInvite(host, invitee.email);

  const connect = () => call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: target.id });
  // A server the invitee has no say over: refused, and nothing is audited.
  const stranger = await seedTarget(await person(app.baseUrl, "sm-stranger"), "Stranger Labs");
  const refused = await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: stranger.id });
  assert.ok(refused.status >= 400, `refused: ${refused.status}`);
  assert.deepEqual(await connectedAudits(), [], "a refused connect writes no channel.server_connected");

  assert.equal((await expectStatus(await connect(), 200)).state, "connected");
  await assertConnectedOnce(app.baseUrl, host, target, invitee, { mode: "invite", actor: invitee });
  // A replay: the invite is used, nothing connects, nothing more is posted.
  assert.equal((await connect()).status, 404);
  await assertConnectedOnce(app.baseUrl, host, target, invitee, { mode: "invite", actor: invitee });
  assert.equal((await connectedAudits()).length, 1);
});

test("a new server connects with the invite (a joint channel): one system message naming it", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  await convertToJoint(host);
  const invitee = await person(app.baseUrl, "sm-newco");
  const invite = await seedInvite(host, invitee.email);
  const body = await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect-new-server`,
    { name: "Newco", slug: `sm-new-${randomBytes(4).toString("hex")}` }), 200);
  assert.equal(body.state, "connected");
  await assertConnectedOnce(app.baseUrl, host, { id: String(body.serverId), name: "Newco" }, invitee, { mode: "invite", actor: invitee });
});

test("Your servers (the host admin's own, host_direct) on a joint channel: one system message per server connected", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  await convertToJoint(host);
  const first = await seedTarget(host.owner, "Own One");
  const second = await seedTarget(host.owner, "Own Two");
  const body = await expectStatus(await call(app.baseUrl, host.owner, "POST", `channels/${host.room.id}/external-connect-servers`,
    { serverIds: [first.id, second.id] }, host.server.id), 200);
  assert.deepEqual((body.servers as Array<{ state: string }>).map((row) => row.state), ["connected", "connected"], JSON.stringify(body));
  await assertConnectedOnce(app.baseUrl, host, first, host.owner, { mode: "host_direct", actor: host.owner });
  await assertConnectedOnce(app.baseUrl, host, second, host.owner, { mode: "host_direct", actor: host.owner });
  assert.equal((await storedSystemMessages(db(), "channel.joint_connect")).length, 2);
  assert.equal((await connectedAudits()).length, 2, "one event per server connected");
});

test("an approved request (a joint channel): one system message once the approver approves, none while it waits", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  await convertToJoint(host);
  const approver = await person(app.baseUrl, "sm-approver");
  const requester = await person(app.baseUrl, "sm-requester");
  const target = await seedTarget(approver, "Approved Labs", [[requester, "member"]]);
  const invite = await seedInvite(host, requester.email);
  const created = await expectStatus(await call(app.baseUrl, requester, "POST", `external-invites/${invite.token}/request-approval`,
    { serverId: target.id, approverUserId: approver.id }), 201);
  assert.deepEqual(await storedSystemMessages(db(), "channel.joint_connect"), [], "nothing while it waits");
  assert.deepEqual(await connectedAudits(), [], "a request alone connects nothing");
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${String(created.requestId)}/approve`), 200);
  // The approver authorized it: the event's actor.
  await assertConnectedOnce(app.baseUrl, host, target, requester, { mode: "approval", actor: approver });
  // Approving again connects and posts nothing.
  assert.equal((await call(app.baseUrl, approver, "POST", `server-connect-requests/${String(created.requestId)}/approve`)).status, 409);
  await assertConnectedOnce(app.baseUrl, host, target, requester, { mode: "approval", actor: approver });
});

test("a private channel: nothing is posted while it converts; the worker's connection posts once, and a replayed worker pass posts nothing", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "sm-convert");
  const target = await seedTarget(invitee, "Converted Labs");
  const invite = await seedInvite(host, invitee.email);
  assert.deepEqual(await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: target.id }), 202), { state: "connecting" });
  assert.deepEqual(await storedSystemMessages(db(), "channel.joint_connect"), [], "not connected yet");
  assert.deepEqual(await connectedAudits(), [], "nor audited");

  const publish = workerPublish(app.app);
  const status = async () => (await getDb().select({ status: channelExternalInvites.status }).from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id)))[0]!.status;
  for (let pass = 0; pass < 30 && await status() === "connecting"; pass += 1) await runChannelConversionWorkerPass(undefined, undefined, undefined, publish);
  assert.equal(await status(), "accepted");
  await assertConnectedOnce(app.baseUrl, host, target, invitee, { mode: "invite", actor: invitee });
  await runChannelConversionWorkerPass(undefined, undefined, undefined, publish);
  await assertConnectedOnce(app.baseUrl, host, target, invitee, { mode: "invite", actor: invitee });
});

async function acceptAsGuest(baseUrl: string, host: Host, label: string) {
  const guest = await person(baseUrl, label);
  const invite = await seedInvite(host, guest.email);
  const accept = () => call(baseUrl, guest, "POST", `external-invites/${invite.token}/accept-as-guest`);
  await expectStatus(await accept(), 200);
  // A retry of their own acceptance answers as the first did, and joins nobody.
  await expectStatus(await accept(), 200);
  return { guest, line: `@${guest.name} joined as a guest.` };
}

test("a Guest joins a private external channel: one system message, read by the channel's members; a retried accept posts nothing", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const { line } = await acceptAsGuest(app.baseUrl, host, "sm-guest");
  assert.deepEqual(await storedSystemMessages(db(), "channel.human_membership"), [{ content: line, channelId: host.room.id }]);
  assert.deepEqual((await channelSystemLines(app.baseUrl, host.member, host.server, host.room.id)).filter((entry) => entry === line), [line]);
  await assertNoDmNotice(db());
  assert.deepEqual(await connectedAudits(), [], "a Guest connects no server");
});

test("a Guest joins a joint channel: one system message, read on the host and on the connected server; a retried accept posts nothing", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  await convertToJoint(host);
  const invitee = await person(app.baseUrl, "sm-peer");
  const target = await seedTarget(invitee, "Peer Labs");
  const invite = await seedInvite(host, invitee.email);
  await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: target.id }), 200);

  const { line } = await acceptAsGuest(app.baseUrl, host, "sm-joint-guest");
  assert.deepEqual((await storedSystemMessages(db(), "channel.human_membership")).map((row) => row.content), [line], "stored once");
  assert.deepEqual((await channelSystemLines(app.baseUrl, host.member, host.server, host.room.id)).filter((entry) => entry === line), [line], "read on the host");
  assert.deepEqual((await channelSystemLines(app.baseUrl, invitee, target, await localCopyOn(host, target.id))).filter((entry) => entry === line), [line], "read on the connected server");
  await assertNoDmNotice(db());
});
