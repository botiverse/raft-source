// The web API, phase 1 (viewer, files, comments, will-notify, mention
// candidates, following, presence), core's object summaries for
// Artifacts (`POST /api/objects/summaries`) and the dashboard (S7) over HTTP
// with real user tokens, at the
// paths the shared contract builds (artifactWebPaths). Proves for every route
// the flag gate and the one 404, each payload against the contract, and the
// rules the contract states: paging, edit and delete by the author only, the
// deleted-with-replies placeholder, mentions checked (and on an edit only the
// added ones, each checked again), a person's comment telling agents and
// following as an agent's does, the bytes' headers, and file content only
// for text and csv, and renaming (task #147: the title route, who may, and
// who is told).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import {
  ARTIFACT_COMMENT_MAX_CHARS,
  BasicTracer,
  MemoryTraceSink,
  OBJECT_SUMMARIES_MAX_ID_CHARS,
  OBJECT_SUMMARIES_MAX_REFS,
  artifactLinkId,
  artifactPublicPaths,
  artifactWebPaths,
  objectWebPaths,
  webSearchPath,
  asArtifactCommentId,
  asArtifactId,
  asServerId,
  type AgentMessage,
  type ArtifactAgentAppEvent,
  type ArtifactId,
  type ServerId,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { agents, attachmentObjects, attachments, channels, objectEventRecipients, objectEvents, serverMembers, servers, thirdPartyAgentEvents } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM, removeAgent, removeHuman } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createMessage } from "../../services/messageService";
import { buildSystemAppAgentMessage } from "../../services/systemAppAgentEvents";
import { addMember } from "../../services/serverService";
import { objectSummaries } from "../../services/objectSummaries";
import { __setFlagReadCacheTtlForTests } from "../../services/featureFlagReadCache";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { artifactsApp } from "./register";
import { createArtifactWebApi } from "./webRoutes";
import { createViewerOperations } from "./webViewer";
import { webFileNotFound, webInvalidPath, webNotVisible, webVersionNotFound } from "./webCommon";
import { mayManageArtifactActions } from "./manage";
import { mayRename } from "./rename";
import type { ServerViewActor } from "../../platform/visibility";
import { ARTIFACT_OPS_IMPORT_ACTOR } from "./import";
import {
  artifactAttachmentSaves,
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactPendingNotices,
  artifactReadPositions,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
} from "./schema";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.write": 2, "artifacts.mentionCandidates": 2, "artifacts.dashboard": 2, "objects.summaries": 2 } });
/** The Artifacts notice a message carries (AgentMessage.app_event). */
const appEventOf = (message: AgentMessage): ArtifactAgentAppEvent | undefined => message.app_event as ArtifactAgentAppEvent | undefined;

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-web-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);
/** The one 404 every route answers for an Artifact the reader can't open, whatever the reason (webCommon webNotVisible). */
const NOT_VISIBLE = webNotVisible().body;

// ---- seeding -------------------------------------------------------------------

type Actor = { type: "user" | "agent"; id: string };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
  };
}

async function insertItem(input: { serverId: ServerId; homeChannelId?: string; serverHome?: boolean; author: Actor; deleted?: boolean; revoked?: boolean }) {
  const id = `pt_${randomUUID()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    description: "what it is",
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  }).returning();
  return row!;
}

/** A published version (current), its files r2 blobs of the server kept in `r2`. */
async function publish(world: { serverId: ServerId; r2: Map<string, Buffer> }, publisher: Actor, input: { itemId: string; number: number; files: Array<{ path: string; bytes: Buffer }> }) {
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId,
    itemId: input.itemId,
    number: input.number,
    entry: input.files[0]!.path,
    fileCount: input.files.length,
    sizeBytes: input.files.reduce((sum, file) => sum + file.bytes.length, 0),
    publishDigest: "digest",
    status: "published",
    publisherType: publisher.type,
    publisherId: publisher.id,
    position: input.number,
  }).returning();
  for (const file of input.files) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    let [blob] = await db.select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha256)));
    if (!blob) {
      const blobId = `b_${randomUUID()}`;
      [blob] = await db.insert(artifactBlobs).values({
        id: blobId, serverId: world.serverId, sha256, sizeBytes: file.bytes.length, r2Key: r2KeyOf(world.serverId, sha256, blobId),
      }).returning();
      world.r2.set(blob!.r2Key!, file.bytes);
    }
    await db.insert(artifactVersionFiles).values({ versionId, path: file.path, sha256, sizeBytes: file.bytes.length, blobId: blob!.id });
  }
  await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: input.number }).where(eq(artifactItems.id, input.itemId));
  return version!;
}

/**
 * A server (Artifacts on unless `enabled: false`) with #priv (owner, reader, agents
 * A, B, C) and #other (owner only); outsider a member in neither; agentOut an
 * agent in neither; a peer server whose only member is peerUser. Artifacts:
 * page in #priv by agent A (v1, v2 current; A follows it, as a publisher),
 * secret in #other, deleted and revoked in #priv, memo public (v1, v2).
 * Notices pushed through the test
 * app's orchestrator land in `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { app: { get(key: string): unknown } }, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const agent = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentA = await agent("wa-a");
  const agentB = await agent("wa-b");
  const agentC = await agent("wa-c");
  const agentOut = await agent("wa-out");
  const priv = await createChannel(server.id, `web-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  for (const a of [agentA, agentB, agentC]) await addAgent(priv.id, a.id);
  const other = await createChannel(server.id, `web-other-${label()}`, undefined, "private");
  await addHuman(other.id, owner.id);

  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const world0 = { serverId, r2 };
  const byA: Actor = { type: "agent", id: agentA.id };
  const page = await insertItem({ serverId, homeChannelId: priv.id, author: byA });
  const v1 = await publish(world0, byA, { itemId: page.id, number: 1, files: [
    { path: "index.html", bytes: Buffer.from("<h1>v1</h1>") },
    { path: "assets/logo.png", bytes: PNG },
    { path: "data.csv", bytes: Buffer.from("a,b\n1,2\n") },
    { path: "notes.txt", bytes: Buffer.from("hello notes") },
  ] });
  const v2 = await publish(world0, byA, { itemId: page.id, number: 2, files: [
    { path: "index.html", bytes: Buffer.from("<h1>v2</h1><script>alert(1)</script>") },
    { path: "assets/logo.png", bytes: PNG },
    { path: "data.csv", bytes: Buffer.from("a,b\n1,2\n") },
    { path: "notes.txt", bytes: Buffer.from("hello notes, again") },
  ] });
  await getDb().insert(artifactSubscriptions).values({ itemId: page.id, actorType: "agent", actorId: agentA.id, reason: "published" });
  const secret = await insertItem({ serverId, homeChannelId: other.id, author: byA });
  await publish(world0, byA, { itemId: secret.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("secret") }] });
  const deleted = await insertItem({ serverId, homeChannelId: priv.id, author: byA, deleted: true });
  await publish(world0, byA, { itemId: deleted.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("gone") }] });
  const revoked = await insertItem({ serverId, homeChannelId: priv.id, author: byA, revoked: true });
  await publish(world0, byA, { itemId: revoked.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("revoked") }] });
  const drawing = await insertItem({ serverId, homeChannelId: priv.id, author: byA });
  await publish(world0, byA, { itemId: drawing.id, number: 1, files: [{ path: "d.svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") }] });
  const memo = await insertItem({ serverId, author: byA });
  await publish(world0, byA, { itemId: memo.id, number: 1, files: [{ path: "memo.txt", bytes: Buffer.from("memo v1") }] });
  await publish(world0, byA, { itemId: memo.id, number: 2, files: [{ path: "memo.txt", bytes: Buffer.from("memo v2") }] });

  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, serverId, peer, owner, reader, outsider, peerUser, agentA, agentB, agentC, agentOut, priv, other, r2, delivered, orchestrator,
    items: { page, secret, deleted, revoked, memo, drawing },
    versions: { v1, v2 },
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id), peerUser: await as(peerUser.id, peer.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

// ---- HTTP ------------------------------------------------------------------------

type Who = { token: string; serverId: string };
type Reply = { status: number; headers: Headers; bytes: Buffer; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, headers: res.headers, bytes, body: json ? JSON.parse(bytes.toString("utf8")) : null };
}

const id = (row: { id: string }): ArtifactId => asArtifactId(row.id);
const text = (value: string) => ({ type: "text" as const, text: value });
const mention = (actor: { id: string }, type: "user" | "agent") => ({ type: "mention" as const, actor: { type, id: actor.id } });
const commentInput = (body: unknown[], extra: Record<string, unknown> = {}) => ({ body, version: 2, target: { scope: "artifact" }, replyTo: null, ...extra });
const userActor = (user: { id: string; name: string }) => ({ type: "user", id: user.id, name: user.name, displayName: user.name, avatarUrl: null });
const agentActor = (agent: { id: string; name: string; displayName: string | null; avatarUrl: string | null }) =>
  ({ type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName || agent.name, avatarUrl: agent.avatarUrl });

/** Every phase-1 route of an Artifact, as [method, path, body]. */
function routesOf(artifact: ArtifactId): Array<[string, string, unknown?]> {
  const commentId = asArtifactCommentId(`c_${randomUUID()}`);
  return [
    ["GET", artifactWebPaths.viewer(artifact)],
    ["GET", artifactWebPaths.details(artifact)],
    ["GET", artifactWebPaths.file(artifact, "index.html")],
    ["GET", artifactWebPaths.fileContent(artifact, "index.html")],
    ["GET", artifactWebPaths.comments(artifact)],
    ["POST", artifactWebPaths.comments(artifact), commentInput([text("hi")])],
    ["PATCH", artifactWebPaths.comment(artifact, commentId), { body: [text("edited")] }],
    ["DELETE", artifactWebPaths.comment(artifact, commentId)],
    ["GET", artifactWebPaths.willNotify(artifact)],
    ["GET", artifactWebPaths.mentionCandidates(artifact, { q: "a" })],
    ["GET", artifactWebPaths.presence(artifact)],
    ["PUT", artifactWebPaths.subscription(artifact)],
    ["DELETE", artifactWebPaths.subscription(artifact)],
    ["PATCH", artifactWebPaths.title(artifact), { title: "Renamed" }],
  ];
}

const commentsOf = (itemId: string) => getDb().select().from(artifactComments).where(eq(artifactComments.itemId, itemId));
const objectEventsOf = (itemId: string, eventKind: string) => getDb().select().from(objectEvents)
  .where(and(eq(objectEvents.objectId, itemId), eq(objectEvents.eventKind, eventKind))).orderBy(objectEvents.seq);
const recipientsOf = async (eventId: string) => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, eventId)))
  .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
const subscriptionOf = async (itemId: string, actor: Actor) => (await getDb().select().from(artifactSubscriptions).where(and(
  eq(artifactSubscriptions.itemId, itemId), eq(artifactSubscriptions.actorType, actor.type), eq(artifactSubscriptions.actorId, actor.id),
)))[0] ?? null;
const noticesTo = (world: World, agentId: string) => world.delivered.filter((entry) => entry.agentId === agentId).map((entry) => entry.message);
const post = (app: { baseUrl: string }, world: World, who: Who, input: unknown, item = world.items.page) => call(app, "POST", artifactWebPaths.comments(id(item)), who, input);

// ---- the gates -------------------------------------------------------------------

test("Artifacts off: every route answers 403 ARTIFACTS_NOT_ENABLED and writes nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app, { enabled: false });
  for (const [method, path, body] of routesOf(id(world.items.page))) {
    const res = await call(app, method, path, world.who.reader, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", `${method} ${path}`);
  }
  // A path that doesn't decode is answered after that gate too.
  const undecodable = await call(app, "GET", `/api/artifacts/${world.items.page.id}/files/%E0%A4%A`, world.who.reader);
  assert.equal(undecodable.status, 403);
  assert.equal(undecodable.body.code, "ARTIFACTS_NOT_ENABLED");
  assert.equal((await commentsOf(world.items.page.id)).length, 0);
  assert.equal(await subscriptionOf(world.items.page.id, { type: "user", id: world.reader.id }), null);
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, world.items.page.id))).length, 0);
});

test("what the reader can't see is one 404 NOT_VISIBLE on every route, the same body whatever the reason", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, secret, deleted, revoked } = world.items;
  const cases: Array<[Who, string]> = [
    [world.who.outsider, page.id],
    [world.who.peerUser, page.id],
    [world.who.reader, secret.id],
    [world.who.reader, deleted.id],
    [world.who.reader, revoked.id],
    [world.who.reader, `pt_${randomUUID()}`],
    [world.who.reader, "not-an-id"],
  ];
  for (const [who, artifact] of cases) {
    const undecodable = await call(app, "GET", `/api/artifacts/${encodeURIComponent(artifact)}/files/%E0%A4%A`, who);
    assert.equal(undecodable.status, 404, `undecodable path of ${artifact}`);
    assert.deepEqual(undecodable.body, NOT_VISIBLE);
    for (const [method, path, body] of routesOf(asArtifactId(artifact))) {
      const res = await call(app, method, path, who, body);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(res.body, NOT_VISIBLE, `${method} ${path}`);
    }
  }
  assert.equal((await commentsOf(page.id)).length, 0);
  // Witness: the reader sees the page.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).status, 200);
});

limitedTest("writes are limited per user (429 RATE_LIMITED past the limit, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const path = artifactWebPaths.subscription(id(world.items.page));
  assert.equal((await call(app, "PUT", path, world.who.reader)).status, 200);
  assert.equal((await call(app, "DELETE", path, world.who.reader)).status, 200);
  const third = await call(app, "PUT", path, world.who.reader);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "RATE_LIMITED");
  assert.equal((await call(app, "PUT", path, world.who.owner)).status, 200, "another user's own budget");
  // Reads are not limited by it.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(world.items.page)), world.who.reader)).status, 200);
  // `@` candidates have their own budget (asked per keystroke).
  const candidates = artifactWebPaths.mentionCandidates(id(world.items.page), { q: "a" });
  assert.equal((await call(app, "GET", candidates, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", candidates, world.who.reader)).status, 200);
  const limited = await call(app, "GET", candidates, world.who.reader);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await call(app, "GET", candidates, world.who.owner)).status, 200, "another user's own budget");
});

// ---- the viewer ------------------------------------------------------------------

test("viewer: the current version as ArtifactViewerData; opening it moves the reader's read position", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const res = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, page.id));
  const a = agentActor(world.agentA);
  assert.deepEqual(res.body, {
    card: {
      id: page.id,
      url: `${getAppUrl()}/artifacts/${artifactLinkId(id(page))}`,
      title: page.title,
      description: "what it is",
      kind: "html",
      facts: { sizeBytes: world.versions.v2.sizeBytes, fileCount: 4 },
      preview: { kind: "none" },
      version: 2,
      pinned: false,
      latestVersion: 2,
      author: a,
      createdAt: item!.createdAt.toISOString(),
      updatedAt: item!.updatedAt.toISOString(),
      commentCount: 0,
      home: { kind: "conversation", conversation: { id: world.priv.id, name: world.priv.name, type: "private" } },
    },
    files: [
      { path: "assets/logo.png", kind: "image", sizeBytes: PNG.length, entry: false },
      { path: "data.csv", kind: "csv", sizeBytes: 8, entry: false },
      { path: "index.html", kind: "html", sizeBytes: world.versions.v2.sizeBytes - PNG.length - 8 - 18, entry: true },
      { path: "notes.txt", kind: "text", sizeBytes: 18, entry: false },
    ],
    versions: [
      { number: 2, publisher: a, createdAt: world.versions.v2.createdAt.toISOString(), note: null, changedPaths: ["index.html", "notes.txt"] },
      { number: 1, publisher: a, createdAt: world.versions.v1.createdAt.toISOString(), note: null, changedPaths: ["assets/logo.png", "data.csv", "index.html", "notes.txt"] },
    ],
    capabilities: { publish: true, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: false },
    viewer: userActor(world.reader),
    following: false,
    savedFrom: null,
    origin: null,
    originalHome: null,
  });
  const [position] = await getDb().select().from(artifactReadPositions).where(and(eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorId, world.reader.id)));
  assert.equal(position!.position, item!.lastPosition);
});

test("details: the viewer's answer without moving the read position, `?version=` as the viewer's", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const positionOf = async () => (await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorId, world.reader.id))))[0] ?? null;
  const details = await call(app, "GET", artifactWebPaths.details(id(page)), world.who.reader);
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.headers.get("cache-control"), "private, no-store");
  assert.equal(await positionOf(), null, "no read position moved");
  const older = await call(app, "GET", artifactWebPaths.details(id(page), 1), world.who.reader);
  assert.equal(older.status, 200);
  assert.equal(older.body.card.version, 1);
  assert.equal(older.body.card.pinned, true);
  assert.equal((await call(app, "GET", artifactWebPaths.details(id(page), 9), world.who.reader)).body.code, "VERSION_NOT_FOUND");
  const viewer = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.deepEqual(details.body, viewer.body, "the same answer as the viewer's");
  assert.ok(await positionOf(), "opening the viewer moves it");
});

test("viewer: an author no one stands behind any more is marked, not just blank: a deleted agent `gone: deleted`, Raft's own importer `gone: system`", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const gone = { type: "agent", id: world.agentA.id, name: "", displayName: "", avatarUrl: null, gone: "deleted" };
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, world.agentA.id));
  const res = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.card.author, gone);
  assert.deepEqual(res.body.versions.map((v: { publisher: unknown }) => v.publisher), [gone, gone]);
  await getDb().update(artifactItems).set({ createdByType: ARTIFACT_OPS_IMPORT_ACTOR.type, createdById: ARTIFACT_OPS_IMPORT_ACTOR.id }).where(eq(artifactItems.id, page.id));
  const system = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.deepEqual(system.body.card.author, { ...ARTIFACT_OPS_IMPORT_ACTOR, name: "", displayName: "", avatarUrl: null, gone: "system" });
});

test("viewer: an older version is pinned; an unknown or malformed one is refused; an outsider gets a public Artifact's current version only and no comments", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const older = await call(app, "GET", artifactWebPaths.viewer(id(page), 1), world.who.reader);
  assert.equal(older.status, 200);
  assert.equal(older.body.card.version, 1);
  assert.equal(older.body.card.pinned, true);
  assert.equal(older.body.card.latestVersion, 2);
  assert.match(older.body.card.url, new RegExp(`/artifacts/${artifactLinkId(id(page))}/v/1$`), "the card's link carries the short id");
  assert.equal(older.body.card.id, page.id, "its id stays pt_…");
  // The route takes the short id a link carries as the same Artifact.
  const byShort = await call(app, "GET", `/api/artifacts/${artifactLinkId(id(page))}?version=1`, world.who.reader);
  assert.equal(byShort.status, 200);
  assert.equal(byShort.body.card.id, page.id);
  assert.deepEqual(older.body.files.map((file: { path: string }) => file.path), ["assets/logo.png", "data.csv", "index.html", "notes.txt"]);
  // Reading an older version is not looking at what's new.
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, page.id))).length, 0);

  const unknown = await call(app, "GET", artifactWebPaths.viewer(id(page), 9), world.who.reader);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, webVersionNotFound(9, 2).body);
  for (const bad of ["0", "x", "1.5", "-1"]) {
    const res = await call(app, "GET", `/api/artifacts/${page.id}?version=${bad}`, world.who.reader);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, "INVALID_REQUEST", bad);
  }

  // Outside the server (a public Artifact, always): the current version, no comments, nothing to do.
  await getDb().insert(artifactComments).values({ id: `c_${randomUUID()}`, itemId: memo.id, versionId: (await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, memo.id), eq(artifactVersions.number, 2))))[0]!.id, authorType: "user", authorId: world.owner.id, body: "members only", position: 3 });
  const outside = await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.peerUser);
  assert.equal(outside.status, 200);
  assert.equal(outside.body.card.version, 2);
  assert.equal(outside.body.card.commentCount, 0);
  assert.deepEqual(outside.body.card.home, { kind: "public" });
  assert.deepEqual(outside.body.versions.map((v: { number: number; changedPaths: string[] }) => [v.number, v.changedPaths]), [[2, []]]);
  assert.deepEqual(outside.body.capabilities, { publish: false, comment: false, changeHome: false, unpublish: false, narrowHome: false, delete: false });
  assert.equal(outside.body.following, false);
  assert.deepEqual(outside.body.viewer, userActor(world.peerUser));
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(memo), 1), world.who.peerUser)).body.code, "VERSION_NOT_FOUND");
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(memo), 2), world.who.peerUser)).status, 200, "the current version by number");
  // A member reads its history and comments.
  const member = await call(app, "GET", artifactWebPaths.viewer(id(memo), 1), world.who.reader);
  assert.equal(member.status, 200);
  assert.equal(member.body.card.commentCount, 1);
});

test("viewer and summaries: another server's reader of a public Artifact is shown its author and publishers by name and avatar, never their ids; a member with them", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  // memo by a person: written and its current version published by owner.
  await getDb().update(artifactItems).set({ createdByType: "user", createdById: world.owner.id }).where(eq(artifactItems.id, memo.id));
  await getDb().update(artifactVersions).set({ publisherType: "user", publisherId: world.owner.id }).where(and(eq(artifactVersions.itemId, memo.id), eq(artifactVersions.number, 2)));
  const ownerShown = { type: "user", name: world.owner.name, displayName: world.owner.name, avatarUrl: null };

  const outside = await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.peerUser);
  assert.equal(outside.status, 200, JSON.stringify(outside.body));
  assert.deepEqual(outside.body.card.author, ownerShown);
  assert.deepEqual(outside.body.versions.map((v: { publisher: unknown }) => v.publisher), [ownerShown]);
  assert.ok(!JSON.stringify(outside.body).includes(world.owner.id), "the viewer names no one of that server by id");
  assert.deepEqual(outside.body.viewer, userActor(world.peerUser), "the reader is still told who it is");
  const summary = (await summariesOf(app, world.who.peerUser, [memo.id])).body.summaries[0];
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.summary.author, ownerShown, "nor does its card in a message");
  assert.ok(!JSON.stringify(summary).includes(world.owner.id));
  assert.equal(summary.summary.fromAnotherServer, true, "the card says it is another server's (#128)");
  assert.equal(outside.body.card.fromAnotherServer, true, "the viewer's card too");

  // A member of its server: the ids, as before.
  const member = await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.reader);
  assert.deepEqual(member.body.card.author, userActor(world.owner));
  assert.deepEqual(member.body.versions[0].publisher, userActor(world.owner));
  assert.deepEqual((await summariesOf(app, world.who.reader, [memo.id])).body.summaries[0].summary.author, userActor(world.owner));
  assert.equal(member.body.card.fromAnotherServer, undefined, "its own server's: no such mark");
});

test("viewer: savedFrom names the attachment's message only for a reader who can see its conversation", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const message = await createMessage(world.other.id, "user", world.owner.id, "the original");
  const storageKey = `k-${label()}`;
  const [object] = await getDb().insert(attachmentObjects).values({
    originServerId: world.server.id, uploaderId: world.owner.id, uploaderType: "user", storageKey, mimeType: "text/html", sizeBytes: 11,
  }).returning();
  const [attachment] = await getDb().insert(attachments).values({
    objectId: object!.id, messageId: message.id, channelId: world.other.id, uploaderId: world.owner.id, uploaderType: "user", filename: "index.html",
  }).returning();
  await getDb().insert(artifactAttachmentSaves).values({ attachmentId: attachment!.id, itemId: page.id, versionId: world.versions.v1.id });
  assert.deepEqual((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.owner)).body.savedFrom, {
    attachmentId: attachment!.id, messageId: message.id, conversationId: world.other.id,
  });
  // The reader sees the Artifact (#priv) but not #other, where it was saved from.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).body.savedFrom, null);
});

/**
 * The viewer's own statements for a member opening an Artifact's current
 * version (the operation alone: core's auth and server check before it are
 * not counted), with the flag cache off as in every test: the item; sight
 * (5: standing, the home channel, its access) beside the item's server's flag
 * (3: live, flag, rules); every readable version (the current and a pinned one
 * among them); then at once the shown version's files, the names (users,
 * agents), the versions' files, the comment count, the home's name (2),
 * the card's publish-check screenshots (1, beside the comment count; the
 * check flag only when the version has some, so not here), capabilities
 * (standing, the author agent's manager; whether the reader may rename it,
 * #12841, comes from that standing read: mayManageArtifactActions `rename`),
 * following, savedFrom, and the read position (2). 23 since the viewer read
 * its versions once and its flags once (it was 27); 24 with the screenshots
 * (25 while the rename standing was a read of its own, folded back since). A
 * new statement here is a round trip on the Artifact's first screen: make it
 * a parallel or batched read of an existing one before raising this. 22 since
 * the Artifacts key is answered by the deployment: the two flag statements
 * (the flag and its rules) are gone.
 */
const VIEWER_MEMBER_STATEMENTS = 22;

test("viewer: a member opens an Artifact in a fixed, small number of statements, however many versions it has; no flag is read from the store", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const viewer = createViewerOperations();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const open = () => countQueries(() => viewer.viewer(reader, page.id, {}));
  const two = await open();
  assert.equal(two.value.kind, "json");
  assert.ok(two.queries <= VIEWER_MEMBER_STATEMENTS, `${two.queries} statements to open it (at most ${VIEWER_MEMBER_STATEMENTS})`);

  const byA: Actor = { type: "agent", id: world.agentA.id };
  for (const number of [3, 4, 5, 6]) {
    await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: page.id, number, files: [{ path: "index.html", bytes: Buffer.from(`<h1>v${number}</h1>`) }, { path: `n${number}.txt`, bytes: Buffer.from(`${number}`) }] });
  }
  const six = await open();
  assert.equal(six.value.kind === "json" && six.value.body.versions.length, 6);
  assert.equal(six.queries, two.queries, "no statement per version");
  const pinned = await countQueries(() => viewer.viewer(reader, page.id, { version: "2" }));
  assert.equal(pinned.value.kind === "json" && pinned.value.body.card.version, 2);
  assert.ok(pinned.queries < two.queries, "a pinned version is found among the versions read (and moves no read position)");

  // The Artifacts key is answered by the deployment (deployment.ts), never read from the flag store: a warm flag cache saves no statement, there is none to save.
  __setFlagReadCacheTtlForTests(30_000);
  try {
    await open();
    const warm = await open();
    assert.equal(warm.queries, two.queries, "no flag statement, cold or warm");
  } finally {
    __setFlagReadCacheTtlForTests(0);
  }
});

// ---- files -----------------------------------------------------------------------

test("file: the exact bytes as an attachment, with a type a browser never runs and nosniff", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const page = id(world.items.page);
  const logo = await call(app, "GET", artifactWebPaths.file(page, "assets/logo.png"), world.who.reader);
  assert.equal(logo.status, 200);
  assert.deepEqual(logo.bytes, PNG);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal(logo.headers.get("content-disposition"), `attachment; filename="logo.png"; filename*=UTF-8''logo.png`);
  assert.equal(logo.headers.get("x-content-type-options"), "nosniff");
  assert.equal(logo.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(logo.headers.get("cache-control"), "private, no-store");
  assert.equal(logo.headers.get("content-length"), String(PNG.length));

  const html = await call(app, "GET", artifactWebPaths.file(page, "index.html"), world.who.reader);
  assert.equal(html.bytes.toString("utf8"), "<h1>v2</h1><script>alert(1)</script>");
  assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8", "html is served as text, never as a page");
  assert.equal((await call(app, "GET", artifactWebPaths.file(page, "data.csv"), world.who.reader)).headers.get("content-type"), "text/csv; charset=utf-8");
  // SVG keeps its type (the shell draws it as <img src=blob:>), and is still a download that runs nothing here.
  const svg = await call(app, "GET", artifactWebPaths.file(id(world.items.drawing), "d.svg"), world.who.reader);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(svg.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
  assert.equal(svg.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const v1 = await call(app, "GET", artifactWebPaths.file(page, "index.html", 1), world.who.reader);
  assert.equal(v1.bytes.toString("utf8"), "<h1>v1</h1>");

  const missing = await call(app, "GET", artifactWebPaths.file(page, "nope.txt"), world.who.reader);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, webFileNotFound("nope.txt", 2).body);
  for (const [raw, path] of [["a%2F..%2Fb", "a/../b"], ["a%5Cb", "a\\b"], ["%2Fabs", "/abs"]]) {
    const res = await call(app, "GET", `/api/artifacts/${page}/files/${raw}`, world.who.reader);
    assert.equal(res.status, 400, raw);
    assert.deepEqual(res.body, webInvalidPath(path).body, raw);
  }
  const undecodable = await call(app, "GET", `/api/artifacts/${page}/files/%E0%A4%A`, world.who.reader);
  assert.equal(undecodable.status, 400);
  assert.deepEqual(undecodable.body, webInvalidPath("%E0%A4%A").body);
  assert.equal((await call(app, "DELETE", `/api/artifacts/${page}/comments/%E0%A4%A`, world.who.reader)).body.code, "INVALID_REQUEST");

  // Only a ready blob of the Artifact's own server is ever read.
  const [notes] = await getDb().select().from(artifactVersionFiles)
    .where(and(eq(artifactVersionFiles.versionId, world.versions.v2.id), eq(artifactVersionFiles.path, "notes.txt")));
  const blobOf = eq(artifactBlobs.id, notes!.blobId);
  await getDb().update(artifactBlobs).set({ state: "pending" }).where(blobOf);
  assert.equal((await call(app, "GET", artifactWebPaths.file(page, "notes.txt"), world.who.reader)).body.code, "FILE_NOT_FOUND", "a pending blob");
  await getDb().update(artifactBlobs).set({ state: "ready", serverId: asServerId(world.peer.id) }).where(blobOf);
  assert.equal((await call(app, "GET", artifactWebPaths.file(page, "notes.txt"), world.who.reader)).body.code, "FILE_NOT_FOUND", "another server's blob");
  assert.equal((await call(app, "GET", artifactWebPaths.fileContent(page, "notes.txt"), world.who.reader)).body.code, "FILE_NOT_FOUND");
  await getDb().update(artifactBlobs).set({ serverId: world.serverId }).where(blobOf);
  assert.equal((await call(app, "GET", artifactWebPaths.file(page, "notes.txt"), world.who.reader)).status, 200);

  __setArtifactR2StoreForTests(null);
  const unconfigured = await call(app, "GET", artifactWebPaths.file(page, "index.html"), world.who.reader);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, "CONTENT_UNAVAILABLE");
});

test("fileContent: text and csv inline (cut at 256 KiB); any other kind only by size and type", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const page = id(world.items.page);
  const get = (path: string, version?: number) => call(app, "GET", artifactWebPaths.fileContent(page, path, version), world.who.reader);
  assert.deepEqual((await get("notes.txt")).body, { kind: "text", path: "notes.txt", version: 2, size: 18, contentType: "text/plain; charset=utf-8", content: "hello notes, again", truncated: false });
  assert.deepEqual((await get("notes.txt", 1)).body, { kind: "text", path: "notes.txt", version: 1, size: 11, contentType: "text/plain; charset=utf-8", content: "hello notes", truncated: false });
  assert.deepEqual((await get("data.csv")).body, { kind: "text", path: "data.csv", version: 2, size: 8, contentType: "text/csv; charset=utf-8", content: "a,b\n1,2\n", truncated: false });
  // Drawn on the content origin or as an image: never inlined.
  assert.deepEqual((await get("index.html")).body, { kind: "binary", path: "index.html", version: 2, size: 36, contentType: "text/html; charset=utf-8" });
  assert.deepEqual((await get("assets/logo.png")).body, { kind: "binary", path: "assets/logo.png", version: 2, size: PNG.length, contentType: "image/png" });
  assert.equal((await get("nope.txt")).body.code, "FILE_NOT_FOUND");

  const big = await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: { type: "agent", id: world.agentA.id } });
  // A multi-byte character straddles the cut: it is left out whole.
  const bytes = Buffer.from(`${"x".repeat(256 * 1024 - 1)}é${"y".repeat(100)}`);
  await publish({ serverId: world.serverId, r2: world.r2 }, { type: "agent", id: world.agentA.id }, { itemId: big.id, number: 1, files: [{ path: "big.txt", bytes }] });
  const cut = await call(app, "GET", artifactWebPaths.fileContent(id(big), "big.txt"), world.who.reader);
  assert.equal(cut.body.truncated, true);
  assert.equal(cut.body.size, bytes.length);
  assert.equal(cut.body.content, "x".repeat(256 * 1024 - 1));
});

// ---- comments: reading -----------------------------------------------------------

test("comments: the newest page first, oldest first within it; `before` loads the page before; `path` one file's; deleted placeholders kept", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const rows = Array.from({ length: 55 }, (_, index) => ({
    id: `c_${String(index).padStart(3, "0")}-${randomUUID()}`,
    itemId: page.id,
    versionId: index < 10 ? world.versions.v1.id : world.versions.v2.id,
    path: index % 5 === 0 ? "notes.txt" : null,
    authorType: "agent" as const,
    authorId: world.agentA.id,
    body: `comment ${index}`,
    position: 3 + index,
  }));
  await getDb().insert(artifactComments).values(rows);
  const first = await call(app, "GET", artifactWebPaths.comments(id(page)), world.who.reader);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal(first.body.comments.length, 50);
  assert.deepEqual(first.body.comments.map((c: { body: Array<{ text: string }> }) => c.body[0]!.text), rows.slice(5).map((row) => row.body));
  assert.equal(first.body.olderCursor, "8");
  assert.deepEqual(first.body.comments[0], {
    id: rows[5]!.id,
    author: agentActor(world.agentA),
    body: [{ type: "text", text: "comment 5" }],
    createdAt: first.body.comments[0].createdAt,
    editedAt: null,
    deletedAt: null,
    version: 1,
    target: { scope: "file", path: "notes.txt", anchor: null },
    replyTo: null,
    resolvedAt: null,
    resolvedBy: null,
  });
  const before = await call(app, "GET", artifactWebPaths.comments(id(page), { before: first.body.olderCursor }), world.who.reader);
  assert.deepEqual(before.body.comments.map((c: { body: Array<{ text: string }> }) => c.body[0]!.text), rows.slice(0, 5).map((row) => row.body));
  assert.equal(before.body.olderCursor, null);
  const notes = await call(app, "GET", artifactWebPaths.comments(id(page), { path: "notes.txt" }), world.who.reader);
  assert.deepEqual(notes.body.comments.map((c: { body: Array<{ text: string }> }) => c.body[0]!.text), rows.filter((row) => row.path).map((row) => row.body));

  // A placeholder for replies stays in the list with an empty body.
  await getDb().update(artifactComments).set({ deletedAt: new Date(), body: "" }).where(eq(artifactComments.id, rows[54]!.id));
  const last = (await call(app, "GET", artifactWebPaths.comments(id(page)), world.who.reader)).body.comments.at(-1);
  assert.equal(last.id, rows[54]!.id);
  assert.deepEqual(last.body, []);
  assert.ok(last.deletedAt);

  for (const bad of ["x", "-1", "1.5"]) {
    assert.equal((await call(app, "GET", `/api/artifacts/${page.id}/comments?before=${bad}`, world.who.reader)).body.code, "INVALID_REQUEST", bad);
  }
  assert.equal((await call(app, "GET", artifactWebPaths.comments(id(page), { path: "../x" }), world.who.reader)).body.code, "INVALID_PATH");

  // A public Artifact's comments: none for someone outside the server, and
  // one named by id is no comment to it (as one that doesn't exist).
  const hiddenId = `c_${randomUUID()}`;
  await getDb().insert(artifactComments).values({ id: hiddenId, itemId: world.items.memo.id, versionId: (await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, world.items.memo.id)))[0]!.id, authorType: "user", authorId: world.owner.id, body: "members only", position: 3 });
  assert.deepEqual((await call(app, "GET", artifactWebPaths.comments(id(world.items.memo)), world.who.peerUser)).body, { comments: [], olderCursor: null });
  for (const [method, body] of [["PATCH", { body: [text("x")] }], ["DELETE", undefined]] as const) {
    const res = await call(app, method, artifactWebPaths.comment(id(world.items.memo), asArtifactCommentId(hiddenId)), world.who.peerUser, body);
    assert.equal(res.status, 404, `${method}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "COMMENT_NOT_FOUND", method);
  }
  assert.equal((await call(app, "GET", artifactWebPaths.comments(id(world.items.memo)), world.who.reader)).body.comments.length, 1);
  assert.equal((await commentsOf(world.items.memo.id))[0]!.body, "members only", "nothing written");
});

// ---- comments: writing -----------------------------------------------------------

test("a person's comment: stored as the contract returns it, at the item's next position, with its object event; it follows the Artifact and tells agents as an agent's comment does", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const anchor = { type: "lines", data: { start: 1, end: 1, quote: "hello" } };
  const res = await post(app, world, world.who.reader, commentInput(
    [text("  can "), mention(world.agentB, "agent"), text(" check line one? cc "), mention(world.owner, "user"), text(" and me "), mention(world.reader, "user"), text("  ")],
    { target: { scope: "file", path: "notes.txt", anchor } },
  ));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, res.body.comment.id));
  assert.deepEqual(res.body, {
    comment: {
      id: row!.id,
      author: userActor(world.reader),
      body: [
        text("can "), { type: "mention", actor: agentActor(world.agentB) }, text(" check line one? cc "), { type: "mention", actor: userActor(world.owner) },
        text(" and me "), { type: "mention", actor: userActor(world.reader) },
      ],
      createdAt: row!.createdAt.toISOString(),
      editedAt: null,
      deletedAt: null,
      version: 2,
      target: { scope: "file", path: "notes.txt", anchor },
      replyTo: null,
      resolvedAt: null,
      resolvedBy: null,
    },
    // B and A (it made the Artifact, and follows it), both at once. People aren't told yet.
    notified: [
      { actor: agentActor(world.agentB), reason: "mentioned" },
      { actor: agentActor(world.agentA), reason: "author" },
    ],
  });
  // Stored as agents read it: the text with @handles, and who it names.
  assert.equal(row!.body, `can @${world.agentB.name} check line one? cc @${world.owner.name} and me @${world.reader.name}`);
  assert.deepEqual(row!.mentions, [{ type: "agent", id: world.agentB.id }, { type: "user", id: world.owner.id }, { type: "user", id: world.reader.id }]);
  assert.deepEqual([row!.authorType, row!.authorId], ["user", world.reader.id]);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, page.id));
  assert.equal(row!.position, item!.lastPosition);
  const events = await getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, page.id), eq(objectEvents.eventKind, "comment")));
  assert.deepEqual(events.map((event) => [event.actorType, event.actorId, event.data]), [["user", world.reader.id, { position: row!.position, comment: row!.id, version: 2 }]]);

  // The commenter follows it now; the list and the viewer say so.
  assert.equal((await subscriptionOf(page.id, { type: "user", id: world.reader.id }))!.reason, "commented");
  const viewer = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.equal(viewer.body.following, true);
  assert.equal(viewer.body.card.commentCount, 1);
  const listed = await call(app, "GET", artifactWebPaths.comments(id(page)), world.who.reader);
  assert.deepEqual(listed.body.comments, [res.body.comment]);

  // B was pushed one mention notice, naming the person who wrote it.
  const [message, ...rest] = noticesTo(world, world.agentB.id);
  assert.equal(rest.length, 0);
  assert.equal(appEventOf(message!)!.reason, "mentioned");
  assert.equal(appEventOf(message!)!.comments!.latest[0]!.id, row!.id);
  assert.deepEqual(appEventOf(message!)!.comments!.latest[0]!.author, { type: "user", name: world.reader.name });
  // The notice names the place in Raft's words (line 1), and carries the anchor; its quoted text is the comment list's.
  assert.deepEqual(appEventOf(message!)!.comments!.latest[0]!.anchor, anchor);
  assert.ok(message!.content.startsWith(`System notification: @${world.reader.name} mentioned you in a comment on "${page.title}" (notes.txt · line 1)`), message!.content);
  assert.ok(!message!.content.includes("hello"), message!.content);
  // A, a follower, was pushed its notice at once too, as for a message (#55): nothing waits.
  const [toA, ...moreToA] = noticesTo(world, world.agentA.id);
  assert.equal(moreToA.length, 0);
  assert.equal(appEventOf(toA!)!.reason, "subscribed");
  assert.deepEqual(appEventOf(toA!)!.comments!.latest.map((c) => c.id), [row!.id]);
  assert.equal((await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.agentId, world.agentA.id))).length, 0);

  // Agents read it through the agent API as they read each other's.
  const key = (await mintAgentCredential({ agentId: world.agentC.id, scopes: ["read"], name: `wa-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const agentView = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${page.id}/comments?all=1`, { headers: { Authorization: `Bearer ${key}` } });
  const agentBody = await agentView.json() as { comments: Array<{ id: string; body: string; author: unknown; anchor: unknown }> };
  assert.deepEqual(agentBody.comments.map((c) => [c.id, c.body, c.author, c.anchor]), [[row!.id, row!.body, { type: "user", name: world.reader.name }, anchor]]);

  // A reply on the whole Artifact takes its parent's file and place; the parent's author hears of it only by following.
  const reply = await post(app, world, world.who.owner, commentInput([text("on it")], { replyTo: row!.id }));
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.deepEqual(reply.body.comment.target, { scope: "file", path: "notes.txt", anchor });
  assert.equal(reply.body.comment.replyTo, row!.id);
  assert.deepEqual(reply.body.notified, [{ actor: agentActor(world.agentA), reason: "author" }]);
});

test("a mention in a block quote, in code or in a link is its words, as in a message: drawn only where it counts, and a mention part that only stands there names nobody", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const b = mention(world.agentB, "agent");
  const handle = `@${world.agentB.name}`;

  // Quoted, then said: one mention, the one outside the quote. The same name in code and in a link's label is words too.
  const said = await post(app, world, world.who.reader, commentInput([text("> "), b, text(" said so\n\n"), b, text(" ok, `"), b, text("` and ["), b, text("](https://example.com)")]));
  assert.equal(said.status, 201, JSON.stringify(said.body));
  assert.deepEqual(said.body.comment.body, [
    text(`> ${handle} said so\n\n`), { type: "mention", actor: agentActor(world.agentB) }, text(` ok, \`${handle}\` and [${handle}](https://example.com)`),
  ]);
  const [saidRow] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, said.body.comment.id));
  assert.deepEqual(saidRow!.mentions, [{ type: "agent", id: world.agentB.id }]);
  assert.deepEqual(said.body.notified.filter((entry: { reason: string }) => entry.reason === "mentioned"), [{ actor: agentActor(world.agentB), reason: "mentioned" }]);
  // Read again, by the list: the same parts.
  const listed = await call(app, "GET", artifactWebPaths.comments(id(page)), world.who.reader);
  assert.deepEqual(listed.body.comments.map((entry: { body: unknown }) => entry.body), [said.body.comment.body]);

  // Only quoted: the words stay, nobody is mentioned, stored or told as mentioned.
  world.delivered.length = 0;
  const quoted = await post(app, world, world.who.reader, commentInput([text("> "), b, text(" said so\n\nagreed")]));
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  assert.deepEqual(quoted.body.comment.body, [text(`> ${handle} said so\n\nagreed`)]);
  const [quotedRow] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, quoted.body.comment.id));
  assert.equal(quotedRow!.body, `> ${handle} said so\n\nagreed`);
  assert.deepEqual(quotedRow!.mentions, []);
  assert.deepEqual(quoted.body.notified.filter((entry: { reason: string }) => entry.reason === "mentioned"), []);
  assert.deepEqual(noticesTo(world, world.agentB.id), []);

  // Someone who can't see the Artifact, only quoted: not a mention, so nothing to refuse.
  const hidden = await post(app, world, world.who.reader, commentInput([text("> "), mention(world.agentOut, "agent"), text(" wrote this\n\nnoted")]));
  assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
  assert.deepEqual(hidden.body.comment.body, [text(`> @${world.agentOut.name} wrote this\n\nnoted`)]);
  // Mentioned outside the quote as well, they are refused as before.
  const refusedOutside = await post(app, world, world.who.reader, commentInput([text("> "), mention(world.agentOut, "agent"), text(" wrote this\n\n"), mention(world.agentOut, "agent"), text(" noted")]));
  assert.equal(refusedOutside.status, 422, JSON.stringify(refusedOutside.body));
  assert.equal(refusedOutside.body.code, "MENTION_NOT_VISIBLE");
});

// A public Artifact opens for another server's reader (Tenny, task #74): the
// read routes the viewer uses answer it, as an outsider, and offer no write.
test("a public Artifact opens for another server's reader, as an outsider: the viewer's reads answer, capabilities offer no write, no read position moves", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const memo = id(world.items.memo);
  const reader = world.who.peerUser;

  const viewer = await call(app, "GET", artifactWebPaths.viewer(memo), reader);
  assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
  assert.equal(viewer.body.card.id, memo);
  assert.deepEqual(viewer.body.capabilities, { publish: false, comment: false, changeHome: false, unpublish: false, narrowHome: false, delete: false }, "no write offered");
  assert.equal(viewer.body.following, false);
  assert.deepEqual(viewer.body.versions.map((v: { number: number }) => v.number), [2], "an outsider's history: the current version");
  const older = await call(app, "GET", artifactWebPaths.viewer(memo, 1), reader);
  assert.equal(older.status, 404);
  assert.equal(older.body.code, "VERSION_NOT_FOUND");
  const bytes = await call(app, "GET", artifactWebPaths.file(memo, "memo.txt"), reader);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.bytes.toString("utf8"), "memo v2");
  const content = await call(app, "GET", artifactWebPaths.fileContent(memo, "memo.txt"), reader);
  assert.equal(content.status, 200, JSON.stringify(content.body));
  assert.equal(content.body.content, "memo v2");
  const comments = await call(app, "GET", artifactWebPaths.comments(memo), reader);
  assert.equal(comments.status, 200, JSON.stringify(comments.body));
  assert.deepEqual(comments.body, { comments: [], olderCursor: null }, "an outsider is listed none");
  const presence = await call(app, "GET", artifactWebPaths.presence(memo), reader);
  assert.equal(presence.status, 200, JSON.stringify(presence.body));
  assert.deepEqual(presence.body, { viewing: [], readCurrentVersion: [], readOtherVersion: [] });
  // The frame route gets past the Artifact to its kind (a text file is drawn by the shell).
  const frame = await call(app, "POST", artifactWebPaths.frame(memo), reader, {});
  assert.equal(frame.status, 409, JSON.stringify(frame.body));
  assert.equal(frame.body.code, "NOT_FRAMED");
  // A path that doesn't decode is refused for the path, past the Artifact.
  const undecodable = await call(app, "GET", `/api/artifacts/${memo}/files/%E0%A4%A`, reader);
  assert.equal(undecodable.status, 400);
  assert.equal(undecodable.body.code, "INVALID_PATH");
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.actorId, world.peerUser.id))).length, 0, "no read position");
});

test("Artifacts off: every read of any Artifact, public or not, seen or not, there or not, is the same 403, so nothing is told", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);

  const reads = (artifact: ArtifactId): Array<[string, string, unknown?]> => [
    ["GET", artifactWebPaths.viewer(artifact)],
    ["GET", artifactWebPaths.details(artifact)],
    ["GET", artifactWebPaths.file(artifact, "index.html")],
    ["GET", artifactWebPaths.fileContent(artifact, "index.html")],
    ["GET", artifactWebPaths.comments(artifact)],
    ["GET", artifactWebPaths.presence(artifact)],
    ["POST", artifactWebPaths.frame(artifact), {}],
  ];
  const { page, secret, deleted, revoked, memo } = world.items;
  const cases: Array<[string, string]> = [
    [`pt_${randomUUID()}`, "no such id"],
    [page.id, "another server's conversation"],
    [secret.id, "another server's private conversation"],
    [deleted.id, "deleted"],
    [revoked.id, "revoked"],
    [memo.id, "public"],
  ];
  let first: unknown = null;
  for (const [artifact, why] of cases) {
    for (const [method, path, body] of reads(asArtifactId(artifact))) {
      const res = await call(app, method, path, world.who.peerUser, body);
      assert.equal(res.status, 403, `${why}: ${method} ${path}`);
      first ??= res.body;
      assert.deepEqual(res.body, first, `${why}: ${method} ${path}`);
    }
  }
  assert.equal((first as { code: string }).code, "ARTIFACTS_NOT_ENABLED");

  // Witness: with Artifacts on, the public one opens.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.peerUser)).status, 200);
});

// A joint channel between the server and the peer: a member of the peer in
// the joint opens the server's Artifact homed there, in the viewer and
// through core's summaries: its whole history and its comments (it is no
// outsider: apiCommon readsAsOutsider), and may comment and follow (the next
// test) but manage nothing. The server's people may name it in a comment, as
// the joint's messages do (#68).
test("a joint channel: a peer member in it opens the server's Artifact homed there, viewer and summaries, whole history and comments, comments and follows but manages nothing, and may be mentioned", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `web-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addAgent(hostProjection.id, world.agentA.id);
  await addHuman(peerProjection.id, peerMember.id);
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const item = await insertItem({ serverId: world.serverId, homeChannelId: joint.canonical.id, author: byA });
  const v1 = await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: item.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("<h1>j1</h1>") }] });
  await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: item.id, number: 2, files: [{ path: "index.html", bytes: Buffer.from("<h1>j2</h1>") }] });
  await getDb().insert(artifactComments).values({ id: `c_${randomUUID()}`, itemId: item.id, versionId: v1.id, authorType: "user", authorId: world.reader.id, body: "from the server", position: 3 });
  // The comment written as a comment would be: the Artifact's last position with it, so the next one is 4.
  await getDb().update(artifactItems).set({ lastPosition: 3 }).where(eq(artifactItems.id, item.id));
  const member: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };

  const opened = await call(app, "GET", artifactWebPaths.viewer(id(item)), member);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(opened.body.card.home, { kind: "conversation", conversation: { id: peerProjection.id, name: peerProjection.name, type: "joint" } }, "the home by the reader's own projection");
  assert.deepEqual(opened.body.versions.map((v: { number: number }) => v.number), [2, 1], "the whole history");
  assert.equal(opened.body.card.commentCount, 1);
  assert.deepEqual(opened.body.capabilities, { publish: false, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: false }, "comments, manages nothing");
  assert.equal(opened.body.following, false);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(item), 1), member)).status, 200, "an older version");
  const comments = await call(app, "GET", artifactWebPaths.comments(id(item)), member);
  assert.equal(comments.status, 200, JSON.stringify(comments.body));
  assert.equal(comments.body.comments.length, 1);
  assert.equal((await call(app, "GET", artifactWebPaths.fileContent(id(item), "index.html"), member)).status, 200);
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.actorId, peerMember.id))).length, 1, "opening it moved its read position, as it takes part (#68)");

  const summaries = await summariesOf(app, member, [item.id]);
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body));
  assert.equal(summaries.body.summaries[0].ok, true);
  assert.deepEqual(withoutUnseen(summaries.body.summaries[0].summary), opened.body.card, "the viewer's card");
  assert.deepEqual(summaries.body.summaries[0].summary.unseen, { newerVersion: false, newComments: 0, firstNewComment: null }, "it opened it, as it takes part: nothing new since");
  // The peer's member outside its projection, and the server's member outside the joint: nothing.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(item)), world.who.peerUser)).status, 404);
  assert.equal((await summariesOf(app, world.who.peerUser, [item.id])).body.summaries[0].ok, false);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(item)), world.who.outsider)).status, 404);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(item)), world.who.reader)).status, 200, "witness: the server's member in the joint");

  // The server's member names it in a comment, as the joint's messages would:
  // the comment keeps the mention, the peer member reads it as one, and the
  // Artifact waits on its dashboard. The peer's person outside the joint is
  // no one it can name.
  const named = await call(app, "POST", artifactWebPaths.comments(id(item)), world.who.reader, commentInput([text("for you "), mention(peerMember, "user")]));
  assert.equal(named.status, 201, JSON.stringify(named.body));
  const namedId = named.body.comment.id as string;
  assert.deepEqual((await commentsOf(item.id)).find((row) => row.id === namedId)!.mentions, [{ type: "user", id: peerMember.id }]);
  const readBack = await call(app, "GET", artifactWebPaths.comments(id(item)), member);
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
  assert.deepEqual(readBack.body.comments.find((entry: { id: string }) => entry.id === namedId).body, [text("for you "), { type: "mention", actor: userActor(peerMember) }]);
  const peerDashboard = await dashboard(app, member);
  assert.equal(peerDashboard.status, 200, JSON.stringify(peerDashboard.body));
  assert.deepEqual(idsOf(peerDashboard.body.waiting), [item.id], "it waits on the peer member's dashboard");
  const notInJoint = await call(app, "POST", artifactWebPaths.comments(id(item)), world.who.reader, commentInput([text("and "), mention(world.peerUser, "user")]));
  assert.equal(notInJoint.status, 422, JSON.stringify(notInJoint.body));
  assert.equal(notInJoint.body.code, "MENTION_NOT_VISIBLE");
});

// A joint channel's member of another server takes part in its Artifacts as
// it writes in the channel (Tenny on #68): it comments, replies, reviews and
// follows, only while it sees the Artifact (in the joint), edits and deletes
// only its own comments, and manages nothing. A refusal is the one every
// reader gets: 404 NOT_VISIBLE for anything it doesn't see.
test("a joint channel: a peer member comments, replies, reviews and follows while it sees the Artifact; its own comments only; refused outside the joint and once it leaves", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const peerMember = await seed.human();
  const stranger = await seed.human();
  for (const human of [peerMember, stranger]) await addMember(world.peer.id, human.id);
  const joint = await seedJointChannel({ name: `web-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  for (const human of [world.owner, world.reader]) await addHuman(hostProjection.id, human.id);
  await addAgent(hostProjection.id, world.agentA.id);
  // The peer's owner is in the joint too: owning its own server manages nothing here.
  for (const human of [peerMember, world.peerUser]) await addHuman(peerProjection.id, human.id);
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const item = await insertItem({ serverId: world.serverId, homeChannelId: joint.canonical.id, author: byA });
  for (const number of [1, 2]) await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: item.id, number, files: [{ path: "index.html", bytes: Buffer.from(`<h1>j${number}</h1>`) }] });
  const member: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };
  const peerOwner: Who = { token: await accessTokenForTest(world.peerUser.id), serverId: world.peer.id };
  const outOfJoint: Who = { token: await accessTokenForTest(stranger.id), serverId: world.peer.id };
  const asMember = { type: "user" as const, id: peerMember.id };

  // It comments, replies to the server's comment, and follows.
  const fromHost = await post(app, world, world.who.reader, commentInput([text("from the server")]), item);
  assert.equal(fromHost.status, 201, JSON.stringify(fromHost.body));
  const said = await post(app, world, member, commentInput([text("from the peer")]), item);
  assert.equal(said.status, 201, JSON.stringify(said.body));
  const reply = await post(app, world, member, commentInput([text("a reply")], { replyTo: fromHost.body.comment.id }), item);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(id(item)), member)).status, 200);
  assert.ok(await subscriptionOf(item.id, asMember), "it follows");
  const opened = await call(app, "GET", artifactWebPaths.viewer(id(item)), member);
  assert.deepEqual([opened.body.following, opened.body.capabilities.comment, opened.body.capabilities.delete], [true, true, false]);
  // And reviews.
  const draft = await call(app, "POST", artifactWebPaths.reviewDrafts(id(item)), member, { version: 2, target: { scope: "artifact" }, body: [text("a draft")] });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const submitted = await call(app, "POST", artifactWebPaths.reviewSubmit(id(item)), member, { version: 2, summary: [text("overall")], clientKey: `k-${label()}` });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));

  // Its own comments only; and nobody of either server edits or deletes its comment, the server's owner included.
  const peerComment = asArtifactCommentId(said.body.comment.id);
  const hostComment = asArtifactCommentId(fromHost.body.comment.id);
  for (const [method, body] of [["PATCH", { body: [text("edited")] }], ["DELETE", undefined]] as const) {
    const onHost = await call(app, method, artifactWebPaths.comment(id(item), hostComment), member, body);
    assert.deepEqual([onHost.status, onHost.body.code], [403, "FORBIDDEN"], `${method} the server's comment`);
    for (const who of [world.who.owner, peerOwner]) {
      const onPeer = await call(app, method, artifactWebPaths.comment(id(item), peerComment), who, body);
      assert.deepEqual([onPeer.status, onPeer.body.code], [403, "FORBIDDEN"], `${method} the peer's comment, not its author`);
    }
  }
  assert.equal((await call(app, "PATCH", artifactWebPaths.comment(id(item), peerComment), member, { body: [text("edited")] })).status, 200, "its own: edited");
  // The peer's owner manages nothing of it (manage.api.test.ts covers every route).
  assert.equal((await removeArtifact(app, peerOwner, item)).status, 403);

  const refused = async (who: Who, status: number, code: string, why: string) => {
    const wrote = await post(app, world, who, commentInput([text("refused")]), item);
    assert.deepEqual([wrote.status, wrote.body.code], [status, code], `${why}: comment`);
    const followed = await call(app, "PUT", artifactWebPaths.subscription(id(item)), who);
    assert.deepEqual([followed.status, followed.body.code], [status, code], `${why}: follow`);
    const drafted = await call(app, "POST", artifactWebPaths.reviewDrafts(id(item)), who, { version: 2, target: { scope: "artifact" }, body: [text("refused")] });
    assert.deepEqual([drafted.status, drafted.body.code], [status, code], `${why}: review`);
  };
  const written = (await commentsOf(item.id)).length;
  // The peer's member outside the joint sees nothing, so writes nothing.
  await refused(outOfJoint, 404, "NOT_VISIBLE", "outside the joint");
  // Witness: in the joint, it writes.
  assert.equal((await post(app, world, member, commentInput([text("still in")]), item)).status, 201, "witness: in the joint");
  // It leaves the joint: the next write is refused at once.
  await removeHuman(peerProjection.id, peerMember.id, { self: true });
  await refused(member, 404, "NOT_VISIBLE", "left the joint");
  assert.equal((await commentsOf(item.id)).length, written + 1, "nothing written but the witness");
});

test("a reply racing its parent's deletion: never a reply to a comment that no longer exists", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const results: Array<{ reply: number; remove: number }> = [];
  for (let round = 0; round < 12; round += 1) {
    const parent = await post(app, world, world.who.reader, commentInput([text(`parent ${round}`)]));
    assert.equal(parent.status, 201, JSON.stringify(parent.body));
    const parentId = parent.body.comment.id as string;
    const [reply, remove] = await Promise.all([
      post(app, world, world.who.owner, commentInput([text(`reply ${round}`)], { replyTo: parentId })),
      call(app, "DELETE", artifactWebPaths.comment(id(world.items.page), parentId as never), world.who.reader),
    ]);
    results.push({ reply: reply.status, remove: remove.status });
    // Whichever went first, the other saw it: a reply after the delete is refused,
    // a delete after the reply keeps the parent as a placeholder.
    if (reply.status === 201) {
      const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, parentId));
      assert.ok(row, `round ${round}: the reply's parent still exists (a placeholder)`);
    } else {
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
      assert.equal(reply.body.code, "COMMENT_NOT_FOUND");
    }
  }
  const rows = await commentsOf(world.items.page.id);
  const ids = new Set(rows.map((row) => row.id));
  assert.deepEqual(rows.filter((row) => row.replyTo !== null && !ids.has(row.replyTo)).map((row) => row.id), [], JSON.stringify(results));
});

test("a page anchor (P108): a place the page names, stored as given; its name an identifier, its label and quote bounded plain text, nothing else", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const pageAnchor = (data: unknown) => commentInput([text("Approved")], { target: { scope: "file", path: "notes.txt", anchor: { type: "page", data } } });
  const good = { name: "refs/a.md#L12", label: "Card 3: ship on Friday?", quote: "第三张卡片的摘录\nwith a line" };
  const res = await post(app, world, world.who.reader, pageAnchor(good));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.comment.target, { scope: "file", path: "notes.txt", anchor: { type: "page", data: good } });
  const quote = "引".repeat(1_000);
  assert.equal((await post(app, world, world.who.reader, pageAnchor({ name: "card-3", quote }))).status, 201, "1,000 CJK characters fit the anchor's 4 KiB");
  const before = (await commentsOf(world.items.page.id)).length;
  for (const data of [
    { name: "" },
    { name: "card 3" },
    { name: "x".repeat(257) },
    { name: "card-3\u0000" },
    { name: "javascript:alert(1)<" },
    { name: "card-3", label: "x".repeat(201) },
    { name: "card-3", label: "   " },
    { name: "card-3", label: "a\u0007b" },
    { name: "card-3", quote: "q".repeat(1_001) },
    { name: "card-3", quote: "\ud800" },
    { name: "card-3", label: "Appro\u200Bved" },
    { name: "card-3", quote: "Approved \u202Edesrever" },
    { name: "card-3", label: `Approved${String.fromCodePoint(0xe0049, 0xe0067)}` },
    { name: "card-3", extra: true },
    { label: "no name" },
  ]) {
    const refused = await post(app, world, world.who.reader, pageAnchor(data));
    assert.equal(refused.status, 400, JSON.stringify(data));
    assert.equal(refused.body.code, "INVALID_REQUEST", JSON.stringify(data));
  }
  assert.equal((await commentsOf(world.items.page.id)).length, before, "nothing written");
});

test("comment refusals, in order, and nothing written: outside the server, the request, the version, the file, the reply, mentions, the text", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const refused = async (who: Who, input: unknown, status: number, code: string, details?: unknown, item = page) => {
    const res = await post(app, world, who, input, item);
    assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code);
    if (details !== undefined) assert.deepEqual(res.body.details, details);
  };
  await refused(world.who.peerUser, commentInput([text("hi")]), 403, "FORBIDDEN", undefined, memo);
  for (const input of [{}, { ...commentInput([text("hi")]), version: "2" }, { ...commentInput([text("hi")]), target: { scope: "page" } }, commentInput([{ type: "bold", text: "x" }]), [1]]) {
    await refused(world.who.reader, input, 400, "INVALID_REQUEST");
  }
  await refused(world.who.reader, commentInput([text("hi")], { target: { scope: "file", path: "notes.txt", anchor: { type: "lines", data: { start: 1, end: 1, quote: "x".repeat(5000) } } } }), 400, "FIELD_TOO_LONG", { field: "anchor", limit: 4096 });
  await refused(world.who.reader, commentInput([text("hi")], { target: { scope: "file", path: "notes.txt", anchor: { type: "html-region", data: {} } } }), 400, "INVALID_REQUEST");
  await refused(world.who.reader, commentInput([text("hi")], { target: { scope: "file", path: "a/../b", anchor: null } }), 400, "INVALID_PATH", { path: "a/../b" });
  await refused(world.who.reader, commentInput([text("hi")], { replyTo: `c_${randomUUID()}` }), 404, "COMMENT_NOT_FOUND");
  await refused(world.who.reader, commentInput([text("hi")], { version: 9 }), 404, "VERSION_NOT_FOUND", { version: 9, currentVersion: 2 });
  await refused(world.who.reader, commentInput([text("hi")], { target: { scope: "file", path: "nope.txt", anchor: null } }), 404, "FILE_NOT_FOUND", { path: "nope.txt", version: 2 });
  const many = Array.from({ length: 21 }, () => mention({ id: randomUUID() }, "user"));
  await refused(world.who.reader, commentInput([text("hi "), ...many]), 400, "TOO_MANY_MENTIONS", { limit: 20 });
  // Can't see it: an agent outside the home, a member outside it, someone of another server, nobody at all. Every one is named.
  const ghost = randomUUID();
  await refused(world.who.reader, commentInput([
    text("hey "), mention(world.agentOut, "agent"), mention(world.outsider, "user"), mention(world.peerUser, "user"), mention({ id: ghost }, "agent"), mention({ id: "not-a-uuid" }, "user"), mention(world.agentB, "agent"),
  ]), 422, "MENTION_NOT_VISIBLE", { actors: [
    { type: "agent", id: world.agentOut.id }, { type: "user", id: world.outsider.id }, { type: "user", id: world.peerUser.id }, { type: "agent", id: ghost }, { type: "user", id: "not-a-uuid" },
  ] });
  await refused(world.who.reader, commentInput([text("   ")]), 400, "INVALID_REQUEST");
  await refused(world.who.reader, commentInput([text("x".repeat(ARTIFACT_COMMENT_MAX_CHARS + 1))]), 400, "FIELD_TOO_LONG", { field: "body", limit: ARTIFACT_COMMENT_MAX_CHARS });
  assert.equal((await commentsOf(page.id)).length, 0);
  assert.equal(world.delivered.length, 0);
  // Exactly the cap, the author included, passes the count (and is then checked one by one).
  const twenty = [mention(world.reader, "user"), ...Array.from({ length: 19 }, () => mention({ id: randomUUID() }, "agent"))];
  assert.equal((await post(app, world, world.who.reader, commentInput([text("ok "), ...twenty]))).body.code, "MENTION_NOT_VISIBLE");
  // The same actor mentioned again counts once.
  assert.equal((await post(app, world, world.who.reader, commentInput([text("ok "), ...Array.from({ length: 30 }, () => mention(world.agentB, "agent"))]))).status, 201);
});

test("edit: its author only; only the mentions it adds are told, each checked again; followers aren't told again", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const created = await post(app, world, world.who.reader, commentInput([text("hi "), mention(world.agentB, "agent")]));
  assert.equal(created.status, 201);
  const commentId = created.body.comment.id;
  const path = artifactWebPaths.comment(id(page), asArtifactCommentId(commentId));
  assert.equal(noticesTo(world, world.agentB.id).length, 1);

  // Another person may not edit it; an unknown comment is not found.
  const other = await call(app, "PATCH", path, world.who.owner, { body: [text("mine now")] });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "FORBIDDEN");
  assert.equal((await call(app, "PATCH", artifactWebPaths.comment(id(page), asArtifactCommentId("c_nope")), world.who.reader, { body: [text("x")] })).body.code, "COMMENT_NOT_FOUND");
  assert.equal((await call(app, "PATCH", path, world.who.reader, { body: "plain" })).body.code, "INVALID_REQUEST");

  // Adding an agent that can't see it is refused, naming it; nothing changes.
  const hidden = await call(app, "PATCH", path, world.who.reader, { body: [text("hi "), mention(world.agentB, "agent"), mention(world.agentOut, "agent")] });
  assert.equal(hidden.status, 422);
  assert.deepEqual(hidden.body.details, { actors: [{ type: "agent", id: world.agentOut.id }] });
  assert.equal((await commentsOf(page.id))[0]!.editedAt, null);

  // B keeps its mention (not told again); C is added (told).
  const edited = await call(app, "PATCH", path, world.who.reader, { body: [text("hi "), mention(world.agentB, "agent"), text(" and "), mention(world.agentC, "agent")] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.notified, [{ actor: agentActor(world.agentC), reason: "mentioned" }]);
  assert.ok(edited.body.comment.editedAt);
  assert.deepEqual(edited.body.comment.body, [text("hi "), { type: "mention", actor: agentActor(world.agentB) }, text(" and "), { type: "mention", actor: agentActor(world.agentC) }]);
  assert.equal(noticesTo(world, world.agentB.id).length, 1);
  assert.equal(noticesTo(world, world.agentC.id).length, 1);
  assert.equal(appEventOf(noticesTo(world, world.agentC.id)[0]!)!.reason, "mentioned");
  // A, a follower, was told of the comment once, as written; the edit tells it nothing more.
  assert.equal(noticesTo(world, world.agentA.id).length, 1);
  assert.equal((await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.agentId, world.agentA.id))).length, 0);

  // A mention already there is not checked again: B leaving the home doesn't stop a typo fix.
  await removeAgent(world.priv.id, world.agentB.id);
  const kept = await call(app, "PATCH", path, world.who.reader, { body: [text("hi! "), mention(world.agentB, "agent"), text(" and "), mention(world.agentC, "agent")] });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(kept.body.notified, []);
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, commentId));
  assert.equal(row!.body, `hi! @${world.agentB.name} and @${world.agentC.name}`);

  // Each edit that went through is an event, for the mentions it added; the refused ones none.
  const events = await objectEventsOf(page.id, "comment_edited");
  assert.deepEqual(events.map((event) => [event.actorType, event.actorId, event.homeKind, event.homeChannelId, event.data]), [
    ["user", world.reader.id, "conversation", world.priv.id, { comment: commentId, position: row!.position }],
    ["user", world.reader.id, "conversation", world.priv.id, { comment: commentId, position: row!.position }],
  ]);
  assert.deepEqual(await recipientsOf(events[0]!.id), [`agent:${world.agentC.id}:mentioned`]);
  assert.deepEqual(await recipientsOf(events[1]!.id), []);
});

test("a person's read position passes their own comment only when nothing unseen by others lies before it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const positionOfReader = async () => (await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorId, world.reader.id))))[0]!.position;
  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  const seen = await positionOfReader();
  assert.equal((await post(app, world, world.who.owner, commentInput([text("from the owner")]))).status, 201);
  assert.equal((await post(app, world, world.who.reader, commentInput([text("from the reader")]))).status, 201);
  assert.equal(await positionOfReader(), seen, "the owner's comment stays unseen: the reader's position doesn't pass it");
  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  const next = await post(app, world, world.who.reader, commentInput([text("again")]));
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, next.body.comment.id));
  assert.equal(await positionOfReader(), row!.position);
});

test("delete: its author only; with replies it stays as a placeholder, without it's gone, and the placeholder goes with its last reply", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  const root = (await post(app, world, world.who.reader, commentInput([text("root")]))).body.comment;
  const reply = (await post(app, world, world.who.owner, commentInput([text("reply")], { replyTo: root.id }))).body.comment;
  const lone = (await post(app, world, world.who.reader, commentInput([text("lone")]))).body.comment;
  const del = (commentId: string, who: Who) => call(app, "DELETE", artifactWebPaths.comment(id(page), asArtifactCommentId(commentId)), who);

  assert.equal((await del(root.id, world.who.owner)).status, 403);
  const gone = await del(lone.id, world.who.reader);
  assert.equal(gone.status, 204);
  assert.equal(gone.bytes.length, 0);
  assert.equal((await del(root.id, world.who.reader)).status, 204);
  const listed = (await call(app, "GET", artifactWebPaths.comments(id(page)), world.who.reader)).body.comments;
  assert.deepEqual(listed.map((c: { id: string; body: unknown[]; deletedAt: string | null }) => [c.id, c.body.length, c.deletedAt !== null]), [[root.id, 0, true], [reply.id, 1, false]]);
  assert.deepEqual(listed[0].author, userActor(world.reader));
  // A placeholder is deleted already: not found again, and not a comment to reply to or edit.
  assert.equal((await del(root.id, world.who.reader)).body.code, "COMMENT_NOT_FOUND");
  assert.equal((await post(app, world, world.who.reader, commentInput([text("late")], { replyTo: root.id }))).body.code, "COMMENT_NOT_FOUND");
  assert.equal((await call(app, "PATCH", artifactWebPaths.comment(id(page), asArtifactCommentId(root.id)), world.who.reader, { body: [text("back")] })).body.code, "COMMENT_NOT_FOUND");
  // Agents don't list the placeholder.
  const [stored] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, root.id));
  assert.deepEqual([stored!.body, stored!.mentions], ["", []]);

  // The last reply goes, and its placeholder parent with it.
  assert.equal((await del(reply.id, world.who.owner)).status, 204);
  assert.deepEqual((await commentsOf(page.id)).map((row) => row.id), []);

  // Each delete that went through is an event, for no one; the refused ones none.
  const events = await objectEventsOf(page.id, "comment_deleted");
  assert.deepEqual(events.map((event) => [event.actorId, event.homeKind, event.data.comment, event.data.placeholder, typeof event.data.position]), [
    [world.reader.id, "conversation", lone.id, false, "number"],
    [world.reader.id, "conversation", root.id, true, "number"],
    [world.owner.id, "conversation", reply.id, false, "number"],
  ]);
  for (const event of events) assert.deepEqual(await recipientsOf(event.id), []);
});

// ---- who hears, whom `@` offers, following, presence -------------------------------

test("willNotify: the following agents that can see it, with why each follows; outside the server 403; an unknown reply 404", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const follows = (agentId: string, reason: "published" | "commented" | "followed", stopped = false) =>
    getDb().insert(artifactSubscriptions).values({ itemId: page.id, actorType: "agent", actorId: agentId, reason, unsubscribedAt: stopped ? new Date() : null });
  await follows(world.agentB.id, "commented");
  await follows(world.agentC.id, "followed");
  await follows(world.agentOut.id, "followed");
  await getDb().insert(artifactSubscriptions).values({ itemId: page.id, actorType: "user", actorId: world.owner.id, reason: "followed" });
  const res = await call(app, "GET", artifactWebPaths.willNotify(id(page)), world.who.reader);
  assert.equal(res.status, 200);
  const expected = [
    { actor: agentActor(world.agentA), reason: "author" },
    { actor: agentActor(world.agentB), reason: "commented" },
    { actor: agentActor(world.agentC), reason: "subscribed" },
  ].sort((x, y) => x.actor.id.localeCompare(y.actor.id));
  // agentOut can't see it; the owner is a person (not told yet).
  assert.deepEqual(res.body, { recipients: expected });
  await getDb().update(artifactSubscriptions).set({ unsubscribedAt: new Date() }).where(and(eq(artifactSubscriptions.itemId, page.id), eq(artifactSubscriptions.actorId, world.agentC.id)));
  assert.deepEqual((await call(app, "GET", artifactWebPaths.willNotify(id(page), { path: "notes.txt" }), world.who.reader)).body.recipients.map((r: { actor: { id: string } }) => r.actor.id).sort(), [world.agentA.id, world.agentB.id].sort());

  assert.equal((await call(app, "GET", artifactWebPaths.willNotify(id(page), { replyTo: asArtifactCommentId("c_nope") }), world.who.reader)).body.code, "COMMENT_NOT_FOUND");
  assert.equal((await call(app, "GET", artifactWebPaths.willNotify(id(page), { path: "../x" }), world.who.reader)).body.code, "INVALID_PATH");
  const outside = await call(app, "GET", artifactWebPaths.willNotify(id(memo)), world.who.peerUser);
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, "FORBIDDEN");
});

test("mentionCandidates: people and agents who can see it, matching q, members of its home first; never outside the server", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const ids = async (q: string, who = world.who.reader, item = page) => {
    const res = await call(app, "GET", artifactWebPaths.mentionCandidates(id(item), { q }), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.candidates as Array<{ type: string; id: string }>;
  };
  const all = await ids("");
  assert.deepEqual(new Set(all.map((c) => c.id)), new Set([world.owner.id, world.reader.id, world.agentA.id, world.agentB.id, world.agentC.id]));
  assert.deepEqual(all.slice(0, 2).map((c) => c.type), ["user", "user"], "people first");
  assert.deepEqual(all.find((c) => c.id === world.agentB.id), agentActor(world.agentB));
  assert.deepEqual((await ids(world.agentB.name.toUpperCase())).map((c) => c.id), [world.agentB.id], "any case");
  assert.deepEqual(await ids(world.outsider.name), [], "a member outside the home can't see it");
  assert.deepEqual(await ids(world.agentOut.name), []);
  assert.deepEqual(await ids("%"), [], "% is a character, not a wildcard");
  // A public Artifact: anyone of the server, but not someone of another server.
  assert.deepEqual((await ids(world.outsider.name, world.who.reader, memo)).map((c) => c.id), [world.outsider.id]);
  assert.deepEqual(await ids(world.peerUser.name, world.who.reader, memo), []);
  assert.equal((await call(app, "GET", artifactWebPaths.mentionCandidates(id(memo), { q: "a" }), world.who.peerUser)).body.code, "FORBIDDEN");
});

test("mentionCandidates: a guest is offered only the people and agents core shows a guest (those it meets in its conversations), as the member profile route; a member everyone who can see it; another server's reader nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  // outsider becomes a guest of one private conversation (its one channel, #wg-rbac:#15) with reader and agent B.
  const room = await createChannel(world.server.id, `web-guest-${label()}`, undefined, "private");
  await seedBoundGuest({ serverId: world.server.id, userId: world.outsider.id, channelId: room.id });
  await addHuman(room.id, world.reader.id);
  await addAgent(room.id, world.agentB.id);
  const candidates = async (who: Who, q = "") => {
    const res = await call(app, "GET", artifactWebPaths.mentionCandidates(id(memo), { q }), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.candidates as Array<{ type: string; id: string }>;
  };

  // The guest (on a public Artifact of its own server): itself, the person and the agent it meets, no one else.
  const guest = await candidates(world.who.outsider);
  assert.deepEqual(new Set(guest.map((c) => c.id)), new Set([world.outsider.id, world.reader.id, world.agentB.id]));
  assert.deepEqual(guest.find((c) => c.id === world.reader.id), userActor(world.reader));
  assert.deepEqual(await candidates(world.who.outsider, world.owner.name), [], "not someone it doesn't meet, even by name");
  assert.deepEqual(await candidates(world.who.outsider, world.agentA.name), []);
  // The same rule as core's member profile route for a guest.
  const profile = async (memberId: string, who: Who) => (await call(app, "GET", `/api/servers/${world.server.id}/members/${memberId}/profile`, who)).status;
  assert.equal(await profile(world.reader.id, world.who.outsider), 200, "witness: the guest sees reader's profile");
  assert.equal(await profile(world.owner.id, world.who.outsider), 404, "witness: and not owner's");

  // A member: unchanged, everyone of the server (the guest included).
  const member = await candidates(world.who.reader);
  for (const who of [world.owner, world.reader, world.outsider, world.agentA, world.agentB, world.agentC, world.agentOut]) {
    assert.ok(member.some((c) => c.id === who.id), `a member is offered ${who.name}`);
  }
  // Another server's reader: none at all.
  const outside = await call(app, "GET", artifactWebPaths.mentionCandidates(id(memo), { q: "" }), world.who.peerUser);
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, "FORBIDDEN");
});

test("mentionCandidates: where the server hides its people from members, a member is offered only the people core shows it (itself, whom it shares a conversation with), as the member profile route, and every agent; owners and admins everyone; unchanged without the setting", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  // outsider (a member) shares one conversation with reader, none with owner; all three are in #all.
  const room = await createChannel(world.server.id, `web-hidden-${label()}`, undefined, "private");
  for (const human of [world.outsider, world.reader]) await addHuman(room.id, human.id);
  const candidates = async (who: Who, q = "") => {
    const res = await call(app, "GET", artifactWebPaths.mentionCandidates(id(memo), { q }), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return new Set((res.body.candidates as Array<{ type: string; id: string }>).map((c) => c.id));
  };
  const profile = async (memberId: string, who: Who) => (await call(app, "GET", `/api/servers/${world.server.id}/members/${memberId}/profile`, who)).status;
  const people = [world.owner, world.reader, world.outsider];
  const agentsOf = [world.agentA, world.agentB, world.agentC, world.agentOut];
  const everyone = new Set([...people, ...agentsOf].map((who) => who.id));
  const hide = (hidden: boolean) => getDb().update(servers).set({ hideHumansFromMembers: hidden }).where(eq(servers.id, world.server.id));

  // Without the setting: a member is offered everyone (and core shows it owner).
  assert.deepEqual(await candidates(world.who.outsider), everyone);
  assert.equal(await profile(world.owner.id, world.who.outsider), 200, "witness: without the setting the member sees owner's profile");

  await hide(true);
  const member = await candidates(world.who.outsider);
  assert.deepEqual(member, new Set([world.outsider.id, world.reader.id, ...agentsOf.map((a) => a.id)]));
  assert.deepEqual(await candidates(world.who.outsider, world.owner.name), new Set(), "not someone hidden from it, even by name");
  // The same people as core's member profile route for that member.
  for (const person of people) {
    assert.equal(member.has(person.id), await profile(person.id, world.who.outsider) === 200, `core and the picker agree on ${person.name}`);
  }
  assert.equal(await profile(world.owner.id, world.who.outsider), 404, "witness: core hides owner from the member");
  // The owner, and an admin, are offered everyone.
  assert.deepEqual(await candidates(world.who.owner), everyone);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, world.outsider.id)));
  assert.deepEqual(await candidates(world.who.outsider), everyone);
  assert.equal(await profile(world.owner.id, world.who.outsider), 200, "witness: core shows an admin owner's profile");

  // The setting off again: a member is offered everyone once more.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, world.outsider.id)));
  await hide(false);
  assert.deepEqual(await candidates(world.who.outsider), everyone);
});

test("subscription: PUT follows, DELETE stops and sticks (commenting doesn't follow again); outside the server PUT 403, DELETE writes nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const me: Actor = { type: "user", id: world.reader.id };
  const path = artifactWebPaths.subscription(id(page));
  assert.deepEqual((await call(app, "PUT", path, world.who.reader)).body, { following: true });
  assert.equal((await subscriptionOf(page.id, me))!.unsubscribedAt, null);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).body.following, true);
  assert.deepEqual((await call(app, "DELETE", path, world.who.reader)).body, { following: false });
  assert.ok((await subscriptionOf(page.id, me))!.unsubscribedAt);
  assert.equal((await post(app, world, world.who.reader, commentInput([text("still here")]))).status, 201);
  assert.ok((await subscriptionOf(page.id, me))!.unsubscribedAt, "a stop sticks");
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).body.following, false);
  assert.deepEqual((await call(app, "PUT", path, world.who.reader)).body, { following: true });
  assert.equal((await subscriptionOf(page.id, me))!.unsubscribedAt, null);

  const outside = await call(app, "PUT", artifactWebPaths.subscription(id(memo)), world.who.peerUser);
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, "FORBIDDEN");
  assert.deepEqual((await call(app, "DELETE", artifactWebPaths.subscription(id(memo)), world.who.peerUser)).body, { following: false });
  assert.equal(await subscriptionOf(memo.id, { type: "user", id: world.peerUser.id }), null);
});

test("presence: nobody viewing (no socket yet); who read the current version, and who only an older one with its version, other than the reader and can still see it; nothing outside the server", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const path = artifactWebPaths.presence(id(page));
  assert.deepEqual((await call(app, "GET", path, world.who.reader)).body, { ownRead: null, viewing: [], readCurrentVersion: [], readOtherVersion: [] });
  // The owner opens it; agent B reads it through the agent API; C had read only v1.
  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.owner);
  const key = (await mintAgentCredential({ agentId: world.agentB.id, scopes: ["read"], name: `wa-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${page.id}`, { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  await getDb().insert(artifactReadPositions).values({ itemId: page.id, actorType: "agent", actorId: world.agentC.id, position: 1 });
  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  const res = await call(app, "GET", path, world.who.reader);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.viewing, []);
  assert.deepEqual(res.body.readCurrentVersion.map((entry: { actor: unknown }) => entry.actor), [agentActor(world.agentB), userActor(world.owner)]);
  assert.ok(res.body.readCurrentVersion.every((entry: { at: string }) => !Number.isNaN(Date.parse(entry.at))));
  // C read only v1: listed apart, with the version it reached, never among who read the current one.
  const olderC = res.body.readOtherVersion.filter((entry: { actor: { id: string } }) => entry.actor.id === world.agentC.id);
  assert.deepEqual(olderC.map((entry: { actor: unknown; version: number }) => ({ actor: entry.actor, version: entry.version })), [{ actor: agentActor(world.agentC), version: 1 }]);
  assert.ok(!res.body.readCurrentVersion.some((entry: { actor: { id: string } }) => entry.actor.id === world.agentC.id));
  // The reader's own (task #136): never among the others; on the current version (2) once it opened it.
  assert.ok(![...res.body.readCurrentVersion, ...res.body.readOtherVersion].some((entry: { actor: { id: string } }) => entry.actor.id === world.reader.id));
  assert.equal(res.body.ownRead.version, 2);
  assert.ok(!Number.isNaN(Date.parse(res.body.ownRead.at)));
  // Its position back before v2 became current: the last version it reached, also when the reader is the only one
  // behind (C's row gone: the version list is loaded for the reader's own position too).
  await getDb().delete(artifactReadPositions).where(and(eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorType, "agent"), eq(artifactReadPositions.actorId, world.agentC.id)));
  await getDb().update(artifactReadPositions).set({ position: 1 }).where(and(eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, world.reader.id)));
  assert.equal((await call(app, "GET", path, world.who.reader)).body.ownRead.version, 1);
  // B leaves the home: no longer listed.
  await removeAgent(world.priv.id, world.agentB.id);
  assert.deepEqual((await call(app, "GET", path, world.who.reader)).body.readCurrentVersion.map((entry: { actor: { id: string } }) => entry.actor.id), [world.owner.id]);
  // Outside the server: nothing, ever.
  await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.reader);
  assert.deepEqual((await call(app, "GET", artifactWebPaths.presence(id(memo)), world.who.peerUser)).body, { viewing: [], readCurrentVersion: [], readOtherVersion: [] });
});

// ---- renaming (task #147) --------------------------------------------------------

const rename = (app: { baseUrl: string }, who: Who, item: { id: string }, body: unknown) => call(app, "PATCH", artifactWebPaths.title(id(item)), who, body);
const titleOf = async (itemId: string) => (await getDb().select({ title: artifactItems.title }).from(artifactItems).where(eq(artifactItems.id, itemId)))[0]!.title;
/** The `system.artifacts` events queued for an agent (core's third_party_agent_events), oldest first. */
const queuedNoticesTo = (agentId: string) => getDb().select().from(thirdPartyAgentEvents)
  .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.artifacts")))
  .orderBy(thirdPartyAgentEvents.createdAt);
const searchHits = async (app: { baseUrl: string }, who: Who, q: string) => ((await call(app, "GET", webSearchPath({ q }), who)).body.groups ?? [])
  .flatMap((group: { items: Array<{ card?: { id: string } }> }) => group.items.map((hit) => hit.card?.id));

test("rename: a member who sees it gives it a new title in place: no version, the search finds it by it, a `renamed` event for no one's Activity, and its following agents told who, from what, to what, without a wake", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  // A follows it (it published it); B chose to; agentOut follows but can't see it; C doesn't follow.
  await getDb().insert(artifactSubscriptions).values([
    { itemId: page.id, actorType: "agent", actorId: world.agentB.id, reason: "followed" },
    { itemId: page.id, actorType: "agent", actorId: world.agentOut.id, reason: "followed" },
  ]);
  const before = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, page.id));

  const res = await rename(app, world.who.reader, page, { title: "  Launch plan,\nsecond draft  " });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The viewer's answer, as the other manage routes answer: stored trimmed and on one line.
  assert.equal(res.body.card.title, "Launch plan, second draft");
  assert.equal(res.body.card.version, 2);
  assert.equal(res.body.capabilities.publish, true);
  assert.equal(await titleOf(page.id), "Launch plan, second draft");
  assert.equal((await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, page.id))).length, before.length, "no version for a title");
  assert.ok((await searchHits(app, world.who.reader, "second draft")).includes(page.id), "found by its new title");

  const [event, ...more] = await objectEventsOf(page.id, "renamed");
  assert.equal(more.length, 0);
  assert.deepEqual([event!.actorType, event!.actorId, event!.data], ["user", world.reader.id, { from: page.title, to: "Launch plan, second draft" }]);
  assert.deepEqual(await recipientsOf(event!.id), [], "no one's Activity");

  // Each following agent that sees it, once, naming the person and both titles; not one that can't see it, nor one that doesn't follow.
  // A rename only changes what the Artifact is shown as: queued, never pushed, so it wakes no one (task #160); each gets it on its next pull.
  assert.deepEqual(world.delivered, [], "no push, no wake");
  for (const agent of [world.agentA, world.agentB]) {
    const [row, ...rest] = await queuedNoticesTo(agent.id);
    assert.equal(rest.length, 0, agent.name);
    assert.equal(row!.status, "queued", agent.name);
    const message = buildSystemAppAgentMessage(row!);
    const notice = appEventOf(message)!;
    assert.equal(notice.reason, "subscribed");
    assert.deepEqual(notice.artifact, { id: page.id, title: "Launch plan, second draft" });
    assert.deepEqual(notice.renamed, { by: { type: "user", name: world.reader.name }, from: page.title, to: "Launch plan, second draft" });
    assert.ok(message.content.startsWith(`System notification: @${world.reader.name} renamed "${page.title}" to "Launch plan, second draft"`), message.content);
    assert.ok(message.content.includes(`Its id is unchanged: raft artifact read ${page.id}.`), message.content);
  }
  assert.deepEqual(await queuedNoticesTo(world.agentOut.id), []);
  assert.deepEqual(await queuedNoticesTo(world.agentC.id), []);
});

test("rename: the same title writes nothing; blank, too long or malformed is 400; another server's reader 403, one who can't see it the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;

  // The title it has (once trimmed): answered, nothing recorded, nobody told.
  const same = await rename(app, world.who.reader, page, { title: ` ${page.title} ` });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.card.title, page.title);
  assert.deepEqual(await objectEventsOf(page.id, "renamed"), []);
  assert.equal(world.delivered.length, 0);

  for (const body of [{ title: "   " }, { title: "" }, {}, { title: 3 }, { title: "x", extra: true }]) {
    const res = await rename(app, world.who.reader, page, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_REQUEST", JSON.stringify(body));
  }
  // A body that isn't a JSON object never reaches the route: express.json refuses it (400, its own answer, not JSON).
  assert.equal((await rename(app, world.who.reader, page, null)).status, 400);
  const long = await rename(app, world.who.reader, page, { title: "x".repeat(301) });
  assert.equal(long.status, 400);
  assert.deepEqual([long.body.code, long.body.details], ["FIELD_TOO_LONG", { field: "title", limit: 300 }]);
  assert.equal((await rename(app, world.who.reader, page, { title: "x".repeat(300) })).status, 200, "the limit itself is a title");

  // Read from another server (a public Artifact): no capability to publish, and the route refuses it.
  const outside = await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.peerUser);
  assert.equal(outside.body.capabilities.publish, false);
  const refused = await rename(app, world.who.peerUser, memo, { title: "Taken over" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "FORBIDDEN");
  assert.equal(await titleOf(memo.id), memo.title);
  // A member who can't see it: the one 404, as every route.
  assert.deepEqual(await rename(app, world.who.outsider, page, { title: "Peeked" }).then((r) => [r.status, r.body]), [404, NOT_VISIBLE]);
  assert.equal(await titleOf(page.id), "x".repeat(300));
  assert.deepEqual((await objectEventsOf(memo.id, "renamed")).length, 0);
});

test("rename: a guest of the server sees someone else's Artifact but may not rename it (as canManageObject: a guest changes only their own)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  // outsider becomes a guest (of one private conversation); memo, public on its own server, it still sees.
  const room = await createChannel(world.server.id, `rename-guest-${label()}`, undefined, "private");
  await seedBoundGuest({ serverId: world.server.id, userId: world.outsider.id, channelId: room.id });
  const viewed = await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.outsider);
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.body.capabilities.publish, false, "no edit field for a guest");
  const refused = await rename(app, world.who.outsider, memo, { title: "A guest's title" });
  assert.deepEqual([refused.status, refused.body.code], [403, "FORBIDDEN"]);
  assert.equal(await titleOf(memo.id), memo.title);
  assert.deepEqual(await objectEventsOf(memo.id, "renamed"), []);
  // A member who isn't a guest may.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.reader)).body.capabilities.publish, true);
});

test("rename: the viewer's answer (mayManageArtifactActions `rename`, from the delete/widen standing read) is mayRename's for every kind of actor", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  // outsider becomes a guest of the server; the guest's own Artifact beside the agent's.
  const room = await createChannel(world.server.id, `rename-fold-${label()}`, undefined, "private");
  await seedBoundGuest({ serverId: world.server.id, userId: world.outsider.id, channelId: room.id });
  const guestsOwn = await insertItem({ serverId: world.serverId, homeChannelId: room.id, author: { type: "user", id: world.outsider.id } });
  const actors: Array<[string, ServerViewActor]> = [
    ["owner", { type: "user", id: world.owner.id, serverId: world.serverId }],
    ["member", { type: "user", id: world.reader.id, serverId: world.serverId }],
    ["guest", { type: "user", id: world.outsider.id, serverId: world.serverId }],
    ["author agent", { type: "agent", id: world.agentA.id, serverId: world.serverId }],
    ["another live agent", { type: "agent", id: world.agentB.id, serverId: world.serverId }],
    ["another server's person", { type: "user", id: world.peerUser.id, serverId: asServerId(world.peer.id) }],
    ["no member at all", { type: "user", id: (await seed.human()).id, serverId: world.serverId }],
  ];
  for (const item of [memo, guestsOwn]) {
    for (const [who, actor] of actors) {
      const answers = await mayManageArtifactActions(actor, item, ["delete", "widen", "rename"]);
      assert.equal(answers[2], await mayRename(actor, item), `${who} on ${item.id}`);
    }
  }
  // The guest renames their own and no one else's; a member any.
  assert.deepEqual(await mayManageArtifactActions(actors[2]![1], guestsOwn, ["rename"]), [true]);
  assert.deepEqual(await mayManageArtifactActions(actors[2]![1], memo, ["rename"]), [false]);
  assert.deepEqual(await mayManageArtifactActions(actors[1]![1], memo, ["rename"]), [true]);
});

// ---- shared by the summaries tests -----------------------------------------------

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as visibility.db.test.ts). */
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
    // Read the count after the call: `{ queries, value: await fn() }` would read it before.
    return { queries, value };
  } finally {
    pg.query = originalQuery;
  }
}

const linkTo = (artifact: { id: string }, version?: number) => `${getAppUrl()}/artifacts/${artifact.id}${version === undefined ? "" : `/v/${version}`}`;
const readPositionsOf = (itemId: string) => getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, itemId));

// ---- object summaries (core's POST /api/objects/summaries, kind "artifact") ----

const summaries = (app: { baseUrl: string }, who: Who, body: unknown) => call(app, "POST", objectWebPaths.summaries(), who, body);
const summariesAt = (app: { baseUrl: string }, who: Who, asked: Array<{ id: string; version?: number }>) => summaries(app, who, { kind: "artifact", refs: asked });
const summariesOf = (app: { baseUrl: string }, who: Who, ids: string[]) => summariesAt(app, who, ids.map((itemId) => ({ id: itemId })));
/** A summary as the viewer's card: all of it but `unseen`, the summaries' own (ArtifactCard `unseen`). */
const withoutUnseen = (summary: Record<string, unknown>) => Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "unseen"));
const unavailableAt = (artifactId: string, version?: number) => ({ ref: version === undefined ? { id: artifactId } : { id: artifactId, version }, ok: false, reason: "unavailable" });
/** The answer a reader who could have seen a deleted Artifact gets: ArtifactDeletedReference, exactly. */
const deletedAt = (ref: { id: string; version?: number }, item: { title: string; deletedAt: Date | null }, deletedBy: Record<string, unknown>) =>
  ({ ref, ok: false, reason: "deleted", deleted: { status: "deleted", title: item.title, deletedBy, deletedAt: item.deletedAt!.toISOString() } });

test("summaries: a visible Artifact's summary is the viewer's card (and its `unseen`), any home; every id answered in order, repeats too; private, no-store; no read position moves", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo, drawing } = world.items;
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const ownersComment = `c_${randomUUID()}`;
  await getDb().insert(artifactComments).values({ id: ownersComment, itemId: page.id, versionId: world.versions.v2.id, authorType: "user", authorId: world.owner.id, body: "a comment", position: 3 });
  // A DM home, named by its peer as the reader sees it.
  const dm = (await findOrCreateDM(world.server.id, world.reader.id, world.agentA.id))!;
  const inDm = await insertItem({ serverId: world.serverId, homeChannelId: dm.id, author: byA });
  await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: inDm.id, number: 1, files: [{ path: "notes.md", bytes: Buffer.from("# hi") }] });
  await getDb().insert(artifactReadPositions).values({ itemId: page.id, actorType: "user", actorId: world.reader.id, position: 1 });
  const before = await readPositionsOf(page.id);
  // The DM is labelled by its peer's handle, plus the display name the reader's sidebar shows.
  await getDb().update(agents).set({ displayName: "Agent Alpha" }).where(eq(agents.id, world.agentA.id));
  const ids = [page.id, memo.id, drawing.id, inDm.id, page.id];
  const res = await summariesOf(app, world.who.reader, ids);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.body.kind, "artifact");
  assert.deepEqual(res.body.summaries.map((answer: { ref: unknown; ok: boolean }) => [answer.ref, answer.ok]), ids.map((itemId) => [{ id: itemId }, true]));
  assert.deepEqual(await readPositionsOf(page.id), before, "summaries never move a read position");
  for (const item of [memo, drawing, inDm]) assert.deepEqual(await readPositionsOf(item.id), [], "nor make one");
  // Each summary is the viewer's card (the viewer moves read positions; read them after).
  const summary = res.body.summaries.map((answer: { summary: Record<string, unknown> }) => answer.summary);
  for (const [index, item] of [page, memo, drawing, inDm].entries()) {
    const viewerCard = (await call(app, "GET", artifactWebPaths.viewer(id(item)), world.who.reader)).body.card;
    assert.deepEqual(withoutUnseen(summary[index]), viewerCard, `the viewer's card for ${index}`);
    assert.ok(!("unseen" in viewerCard), "the viewer's own card has no `unseen`");
  }
  assert.equal(summary[0].commentCount, 1);
  // The reader read page through v1 (position 1): v2 (agent A's) and the owner's comment are new; the rest it never opened.
  assert.deepEqual(summary[0].unseen, { newerVersion: true, newComments: 1, firstNewComment: ownersComment });
  for (const index of [1, 2, 3]) assert.equal(summary[index].unseen, null, `never opened: no marks (${index})`);
  assert.deepEqual(summary[3].home, { kind: "conversation", conversation: { id: dm.id, name: world.agentA.name, type: "dm", peerDisplayName: "Agent Alpha" } });
  assert.deepEqual(summary[4], summary[0], "a repeat is answered again");
});

test("summaries: whatever the reason, an id it can't answer is the same `unavailable`, in its place among visible ones", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, secret, deleted, revoked, memo } = world.items;
  const unpublished = await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: { type: "agent", id: world.agentA.id } });
  const peerAuthor: Actor = { type: "user", id: world.peerUser.id };
  const peerServerHome = await insertItem({ serverId: asServerId(world.peer.id), serverHome: true, author: peerAuthor });
  await publish({ serverId: asServerId(world.peer.id), r2: world.r2 }, peerAuthor, { itemId: peerServerHome.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from("peer") }] });
  const missing = `pt_${randomUUID()}`;
  const ids = [secret.id, page.id, missing, deleted.id, memo.id, revoked.id, unpublished.id, peerServerHome.id, "not an id", page.id];
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const res = await summariesOf(app, world.who.reader, ids);
  assert.equal(res.status, 200);
  // A span of the request: the kind and counts in buckets, never the references.
  const [span, ...others] = sink.getAllSpans().filter((recorded) => recorded.name === "server.objects.summaries");
  assert.equal(others.length, 0);
  assert.equal(sink.getAllSpans().find((recorded) => recorded.context.spanId === span?.context.parentSpanId)?.name, "server.http.request");
  const { object_kind, refs_bucket, ok_bucket, unavailable_bucket } = span?.attrs ?? {};
  assert.deepEqual({ object_kind, refs_bucket, ok_bucket, unavailable_bucket }, { object_kind: "artifact", refs_bucket: "6-20", ok_bucket: "2-5", unavailable_bucket: "6-20" });
  assert.equal(typeof span?.attrs?.duration_ms, "number");
  assert.ok(!JSON.stringify(span?.attrs).includes(page.id));
  const okAt = new Set([1, 4, 9]);
  ids.forEach((itemId, index) => {
    const answer = res.body.summaries[index];
    if (okAt.has(index)) assert.equal(answer.ok, true, `${index} ${itemId}`);
    else assert.deepEqual(answer, unavailableAt(itemId), `${index} ${itemId}`);
  });
  // The private channel's Artifact and a missing one get the same body (but for the reference).
  assert.deepEqual({ ...res.body.summaries[0], ref: "x" }, { ...res.body.summaries[2], ref: "x" });

  // Another server's reader: the public one only.
  const peer = await summariesOf(app, world.who.peerUser, [page.id, memo.id, peerServerHome.id]);
  assert.deepEqual(peer.body.summaries.map((answer: { ok: boolean }) => answer.ok), [false, true, true]);
  assert.deepEqual(peer.body.summaries[0], unavailableAt(page.id));
  // Artifacts off: the public one too.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual((await summariesOf(app, world.who.peerUser, [memo.id])).body.summaries, [unavailableAt(memo.id)]);
});

test("summaries: a pinned version's summary is the viewer's card at that version (its publisher and time; the Artifact's title and counts); one Artifact at two versions answered apart", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  // v1 published by the owner a while ago; the Artifact itself (and v2) by agent A.
  const publishedAt = new Date("2026-01-02T03:04:05.000Z");
  await getDb().update(artifactVersions).set({ publisherType: "user", publisherId: world.owner.id, createdAt: publishedAt }).where(eq(artifactVersions.id, world.versions.v1.id));
  const asked = [{ id: page.id, version: 1 }, { id: page.id }, { id: page.id, version: 2 }, { id: page.id, version: 1 }];
  const res = await summariesAt(app, world.who.reader, asked);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.summaries.map((answer: { ref: unknown; ok: boolean }) => [answer.ref, answer.ok]), asked.map((ref) => [ref, true]), "each reference echoed, in order");
  const [pinned, latest, pinnedCurrent, again] = res.body.summaries.map((answer: { summary: Record<string, unknown> }) => answer.summary);

  const viewerCard = async (version?: number) => (await call(app, "GET", artifactWebPaths.viewer(id(page), version), world.who.reader)).body.card;
  assert.deepEqual(withoutUnseen(pinned), await viewerCard(1), "the viewer's at v1");
  assert.deepEqual(withoutUnseen(latest), await viewerCard(), "the viewer's at the latest");
  assert.deepEqual(withoutUnseen(pinnedCurrent), await viewerCard(2), "the viewer's at v2, pinned");
  assert.deepEqual(again, pinned, "a repeat is answered again");

  assert.equal(pinned.version, 1);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.latestVersion, 2);
  assert.equal((pinned.author as { id: string }).id, world.owner.id, "a pinned card names its version's publisher");
  assert.equal(pinned.updatedAt, publishedAt.toISOString(), "and when that version was published");
  assert.equal((latest.author as { id: string }).id, world.agentA.id, "the latest card names the Artifact's author, as before");
  assert.equal(latest.pinned, false);
  assert.equal(pinnedCurrent.pinned, true);
  assert.equal(pinnedCurrent.version, 2);
  for (const field of ["title", "description", "latestVersion", "commentCount", "home", "createdAt", "unseen"]) assert.deepEqual(pinned[field], latest[field], `${field} is the Artifact's`);
  assert.notDeepEqual(pinned.facts, latest.facts, "facts are the version's");
});

// #proj-workspace:#141: a message card marks what changed since the reader last looked.
test("summaries: `unseen` is what others changed past the reader's read position (a newer version, live comments); its own never count; null before it opened it and for an outsider; opening the current version clears it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo } = world.items;
  const db = getDb();
  const me: Actor = { type: "user", id: world.reader.id };
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const unseenOf = async (who: Who, itemId: string) => (await summariesOf(app, who, [itemId])).body.summaries[0].summary.unseen;

  assert.equal(await unseenOf(world.who.reader, page.id), null, "never opened: everything would be new, so nothing is marked");

  // Read through v2 (position 2), as opening it would. Then: the owner's comment, the reader's own,
  // the owner's deleted one, agent A's; positions 3 to 6.
  await db.insert(artifactReadPositions).values({ itemId: page.id, actorType: "user", actorId: world.reader.id, position: 2 });
  const comment = (author: Actor, position: number, deleted = false) => ({
    id: `c_${randomUUID()}`, itemId: page.id, versionId: world.versions.v2.id, authorType: author.type, authorId: author.id,
    body: `at ${position}`, position, deletedAt: deleted ? new Date() : null,
  });
  const owner: Actor = { type: "user", id: world.owner.id };
  const first = comment(owner, 3);
  await db.insert(artifactComments).values([first, comment(me, 4), comment(owner, 5, true), comment(byA, 6)]);
  await db.update(artifactItems).set({ lastPosition: 6 }).where(eq(artifactItems.id, page.id));
  assert.deepEqual(await unseenOf(world.who.reader, page.id), { newerVersion: false, newComments: 2, firstNewComment: first.id }, "others' live comments only: not its own, not a deleted one; the first of them is where the card opens the list");
  assert.deepEqual(await unseenOf(world.who.owner, page.id), null, "per reader: the owner never opened it");

  // A version the reader published itself is not new to it; agent A's after it is.
  const v3 = await publish({ serverId: world.serverId, r2: world.r2 }, me, { itemId: page.id, number: 3, files: [{ path: "index.html", bytes: Buffer.from("<h1>v3</h1>") }] });
  await db.update(artifactVersions).set({ position: 7 }).where(eq(artifactVersions.id, v3.id));
  await db.update(artifactItems).set({ lastPosition: 7 }).where(eq(artifactItems.id, page.id));
  assert.deepEqual(await unseenOf(world.who.reader, page.id), { newerVersion: false, newComments: 2, firstNewComment: first.id }, "its own version never counts");
  const v4 = await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: page.id, number: 4, files: [{ path: "index.html", bytes: Buffer.from("<h1>v4</h1>") }] });
  await db.update(artifactVersions).set({ position: 8 }).where(eq(artifactVersions.id, v4.id));
  await db.update(artifactItems).set({ lastPosition: 8 }).where(eq(artifactItems.id, page.id));
  const both = await summariesAt(app, world.who.reader, [{ id: page.id }, { id: page.id, version: 1 }]);
  assert.deepEqual(both.body.summaries.map((answer: { summary: { unseen: unknown } }) => answer.summary.unseen), [
    { newerVersion: true, newComments: 2, firstNewComment: first.id },
    { newerVersion: true, newComments: 2, firstNewComment: first.id },
  ], "the Artifact's, on a pinned card too (the web leaves the version mark off a pinned one)");

  // Opening the current version moves the read position over everything: nothing new.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).status, 200);
  assert.deepEqual(await unseenOf(world.who.reader, page.id), { newerVersion: false, newComments: 0, firstNewComment: null });
  // Opening an older version moves nothing: a later comment stays new.
  const later = comment(owner, 9);
  await db.insert(artifactComments).values(later);
  await db.update(artifactItems).set({ lastPosition: 9 }).where(eq(artifactItems.id, page.id));
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page), 1), world.who.reader)).status, 200);
  assert.deepEqual(await unseenOf(world.who.reader, page.id), { newerVersion: false, newComments: 1, firstNewComment: later.id });

  // Another server's reader of a public Artifact reads it as an outsider and keeps no read position: null, whatever rows exist.
  await db.insert(artifactReadPositions).values({ itemId: memo.id, actorType: "user", actorId: world.peerUser.id, position: 0 });
  assert.equal(await unseenOf(world.who.peerUser, memo.id), null);
});

test("summaries: a version that doesn't exist, a revoked one and, outside a public Artifact's server, another version are unavailable, as an Artifact it can't see", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo, secret } = world.items;
  await getDb().update(artifactVersions).set({ revokedAt: new Date(), revokedByType: "user", revokedById: world.owner.id }).where(eq(artifactVersions.id, world.versions.v1.id));
  const res = await summariesAt(app, world.who.reader, [{ id: page.id, version: 9 }, { id: page.id, version: 1 }, { id: page.id }, { id: page.id, version: 2 }, { id: secret.id, version: 1 }]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.summaries.map((answer: { ok: boolean }) => answer.ok), [false, false, true, true, false]);
  assert.deepEqual(res.body.summaries[0], unavailableAt(page.id, 9), "a version that doesn't exist");
  assert.deepEqual(res.body.summaries[1], unavailableAt(page.id, 1), "a revoked version");
  assert.deepEqual({ ...res.body.summaries[0], ref: "x" }, { ...res.body.summaries[4], ref: "x" }, "the same body as an Artifact the reader can't see");

  // memo: public, v2 current. Another server's reader reads only the current version, pinned or not.
  const peer = await summariesAt(app, world.who.peerUser, [{ id: memo.id }, { id: memo.id, version: 2 }, { id: memo.id, version: 1 }]);
  assert.deepEqual(peer.body.summaries.map((answer: { ok: boolean }) => answer.ok), [true, true, false]);
  assert.deepEqual(peer.body.summaries[2], unavailableAt(memo.id, 1));
  assert.deepEqual((await summariesAt(app, world.who.reader, [{ id: memo.id, version: 1 }])).body.summaries[0].ok, true, "witness: a member reads its history");
});

test("summaries: an orphan (its home channel hard-deleted) is unavailable to a member, still summarized for its author", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const author: Actor = { type: "user", id: world.reader.id };
  const doomed = await createChannel(world.server.id, `web-doomed-${label()}`, undefined, "private");
  for (const human of [world.reader, world.outsider]) await addHuman(doomed.id, human.id);
  const orphan = await insertItem({ serverId: world.serverId, homeChannelId: doomed.id, author });
  await publish({ serverId: world.serverId, r2: world.r2 }, author, { itemId: orphan.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("orphan") }] });
  assert.equal((await summariesOf(app, world.who.outsider, [orphan.id])).body.summaries[0].ok, true, "fixture: a member of its channel sees it while the channel stands");

  await getDb().delete(channels).where(eq(channels.id, doomed.id));
  assert.deepEqual((await summariesOf(app, world.who.outsider, [orphan.id])).body.summaries, [unavailableAt(orphan.id)]);
  const mine = await summariesOf(app, world.who.reader, [orphan.id]);
  assert.equal(mine.body.summaries[0].ok, true);
  assert.deepEqual(mine.body.summaries[0].summary.home, { kind: "conversation", conversation: { id: null, name: "", type: "channel" } });
});

test("summaries: a guest sees a public Artifact and one in a conversation it is in, never the server home", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // outsider becomes a guest of #priv, its one channel (#wg-rbac:#15).
  await seedBoundGuest({ serverId: world.serverId, userId: world.outsider.id, channelId: world.priv.id });
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const serverHome = await insertItem({ serverId: world.serverId, serverHome: true, author: byOwner });
  await publish({ serverId: world.serverId, r2: world.r2 }, byOwner, { itemId: serverHome.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from("server") }] });
  const res = await summariesOf(app, world.who.outsider, [world.items.memo.id, world.items.page.id, serverHome.id, world.items.secret.id]);
  assert.deepEqual(res.body.summaries.map((answer: { ok: boolean }) => answer.ok), [true, true, false, false]);
  assert.equal((await summariesOf(app, world.who.reader, [serverHome.id])).body.summaries[0].ok, true, "witness: a member sees the server home");
});

// ---- deleted cards (a deleted Artifact named in a message) ------------------------

const removeArtifact = (app: { baseUrl: string }, who: Who, item: { id: string }) => call(app, "DELETE", artifactWebPaths.artifact(id(item)), who);
const itemRow = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
/** A shown actor without its id: another server's reader of a public Artifact (webCommon.shownActorOf). */
const withoutId = ({ id: _id, ...rest }: Record<string, unknown>) => rest;

test("deleted card: a member who could see it gets `deleted` after the delete (title, by whom, when), for every reference to it, and nothing else", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page } = world.items;
  assert.equal((await summariesOf(app, world.who.reader, [page.id])).body.summaries[0].ok, true, "fixture: the reader sees it live");
  const removed = await removeArtifact(app, world.who.owner, page);
  assert.equal(removed.status, 204, JSON.stringify(removed.body));
  const row = await itemRow(page);
  const asked = [{ id: page.id }, { id: page.id, version: 1 }, { id: page.id, version: 9 }];
  const res = await summariesAt(app, world.who.reader, asked);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(res.body.summaries, asked.map((ref) => deletedAt(ref, row, userActor(world.owner))), "exactly the deleted reference, for any reference to it");
  // The one who deleted it (an owner, in #priv too) reads the same.
  assert.deepEqual((await summariesOf(app, world.who.owner, [page.id])).body.summaries, [deletedAt({ id: page.id }, row, userActor(world.owner))]);
  // Nothing else opens.
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader)).status, 404);
});

test("deleted card: one who couldn't have seen it gets exactly today's `unavailable` (a missing id's)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { secret, page } = world.items;
  // secret is in #other (owner only); page in #priv (not the outsider's, a member of the server).
  for (const item of [secret, page]) assert.equal((await removeArtifact(app, world.who.owner, item)).status, 204);
  const missing = `pt_${randomUUID()}`;
  const notInOther = await summariesOf(app, world.who.reader, [secret.id, missing]);
  assert.deepEqual(notInOther.body.summaries, [unavailableAt(secret.id), unavailableAt(missing)], "a private conversation the reader isn't in");
  assert.deepEqual({ ...notInOther.body.summaries[0], ref: "x" }, { ...notInOther.body.summaries[1], ref: "x" }, "the same body as an id that names nothing");
  assert.deepEqual((await summariesOf(app, world.who.outsider, [page.id])).body.summaries, [unavailableAt(page.id)], "a member outside its channel");
  assert.deepEqual((await summariesOf(app, world.who.peerUser, [page.id, secret.id])).body.summaries, [unavailableAt(page.id), unavailableAt(secret.id)], "another server's reader of a non-public one");
  // Witness: one who could see it gets `deleted`.
  assert.equal((await summariesOf(app, world.who.owner, [secret.id])).body.summaries[0].reason, "deleted", "witness: #other's member");
});

test("deleted card: a revoked Artifact is the plain `unavailable` for everyone, deleted or not, even for who got `deleted` before", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { revoked, page } = world.items;
  assert.equal((await removeArtifact(app, world.who.owner, page)).status, 204);
  assert.equal((await summariesOf(app, world.who.reader, [page.id])).body.summaries[0].reason, "deleted", "fixture: deleted, the reader gets `deleted`");
  // Taken down after the delete.
  await getDb().update(artifactItems).set({ revokedAt: new Date() }).where(eq(artifactItems.id, page.id));
  for (const who of [world.who.reader, world.who.owner, world.who.outsider, world.who.peerUser]) {
    assert.deepEqual((await summariesOf(app, who, [revoked.id, page.id])).body.summaries, [unavailableAt(revoked.id), unavailableAt(page.id)]);
  }
});

test("deleted card: a deleted public Artifact's card is its own server's only; another server's reader gets `unavailable` (deleting withdraws what publishing opened)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { memo } = world.items;
  assert.equal((await summariesOf(app, world.who.peerUser, [memo.id])).body.summaries[0].ok, true, "fixture: the outsider reads it live (public)");
  assert.equal((await removeArtifact(app, world.who.owner, memo)).status, 204);
  const row = await itemRow(memo);
  assert.deepEqual((await summariesOf(app, world.who.peerUser, [memo.id])).body.summaries, [unavailableAt(memo.id)], "an outsider: exactly a missing id's answer");
  assert.deepEqual((await summariesOf(app, world.who.reader, [memo.id])).body.summaries, [deletedAt({ id: memo.id }, row, userActor(world.owner))], "a member of its server: the card, with the deleter's id");
});

test("deleted card: one with no recorded delete is the plain `unavailable`; a signed-out visitor still gets nothing (no summaries, the public view's one 404)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // The fixture's deleted item: in #priv (the reader's), deleted_at set directly, no audit row: nobody to name.
  const { deleted, memo } = world.items;
  assert.deepEqual((await summariesOf(app, world.who.reader, [deleted.id])).body.summaries, [unavailableAt(deleted.id)]);

  assert.equal((await removeArtifact(app, world.who.owner, memo)).status, 204);
  const signedOut = (path: string, init: RequestInit) => fetch(`${app.baseUrl}${path}`, init).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  const asked = (artifactId: string) => ({ method: "POST", headers: { "Content-Type": "application/json", "X-Server-Id": world.server.id }, body: JSON.stringify({ kind: "artifact", refs: [{ id: artifactId }] }) });
  const missing = `pt_${randomUUID()}`;
  const summariesOfDeleted = await signedOut(objectWebPaths.summaries(), asked(memo.id));
  assert.equal(summariesOfDeleted.status, 401, "summaries need a signed-in reader");
  assert.deepEqual(summariesOfDeleted, await signedOut(objectWebPaths.summaries(), asked(missing)), "the same as for an id that names nothing");
  const view = await signedOut(artifactPublicPaths.view(id(memo)), { method: "GET" });
  assert.equal(view.status, 404);
  assert.deepEqual(view, await signedOut(artifactPublicPaths.view(asArtifactId(missing)), { method: "GET" }), "the public view: the one 404, as for an id that names nothing");
});

test("summaries: with Artifacts off every reference is unavailable; a bad body, a reference the kind doesn't read or more than 50 refs 400; an unknown kind 400 naming the kinds; each private, no-store", async ({ app, seed }) => {
  const off = await seedWorld(seed, app, { enabled: false });
  const unavailable = await summariesOf(app, off.who.reader, [off.items.page.id]);
  assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
  assert.deepEqual(unavailable.body.summaries, [{ ref: { id: off.items.page.id }, ok: false, reason: "unavailable" }]);
  assert.equal(unavailable.headers.get("cache-control"), "private, no-store");

  const world = await seedWorld(seed, app);
  const pageId = world.items.page.id;
  const bad: unknown[] = [
    {},
    { kind: "artifact" },
    { kind: "artifact", refs: [] },
    { kind: "artifact", refs: { id: pageId } },
    { kind: "artifact", ids: [pageId] },
    { kind: "artifact", refs: [pageId] },
    { kind: "artifact", refs: [{ id: pageId }, 1] },
    { kind: "artifact", refs: [{ id: pageId }, null] },
    { kind: "artifact", refs: [[pageId]] },
    { kind: "artifact", refs: [{ id: "" }] },
    { kind: "artifact", refs: [{ id: 1 }] },
    { kind: "artifact", refs: [{ version: 1 }] },
    { kind: "artifact", refs: [{ id: "x".repeat(OBJECT_SUMMARIES_MAX_ID_CHARS + 1) }] },
    { kind: 1, refs: [{ id: pageId }] },
    { kind: "artifact", refs: [{ id: pageId }], version: 1 },
    // Artifact references: an id and a whole version from 1, nothing else.
    { kind: "artifact", refs: [{ id: pageId, version: 0 }] },
    { kind: "artifact", refs: [{ id: pageId, version: -1 }] },
    { kind: "artifact", refs: [{ id: pageId, version: 1.5 }] },
    { kind: "artifact", refs: [{ id: pageId, version: "1" }] },
    { kind: "artifact", refs: [{ id: pageId, version: null }] },
    { kind: "artifact", refs: [{ id: pageId, version: 1_000_000_000 }] },
    { kind: "artifact", refs: [{ id: pageId, name: "page" }] },
    [pageId],
  ];
  for (const body of bad) {
    const res = await summaries(app, world.who.reader, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(res.body.code, "INVALID_REQUEST", JSON.stringify(body).slice(0, 80));
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
  const tooMany = await summariesOf(app, world.who.reader, Array.from({ length: OBJECT_SUMMARIES_MAX_REFS + 1 }, () => pageId));
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.body, { error: "too many refs", code: "INVALID_REQUEST", details: { limit: OBJECT_SUMMARIES_MAX_REFS } });
  const most = await summariesOf(app, world.who.reader, Array.from({ length: OBJECT_SUMMARIES_MAX_REFS }, () => pageId));
  assert.equal(most.status, 200);
  assert.equal(most.body.summaries.length, OBJECT_SUMMARIES_MAX_REFS);

  const largest = await summariesAt(app, world.who.reader, [{ id: pageId, version: 999_999_999 }]);
  assert.deepEqual(largest.body.summaries, [unavailableAt(pageId, 999_999_999)], "the largest version is read (and names nothing)");

  const unknown = await summaries(app, world.who.reader, { kind: "artifacts", refs: [{ id: pageId }] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "UNKNOWN_OBJECT_KIND");
  assert.deepEqual(unknown.body.details, { kind: "artifacts", kinds: ["artifact"] });
  assert.match(unknown.body.error, /one of: artifact/);
});

test("summaries: a constant number of queries however many refs, homes, servers and versions", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const peerAuthor: Actor = { type: "user", id: world.peerUser.id };
  async function batch() {
    const rows = [
      await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: byA }),
      await insertItem({ serverId: world.serverId, serverHome: true, author: byA }),
      await insertItem({ serverId: world.serverId, author: byA }),
      await insertItem({ serverId: asServerId(world.peer.id), author: peerAuthor }),
    ];
    for (const row of rows) {
      const author: Actor = { type: row.createdByType, id: row.createdById };
      await publish({ serverId: row.serverId, r2: world.r2 }, author, { itemId: row.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`one ${row.id}`) }] });
    }
    return [...rows.flatMap((row) => [{ id: row.id }, { id: row.id, version: 1 }, { id: row.id, version: 2 }]), { id: world.items.secret.id }];
  }
  const few = await batch();
  const many = [...few, ...(await batch()), ...(await batch()), ...(await batch())];
  const registered = { app: artifactsApp, objectKind: artifactsApp.objectKinds[0]! };
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const small = await countQueries(() => objectSummaries(reader, registered, few));
  const large = await countQueries(() => objectSummaries(reader, registered, many));
  assert.equal(small.value.filter((answer) => answer.ok).length, 8, "each object's current version, also pinned as v1");
  assert.equal(large.value.filter((answer) => answer.ok).length, 32);
  assert.equal(large.queries, small.queries, `${small.queries} queries for ${few.length} refs, ${large.queries} for ${many.length}`);
});

limitedTest("summaries are limited per user on core's own budget (429 RATE_LIMITED past it, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const ids = [world.items.page.id];
  assert.equal((await summariesOf(app, world.who.reader, ids)).status, 200);
  assert.equal((await summariesOf(app, world.who.reader, ids)).status, 200);
  const limited = await summariesOf(app, world.who.reader, ids);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await summariesOf(app, world.who.owner, ids)).status, 200, "another user's own budget");
  // Not the Artifacts writes' budget, nor the viewer's.
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(id(world.items.page)), world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(world.items.page)), world.who.reader)).status, 200);
});

test("POST /api/artifacts/refs is gone: message cards are core's summaries", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const res = await call(app, "POST", "/api/artifacts/refs", world.who.reader, { targets: [linkTo(world.items.page)] });
  assert.equal(res.status, 404);
});

// ---- the dashboard (S7) ------------------------------------------------------------

/** A comment at the item's next position (on its current version), as the write paths number them. */
async function addComment(item: { id: string }, author: Actor, opts: { mentions?: Actor[]; at?: Date; deleted?: boolean; path?: string } = {}) {
  const db = getDb();
  const [row] = await db.update(artifactItems).set({ lastPosition: sql`${artifactItems.lastPosition} + 1` }).where(eq(artifactItems.id, item.id)).returning();
  const commentId = `c_${randomUUID()}`;
  const body = `look @here ${label()}`;
  await db.insert(artifactComments).values({
    id: commentId, itemId: item.id, versionId: row!.currentVersionId!, authorType: author.type, authorId: author.id, body,
    mentions: opts.mentions ?? [], position: row!.lastPosition, createdAt: opts.at ?? new Date(), deletedAt: opts.deleted ? new Date() : null, path: opts.path ?? null,
  });
  return { id: commentId, body, position: row!.lastPosition };
}

/** The reader's read position on an item, written directly (as the viewer would), at `at`. */
async function openedAt(item: { id: string }, actor: Actor, at: Date, position = 0) {
  await getDb().insert(artifactReadPositions).values({ itemId: item.id, actorType: actor.type, actorId: actor.id, position, updatedAt: at });
}

const dashboard = (app: { baseUrl: string }, who: Who, home?: "channel" | "dm" | "server" | "public") => call(app, "GET", artifactWebPaths.dashboard(home ? { home } : {}), who);
const idsOf = (page: { rows: Array<{ card: { id: string } }> }) => page.rows.map((row) => row.card.id);
const readerPositions = (world: World) => getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.actorId, world.reader.id));
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + second * 1000);

// The dashboard is a list: another server's Artifact homed in a joint is in
// it, as it is read.
test("dashboard: a peer member in a joint gets the server's Artifact homed there in its sections", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `web-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addHuman(peerProjection.id, peerMember.id);
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const item = await insertItem({ serverId: world.serverId, homeChannelId: joint.canonical.id, author: byA });
  await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: item.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("<h1>j1</h1>") }] });
  const me: Actor = { type: "user", id: peerMember.id };
  await addComment(item, byA, { mentions: [me], at: at(1) });
  await openedAt(item, me, at(2));
  const member: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };
  const sectionsOf = async () => {
    const res = await dashboard(app, member);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const recent = await call(app, "GET", artifactWebPaths.dashboardSection("recent"), member);
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    return { waiting: idsOf(res.body.waiting), recent: idsOf(res.body.recent), recentPage: idsOf(recent.body) };
  };
  assert.deepEqual(await sectionsOf(), { waiting: [item.id], recent: [item.id], recentPage: [item.id] });
});

test("dashboard: Artifacts off, both routes answer 403 ARTIFACTS_NOT_ENABLED before reading the query, as every route", async ({ app, seed }) => {
  const world = await seedWorld(seed, app, { enabled: false });
  for (const path of [artifactWebPaths.dashboard(), `${artifactWebPaths.dashboard()}?home=nowhere`, artifactWebPaths.dashboardSection("recent", { cursor: "x" }), "/api/artifacts/dashboard/drafts"]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", path);
    assert.equal(res.headers.get("cache-control"), "private, no-store", path);
  }
});

test("dashboard waiting: unread comments by others that mention the reader, one row per Artifact with the newest and the count; never the reader's own, a deleted one, or an Artifact it can't see; opening clears it; the dashboard moves no read position", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo, secret, deleted } = world.items;
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const byA: Actor = { type: "agent", id: world.agentA.id };
  await addComment(page, owner, { mentions: [me], at: at(1) });
  const newest = await addComment(page, byA, { mentions: [me, owner], at: at(2), path: "index.html" });
  await addComment(page, me, { mentions: [me], at: at(3) });
  await addComment(page, owner, { mentions: [me], at: at(4), deleted: true });
  await addComment(page, owner, { mentions: [owner], at: at(5) });
  await addComment(memo, owner, { mentions: [me], at: at(6) });
  // A mention never grants access: the outsider (not in #priv) is mentioned on the page.
  await addComment(page, owner, { mentions: [{ type: "user", id: world.outsider.id }], at: at(8) });
  // Mentioned where the reader can't see: another member's private channel, a deleted Artifact.
  await addComment(secret, owner, { mentions: [me], at: at(9) });
  await addComment(deleted, owner, { mentions: [me], at: at(9) });

  const res = await dashboard(app, world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(res.body).sort(), ["following", "recent", "waiting"]);
  assert.deepEqual(idsOf(res.body.waiting), [memo.id, page.id]);
  assert.equal(res.body.waiting.nextCursor, null);
  const row = res.body.waiting.rows[1];
  assert.deepEqual(row.comment, {
    id: newest.id, author: agentActor(world.agentA), excerpt: newest.body, truncated: false, createdAt: at(2).toISOString(), version: 2, path: "index.html",
  });
  assert.equal(row.count, 2);
  assert.equal(res.body.waiting.rows[0].count, 1);
  // Each person's own: the owner is mentioned by A's comment (its own mention of itself doesn't count) ...
  const owners = (await dashboard(app, world.who.owner)).body.waiting;
  assert.deepEqual(idsOf(owners), [page.id]);
  assert.deepEqual([owners.rows[0].comment.id, owners.rows[0].count], [newest.id, 1]);
  // ... and nothing is shown to whoever can't see it, mentioned or not.
  assert.deepEqual(idsOf((await dashboard(app, world.who.outsider)).body.waiting), []);
  // Reading only: no read position moved, anyone's.
  for (const item of [page, memo, secret]) assert.deepEqual(await readPositionsOf(item.id), [], item.id);

  // The card is exactly the viewer's; opening the current version clears the row.
  const viewer = await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.deepEqual(row.card, viewer.body.card);
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader)).body.waiting), [memo.id]);
  // A newer mention brings it back, counting only what is unread.
  await addComment(page, owner, { mentions: [me], at: at(7) });
  const back = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(back.body.waiting), [page.id, memo.id]);
  assert.equal(back.body.waiting.rows[0].count, 1);
});

test("dashboard following: followed Artifacts with versions or comments by others since the reader's read position; opening clears it; never stopped, not followed or not visible", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, memo, secret, drawing } = world.items;
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const byA: Actor = { type: "agent", id: world.agentA.id };
  for (const item of [page, memo]) assert.equal((await call(app, "PUT", artifactWebPaths.subscription(id(item)), world.who.reader)).status, 200);
  // Followed but not visible: a subscription row on #other's Artifact, with news.
  await getDb().insert(artifactSubscriptions).values({ itemId: secret.id, actorType: "user", actorId: world.reader.id, reason: "followed" });
  await addComment(secret, owner, { at: at(50) });
  // Visible with news, not followed.
  await addComment(drawing, owner, { at: at(50) });

  // Never opened, but starting to follow read everything up to then (decision of 2026-10-26): nothing is new.
  const first = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(first.body.following), []);
  const positions = await readerPositions(world);
  for (const item of [page, memo]) {
    const [row] = await getDb().select({ lastPosition: artifactItems.lastPosition }).from(artifactItems).where(eq(artifactItems.id, item.id));
    assert.equal(positions.find((position) => position.itemId === item.id)?.position, row!.lastPosition, "following moved the read position to the last one");
  }

  await call(app, "GET", artifactWebPaths.viewer(id(memo)), world.who.reader);
  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader)).body.following), []);

  // A new version and a comment by others; the reader's own comment and a deleted one don't count.
  await publish({ serverId: world.serverId, r2: world.r2 }, byA, { itemId: page.id, number: 3, files: [{ path: "index.html", bytes: Buffer.from("<h1>v3</h1>") }] });
  const later = new Date(Date.now() + 60_000);
  await addComment(page, byA, { at: later });
  await addComment(page, me, { at: new Date(later.getTime() + 1000) });
  await addComment(page, owner, { at: new Date(later.getTime() + 2000), deleted: true });
  const before = await readerPositions(world);
  const news = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(news.body.following), [page.id]);
  assert.deepEqual(news.body.following.rows[0].unread, { versions: 1, comments: 1 });
  assert.equal(news.body.following.rows[0].activityAt, later.toISOString());
  assert.deepEqual(await readerPositions(world), before, "the dashboard moves no read position");

  await call(app, "GET", artifactWebPaths.viewer(id(page)), world.who.reader);
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader)).body.following), []);
  // Stopped following: never, whatever is new.
  await addComment(page, owner, { at: new Date(later.getTime() + 3000) });
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader)).body.following), [page.id]);
  assert.equal((await call(app, "DELETE", artifactWebPaths.subscription(id(page)), world.who.reader)).status, 200);
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader)).body.following), []);
});

test("dashboard recent: what the reader published or opened, the later first, each once; never an Artifact it can't see or another server's", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { page, drawing, secret } = world.items;
  const me: Actor = { type: "user", id: world.reader.id };
  const db = getDb();
  const r2 = { serverId: world.serverId, r2: world.r2 };
  await openedAt(page, me, at(10));
  const mine = await publish(r2, me, { itemId: drawing.id, number: 2, files: [{ path: "d.svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }] });
  await db.update(artifactVersions).set({ createdAt: at(20) }).where(eq(artifactVersions.id, mine.id));
  // Not visible: opened and published in #other; opened another server's public Artifact.
  await openedAt(secret, me, at(30));
  const hidden = await publish(r2, me, { itemId: secret.id, number: 2, files: [{ path: "index.html", bytes: Buffer.from("mine, hidden") }] });
  await db.update(artifactVersions).set({ createdAt: at(40) }).where(eq(artifactVersions.id, hidden.id));
  const elsewhere = await insertItem({ serverId: asServerId(world.peer.id), author: { type: "user", id: world.peerUser.id } });
  await publish({ serverId: asServerId(world.peer.id), r2: world.r2 }, { type: "user", id: world.peerUser.id }, { itemId: elsewhere.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from("peer") }] });
  await openedAt(elsewhere, me, at(50));

  const res = await dashboard(app, world.who.reader);
  assert.deepEqual(res.body.recent.rows.map((row: { card: { id: string }; publishedAt: string | null; openedAt: string | null; at: string }) => [row.card.id, row.publishedAt, row.openedAt, row.at]), [
    [drawing.id, at(20).toISOString(), null, at(20).toISOString()],
    [page.id, null, at(10).toISOString(), at(10).toISOString()],
  ]);
  assert.equal(res.body.recent.rows[0].card.version, 2);

  // Opening the one it published: one row, ordered by the opening now.
  await call(app, "GET", artifactWebPaths.viewer(id(drawing)), world.who.reader);
  const again = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(again.body.recent), [drawing.id, page.id]);
  assert.equal(again.body.recent.rows[0].publishedAt, at(20).toISOString());
  assert.ok(again.body.recent.rows[0].openedAt > at(20).toISOString());
  assert.equal(again.body.recent.rows[0].at, again.body.recent.rows[0].openedAt);
});

test("dashboard: an orphan (its home channel hard-deleted) is in no section, even for the owner who opened it; the owner still opens it by id", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const owner: Actor = { type: "user", id: world.owner.id };
  const doomed = await createChannel(world.server.id, `web-doomed-${label()}`, undefined, "private");
  await addHuman(doomed.id, world.owner.id);
  const orphan = await insertItem({ serverId: world.serverId, homeChannelId: doomed.id, author: owner });
  await publish({ serverId: world.serverId, r2: world.r2 }, owner, { itemId: orphan.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("orphan") }] });
  await getDb().insert(artifactSubscriptions).values({ itemId: orphan.id, actorType: "user", actorId: world.owner.id, reason: "published" });
  await openedAt(orphan, owner, at(10));
  const sections = (body: { waiting: { rows: Array<{ card: { id: string } }> }; following: { rows: Array<{ card: { id: string } }> }; recent: { rows: Array<{ card: { id: string } }> } }) =>
    [...idsOf(body.waiting), ...idsOf(body.following), ...idsOf(body.recent)];
  assert.ok(sections((await dashboard(app, world.who.owner)).body).includes(orphan.id), "fixture: listed while its channel stands");

  await getDb().delete(channels).where(eq(channels.id, doomed.id));
  assert.ok(!sections((await dashboard(app, world.who.owner)).body).includes(orphan.id), "an orphan is never listed");
  const opened = await call(app, "GET", artifactWebPaths.viewer(id(orphan)), world.who.owner);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.card.home, { kind: "conversation", conversation: { id: null, name: "", type: "channel" } });
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(orphan)), world.who.reader)).status, 404, "a member who isn't its author, manager, owner or admin");
});

test("dashboard: 20 a page counting only what the reader can see, the next page by cursor; `home` narrows every section; a bad home, section or cursor is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const me: Actor = { type: "user", id: world.reader.id };
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const r2 = { serverId: world.serverId, r2: world.r2 };
  // 22 opened Artifacts in #priv, and 3 in #other interleaved among the newest.
  const seen: string[] = [];
  for (let index = 0; index < 22; index += 1) {
    const item = await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: byA });
    await publish(r2, byA, { itemId: item.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`p ${item.id}`) }] });
    await openedAt(item, me, at(100 + 2 * index));
    seen.unshift(item.id);
  }
  for (let index = 0; index < 3; index += 1) {
    const item = await insertItem({ serverId: world.serverId, homeChannelId: world.other.id, author: byA });
    await publish(r2, byA, { itemId: item.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`o ${item.id}`) }] });
    await openedAt(item, me, at(141 - 2 * index));
  }
  await openedAt(world.items.memo, me, at(1));
  // A DM-homed and a server-homed Artifact, older than the rest.
  const dmAgent = await createAgent(world.server.id, `wa-dm-${label()}`, { runtime: "claude", model: "sonnet" });
  const dm = (await findOrCreateDM(world.server.id, world.reader.id, dmAgent.id))!;
  const inDm = await insertItem({ serverId: world.serverId, homeChannelId: dm.id, author: { type: "agent", id: dmAgent.id } });
  await publish(r2, { type: "agent", id: dmAgent.id }, { itemId: inDm.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`dm ${inDm.id}`) }] });
  await openedAt(inDm, me, at(-1));
  const serverWide = await insertItem({ serverId: world.serverId, serverHome: true, author: { type: "user", id: world.owner.id } });
  await publish(r2, { type: "user", id: world.owner.id }, { itemId: serverWide.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`server ${serverWide.id}`) }] });
  await openedAt(serverWide, me, at(-2));

  const first = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(first.body.recent), seen.slice(0, 20));
  assert.ok(first.body.recent.nextCursor);
  const next = await call(app, "GET", artifactWebPaths.dashboardSection("recent", { cursor: first.body.recent.nextCursor }), world.who.reader);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(Object.keys(next.body).sort(), ["nextCursor", "rows"]);
  assert.deepEqual(idsOf(next.body), [...seen.slice(20), world.items.memo.id, inDm.id, serverWide.id]);
  assert.equal(next.body.nextCursor, null);

  // `home`: each kind keeps only its own.
  assert.deepEqual(idsOf((await dashboard(app, world.who.reader, "public")).body.recent), [world.items.memo.id]);
  const channels = await dashboard(app, world.who.reader, "channel");
  assert.deepEqual(idsOf(channels.body.recent), seen.slice(0, 20));
  const channelsNext = await call(app, "GET", artifactWebPaths.dashboardSection("recent", { home: "channel", cursor: channels.body.recent.nextCursor }), world.who.reader);
  assert.deepEqual(idsOf(channelsNext.body), seen.slice(20));
  assert.equal(channelsNext.body.nextCursor, null);
  for (const [home, only] of [["dm", inDm.id], ["server", serverWide.id]] as const) {
    const res = await dashboard(app, world.who.reader, home);
    assert.deepEqual([idsOf(res.body.waiting), idsOf(res.body.following), idsOf(res.body.recent)], [[], [], [only]], home);
    assert.equal(res.body.recent.nextCursor, null, home);
  }
  // A guest never sees the server home, even with a read position on it; public it does.
  await seedBoundGuest({ serverId: world.server.id, userId: world.outsider.id });
  const guest: Actor = { type: "user", id: world.outsider.id };
  await openedAt(serverWide, guest, at(5));
  await openedAt(world.items.memo, guest, at(4));
  assert.deepEqual(idsOf((await dashboard(app, world.who.outsider, "server")).body.recent), []);
  assert.deepEqual(idsOf((await dashboard(app, world.who.outsider)).body.recent), [world.items.memo.id]);
  assert.deepEqual(idsOf((await dashboard(app, world.who.outsider, "public")).body.recent), [world.items.memo.id]);

  for (const path of [
    "/api/artifacts/dashboard?home=nowhere",
    "/api/artifacts/dashboard?home=dm&home=public",
    "/api/artifacts/dashboard/drafts",
    artifactWebPaths.dashboardSection("recent", { cursor: "not-a-cursor" }),
    artifactWebPaths.dashboardSection("recent", { cursor: Buffer.from(JSON.stringify(["never", "pt_x"])).toString("base64url") }),
    // A cursor pages one section, never the whole dashboard.
    `${artifactWebPaths.dashboard()}?cursor=${first.body.recent.nextCursor}`,
    // Times JavaScript reads but Postgres's timestamptz doesn't hold, as the cursor's milliseconds or as text.
    ...["+275760-09-13T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z", "0000-12-31T23:59:59.999Z", "+010000-01-01T00:00:00.000Z"].flatMap((time) => [
      artifactWebPaths.dashboardSection("recent", { cursor: Buffer.from(JSON.stringify([Date.parse(time), "pt_x"])).toString("base64url") }),
      artifactWebPaths.dashboardSection("recent", { cursor: Buffer.from(JSON.stringify([time, "pt_x"])).toString("base64url") }),
    ]),
    artifactWebPaths.dashboardSection("recent", { cursor: Buffer.from(JSON.stringify([1.5, "pt_x"])).toString("base64url") }),
    // A good time with an id that is no Artifact id (`pt_<uuid>`); a NUL would fail inside the query.
    ...["x", "pt_x", `pt_${randomUUID()}\u0000`, `pt_${randomUUID()} `, randomUUID(), `pt_${randomUUID().toUpperCase()}x`, ""].map((cursorId) =>
      artifactWebPaths.dashboardSection("recent", { cursor: Buffer.from(JSON.stringify([Date.parse("2026-01-01T00:00:00.000Z"), cursorId])).toString("base64url") })),
  ]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }
});

test("dashboard: Artifacts whose sort times differ only below a millisecond page by id, each once, none lost", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const r2 = { serverId: world.serverId, r2: world.r2 };
  const ids: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    const item = await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: byA });
    await publish(r2, byA, { itemId: item.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`u ${item.id}`) }] });
    await openedAt(item, { type: "user", id: world.reader.id }, at(0));
    // Within one millisecond, a microsecond apart (a JavaScript Date can't carry them).
    await getDb().execute(sql`UPDATE ${artifactReadPositions} SET updated_at = ${at(0).toISOString()}::timestamptz + make_interval(secs => ${(index + 1) / 1e6})
      WHERE item_id = ${item.id} AND actor_id = ${world.reader.id}::uuid`);
    ids.push(item.id);
  }
  const [{ micros } = { micros: 0 }] = (await getDb().execute(sql`SELECT count(DISTINCT updated_at)::int AS micros FROM ${artifactReadPositions} WHERE actor_id = ${world.reader.id}::uuid`)).rows as Array<{ micros: number }>;
  assert.equal(micros, 21, "the times differ below a millisecond");
  const byId = [...ids].sort().reverse();
  const first = await dashboard(app, world.who.reader);
  assert.deepEqual(idsOf(first.body.recent), byId.slice(0, 20));
  const next = await call(app, "GET", artifactWebPaths.dashboardSection("recent", { cursor: first.body.recent.nextCursor }), world.who.reader);
  assert.deepEqual(idsOf(next.body), byId.slice(20));
  assert.equal(next.body.nextCursor, null);
});

test("dashboard: a constant number of queries however many rows, homes and authors", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const byA: Actor = { type: "agent", id: world.agentA.id };
  const r2 = { serverId: world.serverId, r2: world.r2 };
  /** One Artifact of each kind of home the reader can see, in every section. */
  async function batch() {
    const dmAgent = await createAgent(world.server.id, `wa-dm-${label()}`, { runtime: "claude", model: "sonnet" });
    const dm = (await findOrCreateDM(world.server.id, world.reader.id, dmAgent.id))!;
    const rows = [
      await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: byA }),
      await insertItem({ serverId: world.serverId, homeChannelId: dm.id, author: { type: "agent", id: dmAgent.id } }),
      await insertItem({ serverId: world.serverId, serverHome: true, author: owner }),
      await insertItem({ serverId: world.serverId, author: byA }),
    ];
    for (const row of rows) {
      await publish(r2, { type: row.createdByType, id: row.createdById }, { itemId: row.id, number: 1, files: [{ path: "a.txt", bytes: Buffer.from(`one ${row.id}`) }] });
      await openedAt(row, me, new Date(), 1);
      await addComment(row, byA, { mentions: [me] });
      await addComment(row, owner, { mentions: [me] });
      await getDb().insert(artifactSubscriptions).values({ itemId: row.id, actorType: "user", actorId: world.reader.id, reason: "followed" });
    }
  }
  const api = createArtifactWebApi();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  await batch();
  const small = await countQueries(() => api.dashboard(reader, {}));
  await batch();
  await batch();
  await batch();
  const large = await countQueries(() => api.dashboard(reader, {}));
  const sizes = (result: typeof small) => (result.value.kind === "json" ? [result.value.body.waiting.rows.length, result.value.body.following.rows.length, result.value.body.recent.rows.length] : result.value.body.code);
  assert.deepEqual(sizes(small), [4, 4, 4]);
  assert.deepEqual(sizes(large), [16, 16, 16]);
  assert.ok(small.queries > 0, "the count observes queries");
  assert.equal(large.queries, small.queries, `${small.queries} queries for 4 Artifacts, ${large.queries} for 16`);
});

limitedTest("the dashboard is limited per user on its own budget, both routes together (429 RATE_LIMITED past it)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await dashboard(app, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", artifactWebPaths.dashboardSection("waiting"), world.who.reader)).status, 200);
  const limited = await dashboard(app, world.who.reader);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await dashboard(app, world.who.owner)).status, 200, "another user's own budget");
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(id(world.items.page)), world.who.reader)).status, 200, "not the viewer's");
});
