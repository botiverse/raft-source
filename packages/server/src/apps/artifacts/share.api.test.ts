// S5 over HTTP with real user tokens, at the paths the shared contract builds
// (artifactWebPaths): sending an Artifact to a conversation (an ordinary
// message as the person: the note, then the link; no message field or table
// of its own), who in a conversation couldn't see it (counts only), saving an
// attachment as an Artifact (the bytes copied into Artifacts' storage) and
// what the attachments on screen were saved as. The flag gate on each; core's
// message limit and idempotent send (`clientKey`) on share; the plan's history
// window and deleted or revoked Artifacts on save and attachment-saves; the
// monthly file upload quota and the saver's Activity on save; a joint
// channel's members on every server in share-audience; the original message a
// save or a first share records, and who is shown it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ARTIFACT_ATTACHMENT_SAVES_MAX_IDS,
  ARTIFACT_SAVE_MAX_BINARY_BYTES,
  ARTIFACT_SHARE_NOTE_MAX_CHARS,
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  artifactPublicPaths,
  artifactWebPaths,
  asArtifactId,
  artifactLinkId,
  asChannelId,
  asServerId,
  type ArtifactId,
  type ArtifactViewerData,
  type ArtifactWebAttachmentSaves,
  type ArtifactWebSaved,
  type ArtifactWebShareAudience,
  type ArtifactWebShared,
  type ObjectInboxItem,
  type ServerId,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { attachmentObjects, attachments, channels, messages, objectEvents, serverFileUploadUsageMonths, serverMembers, servers } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../../services/channelService";
import { addMember } from "../../services/serverService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { createMessage } from "../../services/messageService";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../../services/storageService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { capturePaywallHits } from "../../test/integration/paywallHits";
import type { createSeed } from "../../test/integration/seed";
import { refusalBody } from "../../platform/refusals";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { widerHomeChoices, widerHomesFor } from "./manage";
import {
  artifactAttachmentSaves,
  artifactAudit,
  artifactBlobs,
  artifactItems,
  artifactReadPositions,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
} from "./schema";
import { ALREADY_SAVED_ERROR, ATTACHMENT_NOT_FOUND_ERROR } from "./save";
import { webNotVisible } from "./webCommon";
import { shareAudienceLimits } from "./webShare";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.write": 2, "artifacts.attachmentSaves": 2, "artifacts.shareAudience": 2 } });
const messageLimitedTest = createApiTest({ enforceMessageRateLimit: true, messageRateLimitMax: 2 });

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
  resetStorageForTests();
  shareAudienceLimits.maxCounted = 500;
});
const label = () => randomUUID().slice(0, 8);

// ---- seeding -------------------------------------------------------------------

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

function memoryStorage(objects: Map<string, Buffer>): StorageBackend {
  return {
    put: async () => {},
    delete: async () => {},
    get: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error(`no object ${key}`), { name: "NoSuchKey" });
      return Readable.from([bytes]);
    },
  };
}

/**
 * A server (Artifacts on unless `enabled: false`) with #team (private: owner,
 * reader, guest, agentIn), #other (private: owner only) and #open (public,
 * owner only). Outsider is a member of the server in none of them. An
 * Artifact `page` homed in #team (v1, current), one `secret` in #other.
 * Core's attachment storage and Artifacts' R2 are in memory.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider, guest] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const agentIn = await createAgent(server.id, `sh-in-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentOut = await createAgent(server.id, `sh-out-${label()}`, { runtime: "claude", model: "sonnet" });
  const team = await createChannel(server.id, `share-team-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(team.id, human.id);
  // The guest takes part in its one channel, #team (#wg-rbac:#15).
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: team.id });
  await addAgent(team.id, agentIn.id);
  const other = await createChannel(server.id, `share-other-${label()}`, undefined, "private");
  await addHuman(other.id, owner.id);
  const open = await createChannel(server.id, `share-open-${label()}`);
  await addHuman(open.id, owner.id);

  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const stored = new Map<string, Buffer>();
  __setStorageForTests(memoryStorage(stored));

  const page = await insertArtifact(serverId, r2, team.id, owner.id);
  const secret = await insertArtifact(serverId, r2, other.id, owner.id);
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    server, serverId, owner, reader, outsider, guest, agentIn, agentOut, team, other, open, r2, stored, page, secret,
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id), guest: await as(guest.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function insertArtifact(serverId: ServerId, r2: Map<string, Buffer>, homeChannelId: string, authorId: string) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id, serverId, urlKey: id, name: `art-${label()}`, title: `Artifact ${id.slice(3, 11)}`,
    homeKind: "conversation", homeChannelId, originalHomeChannelId: homeChannelId, createdByType: "user", createdById: authorId,
  });
  const bytes = Buffer.from(`<h1>${id}</h1>`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `b_${randomUUID()}`;
  const [blob] = await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: bytes.length, r2Key: r2KeyOf(serverId, sha256, blobId) }).returning();
  r2.set(blob!.r2Key, bytes);
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: bytes.length, publishDigest: "d",
    status: "published", publisherType: "user", publisherId: authorId, position: 1,
  });
  await db.insert(artifactVersionFiles).values({ versionId, path: "index.html", sha256, sizeBytes: bytes.length, blobId });
  const [item] = await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id)).returning();
  return item!;
}

/** An attachment posted by `uploaderId` on `messageId` in `channelId`, its bytes in core's (memory) storage. */
async function postAttachment(world: World, input: { channelId: string; messageId: string; uploaderId: string; filename: string; bytes: Buffer; sizeBytes?: number }) {
  const storageKey = `att/${randomUUID()}`;
  world.stored.set(storageKey, input.bytes);
  const size = input.sizeBytes ?? input.bytes.length;
  const [object] = await getDb().insert(attachmentObjects).values({
    originServerId: world.server.id, uploaderId: input.uploaderId, uploaderType: "user", storageKey, mimeType: "application/octet-stream", sizeBytes: size,
  }).returning();
  const [row] = await getDb().insert(attachments).values({
    objectId: object!.id, messageId: input.messageId, channelId: input.channelId, uploaderId: input.uploaderId, uploaderType: "user",
    filename: input.filename,
  }).returning();
  return row!;
}

// ---- HTTP ------------------------------------------------------------------------

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : null };
}

const id = (row: { id: string }): ArtifactId => asArtifactId(row.id);
/** The Artifact's address on this deployment (APP_URL, the local default in tests). */
const linkOf = (row: { id: string }) => `${getAppUrl()}/artifacts/${artifactLinkId(row.id as ArtifactId)}`;
const shareInput = (conversationId: string, extra: Record<string, unknown> = {}) => ({ conversationId, threadRootId: null, note: null, widenTo: null, clientKey: randomUUID(), ...extra });
const messagesIn = (channelId: string) => getDb().select().from(messages).where(eq(messages.channelId, channelId));
const messagesBy = async (world: World, senderId: string) => (await getDb().select().from(messages)
  .where(and(eq(messages.senderId, senderId), inArray(messages.channelId, [world.team.id, world.other.id, world.open.id])))).length;
const auditOf = (item: { id: string }) => getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item.id)).orderBy(artifactAudit.id);
const movedEventsOf = async (item: { id: string }) => (await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, item.id)).orderBy(objectEvents.seq))
  .filter((event) => event.eventKind === "moved");
const savesOf = (attachmentId: string) => getDb().select().from(artifactAttachmentSaves).where(eq(artifactAttachmentSaves.attachmentId, attachmentId));

// ---- the flag --------------------------------------------------------------------

test("flag off: share, share-audience, save-attachment and attachment-saves answer 403 ARTIFACTS_NOT_ENABLED and write nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  const root = await createMessage(world.team.id, "user", world.owner.id, "with a file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: root.id, uploaderId: world.owner.id, filename: "a.txt", bytes: Buffer.from("a") });
  const routes: Array<[string, string, unknown?]> = [
    ["POST", artifactWebPaths.share(id(world.page)), shareInput(world.team.id, { note: "look" })],
    ["GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(world.team.id) })],
    ["POST", artifactWebPaths.saveAttachment(), { attachmentId: attachment.id }],
    ["GET", artifactWebPaths.attachmentSaves([attachment.id])],
  ];
  for (const [method, path, body] of routes) {
    const res = await call(app, method, path, world.who.reader, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", `${method} ${path}`);
  }
  assert.equal(await messagesBy(world, world.reader.id), 0);
  assert.deepEqual(await savesOf(attachment.id), []);
  assert.equal(world.r2.size, 2, "only the seeded Artifacts' bytes");
});

// ---- share -----------------------------------------------------------------------

test("share: posts exactly one ordinary message as the person, the note then the Artifact's link", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const before = (await messagesIn(world.team.id)).length;
  const res = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { note: "  Have a look  " }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const shared = res.body as ArtifactWebShared;
  assert.deepEqual(Object.keys(shared).sort(), ["home", "messageId"]);
  assert.equal(shared.home, null);
  const after = await messagesIn(world.team.id);
  assert.equal(after.length, before + 1);
  const message = after.find((row) => row.id === shared.messageId)!;
  assert.equal(message.senderType, "user");
  assert.equal(message.senderId, world.reader.id);
  assert.equal(message.content, `Have a look\n\n${linkOf(world.page)}`);
  assert.equal(message.actionMetadata, null);

  // Without a note: the link alone.
  const bare = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { note: "   " }));
  assert.equal(bare.status, 200);
  const [row] = await getDb().select().from(messages).where(eq(messages.id, bare.body.messageId));
  assert.equal(row!.content, linkOf(world.page));
});

test("share: the link is on this deployment's origin (APP_URL), never production's from staging", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  vi.stubEnv("APP_URL", "https://staging.raft.example");
  try {
    const res = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { note: "staging" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [message] = await getDb().select().from(messages).where(eq(messages.id, res.body.messageId));
    assert.equal(message!.content, `staging\n\nhttps://staging.raft.example/artifacts/${artifactLinkId(id(world.page))}`);
    assert.ok(!message!.content.includes("app.raft.build"));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("share: into a thread of the conversation when threadRootId is given", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const root = await createMessage(world.team.id, "user", world.owner.id, "the root");
  const res = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { threadRootId: root.id, note: "in the thread" }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [message] = await getDb().select().from(messages).where(eq(messages.id, res.body.messageId));
  const [thread] = await getDb().select().from(channels).where(eq(channels.id, message!.channelId));
  assert.equal(thread!.type, "thread");
  assert.equal(thread!.parentMessageId, root.id);
  assert.equal(message!.content, `in the thread\n\n${linkOf(world.page)}`);
  // An existing thread is reused.
  const again = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { threadRootId: root.id }));
  const [second] = await getDb().select().from(messages).where(eq(messages.id, again.body.messageId));
  assert.equal(second!.channelId, thread!.id);
});

test("share: refused (404 TARGET_NOT_FOUND, nothing posted) where the person can't post", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const otherRoot = await createMessage(world.other.id, "user", world.owner.id, "elsewhere");
  const thread = await getOrCreateThread((await createMessage(world.team.id, "user", world.owner.id, "root")).id, world.owner.id, "user");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a conversation the reader isn't in", shareInput(world.other.id)],
    ["a public channel the reader hasn't joined", shareInput(world.open.id)],
    ["no such conversation", shareInput(randomUUID())],
    ["not an id", shareInput("general")],
    ["a thread named as the conversation", shareInput(thread.id)],
    ["a root message of another conversation", shareInput(world.team.id, { threadRootId: otherRoot.id })],
    ["no such root message", shareInput(world.team.id, { threadRootId: randomUUID() })],
  ];
  const threadsBefore = (await getDb().select().from(channels).where(eq(channels.parentMessageId, otherRoot.id))).length;
  for (const [what, input] of cases) {
    const res = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, input);
    assert.equal(res.status, 404, what);
    assert.equal(res.body.code, "TARGET_NOT_FOUND", what);
    assert.equal(res.body.details.conversationId, input.conversationId, what);
  }
  assert.equal(await messagesBy(world, world.reader.id), 0);
  assert.equal((await getDb().select().from(channels).where(eq(channels.parentMessageId, otherRoot.id))).length, threadsBefore, "no thread left behind");
  // An archived conversation, too.
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, world.team.id));
  const archived = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id));
  assert.equal(archived.status, 404);
  assert.equal(await messagesBy(world, world.reader.id), 0);
});

test("share: an Artifact the person can't see is the one 404 NOT_VISIBLE", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const res = await call(app, "POST", artifactWebPaths.share(id(world.secret)), world.who.reader, shareInput(world.team.id));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, webNotVisible().body);
  assert.equal(await messagesBy(world, world.reader.id), 0);
});

test("share: a note over the limit is 400 FIELD_TOO_LONG; a malformed body 400 INVALID_REQUEST; nothing posted", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  // Characters, not UTF-16 units: the limit in emoji fits.
  const atLimit = await call(app, "POST", path, world.who.reader, shareInput(world.team.id, { note: "😀".repeat(ARTIFACT_SHARE_NOTE_MAX_CHARS) }));
  assert.equal(atLimit.status, 200);
  const over = await call(app, "POST", path, world.who.reader, shareInput(world.team.id, { note: "x".repeat(ARTIFACT_SHARE_NOTE_MAX_CHARS + 1) }));
  assert.equal(over.status, 400);
  assert.deepEqual(over.body.code, "FIELD_TOO_LONG");
  assert.deepEqual(over.body.details, { field: "note", limit: ARTIFACT_SHARE_NOTE_MAX_CHARS });
  const { clientKey: _, ...keyless } = shareInput(world.team.id);
  const malformed = [
    {}, { ...shareInput(world.team.id), note: 3 }, { ...shareInput(world.team.id), widenTo: "everyone" }, { ...shareInput(world.team.id), extra: 1 }, ["a"],
    keyless, shareInput(world.team.id, { clientKey: "" }), shareInput(world.team.id, { clientKey: "x".repeat(65) }), shareInput(world.team.id, { clientKey: "a b" }), shareInput(world.team.id, { clientKey: 7 }),
  ];
  for (const body of malformed) {
    const res = await call(app, "POST", path, world.who.reader, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_REQUEST", JSON.stringify(body));
  }
  assert.equal(await messagesBy(world, world.reader.id), 1, "only the one at the limit");
});

test("share with widenTo: the home route's move (home, audit row, moved event), then the message; a retry of the attempt is the one message and no second move", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  const input = shareInput(world.team.id, { note: "for everyone", widenTo: "server" });
  const res = await call(app, "POST", path, world.who.owner, input);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((res.body as ArtifactWebShared).home, { kind: "server" });
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, world.page.id));
  assert.deepEqual([item!.homeKind, item!.homeChannelId], ["server", null]);
  const audit = await auditOf(world.page);
  assert.deepEqual(audit.map((row) => [row.action, row.actorId, row.before, row.after]), [
    ["home_changed", world.owner.id, { home_kind: "conversation", home_channel_id: world.team.id }, { home_kind: "server", home_channel_id: null }],
  ]);
  assert.deepEqual((await movedEventsOf(world.page)).map((event) => event.data), [{ from: "conversation", to: "server", fromChannelId: world.team.id }]);
  const [message] = await getDb().select().from(messages).where(eq(messages.id, res.body.messageId));
  assert.equal(message!.content, `for everyone\n\n${linkOf(world.page)}`);

  // The same attempt again: the one message, nothing moved again.
  const again = await call(app, "POST", path, world.who.owner, input);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.messageId, res.body.messageId);
  // A retry never runs the move: no home in its answer.
  assert.equal(again.body.home, null);
  assert.equal((await auditOf(world.page)).length, 1);
  assert.equal(await messagesBy(world, world.owner.id), 1);

  // On to public, by the person who may.
  const pub = await call(app, "POST", path, world.who.owner, shareInput(world.open.id, { widenTo: "public" }));
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual(pub.body.home, { kind: "public" });
  assert.deepEqual((await auditOf(world.page)).map((row) => row.action), ["home_changed", "made_public"]);
});

test("share with widenTo: refused as the home route refuses (a reader who doesn't manage it: 403), and where the person can't post nothing moves; nothing is posted", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const widenTo of ["server", "public"]) {
    const res = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id, { widenTo }));
    assert.equal(res.status, 403, widenTo);
    assert.equal(res.body.code, "FORBIDDEN", widenTo);
  }
  assert.equal(await messagesBy(world, world.reader.id), 0);
  // The author, into a conversation that doesn't exist: the send's 404, and the move never ran.
  const notPosted = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.owner, shareInput(randomUUID(), { widenTo: "server" }));
  assert.equal(notPosted.status, 404);
  assert.equal(notPosted.body.code, "TARGET_NOT_FOUND");
  // A name taken in the larger home: 409, nothing posted.
  await getDb().insert(artifactItems).values({ id: `pt_${randomUUID()}`, serverId: world.serverId, urlKey: randomUUID(), name: world.page.name, title: "Same name", homeKind: "server", createdByType: "user", createdById: world.owner.id });
  const taken = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.owner, shareInput(world.team.id, { widenTo: "server" }));
  assert.deepEqual([taken.status, taken.body.code], [409, "NAME_TAKEN"]);
  assert.equal(await messagesBy(world, world.owner.id), 0);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, world.page.id));
  assert.equal(item!.homeKind, "conversation");
  assert.deepEqual(await auditOf(world.page), []);
});

test("share with widenTo: a retry after someone narrowed it doesn't widen it again: the one message, replayed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // #other: the owner only (no guest), where `secret` lives.
  const input = shareInput(world.other.id, { widenTo: "server" });
  const first = await call(app, "POST", artifactWebPaths.share(id(world.secret)), world.who.owner, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.home, { kind: "server" });
  // Narrowing back, confirmed from the preview (only `expectedLost` narrows).
  const shown = await call(app, "GET", artifactWebPaths.homeChange(id(world.secret), { to: "conversation", conversationId: asChannelId(world.other.id) }), world.who.owner);
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  const expectedLost = shown.body.peopleLosingAccess + shown.body.agentsLosingAccess;
  const back = await call(app, "POST", artifactWebPaths.home(id(world.secret)), world.who.owner, { to: "conversation", conversationId: world.other.id, expectedLost });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  // The same attempt again: the one message replayed, nothing moved.
  const retry = await call(app, "POST", artifactWebPaths.share(id(world.secret)), world.who.owner, input);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.messageId, first.body.messageId);
  assert.equal(retry.body.home, null);
  const homeOf = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
  assert.deepEqual([(await homeOf(world.secret)).homeKind, (await homeOf(world.secret)).homeChannelId], ["conversation", world.other.id]);
  assert.deepEqual((await auditOf(world.secret)).map((row) => row.action), ["home_changed", "narrowed"]);
});

test("share with widenTo: a clientKey reused for another conversation moves nothing (keyReused, 400)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const homeOf = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
  // A key that sent the page to #team without widenTo, reused for #open with widenTo: keyReused, the home untouched.
  const keyed = shareInput(world.team.id);
  assert.equal((await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.owner, keyed)).status, 200);
  const reused = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.owner, { ...keyed, conversationId: world.open.id, widenTo: "server" });
  assert.deepEqual([reused.status, reused.body.code], [400, "INVALID_REQUEST"]);
  assert.equal((await homeOf(world.page)).homeKind, "conversation");
  assert.deepEqual(await auditOf(world.page), []);
  assert.equal((await messagesIn(world.open.id)).length, 0);
});

test("share-audience widenTo: offered to the author and an admin, never to a member who doesn't manage it nor a delegated actor; server first, public only for whom server doesn't reach", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // #wide: owner, reader, outsider, agentIn, agentOut. The page (#team: owner, reader, guest, agentIn) is unseen by outsider and agentOut.
  // The guest reads only #team, its one channel (#wg-rbac:#15).
  const wide = await createChannel(world.server.id, `share-wide-${label()}`, undefined, "private");
  for (const human of [world.owner, world.reader, world.outsider]) await addHuman(wide.id, human.id);
  for (const agent of [world.agentIn, world.agentOut]) await addAgent(wide.id, agent.id);
  const admin = await seed.human();
  await addMember(world.server.id, admin.id);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, admin.id)));
  await addHuman(world.team.id, admin.id);
  await addHuman(wide.id, admin.id);
  const answer = async (who: { token: string; serverId: string }, item: { id: string }, conversationId: string) => {
    const res = await call(app, "GET", artifactWebPaths.shareAudience(id(item), { conversationId: asChannelId(conversationId) }), who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as ArtifactWebShareAudience;
  };
  const audience = async (who: { token: string; serverId: string }, item: { id: string }, conversationId: string) => (await answer(who, item, conversationId)).widenTo;
  const refused = async (who: { token: string; serverId: string }, item: { id: string }, conversationId: string) => (await answer(who, item, conversationId)).widenRefused;
  // The server reaches outsider and agentOut: public would add no one.
  assert.deepEqual(await audience(world.who.owner, world.page, wide.id), ["server"], "the author");
  assert.deepEqual(await audience({ token: await accessTokenForTest(admin.id), serverId: world.server.id }, world.page, wide.id), ["server"], "an admin");
  assert.deepEqual(await audience(world.who.reader, world.page, wide.id), [], "a member who doesn't manage it");
  // A guest asking about a conversation other than its own: the one 404, as for any it can't see.
  const guestWide = await call(app, "GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(wide.id) }), world.who.guest);
  assert.deepEqual([guestWide.status, guestWide.body.code], [404, "TARGET_NOT_FOUND"], "a guest, outside its channel");
  // In its own #team, everyone sees the page already: nothing to offer, nothing refused.
  assert.deepEqual(await answer(world.who.guest, world.page, world.team.id).then((res) => [res.widenTo, res.widenRefused]), [[], []], "a guest, in its channel");
  // Why not (#77): one who may not move it hears only that, for the server (public would reach no one more).
  assert.deepEqual(await refused(world.who.reader, world.page, wide.id), [{ to: "server", reason: "forbidden" }], "a member who doesn't manage it");
  assert.deepEqual(await refused(world.who.owner, world.page, wide.id), [], "the author: offered, nothing refused");
  // #other's Artifact into #team, as a member who may not move it: the server (reader, agentIn) and public (the guest) both refused.
  await addHuman(world.other.id, world.reader.id);
  assert.deepEqual(await refused(world.who.reader, world.secret, world.team.id), [{ to: "server", reason: "forbidden" }, { to: "public", reason: "forbidden" }]);
  // #other's Artifact into #team: reader and agentIn need the server, the guest needs public.
  assert.deepEqual(await audience(world.who.owner, world.secret, world.team.id), ["server", "public"]);
  // Everyone in #team sees the page already: nothing to offer.
  assert.deepEqual(await audience(world.who.owner, world.page, world.team.id), []);
  // The service, as share-audience asks it: a delegated actor gets nothing, the author both.
  const [page] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, world.page.id));
  assert.deepEqual(await widerHomesFor({ type: "delegated", id: world.owner.id, agentId: world.agentIn.id, serverId: world.serverId }, page!), []);
  assert.deepEqual(await widerHomesFor({ type: "user", id: world.owner.id, serverId: world.serverId }, page!), ["server", "public"]);
  // A name taken in the server: only public is left to offer, and it reaches them too.
  await getDb().insert(artifactItems).values({ id: `pt_${randomUUID()}`, serverId: world.serverId, urlKey: randomUUID(), name: world.page.name, title: "Same name", homeKind: "server", createdByType: "user", createdById: world.owner.id });
  assert.deepEqual(await audience(world.who.owner, world.page, wide.id), ["public"]);
  // And why the server isn't offered (#77): the name, which is this Artifact's own.
  assert.deepEqual(await refused(world.who.owner, world.page, wide.id), [{ to: "server", reason: "name_taken", name: world.page.name }]);
  // One who may not move it still hears only "forbidden", never the name's holder.
  assert.deepEqual(await refused(world.who.reader, world.page, wide.id), [{ to: "server", reason: "forbidden" }]);
  // The service: a delegated actor is refused each larger home.
  assert.deepEqual((await widerHomeChoices({ type: "delegated", id: world.owner.id, agentId: world.agentIn.id, serverId: world.serverId }, page!)).map((choice) => [choice.to, choice.refusal?.kind]), [["server", "forbidden"], ["public", "forbidden"]]);
});

limitedTest("share is a write: limited with the other writes (429 RATE_LIMITED)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  assert.equal((await call(app, "POST", path, world.who.reader, shareInput(world.team.id))).status, 200);
  assert.equal((await call(app, "POST", path, world.who.reader, shareInput(world.team.id))).status, 200);
  const third = await call(app, "POST", path, world.who.reader, shareInput(world.team.id));
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "RATE_LIMITED");
});

test("share is idempotent per clientKey: the same key again is the one message, the same messageId; another conversation with it is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  const input = shareInput(world.team.id, { note: "once" });
  const first = await call(app, "POST", path, world.who.reader, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await call(app, "POST", path, world.who.reader, input);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.messageId, first.body.messageId);
  assert.equal(await messagesBy(world, world.reader.id), 1, "one message");
  const [row] = await getDb().select().from(messages).where(eq(messages.id, first.body.messageId));
  assert.ok(row!.randomId?.includes(input.clientKey), "core's idempotency key is made of the clientKey");

  // Into a thread too: the retry finds the thread and the message.
  const root = await createMessage(world.team.id, "user", world.owner.id, "the root");
  const threaded = shareInput(world.team.id, { threadRootId: root.id });
  const inThread = await call(app, "POST", path, world.who.reader, threaded);
  assert.equal((await call(app, "POST", path, world.who.reader, threaded)).body.messageId, inThread.body.messageId);
  assert.equal(await messagesBy(world, world.reader.id), 1, "the thread reply is in the thread, once");

  // A new key is a new message; the same key from someone else is theirs.
  assert.notEqual((await call(app, "POST", path, world.who.reader, shareInput(world.team.id))).body.messageId, first.body.messageId);
  const owners = await call(app, "POST", path, world.who.owner, input);
  assert.equal(owners.status, 200);
  assert.notEqual(owners.body.messageId, first.body.messageId);

  // The key of a share to #team, for #open: refused, nothing posted.
  const elsewhere = await call(app, "POST", path, world.who.owner, { ...input, conversationId: world.open.id });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.body.code, "INVALID_REQUEST");
  assert.equal((await messagesIn(world.open.id)).length, 0);
});

messageLimitedTest("share is behind core's message limit, counted with POST /api/messages", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  assert.equal((await call(app, "POST", "/api/messages", world.who.reader, { channelId: world.team.id, content: "hello" })).status, 200);
  assert.equal((await call(app, "POST", path, world.who.reader, shareInput(world.team.id))).status, 200);
  const third = await call(app, "POST", path, world.who.reader, shareInput(world.team.id));
  assert.equal(third.status, 429);
  assert.deepEqual(third.body, { error: "Too many messages, please slow down" });
  assert.equal((await call(app, "POST", "/api/messages", world.who.reader, { channelId: world.team.id, content: "again" })).status, 429);
  assert.equal(await messagesBy(world, world.reader.id), 2);
  // Another person's budget is their own.
  assert.equal((await call(app, "POST", path, world.who.owner, shareInput(world.team.id))).status, 200);
});

// ---- share audience --------------------------------------------------------------

test("share-audience: counts the members of a conversation who couldn't see the Artifact, guests apart, no names", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // #wide: owner, reader, outsider, guest, agentIn, agentOut. The page (#team) is seen by owner, reader, guest and agentIn.
  const wide = await createChannel(world.server.id, `share-wide-${label()}`, undefined, "private");
  for (const human of [world.owner, world.reader, world.outsider, world.guest]) await addHuman(wide.id, human.id);
  for (const agent of [world.agentIn, world.agentOut]) await addAgent(wide.id, agent.id);
  const res = await call(app, "GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(wide.id) }), world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The reader may not move it: the server would help, and the reader is told only that they may not (#77).
  assert.deepEqual(res.body as ArtifactWebShareAudience, { members: 6, cannotSee: 2, guestsCannotSee: 0, widenTo: [], widenRefused: [{ to: "server", reason: "forbidden" }] });

  // The reader can't see #other's Artifact at all: the one 404, no counts.
  const hidden = await call(app, "GET", artifactWebPaths.shareAudience(id(world.secret), { conversationId: asChannelId(world.team.id) }), world.who.reader);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, "NOT_VISIBLE");
  // The owner sees it; in #team, reader, guest and agentIn can't (the guest counted apart).
  const owners = await call(app, "GET", artifactWebPaths.shareAudience(id(world.secret), { conversationId: asChannelId(world.team.id) }), world.who.owner);
  assert.deepEqual(owners.body, { members: 4, cannotSee: 3, guestsCannotSee: 1, widenTo: ["server", "public"], widenRefused: [] });

  // A server home reaches every member but the guest.
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, world.secret.id));
  const serverHome = await call(app, "GET", artifactWebPaths.shareAudience(id(world.secret), { conversationId: asChannelId(world.team.id) }), world.who.owner);
  assert.deepEqual(serverHome.body, { members: 4, cannotSee: 1, guestsCannotSee: 1, widenTo: ["public"], widenRefused: [] });
});

test("share-audience: a conversation the reader can't see is 404 TARGET_NOT_FOUND; a missing one 400 INVALID_REQUEST", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const conversationId of [world.other.id, randomUUID(), "general"]) {
    const res = await call(app, "GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(conversationId) }), world.who.reader);
    assert.equal(res.status, 404, conversationId);
    assert.equal(res.body.code, "TARGET_NOT_FOUND", conversationId);
  }
  const missing = await call(app, "GET", `/api/artifacts/${world.page.id}/share-audience`, world.who.reader);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "INVALID_REQUEST");
});

test("share-audience: past the counting budget, `capped` with counts that are a lower bound and the exact member count", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const wide = await createChannel(world.server.id, `share-cap-${label()}`, undefined, "private");
  for (const human of [world.owner, world.reader, world.outsider, world.guest]) await addHuman(wide.id, human.id);
  for (const agent of [world.agentIn, world.agentOut]) await addAgent(wide.id, agent.id);
  shareAudienceLimits.maxCounted = 3;
  const res = await call(app, "GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(wide.id) }), world.who.reader);
  assert.equal(res.status, 200);
  const audience = res.body as ArtifactWebShareAudience;
  assert.equal(audience.capped, true);
  assert.equal(audience.members, 6);
  assert.ok(audience.cannotSee <= 2, "a lower bound");
});

test("share-audience: a joint channel's members on every server in it see an Artifact homed there; one homed elsewhere only public would reach", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerOwner = await seed.human();
  const peerMember = await seed.human();
  const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
  const joint = await seedJointChannel({ name: `share-joint-${label()}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addHuman(peerProjection.id, peerMember.id);
  const item = await insertArtifact(world.serverId, world.r2, joint.canonical.id, world.owner.id);
  const audience = async () => {
    const res = await call(app, "GET", artifactWebPaths.shareAudience(id(item), { conversationId: asChannelId(hostProjection.id) }), world.who.reader);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as ArtifactWebShareAudience;
  };
  assert.deepEqual(await audience(), { members: 2, cannotSee: 0, guestsCannotSee: 0, widenTo: [], widenRefused: [] }, "everyone in the joint sees it");
  // An Artifact of the host's #team: the peer's member is an outsider to it.
  const team = await call(app, "GET", artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(hostProjection.id) }), world.who.reader);
  // Only public would reach them, and the reader may not make it public.
  assert.deepEqual(team.body, { members: 2, cannotSee: 1, guestsCannotSee: 0, widenTo: [], widenRefused: [{ to: "public", reason: "forbidden" }] });
});

// ---- save an attachment ----------------------------------------------------------

test("save-attachment: copies the bytes into Artifacts' storage, a new Artifact homed where the attachment is, the save recorded", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "the report");
  const bytes = Buffer.from("# Q3 report\n\nnumbers");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "Q3 report.md", bytes });
  const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const saved = res.body as ArtifactWebSaved;
  assert.equal(saved.created, true);
  assert.equal(saved.artifact.card.title, "Q3 report", "titled after the file, without its extension");
  assert.equal(saved.artifact.card.version, 1);
  assert.equal(saved.artifact.card.kind, "markdown");
  assert.deepEqual(saved.artifact.card.home, { kind: "conversation", conversation: { id: world.team.id, name: world.team.name, type: "private" } });
  assert.equal(saved.artifact.card.author.id, world.reader.id);
  assert.deepEqual(saved.artifact.files.map((file) => [file.path, file.sizeBytes, file.entry]), [["Q3 report.md", bytes.length, true]]);
  assert.deepEqual(saved.artifact.savedFrom, { attachmentId: attachment.id, messageId: message.id, conversationId: world.team.id });

  // The bytes, copied into R2 under this server's blob.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const [blob] = await getDb().select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha256)));
  assert.equal(blob!.state, "ready");
  assert.deepEqual(world.r2.get(blob!.r2Key), bytes);
  // The save, and the saver follows what it made.
  const [save] = await savesOf(attachment.id);
  assert.equal(save!.itemId, saved.artifact.card.id);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, saved.artifact.card.id));
  assert.equal(item!.createdByType, "user");
  assert.equal(item!.createdById, world.reader.id);
  assert.equal(save!.versionId, item!.currentVersionId);
  assert.equal((await getDb().select().from(artifactSubscriptions).where(and(eq(artifactSubscriptions.itemId, item!.id), eq(artifactSubscriptions.actorId, world.reader.id)))).length, 1);
  // Nothing was added to the message or its attachment.
  const [after] = await getDb().select().from(attachments).where(eq(attachments.id, attachment.id));
  assert.deepEqual(after, attachment);

  // Saving it again answers the same Artifact, 200, created false.
  const again = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.owner, { attachmentId: attachment.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.artifact.card.id, saved.artifact.card.id);
  assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, world.team.id))).length, 2, "the page and the saved one");
});

test("save-attachment: the saver follows the new Artifact as following does: read up to its last position, so only what comes after is unread in Activity", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "a file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "plan.md", bytes: Buffer.from("# plan") });
  const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const itemId = res.body.artifact.card.id as string;
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, itemId));
  const [subscription] = await getDb().select().from(artifactSubscriptions).where(and(eq(artifactSubscriptions.itemId, itemId), eq(artifactSubscriptions.actorId, world.reader.id)));
  assert.equal(subscription!.unsubscribedAt, null, "following");
  const [position] = await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, itemId), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, world.reader.id)));
  assert.equal(position!.position, item!.lastPosition, "the read position is the Artifact's last position");
  assert.equal(res.body.artifact.following, true);

  const activity = async () => {
    const inbox = await call(app, "GET", "/api/channels/inbox?filter=all&limit=100", world.who.reader);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const rows = (inbox.body.items as Array<{ kind: string }>).filter((row): row is ObjectInboxItem => row.kind === "object");
    const summary = await call(app, "GET", "/api/servers/unread-summary", world.who.reader);
    const badge = (summary.body as Array<{ serverId: string; activityObjectUnreadCount?: number }>).find((entry) => entry.serverId === world.server.id)!.activityObjectUnreadCount;
    return { rows: rows.map((row) => [row.objectId, row.unreadCount]), unread: inbox.body.objectUnreadCount, badge };
  };
  assert.deepEqual(await activity(), { rows: [], unread: 0, badge: 0 }, "saving makes nothing unread for the saver");
  // Someone else comments: the saver hears of it, and only of it.
  const commented = await call(app, "POST", artifactWebPaths.comments(asArtifactId(itemId)), world.who.owner, {
    body: [{ type: "text", text: "nice" }], version: 1, target: { scope: "artifact" }, replyTo: null,
  });
  assert.equal(commented.status, 201, JSON.stringify(commented.body));
  assert.deepEqual(await activity(), { rows: [[itemId, 1]], unread: 1, badge: 1 });
});

test("save-attachment, home and unpublish answer the Artifact without `frame`: a ticket is only in the viewer route's own answer", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // The content origin configured: the viewer signs a frame for an html version.
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", "w".repeat(40));
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "content.example.test");
  try {
    const message = await createMessage(world.team.id, "user", world.owner.id, "a page");
    const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "page.html", bytes: Buffer.from("<h1>page</h1>") });
    const created = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const artifact = asArtifactId(created.body.artifact.card.id as string);
    assert.equal(created.body.artifact.card.kind, "html");
    assert.equal("frame" in created.body.artifact, false, "a new save");
    const earlier = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.owner, { attachmentId: attachment.id });
    assert.equal(earlier.status, 200, JSON.stringify(earlier.body));
    assert.equal("frame" in earlier.body.artifact, false, "an earlier save");
    // Witness: the viewer route's own answer carries it.
    const viewed = await call(app, "GET", artifactWebPaths.viewer(artifact), world.who.reader);
    assert.equal(viewed.status, 200);
    assert.match((viewed.body as ArtifactViewerData).frame?.url ?? "", /\/_raft\/open\?ticket=rct1\./);
    // The other routes that answer ArtifactViewerData: moving it, making it private again.
    const moved = await call(app, "POST", artifactWebPaths.home(artifact), world.who.reader, { to: "public" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal("frame" in moved.body, false, "home");
    const unpublished = await call(app, "POST", artifactWebPaths.unpublish(artifact), world.who.reader);
    assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
    assert.equal("frame" in unpublished.body, false, "unpublish");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("save-attachment: the copied bytes count against the server's monthly file upload quota; with no room, 403 FILE_UPLOAD_QUOTA_EXCEEDED and nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const usage = async () => {
    const [row] = await getDb().select().from(serverFileUploadUsageMonths)
      .where(and(eq(serverFileUploadUsageMonths.serverId, world.server.id), eq(serverFileUploadUsageMonths.month, billingUsageMonth())));
    return { usedBytes: row?.usedBytes ?? 0, reservedBytes: row?.reservedBytes ?? 0 };
  };
  const setUsage = (usedBytes: number) => getDb().insert(serverFileUploadUsageMonths)
    .values({ serverId: world.server.id, month: billingUsageMonth(), usedBytes, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes, reservedBytes: 0 } });
  const message = await createMessage(world.team.id, "user", world.owner.id, "a file");
  const bytes = Buffer.from("ten bytes!");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "ten.txt", bytes });
  const save = () => call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  const blobs = () => getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId));
  const before = (await blobs()).length;

  await setUsage(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - 4);
  const captured = capturePaywallHits(app);
  const refused = await save();
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.match(refused.body.error, /^Monthly file upload quota exceeded/);
  assert.equal(refused.body.details.requestedBytes, bytes.length);
  assert.equal(refused.body.details.quota.plan, "free");
  assert.equal(refused.body.details.quota.limitBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  assert.match(refused.body.details.billingUrl, new RegExp(`/s/${world.server.slug}/settings/billing$`));
  assert.deepEqual(await savesOf(attachment.id), [], "nothing saved");
  assert.equal((await blobs()).length, before, "no blob row");
  assert.equal(world.r2.size, 2, "only the seeded Artifacts' bytes");
  assert.deepEqual(await usage(), { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - 4, reservedBytes: 0 }, "nothing reserved or counted");
  // One paywall hit, the reader's, recorded by the server.
  await captured.expect(1, "the person's save");
  assert.deepEqual(captured.hits().map((hit) => [hit.properties, hit.analyticsId !== null, hit.serverId]), [[
    { gate: "upload_monthly_quota", actor: "person", plan: "free", viewer_role: "member", via: "artifact_save_attachment", requested_bytes: bytes.length, month_used_bytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - 4 },
    true,
    world.server.id,
  ]]);

  // With room it saves, and the bytes count once.
  await setUsage(0);
  assert.equal((await save()).status, 201);
  assert.deepEqual(await usage(), { usedBytes: bytes.length, reservedBytes: 0 });
  // Bytes the server's Artifacts already have cost nothing, even with the month full.
  const second = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "same.txt", bytes });
  await setUsage(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  const same = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: second.id });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.deepEqual(await usage(), { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 });
  await captured.expect(1, "saves that fit are no hit");
});

test("save-attachment: an attachment in a thread is homed in the thread's conversation", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const root = await createMessage(world.team.id, "user", world.owner.id, "root");
  const thread = await getOrCreateThread(root.id, world.owner.id, "user");
  const reply = await createMessage(thread.id, "user", world.owner.id, "a reply with a file");
  const attachment = await postAttachment(world, { channelId: thread.id, messageId: reply.id, uploaderId: world.owner.id, filename: "notes.txt", bytes: Buffer.from("notes") });
  const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.artifact.card.home.conversation.id, world.team.id);
});

test("save-attachment: refuses attachments the saver can't see (404 ATTACHMENT_NOT_FOUND), too large ones (422), and one saved as an Artifact the saver can't see now (409)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const elsewhere = await createMessage(world.other.id, "user", world.owner.id, "private file");
  const hidden = await postAttachment(world, { channelId: world.other.id, messageId: elsewhere.id, uploaderId: world.owner.id, filename: "h.txt", bytes: Buffer.from("h") });
  for (const attachmentId of [hidden.id, randomUUID(), "not-a-uuid"]) {
    const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId });
    assert.equal(res.status, 404, attachmentId);
    assert.deepEqual(res.body, refusalBody({ code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId } }));
  }
  assert.deepEqual(await savesOf(hidden.id), []);

  const message = await createMessage(world.team.id, "user", world.owner.id, "big");
  const big = await postAttachment(world, {
    channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "big.bin", bytes: Buffer.from("x"), sizeBytes: ARTIFACT_SAVE_MAX_BINARY_BYTES + 1,
  });
  const tooLarge = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: big.id });
  assert.equal(tooLarge.status, 422);
  assert.deepEqual(tooLarge.body.details, { attachmentId: big.id, reason: "too_large", limit: ARTIFACT_SAVE_MAX_BINARY_BYTES });

  // Saved by the owner, then moved to #other: the reader sees the attachment, not the Artifact.
  const file = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "f.txt", bytes: Buffer.from("f") });
  const first = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.owner, { attachmentId: file.id });
  assert.equal(first.status, 201);
  await getDb().update(artifactItems).set({ homeChannelId: world.other.id }).where(eq(artifactItems.id, first.body.artifact.card.id));
  const already = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: file.id });
  assert.equal(already.status, 409);
  assert.deepEqual(already.body, refusalBody({ code: "ALREADY_SAVED", error: ALREADY_SAVED_ERROR, details: { attachmentId: file.id } }));

  for (const body of [{}, { attachmentId: 3 }, { attachmentId: file.id, extra: true }]) {
    const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_REQUEST");
  }
});

test("save-attachment: Artifacts' storage not configured is 503 CONTENT_UNAVAILABLE, nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "a file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "a.txt", bytes: Buffer.from("a") });
  __setArtifactR2StoreForTests(null);
  const res = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "CONTENT_UNAVAILABLE");
  assert.deepEqual(await savesOf(attachment.id), []);
});

test("save-attachment: a file in a message behind the plan's history window is 404 ATTACHMENT_NOT_FOUND, nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const old = await createMessage(world.team.id, "user", world.owner.id, "an old file");
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: old.id, uploaderId: world.owner.id, filename: "old.txt", bytes: Buffer.from("old") });
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, world.server.id));
  for (const who of [world.who.reader, world.who.owner]) {
    const res = await call(app, "POST", artifactWebPaths.saveAttachment(), who, { attachmentId: attachment.id });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, refusalBody({ code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId: attachment.id } }));
  }
  assert.deepEqual(await savesOf(attachment.id), []);
  assert.equal(world.r2.size, 2, "only the seeded Artifacts' bytes");
  // On Pro (all history) it saves.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  assert.equal((await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id })).status, 201);
});

test("save-attachment: once the Artifact it was saved as is deleted or revoked, saving again makes a new one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "a file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "a.txt", bytes: Buffer.from("a") });
  const save = () => call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  const listed = async () => ((await call(app, "GET", artifactWebPaths.attachmentSaves([attachment.id]), world.who.reader)).body as ArtifactWebAttachmentSaves).saves;
  const first = await save();
  assert.equal(first.status, 201);
  const firstId = first.body.artifact.card.id;
  assert.equal((await listed()).length, 1);

  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, firstId));
  // A deleted one is no save: not listed, and saving makes another (not ALREADY_SAVED).
  assert.deepEqual(await listed(), []);
  const second = await save();
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.created, true);
  assert.notEqual(second.body.artifact.card.id, firstId);
  assert.deepEqual((await savesOf(attachment.id)).map((row) => row.itemId), [second.body.artifact.card.id]);
  const [entry] = await listed();
  assert.equal(entry!.savedAs.status === "ok" ? entry!.savedAs.card.id : null, second.body.artifact.card.id);
  // Saving again now answers the live one.
  const again = await save();
  assert.equal(again.status, 200);
  assert.equal(again.body.artifact.card.id, second.body.artifact.card.id);

  // Revoked, the same.
  await getDb().update(artifactItems).set({ revokedAt: new Date() }).where(eq(artifactItems.id, second.body.artifact.card.id));
  assert.deepEqual(await listed(), []);
  const third = await save();
  assert.equal(third.status, 201);
  assert.notEqual(third.body.artifact.card.id, second.body.artifact.card.id);
});

// ---- attachment saves ------------------------------------------------------------

test("attachment-saves: only saved attachments the reader can see, each as a card or, when the reader can't see the Artifact, unavailable", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const inTeam = await createMessage(world.team.id, "user", world.owner.id, "files");
  const inOther = await createMessage(world.other.id, "user", world.owner.id, "files");
  const savedHere = await postAttachment(world, { channelId: world.team.id, messageId: inTeam.id, uploaderId: world.owner.id, filename: "a.txt", bytes: Buffer.from("a") });
  const notSaved = await postAttachment(world, { channelId: world.team.id, messageId: inTeam.id, uploaderId: world.owner.id, filename: "b.txt", bytes: Buffer.from("b") });
  const movedAway = await postAttachment(world, { channelId: world.team.id, messageId: inTeam.id, uploaderId: world.owner.id, filename: "c.txt", bytes: Buffer.from("c") });
  const savedHidden = await postAttachment(world, { channelId: world.other.id, messageId: inOther.id, uploaderId: world.owner.id, filename: "d.txt", bytes: Buffer.from("d") });
  const saveAs = async (attachmentId: string) => (await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.owner, { attachmentId })).body as ArtifactWebSaved;
  const here = await saveAs(savedHere.id);
  const moved = await saveAs(movedAway.id);
  await saveAs(savedHidden.id);
  await getDb().update(artifactItems).set({ homeChannelId: world.other.id }).where(eq(artifactItems.id, moved.artifact.card.id));

  const ids = [savedHere.id, notSaved.id, movedAway.id, savedHidden.id, randomUUID()];
  const res = await call(app, "GET", artifactWebPaths.attachmentSaves(ids), world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { saves } = res.body as ArtifactWebAttachmentSaves;
  assert.deepEqual(saves.map((save) => save.attachmentId).sort(), [savedHere.id, movedAway.id].sort());
  const byId = new Map(saves.map((save) => [save.attachmentId, save.savedAs]));
  const ok = byId.get(savedHere.id)!;
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.status === "ok" ? ok.card : null, here.artifact.card);
  assert.deepEqual(byId.get(movedAway.id), { status: "unavailable", url: linkOf({ id: moved.artifact.card.id }) });

  // The owner sees every one of them.
  const owners = await call(app, "GET", artifactWebPaths.attachmentSaves(ids), world.who.owner);
  assert.equal(owners.body.saves.length, 3);
  assert.ok(owners.body.saves.every((save: { savedAs: { status: string } }) => save.savedAs.status === "ok"));
});

test("attachment-saves: a saved attachment whose message is behind the plan's history window is not listed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const old = await createMessage(world.team.id, "user", world.owner.id, "an old file");
  const recent = await createMessage(world.team.id, "user", world.owner.id, "a recent file");
  const oldFile = await postAttachment(world, { channelId: world.team.id, messageId: old.id, uploaderId: world.owner.id, filename: "old.txt", bytes: Buffer.from("old") });
  const recentFile = await postAttachment(world, { channelId: world.team.id, messageId: recent.id, uploaderId: world.owner.id, filename: "new.txt", bytes: Buffer.from("new") });
  for (const attachmentId of [oldFile.id, recentFile.id]) {
    assert.equal((await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.owner, { attachmentId })).status, 201);
  }
  // Saved while recent; the message is now 40 days old on a Free server.
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, world.server.id));
  const res = await call(app, "GET", artifactWebPaths.attachmentSaves([oldFile.id, recentFile.id]), world.who.reader);
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as ArtifactWebAttachmentSaves).saves.map((save) => save.attachmentId), [recentFile.id]);
});

test("attachment-saves: more than the limit, none, or a malformed list is 400 INVALID_REQUEST", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const tooMany = Array.from({ length: ARTIFACT_ATTACHMENT_SAVES_MAX_IDS + 1 }, () => randomUUID());
  for (const path of [artifactWebPaths.attachmentSaves(tooMany), artifactWebPaths.attachmentSaves([]), "/api/artifacts/attachment-saves", "/api/artifacts/attachment-saves?attachmentIds=a&attachmentIds=b"]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }
  const atLimit = await call(app, "GET", artifactWebPaths.attachmentSaves(tooMany.slice(1)), world.who.reader);
  assert.equal(atLimit.status, 200);
  assert.deepEqual(atLimit.body, { saves: [] });
});

limitedTest("attachment-saves and share-audience have their own per-user limits", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const saves = artifactWebPaths.attachmentSaves([randomUUID()]);
  assert.equal((await call(app, "GET", saves, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", saves, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", saves, world.who.reader)).status, 429);
  const audience = artifactWebPaths.shareAudience(id(world.page), { conversationId: asChannelId(world.team.id) });
  assert.equal((await call(app, "GET", audience, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", audience, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", audience, world.who.reader)).status, 429);
});

// ---- the original message --------------------------------------------------------

const originAs = async (app: { baseUrl: string }, item: { id: string }, who: Who) => {
  const res = await call(app, "GET", artifactWebPaths.viewer(id(item)), who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as ArtifactViewerData).origin;
};
const storedOrigin = async (item: { id: string }) => {
  const [row] = await getDb().select({ messageId: artifactItems.originMessageId, via: artifactItems.originVia }).from(artifactItems).where(eq(artifactItems.id, item.id));
  return row!;
};
const toServerHome = (item: { id: string }) => getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, item.id));

test("origin: saved from an attachment, its message (via attachment), shown only to a reader who can read that message's conversation", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "the report");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "report.md", bytes: Buffer.from("# report") });
  const saved = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const expected = { messageId: message.id, conversationId: world.team.id, via: "attachment" };
  assert.deepEqual((saved.body as ArtifactWebSaved).artifact.origin, expected);
  const item = { id: (saved.body as ArtifactWebSaved).artifact.card.id };
  assert.deepEqual(await originAs(app, item, world.who.owner), expected);

  // Widened to the server: the outsider (a member, not in the private #team) now sees the Artifact, never where it came from.
  assert.equal(world.team.type, "private");
  await toServerHome(item);
  assert.equal(await originAs(app, item, world.who.outsider), null);
  assert.deepEqual(await originAs(app, item, world.who.reader), expected, "the home moved; the origin didn't");
});

test("origin: a reply in a thread names the thread's conversation and its root message", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const root = await createMessage(world.team.id, "user", world.owner.id, "root");
  const thread = await getOrCreateThread(root.id, world.owner.id, "user");
  const reply = await createMessage(thread.id, "user", world.owner.id, "a reply with a file");
  const attachment = await postAttachment(world, { channelId: thread.id, messageId: reply.id, uploaderId: world.owner.id, filename: "notes.txt", bytes: Buffer.from("notes") });
  const saved = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.artifact.origin, { messageId: reply.id, conversationId: world.team.id, threadRootId: root.id, via: "attachment" });
});

test("origin: an Artifact without one takes the message its first share posts (via share); a second share and a replayed one never change it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  assert.equal(await originAs(app, world.page, world.who.reader), null, "published, never shared");
  const firstInput = shareInput(world.team.id, { note: "first" });
  const first = await call(app, "POST", path, world.who.reader, firstInput);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const expected = { messageId: first.body.messageId, conversationId: world.team.id, via: "share" };
  assert.deepEqual(await originAs(app, world.page, world.who.owner), expected);

  // Another share, by someone else, elsewhere: the origin stays.
  const second = await call(app, "POST", path, world.who.owner, shareInput(world.open.id, { note: "second" }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.messageId, first.body.messageId);
  assert.deepEqual(await originAs(app, world.page, world.who.owner), expected);

  // A replay posts nothing, so it sets nothing: even with no origin it leaves none.
  await getDb().update(artifactItems).set({ originMessageId: null, originVia: null }).where(eq(artifactItems.id, world.page.id));
  const replay = await call(app, "POST", path, world.who.reader, firstInput);
  assert.equal(replay.body.messageId, first.body.messageId);
  assert.deepEqual(await storedOrigin(world.page), { messageId: null, via: null });
  // A new attempt then does.
  const third = await call(app, "POST", path, world.who.reader, shareInput(world.team.id, { note: "third" }));
  assert.deepEqual(await storedOrigin(world.page), { messageId: third.body.messageId, via: "share" });
});

test("origin: an Artifact saved from an attachment and then shared keeps the attachment's message", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "the file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "a.txt", bytes: Buffer.from("a") });
  const saved = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  const item = { id: saved.body.artifact.card.id as string };
  const shared = await call(app, "POST", artifactWebPaths.share(id(item)), world.who.reader, shareInput(world.team.id, { note: "look" }));
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.deepEqual(await originAs(app, item, world.who.reader), { messageId: message.id, conversationId: world.team.id, via: "attachment" });
});

test("origin: a deleted message is no origin, and the Artifact never takes another one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const path = artifactWebPaths.share(id(world.page));
  const first = await call(app, "POST", path, world.who.reader, shareInput(world.team.id));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Retracted (core's soft delete): not shown.
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, first.body.messageId));
  assert.equal(await originAs(app, world.page, world.who.reader), null);
  // Deleted outright: the delete goes through (no foreign key), the id stays as it was, and is never shown.
  await getDb().delete(messages).where(eq(messages.id, first.body.messageId));
  assert.deepEqual(await storedOrigin(world.page), { messageId: first.body.messageId, via: "share" });
  assert.equal(await originAs(app, world.page, world.who.reader), null);
  // A later share doesn't make its message the origin: it was set once.
  assert.equal((await call(app, "POST", path, world.who.reader, shareInput(world.team.id))).status, 200);
  assert.deepEqual(await storedOrigin(world.page), { messageId: first.body.messageId, via: "share" });
  assert.equal(await originAs(app, world.page, world.who.reader), null);
});

test("origin: a public Artifact names it to no one outside its server: not signed out, not to another server's reader", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const message = await createMessage(world.team.id, "user", world.owner.id, "private file");
  const attachment = await postAttachment(world, { channelId: world.team.id, messageId: message.id, uploaderId: world.owner.id, filename: "page.html", bytes: Buffer.from("<h1>hi</h1>") });
  const saved = await call(app, "POST", artifactWebPaths.saveAttachment(), world.who.reader, { attachmentId: attachment.id });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const item = { id: saved.body.artifact.card.id as string };
  await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, item.id));

  // Signed out: the public view has no such field and names neither the message nor its conversation.
  const res = await fetch(`${app.baseUrl}${artifactPublicPaths.view(id(item))}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal("origin" in JSON.parse(text), false);
  for (const secret of [message.id, world.team.id, world.team.name]) assert.ok(!text.includes(secret), secret);

  // Another server's member reads it, without its origin.
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  assert.equal(await originAs(app, item, { token: await accessTokenForTest(peerUser.id), serverId: peer.id }), null);
  // The outsider of its own server, not in the private #team: none either; a member of #team: the message.
  assert.equal(await originAs(app, item, world.who.outsider), null);
  assert.deepEqual(await originAs(app, item, world.who.reader), { messageId: message.id, conversationId: world.team.id, via: "attachment" });
});

test("origin: a message behind the plan's history window is not shown", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const shared = await call(app, "POST", artifactWebPaths.share(id(world.page)), world.who.reader, shareInput(world.team.id));
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${shared.body.messageId}::uuid`);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, world.server.id));
  assert.equal(await originAs(app, world.page, world.who.reader), null);
  // On Pro (all history) it is.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  assert.deepEqual(await originAs(app, world.page, world.who.reader), { messageId: shared.body.messageId, conversationId: world.team.id, via: "share" });
});
