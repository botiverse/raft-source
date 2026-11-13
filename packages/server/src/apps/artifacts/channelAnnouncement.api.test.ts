// Channel announcements (#proj-chat:#29, flag channel_announcement_v0), over
// HTTP with real agent credentials and web sessions: a channel's
// announcement is one Artifact homed in it. Proves the flag (off: no
// `announcement` field anywhere, setting refused with a reason), who may set
// it (editChannelMetadata: a channel admin, a server owner or admin; a plain
// member and an agent of another channel are refused, told who may), that the
// Artifact must live in that channel, removing it, the `raft channel info`
// line from the agent inventory, a stale id reading as none, clearing on
// delete and move, a joint's sides seeing the same one, and the queued notice
// to the channel's other agents when the announcement gets a new version; and
// a person's view of it: who made the current version and its note, seen by
// the Artifact's own read state; it can't be hidden.
// Lives beside the Artifacts app because it seeds and pushes Artifacts
// (core tests do not import the app).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY,
  CHANNEL_ANNOUNCEMENT_NOTICE_KIND,
  asServerId,
  formatAgentChannelInfo,
  type AgentChannelInfo,
  type ArtifactAgentAppEvent,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels, featureFlagRules, inboxNotificationFacts, inboxTargetMuteStates, messages, serverAgentMembers, thirdPartyAgentEvents } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import { tokenForHuman } from "../../test/integration/credentials";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { channelAnnouncementAudience, channelAnnouncementPushRefusal } from "../../platform/channelAnnouncements";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests } from "./blobStore";
import { deleteArtifact, widenArtifactHome } from "./manage";
import { artifactItems, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "channel-announcement-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

const allow = (flagKey: string, serverIds: string[]) =>
  getDb().insert(featureFlagRules).values({ flagKey, stage: "server", priority: 0, decision: "allow", values: serverIds });
const channelAnnouncementsOff = () => getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY));

/** A published Artifact (one version, current), as a push leaves it. */
async function artifact(input: { serverId: ServerId; authorAgentId: string; homeChannelId: string; title?: string }) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    title: input.title ?? `Rules ${label()}`,
    homeKind: "conversation",
    homeChannelId: input.homeChannelId,
    originalHomeChannelId: input.homeChannelId,
    createdByType: "agent",
    createdById: input.authorAgentId,
  });
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
    status: "published", publisherType: "agent", publisherId: input.authorAgentId, position: 1,
  });
  const [item] = await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id)).returning();
  return item!;
}

/**
 * A server with Artifacts and announcements on (unless `announcements:
 * false`): its owner and a member (people), #ops (public) where chanAdmin
 * (its channel admin), member and publisher are agents and both people are
 * in, #other (public) with outsider, and admin, an agent with the server
 * admin role in no channel.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { announcements?: boolean } = {}) {
  const owner = await seed.human();
  const person = await seed.human();
  const server = await seed.server({ owner, members: [person] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  if (opts.announcements !== false) await allow(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, [server.id]);
  const make = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const chanAdmin = await make("ca-chanadmin");
  const member = await make("ca-member");
  const publisher = await make("ca-publisher");
  const outsider = await make("ca-outsider");
  const admin = await make("ca-admin");
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, admin.id)));
  const ops = await createChannel(server.id, `ops-${label()}`, "operations");
  const other = await createChannel(server.id, `other-${label()}`);
  for (const human of [owner, person]) await addHuman(ops.id, human.id);
  await addAgent(ops.id, chanAdmin.id, { role: "admin" });
  for (const agent of [member, publisher]) await addAgent(ops.id, agent.id);
  await addAgent(other.id, outsider.id);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send", "channels"], name: `ca-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  __setArtifactR2StoreForTests({ read: async () => null, presign: async () => null, put: async () => {}, delete: async () => {} });
  return {
    owner, person, server, serverId, ops, other, chanAdmin, member, publisher, outsider, admin,
    keys: { chanAdmin: await key(chanAdmin.id), member: await key(member.id), publisher: await key(publisher.id), outsider: await key(outsider.id), admin: await key(admin.id) },
    tokens: { owner: await tokenForHuman(owner.email), person: await tokenForHuman(person.email) },
    /** A fresh Artifact by the publisher, in #ops unless another home is given. */
    make: (input: { homeChannelId?: string; title?: string } = {}) => artifact({ serverId, authorAgentId: publisher.id, homeChannelId: input.homeChannelId ?? ops.id, title: input.title }),
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;
type App = { baseUrl: string };
type Reply = { status: number; body: any };

async function agentCall(app: App, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function webCall(app: App, world: World, method: string, path: string, token: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": world.server.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const setChannelAnnouncement = (app: App, apiKey: string, channelId: string, announcement: string | null) =>
  agentCall(app, "PATCH", `/channels/${channelId}`, apiKey, { announcement });
/** The channel's entry in the agent's server inventory (what `raft channel info` prints). */
const inventoryEntry = async (app: App, apiKey: string, channelId: string): Promise<AgentChannelInfo & Record<string, unknown>> => {
  const info = await agentCall(app, "GET", "/server", apiKey);
  assert.equal(info.status, 200, JSON.stringify(info.body));
  return info.body.channels.find((channel: { id: string }) => channel.id === channelId);
};
const storedOf = async (channelId: string) =>
  (await getDb().select({ id: channels.announcementArtifactId }).from(channels).where(eq(channels.id, channelId)))[0]?.id ?? null;

test("flag off: no announcement field in the inventory or the web channel, and setting one is refused with a reason", async ({ app, seed }) => {
  const world = await seedWorld(seed, { announcements: false });
  const item = await world.make();

  const entry = await inventoryEntry(app, world.keys.chanAdmin, world.ops.id);
  assert.ok(!("announcement" in entry), "no field while off");
  assert.ok(!("announcementArtifactId" in entry), "the stored id never reaches agents");
  assert.ok(!formatAgentChannelInfo(entry).includes("Announcement:"), "raft channel info prints no line");
  const web = await webCall(app, world, "GET", `/channels/${world.ops.id}`, world.tokens.owner);
  assert.equal(web.status, 200);
  assert.ok(!("announcement" in web.body));

  const refused = await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, item.id);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "channel_announcement_disabled");
  assert.match(refused.body.error, /not turned on/);
  assert.match(refused.body.suggestedNextAction, new RegExp(`message in #${world.ops.name}`));
  const webRefused = await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { announcement: item.id });
  assert.equal(webRefused.status, 403);
  assert.equal(webRefused.body.code, "channel_announcement_disabled");
  assert.equal(await storedOf(world.ops.id), null);

  // Once on, a stored announcement shows again (nothing is dropped while off).
  await allow(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, [world.server.id]);
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, item.id)).status, 200);
  await channelAnnouncementsOff();
  assert.ok(!("announcement" in await inventoryEntry(app, world.keys.member, world.ops.id)));
  assert.equal(await storedOf(world.ops.id), item.id);
});

test("the channel admin, a server admin agent and the server owner may set it; the answer, the inventory and the web channel carry it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const first = await world.make({ title: "Ops rules" });
  const second = await world.make({ title: "Ops links" });

  // No announcement yet: null, not absent.
  assert.equal((await inventoryEntry(app, world.keys.member, world.ops.id)).announcement, null);

  const byChanAdmin = await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, first.id);
  assert.equal(byChanAdmin.status, 200, JSON.stringify(byChanAdmin.body));
  assert.deepEqual(
    { ...byChanAdmin.body.announcement, updatedAt: typeof byChanAdmin.body.announcement.updatedAt },
    { artifactId: first.id, title: "Ops rules", version: 1, updatedAt: "string" },
  );
  assert.ok(!("announcementArtifactId" in byChanAdmin.body));
  assert.equal(await storedOf(world.ops.id), first.id);

  // A server admin agent outside the channel replaces it (one per channel).
  const byAdmin = await setChannelAnnouncement(app, world.keys.admin, world.ops.id, second.id);
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
  assert.equal(byAdmin.body.announcement.artifactId, second.id);

  // The server owner, on the web.
  const byOwner = await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { announcement: first.id });
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.equal(byOwner.body.announcement.artifactId, first.id);
  const read = await webCall(app, world, "GET", `/channels/${world.ops.id}`, world.tokens.person);
  assert.equal(read.body.announcement.artifactId, first.id);
  assert.equal(read.body.announcement.title, "Ops rules");

  // Any member's `raft channel info` shows the line.
  const entry = await inventoryEntry(app, world.keys.member, world.ops.id);
  assert.equal(entry.announcement?.artifactId, first.id);
  const text = formatAgentChannelInfo(entry);
  const line = text.split("\n").find((l) => l.startsWith("Announcement:"));
  assert.match(line ?? "", new RegExp(`^Announcement: "Ops rules" \\(${first.id}, v1, updated \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\dZ\\) — read: raft artifact read ${first.id}$`));
});

test("a plain member, an agent of another channel and a plain person are refused and told who may; nothing changes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make();
  for (const apiKey of [world.keys.member, world.keys.outsider]) {
    const refused = await setChannelAnnouncement(app, apiKey, world.ops.id, item.id);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "channel_announcement_forbidden");
    assert.match(refused.body.error, new RegExp(`Only the owner of #${world.ops.name} \\(one of its channel admins\\) or a server owner or admin`));
    assert.ok(refused.body.suggestedNextAction.length > 0);
  }
  const removeRefused = await setChannelAnnouncement(app, world.keys.member, world.ops.id, null);
  assert.equal(removeRefused.body.code, "channel_announcement_forbidden", "removing needs the same");
  const person = await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.person, { announcement: item.id });
  assert.equal(person.status, 403);
  assert.equal(person.body.code, "channel_announcement_forbidden");
  assert.equal(await storedOf(world.ops.id), null);
});

test("the Artifact must live in that channel: another channel's or the whole server's is refused, an unknown id is not found, a DM has none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const elsewhere = await world.make({ homeChannelId: world.other.id });
  const refused = await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, elsewhere.id);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "channel_announcement_not_in_channel");
  assert.match(refused.body.error, new RegExp(`not homed in #${world.ops.name}`));
  assert.match(refused.body.suggestedNextAction, /raft artifact push <dir> --target .* --announcement/);

  const moved = await world.make();
  await widenArtifactHome({ type: "user", id: world.owner.id, serverId: world.serverId }, moved.id, "server");
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, moved.id)).body.code, "channel_announcement_not_in_channel");

  const unknown = await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, `pt_${randomUUID()}`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "channel_announcement_artifact_not_found");

  const dm = await findOrCreateDM(world.server.id, world.owner.id, world.chanAdmin.id);
  const inDm = await setChannelAnnouncement(app, world.keys.chanAdmin, dm!.id, elsewhere.id);
  assert.equal(inDm.status, 400, JSON.stringify(inDm.body));
  assert.equal(inDm.body.code, "channel_announcement_unsupported_channel");
  assert.equal(await storedOf(world.ops.id), null);
});

test("removing it, and an Artifact deleted, moved out or whose stored id went stale: the channel has none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const actor = { type: "user" as const, id: world.owner.id, serverId: world.serverId };

  const kept = await world.make();
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, kept.id)).status, 200);
  const removed = await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, null);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.announcement, null);
  assert.equal(await storedOf(world.ops.id), null);
  assert.ok((await getDb().select().from(artifactItems).where(eq(artifactItems.id, kept.id)))[0]!.deletedAt === null, "the Artifact stays");

  // Deleted: cleared in the delete's transaction.
  const deleted = await world.make();
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, deleted.id)).status, 200);
  assert.equal((await deleteArtifact(actor, deleted.id)).kind, "deleted");
  assert.equal(await storedOf(world.ops.id), null);

  // Moved to the whole server: cleared with the move.
  const moved = await world.make();
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, moved.id)).status, 200);
  assert.equal((await widenArtifactHome(actor, moved.id, "server")).kind, "moved");
  assert.equal(await storedOf(world.ops.id), null);

  // A stored id whose Artifact is gone some other way (taken down) reads as none.
  const stale = await world.make();
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, stale.id)).status, 200);
  await getDb().update(artifactItems).set({ revokedAt: new Date() }).where(eq(artifactItems.id, stale.id));
  assert.equal((await inventoryEntry(app, world.keys.member, world.ops.id)).announcement, null);
  assert.equal((await webCall(app, world, "GET", `/channels/${world.ops.id}`, world.tokens.person)).body.announcement, null);
});

test("a joint channel: set on one side, both sides see the same announcement", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  await allow(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, [peer.id]);
  const joint = await seedJointChannel({ name: `ca-joint-${label()}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.admin.id);
  await addAgent(hostProjection.id, world.publisher.id);
  const peerAgent = await createAgent(peer.id, `ca-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  await addAgent(peerProjection.id, peerAgent.id);
  const peerKey = (await mintAgentCredential({ agentId: peerAgent.id, scopes: ["read", "send", "channels"], name: `ca-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  // Homed on the joint's canonical channel, as a push into the joint leaves it.
  const item = await world.make({ homeChannelId: joint.canonical.id, title: "Joint rules" });

  const set = await setChannelAnnouncement(app, world.keys.admin, hostProjection.id, item.id);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.announcement.artifactId, item.id);
  assert.equal(await storedOf(hostProjection.id), item.id);
  assert.equal(await storedOf(peerProjection.id), item.id, "every projection carries it");
  const peerEntry = await inventoryEntry(app, peerKey, peerProjection.id);
  assert.equal(peerEntry.announcement?.artifactId, item.id);
  assert.equal(peerEntry.announcement?.title, "Joint rules");
});

test("a joint has an announcement only while every server sharing it has announcements on: with one side off it can't be set, reads as none on both sides, binds no push, tells no agent and posts no line", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const joint = await seedJointChannel({ name: `ca-joint-${label()}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.admin.id);
  await addAgent(hostProjection.id, world.publisher.id);
  const peerAgent = await createAgent(peer.id, `ca-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  await addAgent(peerProjection.id, peerAgent.id);
  const peerKey = (await mintAgentCredential({ agentId: peerAgent.id, scopes: ["read", "send", "channels"], name: `ca-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const item = await world.make({ homeChannelId: joint.canonical.id, title: "Joint rules" });
  const lines = async () => (await Promise.all([joint.canonical.id, hostProjection.id, peerProjection.id].map(announcementLines))).flat();
  const pushRefusalFor = (agent: { id: string }, serverId: string) =>
    channelAnnouncementPushRefusal(item.id, joint.canonical.id, { type: "agent", id: agent.id, serverId });
  const onlyHostOn = async () => {
    await channelAnnouncementsOff();
    await allow(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, [world.server.id]);
  };

  // The peer has announcements off: the host can't set one on the joint.
  const refused = await setChannelAnnouncement(app, world.keys.admin, hostProjection.id, item.id);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "channel_announcement_disabled");
  assert.equal(refused.body.error, `Channel announcements are not turned on for every server that shares #${hostProjection.name}, so nothing was changed.`);
  assert.deepEqual([await storedOf(hostProjection.id), await storedOf(peerProjection.id)], [null, null]);
  assert.equal((await lines()).length, 0);

  // On for both: set, one line, and the peer's plain member needs the right on its own copy to push.
  await allow(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, [peer.id]);
  assert.equal((await setChannelAnnouncement(app, world.keys.admin, hostProjection.id, item.id)).status, 200);
  assert.equal((await inventoryEntry(app, world.keys.admin, hostProjection.id)).announcement?.artifactId, item.id);
  assert.equal((await lines()).length, 1);
  assert.deepEqual(await pushRefusalFor(peerAgent, peer.id), { channel: `#${peerProjection.name}` });
  assert.ok((await channelAnnouncementAudience(item.id, joint.canonical.id)).some((entry) => entry.agentId === peerAgent.id));

  // The peer's flag goes off with the id still stored on both copies: the joint has no announcement.
  await onlyHostOn();
  assert.deepEqual([await storedOf(hostProjection.id), await storedOf(peerProjection.id)], [item.id, item.id]);
  assert.equal((await inventoryEntry(app, world.keys.admin, hostProjection.id)).announcement, null, "none on the side that has the flag on");
  assert.equal("announcement" in (await inventoryEntry(app, peerKey, peerProjection.id)), false, "no field on the side that has it off");
  assert.equal(await pushRefusalFor(peerAgent, peer.id), null, "the side with it off is not bound (L1)");
  assert.equal(await pushRefusalFor(world.publisher, world.server.id), null, "nor is anyone: it is no announcement now");
  assert.deepEqual(await channelAnnouncementAudience(item.id, joint.canonical.id), []);
  const another = await world.make({ homeChannelId: joint.canonical.id, title: "Other rules" });
  assert.equal((await setChannelAnnouncement(app, world.keys.admin, hostProjection.id, another.id)).body.code, "channel_announcement_disabled");

  // The host can still clear what is left; that posts no line carrying the title (L2).
  assert.equal((await setChannelAnnouncement(app, world.keys.admin, hostProjection.id, null)).status, 200);
  assert.deepEqual([await storedOf(hostProjection.id), await storedOf(peerProjection.id)], [null, null]);
  assert.equal((await lines()).length, 1, "no line for the removal");
});

test("a new version of the announcement tells the channel's other agents, queued (it wakes no one); its publisher is not told", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const push = (apiKey: string, body: unknown) => agentCall(app, "POST", "/artifacts/push", apiKey, body);
  const created = await push(world.keys.publisher, { target: `#${world.ops.name}`, title: "Ops rules", files: [{ path: "index.html", content: "<h1>rules v1</h1>" }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);

  const eventsTo = (agentId: string) => getDb().select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.artifacts")));
  // While it is the announcement, only who may set it pushes to it: the channel admin.
  const v2 = await push(world.keys.chanAdmin, { artifact: id, base: 1, note: "on-call rota added", files: [{ path: "index.html", content: "<h1>rules v2</h1>" }] });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));

  const events = await eventsTo(world.member.id);
  assert.equal(events.length, 1, "the member is told once");
  const appEvent = (events[0]!.payload as { app_event?: ArtifactAgentAppEvent }).app_event!;
  assert.equal(appEvent.reason, "subscribed");
  assert.deepEqual(appEvent.channelAnnouncement, { channel: `#${world.ops.name}`, publisher: { type: "agent", name: world.chanAdmin.name }, number: 2, note: "on-call rota added" });
  assert.equal(events[0]!.summary, `@${world.chanAdmin.name} updated the announcement of #${world.ops.name} ("Ops rules", now v2) — "on-call rota added". Read it before you next work there: raft artifact read ${id}. No reply is needed.`);
  assert.equal((await eventsTo(world.chanAdmin.id)).length, 0, "the version's publisher is not told");
  // v1's publisher follows it and last pushed index.html: told your_file_changed, not twice.
  const toV1Publisher = (await eventsTo(world.publisher.id)).map((event) => (event.payload as { app_event?: ArtifactAgentAppEvent }).app_event!);
  assert.deepEqual(toV1Publisher.map((event) => [event.reason, event.channelAnnouncement ?? null]), [["your_file_changed", null]]);
  assert.equal((await eventsTo(world.outsider.id)).length, 0, "an agent of another channel is not told");

  // Not the announcement any more: the next version tells no one.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, null)).status, 200);
  assert.equal((await push(world.keys.publisher, { artifact: id, base: 2, files: [{ path: "index.html", content: "<h1>rules v3</h1>" }] })).status, 201);
  assert.equal((await eventsTo(world.member.id)).length, 1);
  // With the flag off, neither.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);
  await channelAnnouncementsOff();
  assert.equal((await push(world.keys.publisher, { artifact: id, base: 3, files: [{ path: "index.html", content: "<h1>rules v4</h1>" }] })).status, 201);
  assert.equal((await eventsTo(world.member.id)).length, 1);
});

test("a person's announcement: who made the version and its note, seen once they open it; it can't be hidden (no hide route, no hide field)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const push = (body: unknown) => agentCall(app, "POST", "/artifacts/push", world.keys.publisher, body);
  const created = await push({ target: `#${world.ops.name}`, title: "Ops rules", note: "first rules", files: [{ path: "index.html", content: "<h1>v1</h1>" }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);
  const announcementFor = async (token: string) => (await webCall(app, world, "GET", `/channels/${world.ops.id}`, token)).body.announcement;

  const first = await announcementFor(world.tokens.person);
  assert.deepEqual(first.updatedBy, { type: "agent", id: world.publisher.id, name: world.publisher.name });
  assert.equal(first.note, "first rules");
  assert.equal(first.seen, false, "never opened");
  assert.ok(!("hiddenUntilVersion" in first), "a pin is a pin: nothing about hiding");
  // Agents get the plain announcement.
  assert.ok(!("seen" in (await inventoryEntry(app, world.keys.member, world.ops.id)).announcement!));

  // Opening the Artifact's current version (the web viewer) is what marks it seen: the Artifact's own read state.
  const opened = await webCall(app, world, "GET", `/artifacts/${id}`, world.tokens.person);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal((await announcementFor(world.tokens.person)).seen, true);
  assert.equal((await announcementFor(world.tokens.owner)).seen, false, "per reader");

  // A newer version: unseen again.
  assert.equal((await agentCall(app, "POST", "/artifacts/push", world.keys.chanAdmin, { artifact: id, base: 1, note: "rota added", files: [{ path: "index.html", content: "<h1>v2</h1>" }] })).status, 201);
  const second = await announcementFor(world.tokens.person);
  assert.equal(second.version, 2);
  assert.equal(second.note, "rota added");
  assert.equal(second.seen, false);

  // The hide routes are gone.
  for (const method of ["PUT", "DELETE"]) {
    const gone = await webCall(app, world, method, `/channels/${world.ops.id}/announcement/hide`, world.tokens.person, method === "PUT" ? {} : undefined);
    assert.equal(gone.status, 404, `${method} …/announcement/hide`);
  }
});

test("while it is the announcement, pushing to it needs the right to set it: a member who may push is refused until it is removed; the channel admin may", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const push = (apiKey: string, body: unknown) => agentCall(app, "POST", "/artifacts/push", apiKey, body);
  const created = await push(world.keys.publisher, { target: `#${world.ops.name}`, title: "Ops rules", files: [{ path: "index.html", content: "<h1>v1</h1>" }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  const versions = async () => (await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).length;
  // Not the announcement: the Artifact's own rule (an agent of the channel may push).
  assert.equal((await push(world.keys.member, { artifact: id, base: 1, files: [{ path: "index.html", content: "<h1>v2 by member</h1>" }] })).status, 201);
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);

  for (const [apiKey, base] of [[world.keys.member, 2], [world.keys.publisher, 2]] as const) {
    const refused = await push(apiKey, { artifact: id, base, files: [{ path: "index.html", content: "<h1>v3</h1>" }] });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN");
    assert.equal(refused.body.error, `This artifact is the announcement of #${world.ops.name}, so only its owner (one of its channel admins) or a server owner or admin can push a new version. Nothing was pushed.`);
    assert.equal(refused.body.suggestedNextAction, `Ask one of them to push it, or copy the folder and push the copy as a new artifact: raft artifact push <copy> --target "#${world.ops.name}" --title "<title>"`);
    assert.deepEqual(refused.body.details, { channel: `#${world.ops.name}`, title: "Ops rules" });
  }
  // A new title alone is a push too.
  assert.equal((await push(world.keys.member, { artifact: id, base: 2, title: "Renamed", files: [] })).body.code, "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN");
  assert.equal(await versions(), 2, "nothing was pushed");

  // The channel admin and a server admin may.
  assert.equal((await push(world.keys.chanAdmin, { artifact: id, base: 2, files: [{ path: "index.html", content: "<h1>v3 by admin</h1>" }] })).status, 201);
  assert.equal((await push(world.keys.admin, { artifact: id, base: 3, files: [{ path: "index.html", content: "<h1>v4 by server admin</h1>" }] })).status, 201);

  // Removed as the announcement: the member may push again.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, null)).status, 200);
  assert.equal((await push(world.keys.member, { artifact: id, base: 4, files: [{ path: "index.html", content: "<h1>v5 by member</h1>" }] })).status, 201);
  // With the flag off the Artifact's own rule applies too.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);
  await channelAnnouncementsOff();
  assert.equal((await push(world.keys.member, { artifact: id, base: 5, files: [{ path: "index.html", content: "<h1>v6 by member</h1>" }] })).status, 201);
});

test("while it is the announcement, a person's rename on the web needs the right to set it: a member is refused until it is removed; the owner may", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ title: "Ops rules" });
  const rename = (token: string, title: string) => webCall(app, world, "PATCH", `/artifacts/${item.id}/title`, token, { title });
  const titleOf = async () => (await getDb().select({ title: artifactItems.title }).from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!.title;
  // Not the announcement: a member of the server may rename it.
  assert.equal((await rename(world.tokens.person, "Ops rules, draft")).status, 200);
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, item.id)).status, 200);

  const refused = await rename(world.tokens.person, "Hijacked");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN");
  assert.equal(refused.body.error, `This artifact is the announcement of #${world.ops.name}, so only its channel admins or a server owner or admin can change it. Nothing was changed.`);
  assert.equal(refused.body.suggestedNextAction, "Ask a channel admin.");
  assert.deepEqual(refused.body.details, { channel: `#${world.ops.name}`, title: "Ops rules, draft" });
  assert.equal(await titleOf(), "Ops rules, draft", "nothing was changed");

  // The server owner may.
  assert.equal((await rename(world.tokens.owner, "Ops rules")).status, 200);
  assert.equal(await titleOf(), "Ops rules");

  // Removed as the announcement: the member may again.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, null)).status, 200);
  assert.equal((await rename(world.tokens.person, "Ops rules (old)")).status, 200);
  assert.equal(await titleOf(), "Ops rules (old)");
});

/** The channel's announcement event lines, oldest first. */
const announcementLines = (channelId: string) => getDb().select().from(messages)
  .where(and(eq(messages.channelId, channelId), eq(messages.systemSubtype, "channel.announcement")))
  .orderBy(asc(messages.seq));

test("setting, replacing and removing each post one event line naming who and which Artifact; the actor reads it, a muted member is not told", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const first = await world.make({ title: "Ops rules" });
  const second = await world.make({ title: "Ops links" });
  // The person muted #ops: the line follows the channel's mute like any event line.
  await getDb().insert(inboxTargetMuteStates).values({ receiverType: "user", receiverId: world.person.id, serverId: world.server.id, sourceChannelId: world.ops.id, activityMuted: true, muteFromSeq: 0 });

  // A person sets it on the web.
  assert.equal((await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { announcement: first.id })).status, 200);
  // An agent replaces it.
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, second.id)).status, 200);
  // A person removes it.
  assert.equal((await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { announcement: null })).status, 200);

  const lines = await announcementLines(world.ops.id);
  assert.deepEqual(lines.map((line) => line.content), [
    `@${world.owner.name} set the channel announcement: Ops rules`,
    `@${world.chanAdmin.name} replaced the channel announcement: Ops links`,
    `@${world.owner.name} removed the channel announcement: Ops links`,
  ]);
  assert.ok(lines.every((line) => line.messageType === "system" && line.senderId === "system"));
  assert.deepEqual(lines.map((line) => line.actionMetadata), [
    { kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND, change: "set", actor: { type: "user", id: world.owner.id, name: world.owner.displayName }, artifactId: first.id, title: "Ops rules" },
    { kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND, change: "replaced", actor: { type: "agent", id: world.chanAdmin.id, name: world.chanAdmin.displayName ?? world.chanAdmin.name }, artifactId: second.id, title: "Ops links" },
    { kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND, change: "removed", actor: { type: "user", id: world.owner.id, name: world.owner.displayName }, artifactId: second.id, title: "Ops links" },
  ]);
  assert.deepEqual(lines.map((line) => [line.causalActorType, line.causalActorId]), [
    ["user", world.owner.id], ["agent", world.chanAdmin.id], ["user", world.owner.id],
  ]);

  const factsOf = (userId: string) => getDb().select().from(inboxNotificationFacts)
    .where(and(eq(inboxNotificationFacts.receiverType, "user"), eq(inboxNotificationFacts.receiverId, userId), eq(inboxNotificationFacts.sourceChannelId, world.ops.id)));
  assert.equal((await factsOf(world.person.id)).length, 0, "muted: no activity, no alert");
  const ownerFacts = await factsOf(world.owner.id);
  const ownSet = ownerFacts.find((fact) => fact.messageId === lines[0]!.id);
  assert.ok(!ownSet || ownSet.unreadEligible === false, "the owner's own change is born read");
  assert.equal(ownerFacts.find((fact) => fact.messageId === lines[1]!.id)?.unreadEligible, true, "the agent's change is unread for the owner");
});

test("no event line when nothing changes which Artifact it is: set again, another field, or a new version of it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await agentCall(app, "POST", "/artifacts/push", world.keys.chanAdmin, { target: `#${world.ops.name}`, title: "Ops rules", files: [{ path: "index.md", content: "# Ops rules\n\nOn call: Ada." }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);
  assert.equal((await announcementLines(world.ops.id)).length, 1);

  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200, "set again");
  assert.equal((await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { announcement: id })).status, 200);
  assert.equal((await webCall(app, world, "PATCH", `/channels/${world.ops.id}`, world.tokens.owner, { description: "ops, now with rules" })).status, 200);
  assert.equal((await agentCall(app, "POST", "/artifacts/push", world.keys.chanAdmin, { artifact: id, base: 1, note: "rota", files: [{ path: "index.md", content: "# Ops rules\n\nOn call: Bea." }] })).status, 201);
  assert.equal((await announcementLines(world.ops.id)).length, 1, "only the first set posted");
});

test("the web reads the announcement on its own (GET /channels/:id/announcement), with the first line of a Markdown version as its excerpt", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const read = async (token: string) => webCall(app, world, "GET", `/channels/${world.ops.id}/announcement`, token);
  assert.deepEqual((await read(world.tokens.person)).body, { announcement: null }, "none yet");

  const created = await agentCall(app, "POST", "/artifacts/push", world.keys.chanAdmin, { target: `#${world.ops.name}`, title: "Ops rules", files: [{ path: "index.md", content: "# Ops rules\n\nCode freeze Thursday 18:00.\n\nEvery PR after that needs a sign-off." }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, id)).status, 200);

  const answer = await read(world.tokens.person);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.announcement.artifactId, id);
  assert.equal(answer.body.announcement.seen, false);
  assert.equal(answer.body.announcement.excerpt, "Code freeze Thursday 18:00.", "the first line, the heading that repeats the title left out");
  assert.equal((await webCall(app, world, "GET", `/channels/${world.ops.id}`, world.tokens.person)).body.announcement.excerpt, "Code freeze Thursday 18:00.");
  assert.ok(!("excerpt" in (await inventoryEntry(app, world.keys.member, world.ops.id)).announcement!), "agents get the plain announcement");

  // An HTML page has no excerpt.
  const page = await world.make({ title: "Ops page" });
  assert.equal((await setChannelAnnouncement(app, world.keys.chanAdmin, world.ops.id, page.id)).status, 200);
  assert.equal((await read(world.tokens.person)).body.announcement.excerpt, null);

  // Someone outside the server is refused. A private channel the person isn't in, or an unknown id: the same 404.
  const outsiderToken = await tokenForHuman((await seed.human()).email);
  assert.equal((await webCall(app, world, "GET", `/channels/${world.ops.id}/announcement`, outsiderToken)).status, 403);
  const secret = await createChannel(world.server.id, `secret-${label()}`, undefined, "private");
  await addHuman(secret.id, world.owner.id);
  const notVisible = await webCall(app, world, "GET", `/channels/${secret.id}/announcement`, world.tokens.person);
  assert.equal(notVisible.status, 404, JSON.stringify(notVisible.body));
  assert.equal(notVisible.body.code, "channel_not_found");
  assert.equal((await webCall(app, world, "GET", `/channels/${secret.id}/announcement`, world.tokens.owner)).status, 200, "a member reads it");
  const unknown = await webCall(app, world, "GET", `/channels/${randomUUID()}/announcement`, world.tokens.person);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "channel_not_found", "the same answer as not visible");
  await channelAnnouncementsOff();
  assert.deepEqual((await read(world.tokens.person)).body, { announcement: null });
});
