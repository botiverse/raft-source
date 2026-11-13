// Core's mention audience for an Artifact (POST /api/mentions/audience with
// an object audience; routes/mentions.ts, platform/mentions.ts): the people
// and agents of its server who can see its current home, of them whom core
// shows the reader; its home's members first. Narrowing the home narrows the
// next answer. Homed in a joint channel, the joint's other servers' members
// who can see it are offered too, as the joint's own audience shows them.
// Whoever can't see it, an unknown or deleted one, another app's id, another
// server's reader or the app off: the one 404. A constant number of queries
// however many people.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  SERVER_GUEST_FEATURE_FLAG_KEY,
  artifactWebPaths,
  asArtifactId,
  asServerId,
  mentionAudiencePaths,
  type MentionAudienceCandidates,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { mentionAudience } from "../../platform/mentions";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactsApp } from "./register";
import { artifactItems } from "./schema";
import { seedBoundGuest } from "../../test/guestFixture";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-mention-audience-hmac-secret-01234");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);

function memoryR2(): ArtifactR2Store {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read() { return null; },
    async presign() { return null; },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any; text: string; cacheControl: string | null };

async function call(app: { baseUrl: string }, path: string, who: Who, body: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, cacheControl: res.headers.get("cache-control") };
}

async function agentCall(app: { baseUrl: string }, path: string, apiKey: string, body: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, cacheControl: null };
}

/**
 * A server (Artifacts on) with #room (owner, reader, agent A); `other` a member
 * outside it; gus a guest bound to #meet (#wg-rbac:#15) in #meet with reader and
 * agent A; agent Z in no conversation; a peer server whose owner is peerUser.
 * Agent A publishes `page` in #room.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  const owner = await seed.human();
  const reader = await seed.human();
  const other = await seed.human();
  const gus = await seed.human();
  const server = await seed.server({ owner, members: [reader, other, gus] });
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  const db = getDb();
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  await db.insert(featureFlagRules).values([
    { flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] },
  ]);
  const agentA = await createAgent(server.id, `mau-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentZ = await createAgent(server.id, `mau-z-${label()}`, { runtime: "claude", model: "sonnet" });
  const room = await createChannel(server.id, `mau-room-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(room.id, human.id);
  await addAgent(room.id, agentA.id);
  const meet = await createChannel(server.id, `mau-meet-${label()}`, undefined, "private");
  await addHuman(meet.id, reader.id);
  await seedBoundGuest({ serverId: server.id, userId: gus.id, channelId: meet.id });
  await addAgent(meet.id, agentA.id);
  __setArtifactR2StoreForTests(memoryR2());
  const keyA = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `mau-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const publishIn = async (channel: { name: string }) => {
    const created = await agentCall(app, "/artifacts/push", keyA, { target: `#${channel.name}`, title: `Plan ${label()}`, files: [{ path: "index.md", content: "# plan" }] });
    assert.equal(created.status, 201, created.text);
    return created.body.artifact.id as string;
  };
  const page = await publishIn(room);
  const as = async (userId: string, sid: string = server.id): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, peer, owner, reader, other, gus, peerUser, agentA, agentZ, room, meet, keyA, page, publishIn,
    who: { owner: await as(owner.id), reader: await as(reader.id), other: await as(other.id), gus: await as(gus.id), peerUser: await as(peerUser.id, peer.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const objectAudience = (objectId: string, extra: Record<string, unknown> = {}) =>
  ({ audience: { kind: "object", app: artifactsApp.id, objectKind: ARTIFACT_OBJECT_KIND, objectId, ...extra } });

async function candidates(app: { baseUrl: string }, who: Who, objectId: string, q?: string): Promise<MentionAudienceCandidates> {
  const res = await call(app, mentionAudiencePaths.audience(), who, { ...objectAudience(objectId), ...(q === undefined ? {} : { q }) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.cacheControl, "private, no-store");
  return res.body;
}
const keys = (answer: MentionAudienceCandidates) => answer.candidates.map((c) => `${c.type}:${c.id}`);
const set = (answer: MentionAudienceCandidates) => new Set(keys(answer));
const user = (id: string) => `user:${id}`;
const agent = (id: string) => `agent:${id}`;
const setHome = (world: World, id: string, home: { homeKind: "conversation" | "server" | "public"; homeChannelId: string | null }) =>
  getDb().update(artifactItems).set(home).where(eq(artifactItems.id, id));

test("an Artifact in a private conversation: only those who can see it, its home's members first; narrowing the home narrows the next answer", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const inRoom = await candidates(app, world.who.reader, world.page);
  assert.deepEqual(set(inRoom), new Set([user(world.owner.id), user(world.reader.id), agent(world.agentA.id)]));
  assert.deepEqual(inRoom.candidates.map((c) => c.type), ["user", "user", "agent"], "people first");
  assert.equal(inRoom.capped, false);
  assert.deepEqual(inRoom.candidates.find((c) => c.id === world.reader.id), {
    type: "user", id: world.reader.id, name: world.reader.name, displayName: world.reader.displayName, avatarUrl: null, guest: false,
  });
  assert.deepEqual(keys(await candidates(app, world.who.reader, world.page, world.other.name)), [], "a member outside the home can't see it, even by name");
  assert.deepEqual(keys(await candidates(app, world.who.reader, world.page, world.agentZ.name)), []);

  // Widened to the server: every non-guest member and live agent, the home's members first.
  await setHome(world, world.page, { homeKind: "server", homeChannelId: null });
  const wide = await candidates(app, world.who.reader, world.page);
  assert.deepEqual(set(wide), new Set([world.owner, world.reader, world.other].map((p) => user(p.id)).concat([agent(world.agentA.id), agent(world.agentZ.id)])), "a guest can't see a server home");
  assert.equal((await call(app, mentionAudiencePaths.audience(), world.who.other, objectAudience(world.page))).status, 200, "witness: other sees it now");

  // Narrowed to #room again (as a narrowing move would): the next answer narrows, for everyone.
  await setHome(world, world.page, { homeKind: "conversation", homeChannelId: world.room.id });
  assert.deepEqual(set(await candidates(app, world.who.reader, world.page)), set(inRoom));
  assert.equal((await call(app, mentionAudiencePaths.audience(), world.who.other, objectAudience(world.page))).status, 404, "other can't see it any more");
});

// Only its owner finds a personal assistant (agentFindableBy): on a server
// home, where every live agent is offered, nobody else is offered it.
test("another person's assistant is never offered; its owner is offered it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const assistant = await createAgent(world.server.id, `mau-assistant-${label()}`, {
    runtime: "external", model: "external", creatorType: "user", creatorId: world.other.id, kind: "personal_assistant",
  });
  await getDb().update(agents).set({ assistantOwnerUserId: world.other.id }).where(eq(agents.id, assistant.id));
  await setHome(world, world.page, { homeKind: "server", homeChannelId: null });
  for (const viewer of [world.who.reader, world.who.owner]) {
    assert.equal(set(await candidates(app, viewer, world.page)).has(agent(assistant.id)), false, "not offered to another person");
    assert.deepEqual(keys(await candidates(app, viewer, world.page, assistant.name)), [], "not even by its handle");
  }
  assert.ok(set(await candidates(app, world.who.other, world.page)).has(agent(assistant.id)), "its owner is offered it");
});

test("the one 404: can't see it, unknown, deleted, another app's id, another server's reader, the app off", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const notFound = { error: "no such audience", code: "NOT_FOUND" };
  const refused = async (who: Who, body: unknown, why: string) => {
    const res = await call(app, mentionAudiencePaths.audience(), who, body);
    assert.equal(res.status, 404, `${why}: ${res.text}`);
    assert.deepEqual(res.body, notFound, why);
  };
  assert.equal((await call(app, mentionAudiencePaths.audience(), world.who.reader, objectAudience(world.page))).status, 200, "witness");
  await refused(world.who.other, objectAudience(world.page), "a member outside its home");
  await refused(world.who.gus, objectAudience(world.page), "a guest outside its home");
  await refused(world.who.reader, objectAudience(`pt_${randomUUID()}`), "no such Artifact");
  await refused(world.who.reader, objectAudience(world.page, { app: "not-artifacts" }), "the kind under another app's id");
  await refused(world.who.reader, objectAudience(world.page, { objectKind: "not-a-kind" }), "an unknown kind");
  // Public, but another server's reader names no one on it.
  await setHome(world, world.page, { homeKind: "public", homeChannelId: null });
  await refused(world.who.peerUser, objectAudience(world.page), "another server's reader");
  await setHome(world, world.page, { homeKind: "conversation", homeChannelId: world.room.id });
  // The app off.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  await refused(world.who.reader, objectAudience(world.page), "the app off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  assert.equal((await call(app, mentionAudiencePaths.audience(), world.who.reader, objectAudience(world.page))).status, 200, "witness: on again");
  // Deleted.
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, world.page));
  await refused(world.who.reader, objectAudience(world.page), "deleted");
});

test("a guest is offered only whom it meets, marked as a guest; a member is offered the guest too", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await setHome(world, world.page, { homeKind: "public", homeChannelId: null });
  const guest = await candidates(app, world.who.gus, world.page);
  assert.deepEqual(set(guest), new Set([user(world.gus.id), user(world.reader.id), agent(world.agentA.id)]));
  assert.equal(guest.candidates.find((c) => c.id === world.gus.id)!.guest, true);
  assert.deepEqual(keys(await candidates(app, world.who.gus, world.page, world.owner.name)), [], "not someone it doesn't meet, even by name");
  const member = await candidates(app, world.who.reader, world.page);
  assert.equal(member.candidates.find((c) => c.id === world.gus.id)?.guest, true);
  for (const id of [world.owner.id, world.other.id]) assert.ok(set(member).has(user(id)));
});

// A joint channel between the server and the peer (#68, xxchan): an
// Artifact homed there offers the joint's other servers' members as the
// joint's own messages do (its roster, without roles), each only while they
// can see the Artifact (in their server's projection); never on any other
// home, a public one included (another server's people read it there, but
// are no one it names).
test("an Artifact homed in a joint channel: the other server's members of the joint who can see it are offered too; not one outside the joint, nor on any other home", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const peerAgent = await createAgent(world.peer.id, `mau-p-${label()}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `mau-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addAgent(hostProjection.id, world.agentA.id);
  await addHuman(peerProjection.id, peerMember.id);
  await addAgent(peerProjection.id, peerAgent.id);
  const id = await world.publishIn(hostProjection);
  const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
  assert.equal(row!.homeChannelId, joint.canonical.id, "homed in the joint");
  const peers = [user(peerMember.id), agent(peerAgent.id)];

  const offered = await candidates(app, world.who.reader, id);
  for (const key of [user(world.reader.id), agent(world.agentA.id), ...peers]) assert.ok(set(offered).has(key), key);
  assert.ok(!set(offered).has(user(world.peerUser.id)), "the peer's person outside its projection can't see it");
  // The joint's members (both servers') first, people before agents.
  assert.deepEqual(new Set(keys(offered).slice(0, 4)), new Set([user(world.reader.id), user(peerMember.id), agent(world.agentA.id), agent(peerAgent.id)]));
  assert.deepEqual(offered.candidates.slice(0, 4).map((c) => c.type), ["user", "user", "agent", "agent"]);
  assert.deepEqual(offered.candidates.find((c) => c.id === peerMember.id), {
    type: "user", id: peerMember.id, name: peerMember.name, displayName: peerMember.displayName, avatarUrl: null, guest: false,
  }, "another server's person without its role");
  assert.deepEqual(keys(await candidates(app, world.who.reader, id, peerAgent.name)), [agent(peerAgent.id)], "q matches them too");
  // The web route answers the same.
  const route = await fetch(`${app.baseUrl}${artifactWebPaths.mentionCandidates(asArtifactId(id))}`, { headers: { Authorization: `Bearer ${world.who.reader.token}`, "X-Server-Id": world.server.id } });
  assert.equal(route.status, 200);
  const routeKeys = new Set(((await route.json()) as { candidates: Array<{ type: string; id: string }> }).candidates.map((c) => `${c.type}:${c.id}`));
  for (const key of peers) assert.ok(routeKeys.has(key), `route: ${key}`);
  // The peer's member names the joint's members who can see it, of both servers, as in the joint's messages (#68).
  const peerWho: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };
  const fromPeer = await call(app, mentionAudiencePaths.audience(), peerWho, objectAudience(id));
  assert.equal(fromPeer.status, 200, fromPeer.text);
  const peerOffered = new Set((fromPeer.body.candidates as Array<{ type: string; id: string }>).map((c) => `${c.type}:${c.id}`));
  for (const key of [user(world.reader.id), agent(world.agentA.id), agent(peerAgent.id)]) assert.ok(peerOffered.has(key), `from the peer: ${key}`);
  assert.ok(!peerOffered.has(user(world.peerUser.id)), "from the peer: not its person outside the joint");

  // Moved to the server, or public: nobody outside the server is offered.
  for (const home of [{ homeKind: "server" as const, homeChannelId: null }, { homeKind: "public" as const, homeChannelId: null }]) {
    await setHome(world, id, home);
    const elsewhere = set(await candidates(app, world.who.reader, id));
    for (const key of peers) assert.ok(!elsewhere.has(key), `${home.homeKind}: ${key}`);
  }
});

test("an object audience reads a constant number of queries however many people (2 vs 12)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const small = await createChannel(world.server.id, `mau-small-${label()}`, undefined, "private");
  const large = await createChannel(world.server.id, `mau-large-${label()}`, undefined, "private");
  const extra = [];
  for (let index = 0; index < 11; index += 1) {
    const human = await seed.human();
    await addMember(world.server.id, human.id);
    extra.push(human);
  }
  for (const human of [world.reader, world.owner]) await addHuman(small.id, human.id);
  for (const human of [world.reader, ...extra]) await addHuman(large.id, human.id);
  for (const channel of [small, large]) await addAgent(channel.id, world.agentA.id);
  const smallPage = await world.publishIn(small);
  const largePage = await world.publishIn(large);
  const reader = { userId: world.reader.id, serverId: asServerId(world.server.id) };
  const registered = { app: artifactsApp, objectKind: artifactsApp.objectKinds[0]! };
  const run = (objectId: string) => countQueries(() => mentionAudience(reader, { kind: "object", registered, objectId }, { q: "", limit: 200 }));
  const few = await run(smallPage);
  const many = await run(largePage);
  assert.equal(few.value!.candidates.filter((c) => c.type === "user").length, 2);
  assert.equal(many.value!.candidates.filter((c) => c.type === "user").length, 12);
  assert.equal(many.queries, few.queries, `queries: ${few.queries} for 2 people, ${many.queries} for 12`);
});

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as web.api.test.ts). */
async function countQueries<T>(fn: () => Promise<T>): Promise<{ queries: number; value: T }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let queries = 0;
  pg.query = ((...args: unknown[]) => {
    queries += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    const value = await fn();
    return { queries, value };
  } finally {
    pg.query = originalQuery;
  }
}
