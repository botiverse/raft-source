// Moving an Artifact to a larger home (`POST /api/artifacts/:id/home`) and
// deleting it (`DELETE /api/artifacts/:id`), over HTTP with real user tokens
// at the paths the shared contract builds, and the service (manage.ts) for
// what the web route can't reach (an agent actor, an author who left).
// Proves the rule (Tenny, 2026-10-26): the author, the manager of a live
// agent author and the server's owners and admins, only through the
// Artifact's own server (never the other server of a joint conversation);
// widening also needs seeing it now and a non-guest (a guest deletes their
// own, never widens it), deleting doesn't;
// only ever to a larger home; public only by a person; the flag first; an
// audit row and an object event for each change; and a deleted Artifact gone
// from every read (viewer, files, comments, dashboard, search, summaries, the
// agent API's list and read). The viewer's capabilities follow the same rule.
// Making it public stores its current version's signed-out text
// (publicText.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import {
  ARTIFACT_HOME_CHANGE_MAX_COUNTED,
  SERVER_GUEST_FEATURE_FLAG_KEY,
  artifactWebPaths,
  asArtifactId,
  asChannelId,
  asServerId,
  objectWebPaths,
  webSearchPath,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, channels, featureFlagRules, objectEventRecipients, objectEvents, objectInboxStates, serverMembers } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, deleteChannel, getOrCreateThread } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createMessage } from "../../services/messageService";
import { addMember, removeMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, r2KeyOf } from "./blobStore";
import { recordArtifactEvent } from "./events";
import { deleteArtifact, homeChangeLimits, mayManageArtifact, narrowArtifactHome, previewNarrowing, unpublishArtifact, widenArtifactHome } from "./manage";
import { __settlePublicTextFillsForTests } from "./publicText";
import { artifactAudit, artifactBlobs, artifactItems, artifactPendingNotices, artifactSearch, artifactSubscriptions, artifactVersionFiles, artifactVersions, artifactVersionTexts } from "./schema";
import { indexArtifactSearch } from "./search";
import { webManageRefusal, webNotVisible } from "./webCommon";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-manage-tests-hmac-secret-0123456789");
});
afterEach(async () => {
  await __settlePublicTextFillsForTests();
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

type Actor = { type: "user" | "agent"; id: string };

/** A published Artifact (one version, current) with its search row, as a publish leaves it. */
async function artifact(input: { serverId: ServerId; author: Actor; homeChannelId?: string; serverHome?: boolean; name?: string; title?: string; originalHomeChannelId?: string }) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: input.name ?? `art-${label()}`,
    title: input.title ?? `Quarterly ${label()}`,
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    // As made: in a conversation, that one is its original (#75); a test names another for one made elsewhere and moved since.
    originalHomeChannelId: input.originalHomeChannelId ?? input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
  });
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
    status: "published", publisherType: input.author.type, publisherId: input.author.id, position: 1,
  });
  const [item] = await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id)).returning();
  await indexArtifactSearch(db, item!);
  return item!;
}

/**
 * A server (flag on unless `enabled: false`): owner and admin, who are in no
 * channel; author, a member who makes Artifacts; manager, the human creator
 * of agent A; member, neither; #room (private: author, manager, member,
 * agent A). The author is also a member of a peer server (flag on), whose
 * owner is peerUser.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const admin = await seed.human();
  const author = await seed.human();
  const manager = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [admin, author, manager, member] });
  const serverId = asServerId(server.id);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  await addMember(peer.id, author.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const agentA = await createAgent(server.id, `mg-a-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: manager.id });
  const room = await createChannel(server.id, `mg-room-${label()}`, undefined, "private");
  for (const human of [author, manager, member]) await addHuman(room.id, human.id);
  await addAgent(room.id, agentA.id);
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  const byAuthor: Actor = { type: "user", id: author.id };
  const byAgent: Actor = { type: "agent", id: agentA.id };
  return {
    server, serverId, peer, owner, admin, author, manager, member, peerUser, agentA, room, byAuthor, byAgent,
    who: { owner: await as(owner.id), admin: await as(admin.id), author: await as(author.id), manager: await as(manager.id), member: await as(member.id), authorInPeer: await as(author.id, peer.id), peerUser: await as(peerUser.id, peer.id) },
    /** A fresh Artifact of the server. */
    make: (input: { author: Actor; homeChannelId?: string; serverHome?: boolean; name?: string; title?: string; originalHomeChannelId?: string }) => artifact({ serverId, ...input }),
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const widen = (app: { baseUrl: string }, who: Who, item: { id: string }, to: unknown) => call(app, "POST", artifactWebPaths.home(asArtifactId(item.id)), who, { to });
const unpublish = (app: { baseUrl: string }, who: Who, item: { id: string }) => call(app, "POST", artifactWebPaths.unpublish(asArtifactId(item.id)), who);
const remove = (app: { baseUrl: string }, who: Who, item: { id: string }) => call(app, "DELETE", artifactWebPaths.artifact(asArtifactId(item.id)), who);
const rowOf = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
const auditOf = (item: { id: string }) => getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item.id)).orderBy(artifactAudit.id);
const eventsOf = (item: { id: string }) => getDb().select().from(objectEvents).where(eq(objectEvents.objectId, item.id)).orderBy(objectEvents.seq);
const NOT_VISIBLE = webNotVisible().body;
const NAME_TAKEN_PLAN = webManageRefusal({ kind: "name_taken", name: "plan" }).body;
const userView = (world: World, userId: string) => ({ type: "user" as const, id: userId, serverId: world.serverId });

/** Nothing about the item changed: its home and deletion as made, no audit row, no event. */
async function untouched(item: Awaited<ReturnType<World["make"]>>, message: string) {
  const row = await rowOf(item);
  assert.deepEqual([row.homeKind, row.homeChannelId, row.deletedAt], [item.homeKind, item.homeChannelId, null], message);
  assert.deepEqual(await auditOf(item), [], `${message}: no audit row`);
  assert.deepEqual(await eventsOf(item), [], `${message}: no event`);
}

// ---- who may ----------------------------------------------------------------------

test("widen: the author, the manager of an agent author, and the server's owners and admins may; another member may not", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const own = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const res = await widen(app, world.who.author, own, "server");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The answer is the viewer's payload as the actor now sees it.
  assert.equal(res.body.card.id, own.id);
  assert.deepEqual(res.body.card.home, { kind: "server" });
  assert.deepEqual(res.body.capabilities, { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: true, delete: true });
  assert.deepEqual([(await rowOf(own)).homeKind, (await rowOf(own)).homeChannelId], ["server", null]);

  const agents = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  assert.equal((await widen(app, world.who.manager, agents, "server")).status, 200, "the agent's manager");
  assert.equal((await rowOf(agents)).homeKind, "server");

  for (const who of ["owner", "admin"] as const) {
    const serverWide = await world.make({ author: world.byAuthor, serverHome: true });
    const moved = await widen(app, world.who[who], serverWide, "public");
    assert.equal(moved.status, 200, `${who}: ${JSON.stringify(moved.body)}`);
    assert.deepEqual(moved.body.card.home, { kind: "public" });
    assert.equal((await rowOf(serverWide)).homeKind, "public");
  }

  const others = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const refused = await widen(app, world.who.member, others, "server");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "FORBIDDEN");
  await untouched(others, "a member who is neither author nor manager");
  const byAgent = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  assert.equal((await widen(app, world.who.author, byAgent, "server")).status, 403, "an agent's Artifact by someone who doesn't manage the agent");
  await untouched(byAgent, "an agent's Artifact, not its manager");
});

test("delete: a Markdown version's excerpt goes with the Artifact, as its files do", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const other = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const excerptBlocks = [{ type: "paragraph" as const, spans: [{ text: "The agent's words" }] }];
  await getDb().update(artifactVersions).set({ entry: "index.md", excerpt: "The agent's words", excerptBlocks }).where(inArray(artifactVersions.itemId, [item.id, other.id]));
  assert.equal((await remove(app, world.who.author, item)).status, 204);
  const columnsOf = async (itemId: string) => (await getDb().select({ excerpt: artifactVersions.excerpt, excerptBlocks: artifactVersions.excerptBlocks }).from(artifactVersions).where(eq(artifactVersions.itemId, itemId)))[0]!;
  assert.deepEqual(await columnsOf(item.id), { excerpt: null, excerptBlocks: null }, "the blocks are the same words");
  assert.deepEqual(await columnsOf(other.id), { excerpt: "The agent's words", excerptBlocks }, "another Artifact's stays");
});

test("delete: the author, the agent's manager, owners and admins may; another member may not; an admin needn't see it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const cases: Array<[keyof World["who"], Actor]> = [["author", world.byAuthor], ["manager", world.byAgent], ["owner", world.byAuthor], ["admin", world.byAgent]];
  for (const [who, author] of cases) {
    // In #room, which the owner and the admin are not in: they can't see it, and still may delete it.
    const item = await world.make({ author, homeChannelId: world.room.id });
    const res = await remove(app, world.who[who], item);
    assert.equal(res.status, 204, `${who}: ${JSON.stringify(res.body)}`);
    assert.ok((await rowOf(item)).deletedAt !== null, `${who} deleted it`);
  }
  const item = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const refused = await remove(app, world.who.member, item);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "FORBIDDEN");
  await untouched(item, "a member who sees it but isn't its author");
  // One who may not and can't see it learns nothing: the one 404.
  const hidden = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  await addMember(world.server.id, world.peerUser.id);
  const stranger = await call(app, "DELETE", artifactWebPaths.artifact(asArtifactId(hidden.id)), { token: await accessTokenForTest(world.peerUser.id), serverId: world.server.id });
  assert.deepEqual([stranger.status, stranger.body], [404, NOT_VISIBLE]);
  await untouched(hidden, "a member who may not and can't see it");
  // Nor does an id that names nothing.
  assert.deepEqual(await remove(app, world.who.admin, { id: `pt_${randomUUID()}` }), { status: 404, body: NOT_VISIBLE });
});

test("widening needs seeing it now: an admin, an owner or a manager who can't see it gets the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const secret = await createChannel(world.server.id, `mg-secret-${label()}`, undefined, "private");
  await addHuman(secret.id, world.author.id);
  await addAgent(secret.id, world.agentA.id);
  for (const [who, author] of [["owner", world.byAuthor], ["admin", world.byAuthor], ["manager", world.byAgent]] as const) {
    const item = await world.make({ author, homeChannelId: secret.id });
    const res = await widen(app, world.who[who], item, "server");
    assert.deepEqual([res.status, res.body], [404, NOT_VISIBLE], who);
    // The service holds it too, whatever route calls it.
    assert.deepEqual(await widenArtifactHome(userView(world, world[who].id), item.id, "server"), { kind: "not_visible" }, `${who}, the service`);
    await untouched(item, who);
  }
});

test("an author who left the server, or an agent author deleted, hands it to the owners and admins", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const authors = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const agents_ = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  const leaver = userView(world, world.author.id);
  await removeMember(world.server.id, world.author.id);
  assert.deepEqual(await widenArtifactHome(leaver, authors.id, "server"), { kind: "not_visible" }, "left: sees it no more");
  assert.deepEqual(await deleteArtifact(leaver, authors.id), { kind: "not_visible" }, "left: may not delete it");
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, world.agentA.id));
  assert.equal((await widen(app, world.who.manager, agents_, "server")).status, 403, "a deleted agent's manager no longer may");
  assert.equal((await remove(app, world.who.manager, agents_)).status, 403);
  await untouched(agents_, "the manager of a deleted agent");
  assert.equal((await remove(app, world.who.admin, authors)).status, 204, "the admin takes over");
  assert.equal((await remove(app, world.who.owner, agents_)).status, 204, "the owner takes over");
});

test("the other server never may: a public Artifact seen from another server is 403, one it can't see the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const open = await world.make({ author: world.byAuthor });
  // The author themself, through the peer server, as the peer's owner.
  for (const who of [world.who.authorInPeer, world.who.peerUser]) {
    const res = await remove(app, who, open);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "FORBIDDEN");
    const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(open.id)), who);
    assert.equal(viewer.status, 200);
    assert.deepEqual(viewer.body.capabilities, { publish: false, comment: false, changeHome: false, unpublish: false, narrowHome: false, delete: false });
  }
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  assert.deepEqual(await widen(app, world.who.authorInPeer, inRoom, "server"), { status: 404, body: NOT_VISIBLE });
  assert.deepEqual(await remove(app, world.who.authorInPeer, inRoom), { status: 404, body: NOT_VISIBLE });
  await untouched(open, "public, from the peer");
  await untouched(inRoom, "in #room, from the peer");
});

test("a guest deletes their own Artifact and never widens it: 403, the service too, and changeHome false", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const guest = await seed.human();
  await addMember(world.server.id, guest.id);
  // A guest reads the one channel it belongs to (#wg-rbac:#15): #room.
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id, channelId: world.room.id });
  const asGuest = { token: await accessTokenForTest(guest.id), serverId: world.server.id };
  const byGuest: Actor = { type: "user", id: guest.id };

  const own = await world.make({ author: byGuest, homeChannelId: world.room.id });
  // Witness: the guest sees it (a member of #room).
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(own.id)), asGuest);
  assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
  assert.deepEqual(viewer.body.capabilities, { publish: true, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: true });
  for (const to of ["server", "public"] as const) {
    const refused = await widen(app, asGuest, own, to);
    assert.equal(refused.status, 403, `${to}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "FORBIDDEN");
    assert.equal((await widenArtifactHome(userView(world, guest.id), own.id, to)).kind, "forbidden", `${to}, the service`);
  }
  await untouched(own, "a guest widening their own");
  // A larger-home Artifact of theirs reads the same: deletable, not movable.
  const serverWide = await world.make({ author: byGuest, serverHome: true });
  assert.equal(await mayManageArtifact(userView(world, guest.id), serverWide, "widen"), false);
  assert.equal(await mayManageArtifact(userView(world, guest.id), serverWide, "delete"), true);

  assert.equal((await remove(app, asGuest, own)).status, 204, "the guest deletes their own");
  assert.ok((await rowOf(own)).deletedAt !== null);
  // Someone else's, in the same conversation: neither.
  const others = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  assert.equal((await remove(app, asGuest, others)).status, 403);
  assert.equal((await widen(app, asGuest, others, "server")).status, 403);
  await untouched(others, "a guest, not the author");
});

test("a joint channel: the other server's members, its owner and admins included, neither widen nor delete an Artifact homed there", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerAdmin = await seed.human();
  const peerMember = await seed.human();
  for (const human of [peerAdmin, peerMember]) await addMember(world.peer.id, human.id);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, world.peer.id), eq(serverMembers.userId, peerAdmin.id)));
  const joint = await seedJointChannel({ name: `mg-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  for (const human of [world.author, world.member]) await addHuman(hostProjection.id, human.id);
  // Every peer side person is in the joint, through the peer's projection.
  for (const human of [world.peerUser, peerAdmin, peerMember]) await addHuman(peerProjection.id, human.id);
  const peerId = asServerId(world.peer.id);
  const peerSide = {
    peerOwner: world.peerUser.id,
    peerAdmin: peerAdmin.id,
    peerMember: peerMember.id,
    // The author themself, asking as a member of the peer.
    authorInPeer: world.author.id,
  };

  const item = await world.make({ author: world.byAuthor, homeChannelId: hostProjection.id });
  // Witness: the host side's author may do both.
  const own = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.author);
  assert.deepEqual([own.status, own.body.capabilities?.changeHome, own.body.capabilities?.delete], [200, true, true]);

  for (const [name, userId] of Object.entries(peerSide)) {
    const who = { token: await accessTokenForTest(userId), serverId: world.peer.id };
    const actor = { type: "user" as const, id: userId, serverId: peerId };
    // The rule, sight aside: never through another server, so it holds however the joint's visibility grows.
    assert.equal(await mayManageArtifact(actor, item, "widen"), false, `${name}: may not widen`);
    assert.equal(await mayManageArtifact(actor, item, "delete"), false, `${name}: may not delete`);
    // Today the peer side can't see it (the one 404); once a joint home is seen from every side
    // (visibility.db.test.ts' test.fails), the members in it get 403 instead. Either way nothing changes.
    for (const to of ["server", "public"] as const) {
      const res = await widen(app, who, item, to);
      assert.ok(res.status === 403 || res.status === 404, `${name} widening to ${to}: ${res.status}`);
    }
    const res = await remove(app, who, item);
    assert.ok(res.status === 403 || res.status === 404, `${name} deleting: ${res.status}`);
    assert.notEqual((await widenArtifactHome(actor, item.id, "server")).kind, "moved", `${name}, the service`);
    assert.notEqual((await deleteArtifact(actor, item.id)).kind, "deleted", `${name}, the service`);
  }
  await untouched(item, "the peer side of the joint");
  // The host's owner, not in the joint, still may delete it.
  assert.equal((await remove(app, world.who.owner, item)).status, 204);
});

// ---- what may be done -------------------------------------------------------------

test("widening only to a larger home: the same one is 409 HOME_NOT_WIDER (public → server narrows only with expectedLost: below); a body other than ArtifactWebHomeInput is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true });
  const open = await world.make({ author: world.byAuthor });
  for (const [item, home, to] of [[serverWide, "server", "server"], [open, "public", "public"]] as const) {
    const res = await widen(app, world.who.author, item, to);
    assert.deepEqual([res.status, res.body], [409, webManageRefusal({ kind: "not_wider", home, to }).body], `${home} -> ${to}`);
  }
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  for (const body of [{ to: "conversation" }, {}, { to: "server", extra: 1 }, { to: null }, ["server"]]) {
    const res = await call(app, "POST", artifactWebPaths.home(asArtifactId(inRoom.id)), world.who.author, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_REQUEST");
  }
  for (const item of [serverWide, open, inRoom]) await untouched(item, "refused");
  // Conversation straight to public is wider, and allowed.
  assert.equal((await widen(app, world.who.author, inRoom, "public")).status, 200);
});

test("public is a person's step: the service refuses an agent, even the author, and lets it widen to the server", async ({ seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  const agentActor = { type: "agent" as const, id: world.agentA.id, serverId: world.serverId };
  assert.deepEqual(await widenArtifactHome(agentActor, item.id, "public"), { kind: "forbidden", reason: "Only a person can turn on link sharing for an artifact, since anyone with the link could then open it: ask a person who manages it to choose \"Anyone with the link\" on the web." });
  await untouched(item, "an agent going public");
  const moved = await widenArtifactHome(agentActor, item.id, "server");
  assert.equal(moved.kind, "moved");
  assert.equal((await rowOf(item)).homeKind, "server");
  // The person who manages it may take it the rest of the way.
  assert.equal((await widenArtifactHome(userView(world, world.manager.id), item.id, "public")).kind, "moved");
});

test("a name taken in the larger home is 409 NAME_TAKEN, nothing moved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const there = await world.make({ author: world.byAuthor, serverHome: true, name: "plan" });
  const here = await world.make({ author: world.byAuthor, homeChannelId: world.room.id, name: "plan" });
  const res = await widen(app, world.who.author, here, "server");
  assert.deepEqual([res.status, res.body], [409, NAME_TAKEN_PLAN]);
  await untouched(here, "name taken");
  // A deleted one doesn't hold the name.
  assert.equal((await remove(app, world.who.author, there)).status, 204);
  assert.equal((await widen(app, world.who.author, here, "server")).status, 200);
});

test("flag off: both routes answer 403 ARTIFACTS_NOT_ENABLED and change nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  const item = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  for (const res of [await widen(app, world.who.author, item, "server"), await remove(app, world.who.author, item), await remove(app, world.who.admin, item)]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED");
  }
  // Before reading the body.
  assert.equal((await widen(app, world.who.author, item, "nowhere")).body.code, "ARTIFACTS_NOT_ENABLED");
  await untouched(item, "flag off");
});

// ---- what is recorded -------------------------------------------------------------

test("every move and delete writes an audit row (before, after) and an object event: moved for the followers, deleted for no one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  await getDb().insert(artifactSubscriptions).values([
    { itemId: item.id, actorType: "agent", actorId: world.agentA.id, reason: "published" },
    { itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" },
    { itemId: item.id, actorType: "user", actorId: world.manager.id, reason: "followed" },
  ]);
  await getDb().insert(artifactPendingNotices).values({ itemId: item.id, agentId: world.agentA.id, commentIds: ["c_x"], dueAt: new Date(Date.now() + 60_000) });
  assert.equal((await widen(app, world.who.manager, item, "server")).status, 200);
  assert.equal((await widen(app, world.who.manager, item, "public")).status, 200);
  assert.equal((await remove(app, world.who.admin, item)).status, 204);

  const audit = await auditOf(item);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, row.before, row.after]), [
    ["home_changed", "user", world.manager.id, { home_kind: "conversation", home_channel_id: world.room.id }, { home_kind: "server", home_channel_id: null }],
    ["made_public", "user", world.manager.id, { home_kind: "server", home_channel_id: null }, { home_kind: "public", home_channel_id: null }],
    ["deleted", "user", world.admin.id, { deleted_at: null }, { deleted_at: (await rowOf(item)).deletedAt!.toISOString() }],
  ]);

  const events = await eventsOf(item);
  assert.deepEqual(events.map((event) => [event.eventKind, event.homeKind, event.homeChannelId, event.actorId, event.data]), [
    ["moved", "server", null, world.manager.id, { from: "conversation", to: "server", fromChannelId: world.room.id }],
    ["moved", "public", null, world.manager.id, { from: "server", to: "public", fromChannelId: null }],
    ["deleted", "public", null, world.admin.id, {}],
  ]);
  const recipients = async (eventId: string) => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, eventId)))
    .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
  // The followers, the maker as `owner`, never the actor.
  assert.deepEqual(await recipients(events[0]!.id), [`agent:${world.agentA.id}:owner`, `user:${world.member.id}:following`].sort());
  assert.deepEqual(await recipients(events[2]!.id), []);
  // Its pending notices and its search row go with it.
  assert.deepEqual(await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, item.id)), []);
  assert.deepEqual(await getDb().select().from(artifactSearch).where(eq(artifactSearch.itemId, item.id)), []);
});

// ---- after a delete ---------------------------------------------------------------

test("a deleted Artifact is gone from every read: viewer, files, comments, frame, dashboard, search, summaries, the agent API; and can't be moved or deleted again", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const title = `Zephyr ${label()}`;
  const item = await world.make({ author: world.byAgent, homeChannelId: world.room.id, title });
  const artifactId = asArtifactId(item.id);
  const { apiKey } = await mintAgentCredential({ agentId: world.agentA.id, scopes: ["read", "send"], name: `mg-${label()}`, issuedVia: "computer", createdByUserId: null });
  const agentGet = async (path: string) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return { status: res.status, body: await res.json() as any };
  };
  const reads = async () => {
    const viewer = await call(app, "GET", artifactWebPaths.viewer(artifactId), world.who.author);
    const dashboard = await call(app, "GET", artifactWebPaths.dashboard(), world.who.author);
    const search = await call(app, "GET", webSearchPath({ q: title }), world.who.author);
    const summaries = await call(app, "POST", objectWebPaths.summaries(), world.who.author, { kind: "artifact", refs: [{ id: item.id }] });
    const list = await agentGet(`/internal/agent-api/artifacts?${new URLSearchParams({ target: `#${world.room.name}` })}`);
    const query = await agentGet(`/internal/agent-api/artifacts?${new URLSearchParams({ query: title })}`);
    const read = await agentGet(`/internal/agent-api/artifacts/${encodeURIComponent(item.id)}`);
    return {
      viewer: viewer.status,
      recent: dashboard.body.recent.rows.map((row: { card: { id: string } }) => row.card.id),
      search: (search.body.groups ?? []).flatMap((group: { items: Array<{ card: { id: string } }> }) => group.items.map((hit) => hit.card.id)),
      summary: summaries.body.summaries[0].ok,
      list: list.body.artifacts.map((row: { id: string }) => row.id),
      query: query.body.artifacts.map((row: { id: string }) => row.id),
      read: read.status,
    };
  };
  // Witness: before, every read has it (the viewer opened it, so it is recent).
  assert.deepEqual(await reads(), { viewer: 200, recent: [item.id], search: [item.id], summary: true, list: [item.id], query: [item.id], read: 200 });
  assert.equal((await remove(app, world.who.author, { id: item.id })).status, 403, "the author of an agent's Artifact isn't its manager");
  assert.equal((await remove(app, world.who.manager, item)).status, 204);
  assert.deepEqual(await reads(), { viewer: 404, recent: [], search: [], summary: false, list: [], query: [], read: 404 });
  for (const [method, path, body] of [
    ["GET", artifactWebPaths.fileContent(artifactId, "index.html")],
    ["GET", artifactWebPaths.comments(artifactId)],
    ["POST", artifactWebPaths.frame(artifactId), {}],
    ["POST", artifactWebPaths.home(artifactId), { to: "server" }],
    ["DELETE", artifactWebPaths.artifact(artifactId)],
  ] as Array<[string, string, unknown?]>) {
    const res = await call(app, method, path, world.who.manager, body);
    assert.deepEqual([res.status, res.body], [404, NOT_VISIBLE], `${method} ${path}`);
  }
  assert.equal((await auditOf(item)).length, 1, "deleted once");
});

// ---- the viewer's capabilities ----------------------------------------------------

test("viewer capabilities: changeHome and delete by the same rule; changeHome only while a larger home exists", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const capabilities = async (who: Who, item: { id: string }) => {
    const res = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // unpublish only while public (the next test): never here but for the public one.
    assert.equal(res.body.capabilities.unpublish, res.body.card.home.kind === "public" && res.body.capabilities.delete && who !== world.who.member);
    return [res.body.capabilities.changeHome, res.body.capabilities.delete];
  };
  const inRoom = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  assert.deepEqual(await capabilities(world.who.manager, inRoom), [true, true], "the agent's manager");
  assert.deepEqual(await capabilities(world.who.member, inRoom), [false, false], "a member");
  assert.deepEqual(await capabilities(world.who.author, inRoom), [false, false], "a member who made other Artifacts");
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true });
  assert.deepEqual(await capabilities(world.who.author, serverWide), [true, true], "its author");
  assert.deepEqual(await capabilities(world.who.admin, serverWide), [true, true], "an admin");
  assert.deepEqual(await capabilities(world.who.owner, serverWide), [true, true], "the owner");
  assert.deepEqual(await capabilities(world.who.member, serverWide), [false, false], "a member");
  const open = await world.make({ author: world.byAuthor });
  assert.deepEqual(await capabilities(world.who.author, open), [false, true], "public: nothing larger, still deletable");
});

test("making it public stores its current version's signed-out text, after the move; a move to the server stores nothing; public again reads nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const objects = new Map<string, Buffer>();
  let reads = 0;
  __setArtifactR2StoreForTests({
    async read(blob) { reads += 1; const bytes = objects.get(blob.r2Key!); return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null; },
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async presign() { return null; },
  });
  const item = await world.make({ author: world.byAuthor, homeChannelId: world.room.id, title: "Plan" });
  // Its entry's bytes (world.make writes no files).
  const bytes = Buffer.from("<h1>Plan</h1><p>Ship it.</p>");
  const blobId = `b_${randomUUID()}`;
  const sha256 = randomUUID().replaceAll("-", "");
  const r2Key = r2KeyOf(world.serverId, sha256, blobId);
  objects.set(r2Key, bytes);
  await getDb().insert(artifactBlobs).values({ id: blobId, serverId: world.serverId, sha256, sizeBytes: bytes.length, state: "ready", r2Key });
  await getDb().insert(artifactVersionFiles).values({ versionId: item.currentVersionId!, path: "index.html", sha256, sizeBytes: bytes.length, blobId });
  const textRow = async () => (await getDb().select().from(artifactVersionTexts).where(eq(artifactVersionTexts.versionId, item.currentVersionId!)))[0] ?? null;

  assert.equal((await widen(app, world.who.author, item, "server")).status, 200);
  await __settlePublicTextFillsForTests();
  assert.deepEqual([await textRow(), reads], [null, 0], "the server home: nothing");

  assert.equal((await widen(app, world.who.author, item, "public")).status, 200);
  await __settlePublicTextFillsForTests();
  const row = await textRow();
  assert.deepEqual([row?.kind, row?.description, row?.body], ["html", "Ship it.", "# Plan\n\nShip it."]);
  assert.equal(reads, 1);

  // Private and public again: the row stayed, nothing read again.
  assert.equal((await unpublish(app, world.who.author, item)).status, 200);
  assert.ok(await textRow(), "kept while private");
  assert.equal((await widen(app, world.who.author, item, "public")).status, 200);
  await __settlePublicTextFillsForTests();
  assert.equal(reads, 1);
});

// ---- back from public (unpublish) ---------------------------------------------------

test("unpublish: the people who may make it public may make it private; a member, a guest author and another server may not", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const [who, author] of [["author", world.byAuthor], ["manager", world.byAgent], ["owner", world.byAuthor], ["admin", world.byAgent]] as const) {
    const open = await world.make({ author });
    const res = await unpublish(app, world.who[who], open);
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    // The answer is the viewer's payload as the actor now sees it: server-wide, widenable again.
    assert.deepEqual(res.body.card.home, { kind: "server" }, who);
    assert.deepEqual([res.body.capabilities.changeHome, res.body.capabilities.unpublish], [true, false], who);
    assert.deepEqual([(await rowOf(open)).homeKind, (await rowOf(open)).homeChannelId], ["server", null], who);
  }

  const others = await world.make({ author: world.byAuthor });
  const refused = await unpublish(app, world.who.member, others);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "FORBIDDEN");
  await untouched(others, "a member who is neither author nor manager");
  // Another server's reader sees a public Artifact, and still never may (the author through the peer, the peer's owner).
  for (const who of [world.who.authorInPeer, world.who.peerUser]) {
    assert.equal((await unpublish(app, who, others)).status, 403);
  }
  await untouched(others, "from the peer");

  // A guest author: deletes their own, never moves it, this way neither.
  const guest = await seed.human();
  await addMember(world.server.id, guest.id);
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id });
  await getDb().insert(featureFlagRules).values({ flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [world.server.id] });
  const asGuest = { token: await accessTokenForTest(guest.id), serverId: world.server.id };
  const guests = await world.make({ author: { type: "user", id: guest.id } });
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(guests.id)), asGuest);
  assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
  assert.deepEqual(viewer.body.capabilities, { publish: true, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: true });
  assert.equal((await unpublish(app, asGuest, guests)).status, 403);
  assert.equal((await unpublishArtifact(userView(world, guest.id), guests.id)).kind, "forbidden", "the service too");
  await untouched(guests, "a guest author");

  // The service refuses an agent, even the one that made it (a person's step, as making it public).
  const agents_ = await world.make({ author: world.byAgent });
  const agentActor = { type: "agent" as const, id: world.agentA.id, serverId: world.serverId };
  assert.equal((await unpublishArtifact(agentActor, agents_.id)).kind, "forbidden");
  await untouched(agents_, "an agent");

  // What the actor can't see, or no such id: the one 404.
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  assert.deepEqual(await unpublish(app, world.who.authorInPeer, inRoom), { status: 404, body: NOT_VISIBLE });
  assert.deepEqual(await unpublish(app, world.who.admin, { id: `pt_${randomUUID()}` }), { status: 404, body: NOT_VISIBLE });
});

test("unpublish: only a public Artifact (409 NOT_PUBLIC), the name free in the server (409 NAME_TAKEN), the flag first", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true, name: "plan" });
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  for (const [item, home] of [[serverWide, "server"], [inRoom, "conversation"]] as const) {
    const res = await unpublish(app, world.who.author, item);
    assert.deepEqual([res.status, res.body], [409, webManageRefusal({ kind: "not_public", home }).body], home);
    await untouched(item, home);
  }
  const open = await world.make({ author: world.byAuthor, name: "plan" });
  const taken = await unpublish(app, world.who.author, open);
  assert.deepEqual([taken.status, taken.body], [409, NAME_TAKEN_PLAN]);
  await untouched(open, "name taken");
  assert.equal((await remove(app, world.who.author, serverWide)).status, 204);
  assert.equal((await unpublish(app, world.who.author, open)).status, 200, "a deleted one doesn't hold the name");

  const off = await seedWorld(seed, { enabled: false });
  const offItem = await off.make({ author: off.byAuthor });
  const res = await unpublish(app, off.who.author, offItem);
  assert.deepEqual([res.status, res.body.code], [403, "ARTIFACTS_NOT_ENABLED"]);
  await untouched(offItem, "flag off");
});

test("unpublish writes the audit row made_private (before, after) and a moved event for the followers", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ author: world.byAgent });
  await getDb().insert(artifactSubscriptions).values([
    { itemId: item.id, actorType: "agent", actorId: world.agentA.id, reason: "published" },
    { itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" },
  ]);
  assert.equal((await unpublish(app, world.who.owner, item)).status, 200);
  const audit = await auditOf(item);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, row.before, row.after]), [
    ["made_private", "user", world.owner.id, { home_kind: "public", home_channel_id: null }, { home_kind: "server", home_channel_id: null }],
  ]);
  const events = await eventsOf(item);
  assert.deepEqual(events.map((event) => [event.eventKind, event.homeKind, event.homeChannelId, event.actorId, event.data]), [
    ["moved", "server", null, world.owner.id, { from: "public", to: "server", fromChannelId: null }],
  ]);
  const recipients = (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, events[0]!.id)))
    .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
  assert.deepEqual(recipients, [`agent:${world.agentA.id}:owner`, `user:${world.member.id}:following`].sort());
});

test("viewer capabilities: unpublish for the people who may make it private, only while public", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const unpublishes = async (who: Who, item: { id: string }) => {
    const res = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return [res.body.capabilities.changeHome, res.body.capabilities.unpublish];
  };
  const open = await world.make({ author: world.byAuthor });
  for (const who of ["author", "owner", "admin"] as const) assert.deepEqual(await unpublishes(world.who[who], open), [false, true], who);
  assert.deepEqual(await unpublishes(world.who.member, open), [false, false], "a member");
  assert.deepEqual(await unpublishes(world.who.authorInPeer, open), [false, false], "the author, through another server");
  const agents_ = await world.make({ author: world.byAgent });
  assert.deepEqual(await unpublishes(world.who.manager, agents_), [false, true], "the agent's manager");
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true });
  assert.deepEqual(await unpublishes(world.who.author, serverWide), [true, false], "server-wide: nothing to unpublish");
});

// ---- to a smaller home (narrowing) ------------------------------------------------

type HomeBody = { to: "server"; expectedLost?: number } | { to: "conversation"; conversationId: string; expectedLost?: number };
/** The home route exactly as sent. */
const moveHome = (app: { baseUrl: string }, who: Who, item: { id: string }, body: HomeBody) =>
  call(app, "POST", artifactWebPaths.home(asArtifactId(item.id)), who, body);
const preview = (app: { baseUrl: string }, who: Who, item: { id: string }, to: { to: "server" } | { to: "conversation"; conversationId: string }) =>
  call(app, "GET", to.to === "server"
    ? artifactWebPaths.homeChange(asArtifactId(item.id), { to: "server" })
    : artifactWebPaths.homeChange(asArtifactId(item.id), { to: "conversation", conversationId: asChannelId(to.conversationId) }), who);
/**
 * A narrowing as the web confirms one: with `expectedLost` (only it narrows),
 * the preview's count unless given (0 when the preview is refused: the
 * narrowing's own checks refuse first).
 */
const narrow = async (app: { baseUrl: string }, who: Who, item: { id: string }, body: HomeBody) => {
  if (body.expectedLost !== undefined) return moveHome(app, who, item, body);
  const shown = await preview(app, who, item, body.to === "server" ? { to: "server" } : { to: "conversation", conversationId: body.conversationId });
  const expectedLost = shown.status === 200 ? shown.body.peopleLosingAccess + shown.body.agentsLosingAccess : 0;
  return moveHome(app, who, item, { ...body, expectedLost });
};
const into = (channel: { id: string }) => ({ to: "conversation" as const, conversationId: channel.id });
/** Record `conversationId` as the item's original conversation (#75), as if it had been made there. */
const originallyIn = (item: { id: string }, conversationId: string | null) =>
  getDb().update(artifactItems).set({ originalHomeChannelId: conversationId }).where(eq(artifactItems.id, item.id));

/** #ops: a private channel of the world's server with the author and the admin (not the owner, the manager, the member or agent A). */
async function opsChannel(world: World) {
  const ops = await createChannel(world.server.id, `mg-ops-${label()}`, undefined, "private");
  for (const human of [world.author, world.admin]) await addHuman(ops.id, human.id);
  return ops;
}

test("narrow: server → a conversation by an admin and by the author; a member who doesn't manage it, an agent and a delegated actor may not", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  for (const who of ["admin", "author"] as const) {
    const item = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: ops.id });
    const res = await narrow(app, world.who[who], item, into(ops));
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    // The viewer's payload as the mover now sees it: in #ops, widenable again, nothing smaller.
    assert.equal(res.body.card.home.kind, "conversation", who);
    assert.equal(res.body.card.home.conversation.id, ops.id, who);
    assert.deepEqual(res.body.capabilities, { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true }, who);
    assert.deepEqual([(await rowOf(item)).homeKind, (await rowOf(item)).homeChannelId], ["conversation", ops.id], who);
  }

  const others = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: world.room.id });
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(others.id)), world.who.member);
  assert.equal(viewer.body.capabilities.narrowHome, false, "a member sees it and may not narrow it");
  const refused = await narrow(app, world.who.member, others, into(world.room));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "FORBIDDEN");
  assert.equal((await preview(app, world.who.member, others, into(world.room))).status, 403, "nor preview it");
  await untouched(others, "a member who is neither author nor manager");

  // The service: a smaller home is a person's step, and a delegated actor manages nothing.
  const agents_ = await world.make({ author: world.byAgent, serverHome: true, originalHomeChannelId: world.room.id });
  const agentActor = { type: "agent" as const, id: world.agentA.id, serverId: world.serverId };
  assert.equal((await narrowArtifactHome(agentActor, agents_.id, { kind: "conversation", conversationId: world.room.id })).kind, "forbidden", "the agent author");
  const delegated = { type: "delegated" as const, id: world.manager.id, agentId: world.agentA.id, serverId: world.serverId };
  assert.equal((await narrowArtifactHome(delegated, agents_.id, { kind: "conversation", conversationId: world.room.id })).kind, "forbidden", "a delegated actor");
  await untouched(agents_, "an agent, a delegated actor");
  // Its manager may.
  assert.equal((await narrow(app, world.who.manager, agents_, into(world.room))).status, 200);
});

test("narrow: the target is a top-level conversation of the Artifact's server the mover sees, not a thread nor a joint channel, with no guest", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make({ author: world.byAuthor, serverHome: true });
  // Each target as if it were the Artifact's original conversation (#75), so the checks after that one answer.
  const refusedWith = async (to: { to: "conversation"; conversationId: string }, status: number, code: string, details: unknown, what: string) => {
    await originallyIn(item, to.conversationId);
    for (const res of [await narrow(app, world.who.admin, item, to), await preview(app, world.who.admin, item, to)]) {
      assert.deepEqual([res.status, res.body.code, res.body.details], [status, code, details], what);
    }
  };
  // #room is private and the admin isn't in it: the one TARGET_NOT_FOUND, as for one that doesn't exist.
  for (const [what, conversationId] of [["a conversation the admin can't see", world.room.id], ["no such conversation", randomUUID()]] as const) {
    await refusedWith({ to: "conversation", conversationId }, 404, "TARGET_NOT_FOUND", { conversationId }, what);
  }
  // Not an id is never its original conversation.
  for (const res of [await narrow(app, world.who.admin, item, into({ id: "general" })), await preview(app, world.who.admin, item, into({ id: "general" }))]) {
    assert.deepEqual([res.status, res.body.code], [409, "NOT_ORIGINAL_HOME"], "not an id");
  }
  // Another server's conversation, even one the admin is in.
  const elsewhere = await createChannel(world.peer.id, `mg-peer-${label()}`, undefined, "channel");
  await addMember(world.peer.id, world.admin.id);
  await addHuman(elsewhere.id, world.admin.id);
  await refusedWith(into(elsewhere), 404, "TARGET_NOT_FOUND", { conversationId: elsewhere.id }, "another server's conversation");

  const ops = await opsChannel(world);
  const thread = await getOrCreateThread((await createMessage(ops.id, "user", world.admin.id, "root")).id, world.admin.id, "user");
  await refusedWith(into(thread), 400, "TARGET_NOT_SUPPORTED", { conversationId: thread.id, reason: "thread" }, "a thread of #ops");
  // A thread of a conversation the admin can't see is the one 404, saying nothing of it.
  const hiddenThread = await getOrCreateThread((await createMessage(world.room.id, "user", world.author.id, "root")).id, world.author.id, "user");
  await refusedWith(into(hiddenThread), 404, "TARGET_NOT_FOUND", { conversationId: hiddenThread.id }, "a thread the admin can't see");

  const joint = await seedJointChannel({ name: `mg-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const hostProjection = joint.projections[0]!;
  for (const human of [world.admin, world.author]) await addHuman(hostProjection.id, human.id);
  await refusedWith(into(hostProjection), 400, "TARGET_NOT_SUPPORTED", { conversationId: hostProjection.id, reason: "joint" }, "a joint channel");

  // Guests: one in it (the import's rule, #11288).
  const guest = await seed.human();
  await addMember(world.server.id, guest.id);
  const withGuest = await opsChannel(world);
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id, channelId: withGuest.id });
  await refusedWith(into(withGuest), 403, "TARGET_HAS_GUESTS", { conversationId: withGuest.id, reason: "guest_members" }, "a guest in it");
  await untouched(item, "every refused target");
  // The old guest_visible flag no longer opens a channel to guests (a guest
  // reads only its one channel, #wg-rbac:#15): with none in it, it passes the preview.
  const openToGuests = await createChannel(world.server.id, `mg-guests-${label()}`, undefined, "channel");
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, openToGuests.id));
  await originallyIn(item, openToGuests.id);
  const openPreview = await preview(app, world.who.admin, item, into(openToGuests));
  assert.equal(openPreview.status, 200, JSON.stringify(openPreview.body));
  await untouched(item, "previewed only");

  // Witness: #ops itself is fine.
  await originallyIn(item, ops.id);
  assert.equal((await narrow(app, world.who.admin, item, into(ops))).status, 200);
  // Now in a conversation: nothing smaller (409 HOME_NOT_NARROWER), and a malformed body is 400.
  const lateral = await narrow(app, world.who.admin, item, into(ops));
  assert.deepEqual([lateral.status, lateral.body.code, lateral.body.details], [409, "HOME_NOT_NARROWER", { home: "conversation", to: "conversation" }]);
  for (const body of [{ to: "conversation" }, { to: "conversation", conversationId: "" }, { to: "conversation", conversationId: 7 }, { to: "server", conversationId: ops.id }]) {
    const res = await call(app, "POST", artifactWebPaths.home(asArtifactId(item.id)), world.who.admin, body);
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_REQUEST"], JSON.stringify(body));
  }
  for (const path of [`/api/artifacts/${item.id}/home-change`, `/api/artifacts/${item.id}/home-change?to=public`, `/api/artifacts/${item.id}/home-change?to=conversation`]) {
    assert.deepEqual([(await call(app, "GET", path, world.who.admin)).body.code], ["INVALID_REQUEST"], path);
  }
});

test("narrow: its author keeps it: a person author must see it there, an agent author be in the conversation (409 AUTHOR_LOSES_ACCESS)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // A public channel: every member and agent of the server reads it without joining; agent A hasn't joined.
  const open = await createChannel(world.server.id, `mg-open-${label()}`, undefined, "channel");
  await addHuman(open.id, world.manager.id);
  const agents_ = await world.make({ author: world.byAgent, serverHome: true, originalHomeChannelId: open.id });
  const res = await narrow(app, world.who.manager, agents_, into(open));
  assert.deepEqual([res.status, res.body.code, res.body.details], [409, "AUTHOR_LOSES_ACCESS", { reason: "agent_not_member" }]);
  assert.deepEqual((await preview(app, world.who.manager, agents_, into(open))).body.details, { reason: "agent_not_member" });
  await untouched(agents_, "the agent author not in the conversation");
  await addAgent(open.id, world.agentA.id);
  assert.equal((await narrow(app, world.who.manager, agents_, into(open))).status, 200, "once it is in it");

  // A person author not in a private channel the admin moves it to.
  const adminOnly = await createChannel(world.server.id, `mg-admin-${label()}`, undefined, "private");
  await addHuman(adminOnly.id, world.admin.id);
  const authors = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: adminOnly.id });
  const refused = await narrow(app, world.who.admin, authors, into(adminOnly));
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, "AUTHOR_LOSES_ACCESS", { reason: "cannot_see" }]);
  await untouched(authors, "the author not in the conversation");
  // An author who left the server sees nothing of it already: the owners and admins move it where they like.
  await removeMember(world.server.id, world.author.id);
  assert.equal((await narrow(app, world.who.admin, authors, into(adminOnly))).status, 200, "an author who left");
});

test("narrow: a name taken in the target home is 409 NAME_TAKEN, nothing moved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  await world.make({ author: world.byAuthor, homeChannelId: ops.id, name: "plan" });
  const item = await world.make({ author: world.byAuthor, serverHome: true, name: "plan", originalHomeChannelId: ops.id });
  for (const res of [await preview(app, world.who.author, item, into(ops)), await narrow(app, world.who.author, item, into(ops))]) {
    assert.deepEqual([res.status, res.body], [409, NAME_TAKEN_PLAN]);
  }
  await untouched(item, "name taken");
  // From public to the server, the same.
  const open = await world.make({ author: world.byAuthor, name: "draft" });
  await world.make({ author: world.byAuthor, serverHome: true, name: "draft" });
  assert.deepEqual((await narrow(app, world.who.author, open, { to: "server" })).body.code, "NAME_TAKEN");
  await untouched(open, "name taken in the server");
});

test("after narrowing, who can't see it there loses it: viewer and summaries no access, search, and the Activity row, in the move's transaction; the audit row and event say so", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  const title = `Narrowed ${label()}`;
  const item = await world.make({ author: world.byAuthor, serverHome: true, title, originalHomeChannelId: ops.id });
  await getDb().insert(artifactSubscriptions).values([
    { itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" },
    { itemId: item.id, actorType: "user", actorId: world.admin.id, reason: "followed" },
  ]);
  // Activity rows for the member (outside #ops) and the admin (in it).
  await recordArtifactEvent(getDb(), {
    item, eventKind: "comment", actor: world.byAuthor, data: { position: 1 },
    recipients: [{ actor: { type: "user", id: world.member.id }, reason: "following" }, { actor: { type: "user", id: world.admin.id }, reason: "following" }],
  });
  const reads = async (who: Who) => {
    const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), who);
    const summaries = await call(app, "POST", objectWebPaths.summaries(), who, { kind: "artifact", refs: [{ id: item.id }] });
    const search = await call(app, "GET", webSearchPath({ q: title }), who);
    const inbox = await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "all", limit: "100" })}`, who);
    return {
      viewer: viewer.status,
      summary: summaries.body.summaries[0].ok,
      search: (search.body.groups ?? []).flatMap((group: { items: Array<{ card?: { id: string } }> }) => group.items.map((hit) => hit.card?.id)).filter((hitId: unknown) => hitId === item.id).length,
      activity: inbox.body.items.filter((row: { kind: string; objectId?: string }) => row.kind === "object" && row.objectId === item.id).length,
    };
  };
  const rowsOf = async (userId: string) => (await getDb().select().from(objectInboxStates).where(and(eq(objectInboxStates.objectId, item.id), eq(objectInboxStates.userId, userId)))).length;
  // Witness: before, both read it everywhere.
  assert.deepEqual(await reads(world.who.member), { viewer: 200, summary: true, search: 1, activity: 1 });
  assert.deepEqual(await reads(world.who.admin), { viewer: 200, summary: true, search: 1, activity: 1 });

  const res = await narrow(app, world.who.author, item, into(ops));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The member: no access, everywhere the link or card shows (never an error), and the row went with the move.
  assert.deepEqual(await reads(world.who.member), { viewer: 404, summary: false, search: 0, activity: 0 });
  assert.equal(await rowsOf(world.member.id), 0, "the member's Activity row is gone");
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.member);
  assert.deepEqual(viewer.body, NOT_VISIBLE);
  // The admin, in #ops, keeps it all.
  assert.deepEqual(await reads(world.who.admin), { viewer: 200, summary: true, search: 1, activity: 1 });
  assert.equal(await rowsOf(world.admin.id), 1);

  // Audited: who, from which home to which, how many lost it (owner, manager and member; agent A), the Activity rows removed.
  const audit = await auditOf(item);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, row.before, row.after]), [[
    "narrowed", "user", world.author.id,
    { home_kind: "server", home_channel_id: null },
    { home_kind: "conversation", home_channel_id: ops.id, lost_access: { people: 3, agents: 1, capped: false, left_public: false }, activity_rows_removed: 1 },
  ]]);
  // The moved event, for the followers who still see it (the admin), never the member.
  const events = await eventsOf(item);
  const moved = events.find((event) => event.eventKind === "moved")!;
  assert.deepEqual([moved.homeKind, moved.homeChannelId, moved.data], ["conversation", ops.id, { from: "server", to: "conversation", fromChannelId: null }]);
  const recipients = (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, moved.id))).map((row) => row.recipientId);
  assert.deepEqual(recipients, [world.admin.id]);
});

test("narrow: public → a conversation and public → the server through the home route; signed-out visitors lose it; unpublish still answers as before", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  const anonymous = async (item: { id: string }) => (await fetch(`${app.baseUrl}/api/public/artifacts/${item.id}`)).status;

  const open = await world.make({ author: world.byAuthor, originalHomeChannelId: ops.id });
  assert.equal(await anonymous(open), 200, "witness: public");
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(open.id)), world.who.author);
  assert.deepEqual([viewer.body.capabilities.unpublish, viewer.body.capabilities.narrowHome], [true, true]);
  const res = await narrow(app, world.who.author, open, into(ops));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([(await rowOf(open)).homeKind, (await rowOf(open)).homeChannelId], ["conversation", ops.id]);
  assert.equal(await anonymous(open), 404);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(asArtifactId(open.id)), world.who.member)).status, 404);
  assert.deepEqual((await auditOf(open)).map((row) => [row.action, row.before, (row.after as { lost_access: unknown }).lost_access]), [
    ["narrowed", { home_kind: "public", home_channel_id: null }, { people: 3, agents: 1, capped: false, left_public: true }],
  ]);

  const toServer = await world.make({ author: world.byAuthor });
  const back = await narrow(app, world.who.admin, toServer, { to: "server" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.card.home, { kind: "server" });
  assert.equal(await anonymous(toServer), 404);
  assert.equal((await auditOf(toServer))[0]!.action, "narrowed");
  // The server is the smallest `to: "server"` reaches: again without
  // expectedLost is a widening, 409 HOME_NOT_WIDER; with it, 409 HOME_NOT_NARROWER.
  assert.equal((await moveHome(app, world.who.admin, toServer, { to: "server" })).body.code, "HOME_NOT_WIDER");
  assert.equal((await narrow(app, world.who.admin, toServer, { to: "server" })).body.code, "HOME_NOT_NARROWER");

  // unpublish is unchanged: its own audit row.
  const unpublished = await world.make({ author: world.byAuthor });
  assert.equal((await unpublish(app, world.who.author, unpublished)).status, 200);
  assert.equal((await auditOf(unpublished))[0]!.action, "made_private");
});

test("without expectedLost a home change only widens (Kirby, #45): public → server and → a conversation are 409 HOME_NOT_WIDER and change nothing, after who may (403, 404); conversation → server still widens", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  // A stale chip: `to: "server"` on an Artifact that is public now.
  const open = await world.make({ author: world.byAuthor });
  const stale = await moveHome(app, world.who.author, open, { to: "server" });
  assert.deepEqual([stale.status, stale.body.code, stale.body.details], [409, "HOME_NOT_WIDER", { home: "public", to: "server" }]);
  await untouched(open, "public → server without expectedLost");
  assert.equal((await rowOf(open)).homeKind, "public");
  // A conversation is never larger: without expectedLost, refused from any home.
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true });
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  for (const [item, home] of [[open, "public"], [serverWide, "server"], [inRoom, "conversation"]] as const) {
    const res = await moveHome(app, world.who.author, item, into(ops));
    assert.deepEqual([res.status, res.body.code, res.body.details], [409, "HOME_NOT_WIDER", { home, to: "conversation" }], home);
    await untouched(item, `${home} → a conversation without expectedLost`);
  }
  // Who may comes first, as from either move (Tenny): one who sees it but may not move it gets 403, not the 409; one who can't see it, the one 404.
  const notMine = await moveHome(app, world.who.member, serverWide, into(ops));
  assert.deepEqual([notMine.status, notMine.body.code], [403, "FORBIDDEN"], JSON.stringify(notMine.body));
  await untouched(serverWide, "a member who sees it but may not move it");
  const unseen = await moveHome(app, world.who.peerUser, inRoom, into(ops));
  assert.deepEqual([unseen.status, unseen.body.code], [404, "NOT_VISIBLE"], JSON.stringify(unseen.body));
  // A widening needs none.
  const widened = await moveHome(app, world.who.author, inRoom, { to: "server" });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
  assert.equal((await rowOf(inRoom)).homeKind, "server");
});

test("home-change preview: how many of the server's people and agents would lose it, counts only, capped past the budget", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  // The server: owner, admin, author, manager, member, and agent A. #ops: the author and the admin.
  const serverWide = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: ops.id });
  const res = await preview(app, world.who.author, serverWide, into(ops));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { peopleLosingAccess: 3, agentsLosingAccess: 1, leavesPublic: false });
  // Into #room (author, manager, member, agent A), had it been made there: the owner and the admin.
  const madeInRoom = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: world.room.id });
  assert.deepEqual((await preview(app, world.who.author, madeInRoom, into(world.room))).body, { peopleLosingAccess: 2, agentsLosingAccess: 0, leavesPublic: false });
  await untouched(serverWide, "a preview writes nothing");

  // Public: a guest of the server loses it too, and so does everyone outside (not counted).
  const guest = await seed.human();
  await addMember(world.server.id, guest.id);
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id });
  const open = await world.make({ author: world.byAuthor, originalHomeChannelId: ops.id });
  assert.deepEqual((await preview(app, world.who.author, open, into(ops))).body, { peopleLosingAccess: 4, agentsLosingAccess: 1, leavesPublic: true });
  assert.deepEqual((await preview(app, world.who.author, open, { to: "server" })).body, { peopleLosingAccess: 1, agentsLosingAccess: 0, leavesPublic: true });

  // Not smaller: 409 HOME_NOT_NARROWER.
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const lateral = await preview(app, world.who.author, inRoom, { to: "server" });
  assert.deepEqual([lateral.status, lateral.body.code, lateral.body.details], [409, "HOME_NOT_NARROWER", { home: "conversation", to: "server" }]);

  // Past the counting budget: capped, a lower bound.
  homeChangeLimits.maxCounted = 2;
  try {
    const capped = await preview(app, world.who.author, serverWide, into(ops));
    assert.equal(capped.body.capped, true);
    assert.ok(capped.body.peopleLosingAccess + capped.body.agentsLosingAccess <= 2, JSON.stringify(capped.body));
  } finally {
    homeChangeLimits.maxCounted = ARTIFACT_HOME_CHANGE_MAX_COUNTED;
  }
  // The service answers the same for a delegated actor: nothing.
  const delegated = { type: "delegated" as const, id: world.author.id, agentId: world.agentA.id, serverId: world.serverId };
  assert.equal((await previewNarrowing(delegated, serverWide, { kind: "server" })).kind, "forbidden");
});

test("narrow with expectedLost: moves only while the confirmed count holds, else 409 LOSS_CHANGED and nothing changes; never widens", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  const item = await world.make({ author: world.byAuthor, serverHome: true, originalHomeChannelId: ops.id });
  const shown = await preview(app, world.who.author, item, into(ops));
  const expected = shown.body.peopleLosingAccess + shown.body.agentsLosingAccess;
  assert.equal(expected, 4, JSON.stringify(shown.body));
  const wrong = await narrow(app, world.who.author, item, { ...into(ops), expectedLost: 3 });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.details], [409, "LOSS_CHANGED", { expected: 3, actual: 4, capped: false }]);
  await untouched(item, "a count that doesn't hold");
  // The member joins #ops after the preview: one fewer loses it.
  await addHuman(ops.id, world.member.id);
  const changed = await narrow(app, world.who.author, item, { ...into(ops), expectedLost: expected });
  assert.deepEqual([changed.status, changed.body.details], [409, { expected: 4, actual: 3, capped: false }]);
  await untouched(item, "changed since the preview");
  assert.equal((await narrow(app, world.who.author, item, { ...into(ops), expectedLost: 3 })).status, 200, "the count that holds");

  // With expectedLost, `to: "server"` is a narrowing: on an Artifact in a conversation it is refused, never widened.
  const inRoom = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  const notWidened = await narrow(app, world.who.author, inRoom, { to: "server", expectedLost: 0 });
  assert.deepEqual([notWidened.status, notWidened.body.code], [409, "HOME_NOT_NARROWER"]);
  await untouched(inRoom, "expectedLost on a widening");
  for (const body of [{ to: "server", expectedLost: -1 }, { to: "server", expectedLost: 1.5 }, { to: "server", expectedLost: "4" }, { to: "public", expectedLost: 0 }]) {
    const res = await call(app, "POST", artifactWebPaths.home(asArtifactId(inRoom.id)), world.who.author, body);
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_REQUEST"], JSON.stringify(body));
  }
  // The service: the same.
  const open = await world.make({ author: world.byAuthor });
  assert.deepEqual(await narrowArtifactHome(userView(world, world.author.id), open.id, { kind: "server" }, { expectedLost: 1 }), { kind: "loss_changed", expected: 1, actual: 0, capped: false });
  await untouched(open, "the service, a count that doesn't hold");
  assert.equal((await narrowArtifactHome(userView(world, world.author.id), open.id, { kind: "server" }, { expectedLost: 0 })).kind, "moved");
});

// ---- back to its original conversation only (#75) ----------------------------------

test("narrow only back to the original conversation (#75): made in #ops and widened, the viewer offers #ops, narrowing there works; any other conversation is 409 NOT_ORIGINAL_HOME naming #ops", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  const item = await world.make({ author: world.byAuthor, homeChannelId: ops.id });
  // Made in #ops: nothing smaller, nothing to return to.
  const made = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.author);
  assert.deepEqual([made.body.originalHome, made.body.capabilities.narrowHome], [null, false]);

  const widened = await widen(app, world.who.author, item, "server");
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
  // The home route's answer and the viewer both name #ops, for the author and an admin in it.
  assert.deepEqual([widened.body.originalHome, widened.body.capabilities.narrowHome], [{ conversationId: ops.id }, true]);
  for (const who of ["author", "admin"] as const) {
    const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who[who]);
    assert.deepEqual([viewer.body.originalHome, viewer.body.capabilities.narrowHome], [{ conversationId: ops.id }, true], who);
  }
  // A member who sees it but may not move it: neither.
  const members = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.member);
  assert.deepEqual([members.status, members.body.originalHome, members.body.capabilities.narrowHome], [200, null, false]);

  // #room is a conversation the author sees, but not the original: refused, preview and move alike, naming #ops.
  for (const res of [await preview(app, world.who.author, item, into(world.room)), await moveHome(app, world.who.author, item, { ...into(world.room), expectedLost: 0 })]) {
    assert.deepEqual([res.status, res.body.code, res.body.details], [409, "NOT_ORIGINAL_HOME", { originalConversationId: ops.id }]);
  }
  assert.deepEqual([(await rowOf(item)).homeKind, (await rowOf(item)).homeChannelId], ["server", null], "not moved");
  // Who may comes first: a member who may not move it hears 403, not where it came from.
  assert.equal((await narrow(app, world.who.member, item, into(world.room))).status, 403);

  // Back to #ops: the narrowing's own checks and audit row, as before.
  const back = await narrow(app, world.who.author, item, into(ops));
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.card.home.conversation.id, ops.id);
  assert.deepEqual([back.body.originalHome, back.body.capabilities.narrowHome], [null, false], "in its conversation again: nothing smaller");
  assert.deepEqual((await auditOf(item)).map((row) => row.action), ["home_changed", "narrowed"]);
  // The original never moves: still #ops.
  assert.equal((await rowOf(item)).originalHomeChannelId, ops.id);

  // Made in the whole server, it has none: no conversation to narrow to, named as null; public → the server still narrows.
  const serverMade = await world.make({ author: world.byAuthor, serverHome: true });
  const serverViewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(serverMade.id)), world.who.author);
  assert.deepEqual([serverViewer.body.originalHome, serverViewer.body.capabilities.narrowHome], [null, false]);
  const none = await narrow(app, world.who.author, serverMade, into(ops));
  assert.deepEqual([none.status, none.body.code, none.body.details], [409, "NOT_ORIGINAL_HOME", { originalConversationId: null }]);
  await untouched(serverMade, "no original conversation");
  const publicMade = await world.make({ author: world.byAuthor });
  const publicViewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(publicMade.id)), world.who.author);
  assert.deepEqual([publicViewer.body.originalHome, publicViewer.body.capabilities.narrowHome, publicViewer.body.capabilities.unpublish], [null, false, true], "public back to the server is unpublish's");
  assert.equal((await narrow(app, world.who.author, publicMade, { to: "server" })).status, 200, "the home route's public → server still narrows");
});

test("the original conversation deleted: originalHome null and narrowHome false; narrowing there is the one TARGET_NOT_FOUND", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ops = await opsChannel(world);
  const item = await world.make({ author: world.byAuthor, homeChannelId: ops.id });
  assert.equal((await widen(app, world.who.author, item, "server")).status, 200);
  await deleteChannel(ops.id);
  const viewer = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.author);
  assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
  assert.deepEqual([viewer.body.originalHome, viewer.body.capabilities.narrowHome], [null, false]);
  const res = await narrow(app, world.who.author, item, into(ops));
  assert.deepEqual([res.status, res.body.code], [404, "TARGET_NOT_FOUND"]);
  // Named elsewhere, it is not said either.
  const elsewhere = await narrow(app, world.who.author, item, into(world.room));
  assert.deepEqual([elsewhere.status, elsewhere.body.code, elsewhere.body.details], [409, "NOT_ORIGINAL_HOME", { originalConversationId: null }]);
  assert.equal((await rowOf(item)).homeKind, "server");
});

test("a manager who can't see the original conversation is never told it: originalHome null, NOT_ORIGINAL_HOME names null, narrowing there the one TARGET_NOT_FOUND", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // Made in #room (private: author, manager, member, agent A), widened; the admin isn't in #room.
  const item = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });
  assert.equal((await widen(app, world.who.author, item, "server")).status, 200);
  const authors = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.author);
  assert.deepEqual(authors.body.originalHome, { conversationId: world.room.id }, "witness: the author is in it");
  const admins = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), world.who.admin);
  assert.equal(admins.status, 200, JSON.stringify(admins.body));
  assert.deepEqual([admins.body.originalHome, admins.body.capabilities.narrowHome, admins.body.capabilities.changeHome], [null, false, true]);
  assert.ok(!JSON.stringify(admins.body).includes(world.room.id), "#room's id is nowhere in the admin's answer");
  const ops = await opsChannel(world);
  const other = await narrow(app, world.who.admin, item, into(ops));
  assert.deepEqual([other.status, other.body.code, other.body.details], [409, "NOT_ORIGINAL_HOME", { originalConversationId: null }]);
  const hidden = await narrow(app, world.who.admin, item, into(world.room));
  assert.deepEqual([hidden.status, hidden.body.code, hidden.body.details], [404, "TARGET_NOT_FOUND", { conversationId: world.room.id }]);
  assert.equal((await rowOf(item)).homeKind, "server");
});
