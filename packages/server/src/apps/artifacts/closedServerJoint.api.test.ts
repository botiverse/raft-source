// A closed server's Artifact kept in a joint channel it is still in (the
// closed-server purge keeps it there, KeptChannels.apps) answers the same
// everywhere: read by the joint's participants on live servers (the viewer,
// its comments, the agent API, lists, search, Activity), never by anyone
// else, and read-only: every write is the one 403 FORBIDDEN
// (apiCommon CLOSED_SERVER_READ_ONLY_ERROR). Its other Artifacts stay unseen,
// and leaving the joint ends the reads (platform/visibility
// objectServersAnswer, closedServerJointObjects).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { artifactPublicPaths, artifactWebPaths, asArtifactId, objectActivityWebPaths, objectWebPaths, webSearchPath, type ObjectInboxItem } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channelAgents, channelHumans, servers } from "../../db/schema";
import { closedServerJointObjects } from "../../platform/visibility";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { addMember } from "../../services/serverService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import { accessTokenForTest } from "../../test/integration/credentials";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { CLOSED_SERVER_READ_ONLY_ERROR, itemsReadable } from "./apiCommon";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { isFollowing } from "./comments";
import { artifactAudit, artifactItems } from "./schema";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-closed-joint-tests-hmac-secret-0123456789");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);

function memoryR2(): ArtifactR2Store {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read(blob) {
      const bytes = objects.get(blob.r2Key);
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any; text: string };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who | null, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(who ? { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: json && text ? JSON.parse(text) : null, text };
}

async function agentCall(app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const text = (value: string) => ({ type: "text" as const, text: value });
const webComment = (value: string) => ({ body: [text(value)], version: 1, target: { scope: "artifact" }, replyTo: null });

/**
 * The host server (to be closed) and a peer server joined by a joint
 * channel: the host's agent A in its projection, the peer person `peer` and
 * the peer's agent in the peer's; `bystander`, a member of the peer server
 * outside the joint. A publishes `kept` in the joint and `own` in a private
 * room of the host; the host's owner makes `open` public. The peer follows
 * `kept` and A comments on it, so the peer has its Activity row.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  __setArtifactR2StoreForTests(memoryR2());
  const owner = await seed.human();
  const host = await seed.server({ owner });
  const peer = await seed.human();
  const bystander = await seed.human();
  const peerServer = await seed.server({ owner: peer, members: [bystander] });
  const agentA = await createAgent(host.id, `cj-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peerServer.id, `cj-p-${label()}`, { runtime: "claude", model: "sonnet" });
  const room = await createChannel(host.id, `room-${label()}`, undefined, "private");
  await addAgent(room.id, agentA.id);
  await addHuman(room.id, owner.id);
  const joint = await seedJointChannel({ name: `cj-joint-${label()}`, serverIds: [host.id, peerServer.id], createdByUserId: owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, agentA.id);
  await addHuman(peerProjection.id, peer.id);
  await addAgent(peerProjection.id, peerAgent.id);
  const mint = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `cj-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { a: await mint(agentA.id), peer: await mint(peerAgent.id) };
  const word = `zeppelin${label()}`;
  const push = async (target: string, title: string) => {
    const res = await agentCall(app, "POST", "/artifacts/push", keys.a, { target, title, files: [{ path: "index.md", content: `# ${title}` }] });
    assert.equal(res.status, 201, res.text);
    return asArtifactId(res.body.artifact.id as string);
  };
  const kept = await push(`#${hostProjection.name}`, `Kept ${word}`);
  const own = await push(`#${room.name}`, `Own ${word}`);
  const open = await push(`#${room.name}`, `Open ${word}`);
  const as = async (userId: string, serverId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId });
  const who = { owner: await as(owner.id, host.id), peer: await as(peer.id, peerServer.id), bystander: await as(bystander.id, peerServer.id) };
  assert.equal((await call(app, "POST", artifactWebPaths.home(open), who.owner, { to: "public" })).status, 200);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(kept), who.peer)).status, 200);
  const commented = await agentCall(app, "POST", `/artifacts/${kept}/comments`, keys.a, { body: "from the host" });
  assert.equal(commented.status, 201, commented.text);
  const close = () => getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, host.id));
  return { host, peerServer, owner, peer, bystander, agentA, peerAgent, keys, who, kept, own, open, word, hostProjection, peerProjection, close };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** What the joint's peer reads of `kept`, by every read path: each a status, and whether lists, search and Activity hold it. */
async function peerReads(app: { baseUrl: string }, world: World) {
  const { kept, who, keys } = world;
  const status = async (reply: Promise<Reply>) => (await reply).status;
  const ids = (reply: Reply, field: (body: any) => Array<{ id: string }>) => reply.status === 200 ? field(reply.body).map((entry) => entry.id) : [];
  const webList = await call(app, "GET", webSearchPath({ q: world.word, app: "artifacts" }), who.peer);
  const inbox = await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "all", limit: "100" })}`, who.peer);
  const agentComments = await agentCall(app, "GET", `/artifacts/${kept}/comments?all=1`, keys.peer);
  const webComments = await call(app, "GET", artifactWebPaths.comments(kept), who.peer);
  return {
    viewer: await status(call(app, "GET", artifactWebPaths.viewer(kept), who.peer)),
    file: await status(call(app, "GET", artifactWebPaths.fileContent(kept, "index.md"), who.peer)),
    webComments: webComments.status === 200 ? webComments.body.comments.length : webComments.status,
    agentRead: await status(agentCall(app, "GET", `/artifacts/${kept}`, keys.peer)),
    agentComments: agentComments.status === 200 ? agentComments.body.comments.length : agentComments.status,
    agentList: ids(await agentCall(app, "GET", `/artifacts?target=${encodeURIComponent(`#${world.peerProjection.name}`)}`, keys.peer), (body) => body.artifacts).includes(kept),
    agentSearch: ids(await agentCall(app, "GET", `/artifacts?query=${world.word}`, keys.peer), (body) => body.artifacts).includes(kept),
    webSearch: webList.status === 200 && webList.body.groups.some((group: { items: Array<{ card: { id: string } }> }) => group.items.some((item) => item.card.id === kept)),
    activity: inbox.status === 200 && (inbox.body.items as Array<{ kind: string }>).filter((item): item is ObjectInboxItem => item.kind === "object").some((row) => row.objectId === kept),
    summary: await (async () => {
      const reply = await call(app, "POST", objectWebPaths.summaries(), who.peer, { kind: "artifact", refs: [{ id: kept }] });
      return reply.status === 200 ? reply.body.summaries[0].ok : reply.text;
    })(),
  };
}

const READS = { viewer: 200, file: 200, webComments: 1, agentRead: 200, agentComments: 1, agentList: true, agentSearch: true, webSearch: true, activity: true };

/** Every write the joint's peer (a person and an agent) might try on `kept`, as [name, reply]. */
async function peerWrites(app: { baseUrl: string }, world: World): Promise<Array<[string, Reply]>> {
  const { kept, who, keys } = world;
  // The agent has read the comments, so none holds its own back (UNSEEN_CHANGES); its writes go first.
  assert.equal((await agentCall(app, "GET", `/artifacts/${kept}`, keys.peer)).status, 200);
  assert.equal((await agentCall(app, "GET", `/artifacts/${kept}/comments`, keys.peer)).status, 200);
  return [
    ["agent comment", await agentCall(app, "POST", `/artifacts/${kept}/comments`, keys.peer, { body: "from the peer's agent" })],
    ["agent review", await agentCall(app, "POST", `/artifacts/${kept}/reviews`, keys.peer, { body: "overall", comments: [{ body: "a point" }] })],
    ["agent follow", await agentCall(app, "PUT", `/artifacts/${kept}/subscription`, keys.peer)],
    ["agent push", await agentCall(app, "POST", "/artifacts/push", keys.peer, { artifact: kept, base: 1, files: [{ path: "index.md", content: "# peer" }] })],
    ["agent move", await agentCall(app, "POST", `/artifacts/${kept}/home`, keys.peer, { to: "server" })],
    ["agent delete", await agentCall(app, "DELETE", `/artifacts/${kept}`, keys.peer)],
    ["web comment", await call(app, "POST", artifactWebPaths.comments(kept), who.peer, webComment("from the peer"))],
    ["web follow", await call(app, "PUT", artifactWebPaths.subscription(kept), who.peer)],
    ["web rename", await call(app, "PATCH", artifactWebPaths.title(kept), who.peer, { title: "Renamed" })],
    ["web move", await call(app, "POST", artifactWebPaths.home(kept), who.peer, { to: "server" })],
    ["web delete", await call(app, "DELETE", artifactWebPaths.artifact(kept), who.peer)],
  ];
}

test("a closed server's Artifact kept in a joint it is still in: the joint's peer reads it everywhere (viewer, comments, agent API, lists, search, Activity) and writes nothing; the one refusal", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { kept } = world;
  // Live: the peer reads it and takes part (the witness: the same reads before and after).
  const { summary: liveSummary, ...live } = await peerReads(app, world);
  assert.deepEqual(live, READS, "live: every read");
  const liveComment = await call(app, "POST", artifactWebPaths.comments(kept), world.who.peer, webComment("while live"));
  assert.equal(liveComment.status, 201, liveComment.text);
  assert.equal((await agentCall(app, "PUT", `/artifacts/${kept}/subscription`, world.keys.peer)).status, 200, "the peer's agent follows it while live");
  // A newer event from the host: the peer's Activity row is unread when the server closes.
  assert.equal((await agentCall(app, "GET", `/artifacts/${kept}/comments`, world.keys.a)).status, 200);
  assert.equal((await agentCall(app, "POST", `/artifacts/${kept}/comments`, world.keys.a, { body: "last word" })).status, 201);
  const peerRow = async () => (await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "all", limit: "100" })}`, world.who.peer)).body.items
    .filter((item: { kind: string }): item is ObjectInboxItem => item.kind === "object").find((row: ObjectInboxItem) => row.objectId === kept);

  await world.close();

  assert.ok((await peerRow())!.unreadCount > 0, "closed: its row unread");
  const { summary, ...closed } = await peerReads(app, world);
  // Opening it read it (the reader's own read position, as for a live Artifact).
  assert.equal((await peerRow())!.unreadCount, 0, "opening it read the row");
  assert.deepEqual(closed, { ...READS, webComments: 3, agentComments: 3 }, "closed: the same reads, its comments included");
  assert.deepEqual([liveSummary, summary], [true, true], "its card in a message answers as before");
  // The viewer offers no write.
  const viewer = await call(app, "GET", artifactWebPaths.viewer(kept), world.who.peer);
  assert.deepEqual(viewer.body.capabilities, { publish: false, comment: false, changeHome: false, unpublish: false, narrowHome: false, delete: false });

  // Every write: the one 403, its one sentence.
  for (const [name, reply] of await peerWrites(app, world)) {
    assert.deepEqual([reply.status, reply.body?.code, reply.body?.error], [403, "FORBIDDEN", CLOSED_SERVER_READ_ONLY_ERROR], `${name}: ${reply.text}`);
  }
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, kept));
  assert.equal(item!.title.startsWith("Kept"), true, "nothing changed");
  assert.equal(item!.deletedAt, null);
  assert.equal(item!.homeKind, "conversation");

  // Its own state stays the reader's: unfollowing (never following again) and Done.
  assert.equal(viewer.body.following, true, "the peer still follows it");
  const webUnfollow = await call(app, "DELETE", artifactWebPaths.subscription(kept), world.who.peer);
  assert.deepEqual([webUnfollow.status, webUnfollow.body], [200, { following: false }], webUnfollow.text);
  assert.equal(await isFollowing(kept, { type: "user", id: world.peer.id }), false, "the person's follow stopped");
  const agentUnfollow = await agentCall(app, "DELETE", `/artifacts/${kept}/subscription`, world.keys.peer);
  assert.deepEqual([agentUnfollow.status, agentUnfollow.body.following], [200, false], agentUnfollow.text);
  assert.equal(await isFollowing(kept, { type: "agent", id: world.peerAgent.id }), false, "the agent's follow stopped");
  const done = await call(app, "POST", objectActivityWebPaths.done(), world.who.peer, { kind: "artifact", objectId: kept });
  assert.equal(done.status, 200, done.text);
  assert.equal(await peerRow(), undefined, "Done hides its row");

  // Nobody acts from the closed server itself.
  assert.notEqual((await agentCall(app, "GET", `/artifacts/${kept}`, world.keys.a)).status, 200, "the closed server's agent");
  assert.notEqual((await call(app, "GET", artifactWebPaths.viewer(kept), world.who.owner)).status, 200, "the closed server's owner");
});

test("a closed server's Artifacts: a non-participant never sees the kept one; one in its own channel, or public, stays unseen; leaving the joint ends the reads", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { kept, own, open } = world;
  // Live witnesses: the bystander sees the public one only; the peer sees the public one too.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(kept), world.who.bystander)).status, 404);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(open), world.who.peer)).status, 200, "live: another server's public Artifact");
  assert.equal((await call(app, "GET", artifactPublicPaths.view(open), null)).status, 200, "live: signed out");
  const rows = await getDb().select().from(artifactItems).where(sql`${artifactItems.id} IN (${kept}, ${own}, ${open})`);
  const byId = (id: string) => rows.find((row) => row.id === id)!;
  const items = [byId(kept), byId(own), byId(open)];
  assert.deepEqual(await itemsReadable(items), [true, true, true]);
  assert.deepEqual(await closedServerJointObjects(items), [false, false, false], "live: none");

  await world.close();

  assert.deepEqual(await closedServerJointObjects(items), [true, false, false], "only the joint's");
  assert.deepEqual(await itemsReadable(items), [true, false, false], "read: only the joint's");
  // The bystander (the peer server's, outside the joint): nothing, by any path.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(kept), world.who.bystander)).status, 404);
  assert.equal((await call(app, "POST", artifactWebPaths.comments(kept), world.who.bystander, webComment("hi"))).status, 404, "a write is the one 404, not the read-only 403");
  const search = await call(app, "GET", webSearchPath({ q: world.word, app: "artifacts" }), world.who.bystander);
  assert.ok(!JSON.stringify(search.body ?? {}).includes(kept), search.text);
  // The public one and the own-channel one: unseen by everyone.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(open), world.who.peer)).status, 404, "another server's public Artifact, its server closed");
  assert.equal((await call(app, "GET", artifactPublicPaths.view(open), null)).status, 404, "signed out");
  assert.equal((await agentCall(app, "GET", `/artifacts/${own}`, world.keys.peer)).status, 404);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(kept), world.who.peer)).status, 200, "witness: the joint's");

  // The closed server's copy disconnected: the kept Artifact is an orphan of it, read by no one.
  await getDb().execute(sql`UPDATE joint_channel_servers SET status = 'disconnected' WHERE server_id = ${world.host.id}`);
  assert.deepEqual(await closedServerJointObjects(items), [false, false, false]);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(kept), world.who.peer)).status, 404);
  assert.equal((await agentCall(app, "GET", `/artifacts/${kept}`, world.keys.peer)).status, 404);
  const listed = await agentCall(app, "GET", `/artifacts?query=${world.word}`, world.keys.peer);
  assert.deepEqual(listed.body.artifacts, [], listed.text);
});

test("a live server's Artifact in a joint: unchanged, the peer comments and follows", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const writes = await peerWrites(app, world);
  const status = Object.fromEntries(writes.map(([name, reply]) => [name, reply.status]));
  // Only the Artifact's own server publishes, moves, renames and deletes it; the joint's peer comments, reviews and follows.
  assert.deepEqual(status, {
    "web comment": 201,
    "web follow": 200,
    "web rename": 403,
    "web move": 403,
    "web delete": 403,
    "agent comment": 201,
    "agent review": 201,
    "agent follow": 200,
    "agent push": 403,
    "agent move": 403,
    "agent delete": 403,
  });
  for (const [name, reply] of writes) assert.notEqual(reply.body?.error, CLOSED_SERVER_READ_ONLY_ERROR, name);
});

/**
 * A closed server's Artifact kept in a joint is moderated by the joint
 * channel's managers on its host, by takedown and restore only (takedown.ts): the
 * joint is hosted by H (live), C (to be closed) publishes in it, P is another
 * live participant. In the joint: H's owner, an H admin, an H member
 * appointed manager of H's copy, a plain H member, H's agent appointed
 * manager of H's copy; P's owner and a P member appointed manager of P's
 * copy. Outside it: an H admin and a P member. C's agent publishes `taken`,
 * `deleted` and `other` there.
 */
async function seedHostedJoint(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  __setArtifactR2StoreForTests(memoryR2());
  const [hostOwner, hostAdmin, hostManager, hostMember, hostAbsentAdmin, closedOwner, peerOwner, peerManager, bystander] =
    await Promise.all(Array.from({ length: 9 }, () => seed.human()));
  const host = await seed.server({ owner: hostOwner!, members: [hostManager!, hostMember!] });
  await addMember(host.id, hostAdmin!.id, "admin");
  await addMember(host.id, hostAbsentAdmin!.id, "admin");
  const closed = await seed.server({ owner: closedOwner! });
  const peerServer = await seed.server({ owner: peerOwner!, members: [peerManager!, bystander!] });
  const author = await createAgent(closed.id, `kj-c-${label()}`, { runtime: "claude", model: "sonnet" });
  const hostAgent = await createAgent(host.id, `kj-h-${label()}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `kj-joint-${label()}`, serverIds: [host.id, closed.id, peerServer.id], createdByUserId: hostOwner!.id });
  const [hostCopy, closedCopy, peerCopy] = joint.projections as [typeof joint.canonical, typeof joint.canonical, typeof joint.canonical];
  for (const person of [hostOwner, hostAdmin, hostManager, hostMember]) await addHuman(hostCopy.id, person!.id);
  for (const person of [peerOwner, peerManager]) await addHuman(peerCopy.id, person!.id);
  await addAgent(closedCopy.id, author.id);
  await addAgent(hostCopy.id, hostAgent.id);
  await getDb().update(channelHumans).set({ role: "admin" }).where(and(eq(channelHumans.channelId, hostCopy.id), eq(channelHumans.userId, hostManager!.id)));
  await getDb().update(channelHumans).set({ role: "admin" }).where(and(eq(channelHumans.channelId, peerCopy.id), eq(channelHumans.userId, peerManager!.id)));
  await getDb().update(channelAgents).set({ role: "admin" }).where(and(eq(channelAgents.channelId, hostCopy.id), eq(channelAgents.agentId, hostAgent.id)));
  const mint = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `kj-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { author: await mint(author.id), hostAgent: await mint(hostAgent.id) };
  const push = async (title: string) => {
    const res = await agentCall(app, "POST", "/artifacts/push", keys.author, { target: `#${closedCopy.name}`, title, files: [{ path: "index.md", content: `# ${title}` }] });
    assert.equal(res.status, 201, res.text);
    return asArtifactId(res.body.artifact.id as string);
  };
  const ids = { taken: await push("Taken"), deleted: await push("Deleted"), other: await push("Other") };
  const as = async (userId: string, serverId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId });
  const who = {
    hostOwner: await as(hostOwner!.id, host.id),
    hostAdmin: await as(hostAdmin!.id, host.id),
    hostManager: await as(hostManager!.id, host.id),
    hostMember: await as(hostMember!.id, host.id),
    hostAbsentAdmin: await as(hostAbsentAdmin!.id, host.id),
    peerOwner: await as(peerOwner!.id, peerServer.id),
    peerManager: await as(peerManager!.id, peerServer.id),
    bystander: await as(bystander!.id, peerServer.id),
  };
  const close = () => getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, closed.id));
  return { host, closed, peerServer, hostCopy, keys, who, ids, users: { hostAdmin: hostAdmin!, hostManager: hostManager!, hostOwner: hostOwner! }, close };
}

const reason = { reason: "reported: not for this channel" };
const auditOf = (itemId: string, action: string) =>
  getDb().select().from(artifactAudit).where(and(eq(artifactAudit.itemId, itemId), eq(artifactAudit.action, action)));

test("a closed server's Artifact kept in a joint: the joint's managers on its host take it down and restore it for everyone, audited; nobody else, and nothing else, a delete included", async ({ app, seed }) => {
  const world = await seedHostedJoint(seed, app);
  const { ids, who } = world;
  // Live: the host's managers manage nothing of C's Artifact (only its own server does).
  const liveTakedown = await call(app, "POST", artifactWebPaths.takedown(ids.taken), who.hostOwner, reason);
  assert.equal(liveTakedown.status, 403, liveTakedown.text);
  assert.notEqual(liveTakedown.body.error, CLOSED_SERVER_READ_ONLY_ERROR);
  assert.equal((await call(app, "DELETE", artifactWebPaths.artifact(ids.deleted), who.hostOwner)).status, 403, "live: delete");
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(ids.taken), who.hostOwner)).body.capabilities.delete, false, "live: no delete offered");

  await world.close();

  // Refused: another participant's owner and appointed manager, a plain host member (the one read-only 403); the host's appointed agent (people only); outsiders (the one 404).
  const readOnly = [403, "FORBIDDEN", CLOSED_SERVER_READ_ONLY_ERROR];
  for (const [name, by] of [["peer owner", who.peerOwner], ["peer manager", who.peerManager], ["host member", who.hostMember]] as const) {
    const takedown = await call(app, "POST", artifactWebPaths.takedown(ids.taken), by, reason);
    assert.deepEqual([takedown.status, takedown.body?.code, takedown.body?.error], readOnly, `${name} takedown: ${takedown.text}`);
    const deleted = await call(app, "DELETE", artifactWebPaths.artifact(ids.deleted), by);
    assert.deepEqual([deleted.status, deleted.body?.code, deleted.body?.error], readOnly, `${name} delete: ${deleted.text}`);
    assert.equal((await call(app, "GET", artifactWebPaths.viewer(ids.taken), by)).body.capabilities.delete, false, `${name}: no delete offered`);
  }
  const agentDelete = await agentCall(app, "DELETE", `/artifacts/${ids.deleted}`, world.keys.hostAgent);
  assert.deepEqual([agentDelete.status, agentDelete.body?.error], [403, CLOSED_SERVER_READ_ONLY_ERROR], `host's appointed agent: ${agentDelete.text}`);
  for (const [name, by] of [["bystander", who.bystander], ["host admin outside the channel", who.hostAbsentAdmin]] as const) {
    assert.equal((await call(app, "POST", artifactWebPaths.takedown(ids.taken), by, reason)).status, 404, `${name} takedown`);
    assert.equal((await call(app, "DELETE", artifactWebPaths.artifact(ids.deleted), by)).status, 404, `${name} delete`);
  }
  assert.equal((await auditOf(ids.taken, "taken_down")).length + (await auditOf(ids.deleted, "deleted")).length, 0, "nothing written by the refused");

  // Every other write stays the read-only 403, for the host's managers too: a delete included (Tenny: takedown and restore only).
  for (const [name, by] of [["host owner", who.hostOwner], ["host admin", who.hostAdmin], ["host manager", who.hostManager]] as const) {
    const deleted = await call(app, "DELETE", artifactWebPaths.artifact(ids.deleted), by);
    assert.deepEqual([deleted.status, deleted.body?.code, deleted.body?.error], readOnly, `${name} delete: ${deleted.text}`);
    assert.equal((await call(app, "GET", artifactWebPaths.viewer(ids.deleted), by)).body.capabilities.delete, false, `${name}: no delete offered`);
  }
  const [undeleted] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, ids.deleted));
  assert.equal(undeleted!.deletedAt, null, "no delete went through");
  assert.equal((await auditOf(ids.deleted, "deleted")).length, 0);
  for (const [name, reply] of [
    ["comment", await call(app, "POST", artifactWebPaths.comments(ids.other), who.hostOwner, webComment("hi"))],
    ["rename", await call(app, "PATCH", artifactWebPaths.title(ids.other), who.hostOwner, { title: "Renamed" })],
    ["move", await call(app, "POST", artifactWebPaths.home(ids.other), who.hostOwner, { to: "server" })],
    ["follow", await call(app, "PUT", artifactWebPaths.subscription(ids.other), who.hostOwner)],
  ] as const) {
    assert.deepEqual([reply.status, reply.body?.error], [403, CLOSED_SERVER_READ_ONLY_ERROR], `${name}: ${reply.text}`);
  }

  // A host admin takes it down: gone for every participant; audited with the host's copy.
  const takenDown = await call(app, "POST", artifactWebPaths.takedown(ids.taken), who.hostAdmin, reason);
  assert.deepEqual([takenDown.status, takenDown.body?.takenDown, takenDown.body?.changed], [200, true, true], takenDown.text);
  for (const by of [who.peerOwner, who.hostMember, who.hostAdmin]) assert.equal((await call(app, "GET", artifactWebPaths.viewer(ids.taken), by)).status, 404);
  const jointManager = { server_id: world.host.id, channel_id: world.hostCopy.id };
  const [down] = await auditOf(ids.taken, "taken_down");
  assert.deepEqual([down!.actorType, down!.actorId, down!.after?.reason, down!.after?.joint_manager], ["user", world.users.hostAdmin.id, reason.reason, jointManager]);
  // The host's appointed manager restores it.
  const restored = await call(app, "POST", artifactWebPaths.restore(ids.taken), who.hostManager, reason);
  assert.deepEqual([restored.status, restored.body?.takenDown], [200, false], restored.text);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(ids.taken), who.peerOwner)).status, 200, "back for the peer");
  const [back] = await auditOf(ids.taken, "restored");
  assert.deepEqual([back!.actorId, back!.after?.joint_manager], [world.users.hostManager.id, jointManager]);

  // And the host's owner takes the last one down.
  assert.equal((await call(app, "POST", artifactWebPaths.takedown(ids.other), who.hostOwner, reason)).status, 200);
  const [ownerDown] = await auditOf(ids.other, "taken_down");
  assert.equal(ownerDown!.actorId, world.users.hostOwner.id);
});
