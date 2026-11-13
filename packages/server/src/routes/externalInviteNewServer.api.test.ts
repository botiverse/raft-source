import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, APPSUMO_PLAN_LIMITS, MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { appSumoLicenseBindings, appSumoLicenses, channelConversionJobs, channelExternalInvites, channelHumans, channels, featureFlagRules, featureFlags, jointChannelServers, serverMembers, servers } from "../db/schema";
import { parseAppSumoLicenseKey } from "../services/appSumoContracts";
import { createChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { connectNewServerWithInvite, ExternalConnectError, NewServerNotConnectedError } from "../services/externalInviteConnectService";
import { createServerAsOwner } from "../services/serverCreateService";
import { __setServerCreateRateLimitForTests } from "../services/serverCreateLimits";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { capturePaywallHits, captureRefusalSpans } from "../test/integration/paywallHits";

// An external invite's recipient creates a new server and connects it, P2a-5
// (#wg-rbac:#16): created as POST /api/servers creates one, connected as a
// direct connect, the invite ending as new_server; refusals the preflight sees
// and invites the caller cannot use create nothing.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const RETIRED_CONVERSION_FLAG_KEY = "channel_to_joint_conversion_v0";
const NEUTRAL = { error: "This invite link is not valid" };

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

async function seedHost(baseUrl: string, options: { plan?: "free" | "pro"; flag?: boolean } = {}) {
  const owner = await person(baseUrl, "ns-host-owner");
  const server = await createServer("New Server Host", `ns-host-${randomBytes(4).toString("hex")}`, owner.id);
  if (options.plan) await getDb().update(servers).set({ plan: options.plan }).where(eq(servers.id, server.id));
  if (options.flag !== false) await enableExternalChannelsFlag(server.id);
  const room = () => createChannel(server.id, `ns-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, room };
}

type Host = Awaited<ReturnType<typeof seedHost>>;

async function seedInvite(host: Host, channelId: string, email: string) {
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

function call(baseUrl: string, as: Person, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const slug = () => `ns-new-${randomBytes(4).toString("hex")}`;
const connectNew = (baseUrl: string, as: Person, token: string, body: unknown = { name: "My New Server", slug: slug() }) =>
  call(baseUrl, as, "POST", `external-invites/${token}/connect-new-server`, body);
const connect = (baseUrl: string, as: Person, token: string, serverId: string) => call(baseUrl, as, "POST", `external-invites/${token}/connect`, { serverId });
const page = async (baseUrl: string, as: Person, token: string) => {
  const response = await call(baseUrl, as, "GET", `external-invites/${token}`);
  assert.equal(response.status, 200);
  return (await response.json() as { options: { newServer: boolean } }).options.newServer;
};

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

const ownedServers = (userId: string) => getDb().select().from(servers).where(eq(servers.ownerId, userId));

async function projectionOn(hostChannelId: string, serverId: string) {
  const [host] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  if (!host) return null;
  const [row] = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, host.jointChannelId), eq(jointChannelServers.serverId, serverId)));
  return row ?? null;
}

async function isChannelMember(channelId: string, userId: string) {
  return (await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)))).length > 0;
}

async function channelTypeOf(id: string) {
  const [row] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, id));
  return row?.type;
}

async function convertToJoint(host: Host, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

/** The new server is an ordinary one the caller owns, created as POST /api/servers creates it. */
async function assertCreatedAsOwner(serverId: string, owner: Person, name: string) {
  const [server] = await getDb().select().from(servers).where(eq(servers.id, serverId));
  assert.deepEqual({ name: server?.name, ownerId: server?.ownerId, plan: server?.plan, kind: server?.kind }, { name, ownerId: owner.id, plan: "free", kind: "normal" });
  const [member] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, owner.id)));
  assert.equal(member?.role, "owner");
  const defaults = (await getDb().select({ name: channels.name }).from(channels).where(eq(channels.serverId, serverId))).map((row) => row.name);
  assert.ok(defaults.includes("all") && defaults.includes("onboarding-owner"), `default channels: ${defaults.join(", ")}`);
}

test("the person's server-create budget holds here too: 429, no server, the invite still pending", async ({ app }) => {
  __setServerCreateRateLimitForTests(1);
  try {
    const host = await seedHost(app.baseUrl);
    const invitee = await person(app.baseUrl, "ns-budget");
    const room = await host.room();
    await convertToJoint(host, room.id);
    const invite = await seedInvite(host, room.id, invitee.email);
    await expectStatus(await call(app.baseUrl, invitee, "POST", "servers", { name: "First", slug: slug() }), 200);

    const refused = await connectNew(app.baseUrl, invitee, invite.token);
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    await expectStatus(refused, 429, "server_create_rate_limited");
    assert.equal((await ownedServers(invitee.id)).length, 1);
    assert.equal((await inviteRow(invite.id)).status, "pending");
  } finally {
    __setServerCreateRateLimitForTests(null);
  }
});

test("a joint channel: 200 connected, the new server is the caller's, they are in its projection, the invite ends as new_server", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-joint");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  assert.equal(await page(app.baseUrl, invitee, invite.token), true);

  const body = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token, { name: "Joint Newco", slug: slug() }), 200) as { state: string; serverId: string; channelId: string };
  assert.equal(body.state, "connected");
  await assertCreatedAsOwner(body.serverId, invitee, "Joint Newco");
  const projection = await projectionOn(room.id, body.serverId);
  assert.equal(projection?.status, "active");
  assert.equal(projection?.localChannelId, body.channelId);
  assert.equal(await isChannelMember(body.channelId, invitee.id), true);
  const row = await inviteRow(invite.id);
  assert.deepEqual(
    { status: row.status, outcome: row.outcome, acceptedUserId: row.acceptedUserId, acceptedServerId: row.acceptedServerId },
    { status: "accepted", outcome: "new_server", acceptedUserId: invitee.id, acceptedServerId: body.serverId },
  );
  // Used: the link is the neutral 404 now, and nothing more is created.
  assert.deepEqual(await (await connectNew(app.baseUrl, invitee, invite.token)).json(), NEUTRAL);
  assert.equal((await ownedServers(invitee.id)).length, 1);
});

test("a private channel: 202 connecting with the new server's id; the worker converts and connects it, the invite ends as new_server", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-private");
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);

  const body = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token, { name: "Private Newco", slug: slug() }), 202) as { state: string; serverId: string };
  assert.equal(body.state, "connecting");
  await assertCreatedAsOwner(body.serverId, invitee, "Private Newco");
  const reserved = await inviteRow(invite.id);
  assert.deepEqual(
    { status: reserved.status, server: reserved.connectServerId, joiner: reserved.connectJoinerUserId, authorizer: reserved.connectAuthorizerUserId, outcome: reserved.connectOutcome },
    { status: "connecting", server: body.serverId, joiner: invitee.id, authorizer: invitee.id, outcome: "new_server" },
  );

  for (let pass = 0; pass < 30 && (await inviteRow(invite.id)).status === "connecting"; pass += 1) {
    await runChannelConversionWorkerPass();
  }
  const row = await inviteRow(invite.id);
  assert.deepEqual(
    { status: row.status, outcome: row.outcome, acceptedUserId: row.acceptedUserId, acceptedServerId: row.acceptedServerId },
    { status: "accepted", outcome: "new_server", acceptedUserId: invitee.id, acceptedServerId: body.serverId },
  );
  const projection = await projectionOn(room.id, body.serverId);
  assert.equal(projection?.status, "active");
  assert.equal(await isChannelMember(projection!.localChannelId, invitee.id), true);

  // An existing server connected through /connect on the same path still ends as server.
  const other = await person(app.baseUrl, "ns-private-existing");
  const existing = await createServer("Existing", slug(), other.id);
  const otherHost = await seedHost(app.baseUrl);
  const second = await seedInvite(otherHost, (await otherHost.room()).id, other.email);
  await expectStatus(await connect(app.baseUrl, other, second.token, existing.id), 202);
  assert.equal((await inviteRow(second.id)).connectOutcome, "server");
  for (let pass = 0; pass < 30 && (await inviteRow(second.id)).status === "connecting"; pass += 1) {
    await runChannelConversionWorkerPass();
  }
  assert.deepEqual({ status: (await inviteRow(second.id)).status, outcome: (await inviteRow(second.id)).outcome }, { status: "accepted", outcome: "server" });
});

test("refusals the preflight sees create no server, and the invite stays pending", async ({ app }) => {
  // Paid: the free plan is its own case below.
  const host = await seedHost(app.baseUrl, { plan: "pro" });
  const refused = async (label: string, as: Person, token: string, status: number, expected: string | typeof NEUTRAL) => {
    const response = await connectNew(app.baseUrl, as, token);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
    if (typeof expected === "string") assert.equal(body.code, expected, label);
    else assert.deepEqual(body, expected, label);
    assert.equal((await ownedServers(as.id)).length, 0, `${label}: no server created`);
  };

  const invitee = await person(app.baseUrl, "ns-refused");

  // A Guest bound to the channel no longer keeps a new server out (P3: the
  // host's external_channels_v1 is on; the Guest is carried into the joint).
  const withGuest = await host.room();
  await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser(`ns-bound-${randomBytes(4).toString("hex")}`)).id, channelId: withGuest.id });
  const guestInvite = await seedInvite(host, withGuest.id, invitee.email);
  assert.equal(await page(app.baseUrl, invitee, guestInvite.token), true);

  // Another invite of the channel connecting.
  const busy = await host.room();
  const connector = await person(app.baseUrl, "ns-connector");
  const connectorServer = await createServer("Connector", slug(), connector.id);
  const busyInvite = await seedInvite(host, busy.id, invitee.email);
  assert.equal(await page(app.baseUrl, invitee, busyInvite.token), true);
  await expectStatus(await connect(app.baseUrl, connector, (await seedInvite(host, busy.id, connector.email)).token, connectorServer.id), 202);
  assert.equal(await page(app.baseUrl, invitee, busyInvite.token), false);
  await refused("connect_in_progress", invitee, busyInvite.token, 409, "connect_in_progress");
  assert.equal((await inviteRow(busyInvite.id)).status, "pending");

  // The same channel once its conversion committed: no job under way, the other connection still is.
  const [connecting] = await getDb().select().from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, busy.id), eq(channelExternalInvites.status, "connecting")));
  assert.equal((await runChannelConversionJob(connecting!.connectConversionJobId!)).status, "done");
  assert.equal((await inviteRow(connecting!.id)).connectPhase, "connection");
  await refused("connect_in_progress (connection step)", invitee, busyInvite.token, 409, "connect_in_progress");

  // An admin's conversion of the channel under way, no invite connecting.
  const converting = await host.room();
  await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: converting.id, createdByUserId: host.owner.id });
  await refused("conversion under way", invitee, (await seedInvite(host, converting.id, invitee.email)).token, 409, "connect_in_progress");

  // An archived channel.
  const archived = await host.room();
  const archivedInvite = await seedInvite(host, archived.id, invitee.email);
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));
  await refused("channel_archived", invitee, archivedInvite.token, 409, "channel_archived");

  // Invites the caller cannot use: one neutral 404.
  const stranger = await person(app.baseUrl, "ns-stranger");
  const elsewhere = await seedInvite(host, (await host.room()).id, invitee.email);
  await refused("another address", stranger, elsewhere.token, 404, NEUTRAL);
  await refused("unknown token", invitee, randomBytes(32).toString("hex"), 404, NEUTRAL);
  const flagOff = await seedHost(app.baseUrl, { flag: false });
  const offInvite = await seedInvite(flagOff, (await flagOff.room()).id, invitee.email);
  await refused("flag off on the host", invitee, offInvite.token, 404, NEUTRAL);
  assert.equal((await call(app.baseUrl, invitee, "GET", `external-invites/${offInvite.token}`)).status, 404);
  // The flag turned off on a host that had it: the same.
  const turnedOff = await host.room();
  const turnedOffInvite = await seedInvite(host, turnedOff.id, invitee.email);
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  await refused("flag turned off", invitee, turnedOffInvite.token, 404, NEUTRAL);
  assert.equal((await inviteRow(turnedOffInvite.id)).status, "pending");
});

test("a private channel with external_channels_v1 on and no conversion flag: the conversion starts (#wg-rbac:#50)", async ({ app }) => {
  // The retired channel_to_joint_conversion_v0 row absent altogether, as after
  // its prod deletion: external_channels_v1 alone lets the invite convert.
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, RETIRED_CONVERSION_FLAG_KEY));
  await getDb().delete(featureFlags).where(eq(featureFlags.key, RETIRED_CONVERSION_FLAG_KEY));
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-no-conversion-flag");
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  const body = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 202) as { state: string; serverId: string };
  assert.equal(body.state, "connecting");
  assert.equal((await inviteRow(invite.id)).status, "connecting");
  const jobs = await getDb().select({ status: channelConversionJobs.status }).from(channelConversionJobs)
    .where(eq(channelConversionJobs.sourceChannelId, room.id));
  assert.equal(jobs.length, 1, "the reservation started the channel's conversion");
});

/** A joint channel of `host` with one other server (owned by a new person) connected through an external invite. */
async function jointWithOneParticipant(baseUrl: string, host: Host) {
  const room = await host.room();
  await convertToJoint(host, room.id);
  const first = await person(baseUrl, "ns-first-participant");
  const firstServer = await createServer("First Participant", slug(), first.id);
  await expectStatus(await connect(baseUrl, first, (await seedInvite(host, room.id, first.email)).token, firstServer.id), 200);
  return room;
}

/**
 * A joint whose host (`created_by_server_id`) has external channels off, so
 * the per-joint free-server cap still applies (#12580), with `participant`
 * (external channels on, free) connected: its projection is the channel the
 * participant's external invites name.
 */
async function flagOffJointWithParticipant(baseUrl: string, options: { hostPlan: "free" | "pro" }) {
  const jointHost = await seedHost(baseUrl, { plan: options.hostPlan, flag: false });
  const room = await jointHost.room();
  await convertToJoint(jointHost, room.id);
  const [hostProjection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
  const participant = await seedHost(baseUrl);
  const [local] = await getDb().insert(channels).values({ serverId: participant.server.id, name: room.name, type: "joint" }).returning();
  await getDb().insert(jointChannelServers).values({ jointChannelId: hostProjection!.jointChannelId, serverId: participant.server.id, localChannelId: local!.id });
  return { jointHost, participant, local: local! };
}

test("no per-joint free-server cap when the joint's host has external channels on: a third free server is created and connected", async ({ app }) => {
  // #12580: external channels on for the joint's host replaces the 2-free-server
  // cap; a new free server is in no other external channel, so it connects.
  const host = await seedHost(app.baseUrl);
  const room = await jointWithOneParticipant(app.baseUrl, host);
  const invitee = await person(app.baseUrl, "ns-free-cap");
  const invite = await seedInvite(host, room.id, invitee.email);
  const body = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 200) as { state: string; serverId: string };
  assert.equal(body.state, "connected");
  assert.equal((await projectionOn(room.id, body.serverId))?.status, "active");
  assert.equal((await inviteRow(invite.id)).status, "accepted");
});

test("a joint at its free-server cap (its host has external channels off; a free host and a free participant): joint_free_server_limit before creating", async ({ app }) => {
  const { participant, local } = await flagOffJointWithParticipant(app.baseUrl, { hostPlan: "free" });
  const invitee = await person(app.baseUrl, "ns-free-cap");
  const invite = await seedInvite(participant, local.id, invitee.email);
  const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 409, "joint_free_server_limit");
  // The new server's side (adding a free server), which does not exist yet.
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "connecting", server: null });
  assert.equal((await ownedServers(invitee.id)).length, 0);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("a joint's free-server cap on the invite routes is a paywall hit (joint_channel_free_cap) for the connecting server's own member; not for a server that does not exist yet (#wg-rbac:#60)", async ({ app }) => {
  const { jointHost, participant, local } = await flagOffJointWithParticipant(app.baseUrl, { hostPlan: "free" });
  const paywall = capturePaywallHits(app);
  const spans = captureRefusalSpans(app);
  const CAP = { status: 409, errorCode: "joint_free_server_limit", limitSide: "connecting" };

  // Before any server is created the refusal names no server: nothing to count it for.
  const newcomer = await person(app.baseUrl, "ns-cap-newcomer");
  await expectStatus(await connectNew(app.baseUrl, newcomer, (await seedInvite(participant, local.id, newcomer.email)).token), 409, "joint_free_server_limit");
  assert.deepEqual(await spans.expect(1, "the preflight's span"), [CAP]);
  await paywall.expect(0, "no server, no row");

  // A free server the invitee owns: its row, without limit_side (that gate has none).
  const invitee = await person(app.baseUrl, "ns-cap-owner");
  const own = await createServer("Own", slug(), invitee.id);
  const refused = await expectStatus(await connect(app.baseUrl, invitee, (await seedInvite(participant, local.id, invitee.email)).token, own.id), 409, "joint_free_server_limit");
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "connecting", server: own.id });
  await paywall.expect(1, "the connecting server's owner");
  assert.deepEqual(paywall.hits().map((hit) => ({ properties: hit.properties, serverId: hit.serverId })), [
    { properties: { gate: "joint_channel_free_cap", actor: "person", plan: "free", viewer_role: "owner" }, serverId: own.id },
  ]);
  assert.deepEqual(await spans.expect(2, "the connect's span"), [CAP, CAP]);
  assert.ok(![jointHost.server.id, participant.server.id].includes(String(paywall.hits()[0]!.serverId)), "never the other side's server");
});

test("a joint already at its total server cap: joint_server_limit before creating", async ({ app }) => {
  const host = await seedHost(app.baseUrl, { plan: "pro" });
  const room = await host.room();
  await convertToJoint(host, room.id);
  const [hostProjection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
  // Paid participants up to the cap, the host included (the free-server cap stays out of it).
  for (let n = 1; n < MAX_JOINT_CHANNEL_SERVERS; n += 1) {
    const [server] = await getDb().insert(servers).values({ name: `Cap ${n}`, slug: slug(), ownerId: host.owner.id, plan: "pro" }).returning();
    const [local] = await getDb().insert(channels).values({ serverId: server!.id, name: room.name, type: "private" }).returning();
    await getDb().insert(jointChannelServers).values({ jointChannelId: hostProjection!.jointChannelId, serverId: server!.id, localChannelId: local!.id });
  }
  const invitee = await person(app.baseUrl, "ns-total-cap");
  const invite = await seedInvite(host, room.id, invitee.email);
  const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 409, "joint_server_limit");
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "host", server: host.server.id });
  assert.equal((await ownedServers(invitee.id)).length, 0);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("an AppSumo host at its hosted-joint limit, on a joint no other server has joined: joint_channel_plan_limit_reached before creating", async ({ app }) => {
  // AppSumo reads as paid for the external-channel rule, so only the joint
  // accept's hosting-slot check (the first other server) refuses here.
  const host = await seedHost(app.baseUrl);
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await getDb().insert(appSumoLicenses).values({ productId: "fixture", licenseKey: key, tier: 1, status: "active", verifiedAt: new Date() });
  await getDb().insert(appSumoLicenseBindings).values({ serverId: host.server.id, productId: "fixture", originalLicenseKey: key, currentLicenseKey: key, boundByUserId: host.owner.id });
  const rooms = [await host.room(), await host.room(), await host.room()];
  for (const room of rooms) await convertToJoint(host, room.id);
  for (const room of rooms.slice(0, APPSUMO_PLAN_LIMITS[1].maxHostedJointChannels)) {
    const other = await person(app.baseUrl, "ns-appsumo-other");
    const otherServer = await createServer("Other", slug(), other.id);
    await expectStatus(await connect(app.baseUrl, other, (await seedInvite(host, room.id, other.email)).token, otherServer.id), 200);
  }
  const invitee = await person(app.baseUrl, "ns-appsumo");
  const invite = await seedInvite(host, rooms[2]!.id, invitee.email);
  const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 409, "joint_channel_plan_limit_reached");
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "host", server: host.server.id });
  assert.equal((await ownedServers(invitee.id)).length, 0);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("a limit the preflight could not see, after creating: the refusal names the server the caller keeps", async ({ app }) => {
  // A paid joint host with external channels off (the free-server cap applies,
  // #12580) and a free participant: a new free server fits (two free servers).
  const { jointHost: host, participant, local } = await flagOffJointWithParticipant(app.baseUrl, { hostPlan: "pro" });
  const db = getDb();
  // Creating "Downgrade" turns the host free after the preflight: three free servers then.
  await db.execute(sql.raw(`CREATE FUNCTION ns_test_downgrade() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE servers SET plan = 'free' WHERE id = '${host.server.id}'; RETURN NEW; END $$`));
  await db.execute(sql.raw("CREATE TRIGGER ns_test_downgrade AFTER INSERT ON servers FOR EACH ROW WHEN (NEW.name = 'Downgrade') EXECUTE FUNCTION ns_test_downgrade()"));
  try {
    const invitee = await person(app.baseUrl, "ns-after-limit");
    const invite = await seedInvite(participant, local.id, invitee.email);
    const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token, { name: "Downgrade", slug: slug() }), 409, "joint_free_server_limit");
    const [kept] = await ownedServers(invitee.id);
    assert.ok(kept);
    assert.equal(refused.serverId, kept.id);
    // The new server's own side now that it exists: upgrading it would let it in.
    assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "connecting", server: kept.id });
    assert.equal(await projectionOn(local.id, kept.id), null);
    assert.equal((await inviteRow(invite.id)).status, "pending");
  } finally {
    await db.execute(sql.raw("DROP TRIGGER ns_test_downgrade ON servers"));
    await db.execute(sql.raw("DROP FUNCTION ns_test_downgrade()"));
  }
});

test("an unexpected error after creating (the privacy revalidation times out): the 500 names the server too (Cody)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-after-500");
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  const previous: unknown = app.app.get("slackBridgePrivacyRevalidator");
  app.app.set("slackBridgePrivacyRevalidator", async () => { throw new Error("injected privacy transport timeout"); });
  try {
    const failed = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token, { name: "Timeout Newco", slug: slug() }), 500);
    const [kept] = await ownedServers(invitee.id);
    assert.ok(kept);
    assert.equal(failed.serverId, kept.id);
    assert.equal(failed.error, "Failed to create and connect a server");
    assert.equal(JSON.stringify(failed).includes("injected"), false, "no internal error detail");
    assert.equal((await inviteRow(invite.id)).status, "pending");
    assert.equal(await channelTypeOf(room.id), "private");
  } finally {
    app.app.set("slackBridgePrivacyRevalidator", previous);
  }
});

test("a free host already in an external channel: refused before creating", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const external = await host.room();
  await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser(`ns-free-guest-${randomBytes(4).toString("hex")}`)).id, channelId: external.id });
  const invitee = await person(app.baseUrl, "ns-free");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 409, "free_external_limit");
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "host", server: host.server.id });
  assert.equal((await ownedServers(invitee.id)).length, 0);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("server-create validation answers as POST /api/servers and creates nothing", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-validation");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const taken = await createServer("Taken", slug(), (await seedUser(`ns-taken-${randomBytes(4).toString("hex")}`)).id);

  const cases: Array<[string, unknown, number]> = [
    ["empty name", { name: "", slug: slug() }, 400],
    ["no slug", { name: "Newco" }, 400],
    ["bad slug", { name: "Newco", slug: "9-Bad Slug" }, 400],
    ["slug taken", { name: "Newco", slug: taken.slug }, 409],
  ];
  for (const [label, body, status] of cases) {
    const viaInvite = await connectNew(app.baseUrl, invitee, invite.token, body);
    const viaServers = await call(app.baseUrl, invitee, "POST", "servers", body);
    assert.equal(viaInvite.status, status, label);
    assert.deepEqual(await viaInvite.json(), await viaServers.json(), `${label}: the same answer as POST /api/servers`);
    assert.equal(viaServers.status, status, label);
  }
  assert.equal((await ownedServers(invitee.id)).length, 0);
  assert.equal((await inviteRow(invite.id)).status, "pending");
  // POST /api/servers itself still creates (the create both share).
  const created = await expectStatus(await call(app.baseUrl, invitee, "POST", "servers", { name: "Plain", slug: slug() }), 200) as { id: string };
  await assertCreatedAsOwner(created.id, invitee, "Plain");
});

test("options.newServer: only on a pending invite whose channel nothing is connecting to and no Guest is bound to", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-options");
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  assert.equal(await page(app.baseUrl, invitee, invite.token), true);
  await getDb().update(channelExternalInvites).set({ status: "awaiting_approval" }).where(eq(channelExternalInvites.id, invite.id));
  assert.equal(await page(app.baseUrl, invitee, invite.token), false);
  await getDb().update(channelExternalInvites).set({ status: "pending" }).where(eq(channelExternalInvites.id, invite.id));
  // Also the invitee's own connection under way.
  const own = await createServer("Own", slug(), invitee.id);
  await expectStatus(await connect(app.baseUrl, invitee, invite.token, own.id), 202);
  assert.equal(await page(app.baseUrl, invitee, invite.token), false);
});

test("a refusal after creating (a race the preflight cannot see): the caller keeps the new server, named in the error", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "ns-race");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const name = "Race Newco";

  const err = await connectNewServerWithInvite(invite.token, invitee.id, async () => {
    const server = await createServerAsOwner({ name, slug: slug() }, invitee.id);
    // The channel is archived right after the preflight and the creation.
    await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, room.id));
    return server;
  }).then(() => null, (error: unknown) => error);
  assert.ok(err instanceof NewServerNotConnectedError, String(err));
  assert.ok(err.cause instanceof ExternalConnectError && err.cause.code === "channel_archived", String(err.cause));
  await assertCreatedAsOwner(err.serverId, invitee, name);
  assert.equal(await projectionOn(room.id, err.serverId), null);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

test("a host at its hosting limit, a private channel: connect-new-server is refused before creating, with a neutral sentence (no plan, no limit, no other channel; #wg-rbac:#61)", async ({ app }) => {
  const NEUTRAL_LIMIT = "This channel's server can't share another channel with people outside it right now. Ask the person who invited you.";
  const fill = async (host: Host, roomId: string) => {
    await convertToJoint(host, roomId);
    const other = await person(app.baseUrl, "ns-neutral-other");
    const otherServer = await createServer("Other", slug(), other.id);
    await expectStatus(await connect(app.baseUrl, other, (await seedInvite(host, roomId, other.email)).token, otherServer.id), 200);
  };
  const refusedOn = async (host: Host, code: string, usedNames: string[]) => {
    const room = await host.room();
    const invitee = await person(app.baseUrl, "ns-neutral");
    const invite = await seedInvite(host, room.id, invitee.email);
    const refused = await expectStatus(await connectNew(app.baseUrl, invitee, invite.token), 409, code);
    assert.equal(refused.error, NEUTRAL_LIMIT);
    for (const name of usedNames) assert.equal(JSON.stringify(refused).includes(name), false, JSON.stringify(refused));
    assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "host", server: host.server.id });
    assert.equal((await ownedServers(invitee.id)).length, 0, "nothing created");
    assert.equal((await inviteRow(invite.id)).status, "pending");
  };

  // A free host: its one slot used.
  const free = await seedHost(app.baseUrl, { plan: "free" });
  const used = await free.room();
  await fill(free, used.id);
  await refusedOn(free, "joint_channel_free_limit_reached", [used.name]);

  // An AppSumo host: its tier's slots used. The sentence does not tell the limit either.
  const appsumo = await seedHost(app.baseUrl);
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await getDb().insert(appSumoLicenses).values({ productId: "fixture", licenseKey: key, tier: 1, status: "active", verifiedAt: new Date() });
  await getDb().insert(appSumoLicenseBindings).values({ serverId: appsumo.server.id, productId: "fixture", originalLicenseKey: key, currentLicenseKey: key, boundByUserId: appsumo.owner.id });
  const names: string[] = [];
  for (let n = 0; n < APPSUMO_PLAN_LIMITS[1].maxHostedJointChannels; n += 1) {
    const room = await appsumo.room();
    names.push(room.name);
    await fill(appsumo, room.id);
  }
  await refusedOn(appsumo, "joint_channel_plan_limit_reached", names);
});
