// The standalone page's one call (`GET /api/artifacts/:id/open`, webOpen.ts)
// over HTTP with real user tokens and no X-Server-Id: 401 signed out; a
// member who reads it in the Artifact's own server gets that server and the
// viewer's own answer (version, read position, capabilities, frame); a
// public Artifact is read as an outsider by anyone else (no capability, the
// current version only, the signed-out page's frame); the one 404 for
// everything else, a member who can't see its home included, and for
// everyone with Artifacts off; `private, no-store` and `Vary`; the viewer's
// per-user budget.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { artifactWebPaths, asArtifactId, asServerId, type ArtifactWebFrame, type ServerId } from "@botiverse/raft-shared";
import { artifactContentTicketKey, verifyArtifactContentTicket, type ArtifactContentTicketClaims } from "@botiverse/raft-shared/src/artifactContentTicket";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { removeMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { r2KeyOf } from "./blobStore";
import { ANONYMOUS_CONTENT_VIEWER, anonymousContentSubject } from "./contentWorker";
import { artifactBlobs, artifactItems, artifactReadPositions, artifactVersionFiles, artifactVersions } from "./schema";
import { webNotVisible, webVersionNotFound } from "./webCommon";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.frame": 2 } });
const label = () => randomUUID().slice(0, 8);

const WORKER_TOKEN = "w".repeat(40);
const CONTENT_DOMAIN = "content.example.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The content origin configured, so framed kinds carry a `frame`. */
function configureContent() {
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT_DOMAIN);
}

async function claimsOf(frame: ArtifactWebFrame): Promise<ArtifactContentTicketClaims> {
  const verified = await verifyArtifactContentTicket(new URL(frame.url).searchParams.get("ticket")!, [await artifactContentTicketKey(WORKER_TOKEN)], { origin: frame.origin });
  assert.ok(verified.ok, JSON.stringify(verified));
  return verified.claims;
}

// ---- seeding -------------------------------------------------------------------

type Actor = { type: "user" | "agent"; id: string };

async function insertItem(input: { serverId: ServerId; homeChannelId?: string; author: Actor }) {
  const id = `pt_${randomUUID()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    homeKind: input.homeChannelId ? "conversation" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
  }).returning();
  return row!;
}

/** A published version, made current. */
async function publish(serverId: ServerId, uploader: Actor, input: { itemId: string; number: number; path?: string; bytes: string }) {
  const db = getDb();
  const path = input.path ?? "index.html";
  const bytes = Buffer.from(input.bytes);
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId, itemId: input.itemId, number: input.number, entry: path, title: null, fileCount: 1, sizeBytes: bytes.length,
    publishDigest: "digest", status: "published", publisherType: uploader.type, publisherId: uploader.id, position: input.number,
  }).returning();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `b_${randomUUID()}`;
  await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: bytes.length, state: "ready", r2Key: r2KeyOf(serverId, sha256, blobId) });
  await db.insert(artifactVersionFiles).values({ versionId, path, sha256, sizeBytes: bytes.length, blobId });
  await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: input.number }).where(eq(artifactItems.id, input.itemId));
  return version!;
}

/**
 * Artifacts on. A server with #priv (owner, reader); outsider a member of
 * the server not in #priv; a peer server whose only member is
 * peerUser; loner in no server. Artifacts of the server: page in #priv (v1,
 * v2 current), memo public (v1, v2 current), sheet public (a csv, drawn by
 * the shell).
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const peerUser = await seed.human();
  const loner = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider], name: `Open ${label()}` });
  const serverId = asServerId(server.id);
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const priv = await createChannel(server.id, `open-priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addHuman(priv.id, reader.id);
  const author: Actor = { type: "user", id: owner.id };
  const page = await insertItem({ serverId, homeChannelId: priv.id, author });
  const pageV1 = await publish(serverId, author, { itemId: page.id, number: 1, bytes: "<h1>v1</h1>" });
  const pageV2 = await publish(serverId, author, { itemId: page.id, number: 2, bytes: "<h1>v2</h1>" });
  const memo = await insertItem({ serverId, author });
  const memoV1 = await publish(serverId, author, { itemId: memo.id, number: 1, bytes: "memo v1" });
  const memoV2 = await publish(serverId, author, { itemId: memo.id, number: 2, bytes: "memo v2" });
  const sheet = await insertItem({ serverId, author });
  await publish(serverId, author, { itemId: sheet.id, number: 1, path: "data.csv", bytes: "a,b\n1,2\n" });
  return {
    server, peer, owner, reader, outsider, peerUser, loner,
    items: { page, memo, sheet },
    versions: { pageV1, pageV2, memoV1, memoV2 },
  };
}

// ---- HTTP ------------------------------------------------------------------------

type Answer = { status: number; cacheControl: string | null; vary: string | null; body: any };

async function answerOf(res: Response): Promise<Answer> {
  return { status: res.status, cacheControl: res.headers.get("cache-control"), vary: res.headers.get("vary"), body: await res.json() };
}

/** `open` with the user's token and no X-Server-Id (unless `headers` adds one). */
async function open(baseUrl: string, input: { userId: string | null; artifact: string; version?: number; headers?: Record<string, string> }): Promise<Answer> {
  const res = await fetch(`${baseUrl}${artifactWebPaths.open(asArtifactId(input.artifact), { version: input.version })}`, {
    headers: { ...(input.userId === null ? {} : { Authorization: `Bearer ${await accessTokenForTest(input.userId)}` }), ...input.headers },
  });
  return answerOf(res);
}

async function viewer(baseUrl: string, input: { userId: string; serverId: string; artifact: string; version?: number }): Promise<Answer> {
  const res = await fetch(`${baseUrl}${artifactWebPaths.viewer(asArtifactId(input.artifact), input.version)}`, {
    headers: { Authorization: `Bearer ${await accessTokenForTest(input.userId)}`, "X-Server-Id": input.serverId },
  });
  return answerOf(res);
}

async function frameRoute(baseUrl: string, input: { userId: string; serverId: string; artifact: string }) {
  const res = await fetch(`${baseUrl}${artifactWebPaths.frame(asArtifactId(input.artifact))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessTokenForTest(input.userId)}`, "X-Server-Id": input.serverId, "Content-Type": "application/json" },
    body: "{}",
  });
  return answerOf(res);
}

const NOT_VISIBLE = webNotVisible().body;

/** Every answer of the route: never stored, and varies by the credential. */
function assertHeaders(answer: Answer, why: string) {
  assert.equal(answer.cacheControl, "private, no-store", why);
  assert.match(answer.vary ?? "", /\bCookie\b/, why);
  assert.match(answer.vary ?? "", /\bAuthorization\b/, why);
}

function assertNotVisible(answer: Answer, why: string) {
  assert.equal(answer.status, 404, `${why}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(answer.body, NOT_VISIBLE, why);
  assertHeaders(answer, why);
}

const readPositionOf = async (itemId: string, userId: string) => (await getDb().select().from(artifactReadPositions).where(and(
  eq(artifactReadPositions.itemId, itemId), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, userId),
)))[0]?.position ?? null;

/** The answer without its frame (each answer signs a new ticket). */
const withoutFrame = (body: Record<string, unknown>) => {
  const { frame: _frame, ...rest } = body;
  return rest;
};

// ---- tests -----------------------------------------------------------------------

test("signed out: 401, never stored", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const artifact of [world.items.memo.id, world.items.page.id, `pt_${randomUUID()}`]) {
    const res = await open(app.baseUrl, { userId: null, artifact });
    assert.equal(res.status, 401);
    assertHeaders(res, "401");
  }
});

test("a member who reads it in its server: that server, and the viewer's own answer there (capabilities, read position, frame, ?version=)", async ({ app, seed }) => {
  configureContent();
  const world = await seedWorld(seed);
  const { page } = world.items;
  assert.equal(await readPositionOf(page.id, world.reader.id), null);
  const res = await open(app.baseUrl, { userId: world.reader.id, artifact: page.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertHeaders(res, "200");
  assert.deepEqual(Object.keys(res.body).sort(), ["opensIn", "viewer"]);
  assert.deepEqual(res.body.opensIn, { serverId: world.server.id, slug: world.server.slug, name: world.server.name });
  assert.equal(res.body.viewer.card.version, 2);
  assert.equal(res.body.viewer.capabilities.comment, true, "a member of its server comments");
  assert.deepEqual(res.body.viewer.versions.map((version: { number: number }) => version.number), [2, 1], "the history");
  assert.equal(await readPositionOf(page.id, world.reader.id), 2, "opening the current version moves the read position");
  const claims = await claimsOf(res.body.viewer.frame);
  assert.deepEqual([claims.artifact, claims.version, claims.viewer, claims.subject], [page.id, world.versions.pageV2.id, `user:${world.reader.id}`, claims.subject]);
  // The ticket names the reader's sign-in (every access token has a family now).
  assert.match(claims.subject, new RegExp(`^v1:${world.server.id}:${world.reader.id}:[0-9a-f-]{36}$`));
  // Exactly what the viewer route answers in that server (but for the frame's new ticket).
  const viewed = await viewer(app.baseUrl, { userId: world.reader.id, serverId: world.server.id, artifact: page.id });
  assert.deepEqual(withoutFrame(res.body.viewer), withoutFrame(viewed.body));

  // ?version=: as the viewer: an older version for a member, its frame that version's; an unknown one the viewer's refusal.
  const older = await open(app.baseUrl, { userId: world.reader.id, artifact: page.id, version: 1 });
  assert.equal(older.status, 200, JSON.stringify(older.body));
  assert.equal(older.body.viewer.card.version, 1);
  assert.equal((await claimsOf(older.body.viewer.frame)).version, world.versions.pageV1.id);
  const unknown = await open(app.baseUrl, { userId: world.reader.id, artifact: page.id, version: 9 });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, webVersionNotFound(9, 2).body);
  assertHeaders(unknown, "VERSION_NOT_FOUND");

  // A public Artifact of their own server opens there too, with the history.
  const memo = await open(app.baseUrl, { userId: world.outsider.id, artifact: world.items.memo.id, version: 1 });
  assert.equal(memo.status, 200, JSON.stringify(memo.body));
  assert.equal(memo.body.opensIn.serverId, world.server.id);
  assert.equal(memo.body.viewer.card.version, 1);

  // No server is asked with: another server's X-Server-Id changes nothing.
  const asked = await open(app.baseUrl, { userId: world.peerUser.id, artifact: world.items.memo.id, headers: { "X-Server-Id": world.peer.id } });
  assert.equal(asked.body.opensIn, null);
  // The server-scoped routes still need one.
  const scoped = await fetch(`${app.baseUrl}${artifactWebPaths.viewer(asArtifactId(page.id))}`, { headers: { Authorization: `Bearer ${await accessTokenForTest(world.reader.id)}` } });
  assert.equal(scoped.status, 400);
});

test("a member who can't see its home gets the one 404, as for an unknown id; nothing moves", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { page } = world.items;
  const unknown = await open(app.baseUrl, { userId: world.outsider.id, artifact: `pt_${randomUUID()}` });
  assertNotVisible(unknown, "unknown id");
  const cases: Array<[string, string, string]> = [
    [world.outsider.id, page.id, "a member of its server outside its private channel"],
    [world.outsider.id, "not-an-id", "not an id"],
    [world.peerUser.id, page.id, "another server's private channel"],
    [world.loner.id, page.id, "someone in no server"],
  ];
  for (const [userId, artifact, why] of cases) {
    const res = await open(app.baseUrl, { userId, artifact });
    assertNotVisible(res, why);
    assert.deepEqual(res.body, unknown.body, why);
  }
  assert.equal(await readPositionOf(page.id, world.outsider.id), null);
  // No longer a member: the one 404 too.
  await removeMember(world.server.id, world.reader.id);
  assertNotVisible(await open(app.baseUrl, { userId: world.reader.id, artifact: page.id }), "a removed member");
});

test("a public Artifact for someone outside its server: read-only as an outsider, the current version only, the signed-out page's frame", async ({ app, seed }) => {
  configureContent();
  const world = await seedWorld(seed);
  const { memo } = world.items;
  for (const [userId, who] of [[world.peerUser.id, "a member of another server"], [world.loner.id, "someone in no server"]] as const) {
    const res = await open(app.baseUrl, { userId, artifact: memo.id });
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    assertHeaders(res, who);
    assert.equal(res.body.opensIn, null, who);
    const shown = res.body.viewer;
    assert.deepEqual(shown.capabilities, { publish: false, comment: false, changeHome: false, unpublish: false, narrowHome: false, delete: false }, who);
    assert.deepEqual(shown.versions.map((version: { number: number }) => version.number), [2], `${who}: the current version only`);
    assert.equal(shown.card.version, 2, who);
    assert.equal(shown.card.commentCount, 0, who);
    assert.equal(shown.card.author.id, undefined, `${who}: the author by name, not who in that server`);
    assert.deepEqual([shown.following, shown.origin, shown.savedFrom], [false, null, null], who);
    assert.equal(shown.viewer.id, userId, who);
    const claims = await claimsOf(shown.frame);
    assert.deepEqual([claims.artifact, claims.version, claims.viewer, claims.subject], [
      memo.id, world.versions.memoV2.id, ANONYMOUS_CONTENT_VIEWER, anonymousContentSubject({ artifact: memo.id, version: world.versions.memoV2.id }),
    ], `${who}: the signed-out page's ticket`);
    assert.equal(await readPositionOf(memo.id, userId), null, `${who}: no read position`);

    // ?version=: the current one by number; any other the one 404; malformed 400, as the viewer.
    assert.equal((await open(app.baseUrl, { userId, artifact: memo.id, version: 2 })).status, 200, who);
    assertNotVisible(await open(app.baseUrl, { userId, artifact: memo.id, version: 1 }), `${who}: an older version`);
    assertNotVisible(await open(app.baseUrl, { userId, artifact: memo.id, version: 9 }), `${who}: no such version`);
    const malformed = await fetch(`${app.baseUrl}/api/artifacts/${memo.id}/open?version=abc`, { headers: { Authorization: `Bearer ${await accessTokenForTest(userId)}` } });
    assert.equal(malformed.status, 400, who);
  }
  // A kind the shell draws: no frame.
  const sheet = await open(app.baseUrl, { userId: world.peerUser.id, artifact: world.items.sheet.id });
  assert.equal(sheet.status, 200);
  assert.equal("frame" in sheet.body.viewer, false);
});

test("Artifacts off: the one 404 for members and everyone else", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const cases: Array<[string, string, string]> = [
    [world.reader.id, world.items.page.id, "a member who sees its home"],
    [world.reader.id, world.items.memo.id, "a member, public"],
    [world.outsider.id, world.items.memo.id, "another member, public"],
    [world.peerUser.id, world.items.memo.id, "another server's member, public"],
    [world.loner.id, world.items.memo.id, "someone in no server, public"],
  ];
  for (const [userId, artifact, why] of cases) assertNotVisible(await open(app.baseUrl, { userId, artifact }), why);
  assert.equal(await readPositionOf(world.items.page.id, world.reader.id), null);
});

test("an id that doesn't decode: the one 404 signed in, 401 signed out", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const url = `${app.baseUrl}/api/artifacts/%E0%A4%A/open`;
  const signedIn = await answerOf(await fetch(url, { headers: { Authorization: `Bearer ${await accessTokenForTest(world.reader.id)}` } }));
  assertNotVisible(signedIn, "undecodable");
  const signedOut = await answerOf(await fetch(url));
  assert.equal(signedOut.status, 401);
  assertHeaders(signedOut, "undecodable, signed out");
});

limitedTest("in the viewer's and frame route's per-user budget (429 RATE_LIMITED past it, together)", async ({ app, seed }) => {
  configureContent();
  const world = await seedWorld(seed);
  const reader = { userId: world.reader.id, serverId: world.server.id, artifact: world.items.page.id };
  assert.equal((await open(app.baseUrl, reader)).status, 200);
  assert.equal((await viewer(app.baseUrl, reader)).status, 200);
  // Two tickets this minute: none of the three signs a third.
  const third = await open(app.baseUrl, reader);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "RATE_LIMITED");
  assertHeaders(third, "429");
  assert.equal((await viewer(app.baseUrl, reader)).status, 429);
  assert.equal((await frameRoute(app.baseUrl, reader)).status, 429);
  assert.equal((await open(app.baseUrl, { ...reader, userId: world.owner.id })).status, 200, "another user's own budget");
});
