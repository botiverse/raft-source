// A publish check's screenshots over HTTP (task #130), and core's object file
// read they go through: `GET /api/objects/:kind/:id/files/:fileId`
// (routes/objects.ts, services/objectFiles.ts readObjectFile). Artifacts has
// no web screenshot route of its own (the agent's is checkRead.ts,
// checkPush.api.test.ts): a check's row names core object files of
// the Artifact, and core serves them to whoever can see the Artifact fully
// now (never another server's reader of a public one: its public face only).
// The bytes with the type core detected, inline, nosniff, a sandboxing CSP
// and a short private cache; one 404 NOT_FOUND for every other answer (no
// such kind, object or file, another object's file id, an Artifact the
// reader can't see or whose server or the reader's has Artifacts off, a file
// let go, a screenshot on a deployment without a check Worker: the shots are
// hidden, the Artifact's other files not); a draft (unclaimed, or hung on a `draft:` part) only for its
// uploader; 503 without the bucket.
// It moves no read position.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { asObjectFileId, asServerId, objectWebPaths, type ObjectFileId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectFiles } from "../../db/schema";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { claimObjectFile, moveObjectFiles, putObjectFile } from "../../services/objectFiles";
import { createApiTest } from "../../test/integration/apiTest";
import { accessTokenForTest } from "../../test/integration/credentials";
import type { createSeed } from "../../test/integration/seed";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { testJpeg, testPng } from "../../test/objectFileTestImages";
import { artifactFileObject, checkShotFileOf, checkShotPart, keepNewestCheckShots } from "./checks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactItems, artifactReadPositions, artifactVersionChecks, artifactVersions, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

/** A check Worker's token: what makes a deployment run publish checks and serve their screenshots (checkWorkerToken.ts checksConfigured). */
const CHECK_WORKER_TOKEN = "k".repeat(40);

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  storage = installMemoryObjectFilesStorage();
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", CHECK_WORKER_TOKEN);
});
afterEach(() => {
  storage.restore();
  vi.unstubAllEnvs();
});

const PNG = (label: string) => testPng(label);

/**
 * A server (Artifacts and publish checks on) with #priv (owner and reader), outsider a member of
 * the server outside #priv, and a peer server (both on) whose only
 * member is peerUser. page in #priv and memo, public: v1 and v2 (current),
 * each checked with both screenshots.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const db = getDb();
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const priv = await createChannel(server.id, `shot-priv-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addHuman(priv.id, reader.id);

  const makeItem = async (homeChannelId: string | null): Promise<ArtifactItemRow> => {
    const id = `pt_${randomUUID()}`;
    const [item] = await db.insert(artifactItems).values({
      id, serverId, urlKey: id, name: id, title: id, homeKind: homeChannelId ? "conversation" : "public", homeChannelId, createdByType: "user", createdById: owner.id,
    }).returning();
    return item!;
  };
  const push = async (itemId: string, number: number): Promise<ArtifactVersionRow> => {
    const [version] = await db.insert(artifactVersions).values({
      id: `v_${randomUUID()}`, itemId, number, entry: "index.html", fileCount: 1, sizeBytes: 1,
      publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id, position: number,
    }).returning();
    await db.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: number }).where(eq(artifactItems.id, itemId));
    return version!;
  };
  /** A done check of `version` with both screenshots, stored as the check task stores them. */
  const checked = async (version: ArtifactVersionRow) => {
    const put = (bytes: Buffer) => putObjectFile({
      object: artifactFileObject(version.itemId), parent: checkShotPart(version.id), bytes, uploadedBy: { type: "user", id: owner.id }, quota: "exempt",
    });
    const files = { desktop: (await put(PNG(`desktop ${version.id}`))).id, phone: (await put(await testJpeg(`phone ${version.id}`))).id };
    // What core kept (a JPEG is encoded again): what a reader is served.
    const kept = async (fileId: ObjectFileId) => storage.objects.get((await db.select().from(objectFiles).where(eq(objectFiles.id, fileId)))[0]!.storageKey)!.bytes;
    const shots = { desktop: await kept(files.desktop), phone: await kept(files.phone) };
    await db.insert(artifactVersionChecks).values({
      versionId: version.id, status: "done", finishedAt: new Date(), findings: { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null },
      desktopFileId: files.desktop, phoneFileId: files.phone,
    });
    return { shots, files };
  };

  const page = await makeItem(priv.id);
  const pageV1 = await push(page.id, 1);
  const pageV2 = await push(page.id, 2);
  const shotsV1 = await checked(pageV1);
  const shotsV2 = await checked(pageV2);
  const memo = await makeItem(null);
  await checked(await push(memo.id, 1));
  const memoShots = await checked(await push(memo.id, 2));
  return { server, serverId, peer, owner, reader, outsider, peerUser, page, pageV1, pageV2, shotsV1, shotsV2, memo, memoShots, push, checked };
}

async function read(baseUrl: string, input: { token: string; serverId: ServerId | string; kind?: string; id: string; fileId: ObjectFileId | string }) {
  const path = objectWebPaths.file(input.kind ?? ARTIFACT_OBJECT_KIND, input.id, asObjectFileId(input.fileId));
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${input.token}`, "X-Server-Id": input.serverId } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    bytes,
    code: res.headers.get("content-type")?.startsWith("application/json") ? (JSON.parse(bytes.toString()) as { code: string }).code : null,
  };
}

test("a reader who can see the Artifact gets its check's screenshots: the bytes with the type core detected, inline, nosniff, sandboxed, a short private cache; no read position moved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const token = await accessTokenForTest(world.reader.id);
  const as = (fileId: ObjectFileId) => read(app.baseUrl, { token, serverId: world.server.id, id: world.page.id, fileId });

  // The id a reader of the check is handed (the row's), served by core.
  const desktopId = await checkShotFileOf(world.pageV2.id, "desktop");
  assert.equal(desktopId, world.shotsV2.files.desktop);
  const desktop = await as(desktopId!);
  assert.equal(desktop.status, 200);
  assert.deepEqual(desktop.bytes, world.shotsV2.shots.desktop);
  assert.equal(desktop.headers.get("content-type"), "image/png");
  assert.equal(desktop.headers.get("content-length"), String(world.shotsV2.shots.desktop.length));
  assert.equal(desktop.headers.get("content-disposition"), "inline");
  assert.equal(desktop.headers.get("x-content-type-options"), "nosniff");
  assert.equal(desktop.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(desktop.headers.get("cache-control"), "private, max-age=60");
  assert.match(desktop.headers.get("vary") ?? "", /Authorization/);
  const phone = await as(world.shotsV2.files.phone);
  assert.deepEqual([phone.status, phone.headers.get("content-type")], [200, "image/jpeg"]);
  assert.deepEqual(phone.bytes, world.shotsV2.shots.phone);
  assert.deepEqual((await as(world.shotsV1.files.desktop)).bytes, world.shotsV1.shots.desktop, "an older version's too");
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, world.page.id))).length, 0, "no read position moved");

  // A public Artifact's: its own server's people read it fully, parts and all.
  const own = await read(app.baseUrl, { token: await accessTokenForTest(world.outsider.id), serverId: world.server.id, id: world.memo.id, fileId: world.memoShots.files.desktop });
  assert.equal(own.status, 200);
  assert.deepEqual(own.bytes, world.memoShots.shots.desktop);
});

test("another server's reader of a public Artifact sees only its public face, never a file of it: one 404 NOT_FOUND", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const token = await accessTokenForTest(world.peerUser.id);
  for (const fileId of [world.memoShots.files.desktop, world.memoShots.files.phone]) {
    const peer = await read(app.baseUrl, { token, serverId: world.peer.id, id: world.memo.id, fileId });
    assert.deepEqual([peer.status, peer.code], [404, "NOT_FOUND"]);
  }
});

test("one 404 NOT_FOUND for everything else: another object's file id, an Artifact the reader can't see, Artifacts off, an unknown kind, a file let go; 503 without the bucket", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const reader = await accessTokenForTest(world.reader.id);
  const fileId = world.shotsV2.files.desktop;
  const as = (input: { token?: string; serverId?: string; kind?: string; id?: string; fileId?: string } = {}) =>
    read(app.baseUrl, { token: input.token ?? reader, serverId: input.serverId ?? world.server.id, kind: input.kind, id: input.id ?? world.page.id, fileId: input.fileId ?? fileId });
  const notFound = async (input: Parameters<typeof as>[0], why: string) => {
    const res = await as(input);
    assert.deepEqual([res.status, res.code], [404, "NOT_FOUND"], why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  };
  assert.equal((await as()).status, 200);

  await notFound({ token: await accessTokenForTest(world.outsider.id) }, "a member of the server outside the Artifact's conversation");
  await notFound({ id: world.memo.id }, "the file id under another object (one the reader can see)");
  await notFound({ id: world.memo.id, fileId: world.shotsV2.files.phone }, "the same for every file of another object");
  await notFound({ kind: "nope" }, "a kind nobody registered");
  await notFound({ fileId: randomUUID() }, "no such file");
  await notFound({ fileId: "not-a-uuid" }, "a malformed file id");
  await notFound({ id: `pt_${randomUUID()}` }, "no such Artifact");
  await notFound({ id: "x".repeat(300) }, "an id longer than any");

  // Its bytes gone from the bucket.
  const [row] = await getDb().select().from(objectFiles).where(eq(objectFiles.id, world.shotsV2.files.phone));
  storage.objects.delete(row!.storageKey);
  await notFound({ fileId: world.shotsV2.files.phone }, "bytes missing");

  // Artifacts off (not 403: core's one answer).
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  await notFound({}, "Artifacts off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  assert.equal((await as()).status, 200, "on again");

  // Let go: an older version's screenshots past the newest three, and every file of a deleted Artifact.
  const v3 = await world.checked(await world.push(world.page.id, 3));
  await world.checked(await world.push(world.page.id, 4));
  assert.equal(await keepNewestCheckShots(world.page.id), 2, "v1's two screenshots go");
  await notFound({ fileId: world.shotsV1.files.desktop }, "a version past the newest three");
  assert.equal((await as({ fileId: v3.files.desktop })).status, 200);
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, world.page.id));
  await notFound({ fileId: v3.files.desktop }, "a deleted Artifact (the kind's homes leave it out)");

  // The bucket not configured: 503 for a file the reader may read; still one 404 for anything else.
  storage.restore();
  storage = installMemoryObjectFilesStorage({ configured: false });
  const unavailable = await as({ id: world.memo.id, fileId: world.memoShots.files.desktop });
  assert.deepEqual([unavailable.status, unavailable.code], [503, "STORAGE_UNAVAILABLE"]);
  await notFound({ fileId: randomUUID() }, "no such file, whatever the bucket");
});

test("a deployment without a check Worker hides the screenshots (the one 404 NOT_FOUND); the Artifact's other files are served as ever; with one again, the screenshots are back", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const reader = await accessTokenForTest(world.reader.id);
  const as = (fileId: ObjectFileId) => read(app.baseUrl, { token: reader, serverId: world.server.id, id: world.page.id, fileId });
  const shots = [world.shotsV2.files.desktop, world.shotsV2.files.phone, world.shotsV1.files.desktop];
  // A comment's image of the same Artifact: not a screenshot, never behind the check Worker.
  const image = await putObjectFile({ object: artifactFileObject(world.page.id), parent: "comment:c_1", bytes: PNG("comment image"), uploadedBy: { type: "user", id: world.owner.id }, quota: "exempt" });
  for (const fileId of shots) assert.equal((await as(fileId)).status, 200, "with a check Worker: served");

  // No token, or one the check routes refuse: hidden, as a file there isn't.
  for (const token of ["", "too-short"]) {
    vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", token);
    for (const fileId of shots) {
      const res = await as(fileId);
      assert.deepEqual([res.status, res.code], [404, "NOT_FOUND"], fileId);
      assert.equal(res.headers.get("cache-control"), "private, no-store", fileId);
    }
    const memo = await read(app.baseUrl, { token: await accessTokenForTest(world.outsider.id), serverId: world.server.id, id: world.memo.id, fileId: world.memoShots.files.desktop });
    assert.deepEqual([memo.status, memo.code], [404, "NOT_FOUND"], "a public one's to its own server's people too");
    const other = await as(image.id);
    assert.equal(other.status, 200, "the Artifact's other files as ever");
    assert.deepEqual(other.bytes, PNG("comment image"));
  }

  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", CHECK_WORKER_TOKEN);
  for (const fileId of shots) assert.equal((await as(fileId)).status, 200, "configured again: served");
});

test("an unclaimed file is read only by the one who uploaded it, until it is claimed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const reader = await accessTokenForTest(world.reader.id);
  const owner = await accessTokenForTest(world.owner.id);
  const object = artifactFileObject(world.page.id);
  const draft = await putObjectFile({ object, parent: null, bytes: PNG("pasted"), uploadedBy: { type: "user", id: world.reader.id }, quota: "monthly", billedTo: world.serverId });
  const as = (token: string) => read(app.baseUrl, { token, serverId: world.server.id, id: world.page.id, fileId: draft.id });

  const mine = await as(reader);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.bytes, PNG("pasted"));
  const theirs = await as(owner);
  assert.deepEqual([theirs.status, theirs.code], [404, "NOT_FOUND"], "the Artifact's owner sees the Artifact, not another's draft");

  // An uploader who can't see the object reads nothing of it, their draft included.
  const outsiderDraft = await putObjectFile({ object, parent: null, bytes: PNG("outside"), uploadedBy: { type: "user", id: world.outsider.id }, quota: "monthly", billedTo: world.serverId });
  const outside = await read(app.baseUrl, { token: await accessTokenForTest(world.outsider.id), serverId: world.server.id, id: world.page.id, fileId: outsiderDraft.id });
  assert.equal(outside.status, 404);

  // Claimed by a part (the comment it was pasted into): everyone who sees the Artifact.
  assert.ok(await claimObjectFile({ object, fileId: draft.id, parent: "comment:c_1", by: { type: "user", id: world.reader.id } }));
  assert.equal((await as(owner)).status, 200);
  assert.equal((await as(reader)).status, 200);
});

test("a file on a draft part (`draft:<id>`) is read only by its uploader, as an unclaimed one; moved to the posted part, by everyone who sees the Artifact", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const reader = await accessTokenForTest(world.reader.id);
  const owner = await accessTokenForTest(world.owner.id);
  const object = artifactFileObject(world.page.id);
  const pasted = await putObjectFile({ object, parent: null, bytes: PNG("in a draft"), uploadedBy: { type: "user", id: world.reader.id }, quota: "monthly", billedTo: world.serverId });
  assert.ok(await claimObjectFile({ object, fileId: pasted.id, parent: "draft:3f0c2a7e-0000-4000-8000-000000000001", by: { type: "user", id: world.reader.id } }));
  const as = (token: string) => read(app.baseUrl, { token, serverId: world.server.id, id: world.page.id, fileId: pasted.id });

  assert.equal((await as(reader)).status, 200, "its uploader reads it");
  const theirs = await as(owner);
  assert.deepEqual([theirs.status, theirs.code], [404, "NOT_FOUND"], "another full reader of the Artifact gets the one 404, as for no file");
  const none = await read(app.baseUrl, { token: owner, serverId: world.server.id, id: world.page.id, fileId: randomUUID() });
  assert.deepEqual([theirs.status, theirs.headers.get("content-type"), theirs.bytes.toString()], [none.status, none.headers.get("content-type"), none.bytes.toString()], "the same body");

  // A part whose name only starts like one is no draft.
  const onPart = await putObjectFile({ object, parent: "drafted:x_1", bytes: PNG("not a draft"), uploadedBy: { type: "user", id: world.reader.id }, quota: "exempt" });
  assert.equal((await read(app.baseUrl, { token: owner, serverId: world.server.id, id: world.page.id, fileId: onPart.id })).status, 200);

  // Posted: moved to the comment's part, and read as the Artifact's own.
  await getDb().transaction((tx) => moveObjectFiles({ object, from: "draft:3f0c2a7e-0000-4000-8000-000000000001", to: "comment:c_posted", executor: tx }));
  assert.equal((await as(owner)).status, 200);
  assert.equal((await as(reader)).status, 200);
});
