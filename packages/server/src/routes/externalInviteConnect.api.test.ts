import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channelConversionJobs,
  channelExternalInvites,
  channelHumans,
  channelServerConnectRequests,
  channels,
  featureFlagRules,
  integrationAuditEvents,
  jointChannelInvites,
  jointChannelServers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { addHuman, canUserAccessChannel, createChannel, createJointChannelInvite } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { __setExternalConnectSettleBarrierForTests, advanceExternalConnect, approveServerConnectRequest, ExternalConnectError } from "../services/externalInviteConnectService";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { EXTERNAL_CHANNEL_MAX_SLOTS } from "../services/externalChannelLimitService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { captureEmails, enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { capturePaywallHits, captureRefusalSpans } from "../test/integration/paywallHits";

// Connecting a server with an external invite, P2a-3 (#wg-rbac:#16): the
// invitee's options, connecting directly or by approval, the interim Guest
// block, revoking, and the conversion path the worker finishes.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const NEUTRAL = { error: "This invite link is not valid" };

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

/** A host server with the flag on, its owner (the inviter) and an admin, and a private channel without Guests. */
async function seedHost(baseUrl: string, options: { plan?: "free" | "pro" } = {}) {
  const tag = randomBytes(4).toString("hex");
  const owner = await person(baseUrl, "cx-host-owner");
  const admin = await person(baseUrl, "cx-host-admin");
  const server = await createServer("Connect Host", `cx-host-${tag}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  if (options.plan) await getDb().update(servers).set({ plan: options.plan }).where(eq(servers.id, server.id));
  await enableExternalChannelsFlag(server.id);
  const room = async () => {
    const channel = await createChannel(server.id, `cx-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
    await addHuman(channel.id, admin.id);
    return channel;
  };
  return { owner, admin, server, room };
}

/** A server `owner` owns, with members added at the given roles. */
async function seedTarget(owner: Person, members: Array<[Person, "admin" | "member" | "guest"]> = []) {
  const server = await createServer("Target", `cx-target-${randomBytes(4).toString("hex")}`, owner.id);
  for (const [member, role] of members) {
    // A Guest is bound to its one channel (#wg-rbac:#15): a new private channel of the server.
    if (role === "guest") await seedBoundGuest({ serverId: server.id, userId: member.id });
    else await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role });
  }
  return server;
}

async function seedInvite(host: Awaited<ReturnType<typeof seedHost>>, channelId: string, email: string, input: { expiresAt?: Date; invitedBy?: string } = {}) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId,
    hostServerId: host.server.id,
    email,
    tokenHash: sha256(token),
    invitedByUserId: input.invitedBy ?? host.owner.id,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

function call(baseUrl: string, as: Person, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const page = (baseUrl: string, as: Person, token: string) => call(baseUrl, as, "GET", `external-invites/${token}`);
const connect = (baseUrl: string, as: Person, token: string, serverId: string) => call(baseUrl, as, "POST", `external-invites/${token}/connect`, { serverId });
const requestApproval = (baseUrl: string, as: Person, token: string, serverId: string, approverUserId: string) =>
  call(baseUrl, as, "POST", `external-invites/${token}/request-approval`, { serverId, approverUserId });
const acceptAsGuest = (baseUrl: string, as: Person, token: string) => call(baseUrl, as, "POST", `external-invites/${token}/accept-as-guest`);
const revoke = (baseUrl: string, as: Person, serverId: string, channelId: string, inviteId: string) => fetch(`${baseUrl}/api/channels/${channelId}/external-invites/${inviteId}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${as.token}`, "X-Server-Id": serverId },
});

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as { error?: string; code?: string };
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

async function requestRow(id: string) {
  const [row] = await getDb().select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, id));
  return row!;
}

/** The connected server's local projection of the host channel's joint, if any. */
async function projectionOn(hostChannelId: string, serverId: string) {
  const [host] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  if (!host) return null;
  const rows = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, host.jointChannelId), eq(jointChannelServers.serverId, serverId)));
  assert.ok(rows.length <= 1);
  return rows[0] ?? null;
}

async function isChannelMember(channelId: string, userId: string) {
  const rows = await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return rows.length > 0;
}

async function channelType(id: string) {
  const [row] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, id));
  return row?.type;
}

/** Makes the channel joint the way an admin's conversion does (host only). */
async function convertToJoint(host: Awaited<ReturnType<typeof seedHost>>, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  const done = await runChannelConversionJob(job.id);
  assert.equal(done.status, "done");
}

async function conversionJobOf(inviteId: string) {
  const invite = await inviteRow(inviteId);
  assert.ok(invite.connectConversionJobId, "the reservation names its conversion job");
  return invite.connectConversionJobId;
}

/** While `run` runs, `holder`'s address belongs to a new verified account (the successor), and theirs is another. */
async function swapInvitedAddress(baseUrl: string, holder: Person, run: (successor: Person) => Promise<void>) {
  const moved = `moved-${randomBytes(4).toString("hex")}@slock.test`;
  await getDb().update(users).set({ email: moved }).where(eq(users.id, holder.id));
  const successor = await person(baseUrl, "cx-successor");
  await getDb().update(users).set({ email: holder.email }).where(eq(users.id, successor.id));
  try {
    await run(successor);
  } finally {
    await getDb().update(users).set({ email: `gone-${randomBytes(4).toString("hex")}@slock.test` }).where(eq(users.id, successor.id));
    await getDb().update(users).set({ email: holder.email }).where(eq(users.id, holder.id));
  }
}

const emailsTo = (deliveries: ReturnType<typeof captureEmails>["deliveries"], to: string) => deliveries.filter((delivery) => delivery.to === to);

test("the page lists the invitee's servers: direct where they administer, approval where they are a member; Guest while nothing connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-invitee");
  const otherOwner = await person(app.baseUrl, "cx-other-owner");
  // The approval server's people at every role: only its owner and admin may approve.
  const otherAdmin = await person(app.baseUrl, "cx-other-admin");
  const otherMember = await person(app.baseUrl, "cx-other-member");
  const otherGuest = await person(app.baseUrl, "cx-other-guest");
  const owned = await seedTarget(invitee);
  const memberOf = await seedTarget(otherOwner, [[invitee, "member"], [otherAdmin, "admin"], [otherMember, "member"], [otherGuest, "guest"]]);
  // Its Guest's bound channel makes it external; paid, so that alone does not put it at the free plan's limit.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, memberOf.id));
  const guestOf = await seedTarget(otherOwner, [[invitee, "guest"]]);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  // Tiles as the caller's own lists show them: a server's avatar and slug, an approver's avatar.
  await getDb().update(servers).set({ avatarUrl: "https://cdn.test/owned.png" }).where(eq(servers.id, owned.id));
  await getDb().update(users).set({ avatarUrl: "pixel:approver" }).where(eq(users.id, otherOwner.id));

  const response = await page(app.baseUrl, invitee, invite.token);
  const shown = await expectStatus(response, 200) as unknown as { status: string; options: { guest: boolean; connect: { servers: unknown[] } } };
  assert.equal(shown.status, "pending");
  assert.equal(shown.options.guest, true);
  assert.deepEqual(
    [...shown.options.connect.servers].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [
      { id: owned.id, name: owned.name, slug: owned.slug, avatarUrl: "https://cdn.test/owned.png", canConnectDirectly: true, needsApproval: false, approvers: [], atLimit: false, canUpgrade: false, owners: [] },
      {
        id: memberOf.id, name: memberOf.name, slug: memberOf.slug, avatarUrl: null, canConnectDirectly: false, needsApproval: true,
        // Its owner and admin, by name; never a member (the invitee among them) or a Guest.
        approvers: [
          { id: otherAdmin.id, name: otherAdmin.displayName, avatarUrl: null },
          { id: otherOwner.id, name: otherOwner.displayName, avatarUrl: "pixel:approver" },
        ],
        atLimit: false, canUpgrade: false, owners: [],
      },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    `never the host or a server they are only a Guest of (${guestOf.id})`,
  );

  // Another invite of the channel connecting: no Guest option on this one.
  const connector = await person(app.baseUrl, "cx-connector");
  const connectorServer = await seedTarget(connector);
  const other = await seedInvite(host, room.id, connector.email);
  await expectStatus(await connect(app.baseUrl, connector, other.token, connectorServer.id), 202);
  const whileConnecting = await (await page(app.baseUrl, invitee, invite.token)).json() as { options: { guest: boolean } };
  assert.equal(whileConnecting.options.guest, false);
  const connecting = await (await page(app.baseUrl, connector, other.token)).json() as { status: string; options: { guest: boolean; connect: { servers: unknown[] } } };
  assert.deepEqual({ status: connecting.status, options: connecting.options }, { status: "connecting", options: { guest: false, connect: { servers: [] }, newServer: false } });
  // The connect phase, to the invitee only.
  assert.equal((connecting as { connectPhase?: string }).connectPhase, "conversion");
  assert.equal((await (await page(app.baseUrl, invitee, other.token)).json() as { connectPhase?: string }).connectPhase, undefined);

  // Joint: the page still works (it used to 404 for anything not private), with the Guest option (P3: the host's external_channels_v1 is on).
  await runChannelConversionJob(await conversionJobOf(other.id));
  await runChannelConversionWorkerPass();
  assert.equal(await channelType(room.id), "joint");
  const joint = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as unknown as { options: { guest: boolean; connect: { servers: Array<{ id: string }> } } };
  assert.equal(joint.options.guest, true);
  assert.deepEqual(joint.options.connect.servers.map((server) => server.id).sort(), [owned.id, memberOf.id].sort());
});

test("the page says how many servers the channel can still take: its slots less its parties and the other open invites, this invite's own given back", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-slots-invitee");
  await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  const slotsLeft = async () => {
    const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as unknown as { options: { connect: { slotsLeft?: number } } };
    return shown.options.connect.slotsLeft;
  };
  // The host is the one party; this invite's slot is the invitee's to fill.
  assert.equal(await slotsLeft(), EXTERNAL_CHANNEL_MAX_SLOTS - 1);
  // Another open invite and two bound Guests hold three more.
  await seedInvite(host, room.id, `cx-slots-other-${randomBytes(4).toString("hex")}@slock.test`);
  for (let index = 0; index < 2; index += 1) {
    await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser(`cx-slots-guest-${randomBytes(4).toString("hex")}`)).id, channelId: room.id });
  }
  assert.equal(await slotsLeft(), EXTERNAL_CHANNEL_MAX_SLOTS - 4);
  // Parties one short of the cap, but with the two open invites past it (over-invited from before):
  // no room, rather than this invite's slot added on top of a floored 0.
  for (let index = 0; index < EXTERNAL_CHANNEL_MAX_SLOTS - 4; index += 1) {
    await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser(`cx-slots-over-${randomBytes(4).toString("hex")}`)).id, channelId: room.id });
  }
  assert.equal(await slotsLeft(), 0);
});

test("on a joint channel connecting is one commit: the server joins, the invitee is in it, the invite is accepted with outcome server", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-direct");
  const target = await seedTarget(invitee);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const response = await connect(app.baseUrl, invitee, invite.token, target.id);
  const body = await expectStatus(response, 200) as unknown as { state: string; serverId: string; channelId: string };
  assert.equal(body.state, "connected");
  assert.equal(body.serverId, target.id);
  const projection = await projectionOn(room.id, target.id);
  assert.equal(projection?.status, "active");
  assert.equal(projection?.localChannelId, body.channelId);
  assert.equal(await isChannelMember(body.channelId, invitee.id), true);
  const row = await inviteRow(invite.id);
  assert.deepEqual(
    { status: row.status, outcome: row.outcome, acceptedUserId: row.acceptedUserId, acceptedServerId: row.acceptedServerId, connectPhase: row.connectPhase },
    { status: "accepted", outcome: "server", acceptedUserId: invitee.id, acceptedServerId: target.id, connectPhase: null },
  );
  // The joint invite it went through names the inviter (audit) and the authorizer.
  const [jointInvite] = await getDb().select().from(jointChannelInvites).where(eq(jointChannelInvites.toServerId, target.id));
  assert.deepEqual(
    { invitedByUserId: jointInvite?.invitedByUserId, invitedUserId: jointInvite?.invitedUserId, acceptedByUserId: jointInvite?.acceptedByUserId, status: jointInvite?.status },
    { invitedByUserId: host.owner.id, invitedUserId: invitee.id, acceptedByUserId: invitee.id, status: "accepted" },
  );
  // Used: the link is the neutral 404 now.
  assert.deepEqual(await (await connect(app.baseUrl, invitee, invite.token, target.id)).json(), NEUTRAL);
  // The page tells the person who connected where they landed: their server's projection.
  const landed = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as unknown as { status: string; accepted: unknown };
  assert.deepEqual({ status: landed.status, accepted: landed.accepted }, {
    status: "accepted",
    accepted: { outcome: "server", serverId: target.id, channelId: body.channelId, channelName: (await getDb().select({ name: channels.name }).from(channels).where(eq(channels.id, body.channelId)))[0]!.name },
  });
  // Anyone else: the neutral 404 (an admin of the host, a stranger, someone signed in as the invited address now).
  for (const other of [host.admin, await person(app.baseUrl, "cx-direct-stranger")]) {
    const shown = await page(app.baseUrl, other, invite.token);
    assert.equal(shown.status, 404);
    assert.deepEqual(await shown.json(), NEUTRAL);
  }
  await swapInvitedAddress(app.baseUrl, invitee, async (successor) => {
    assert.deepEqual(await (await page(app.baseUrl, successor, invite.token)).json(), NEUTRAL);
    assert.deepEqual(await (await page(app.baseUrl, invitee, invite.token)).json(), NEUTRAL);
  });
  assert.equal((await page(app.baseUrl, invitee, invite.token)).status, 200);
  // Their server left the channel: nowhere to send them, the neutral 404.
  await getDb().update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, body.channelId));
  assert.deepEqual(await (await page(app.baseUrl, invitee, invite.token)).json(), NEUTRAL);
});

test("an accepted server invite reveals nothing once its recipient leaves the landing server", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-removed-recipient");
  const targetOwner = await person(app.baseUrl, "cx-target-owner");
  const target = await seedTarget(targetOwner, [[invitee, "admin"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const connected = await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 200) as unknown as { channelId: string };
  assert.equal((await page(app.baseUrl, invitee, invite.token)).status, 200);

  const removed = await fetch(`${app.baseUrl}/api/servers/${target.id}/members/${invitee.id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${targetOwner.token}`, "X-Server-Id": target.id },
  });
  await expectStatus(removed, 200);
  assert.equal((await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, invitee.id)))).length, 0);
  const direct = await fetch(`${app.baseUrl}/api/channels/${connected.channelId}`, {
    headers: { Authorization: `Bearer ${invitee.token}`, "X-Server-Id": target.id },
  });
  assert.ok([403, 404].includes(direct.status));
  await getDb().update(channels).set({ name: "private-after-recipient-left" }).where(eq(channels.id, connected.channelId));
  const response = await page(app.baseUrl, invitee, invite.token);
  assert.equal(response.status, 404, await response.clone().text());
  assert.deepEqual(await response.json(), NEUTRAL);
});

test("an inviter who lost their admin role later does not invalidate the invite (cindyz 83bec5cb)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-demoted-inviter");
  const target = await seedTarget(invitee);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email, { invitedBy: host.admin.id });
  await getDb().update(serverMembers).set({ role: "member" })
    .where(and(eq(serverMembers.serverId, host.server.id), eq(serverMembers.userId, host.admin.id)));

  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 200);
  assert.equal((await inviteRow(invite.id)).status, "accepted");
  assert.equal((await projectionOn(room.id, target.id))?.status, "active");
});

test("connect needs owner/admin of a server the invitee belongs to, other than the host", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-not-admin");
  const otherOwner = await person(app.baseUrl, "cx-owner-2");
  const memberOf = await seedTarget(otherOwner, [[invitee, "member"]]);
  const stranger = await seedTarget(otherOwner);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  await expectStatus(await connect(app.baseUrl, invitee, invite.token, memberOf.id), 403, "server_admin_required");
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, stranger.id), 400, "invalid_server");
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, host.server.id), 400, "invalid_server");
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("the community servers (/community, /community-cn) are never offered and can't be connected or asked for", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-community");
  const otherOwner = await person(app.baseUrl, "cx-community-owner");
  const owned = await seedTarget(invitee);
  const community = await createServer("Community", "community", invitee.id);
  const communityCn = await createServer("社区", "community-cn", otherOwner.id);
  await getDb().insert(serverMembers).values({ serverId: communityCn.id, userId: invitee.id, role: "member" });
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);

  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as unknown as { options: { connect: { servers: Array<{ id: string }> } } };
  assert.deepEqual(shown.options.connect.servers.map((server) => server.id), [owned.id], "only the ordinary server");
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, community.id), 400, "invalid_server");
  await expectStatus(await requestApproval(app.baseUrl, invitee, invite.token, communityCn.id, otherOwner.id), 400, "invalid_server");
  assert.equal((await inviteRow(invite.id)).status, "pending");
  assert.equal(await projectionOn(room.id, community.id), null);

  // "Your servers": a host admin who owns /community doesn't see it either.
  await getDb().insert(serverMembers).values({ serverId: community.id, userId: host.admin.id, role: "admin" });
  const listed = await fetch(`${app.baseUrl}/api/channels/external-connect-servers`, {
    headers: { Authorization: `Bearer ${host.admin.token}`, "X-Server-Id": host.server.id },
  });
  const own = await expectStatus(listed, 200) as unknown as { servers: Array<{ id: string }> };
  assert.ok(!own.servers.some((server) => server.id === community.id), "no community server in Your servers");
});

test("every invite the caller cannot use is the same 404 on connect and request-approval", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-neutral");
  const stranger = await person(app.baseUrl, "cx-neutral-stranger");
  const target = await seedTarget(invitee);
  const spare = async () => (await host.room()).id;
  const cases: Array<[string, Person, string]> = [
    ["unknown token", invitee, randomBytes(32).toString("hex")],
    ["expired by time", invitee, (await seedInvite(host, await spare(), invitee.email, { expiresAt: new Date(Date.now() - 1000) })).token],
    ["another address", stranger, (await seedInvite(host, await spare(), invitee.email)).token],
  ];
  const revoked = await seedInvite(host, await spare(), invitee.email);
  await getDb().update(channelExternalInvites).set({ status: "revoked" }).where(eq(channelExternalInvites.id, revoked.id));
  cases.push(["revoked", invitee, revoked.token]);
  const paywall = capturePaywallHits(app);
  const spans = captureRefusalSpans(app);
  // The answer as bytes, headers that could tell reasons apart included.
  const answers = new Set<string>();
  const answer = async (response: Response) => JSON.stringify([response.status, response.headers.get("content-type"), response.headers.get("content-length"), await response.clone().text()]);
  for (const [label, as, token] of cases) {
    const connected = await connect(app.baseUrl, as, token, target.id);
    answers.add(await answer(connected));
    assert.equal(connected.status, 404, `connect: ${label}`);
    assert.deepEqual(await connected.json(), NEUTRAL, `connect: ${label}`);
    const requested = await requestApproval(app.baseUrl, as, token, target.id, invitee.id);
    answers.add(await answer(requested));
    assert.equal(requested.status, 404, `request-approval: ${label}`);
    assert.deepEqual(await requested.json(), NEUTRAL, `request-approval: ${label}`);
  }
  // Byte-identical for every reason, and the body it has always been (#wg-rbac:#60 changes no answer).
  assert.deepEqual([...answers], [JSON.stringify([404, "application/json; charset=utf-8", "41", '{"error":"This invite link is not valid"}'])]);
  // On the server's own trace too, one code for every reason, and no side.
  const traced = await spans.expect(cases.length * 2, "each unusable invite's span");
  assert.deepEqual([...new Set(traced.map((span) => JSON.stringify(span)))], [JSON.stringify({ status: 404, errorCode: "external_invite_unusable", limitSide: null })]);
  await paywall.expect(0, "an unusable invite is no paywall");
});

test("P3: a channel with a Guest connects, carrying the Guest into the joint channel; no Guest gets in while a server is connecting", async ({ app }) => {
  // Paid: the free plan's one-external-channel rule is tested on its own.
  const host = await seedHost(app.baseUrl, { plan: "pro" });
  const invitee = await person(app.baseUrl, "cx-guests");
  const target = await seedTarget(invitee);
  const withGuest = await host.room();
  const boundGuest = await seedUser(`cx-bound-${randomBytes(4).toString("hex")}`);
  await seedBoundGuest({ serverId: host.server.id, userId: boundGuest.id, channelId: withGuest.id });
  const carried = await seedInvite(host, withGuest.id, invitee.email);
  // With external_channels_v1 on for the host the Guest no longer blocks it (guests_present before P3).
  await expectStatus(await connect(app.baseUrl, invitee, carried.token, target.id), 202);
  assert.equal((await runChannelConversionJob(await conversionJobOf(carried.id))).status, "done");
  assert.equal(await channelType(withGuest.id), "joint");
  const [binding] = await getDb().select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, host.server.id), eq(serverMembers.userId, boundGuest.id)));
  assert.deepEqual(binding, { role: "guest", guestChannelId: withGuest.id }, "the binding is unchanged: the host projection");
  assert.equal(await canUserAccessChannel(withGuest.id, boundGuest.id, asServerId(host.server.id)), true, "the Guest is in the joint channel");

  // The other way round: connecting holds the channel against a Guest.
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  const guestToBe = await person(app.baseUrl, "cx-guest-to-be");
  const guestInvite = await seedInvite(host, room.id, guestToBe.email);
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 202);
  // While the conversion holds its fence, the writer fence answers.
  await expectStatus(await acceptAsGuest(app.baseUrl, guestToBe, guestInvite.token), 409, "channel_conversion_in_progress");
  // The conversion rolls back: the channel is writable again, but until the
  // worker returns the invite to pending the reservation still holds it.
  const failed = await runChannelConversionJob(await conversionJobOf(invite.id), { failBeforePhase: "verify" });
  assert.equal(failed.status, "failed");
  assert.equal(await channelType(room.id), "private");
  await expectStatus(await acceptAsGuest(app.baseUrl, guestToBe, guestInvite.token), 409, "connect_in_progress");
  const [member] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, host.server.id), eq(serverMembers.userId, guestToBe.id)));
  assert.equal(member, undefined);
});

test("one connection per channel at a time; revoke is refused during the conversion and allowed after it, and then nothing connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const first = await person(app.baseUrl, "cx-first");
  const second = await person(app.baseUrl, "cx-second");
  const firstServer = await seedTarget(first);
  const secondServer = await seedTarget(second);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, first.email);
  const another = await seedInvite(host, room.id, second.email);

  await expectStatus(await connect(app.baseUrl, first, invite.token, firstServer.id), 202);
  await expectStatus(await connect(app.baseUrl, second, another.token, secondServer.id), 409, "connect_in_progress");
  await expectStatus(await connect(app.baseUrl, first, invite.token, firstServer.id), 409, "connect_in_progress");
  const reserved = await inviteRow(invite.id);
  assert.deepEqual(
    { status: reserved.status, phase: reserved.connectPhase, server: reserved.connectServerId, joiner: reserved.connectJoinerUserId, authorizer: reserved.connectAuthorizerUserId },
    { status: "connecting", phase: "conversion", server: firstServer.id, joiner: first.id, authorizer: first.id },
  );
  // The host's list shows it connecting.
  const listed = await (await fetch(`${app.baseUrl}/api/channels/${room.id}/external-invites`, {
    headers: { Authorization: `Bearer ${host.owner.token}`, "X-Server-Id": host.server.id },
  })).json() as { invites: Array<{ id: string; connecting: boolean; connectPhase: string | null; revocable: boolean }> };
  const listedInvite = listed.invites.find((row) => row.id === invite.id);
  assert.deepEqual(
    { connecting: listedInvite?.connecting, connectPhase: listedInvite?.connectPhase, revocable: listedInvite?.revocable },
    { connecting: true, connectPhase: "conversion", revocable: false },
    "Withdraw is disabled while the conversion job is queued",
  );
  const listedOther = listed.invites.find((row) => row.id === another.id);
  assert.deepEqual({ connectPhase: listedOther?.connectPhase, revocable: listedOther?.revocable }, { connectPhase: null, revocable: true });

  await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, room.id, invite.id), 409, "connecting");

  // The conversion commits (its finalize moves the invite to the connection
  // step); the worker has not connected yet. Now revoke goes through, and the
  // worker never connects a revoked invite.
  assert.equal((await runChannelConversionJob(await conversionJobOf(invite.id))).status, "done");
  assert.equal((await inviteRow(invite.id)).connectPhase, "connection");
  const relisted = await (await fetch(`${app.baseUrl}/api/channels/${room.id}/external-invites`, {
    headers: { Authorization: `Bearer ${host.owner.token}`, "X-Server-Id": host.server.id },
  })).json() as { invites: Array<{ id: string; connectPhase: string | null; revocable: boolean }> };
  const relistedInvite = relisted.invites.find((row) => row.id === invite.id);
  assert.deepEqual({ connectPhase: relistedInvite?.connectPhase, revocable: relistedInvite?.revocable }, { connectPhase: "connection", revocable: true });
  await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, room.id, invite.id), 200);
  await runChannelConversionWorkerPass();
  assert.equal(await advanceExternalConnect(invite.id), null);
  assert.equal((await inviteRow(invite.id)).status, "revoked");
  assert.equal(await projectionOn(room.id, firstServer.id), null);
  assert.equal(await channelType(room.id), "joint", "the channel stays joint");
});

test("the conversion path: 202, the job runs, the worker connects the server and accepts the invite; re-running connects nothing twice", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-convert");
  const target = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);

  const response = await connect(app.baseUrl, invitee, invite.token, target.id);
  assert.deepEqual(await expectStatus(response, 202), { state: "connecting" });
  const jobId = await conversionJobOf(invite.id);
  const [job] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId));
  assert.equal(job?.createdByUserId, host.owner.id, "the conversion is attributed to the inviter");

  // Worker passes alone drive it: phases, then the connection.
  for (let pass = 0; pass < 30 && (await inviteRow(invite.id)).status === "connecting"; pass += 1) {
    await runChannelConversionWorkerPass();
  }
  const row = await inviteRow(invite.id);
  assert.deepEqual(
    { status: row.status, outcome: row.outcome, acceptedUserId: row.acceptedUserId, acceptedServerId: row.acceptedServerId },
    { status: "accepted", outcome: "server", acceptedUserId: invitee.id, acceptedServerId: target.id },
  );
  assert.equal(await channelType(room.id), "joint");
  const projection = await projectionOn(room.id, target.id);
  assert.equal(projection?.status, "active");
  assert.equal(await isChannelMember(projection!.localChannelId, invitee.id), true);

  // Idempotent: more passes and a direct step change nothing.
  await runChannelConversionWorkerPass();
  assert.equal(await advanceExternalConnect(invite.id), null);
  const participants = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, projection!.jointChannelId));
  assert.equal(participants.length, 2);
});

test("a conversion that rolls back returns the invite to pending and emails the invitee", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-rollback");
  const target = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 202);
  const failed = await runChannelConversionJob(await conversionJobOf(invite.id), { failBeforePhase: "move_parent_messages" });
  assert.equal((failed.progress as { rollbackState?: string }).rollbackState, "restored");

  const mail = captureEmails();
  try {
    await runChannelConversionWorkerPass();
  } finally {
    mail.stop();
  }
  const row = await inviteRow(invite.id);
  assert.deepEqual({ status: row.status, phase: row.connectPhase, job: row.connectConversionJobId }, { status: "pending", phase: null, job: null });
  assert.equal(await channelType(room.id), "private");
  const sent = emailsTo(mail.deliveries, invitee.email);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /couldn't be connected/);

  // Pending again: connecting once more restarts the rolled-back job and goes through.
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 202);
  assert.equal(await conversionJobOf(invite.id), failed.id);
  for (let pass = 0; pass < 30 && (await inviteRow(invite.id)).status === "connecting"; pass += 1) await runChannelConversionWorkerPass();
  assert.equal((await inviteRow(invite.id)).status, "accepted");
});

test("after the conversion commits, the connection step is durable: a crash before connecting completes on the next pass; flag off waits", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-crash");
  const target = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 202);
  // The job finishes in its own commits and the process "crashes" before any connect step.
  assert.equal((await runChannelConversionJob(await conversionJobOf(invite.id))).status, "done");
  const afterFinalize = await inviteRow(invite.id);
  assert.deepEqual({ status: afterFinalize.status, phase: afterFinalize.connectPhase }, { status: "connecting", phase: "connection" });

  // The flag goes off: the worker re-reads it and does not connect.
  await getDb().delete(featureFlagRules).where(and(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY)));
  await runChannelConversionWorkerPass();
  assert.equal(await projectionOn(room.id, target.id), null);
  assert.equal((await inviteRow(invite.id)).status, "connecting");

  // Back on (and due again): the next pass connects, without converting again.
  await enableExternalChannelsFlag(host.server.id);
  await getDb().update(channelExternalInvites).set({ connectNextAttemptAt: null }).where(eq(channelExternalInvites.id, invite.id));
  await runChannelConversionWorkerPass();
  assert.equal((await inviteRow(invite.id)).status, "accepted");
  assert.equal((await projectionOn(room.id, target.id))?.status, "active");
  const jobs = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, room.id));
  assert.equal(jobs.length, 1, "converted once");
});

test("a joiner who left the server after the conversion: no connection, the channel stays joint, the invite returns to pending", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-left-approver");
  const requester = await person(app.baseUrl, "cx-left-requester");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, requester.email);
  const requested = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requested.requestId}/approve`), 202);
  assert.equal((await runChannelConversionJob(await conversionJobOf(invite.id))).status, "done");
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, requester.id)));
  await runChannelConversionWorkerPass();
  assert.equal((await inviteRow(invite.id)).status, "pending");
  assert.equal(await projectionOn(room.id, target.id), null);
  assert.equal(await channelType(room.id), "joint");
});

test("approval: the requester asks an admin, the approver is emailed and approves; the requester joins, the approver authorized", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-approver");
  const requester = await person(app.baseUrl, "cx-requester");
  const bystander = await person(app.baseUrl, "cx-bystander");
  const target = await seedTarget(approver, [[requester, "member"], [bystander, "admin"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, requester.email);

  await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, requester.id), 400, "invalid_approver");
  const mail = captureEmails();
  let requestId: string;
  try {
    const created = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
    requestId = created.requestId!;
  } finally {
    mail.stop();
  }
  const toApprover = emailsTo(mail.deliveries, approver.email);
  assert.equal(toApprover.length, 1);
  assert.ok(toApprover[0]!.html.includes(`/server-connect-requests/${requestId}`));
  // The request ends with the invite: the email says when.
  const endsOn = (await requestRow(requestId)).expiresAt.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  assert.ok(toApprover[0]!.html.includes(`The request ends with the invite on ${endsOn} (UTC).`));
  assert.equal((await inviteRow(invite.id)).status, "awaiting_approval");
  await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 409, "approval_in_progress");
  await expectStatus(await connect(app.baseUrl, requester, invite.token, target.id), 409, "approval_in_progress");

  // Only the named approver sees or decides it.
  await expectStatus(await call(app.baseUrl, bystander, "GET", `server-connect-requests/${requestId}`), 404, "request_not_found");
  await expectStatus(await call(app.baseUrl, bystander, "POST", `server-connect-requests/${requestId}/approve`), 404, "request_not_found");
  const view = await expectStatus(await call(app.baseUrl, approver, "GET", `server-connect-requests/${requestId}`), 200) as unknown as Record<string, unknown>;
  assert.equal(view.status, "pending");
  assert.deepEqual(view.requester, { id: requester.id, name: requester.displayName });
  assert.equal(view.targetChannelId, null, "not connected yet");

  const resultMail = captureEmails();
  try {
    await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 200);
  } finally {
    resultMail.stop();
  }
  const projection = await projectionOn(room.id, target.id);
  assert.equal(projection?.status, "active");
  assert.equal(projection?.joinedByUserId, approver.id, "the approver connected it");
  assert.equal(await isChannelMember(projection!.localChannelId, requester.id), true, "the requester joined");
  assert.equal(await isChannelMember(projection!.localChannelId, approver.id), false, "the approver did not");
  const row = await inviteRow(invite.id);
  assert.deepEqual({ status: row.status, outcome: row.outcome, acceptedUserId: row.acceptedUserId }, { status: "accepted", outcome: "server", acceptedUserId: requester.id });
  assert.equal((await requestRow(requestId)).status, "approved");
  assert.equal(emailsTo(resultMail.deliveries, requester.email).length, 1);
  // Approved: the request names the approver's channel, for "Open #channel".
  const approved = await expectStatus(await call(app.baseUrl, approver, "GET", `server-connect-requests/${requestId}`), 200) as unknown as Record<string, unknown>;
  assert.deepEqual({ status: approved.status, targetChannelId: approved.targetChannelId }, { status: "approved", targetChannelId: projection!.localChannelId });
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409, "request_not_pending");
});

test("approval on a private channel starts the conversion; the worker connects with the approver as authorizer", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-approver-conv");
  const requester = await person(app.baseUrl, "cx-requester-conv");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, requester.email);
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 202);
  const reserved = await inviteRow(invite.id);
  assert.deepEqual(
    { status: reserved.status, joiner: reserved.connectJoinerUserId, authorizer: reserved.connectAuthorizerUserId },
    { status: "connecting", joiner: requester.id, authorizer: approver.id },
  );
  assert.equal((await requestRow(requestId!)).status, "approved");
  for (let pass = 0; pass < 30 && (await inviteRow(invite.id)).status === "connecting"; pass += 1) await runChannelConversionWorkerPass();
  const projection = await projectionOn(room.id, target.id);
  assert.equal(projection?.joinedByUserId, approver.id);
  assert.equal(await isChannelMember(projection!.localChannelId, requester.id), true);
  assert.equal((await inviteRow(invite.id)).acceptedUserId, requester.id);
});

test("reject, an approver who lost the role, and a requester who left: the request ends, the invite returns to pending, the invitee is emailed", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-decide-approver");
  const requester = await person(app.baseUrl, "cx-decide-requester");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const otherApprover = await person(app.baseUrl, "cx-decide-other");
  await getDb().insert(serverMembers).values({ serverId: target.id, userId: otherApprover.id, role: "admin" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, requester.email);
  const ask = async (approverUserId: string) =>
    (await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approverUserId), 201) as { requestId?: string }).requestId!;

  // Rejected.
  const rejected = await ask(approver.id);
  let mail = captureEmails();
  try {
    await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${rejected}/reject`), 200);
  } finally {
    mail.stop();
  }
  assert.equal((await requestRow(rejected)).status, "rejected");
  assert.equal((await inviteRow(invite.id)).status, "pending");
  assert.match(emailsTo(mail.deliveries, requester.email)[0]?.subject ?? "", /declined/);

  // The approver lost the role before clicking.
  const lost = await ask(otherApprover.id);
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, otherApprover.id)));
  mail = captureEmails();
  try {
    const body = await expectStatus(await call(app.baseUrl, otherApprover, "POST", `server-connect-requests/${lost}/approve`), 403, "approver_lost_role");
    assert.equal(body.error, "You can no longer approve this request");
  } finally {
    mail.stop();
  }
  const lostRow = await requestRow(lost);
  assert.deepEqual({ status: lostRow.status, reason: lostRow.cancelReason }, { status: "cancelled", reason: "approver_lost_role" });
  assert.equal((await inviteRow(invite.id)).status, "pending");
  assert.match(emailsTo(mail.deliveries, requester.email)[0]?.subject ?? "", /was canceled/);
  assert.equal(await projectionOn(room.id, target.id), null);

  // The requester left the server before approval.
  const left = await ask(approver.id);
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, requester.id)));
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${left}/approve`), 409, "requester_left");
  const leftRow = await requestRow(left);
  assert.deepEqual({ status: leftRow.status, reason: leftRow.cancelReason }, { status: "cancelled", reason: "requester_left" });
  assert.equal((await inviteRow(invite.id)).status, "pending");
  assert.equal(await projectionOn(room.id, target.id), null);
});

test("an approver whose account is being deleted and who also lost the role: refused as anyone not the approver (404), the request kept pending, nobody emailed", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-deleting-owner");
  const requester = await person(app.baseUrl, "cx-deleting-requester");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const deleting = await person(app.baseUrl, "cx-deleting-approver");
  await getDb().insert(serverMembers).values({ serverId: target.id, userId: deleting.id, role: "admin" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, requester.email);
  const requestId = (await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, deleting.id), 201) as { requestId?: string }).requestId!;
  const before = (await inviteRow(invite.id)).status;

  // The approver asks to delete their account (their sessions end: the service is called directly), then loses the role.
  const requested = await requestAccountDeletion({ userId: deleting.id, source: "self", actorUserId: deleting.id });
  assert.equal(requested.kind, "scheduled", JSON.stringify(requested));
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, deleting.id)));

  const mail = captureEmails();
  try {
    await assert.rejects(approveServerConnectRequest(requestId, deleting.id),
      (err: unknown) => err instanceof ExternalConnectError && err.code === "request_not_found" && err.message === "Request not found");
  } finally {
    mail.stop();
  }
  assert.deepEqual(mail.deliveries, [], "no cancel email");
  const row = await requestRow(requestId);
  assert.deepEqual({ status: row.status, reason: row.cancelReason }, { status: "pending", reason: null }, "kept pending");
  assert.equal((await inviteRow(invite.id)).status, before, "the invite as it was");
  assert.equal(await projectionOn(room.id, target.id), null, "not connected");
});

test("revoking an invite awaiting approval cancels its request", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-revoke-approver");
  const requester = await person(app.baseUrl, "cx-revoke-requester");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, requester.email);
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
  await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, room.id, invite.id), 200);
  const row = await requestRow(requestId!);
  assert.deepEqual({ status: row.status, reason: row.cancelReason }, { status: "cancelled", reason: "invite_revoked" });
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409, "request_not_pending");
});

test("free plan, one external channel: a Guest first then a connect, or a connect first then a Guest, are refused alike; a paid host takes both", async ({ app }) => {
  const outcome = async (plan: "free" | "pro", order: "guest-first" | "connect-first") => {
    const host = await seedHost(app.baseUrl, { plan });
    const guestRoom = await host.room();
    const jointRoom = await host.room();
    await convertToJoint(host, jointRoom.id);
    const guest = await person(app.baseUrl, "cx-free-guest");
    const connector = await person(app.baseUrl, "cx-free-connector");
    const target = await seedTarget(connector);
    const guestInvite = await seedInvite(host, guestRoom.id, guest.email);
    const connectInvite = await seedInvite(host, jointRoom.id, connector.email);
    const asGuest = () => acceptAsGuest(app.baseUrl, guest, guestInvite.token);
    const asServer = () => connect(app.baseUrl, connector, connectInvite.token, target.id);
    const first = order === "guest-first" ? await asGuest() : await asServer();
    assert.equal(first.status, 200, await first.clone().text());
    const second = order === "guest-first" ? await asServer() : await asGuest();
    return { status: second.status, code: (await second.json() as { code?: string }).code };
  };
  assert.deepEqual(await outcome("free", "guest-first"), { status: 409, code: "free_external_limit" });
  assert.deepEqual(await outcome("free", "connect-first"), { status: 409, code: "free_external_limit" });
  assert.deepEqual(await outcome("pro", "guest-first"), { status: 200, code: undefined });
  assert.deepEqual(await outcome("pro", "connect-first"), { status: 200, code: undefined });
});

test("free plan: another server joins a channel that is already external", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const first = await person(app.baseUrl, "cx-free-first");
  const second = await person(app.baseUrl, "cx-free-second");
  const firstServer = await seedTarget(first);
  const secondServer = await seedTarget(second);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, secondServer.id));
  await expectStatus(await connect(app.baseUrl, first, (await seedInvite(host, room.id, first.email)).token, firstServer.id), 200);
  // The free host now has its one external channel: this very one.
  await expectStatus(await connect(app.baseUrl, second, (await seedInvite(host, room.id, second.email)).token, secondServer.id), 200);
});

/** Makes the server external the way a Guest accept does: a channel of it with a bound Guest. */
async function makeExternal(baseUrl: string, server: { id: string }, ownerId: string) {
  const channel = await createChannel(server.id, `cx-used-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: ownerId });
  const guest = await person(baseUrl, "cx-used-guest");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
}

test("the connect list marks the invitee's free servers already in an external channel: at the limit, upgradable only where they may pay for it (an owner), with its owners named; the host's own limit is not told", async ({ app }) => {
  // The host is on the Free plan and already in an external channel: its limit is not the invitee's to know.
  const host = await seedHost(app.baseUrl);
  await makeExternal(app.baseUrl, host.server, host.owner.id);
  const room = await host.room();
  const invitee = await person(app.baseUrl, "cx-avail-invitee");
  const otherOwner = await person(app.baseUrl, "cx-avail-other");
  const owned = await seedTarget(invitee);
  const administered = await seedTarget(otherOwner, [[invitee, "admin"]]);
  const memberOf = await seedTarget(otherOwner, [[invitee, "member"]]);
  const paid = await seedTarget(invitee);
  const untouched = await seedTarget(invitee);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, paid.id));
  for (const [server, ownerId] of [[owned, invitee.id], [administered, otherOwner.id], [memberOf, otherOwner.id], [paid, invitee.id]] as const) {
    await makeExternal(app.baseUrl, server, ownerId);
  }
  const invite = await seedInvite(host, room.id, invitee.email);

  const shown = await expectStatus(await page(app.baseUrl, invitee, invite.token), 200) as unknown as {
    options: { guest: boolean; newServer: boolean; connect: { servers: Array<{ id: string; atLimit: boolean; canUpgrade: boolean; owners: Array<{ id: string; name: string }> }> } };
    channelFull: boolean;
  };
  const availability = Object.fromEntries(shown.options.connect.servers.map((server) => [server.id, {
    atLimit: server.atLimit, canUpgrade: server.canUpgrade, owners: server.owners.map((owner) => [owner.id, owner.name]),
  }]));
  const ownedBy = (who: { id: string; displayName: string | null }) => [[who.id, who.displayName]];
  assert.deepEqual(availability, {
    [owned.id]: { atLimit: true, canUpgrade: true, owners: ownedBy(invitee) },
    // An admin connects it directly but can't pay for it (manageBilling is an owner's): asks its owner.
    [administered.id]: { atLimit: true, canUpgrade: false, owners: ownedBy(otherOwner) },
    // A member can't upgrade it (nor connect it but by approval).
    [memberOf.id]: { atLimit: true, canUpgrade: false, owners: ownedBy(otherOwner) },
    // Not at its limit: no owners listed.
    [paid.id]: { atLimit: false, canUpgrade: false, owners: [] },
    [untouched.id]: { atLimit: false, canUpgrade: false, owners: [] },
  });
  // The host's limit: the ways in are offered as usual, and nothing names a plan.
  assert.equal(shown.options.guest, true);
  assert.equal(shown.options.newServer, true);
  assert.equal(shown.channelFull, false);
  assert.equal(/plan|free|pro\b/i.test(JSON.stringify(shown)), false, JSON.stringify(shown));

  // What the list says is what the connect answers, once the host's own limit is out of the way.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, host.server.id));
  const refused = await expectStatus(await connect(app.baseUrl, invitee, invite.token, owned.id), 409, "free_external_limit") as { limitSide?: string };
  assert.equal(refused.limitSide, "connecting");
});

test("revoke after the conversion job ended: allowed whether or not it restored the channel, which is left as it is; a stale worker then changes nothing", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "cx-revoke-failed");
  const target = await seedTarget(invitee);

  // Failed and restored.
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 202);
  const jobId = await conversionJobOf(invite.id);
  assert.equal((await runChannelConversionJob(jobId, { failBeforePhase: "verify" })).status, "failed");
  // A worker read the reservation and pauses right before settling it.
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let reached!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
  __setExternalConnectSettleBarrierForTests(async () => { reached(); await paused; });
  try {
    const stale = advanceExternalConnect(invite.id);
    await atBarrier;
    await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, room.id, invite.id), 200);
    resume();
    await stale;
  } finally {
    __setExternalConnectSettleBarrierForTests(null);
  }
  const row = await inviteRow(invite.id);
  assert.deepEqual({ status: row.status, generation: row.connectGeneration, job: row.connectConversionJobId }, { status: "revoked", generation: null, job: null });
  const [job] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId));
  assert.equal(job?.status, "failed", "the job is left as it was");
  assert.equal(await channelType(room.id), "private");

  // Failed without a restore: revocable all the same, channel and job untouched.
  const other = await host.room();
  const second = await seedInvite(host, other.id, invitee.email);
  await expectStatus(await connect(app.baseUrl, invitee, second.token, target.id), 202);
  const secondJob = await conversionJobOf(second.id);
  await getDb().update(channelConversionJobs).set({ status: "failed", progress: {} }).where(eq(channelConversionJobs.id, secondJob));
  await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, other.id, second.id), 200);
  assert.equal((await inviteRow(second.id)).status, "revoked");
  const [kept] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, secondJob));
  assert.equal(kept?.status, "failed");
});

test("an archived joint takes no new server: the ordinary joint accept, single and batch, is refused after the archive", async ({ app }) => {
  for (const batch of [false, true]) {
    const host = await seedHost(app.baseUrl, { plan: "pro" });
    const room = await host.room();
    await convertToJoint(host, room.id);
    const peer = await person(app.baseUrl, "cx-archived-peer");
    const target = await seedTarget(peer);
    const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
    const invite = await createJointChannelInvite({ jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.id, invitedUserId: peer.id, invitedByUserId: host.owner.id });
    const archived = await fetch(`${app.baseUrl}/api/channels/${room.id}/archive`, {
      method: "POST", headers: { Authorization: `Bearer ${host.owner.token}`, "X-Server-Id": host.server.id },
    });
    await expectStatus(archived, 200);
    const accept = await fetch(`${app.baseUrl}/api/channels/joint-invites/${batch ? "accept-many" : `${invite.id}/accept`}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "X-Server-Id": target.id, "Content-Type": "application/json" },
      ...(batch ? { body: JSON.stringify({ inviteIds: [invite.id] }) } : {}),
    });
    const label = batch ? "batch" : "single";
    const body = await accept.json() as { code?: string };
    assert.equal(accept.status, 409, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "channel_archived", label);
    assert.equal(await projectionOn(room.id, target.id), null, label);
    const [row] = await getDb().select().from(jointChannelInvites).where(eq(jointChannelInvites.id, invite.id));
    assert.equal(row?.status, "pending", label);
  }
});

test("the page shows the requester their pending request, then the one declined or cancelled; nobody else sees either", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-state-approver");
  const requester = await person(app.baseUrl, "cx-state-requester");
  const stranger = await person(app.baseUrl, "cx-state-stranger");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, requester.email);
  type Shown = { status: string; pendingRequest?: Record<string, unknown>; lastRequest?: Record<string, unknown> };
  const shownTo = async (as: Person) => await expectStatus(await page(app.baseUrl, as, invite.token), 200) as unknown as Shown;

  const before = await shownTo(requester);
  assert.deepEqual({ pending: before.pendingRequest, last: before.lastRequest }, { pending: undefined, last: undefined });

  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
  const waiting = await shownTo(requester);
  assert.equal(waiting.status, "awaiting_approval");
  assert.deepEqual({ ...waiting.pendingRequest, expiresAt: typeof waiting.pendingRequest?.expiresAt }, {
    id: requestId,
    serverId: target.id,
    serverName: target.name,
    approverUserId: approver.id,
    approverName: approver.displayName,
    expiresAt: "string",
  });
  assert.equal(waiting.lastRequest, undefined);
  // The link holder sees the page, not the request.
  for (const other of [stranger, approver]) {
    const shown = await shownTo(other);
    assert.deepEqual({ pending: shown.pendingRequest, last: shown.lastRequest }, { pending: undefined, last: undefined });
  }

  // Someone else signed in as the invited address now (the requester changed theirs): not their request.
  await swapInvitedAddress(app.baseUrl, requester, async (successor) => {
    const shown = await shownTo(successor);
    assert.deepEqual({ status: shown.status, pending: shown.pendingRequest, last: shown.lastRequest }, { status: "awaiting_approval", pending: undefined, last: undefined });
    const refused = await call(app.baseUrl, successor, "POST", `external-invites/${invite.token}/cancel-request`);
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), NEUTRAL);
    // And the requester, no longer the invited address, is not told either.
    assert.equal((await shownTo(requester)).pendingRequest, undefined);
  });
  assert.equal((await requestRow(requestId!)).status, "pending");

  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/reject`), 200);
  const declined = await shownTo(requester);
  assert.equal(declined.status, "pending");
  assert.equal(declined.pendingRequest, undefined);
  assert.deepEqual({ ...declined.lastRequest, decidedAt: typeof declined.lastRequest?.decidedAt }, {
    status: "rejected", decidedAt: "string", serverName: target.name, cancelReason: null,
  });
  assert.equal((await shownTo(stranger)).lastRequest, undefined);

  // Revoked or expired: the neutral 404, request or not.
  await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201);
  await getDb().update(channelExternalInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(channelExternalInvites.id, invite.id));
  assert.deepEqual(await (await page(app.baseUrl, requester, invite.token)).json(), NEUTRAL);
  await getDb().update(channelExternalInvites).set({ expiresAt: new Date(Date.now() + DAY_MS) }).where(eq(channelExternalInvites.id, invite.id));
  await expectStatus(await revoke(app.baseUrl, host.owner, host.server.id, room.id, invite.id), 200);
  assert.deepEqual(await (await page(app.baseUrl, requester, invite.token)).json(), NEUTRAL);
});

test("cancel-request: the requester withdraws it, the invite is pending again and a new request works; anyone else 404, nothing pending 409", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const approver = await person(app.baseUrl, "cx-cancel-approver");
  const requester = await person(app.baseUrl, "cx-cancel-requester");
  const stranger = await person(app.baseUrl, "cx-cancel-stranger");
  const target = await seedTarget(approver, [[requester, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, requester.email);
  const cancel = (as: Person, token = invite.token) => call(app.baseUrl, as, "POST", `external-invites/${token}/cancel-request`);

  await expectStatus(await cancel(requester), 409, "request_not_pending");
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };

  // Not theirs to cancel: the neutral 404, and the request is untouched.
  for (const other of [stranger, approver, host.owner]) {
    const refused = await cancel(other);
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), NEUTRAL);
  }
  assert.deepEqual(await (await cancel(requester, randomBytes(32).toString("hex"))).json(), NEUTRAL);
  assert.equal((await requestRow(requestId!)).status, "pending");

  const mail = captureEmails();
  try {
    assert.deepEqual(await expectStatus(await cancel(requester), 200), { status: "cancelled" });
  } finally {
    mail.stop();
  }
  assert.equal(mail.deliveries.length, 0, "nobody is emailed");
  const row = await requestRow(requestId!);
  assert.deepEqual({ status: row.status, reason: row.cancelReason, decided: !!row.decidedAt }, { status: "cancelled", reason: "requester_cancelled", decided: true });
  assert.equal((await inviteRow(invite.id)).status, "pending");
  const shown = await expectStatus(await page(app.baseUrl, requester, invite.token), 200) as unknown as { lastRequest?: Record<string, unknown> };
  assert.equal(shown.lastRequest?.cancelReason, "requester_cancelled");
  await expectStatus(await cancel(requester), 409, "request_not_pending");
  // The approver can no longer decide it.
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409, "request_not_pending");

  // A new request works, and is approved.
  const again = await expectStatus(await requestApproval(app.baseUrl, requester, invite.token, target.id, approver.id), 201) as { requestId?: string };
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${again.requestId}/approve`), 200);
  assert.equal((await inviteRow(invite.id)).status, "accepted");
  // Accepted: nothing to cancel, the neutral 404.
  assert.deepEqual(await (await cancel(requester)).json(), NEUTRAL);
});

test("a limit refusal names whose limit it is: the host's, or the connecting server's (connect and approve)", async ({ app }) => {
  type Refusal = { code?: string; limitSide?: string; limitServerId?: string | null };
  const side = (body: Refusal) => ({ code: body.code, side: body.limitSide, server: body.limitServerId });

  // The connecting server's: a free server already in a channel shared with another host's.
  const connector = await person(app.baseUrl, "cx-side-connector");
  const requester = await person(app.baseUrl, "cx-side-requester");
  const freeTarget = await seedTarget(connector, [[requester, "member"]]);
  const first = await seedHost(app.baseUrl, { plan: "pro" });
  const firstRoom = await first.room();
  await convertToJoint(first, firstRoom.id);
  await expectStatus(await connect(app.baseUrl, connector, (await seedInvite(first, firstRoom.id, connector.email)).token, freeTarget.id), 200);
  const second = await seedHost(app.baseUrl, { plan: "pro" });
  const secondRoom = await second.room();
  await convertToJoint(second, secondRoom.id);
  const refusedConnect = await expectStatus(await connect(app.baseUrl, connector, (await seedInvite(second, secondRoom.id, connector.email)).token, freeTarget.id), 409) as Refusal;
  assert.deepEqual(side(refusedConnect), { code: "free_external_limit", side: "connecting", server: freeTarget.id });
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, (await seedInvite(second, secondRoom.id, requester.email)).token, freeTarget.id, connector.id), 201) as { requestId?: string };
  const refusedApprove = await expectStatus(await call(app.baseUrl, connector, "POST", `server-connect-requests/${requestId}/approve`), 409) as Refusal;
  assert.deepEqual(side(refusedApprove), { code: "free_external_limit", side: "connecting", server: freeTarget.id });

  // The host's: a free host with an external channel already, connecting a paid server to another.
  const freeHost = await seedHost(app.baseUrl, { plan: "free" });
  const usedRoom = await freeHost.room();
  await convertToJoint(freeHost, usedRoom.id);
  const paidOwner = await person(app.baseUrl, "cx-side-paid");
  const paid = await seedTarget(paidOwner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, paid.id));
  await expectStatus(await connect(app.baseUrl, paidOwner, (await seedInvite(freeHost, usedRoom.id, paidOwner.email)).token, paid.id), 200);
  const otherRoom = await freeHost.room();
  await convertToJoint(freeHost, otherRoom.id);
  const otherPaidOwner = await person(app.baseUrl, "cx-side-paid-2");
  const otherPaid = await seedTarget(otherPaidOwner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, otherPaid.id));
  const refusedHost = await expectStatus(await connect(app.baseUrl, otherPaidOwner, (await seedInvite(freeHost, otherRoom.id, otherPaidOwner.email)).token, otherPaid.id), 409) as Refusal;
  assert.deepEqual(side(refusedHost), { code: "free_external_limit", side: "host", server: freeHost.server.id });

  // No per-joint free-server cap with external channels on for the host: a
  // third free server connects (directly, and when an approver connects it).
  const freeOwner = await person(app.baseUrl, "cx-side-free");
  const freeOne = await seedTarget(freeOwner);
  await expectStatus(await connect(app.baseUrl, freeOwner, (await seedInvite(freeHost, usedRoom.id, freeOwner.email)).token, freeOne.id), 200);
  const thirdOwner = await person(app.baseUrl, "cx-side-third");
  const thirdFree = await seedTarget(thirdOwner);
  await expectStatus(await connect(app.baseUrl, thirdOwner, (await seedInvite(freeHost, usedRoom.id, thirdOwner.email)).token, thirdFree.id), 200);
  const capRequester = await person(app.baseUrl, "cx-side-cap-requester");
  const capApprover = await person(app.baseUrl, "cx-side-cap-approver");
  const capServer = await seedTarget(capApprover, [[capRequester, "member"]]);
  const capInvite = await seedInvite(freeHost, usedRoom.id, capRequester.email);
  const asked = await expectStatus(await requestApproval(app.baseUrl, capRequester, capInvite.token, capServer.id, capApprover.id), 201) as { requestId?: string };
  await expectStatus(await call(app.baseUrl, capApprover, "POST", `server-connect-requests/${asked.requestId}/approve`), 200);
});

test("the approval page says on load whether approving meets the approver's server's Free limit: an owner may upgrade, an admin may not and is told its owners; nobody else learns anything", async ({ app }) => {
  type View = { status: string; canApprove: boolean; targetServer: { id: string; atLimit: boolean; canUpgrade: boolean; owners: Array<{ id: string; name: string }> } };
  const owner = await person(app.baseUrl, "cx-limit-owner");
  const admin = await person(app.baseUrl, "cx-limit-admin");
  const bystander = await person(app.baseUrl, "cx-limit-bystander");
  const requester = await person(app.baseUrl, "cx-limit-requester");
  const target = await seedTarget(owner, [[admin, "admin"], [bystander, "admin"], [requester, "member"]]);
  // A paid host: its own limit is out of the way.
  const host = await seedHost(app.baseUrl, { plan: "pro" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const otherRoom = await host.room();
  await convertToJoint(host, otherRoom.id);
  const ask = async (channelId: string, approver: Person) => {
    const created = await expectStatus(await requestApproval(app.baseUrl, requester, (await seedInvite(host, channelId, requester.email)).token, target.id, approver.id), 201) as { requestId?: string };
    return created.requestId!;
  };
  const toOwner = await ask(room.id, owner);
  const toAdmin = await ask(otherRoom.id, admin);
  const view = async (as: Person, requestId: string) => {
    const body = await expectStatus(await call(app.baseUrl, as, "GET", `server-connect-requests/${requestId}`), 200) as unknown as View;
    return { canApprove: body.canApprove, atLimit: body.targetServer.atLimit, canUpgrade: body.targetServer.canUpgrade, owners: body.targetServer.owners.map((o) => o.name) };
  };

  // Not at its limit yet.
  assert.deepEqual(await view(owner, toOwner), { canApprove: true, atLimit: false, canUpgrade: false, owners: [] });

  await makeExternal(app.baseUrl, target, owner.id);
  assert.deepEqual(await view(owner, toOwner), { canApprove: true, atLimit: true, canUpgrade: true, owners: [owner.displayName] });
  // An admin approves but can't pay for it (manageBilling is an owner's).
  assert.deepEqual(await view(admin, toAdmin), { canApprove: true, atLimit: true, canUpgrade: false, owners: [owner.displayName] });
  // Anyone not the named approver, an admin of the server too: the same 404 as before, nothing more.
  const refused = await expectStatus(await call(app.baseUrl, bystander, "GET", `server-connect-requests/${toOwner}`), 404, "request_not_found");
  assert.equal(/atLimit|canUpgrade|owners|canApprove/.test(JSON.stringify(refused)), false);
  // What the page said is what approving answers.
  await expectStatus(await call(app.baseUrl, admin, "POST", `server-connect-requests/${toAdmin}/approve`), 409, "free_external_limit");

  // An approver who lost the role can't approve; one who left the server learns nothing of it.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, admin.id)));
  assert.deepEqual(await view(admin, toAdmin), { canApprove: false, atLimit: true, canUpgrade: false, owners: [owner.displayName] });
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, target.id), eq(serverMembers.userId, admin.id)));
  assert.deepEqual(await view(admin, toAdmin), { canApprove: false, atLimit: false, canUpgrade: false, owners: [] });

  // Upgraded: no longer at its limit.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, target.id));
  assert.deepEqual(await view(owner, toOwner), { canApprove: true, atLimit: false, canUpgrade: false, owners: [] });
  // Decided: nothing to approve, no limit told.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, target.id));
  await expectStatus(await call(app.baseUrl, owner, "POST", `server-connect-requests/${toOwner}/reject`), 200);
  assert.deepEqual(await view(owner, toOwner), { canApprove: false, atLimit: false, canUpgrade: false, owners: [] });
});

test("paywall_hit for the Free plan's one external channel: counted for the server whose limit it is and only for its own members, once a day; the span names the refusal whoever was stopped (#wg-rbac:#60)", async ({ app }) => {
  const paywall = capturePaywallHits(app);
  const spans = captureRefusalSpans(app);
  const rows = () => paywall.hits().map((hit) => ({ ...hit.properties, server: hit.serverId }));
  const FREE_LIMIT = { status: 409, errorCode: "free_external_limit" };

  // A free host whose one external channel a paid server has joined.
  const freeHost = await seedHost(app.baseUrl, { plan: "free" });
  const usedRoom = await freeHost.room();
  await convertToJoint(freeHost, usedRoom.id);
  const paidOwner = await person(app.baseUrl, "cx-hit-paid");
  const paid = await seedTarget(paidOwner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, paid.id));
  await expectStatus(await connect(app.baseUrl, paidOwner, (await seedInvite(freeHost, usedRoom.id, paidOwner.email)).token, paid.id), 200);
  const otherRoom = await freeHost.room();
  const asHost = (as: Person, path: string, body: unknown) => fetch(`${app.baseUrl}/api/channels/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json", "X-Server-Id": freeHost.server.id },
    body: JSON.stringify(body),
  });
  await paywall.expect(0, "nothing refused yet");
  spans.clear();

  // The host's own owner, stopped inviting to a second channel: the host's row.
  const emails = { emails: ["second@example.com"] };
  const refusedSend = await expectStatus(await asHost(freeHost.owner, `${otherRoom.id}/external-invites`, emails), 409, "free_external_limit") as Record<string, unknown>;
  assert.deepEqual({ side: refusedSend.limitSide, server: refusedSend.limitServerId }, { side: "host", server: freeHost.server.id });
  const hostOwnerHit = { gate: "external_channel_free_limit", actor: "person", plan: "free", viewer_role: "owner", limit_side: "host", server: freeHost.server.id };
  await paywall.expect(1, "the host owner's send");
  assert.deepEqual(rows(), [hostOwnerHit]);
  assert.deepEqual(await spans.expect(1, "the send's span"), [{ ...FREE_LIMIT, limitSide: "host" }]);

  // Again the same day, on the preview, the review before Create Channel and the send: still one row.
  await expectStatus(await asHost(freeHost.owner, `${otherRoom.id}/external-invites/preview`, emails), 409, "free_external_limit");
  await expectStatus(await asHost(freeHost.owner, "external-invites/preview", emails), 409, "free_external_limit");
  await expectStatus(await asHost(freeHost.owner, `${otherRoom.id}/external-invites`, emails), 409, "free_external_limit");
  await paywall.expect(1, "once per person, server, gate and day");
  // Another person of the host is their own row.
  await expectStatus(await asHost(freeHost.admin, `${otherRoom.id}/external-invites`, emails), 409, "free_external_limit");
  await paywall.expect(2, "the host admin's send");
  assert.deepEqual(rows(), [hostOwnerHit, { ...hostOwnerHit, viewer_role: "admin" }]);

  // An invitee the host's limit stops is not a member of the host: no row, for either server.
  spans.clear();
  await convertToJoint(freeHost, otherRoom.id);
  const outsiderOwner = await person(app.baseUrl, "cx-hit-outsider");
  const outsiderServer = await seedTarget(outsiderOwner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, outsiderServer.id));
  const refusedHost = await expectStatus(await connect(app.baseUrl, outsiderOwner, (await seedInvite(freeHost, otherRoom.id, outsiderOwner.email)).token, outsiderServer.id), 409, "free_external_limit") as Record<string, unknown>;
  assert.deepEqual({ side: refusedHost.limitSide, server: refusedHost.limitServerId }, { side: "host", server: freeHost.server.id });
  // The trace still says what refused, and whose side.
  assert.deepEqual(await spans.expect(1, "the invitee's span"), [{ ...FREE_LIMIT, limitSide: "host" }]);
  // A Guest the host's limit stops, likewise.
  const guestRoom = await freeHost.room();
  const guest = await person(app.baseUrl, "cx-hit-guest");
  await expectStatus(await acceptAsGuest(app.baseUrl, guest, (await seedInvite(freeHost, guestRoom.id, guest.email)).token), 409, "free_external_limit");
  assert.deepEqual(await spans.expect(2, "the Guest's span"), [{ ...FREE_LIMIT, limitSide: "host" }, { ...FREE_LIMIT, limitSide: "host" }]);
  await paywall.expect(2, "someone stopped by another server's limit records nothing");

  // The connecting side: the invitee owns a free server already in an external channel. Their server's row.
  const connector = await person(app.baseUrl, "cx-hit-connector");
  const requester = await person(app.baseUrl, "cx-hit-requester");
  const freeTarget = await seedTarget(connector, [[requester, "member"]]);
  const first = await seedHost(app.baseUrl, { plan: "pro" });
  const firstRoom = await first.room();
  await convertToJoint(first, firstRoom.id);
  await expectStatus(await connect(app.baseUrl, connector, (await seedInvite(first, firstRoom.id, connector.email)).token, freeTarget.id), 200);
  const second = await seedHost(app.baseUrl, { plan: "pro" });
  const secondRoom = await second.room();
  await convertToJoint(second, secondRoom.id);
  spans.clear();
  const refusedConnect = await expectStatus(await connect(app.baseUrl, connector, (await seedInvite(second, secondRoom.id, connector.email)).token, freeTarget.id), 409, "free_external_limit") as Record<string, unknown>;
  assert.deepEqual({ side: refusedConnect.limitSide, server: refusedConnect.limitServerId }, { side: "connecting", server: freeTarget.id });
  await paywall.expect(3, "the connecting server's owner");
  const connectingHit = { gate: "external_channel_free_limit", actor: "person", plan: "free", viewer_role: "owner", limit_side: "connecting", server: freeTarget.id };
  assert.deepEqual(rows()[2], connectingHit);
  assert.deepEqual(await spans.expect(1, "the connect's span"), [{ ...FREE_LIMIT, limitSide: "connecting" }]);

  // The same person refused again the same day, as the approver of a member's request: no second row.
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, (await seedInvite(second, secondRoom.id, requester.email)).token, freeTarget.id, connector.id), 201) as { requestId?: string };
  await expectStatus(await call(app.baseUrl, connector, "POST", `server-connect-requests/${requestId}/approve`), 409, "free_external_limit");
  await paywall.expect(3, "the approver is the same person: once a day");

  // Only the two servers whose limit it was, each by its own members; never the other side's.
  assert.deepEqual([...new Set(rows().map((row) => row.server))].sort(), [freeHost.server.id, freeTarget.id].sort());
  // Nothing of the invite, the channel or the other server is a property.
  for (const row of rows()) assert.deepEqual(Object.keys(row).sort(), ["actor", "gate", "limit_side", "plan", "server", "viewer_role"]);
});

test("paywall_hit on the multi-connect and an ordinary joint accept: each refused server is its own members' row, whatever server the request named (#wg-rbac:#60)", async ({ app }) => {
  const owner = await person(app.baseUrl, "cx-hit-multi-owner");
  const free = await seedTarget(owner);
  const paid = await seedTarget(owner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, paid.id));
  const first = await seedHost(app.baseUrl, { plan: "pro" });
  const firstRoom = await first.room();
  await convertToJoint(first, firstRoom.id);
  await expectStatus(await connect(app.baseUrl, owner, (await seedInvite(first, firstRoom.id, owner.email)).token, free.id), 200);
  const second = await seedHost(app.baseUrl, { plan: "pro" });
  const secondRoom = await second.room();
  await convertToJoint(second, secondRoom.id);
  const paywall = capturePaywallHits(app);
  const freeHit = { properties: { gate: "external_channel_free_limit", actor: "person", plan: "free", viewer_role: "owner", limit_side: "connecting" }, serverId: free.id };
  const recorded = () => paywall.hits().map((hit) => ({ properties: hit.properties, serverId: hit.serverId }));

  // The invite page's multi-select: a 200 whose refused server is still a hit.
  const multi = await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${(await seedInvite(second, secondRoom.id, owner.email)).token}/connect-servers`, { servers: [{ serverId: free.id }] }), 200) as { servers?: Array<{ state: string; code?: string }> };
  assert.deepEqual(multi.servers?.map((server) => [server.state, server.code]), [["refused", "free_external_limit"]]);
  await paywall.expect(1, "the multi-connect's refused server");
  assert.deepEqual(recorded(), [freeHit]);

  // The ordinary joint accept, asked through the paid server: the row is the free server's, whose limit it is.
  const fresh = capturePaywallHits(app);
  const third = await seedHost(app.baseUrl, { plan: "pro" });
  const thirdRoom = await third.room();
  await convertToJoint(third, thirdRoom.id);
  const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, thirdRoom.id));
  const invite = await createJointChannelInvite({
    jointChannelId: projection!.jointChannelId, fromServerId: third.server.id, targetServerId: free.id, invitedUserId: owner.id, invitedByUserId: third.owner.id,
  });
  const batch = await fetch(`${app.baseUrl}/api/channels/joint-invites/accept-many`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "X-Server-Id": paid.id, "Content-Type": "application/json" }, body: JSON.stringify({ inviteIds: [invite.id] }),
  });
  await expectStatus(batch, 409, "free_external_limit");
  await fresh.expect(1, "the joint accept's refusal");
  assert.deepEqual(fresh.hits().map((hit) => ({ properties: hit.properties, serverId: hit.serverId })), [freeHit]);
});

test("an ordinary joint invite accept, single and batch: a free server already in an external channel is refused another (409, the connecting side); a paid one is not", async ({ app }) => {
  const owner = await person(app.baseUrl, "cx-accept-owner");
  const free = await seedTarget(owner);
  const paid = await seedTarget(owner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, paid.id));
  const first = await seedHost(app.baseUrl, { plan: "pro" });
  const firstRoom = await first.room();
  await convertToJoint(first, firstRoom.id);
  await expectStatus(await connect(app.baseUrl, owner, (await seedInvite(first, firstRoom.id, owner.email)).token, free.id), 200);

  const second = await seedHost(app.baseUrl, { plan: "pro" });
  const secondRoom = await second.room();
  await convertToJoint(second, secondRoom.id);
  const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, secondRoom.id));
  const inviteTo = (targetServerId: string) => createJointChannelInvite({
    jointChannelId: projection!.jointChannelId, fromServerId: second.server.id, targetServerId, invitedUserId: owner.id, invitedByUserId: second.owner.id,
  });
  const freeInvite = await inviteTo(free.id);
  const paidInvite = await inviteTo(paid.id);
  const acceptOne = (inviteId: string, serverId: string) => fetch(`${app.baseUrl}/api/channels/joint-invites/${inviteId}/accept`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "X-Server-Id": serverId },
  });
  const acceptMany = (inviteIds: string[]) => fetch(`${app.baseUrl}/api/channels/joint-invites/accept-many`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "X-Server-Id": paid.id, "Content-Type": "application/json" }, body: JSON.stringify({ inviteIds }),
  });
  const refusal = { code: "free_external_limit", limitSide: "connecting", limitServerId: free.id };
  const single = await expectStatus(await acceptOne(freeInvite.id, free.id), 409) as Record<string, unknown>;
  assert.deepEqual({ code: single.code, limitSide: single.limitSide, limitServerId: single.limitServerId }, refusal);
  const batch = await expectStatus(await acceptMany([freeInvite.id, paidInvite.id]), 409) as Record<string, unknown>;
  assert.deepEqual({ code: batch.code, limitSide: batch.limitSide, limitServerId: batch.limitServerId }, refusal);
  assert.equal(await projectionOn(secondRoom.id, free.id), null);
  assert.equal(await projectionOn(secondRoom.id, paid.id), null, "the batch rolled back as a whole");
  // On the second host: nothing audited by the refused accepts (the rolled-back batch included), then one event per server connected.
  const connectedAudits = async () => (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_connected")))
    .filter((row) => row.serverId === second.server.id)
    .map((row) => ({ mode: row.metadata.mode, channelId: row.metadata.channelId, connectedServerId: row.metadata.connectedServerId, actorId: row.actorId }));
  assert.deepEqual(await connectedAudits(), [], "a refused accept writes no channel.server_connected");
  await expectStatus(await acceptOne(paidInvite.id, paid.id), 200);
  assert.equal((await projectionOn(secondRoom.id, paid.id))?.status, "active");
  const audited = { mode: "joint_invite", channelId: secondRoom.id, actorId: owner.id };
  assert.deepEqual(await connectedAudits(), [{ ...audited, connectedServerId: paid.id }]);
  // The batch accept, of one more paid server: its own event.
  const alsoPaid = await seedTarget(owner);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, alsoPaid.id));
  await expectStatus(await acceptMany([(await inviteTo(alsoPaid.id)).id]), 200);
  assert.deepEqual((await connectedAudits()).sort((a, b) => String(a.connectedServerId).localeCompare(String(b.connectedServerId))),
    [{ ...audited, connectedServerId: paid.id }, { ...audited, connectedServerId: alsoPaid.id }].sort((a, b) => a.connectedServerId.localeCompare(b.connectedServerId)));
});

test("a host at its hosting limit refuses an invitee's connect, multi-connect and an approval with a neutral sentence: never its plan, nor the channel using its slot (#wg-rbac:#61)", async ({ app }) => {
  // A free host whose one hosting slot a joined joint already uses, and another private channel of it.
  const host = await seedHost(app.baseUrl, { plan: "free" });
  const usedRoom = await host.room();
  await convertToJoint(host, usedRoom.id);
  const firstOwner = await person(app.baseUrl, "cx-neutral-first");
  const firstServer = await seedTarget(firstOwner);
  await expectStatus(await connect(app.baseUrl, firstOwner, (await seedInvite(host, usedRoom.id, firstOwner.email)).token, firstServer.id), 200);
  const room = await host.room();

  type Refusal = { error?: string; code?: string; limitSide?: string; limitServerId?: string | null };
  const assertNeutral = (refusal: Refusal) => {
    assert.equal(refusal.code, "joint_channel_free_limit_reached");
    assert.equal(refusal.error, "This channel's server can't share another channel with people outside it right now. Ask the person who invited you.");
    assert.equal(/free|plan|upgrade|pro\b/i.test(refusal.error ?? ""), false, refusal.error);
    assert.equal(JSON.stringify(refusal).includes(usedRoom.name), false, JSON.stringify(refusal));
    assert.equal("blockingChannel" in refusal, false);
    assert.deepEqual({ side: refusal.limitSide, server: refusal.limitServerId }, { side: "host", server: host.server.id });
  };

  // The invitee connects a server they own.
  const invitee = await person(app.baseUrl, "cx-neutral-invitee");
  const target = await seedTarget(invitee);
  const invite = await seedInvite(host, room.id, invitee.email);
  assertNeutral(await expectStatus(await connect(app.baseUrl, invitee, invite.token, target.id), 409));
  assert.equal(await channelType(room.id), "private", "no conversion started");
  assert.equal((await inviteRow(invite.id)).status, "pending");

  // The same through the multi-connect: the server's own outcome.
  const multi = await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect-servers`, { servers: [{ serverId: target.id }] }), 200) as unknown as { servers: Array<Refusal & { state: string; status?: number }> };
  assert.deepEqual({ state: multi.servers[0]?.state, status: multi.servers[0]?.status }, { state: "refused", status: 409 });
  assertNeutral(multi.servers[0]!);

  // An approver on another server approves a member's request.
  const requester = await person(app.baseUrl, "cx-neutral-requester");
  const approver = await person(app.baseUrl, "cx-neutral-approver");
  const approved = await seedTarget(approver, [[requester, "member"]]);
  const { requestId } = await expectStatus(await requestApproval(app.baseUrl, requester, (await seedInvite(host, room.id, requester.email)).token, approved.id, approver.id), 201) as { requestId?: string };
  assertNeutral(await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestId}/approve`), 409));
});
