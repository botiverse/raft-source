// Reading one Artifact as a person (readAsUser.ts readArtifactAsUser), called
// as its caller calls it: the function, no HTTP. Proves what its header
// promises: the answer is what that person could open on the web and nothing
// more (the web's own operations are asked beside it and compared), every
// reference that doesn't open reads as one refusal, and nothing is written
// (no read position, no follow, no comment, no object event).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT,
  AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES,
  artifactLinkId,
  asArtifactId,
  asServerId,
  type ServerId,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { objectEvents } from "../../db/schema";
import { appHosts } from "../../platform/links";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { ARTIFACTS_NOT_ENABLED_ERROR } from "./apiCommon";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { isFollowing } from "./comments";
import { readArtifactAsUser, type ArtifactReadAsUser, type ArtifactReadAsUserInput } from "./readAsUser";
import {
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
} from "./schema";
import { createWebCommentOperations } from "./webComments";
import { webFail, webFileNotFound, webInvalidPath, webNotVisible, webVersionNotFound, type ArtifactWebReader } from "./webCommon";
import { createViewerOperations } from "./webViewer";

afterEach(async () => {
  await statementsSettled();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);

// ---- the test database's statements ----------------------------------------------

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
/** The statements of the current test's database that were started and have not ended. */
let statements = { running: 0 };

/** Count the statements of this test's database as they start and end (the client goes with the database, so nothing is restored). */
function watchStatements() {
  const counted = { running: 0 };
  statements = counted;
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const query = pg.query.bind(pg);
  pg.query = (...args: unknown[]) => {
    counted.running += 1;
    return query(...args).finally(() => {
      counted.running -= 1;
    });
  };
}

/**
 * Wait until no statement is running and none follows one that just ended.
 * A version that isn't there is refused as soon as the versions are read,
 * while the reads the viewer makes beside that one (webViewer.ts
 * viewerDataOf) are still on their way, so the answer comes back before they
 * end. They must end before the test's database closes: closed under them,
 * PGlite doesn't fail the next one, it never returns from it. After each test,
 * a failed one included.
 */
async function statementsSettled(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (let quietTurns = 0; quietTurns < 3;) {
    if (Date.now() > deadline) throw new Error(`${statements.running} statements of the test's database were still running after 30 seconds`);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    quietTurns = statements.running === 0 ? quietTurns + 1 : 0;
  }
}

// ---- seeding (web.api.test.ts's, the parts a read needs) -------------------------

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

/** A published version (current), its entry the first file, its files r2 blobs of the server kept in `r2`. */
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

const V1 = {
  html: "<h1>v1</h1>",
  notes: "# Notes\n\nfirst\n",
  css: "h1 { color: teal; }\n",
  old: "only in the first version",
};
const V2 = {
  html: "<h1>v2</h1><script>alert(1)</script>",
  notes: "# Notes\n\nsecond, with an é\n",
};

/**
 * A server with #priv (owner, reader, agent A) and #other (owner only);
 * bystander a member in neither; a peer server whose only member is peerUser.
 * Artifacts by agent A: page in #priv (v1; v2 current, without old.txt),
 * secret in #other, deleted and revoked in #priv, board homed in the server,
 * memo public (v1, v2). Artifacts are on for the deployment.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  watchStatements();
  const owner = await seed.human();
  const reader = await seed.human();
  const bystander = await seed.human();
  const server = await seed.server({ owner, members: [reader, bystander] });
  const serverId = asServerId(server.id);
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const agentA = await createAgent(server.id, `ru-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const priv = await createChannel(server.id, `ru-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  await addAgent(priv.id, agentA.id);
  const other = await createChannel(server.id, `ru-other-${label()}`, undefined, "private");
  await addHuman(other.id, owner.id);

  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const store = { serverId, r2 };
  const byA: Actor = { type: "agent", id: agentA.id };
  const page = await insertItem({ serverId, homeChannelId: priv.id, author: byA });
  const v1 = await publish(store, byA, { itemId: page.id, number: 1, files: [
    { path: "index.html", bytes: Buffer.from(V1.html) },
    { path: "assets/logo.png", bytes: PNG },
    { path: "notes.md", bytes: Buffer.from(V1.notes) },
    { path: "old.txt", bytes: Buffer.from(V1.old) },
    { path: "style.css", bytes: Buffer.from(V1.css) },
  ] });
  const v2 = await publish(store, byA, { itemId: page.id, number: 2, files: [
    { path: "index.html", bytes: Buffer.from(V2.html) },
    { path: "assets/logo.png", bytes: PNG },
    { path: "notes.md", bytes: Buffer.from(V2.notes) },
    { path: "style.css", bytes: Buffer.from(V1.css) },
  ] });
  const secret = await insertItem({ serverId, homeChannelId: other.id, author: byA });
  await publish(store, byA, { itemId: secret.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("secret") }] });
  const deleted = await insertItem({ serverId, homeChannelId: priv.id, author: byA, deleted: true });
  await publish(store, byA, { itemId: deleted.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("gone") }] });
  const revoked = await insertItem({ serverId, homeChannelId: priv.id, author: byA, revoked: true });
  await publish(store, byA, { itemId: revoked.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("revoked") }] });
  const board = await insertItem({ serverId, serverHome: true, author: byA });
  await publish(store, byA, { itemId: board.id, number: 1, files: [{ path: "board.md", bytes: Buffer.from("# board") }] });
  const memo = await insertItem({ serverId, author: byA });
  const memoV1 = await publish(store, byA, { itemId: memo.id, number: 1, files: [{ path: "memo.md", bytes: Buffer.from("# memo v1") }] });
  const memoV2 = await publish(store, byA, { itemId: memo.id, number: 2, files: [{ path: "memo.md", bytes: Buffer.from("# memo v2") }] });

  const as = (user: { id: string }, sid: ServerId = serverId): ArtifactWebReader => ({ userId: user.id, serverId: sid, sessionFamilyId: null });
  return {
    server, serverId, peer, owner, reader, bystander, peerUser, agentA, byA, priv, other, store,
    items: { page, secret, deleted, revoked, board, memo },
    versions: { v1, v2, memoV1, memoV2 },
    who: { owner: as(owner), reader: as(reader), bystander: as(bystander), peerUser: as(peerUser, asServerId(peer.id)) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

// ---- asking ----------------------------------------------------------------------

type Answer = Awaited<ReturnType<typeof readArtifactAsUser>>;
type Options = Omit<ArtifactReadAsUserInput, "serverId" | "userId" | "ref">;

const read = (reader: ArtifactWebReader, ref: string, options: Options = {}): Promise<Answer> =>
  readArtifactAsUser({ serverId: reader.serverId, userId: reader.userId, ref, ...options });

/** The Artifact as answered: 200 and its body. */
function shown(answer: Answer): ArtifactReadAsUser {
  if (answer.kind !== "json") assert.fail(`refused where the Artifact was expected: ${answer.status} ${answer.body.code}`);
  assert.equal(answer.status, 200);
  return answer.body;
}

/** A refusal as answered, whole (kind, status and body). */
function refused(answer: Answer) {
  if (answer.kind !== "error") assert.fail("answered the Artifact where a refusal was expected");
  return answer;
}

const open = async (reader: ArtifactWebReader, ref: string, options: Options = {}) => shown(await read(reader, ref, options));
const shortId = (row: { id: string }) => artifactLinkId(asArtifactId(row.id));
const linkTo = (row: { id: string }, version?: number) => `${getAppUrl()}/artifacts/${shortId(row)}${version === undefined ? "" : `/v/${version}`}`;
const agentActor = (agent: { id: string; name: string; displayName: string | null; avatarUrl: string | null }) =>
  ({ type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName || agent.name, avatarUrl: agent.avatarUrl });
const size = (text: string) => Buffer.byteLength(text);
const itemRow = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;

/** Comments on `item`, one per entry, at the positions after its last one (the item's last position moved with them). */
async function comment(item: { id: string }, entries: Array<{ author: Actor; versionId: string; body: string; path?: string; replyTo?: string; deleted?: boolean }>) {
  const from = (await itemRow(item.id)).lastPosition;
  const rows = entries.map((entry, index) => ({
    id: `c_${String(from + index).padStart(4, "0")}-${randomUUID()}`,
    itemId: item.id,
    versionId: entry.versionId,
    path: entry.path ?? null,
    replyTo: entry.replyTo ?? null,
    authorType: entry.author.type,
    authorId: entry.author.id,
    body: entry.body,
    deletedAt: entry.deleted ? new Date() : null,
    position: from + index + 1,
  }));
  await getDb().insert(artifactComments).values(rows);
  await getDb().update(artifactItems).set({ lastPosition: from + rows.length }).where(eq(artifactItems.id, item.id));
  return rows;
}

/** The references to an Artifact that don't open for `world.who.reader`, each with what it is. */
function closedRefs(world: World): Array<[string, string]> {
  const { page, secret, deleted, revoked } = world.items;
  const unknown = { id: `pt_${randomUUID()}` };
  return [
    ["an Artifact of a private conversation the reader is not in", secret.id],
    ["its short id", shortId(secret)],
    ["a link to it", linkTo(secret)],
    ["a link to its version", linkTo(secret, 1)],
    ["a deleted Artifact", deleted.id],
    ["a link to a deleted Artifact", linkTo(deleted)],
    ["a revoked Artifact", revoked.id],
    ["an id no Artifact has", unknown.id],
    ["a short id no Artifact has", shortId(unknown)],
    ["a link to an id no Artifact has", linkTo(unknown)],
    ["the title of an Artifact the reader can't open", secret.title],
    ["the title of an Artifact the reader can open", page.title],
    ["the old name of an Artifact the reader can open", page.name!],
    ["a link on a host that isn't Raft's to an Artifact the reader can open", `https://example.com/artifacts/${shortId(page)}`],
    ["a link to something else on Raft's host", `${getAppUrl()}/channels/${shortId(page)}`],
    ["words", "the quarterly report"],
    ["nothing", ""],
  ];
}

/** What a caller may ask beside the reference: none of it changes a refusal of the reference. */
const ASKED: Options[] = [{}, { version: 1 }, { version: 7 }, { path: "index.html" }, { path: "../index.html" }, { comments: true }];

// ---- what a member is shown ------------------------------------------------------

test("a member reading an Artifact of their conversation gets its facts, every version, the shown version's files, and the entry file's text", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const body = await open(world.who.reader, page.id);
  const row = await itemRow(page.id);
  const a = agentActor(world.agentA);

  assert.deepEqual(Object.keys(body).sort(), ["file", "files", "item", "versions"]);
  assert.deepEqual(body.item, {
    id: page.id,
    url: `${getAppUrl()}/artifacts/${shortId(page)}`,
    title: page.title,
    description: "what it is",
    home: { kind: "conversation", conversation: { id: world.priv.id, name: world.priv.name, type: "private" } },
    author: a,
    version: 2,
    latestVersion: 2,
    position: row.lastPosition,
    commentCount: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  assert.deepEqual(body.versions, [
    { number: 2, publisher: a, createdAt: world.versions.v2.createdAt.toISOString(), note: null, changedPaths: ["index.html", "notes.md", "old.txt"] },
    { number: 1, publisher: a, createdAt: world.versions.v1.createdAt.toISOString(), note: null, changedPaths: ["assets/logo.png", "index.html", "notes.md", "old.txt", "style.css"] },
  ]);
  assert.deepEqual(body.files, [
    { path: "assets/logo.png", kind: "image", sizeBytes: PNG.length, entry: false },
    { path: "index.html", kind: "html", sizeBytes: size(V2.html), entry: true },
    { path: "notes.md", kind: "markdown", sizeBytes: size(V2.notes), entry: false },
    { path: "style.css", kind: "text", sizeBytes: size(V1.css), entry: false },
  ]);
  assert.deepEqual(body.file, {
    path: "index.html",
    entry: true,
    contentType: "text/html; charset=utf-8",
    sizeBytes: size(V2.html),
    kind: "text",
    text: V2.html,
    truncated: false,
  });
});

test("the versions, files and facts are the ones the web's details operation answers the same reader, for the current version, an older one, and an outsider's public one", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page, memo } = world.items;
  const viewer = createViewerOperations();
  const cases: Array<[string, ArtifactWebReader, string, number | undefined]> = [
    ["the member, the current version", world.who.reader, page.id, undefined],
    ["the member, version 1", world.who.reader, page.id, 1],
    ["the owner, the current version", world.who.owner, page.id, undefined],
    ["another server's member, a public Artifact", world.who.peerUser, memo.id, undefined],
  ];
  for (const [what, reader, id, version] of cases) {
    const body = await open(reader, id, version === undefined ? {} : { version });
    const web = await viewer.details(reader, id, version === undefined ? {} : { version: String(version) });
    if (web.kind !== "json") assert.fail(`the web refused ${what}`);
    const { card } = web.body;
    assert.deepEqual(body.versions, web.body.versions, what);
    assert.deepEqual(body.files, web.body.files, what);
    assert.deepEqual(body.item, {
      id: card.id,
      url: card.url,
      title: card.title,
      description: card.description,
      home: card.home,
      author: card.author,
      version: card.version,
      latestVersion: card.latestVersion,
      position: body.item.position,
      commentCount: card.commentCount,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }, what);
  }
  // Not an empty comparison: the member's lists hold both versions and the four files.
  const member = await open(world.who.reader, page.id);
  assert.equal(member.versions.length, 2);
  assert.equal(member.files.length, 4);
});

// ---- the reference ---------------------------------------------------------------

test("an Artifact is named by its id, its short id or a link on any of Raft's app hosts, each with the same answer", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const byId = await open(world.who.reader, page.id);
  const origin = new URL(byId.item.url);
  assert.ok(appHosts().includes(origin.hostname), "the canonical link is on one of the app hosts");

  const refs: Array<[string, string]> = [
    ["the short id", shortId(page)],
    ["the canonical link", byId.item.url],
    ["the link with a server in it", `${origin.origin}/s/${world.server.slug}/artifacts/${shortId(page)}`],
    ["the link with the long id", `${origin.origin}/artifacts/${page.id}`],
    ["the id with spaces around it", `  ${page.id}\n`],
    ...appHosts().map((host): [string, string] => [`a link on ${host}`, `https://${host}/artifacts/${shortId(page)}`]),
  ];
  for (const [what, ref] of refs) {
    assert.deepEqual(await open(world.who.reader, ref), byId, what);
  }
});

test("a link ending in /v/<n> shows version n, and a version given beside it wins over the link's", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const row = await itemRow(page.id);

  const linked = await open(world.who.reader, linkTo(page, 1));
  assert.equal(linked.item.version, 1);
  assert.equal(linked.item.latestVersion, 2);
  assert.equal(linked.item.url, linkTo(page, 1));
  assert.equal(linked.item.updatedAt, world.versions.v1.createdAt.toISOString());
  assert.deepEqual(linked.files.map((file) => file.path), ["assets/logo.png", "index.html", "notes.md", "old.txt", "style.css"]);
  assert.deepEqual(linked.versions.map((version) => version.number), [2, 1]);
  assert.deepEqual(linked.file, { path: "index.html", entry: true, contentType: "text/html; charset=utf-8", sizeBytes: size(V1.html), kind: "text", text: V1.html, truncated: false });

  // The same version asked by number is the same answer.
  assert.deepEqual(await open(world.who.reader, page.id, { version: 1 }), linked);

  const overridden = await open(world.who.reader, linkTo(page, 1), { version: 2 });
  assert.equal(overridden.item.version, 2);
  assert.equal(overridden.item.url, linkTo(page, 2));
  assert.equal(overridden.file.kind === "text" && overridden.file.text, V2.html);
  const back = await open(world.who.reader, linkTo(page, 2), { version: 1 });
  assert.equal(back.item.version, 1);
  assert.equal(back.file.kind === "text" && back.file.text, V1.html);

  // No version asked: the current one, and the link without a version.
  const current = await open(world.who.reader, linkTo(page));
  assert.equal(current.item.version, 2);
  assert.equal(current.item.url, linkTo(page));
  assert.equal(current.item.updatedAt, row.updatedAt.toISOString());

  // A version the Artifact doesn't have is the web's 404, by number or by link.
  assert.deepEqual(refused(await read(world.who.reader, page.id, { version: 9 })), webVersionNotFound(9, 2));
  const missing = refused(await read(world.who.reader, linkTo(page, 9)));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "VERSION_NOT_FOUND");
  assert.deepEqual(missing.body.details, { version: 9, currentVersion: 2 });
});

// ---- one file --------------------------------------------------------------------

test("a path names another file of the shown version: text files with their text, a binary file with only its size and type", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const fileAt = async (path: string, version?: number) => (await open(world.who.reader, page.id, { path, ...(version === undefined ? {} : { version }) })).file;

  assert.deepEqual(await fileAt("notes.md"), {
    path: "notes.md", entry: false, contentType: "text/markdown; charset=utf-8", sizeBytes: size(V2.notes), kind: "text", text: V2.notes, truncated: false,
  });
  assert.deepEqual(await fileAt("style.css"), {
    path: "style.css", entry: false, contentType: "text/css; charset=utf-8", sizeBytes: size(V1.css), kind: "text", text: V1.css, truncated: false,
  });
  // The whole object: a binary file carries no `text` and no `truncated`.
  assert.deepEqual(await fileAt("assets/logo.png"), { path: "assets/logo.png", entry: false, contentType: "image/png", sizeBytes: PNG.length, kind: "binary" });
  // The entry asked by its path is the entry.
  assert.deepEqual(await fileAt("index.html"), (await open(world.who.reader, page.id)).file);
  // The path is looked up in the version shown.
  assert.deepEqual(await fileAt("notes.md", 1), {
    path: "notes.md", entry: false, contentType: "text/markdown; charset=utf-8", sizeBytes: size(V1.notes), kind: "text", text: V1.notes, truncated: false,
  });
  assert.deepEqual(await fileAt("old.txt", 1), {
    path: "old.txt", entry: false, contentType: "text/plain; charset=utf-8", sizeBytes: size(V1.old), kind: "text", text: V1.old, truncated: false,
  });

  // The rest of the answer is the one without a path.
  const withPath = await open(world.who.reader, page.id, { path: "notes.md" });
  const without = await open(world.who.reader, page.id);
  assert.deepEqual({ ...withPath, file: without.file }, without);
});

test("a path no file can have is the web's 400 INVALID_PATH, and a path the shown version lacks its 404 FILE_NOT_FOUND", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  for (const path of ["../index.html", "/index.html", "assets//logo.png", "assets/", ".git/config", "notes.md?raw", ""]) {
    const answer = refused(await read(world.who.reader, page.id, { path }));
    assert.equal(answer.status, 400, JSON.stringify(path));
    assert.equal(answer.body.code, "INVALID_PATH", JSON.stringify(path));
    assert.deepEqual(answer, webInvalidPath(path), JSON.stringify(path));
  }
  for (const [path, version, shownVersion] of [["nope.txt", undefined, 2], ["old.txt", undefined, 2], ["old.txt", 2, 2], ["assets", undefined, 2], ["INDEX.HTML", 1, 1]] as const) {
    const answer = refused(await read(world.who.reader, page.id, { path, ...(version === undefined ? {} : { version }) }));
    assert.equal(answer.status, 404, path);
    assert.equal(answer.body.code, "FILE_NOT_FOUND", path);
    assert.deepEqual(answer, webFileNotFound(path, shownVersion), path);
  }
});

test("a text file longer than the limit comes back cut at a whole character with truncated true, and one exactly at the limit whole", async ({ seed }) => {
  const world = await seedWorld(seed);
  const max = AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES;
  // A two-byte character straddles the cut: it is left out whole.
  const long = Buffer.from(`${"x".repeat(max - 1)}é${"y".repeat(100)}`);
  const exact = Buffer.from("z".repeat(max));
  const big = await insertItem({ serverId: world.serverId, homeChannelId: world.priv.id, author: world.byA });
  await publish(world.store, world.byA, { itemId: big.id, number: 1, files: [{ path: "big.txt", bytes: long }, { path: "exact.txt", bytes: exact }] });

  const cut = (await open(world.who.reader, big.id)).file;
  if (cut.kind !== "text") assert.fail("big.txt was not answered as text");
  assert.equal(cut.truncated, true);
  assert.equal(cut.sizeBytes, long.length);
  assert.equal(cut.text.length, max - 1);
  assert.equal(cut.text === "x".repeat(max - 1), true);
  assert.equal(cut.entry, true);

  const whole = (await open(world.who.reader, big.id, { path: "exact.txt" })).file;
  if (whole.kind !== "text") assert.fail("exact.txt was not answered as text");
  assert.equal(whole.truncated, false);
  assert.equal(whole.sizeBytes, max);
  assert.equal(whole.text === "z".repeat(max), true);
});

// ---- comments --------------------------------------------------------------------

test("with comments asked, the answer holds the newest page of comments, oldest first, exactly as the web's comment list answers that reader; not asked, it holds no comments key", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const { v1, v2 } = world.versions;
  const web = createWebCommentOperations();
  const webPage = async (reader: ArtifactWebReader) => {
    const answer = await web.comments(reader, page.id, {});
    if (answer.kind !== "json") assert.fail("the web refused the comment list");
    return { comments: answer.body.comments, olderCursor: answer.body.olderCursor };
  };
  const [first] = await comment(page, [{ author: { type: "user", id: world.owner.id }, versionId: v1.id, body: "first, from the owner" }]);
  const rest = await comment(page, [
    { author: world.byA, versionId: v2.id, body: "a reply from the agent", replyTo: first!.id },
    { author: { type: "user", id: world.reader.id }, versionId: v2.id, body: "the reader's own, on a file", path: "notes.md" },
    { author: { type: "user", id: world.owner.id }, versionId: v2.id, body: "taken back", deleted: true },
  ]);
  const written = [first!, ...rest];

  const body = await open(world.who.reader, page.id, { comments: true });
  const listed = body.comments;
  if (listed === undefined) assert.fail("no comments in the answer");
  assert.deepEqual(listed.comments.map((entry) => entry.id), written.map((row) => row.id));
  assert.deepEqual(listed.comments.map((entry) => entry.body), [
    [{ type: "text", text: "first, from the owner" }],
    [{ type: "text", text: "a reply from the agent" }],
    [{ type: "text", text: "the reader's own, on a file" }],
    [],
  ]);
  assert.deepEqual(listed.comments.map((entry) => entry.version), [1, 2, 2, 2]);
  assert.deepEqual(listed.comments.map((entry) => entry.author.id), [world.owner.id, world.agentA.id, world.reader.id, world.owner.id]);
  assert.deepEqual(listed.comments.map((entry) => entry.replyTo), [null, first!.id, null, null]);
  assert.deepEqual(listed.comments[2]!.target, { scope: "file", path: "notes.md", anchor: null });
  assert.equal(listed.comments[3]!.deletedAt === null, false);
  assert.equal(listed.olderCursor, null);
  assert.deepEqual(listed, await webPage(world.who.reader));
  // The live ones are counted on the item; the rest of the answer is the one without comments.
  assert.equal(body.item.commentCount, 3);
  const without = await open(world.who.reader, page.id);
  assert.deepEqual(Object.keys(without).sort(), ["file", "files", "item", "versions"]);
  assert.equal(without.comments === undefined, true);
  assert.deepEqual({ ...without, comments: listed }, body);
  assert.deepEqual(Object.keys(await open(world.who.reader, page.id, { comments: false })).sort(), ["file", "files", "item", "versions"]);

  // More than a page: the newest page, oldest first, and the web's cursor to the ones before.
  const more = await comment(page, Array.from({ length: AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT }, (_, index) => ({ author: world.byA, versionId: v2.id, body: `later ${index}` })));
  const all = [...written, ...more];
  const paged = (await open(world.who.owner, page.id, { comments: true })).comments;
  if (paged === undefined) assert.fail("no comments in the answer");
  assert.equal(paged.comments.length, AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT);
  assert.deepEqual(paged.comments.map((entry) => entry.id), all.slice(-AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT).map((row) => row.id));
  assert.equal(paged.olderCursor, String(all.at(-AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT)!.position));
  assert.deepEqual(paged, await webPage(world.who.owner));
});

// ---- outside the Artifact's server -----------------------------------------------

test("a member of another server reading a public Artifact gets its current version only, nobody's id, and no comments", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { memo } = world.items;
  const { memoV1, memoV2 } = world.versions;
  await comment(memo, [{ author: { type: "user", id: world.owner.id }, versionId: memoV2.id, body: "for members only" }]);
  const row = await itemRow(memo.id);
  // Shown without an id: who in that server it is stays there.
  const a = { type: "agent", name: world.agentA.name, displayName: world.agentA.displayName || world.agentA.name, avatarUrl: world.agentA.avatarUrl };

  const body = await open(world.who.peerUser, memo.id, { comments: true });
  assert.deepEqual(body.item, {
    id: memo.id,
    url: linkTo(memo),
    title: memo.title,
    description: "what it is",
    home: { kind: "public" },
    author: a,
    version: 2,
    latestVersion: 2,
    position: row.lastPosition,
    commentCount: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  assert.deepEqual(body.versions, [{ number: 2, publisher: a, createdAt: memoV2.createdAt.toISOString(), note: null, changedPaths: [] }]);
  assert.deepEqual(body.files, [{ path: "memo.md", kind: "markdown", sizeBytes: size("# memo v2"), entry: true }]);
  assert.deepEqual(body.file, { path: "memo.md", entry: true, contentType: "text/markdown; charset=utf-8", sizeBytes: size("# memo v2"), kind: "text", text: "# memo v2", truncated: false });
  assert.deepEqual(body.comments, { comments: [], olderCursor: null });

  // The current version by its number or its link opens; an older one is 404 VERSION_NOT_FOUND, by number or by link.
  assert.equal((await open(world.who.peerUser, memo.id, { version: 2 })).item.version, 2);
  assert.equal((await open(world.who.peerUser, linkTo(memo, 2))).item.url, linkTo(memo, 2));
  const older = refused(await read(world.who.peerUser, memo.id, { version: 1 }));
  assert.equal(older.status, 404);
  assert.equal(older.body.code, "VERSION_NOT_FOUND");
  assert.deepEqual(older, webVersionNotFound(1, 2));
  assert.deepEqual(refused(await read(world.who.peerUser, linkTo(memo, 1))), older);
  assert.deepEqual(refused(await read(world.who.peerUser, linkTo(memo, 2), { version: 1, comments: true })), older);

  // Witness: a member of its own server reads the older version, both versions, the comment and who wrote it.
  const inside = await open(world.who.reader, memo.id, { version: 1, comments: true });
  assert.equal(inside.file.kind === "text" && inside.file.text, "# memo v1");
  assert.deepEqual(inside.versions.map((version) => version.number), [2, 1]);
  assert.equal(inside.versions[1]!.createdAt, memoV1.createdAt.toISOString());
  assert.deepEqual(inside.item.author, agentActor(world.agentA));
  assert.equal(inside.item.commentCount, 1);
  assert.deepEqual(inside.comments?.comments.map((entry) => entry.body), [[{ type: "text", text: "for members only" }]]);
});

// ---- what doesn't open -----------------------------------------------------------

test("an Artifact the person can't see, a deleted one, an unknown id and a reference that is no id or link all answer the one 404 NOT_VISIBLE, whatever else is asked", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page, board, secret } = world.items;
  const notVisible = webNotVisible();
  assert.equal(notVisible.status, 404);
  assert.equal(notVisible.body.code, "NOT_VISIBLE");

  const cases: Array<[string, ArtifactWebReader, string]> = [
    ...closedRefs(world).map(([what, ref]): [string, ArtifactWebReader, string] => [what, world.who.reader, ref]),
    ["a conversation's Artifact, for a member of the server outside the conversation", world.who.bystander, page.id],
    ["a link to it, for the same member", world.who.bystander, linkTo(page, 1)],
    ["a conversation's Artifact, for a member of another server", world.who.peerUser, page.id],
    ["a server's Artifact, for a member of another server", world.who.peerUser, board.id],
    ["a link to a server's Artifact, for a member of another server", world.who.peerUser, linkTo(board)],
  ];
  const answers: Answer[] = [];
  for (const [what, reader, ref] of cases) {
    for (const asked of ASKED) {
      const answer = refused(await read(reader, ref, asked));
      assert.deepEqual(answer, notVisible, `${what}, asked ${JSON.stringify(asked)}`);
      answers.push(answer);
    }
  }
  // Each the same as every other, the whole refusal.
  assert.equal(answers.length, cases.length * ASKED.length);
  for (const answer of answers) assert.deepEqual(answer, answers[0]);

  // Witnesses: the same Artifacts open for those who can see them.
  assert.equal((await open(world.who.reader, page.id)).item.id, page.id);
  assert.equal((await open(world.who.owner, secret.id)).item.id, secret.id);
  assert.equal((await open(world.who.bystander, board.id)).item.id, board.id);
  assert.deepEqual((await open(world.who.bystander, linkTo(board))).item.home, { kind: "server" });
});

test("with Artifacts off for the deployment, every reference answers the one 403 ARTIFACTS_NOT_ENABLED, an Artifact the person could open like one they couldn't", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page, board, memo } = world.items;
  // On: these open.
  assert.equal((await open(world.who.reader, page.id)).item.id, page.id);
  assert.equal((await open(world.who.peerUser, memo.id)).item.id, memo.id);

  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const notEnabled = webFail(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
  const cases: Array<[string, ArtifactWebReader, string]> = [
    ...closedRefs(world).map(([what, ref]): [string, ArtifactWebReader, string] => [what, world.who.reader, ref]),
    ["an Artifact of the reader's conversation", world.who.reader, page.id],
    ["its short id", world.who.reader, shortId(page)],
    ["a link to it", world.who.reader, linkTo(page)],
    ["a link to its version", world.who.reader, linkTo(page, 1)],
    ["a server's Artifact", world.who.reader, board.id],
    ["a public Artifact, for a member of its server", world.who.reader, memo.id],
    ["a public Artifact, for a member of another server", world.who.peerUser, memo.id],
    ["a conversation's Artifact, for its owner", world.who.owner, page.id],
  ];
  const answers: Answer[] = [];
  for (const [what, reader, ref] of cases) {
    for (const asked of ASKED) {
      const answer = refused(await read(reader, ref, asked));
      assert.equal(answer.status, 403, what);
      assert.equal(answer.body.code, "ARTIFACTS_NOT_ENABLED", what);
      assert.deepEqual(answer, notEnabled, `${what}, asked ${JSON.stringify(asked)}`);
      answers.push(answer);
    }
  }
  assert.equal(answers.length, cases.length * ASKED.length);
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
});

// ---- a read and nothing else -----------------------------------------------------

/** Every table of the app's schema as its row count and a digest of its rows: equal before and after means no row was written, changed or removed. */
async function everyArtifactRow(): Promise<Record<string, string>> {
  const tables = (await getDb().execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'app_artifacts' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows as Array<{ table_name: string }>;
  const state: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    const [row] = (await getDb().execute(sql.raw(
      `SELECT count(*)::int AS rows, coalesce(md5(string_agg(t::text, ';' ORDER BY t::text)), '') AS digest FROM app_artifacts."${table}" t`,
    ))).rows as Array<{ rows: number; digest: string }>;
    state[table] = `${row!.rows} ${row!.digest}`;
  }
  return state;
}

test("reading writes nothing: no read position moves or appears, nobody starts following, no comment and no object event is added", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { page, memo, secret } = world.items;
  const db = getDb();
  await comment(page, [
    { author: world.byA, versionId: world.versions.v2.id, body: "one the readers have not seen" },
    { author: world.byA, versionId: world.versions.v2.id, body: "and another" },
  ]);
  // The owner has read up to version 1, a while ago; the reader has never opened it.
  const readAt = new Date("2026-01-02T03:04:05.000Z");
  await db.insert(artifactReadPositions).values({ itemId: page.id, actorType: "user", actorId: world.owner.id, position: 1, updatedAt: readAt });
  const positionOf = async (userId: string) => (await db.select().from(artifactReadPositions).where(and(
    eq(artifactReadPositions.itemId, page.id), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, userId),
  )))[0] ?? null;
  const subscriptionsOf = (userId: string) => db.select().from(artifactSubscriptions).where(and(eq(artifactSubscriptions.actorType, "user"), eq(artifactSubscriptions.actorId, userId)));
  const commentIds = async () => (await db.select({ id: artifactComments.id }).from(artifactComments).orderBy(artifactComments.id)).map((row) => row.id);
  const eventCount = async () => (await db.select({ id: objectEvents.id }).from(objectEvents)).length;

  const before = { rows: await everyArtifactRow(), comments: await commentIds(), events: await eventCount() };
  assert.equal(before.comments.length, 2);
  assert.equal(before.rows.read_positions?.startsWith("1 "), true);
  assert.equal(before.rows.subscriptions?.startsWith("0 "), true);

  for (const reader of [world.who.reader, world.who.owner]) {
    for (let round = 0; round < 2; round += 1) {
      assert.equal((await open(reader, page.id)).item.version, 2);
      assert.equal((await open(reader, linkTo(page), { comments: true })).comments?.comments.length, 2);
      assert.equal((await open(reader, page.id, { version: 1, path: "notes.md", comments: true })).item.version, 1);
      assert.equal((await open(reader, memo.id, { comments: true })).item.id, memo.id);
      assert.equal(refused(await read(reader, page.id, { path: "nope.txt", comments: true })).body.code, "FILE_NOT_FOUND");
      assert.equal(refused(await read(reader, page.id, { version: 9, comments: true })).body.code, "VERSION_NOT_FOUND");
      assert.equal(refused(await read(reader, `pt_${randomUUID()}`, { comments: true })).body.code, "NOT_VISIBLE");
    }
  }
  assert.equal(refused(await read(world.who.reader, secret.id, { comments: true })).body.code, "NOT_VISIBLE");
  assert.deepEqual((await open(world.who.peerUser, memo.id, { comments: true })).comments, { comments: [], olderCursor: null });

  // Absent stays absent; an existing one keeps its position and its time.
  assert.equal(await positionOf(world.reader.id), null);
  const owners = await positionOf(world.owner.id);
  assert.equal(owners?.position, 1);
  assert.equal(owners?.updatedAt.toISOString(), readAt.toISOString());
  assert.equal(await positionOf(world.peerUser.id), null);
  // Nobody follows anything.
  for (const user of [world.reader, world.owner, world.peerUser]) {
    assert.equal(await isFollowing(page.id, { type: "user", id: user.id }), false);
    assert.equal(await isFollowing(memo.id, { type: "user", id: user.id }), false);
    assert.equal((await subscriptionsOf(user.id)).length, 0);
  }
  // No comment, no object event, and no other row of the app's tables either.
  assert.deepEqual(await commentIds(), before.comments);
  assert.equal(await eventCount(), before.events);
  assert.deepEqual(await everyArtifactRow(), before.rows);

  // Witness that these checks see a write: the web's viewer, opened by the same reader, moves their read position.
  const opened = await createViewerOperations().viewer(world.who.reader, page.id, {});
  assert.equal(opened.kind, "json");
  assert.equal((await positionOf(world.reader.id))?.position, (await itemRow(page.id)).lastPosition);
  assert.notDeepEqual(await everyArtifactRow(), before.rows);
});
