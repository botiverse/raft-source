// The signed-in `GET /api/artifacts/:id/download.zip` over HTTP with real
// user tokens (webViewer.ts downloadZip, versionZip.ts; contract:
// artifactWebPaths.downloadZip): every file of the version shown, paths and
// bytes as published, named by the title and the version; resolved as a
// file is, so a reader who can't see it (outside its conversation, deleted,
// no such id) gets the one 404 NOT_VISIBLE; `?version=` as the file route
// reads it; over the archive's limit 413 DOWNLOAD_TOO_LARGE before anything
// is read.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { artifactWebPaths, asArtifactId, asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import { readStoredZip } from "../../test/storedZipReader";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions } from "./schema";
import { ARTIFACT_ZIP_MAX_BYTES } from "./versionZip";
import { webNotVisible, webVersionNotFound } from "./webCommon";
import { zipsInFlight } from "./zipSlots";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const NOT_VISIBLE = webNotVisible().body;
const label = () => randomUUID().slice(0, 8);

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
});

type Actor = { type: "user" | "agent"; id: string };
type File = { path: string; bytes: Buffer };

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

async function insertItem(serverId: ServerId, homeChannelId: string, author: Actor, opts: { deleted?: boolean; title?: string } = {}) {
  const id = `pt_${randomUUID()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId,
    urlKey: id,
    name: `zip-${label()}`,
    title: opts.title ?? `Artifact ${id.slice(3, 11)}`,
    homeKind: "conversation",
    homeChannelId,
    createdByType: author.type,
    createdById: author.id,
    deletedAt: opts.deleted ? new Date() : null,
  }).returning();
  return row!;
}

/** A published version, made current; its files' blobs ready in `r2`, the first file the entry. */
async function publish(serverId: ServerId, r2: Map<string, Buffer>, author: Actor, itemId: string, number: number, files: File[]) {
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId, itemId, number, entry: files[0]!.path, fileCount: files.length,
    sizeBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    publishDigest: "digest", status: "published", publisherType: author.type, publisherId: author.id, position: number,
  }).returning();
  for (const file of files) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    // One blob per server and content, as a push stores it.
    let [blob] = await db.select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha256)));
    if (!blob) {
      const blobId = `b_${randomUUID()}`;
      const r2Key = r2KeyOf(serverId, sha256, blobId);
      r2.set(r2Key, file.bytes);
      [blob] = await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: file.bytes.length, state: "ready", r2Key }).returning();
    }
    await db.insert(artifactVersionFiles).values({ versionId, path: file.path, sha256, sizeBytes: file.bytes.length, blobId: blob!.id });
  }
  await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: number }).where(eq(artifactItems.id, itemId));
  return version!;
}

const V1: File[] = [
  { path: "index.md", bytes: Buffer.from("# Notes v1\n\n![chart](images/chart.png)\n") },
  { path: "images/chart.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
];
const V2: File[] = [
  { path: "index.md", bytes: Buffer.from("# Notes v2\n\n![chart](images/chart.png)\n![logo](images/logo (1).svg)\n") },
  { path: "images/chart.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6, 7]) },
  { path: "images/logo (1).svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") },
  { path: "data/table.csv", bytes: Buffer.from("a,b\n1,2\n") },
];

/** A server (Artifacts on) with #priv (owner, reader); outsider a member outside it. notes in #priv (v1, v2 current), gone deleted. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const priv = await createChannel(server.id, `zip-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const author: Actor = { type: "user", id: owner.id };
  const notes = await insertItem(serverId, priv.id, author, { title: "Q3 notes: «draft»/final" });
  await publish(serverId, r2, author, notes.id, 1, V1);
  const v2 = await publish(serverId, r2, author, notes.id, 2, V2);
  const gone = await insertItem(serverId, priv.id, author, { deleted: true });
  await publish(serverId, r2, author, gone.id, 1, V1);
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return { notes, gone, v2, who: { reader: await as(reader.id), outsider: await as(outsider.id) } };
}

type Who = { token: string; serverId: string };

async function get(app: { baseUrl: string }, path: string, who: Who) {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  const bytes = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, headers: res.headers, bytes, body: json ? JSON.parse(bytes.toString("utf8")) : null };
}

const byPath = (files: File[]) => new Map(files.map((file) => [file.path, file.bytes]));

test("download.zip: every file of the shown version, paths and bytes as published, an attachment named by the title and version, never cached", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const notes = asArtifactId(world.notes.id);
  const res = await get(app, artifactWebPaths.downloadZip(notes), world.who.reader);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  // The title's unsafe characters dropped (the name a browser saves it as), the version after it.
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="Q3 notes draft final v2\.zip"/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(Number(res.headers.get("content-length")), res.bytes.length);
  const entries = readStoredZip(res.bytes);
  // By path, as the viewer and `raft artifact read --files` list them; folders as path prefixes.
  assert.deepEqual(entries.map((entry) => entry.name), ["data/table.csv", "images/chart.png", "images/logo (1).svg", "index.md"]);
  for (const entry of entries) assert.deepEqual(entry.bytes, byPath(V2).get(entry.name), entry.name);

  // `?version=`: that version's files, as the file route reads them.
  const v1 = await get(app, artifactWebPaths.downloadZip(notes, 1), world.who.reader);
  assert.equal(v1.status, 200);
  assert.match(v1.headers.get("content-disposition") ?? "", /filename="Q3 notes draft final v1\.zip"/);
  const v1Entries = readStoredZip(v1.bytes);
  assert.deepEqual(v1Entries.map((entry) => entry.name), ["images/chart.png", "index.md"]);
  for (const entry of v1Entries) assert.deepEqual(entry.bytes, byPath(V1).get(entry.name), entry.name);
  const unknown = await get(app, artifactWebPaths.downloadZip(notes, 9), world.who.reader);
  assert.deepEqual([unknown.status, unknown.body], [404, webVersionNotFound(9, 2).body]);
  assert.equal((await get(app, `/api/artifacts/${notes}/download.zip?version=one`, world.who.reader)).body.code, "INVALID_REQUEST");
  // Every archive gave its slot back.
  const until = Date.now() + 5_000;
  while (zipsInFlight("web") !== 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(zipsInFlight("web"), 0);
});

test("download.zip: whoever can't see it gets the one 404, the same body for every reason", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const [why, who, id] of [
    ["outside its conversation", world.who.outsider, world.notes.id],
    ["deleted", world.who.reader, world.gone.id],
    ["no such id", world.who.reader, `pt_${randomUUID()}`],
    ["not an id", world.who.reader, "not-an-id"],
  ] as const) {
    const res = await get(app, artifactWebPaths.downloadZip(asArtifactId(id)), who);
    assert.deepEqual([res.status, res.body], [404, NOT_VISIBLE], why);
  }
  // Witness: the reader gets it.
  assert.equal((await get(app, artifactWebPaths.downloadZip(asArtifactId(world.notes.id)), world.who.reader)).status, 200);
});

test("download.zip: over the archive's limit 413 DOWNLOAD_TOO_LARGE with the limit, before any file is read", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // The rows' sizes decide, summed before anything is read: one says it is past the limit.
  await getDb().update(artifactVersionFiles).set({ sizeBytes: ARTIFACT_ZIP_MAX_BYTES })
    .where(and(eq(artifactVersionFiles.versionId, world.v2.id), eq(artifactVersionFiles.path, "index.md")));
  let reads = 0;
  __setArtifactR2StoreForTests({ ...memoryR2(new Map()), async read() { reads += 1; return null; } });
  const res = await get(app, artifactWebPaths.downloadZip(asArtifactId(world.notes.id)), world.who.reader);
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "DOWNLOAD_TOO_LARGE");
  assert.deepEqual(res.body.details, { limit: ARTIFACT_ZIP_MAX_BYTES });
  assert.equal(reads, 0);
});
