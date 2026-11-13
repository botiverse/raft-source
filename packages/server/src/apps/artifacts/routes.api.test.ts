// The read side of the Artifacts agent API (S1a), over HTTP with real agent
// credentials: the flag gate, one 404 for everything not visible, homes ×
// agents, list order/paging/target, read positions (advanced only by reading
// the current version, and by the unseen comments list over what it showed),
// files (bytes, JSON, path checks) and the stores behind them.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { artifactLinkId, asArtifactId, asServerId, decodeArtifactShortId, encodeArtifactShortId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createMessage } from "../../services/messageService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { ARTIFACTS_NOT_ENABLED, fileNotFound, notVisible, storageUnavailable, targetNotFound, versionNotFound } from "./apiCommon";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { advanceReadPosition } from "./routes";
import {
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactHomeKind,
} from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

/** A body as it arrives: undefined fields (a hint's unset arguments) dropped. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const test = createApiTest();

// Keys verify by HMAC, not argon2 (64 MiB a verify), whose allocation failing
// under memory pressure core's credential lookup reads as a 401.
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-read-tests-hmac-secret-0123456789ab");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);
/** The short id of an Artifact's `pt_<uuid>` (shared artifactShortId). */
const shortOf = (id: string) => encodeArtifactShortId(id.slice("pt_".length));
/**
 * A fresh string that is both a short id and an Artifact name (a digit, then
 * digits and lowercase without `l`), and the `pt_` id it decodes to.
 */
function nameShapedShortId(): { name: string; id: string } {
  const chars = "123456789abcdefghijkmnopqrstuvwxyz";
  const name = `1${Array.from({ length: 21 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")}`;
  return { name, id: `pt_${decodeArtifactShortId(name)!}` };
}

// ---- stores ------------------------------------------------------------------

/** R2 in memory: r2_key -> bytes. */
function memoryR2(objects: Map<string, Buffer>, presigned: string[] = []): ArtifactR2Store {
  return {
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async delete(key) {
      objects.delete(key);
    },
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign(blob, options) {
      const url = `https://r2.example.test/${blob.r2Key}?ct=${encodeURIComponent(options.contentType)}&ttl=${options.expiresInSeconds}`;
      presigned.push(url);
      return url;
    },
  };
}

// ---- seeding ---------------------------------------------------------------

type Actor = { type: "user" | "agent"; id: string };

function enableArtifacts() {
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
}

async function insertItem(input: {
  serverId: ServerId;
  homeKind: ArtifactHomeKind;
  homeChannelId?: string;
  author: Actor;
  name?: string;
  updatedAt?: Date;
  deleted?: boolean;
  revoked?: boolean;
  id?: string;
}) {
  const id = input.id ?? `pt_${randomUUID()}`;
  // An old name (Artifacts from before titles keep theirs): what the name lookups below resolve.
  const name = input.name ?? `art-${label()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name,
    title: `Artifact ${id.slice(3, 11)}`,
    homeKind: input.homeKind,
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    updatedAt: input.updatedAt ?? new Date(),
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  }).returning();
  return { ...row!, name };
}

type FileSpec = { path: string; bytes: Buffer };

/** A blob per file (one per server and bytes), then the version. */
async function publish(ctx: { r2: Map<string, Buffer>; serverId: string }, input: {
  itemId: string;
  number: number;
  position: number;
  publisher: Actor;
  files: FileSpec[];
  note?: string;
  current?: boolean;
}) {
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId,
    itemId: input.itemId,
    number: input.number,
    entry: input.files[0]!.path,
    note: input.note ?? null,
    fileCount: input.files.length,
    sizeBytes: input.files.reduce((sum, file) => sum + file.bytes.length, 0),
    publishDigest: "digest",
    status: "published",
    publisherType: input.publisher.type,
    publisherId: input.publisher.id,
    position: input.position,
  }).returning();
  for (const file of input.files) {
    const bytes = file.bytes;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Content-addressed: the same bytes are one blob of the server.
    const serverId = asServerId(ctx.serverId);
    const fresh = `b_${randomUUID()}`;
    const key = r2KeyOf(serverId, sha256, fresh);
    ctx.r2.set(key, bytes);
    await db.insert(artifactBlobs).values({ id: fresh, serverId, sha256, sizeBytes: bytes.length, r2Key: key }).onConflictDoNothing();
    const [blob] = await db.select({ id: artifactBlobs.id }).from(artifactBlobs).where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha256)));
    const blobId = blob!.id;
    await db.insert(artifactVersionFiles).values({ versionId, path: file.path, sha256, sizeBytes: bytes.length, blobId });
  }
  if (input.current !== false) {
    await db.update(artifactItems).set({ currentVersionId: versionId }).where(eq(artifactItems.id, input.itemId));
  }
  await bumpLastPosition(input.itemId, input.position);
  return version!;
}

async function bumpLastPosition(itemId: string, position: number) {
  const [item] = await getDb().select({ last: artifactItems.lastPosition }).from(artifactItems).where(eq(artifactItems.id, itemId));
  if (item!.last < position) await getDb().update(artifactItems).set({ lastPosition: position }).where(eq(artifactItems.id, itemId));
}

async function comment(input: { itemId: string; versionId: string; position: number; author: Actor; body: string; path?: string; deleted?: boolean }) {
  const [row] = await getDb().insert(artifactComments).values({
    id: `c_${randomUUID()}`,
    itemId: input.itemId,
    versionId: input.versionId,
    path: input.path ?? null,
    authorType: input.author.type,
    authorId: input.author.id,
    body: input.body,
    position: input.position,
    deletedAt: input.deleted ? new Date() : null,
  }).returning();
  await bumpLastPosition(input.itemId, input.position);
  return row!;
}

async function readPosition(itemId: string, agentId: string): Promise<number | null> {
  const [row] = await getDb().select().from(artifactReadPositions).where(and(
    eq(artifactReadPositions.itemId, itemId), eq(artifactReadPositions.actorType, "agent"), eq(artifactReadPositions.actorId, agentId),
  ));
  return row?.position ?? null;
}

/**
 * A server with the flag on: owner (human), agentIn (in #pub and #priv, DM
 * with the owner), agentOut (in no channel), a thread in #pub, and an agent
 * of another server. Artifacts:
 *   priv    home #priv: v1 (pos 1), c1 (pos 2, owner), v2 (pos 3), c2 (pos 4, owner, long), c3 (pos 5, agentIn)
 *   server  home server
 *   pub     home #pub (public channel)
 *   dm      home owner<->agentIn DM
 *   public  home public: pv1 (pos 1), a comment (pos 2, owner), pv2 (pos 3)
 *   deleted / revoked  home server
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const serverId = asServerId(server.id);
  const agentIn = await createAgent(server.id, `art-in-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentOut = await createAgent(server.id, `art-out-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, `art-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `art-pub-${label()}`);
  await addHuman(pub.id, owner.id);
  await addAgent(pub.id, agentIn.id);
  const priv = await createChannel(server.id, `art-priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addAgent(priv.id, agentIn.id);
  const dm = (await findOrCreateDM(server.id, owner.id, agentIn.id))!;
  const root = await createMessage(pub.id, "user", owner.id, `thread root ${label()}`);

  const ownerActor: Actor = { type: "user", id: owner.id };
  const agentInActor: Actor = { type: "agent", id: agentIn.id };
  const r2 = new Map<string, Buffer>();
  const ctx = { r2, serverId: server.id };
  const base = Date.now() - 60_000;
  const at = (offset: number) => new Date(base + offset * 1000);

  const priv1 = await insertItem({ serverId, homeKind: "conversation", homeChannelId: priv.id, author: ownerActor, name: `priv-${label()}`, updatedAt: at(6) });
  const v1 = await publish(ctx, { itemId: priv1.id, number: 1, position: 1, publisher: ownerActor, note: "first", files: [
    { path: "index.html", bytes: Buffer.from("<h1>v1</h1>") },
    { path: "notes.md", bytes: Buffer.from("# notes") },
  ] });
  const c1 = await comment({ itemId: priv1.id, versionId: v1.id, position: 2, author: ownerActor, body: "first look", path: "index.html" });
  const v2 = await publish(ctx, { itemId: priv1.id, number: 2, position: 3, publisher: ownerActor, note: "logo", files: [
    { path: "index.html", bytes: Buffer.from("<h1>v2</h1>") },
    { path: "notes.md", bytes: Buffer.from("# notes") },
    { path: "assets/logo.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ] });
  const longBody = "é".repeat(400);
  const c2 = await comment({ itemId: priv1.id, versionId: v2.id, position: 4, author: ownerActor, body: longBody, path: "notes.md" });
  const c3 = await comment({ itemId: priv1.id, versionId: v2.id, position: 5, author: agentInActor, body: "my own note" });

  const serverItem = await insertItem({ serverId, homeKind: "server", author: ownerActor, updatedAt: at(5) });
  const pubItem = await insertItem({ serverId, homeKind: "conversation", homeChannelId: pub.id, author: agentInActor, updatedAt: at(4) });
  const dmItem = await insertItem({ serverId, homeKind: "conversation", homeChannelId: dm.id, author: ownerActor, updatedAt: at(3) });
  const publicItem = await insertItem({ serverId, homeKind: "public", author: ownerActor, updatedAt: at(2) });
  const pv1 = await publish(ctx, { itemId: publicItem.id, number: 1, position: 1, publisher: ownerActor, files: [
    { path: "index.html", bytes: Buffer.from("p1") },
    { path: "draft-acquisition-plan.html", bytes: Buffer.from("secret plan") },
  ] });
  await comment({ itemId: publicItem.id, versionId: pv1.id, position: 2, author: ownerActor, body: "members only" });
  await publish(ctx, { itemId: publicItem.id, number: 2, position: 3, publisher: ownerActor, files: [{ path: "index.html", bytes: Buffer.from("p2") }] });
  const deleted = await insertItem({ serverId, homeKind: "server", author: ownerActor, deleted: true, updatedAt: at(7) });
  const revoked = await insertItem({ serverId, homeKind: "server", author: ownerActor, revoked: true, updatedAt: at(8) });

  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read"], name: `art-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  return {
    server, peer, serverId, owner, agentIn, agentOut, peerAgent, channels: { pub, priv, dm }, root,
    items: { priv: priv1, server: serverItem, pub: pubItem, dm: dmItem, public: publicItem, deleted, revoked },
    versions: { v1, v2 },
    comments: { c1, c2, c3 },
    longBody,
    r2,
    keys: { in: await key(agentIn.id), out: await key(agentOut.id), peer: await key(peerAgent.id) },
  };
}

// ---- HTTP ----------------------------------------------------------------------

/** A GET with the path sent exactly as written (fetch would normalise `..` and `%2e%2e`). */
function rawGet(baseUrl: string, path: string, apiKey: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: "GET", path, headers: { Authorization: `Bearer ${apiKey}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function getJson(baseUrl: string, path: string, apiKey: string): Promise<{ status: number; body: any }> {
  const res = await rawGet(baseUrl, `/internal/agent-api${path}`, apiKey);
  return { status: res.status, body: JSON.parse(res.body.toString("utf8") || "null") };
}

function withStores(world: { r2: Map<string, Buffer> }) {
  __setArtifactR2StoreForTests(memoryR2(world.r2));
}

function resetStores() {
  __setArtifactR2StoreForTests(undefined);
}

// ---- tests ---------------------------------------------------------------------

test("Artifacts off: every route answers 403 ARTIFACTS_NOT_ENABLED and nothing else", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { priv } = world.items;
  const paths = [
    "/artifacts",
    `/artifacts/${priv.id}`,
    `/artifacts/${priv.id}/comments`,
    `/artifacts/${priv.id}/files/index.html`,
    `/artifacts/${priv.id}/files/index.html/content`,
    "/artifacts/pt_missing",
  ];
  for (const path of paths) {
    const res = await getJson(app.baseUrl, path, world.keys.in);
    assert.equal(res.status, 403, path);
    assert.deepEqual(res.body, wire(ARTIFACTS_NOT_ENABLED.body), path);
  }
  assert.equal(await readPosition(priv.id, world.agentIn.id), null, "a refused read moves nothing");
});

test("not visible, missing, deleted and revoked answer one identical 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  withStores(world);
  try {
    const { priv, deleted, revoked, dm } = world.items;
    const cases: Array<[string, string]> = [
      [world.keys.out, priv.id], // private home, agent not in it
      [world.keys.out, priv.name], // by old name, same
      [world.keys.out, priv.title], // by title, same
      [world.keys.out, dm.id], // someone else's DM
      [world.keys.in, "pt_00000000-0000-4000-8000-000000000000"], // no such artifact
      [world.keys.in, "no-such-name"],
      [world.keys.in, "Not A Title Anyone Has"], // anything else is a title
      [world.keys.in, deleted.id],
      [world.keys.in, deleted.name],
      [world.keys.in, deleted.title],
      [world.keys.in, revoked.id],
      [world.keys.in, revoked.title],
      [world.keys.peer, priv.id], // another server's agent, non-public home
    ];
    const bodies = new Set<string>();
    for (const [key, ref] of cases) {
      for (const suffix of ["", "/comments", "/files/index.html", "/files/index.html/content"]) {
        const res = await rawGet(app.baseUrl, `/internal/agent-api/artifacts/${encodeURIComponent(ref)}${suffix}`, key);
        assert.equal(res.status, 404, `${ref}${suffix}`);
        bodies.add(res.body.toString("utf8"));
      }
    }
    assert.deepEqual([...bodies], [JSON.stringify(notVisible().body)]);
    // A title or a name is looked up only in the caller's server: the peer agent can't name a public artifact.
    assert.equal((await getJson(app.baseUrl, `/artifacts/${world.items.public.name}`, world.keys.peer)).status, 404);
    assert.equal((await getJson(app.baseUrl, `/artifacts/${encodeURIComponent(world.items.public.title)}`, world.keys.peer)).status, 404);
    // Its own agents find it by either.
    assert.equal((await getJson(app.baseUrl, `/artifacts/${encodeURIComponent(world.items.public.title.toUpperCase())}`, world.keys.in)).body.artifact.id, world.items.public.id);
  } finally {
    resetStores();
  }
});

test("who sees what, by home: list and read agree", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  withStores(world);
  try {
    const { items } = world;
    const listed = async (key: string) => ((await getJson(app.baseUrl, "/artifacts?limit=50", key)).body.artifacts as Array<{ id: string }>).map((row) => row.id);
    // Most recently updated first.
    assert.deepEqual(await listed(world.keys.in), [items.priv.id, items.server.id, items.pub.id, items.dm.id, items.public.id]);
    // Not in #priv, not in the DM; a public channel's home is seen without joining it.
    assert.deepEqual(await listed(world.keys.out), [items.server.id, items.pub.id, items.public.id]);
    // Another server's agent lists nothing of this server.
    assert.deepEqual(await listed(world.keys.peer), []);
    for (const [key, visible] of [[world.keys.in, [items.priv, items.server, items.pub, items.dm, items.public]], [world.keys.out, [items.server, items.pub, items.public]]] as const) {
      for (const item of Object.values(items)) {
        const res = await getJson(app.baseUrl, `/artifacts/${item.id}`, key);
        assert.equal(res.status, visible.some((row) => row.id === item.id) ? 200 : 404, `${item.id}`);
      }
    }
    // Outside the server: a public artifact by id, current version only, no comments (always).
    const outsider = await getJson(app.baseUrl, `/artifacts/${items.public.id}`, world.keys.peer);
    assert.equal(outsider.status, 200);
    assert.equal(outsider.body.versions.total, 1);
    assert.equal(outsider.body.unseen.commentCount, 0);
    assert.equal(outsider.body.mayPush, false, "another server's: a pull of it is a copy");
    assert.equal((await getJson(app.baseUrl, `/artifacts/${items.public.id}?version=1`, world.keys.peer)).body.code, "VERSION_NOT_FOUND");
    for (const view of ["?all=1", ""]) {
      const comments = await getJson(app.baseUrl, `/artifacts/${items.public.id}/comments${view}`, world.keys.peer);
      assert.equal(comments.status, 200, view);
      assert.deepEqual(comments.body.comments, [], view);
    }
    // Nothing of the hidden versions, not even the names of files only they had.
    assert.deepEqual(outsider.body.versions.latest.map((v: { number: number; changedPaths: string[] }) => [v.number, v.changedPaths]), [[2, []]]);
    assert.doesNotMatch(JSON.stringify(outsider.body), /draft-acquisition-plan/);
    const member = await getJson(app.baseUrl, `/artifacts/${items.public.id}`, world.keys.in);
    assert.deepEqual(member.body.versions.latest[0].changedPaths, ["draft-acquisition-plan.html", "index.html"]);
    assert.equal(member.body.mayPush, true, "its own server's agent pushes to it");
    // Files of hidden versions, as bytes or JSON; the current one is readable.
    for (const suffix of ["", "/content"]) {
      const old = await getJson(app.baseUrl, `/artifacts/${items.public.id}/files/index.html${suffix}?version=1`, world.keys.peer);
      assert.deepEqual(old, { status: 404, body: wire(versionNotFound(items.public.id, 1, 2).body) });
    }
    assert.equal((await rawGet(app.baseUrl, `/internal/agent-api/artifacts/${items.public.id}/files/index.html`, world.keys.peer)).body.toString(), "p2");
    assert.equal((await getJson(app.baseUrl, `/artifacts/${items.public.id}/files/index.html/content`, world.keys.peer)).body.content, "p2");
    assert.equal((await getJson(app.baseUrl, `/artifacts/${items.public.id}/comments?all=1`, world.keys.in)).body.comments.length, 1);

    // Homes as the agent names them.
    const homes = new Map(((await getJson(app.baseUrl, "/artifacts?limit=50", world.keys.in)).body.artifacts as Array<{ id: string; home: unknown }>).map((row) => [row.id, row.home]));
    assert.deepEqual(homes.get(items.priv.id), { kind: "conversation", conversation: { id: world.channels.priv.id, type: "private", target: `#${world.channels.priv.name}` } });
    assert.deepEqual(homes.get(items.server.id), { kind: "server", serverName: world.server.name }, "named by its server (#84)");
    assert.deepEqual(homes.get(items.public.id), { kind: "public" });
    const dmHome = homes.get(items.dm.id) as { conversation: { type: string; target: string } };
    assert.equal(dmHome.conversation.type, "dm");
    assert.match(dmHome.conversation.target, new RegExp(`^dm:@${world.owner.name}`));

    // A deleted author agent has no handle: its name may now be a live agent's.
    const gone = await createAgent(world.server.id, `art-gone-${label()}`, { runtime: "claude", model: "sonnet" });
    await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
    await getDb().update(artifactItems).set({ createdByType: "agent", createdById: gone.id }).where(eq(artifactItems.id, items.server.id));
    assert.deepEqual((await getJson(app.baseUrl, `/artifacts/${items.server.id}`, world.keys.in)).body.artifact.author, { type: "agent", name: null });
    assert.deepEqual((await getJson(app.baseUrl, `/artifacts/${items.pub.id}`, world.keys.in)).body.artifact.author, { type: "agent", name: world.agentIn.name });
  } finally {
    resetStores();
  }
});

test("list: pages by cursor, filters by target, maps a thread target to its parent", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const { items } = world;
  const first = await getJson(app.baseUrl, "/artifacts?limit=2", world.keys.in);
  assert.deepEqual(first.body.artifacts.map((row: { id: string }) => row.id), [items.priv.id, items.server.id]);
  assert.equal(first.body.target, null);
  const second = await getJson(app.baseUrl, `/artifacts?limit=2&cursor=${first.body.nextCursor}`, world.keys.in);
  assert.deepEqual(second.body.artifacts.map((row: { id: string }) => row.id), [items.pub.id, items.dm.id]);
  const third = await getJson(app.baseUrl, `/artifacts?limit=2&cursor=${second.body.nextCursor}`, world.keys.in);
  assert.deepEqual(third.body.artifacts.map((row: { id: string }) => row.id), [items.public.id]);
  assert.equal(third.body.nextCursor, null);
  assert.equal((await getJson(app.baseUrl, "/artifacts?cursor=garbage", world.keys.in)).status, 400);

  const priv = await getJson(app.baseUrl, `/artifacts?target=${encodeURIComponent(`#${world.channels.priv.name}`)}`, world.keys.in);
  assert.deepEqual(priv.body.artifacts.map((row: { id: string }) => row.id), [items.priv.id]);
  assert.deepEqual(priv.body.target, { target: `#${world.channels.priv.name}`, conversationId: world.channels.priv.id, homeFromThread: null });

  const shortId = world.root.id.slice(0, 8);
  const thread = await getJson(app.baseUrl, `/artifacts?target=${encodeURIComponent(`#${world.channels.pub.name}:${shortId}`)}`, world.keys.in);
  assert.deepEqual(thread.body.artifacts.map((row: { id: string }) => row.id), [items.pub.id]);
  assert.deepEqual(thread.body.target, { target: `#${world.channels.pub.name}`, conversationId: world.channels.pub.id, homeFromThread: shortId });

  // A conversation the agent can't see is not a target.
  const hidden = await getJson(app.baseUrl, `/artifacts?target=${encodeURIComponent(`#${world.channels.priv.name}`)}`, world.keys.out);
  assert.deepEqual(hidden, { status: 404, body: wire(targetNotFound({ target: `#${world.channels.priv.name}` }).body) });
});

test("read: the current version, what's new since last time, and the read position", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const { priv } = world.items;

  // An older version: shown, nothing unseen, the position untouched.
  const old = await getJson(app.baseUrl, `/artifacts/${priv.id}?version=1`, world.keys.in);
  assert.equal(old.status, 200);
  assert.equal(old.body.version.number, 1);
  assert.equal(old.body.version.current, false);
  assert.equal(old.body.unseen, null);
  assert.equal(await readPosition(priv.id, world.agentIn.id), null);
  assert.equal((await getJson(app.baseUrl, `/artifacts/${priv.id}?version=9`, world.keys.in)).body.code, "VERSION_NOT_FOUND");

  const res = await getJson(app.baseUrl, `/artifacts/${priv.id}`, world.keys.in);
  assert.equal(res.status, 200);
  const body = res.body;
  // The link carries the short id; the id field stays pt_… (released CLIs read it).
  assert.equal(body.artifact.url, `${new URL(body.artifact.url).origin}/artifacts/${artifactLinkId(asArtifactId(priv.id))}`);
  assert.equal(body.artifact.id, priv.id);
  assert.equal(body.artifact.kind, "html");
  assert.equal(body.artifact.currentVersion, 2);
  assert.deepEqual(body.artifact.author, { type: "user", name: world.owner.name });
  assert.deepEqual(body.version.files, [
    { path: "assets/logo.png", sizeBytes: 4, kind: "image", entry: false },
    { path: "index.html", sizeBytes: 11, kind: "html", entry: true },
    { path: "notes.md", sizeBytes: 7, kind: "markdown", entry: false },
  ]);
  assert.equal(body.versions.total, 2);
  assert.deepEqual(body.versions.latest.map((v: { number: number; changedPaths: string[] }) => [v.number, v.changedPaths]), [
    [2, ["assets/logo.png", "index.html"]],
    [1, ["index.html", "notes.md"]],
  ]);
  // Others' versions and comments; the agent's own comment (c3) is not news to it.
  assert.equal(body.unseen.firstRead, true);
  assert.equal(body.unseen.versionCount, 2);
  assert.equal(body.unseen.commentCount, 2);
  assert.deepEqual(body.unseen.versions.map((v: { number: number }) => v.number), [1, 2]);
  assert.deepEqual(body.unseen.comments.map((c: { id: string; version: number; path: string | null }) => [c.id, c.version, c.path]), [
    [world.comments.c1.id, 1, "index.html"],
    [world.comments.c2.id, 2, "notes.md"],
  ]);
  const long = body.unseen.comments[1];
  assert.equal(long.truncated, true);
  assert.equal(long.bodyChars, 400);
  assert.equal(Array.from(long.excerpt as string).length, 300);
  assert.equal(body.unseen.comments[0].bodyChars, "first look".length);
  assert.equal(body.unseen.commentsCursor, null, "every unseen comment was shown");
  assert.deepEqual(body.viewing, []);
  // Reading the current version moves over others' versions and the comments
  // it showed in full, and stops before c2 (4), whose excerpt was cut short
  // (task #71): c2 stays unseen until the agent reads it in full.
  assert.equal(body.unseen.unread, 1);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 3, "up to the comment not shown in full");

  const again = await getJson(app.baseUrl, `/artifacts/${priv.id}`, world.keys.in);
  assert.deepEqual(
    { firstRead: again.body.unseen.firstRead, versionCount: again.body.unseen.versionCount, commentCount: again.body.unseen.commentCount, comments: again.body.unseen.comments.map((c: { id: string }) => c.id), unread: again.body.unseen.unread },
    { firstRead: false, versionCount: 0, commentCount: 1, comments: [world.comments.c2.id], unread: 1 },
  );
  // Listing the new comments shows c2 in full: now it's seen, and so is the agent's own c3 after it.
  assert.deepEqual((await getJson(app.baseUrl, `/artifacts/${priv.id}/comments`, world.keys.in)).body.comments.map((c: { id: string }) => c.id), [world.comments.c2.id]);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 4);
  const cleared = await getJson(app.baseUrl, `/artifacts/${priv.id}`, world.keys.in);
  assert.deepEqual({ commentCount: cleared.body.unseen.commentCount, unread: cleared.body.unseen.unread }, { commentCount: 0, unread: 0 });
  assert.equal(await readPosition(priv.id, world.agentIn.id), 5);
  // By old name in the agent's server, and `version` naming the current version reads it as current.
  const byName = await getJson(app.baseUrl, `/artifacts/${priv.name}?version=2`, world.keys.in);
  assert.equal(byName.body.artifact.id, priv.id);
  assert.notEqual(byName.body.unseen, null);
});

test("read: the short id a link carries is the same Artifact as its pt_ id, on the read, file and comments routes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const { priv } = world.items;
  withStores(world);
  try {
    const short = artifactLinkId(asArtifactId(priv.id));
    assert.match(short, /^[1-9A-HJ-NP-Za-km-z]{22}$/);
    const read = await getJson(app.baseUrl, `/artifacts/${short}?version=1`, world.keys.in);
    assert.equal(read.status, 200);
    assert.equal(read.body.artifact.id, priv.id, "the answer names it by its pt_ id");
    assert.equal(read.body.version.number, 1);
    const file = await rawGet(app.baseUrl, `/internal/agent-api/artifacts/${short}/files/index.html?version=1`, world.keys.in);
    assert.equal(file.status, 200);
    assert.equal(file.body.toString(), "<h1>v1</h1>");
    assert.equal((await getJson(app.baseUrl, `/artifacts/${short}/comments?all=1`, world.keys.in)).status, 200);
    // The one 404 for an id the agent can't see: one it isn't in the home of, one that names nothing.
    for (const [key, id] of [[world.keys.out, short], [world.keys.in, artifactLinkId(asArtifactId(`pt_${randomUUID()}`))]] as const) {
      assert.deepEqual((await getJson(app.baseUrl, `/artifacts/${id}`, key)).body.code, "NOT_VISIBLE");
    }
    // Not an id (22 characters of Base58 over 16 bytes): looked up as a title, and none has it.
    assert.deepEqual((await getJson(app.baseUrl, "/artifacts/YcVfxkQb6JRzqk5kF2tNLw", world.keys.in)).body, wire(notVisible().body));
  } finally {
    resetStores();
  }
});

test("a short id that is also a name: the id whenever an Artifact has it, seen or not; the name only when none does", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const owner: Actor = { type: "user", id: world.owner.id };
  const inPrivate = { serverId: world.serverId, homeKind: "conversation" as const, homeChannelId: world.channels.priv.id, author: owner };
  const serverWide = { serverId: world.serverId, homeKind: "server" as const, author: owner };

  // 1. No Artifact has the id: the string is a name, and the one named so is found.
  const named = nameShapedShortId();
  const byName = await insertItem({ ...serverWide, name: named.name });
  const found = await getJson(app.baseUrl, `/artifacts/${named.name}`, world.keys.out);
  assert.equal(found.status, 200);
  assert.equal(found.body.artifact.id, byName.id);

  // 2. An Artifact has the id but the caller can't see it, and none has the name: the one 404, the same
  // status and body as a short id no Artifact has, so the answer doesn't tell that it exists.
  const hidden = nameShapedShortId();
  await insertItem({ ...inPrivate, id: hidden.id });
  const unseen = await getJson(app.baseUrl, `/artifacts/${hidden.name}`, world.keys.out);
  const nothing = await getJson(app.baseUrl, `/artifacts/${nameShapedShortId().name}`, world.keys.out);
  const nothingCapitals = await getJson(app.baseUrl, `/artifacts/${shortOf(`pt_${randomUUID()}`)}`, world.keys.out);
  assert.deepEqual(unseen, { status: 404, body: wire(notVisible().body) });
  assert.deepEqual(nothing, unseen);
  assert.deepEqual(nothingCapitals, unseen);

  // 3. An Artifact has the id but the caller can't see it, and one it can see has the name: still the 404,
  // never the named one.
  const both = nameShapedShortId();
  const byId = await insertItem({ ...inPrivate, id: both.id });
  await insertItem({ ...serverWide, name: both.name });
  assert.deepEqual(await getJson(app.baseUrl, `/artifacts/${both.name}`, world.keys.out), unseen);
  // Someone who sees the id's Artifact gets it, not the named one.
  assert.equal((await getJson(app.baseUrl, `/artifacts/${both.name}`, world.keys.in)).body.artifact.id, byId.id);
  // A deleted Artifact with the id counts too: the 404, not the name.
  const gone = nameShapedShortId();
  await insertItem({ ...serverWide, id: gone.id, deleted: true });
  await insertItem({ ...serverWide, name: gone.name });
  assert.deepEqual(await getJson(app.baseUrl, `/artifacts/${gone.name}`, world.keys.in), unseen);
});

test("read: more unseen comments than shown hand over a cursor that pages them from the first", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const owner: Actor = { type: "user", id: world.owner.id };
  const item = await insertItem({ serverId: world.serverId, homeKind: "server", author: owner });
  const version = await publish({ r2: world.r2, serverId: world.server.id }, { itemId: item.id, number: 1, position: 1, publisher: owner, files: [{ path: "a.txt", bytes: Buffer.from("a") }] });
  // The agent had looked up to position 1, then 7 comments came in.
  await advanceReadPosition({ type: "agent", id: world.agentIn.id }, item.id, 1);
  const ids: string[] = [];
  for (let n = 0; n < 7; n += 1) ids.push((await comment({ itemId: item.id, versionId: version.id, position: 2 + n, author: owner, body: `comment ${n}` })).id);

  const read = await getJson(app.baseUrl, `/artifacts/${item.id}`, world.keys.in);
  assert.equal(read.body.unseen.commentCount, 7);
  assert.deepEqual(read.body.unseen.comments.map((c: { id: string }) => c.id), ids.slice(2), "the newest five, oldest first");
  assert.equal(read.body.unseen.commentsCursor, "1");
  const paged = await getJson(app.baseUrl, `/artifacts/${item.id}/comments?all=1&cursor=${read.body.unseen.commentsCursor}`, world.keys.in);
  assert.deepEqual(paged.body.comments.map((c: { id: string }) => c.id), ids);
});

test("comments: unseen by default, all, by path; the position moves over what was shown only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const { priv } = world.items;
  const owner: Actor = { type: "user", id: world.owner.id };

  // Unseen versions (v1, v2) come before and between the comments: the list
  // shows the comments in full and counts the versions, and the position
  // moves over both (as a hold's does: task #71, so listing the comments
  // clears what holds a publish), up to the last comment shown.
  const first = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments`, world.keys.in);
  assert.equal(first.body.view, "unseen");
  assert.deepEqual(first.body.comments.map((c: { id: string }) => c.id), [world.comments.c1.id, world.comments.c2.id]);
  assert.equal(first.body.comments[1].body, world.longBody, "full text");
  assert.equal(first.body.unseenVersionCount, 2);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 4);

  await getJson(app.baseUrl, `/artifacts/${priv.id}`, world.keys.in);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 5);
  const c4 = await comment({ itemId: priv.id, versionId: world.versions.v2.id, position: 6, author: owner, body: "on index", path: "index.html" });
  const c5 = await comment({ itemId: priv.id, versionId: world.versions.v2.id, position: 7, author: owner, body: "on notes", path: "notes.md" });
  await comment({ itemId: priv.id, versionId: world.versions.v2.id, position: 8, author: owner, body: "gone", deleted: true });

  // One file's comments: c4 on another file wasn't shown, so the position stays before it.
  const notes = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments?path=notes.md`, world.keys.in);
  assert.deepEqual(notes.body.comments.map((c: { id: string }) => c.id), [c5.id]);
  assert.equal(notes.body.path, "notes.md");
  assert.equal(await readPosition(priv.id, world.agentIn.id), 5);

  const unseen = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments`, world.keys.in);
  assert.deepEqual(unseen.body.comments.map((c: { id: string }) => c.id), [c4.id, c5.id]);
  assert.equal(unseen.body.unseenVersionCount, 0);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 7);
  assert.deepEqual((await getJson(app.baseUrl, `/artifacts/${priv.id}/comments`, world.keys.in)).body.comments, []);

  // A cursor past the read position: the comments before it weren't shown, so the position stops before them.
  const c6 = await comment({ itemId: priv.id, versionId: world.versions.v2.id, position: 9, author: owner, body: "six" });
  const c7 = await comment({ itemId: priv.id, versionId: world.versions.v2.id, position: 10, author: owner, body: "seven" });
  const skipped = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments?cursor=9`, world.keys.in);
  assert.deepEqual(skipped.body.comments.map((c: { id: string }) => c.id), [c7.id]);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 8, "up to c6 (9) only; 8 is a deleted comment");
  const rest = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments`, world.keys.in);
  assert.deepEqual(rest.body.comments.map((c: { id: string }) => c.id), [c6.id, c7.id]);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 10);

  // Every comment, the agent's own included, oldest first; deleted ones never.
  const all = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments?all=1`, world.keys.in);
  assert.equal(all.body.view, "all");
  assert.deepEqual(all.body.comments.map((c: { id: string }) => c.id), [world.comments.c1.id, world.comments.c2.id, world.comments.c3.id, c4.id, c5.id, c6.id, c7.id]);
  assert.deepEqual(all.body.comments[2].author, { type: "agent", name: world.agentIn.name });
  assert.equal(all.body.nextCursor, null);
  assert.equal(await readPosition(priv.id, world.agentIn.id), 10, "all=1 moves nothing");
  const byPath = await getJson(app.baseUrl, `/artifacts/${priv.id}/comments?all=1&path=index.html`, world.keys.in);
  assert.deepEqual(byPath.body.comments.map((c: { id: string }) => c.id), [world.comments.c1.id, c4.id]);
});

test("read positions only move forward", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const item = await insertItem({ serverId: asServerId(server.id), homeKind: "server", author: { type: "user", id: owner.id } });
  const agentId = randomUUID();
  await advanceReadPosition({ type: "agent", id: agentId }, item.id, 5);
  await advanceReadPosition({ type: "agent", id: agentId }, item.id, 3);
  assert.equal(await readPosition(item.id, agentId), 5);
  await advanceReadPosition({ type: "agent", id: agentId }, item.id, 9);
  assert.equal(await readPosition(item.id, agentId), 9);
});

test("files: bytes and JSON, exact paths only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  const presigned: string[] = [];
  __setArtifactR2StoreForTests(memoryR2(world.r2, presigned));
  try {
    const base = `/internal/agent-api/artifacts/${world.items.priv.id}/files`;
    const html = await rawGet(app.baseUrl, `${base}/index.html`, world.keys.in);
    assert.equal(html.status, 200);
    assert.equal(html.body.toString(), "<h1>v2</h1>");
    assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(html.headers["content-length"], "11");
    assert.match(String(html.headers["content-disposition"]), /^attachment;/);
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    assert.equal(html.headers["content-security-policy"], "sandbox; default-src 'none'");
    assert.equal(html.headers["cache-control"], "private, no-store");
    assert.equal((await rawGet(app.baseUrl, `${base}/index.html?version=1`, world.keys.in)).body.toString(), "<h1>v1</h1>");
    // A nested path is one encoded segment.
    const logo = await rawGet(app.baseUrl, `${base}/assets%2Flogo.png`, world.keys.in);
    assert.equal(logo.status, 200);
    assert.deepEqual([...logo.body], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(logo.headers["content-type"], "image/png");

    const missing = await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/assets%2Flogo.png?version=1`, world.keys.in);
    assert.deepEqual(missing, { status: 404, body: wire(fileNotFound(world.items.priv.id, "assets/logo.png", 1).body) });
    assert.equal((await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/logo.png/content`, world.keys.in)).body.code, "FILE_NOT_FOUND");

    const text = await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/notes.md/content`, world.keys.in);
    assert.deepEqual(text.body, { kind: "text", path: "notes.md", version: 2, size: 7, contentType: "text/markdown; charset=utf-8", encoding: "utf8", content: "# notes", truncated: false });
    const binary = await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/assets%2Flogo.png/content`, world.keys.in);
    assert.equal(binary.body.kind, "binary");
    assert.equal(binary.body.size, 4);
    assert.match(binary.body.downloadUrl, /^https:\/\/r2\.example\.test\/servers\/[0-9a-f-]+\/blobs\//);
    assert.ok(Date.parse(binary.body.expiresAt) > Date.now() + 290_000);

    // A text file over the cap: cut at a character boundary, marked truncated.
    const owner: Actor = { type: "user", id: world.owner.id };
    const big = await insertItem({ serverId: world.serverId, homeKind: "server", author: owner });
    await publish({ r2: world.r2, serverId: world.server.id }, { itemId: big.id, number: 1, position: 1, publisher: owner, files: [
      { path: "big.txt", bytes: Buffer.from("é".repeat(200_000)) },
      { path: "photo.jpg", bytes: Buffer.from([1, 2, 3]) },
    ] });
    const cut = await getJson(app.baseUrl, `/artifacts/${big.id}/files/big.txt/content`, world.keys.in);
    assert.equal(cut.body.truncated, true);
    assert.equal(cut.body.size, 400_000);
    assert.equal(cut.body.content, "é".repeat(131_072));
    const photo = await getJson(app.baseUrl, `/artifacts/${big.id}/files/photo.jpg/content`, world.keys.in);
    assert.match(photo.body.downloadUrl, /^https:\/\/r2\.example\.test\/servers\/[0-9a-f-]+\/blobs\//);
    assert.equal(presigned.length, 2);

    // R2 not configured: the bytes' store is unavailable, said as such.
    __setArtifactR2StoreForTests(null);
    const down = await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/index.html`, world.keys.in);
    assert.deepEqual(down, { status: 503, body: wire(storageUnavailable().body) });
  } finally {
    resetStores();
  }
});

test("files: malformed paths are refused before any lookup, in every encoding", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  enableArtifacts();
  withStores(world);
  try {
    const malformed = [
      "..%2Findex.html", // ../index.html
      "%2e%2e%2Findex.html", // ../index.html, dots encoded
      "%2E%2E", // ..
      "assets%2F..%2F..%2Fsecret", // assets/../../secret
      "%252e%252e%252findex.html", // double-encoded ../index.html
      "%25252E%25252E", // triple-encoded ..
      ".", // a dot segment
      "assets%2F.%2Flogo.png", // assets/./logo.png
      "assets%2F%2Flogo.png", // doubled slash
      "%2Findex.html", // leading slash
      "assets%2F", // trailing slash
      "assets%5Clogo.png", // backslash
      "index.html%00", // NUL
      "index%0A.html", // a control character
      "index%7F.html", // DEL
      "%252e%252e%252f%25zz", // encoded traversal beside a stray `%`
      "%25zz%252f..%252findex.html",
      "%252e%252e%2525",
      "100%25.html", // a literal `%`: no stored path has one (Porthole's path rules)
      "a%3Fb", // `?`
      "a%23b", // `#`
    ];
    for (const segment of malformed) {
      for (const suffix of ["", "/content"]) {
        const res = await rawGet(app.baseUrl, `/internal/agent-api/artifacts/${world.items.priv.id}/files/${segment}${suffix}`, world.keys.in);
        assert.equal(res.status, 400, `${segment}${suffix}: ${res.body}`);
        assert.equal(JSON.parse(res.body.toString()).code, "INVALID_PATH", `${segment}${suffix}`);
      }
    }
    // A well-formed path the version doesn't have.
    assert.equal((await getJson(app.baseUrl, `/artifacts/${world.items.priv.id}/files/a..b.html`, world.keys.in)).body.code, "FILE_NOT_FOUND");
  } finally {
    resetStores();
  }
});
