// An Artifact's original message from a link (`link`, linkOrigin.ts; README
// "Original message"), over HTTP with real user tokens: ordinary messages
// posted through core's send route (`POST /api/messages`, the pipeline that
// tells the app: services/firstPartyAppMessageLinks), then the origin as
// stored and as the web viewer answers it. The first linking message in the
// home conversation (or one of its threads) sets it; a later one, a message
// elsewhere (another channel, a DM that isn't the home), a link in code, and
// an Artifact that already has an attachment's or a share's origin change
// nothing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { artifactLinkId, artifactWebPaths, asArtifactId, asServerId, type ArtifactId, type ArtifactViewerData, type ServerId } from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { accessTokenForTest } from "../../test/integration/credentials";
import { addHuman, createChannel, findOrCreateUserDM, getOrCreateThread } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { drainMessageObjectLinksForTests } from "../../services/firstPartyAppMessageLinks";
import { drainMessageReferencesForTests } from "../../services/messageReferences";
import { referencesOfSource } from "../../services/objectReferences";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions } from "./schema";

const test = createApiTest();

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

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

/** A published Artifact (v1, current) homed in `homeChannelId`, by `authorId`, with no original message. */
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

/**
 * A server (Artifacts on) with #team (private: owner, reader), #open (public:
 * owner, reader) and the owner's DM with the reader. An Artifact `page`
 * homed in #team, one `note` homed in the DM; neither has an original message.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const server = await seed.server({ owner, members: [reader] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const team = await createChannel(server.id, `link-team-${label()}`, undefined, "private");
  const open = await createChannel(server.id, `link-open-${label()}`);
  for (const human of [owner, reader]) {
    await addHuman(team.id, human.id);
    await addHuman(open.id, human.id);
  }
  const dm = await findOrCreateUserDM(server.id, owner.id, reader.id);
  assert.ok(dm);
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const page = await insertArtifact(serverId, r2, team.id, owner.id);
  const note = await insertArtifact(serverId, r2, dm.id, owner.id);
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return { server, owner, reader, team, open, dm, page, note, who: { owner: await as(owner.id), reader: await as(reader.id) } };
}

type Who = { token: string; serverId: string };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : null };
}

/** An ordinary message through core's send route; returns once the apps were told of its links. */
async function post(app: { baseUrl: string }, who: Who, channelId: string, content: string): Promise<string> {
  const res = await call(app, "POST", "/api/messages", who, { channelId, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await drainMessageObjectLinksForTests();
  await drainMessageReferencesForTests();
  return res.body.id as string;
}

const linkOf = (row: { id: string }) => `${getAppUrl()}/artifacts/${artifactLinkId(row.id as ArtifactId)}`;
const storedOrigin = async (item: { id: string }) => {
  const [row] = await getDb().select({ messageId: artifactItems.originMessageId, via: artifactItems.originVia }).from(artifactItems).where(eq(artifactItems.id, item.id));
  return row!;
};
const originAs = async (app: { baseUrl: string }, item: { id: string }, who: Who) => {
  const res = await call(app, "GET", artifactWebPaths.viewer(asArtifactId(item.id)), who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as ArtifactViewerData).origin;
};
const NONE = { messageId: null, via: null };

test("link: the first message in its home conversation that links it is its original message (via link); a later one never changes it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const first = await post(app, world.who.reader, world.team.id, `Here it is: ${linkOf(world.page)}`);
  assert.deepEqual(await storedOrigin(world.page), { messageId: first, via: "link" });
  assert.deepEqual(await originAs(app, world.page, world.who.owner), { messageId: first, conversationId: world.team.id, via: "link" });

  // Another linking message in the home, by someone else, with words this time: the origin stays.
  await post(app, world.who.owner, world.team.id, `[the page](${linkOf(world.page)})`);
  assert.deepEqual(await storedOrigin(world.page), { messageId: first, via: "link" });
  // A link to its pinned version names the same Artifact: still the first.
  await post(app, world.who.owner, world.team.id, `${linkOf(world.page)}/v/1`);
  assert.deepEqual(await storedOrigin(world.page), { messageId: first, via: "link" });
});

test("link: a reply in one of its home conversation's threads counts, named by the thread's root", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const root = await post(app, world.who.owner, world.team.id, "a root without a link");
  const thread = await getOrCreateThread(root, world.owner.id, "user");
  const reply = await post(app, world.who.reader, thread.id, `${linkOf(world.page)} is ready`);
  assert.deepEqual(await storedOrigin(world.page), { messageId: reply, via: "link" });
  assert.deepEqual(await originAs(app, world.page, world.who.reader), { messageId: reply, conversationId: world.team.id, threadRootId: root, via: "link" });
});

test("link: a message in another conversation (another channel, a DM that isn't its home) never sets it, nor a link in code; a DM home takes a link posted in it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await post(app, world.who.owner, world.open.id, `elsewhere: ${linkOf(world.page)}`);
  await post(app, world.who.owner, world.dm.id, `in a DM: ${linkOf(world.page)}`);
  assert.deepEqual(await storedOrigin(world.page), NONE, "never from outside its home");
  await post(app, world.who.owner, world.team.id, `\`${linkOf(world.page)}\`\n\n\`\`\`\n${linkOf(world.page)}\n\`\`\``);
  assert.deepEqual(await storedOrigin(world.page), NONE, "a link in code is no link");
  assert.equal(await originAs(app, world.page, world.who.owner), null);

  // The DM is the note's home: a link posted there is its origin; #team's link to it isn't.
  await post(app, world.who.reader, world.team.id, linkOf(world.note));
  assert.deepEqual(await storedOrigin(world.note), NONE);
  const inDm = await post(app, world.who.reader, world.dm.id, linkOf(world.note));
  assert.deepEqual(await storedOrigin(world.note), { messageId: inDm, via: "link" });
});

test("link: an attachment's or a share's original message is never replaced, and a share's own message stays `share`", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // Shared into its home: the share's message, `share` (the app's own message is not taken as a link).
  const shared = await call(app, "POST", artifactWebPaths.share(asArtifactId(world.page.id)), world.who.reader, {
    conversationId: world.team.id, threadRootId: null, note: "look", widenTo: null, clientKey: randomUUID(),
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  await drainMessageObjectLinksForTests();
  assert.deepEqual(await storedOrigin(world.page), { messageId: shared.body.messageId, via: "share" });
  await post(app, world.who.owner, world.team.id, linkOf(world.page));
  assert.deepEqual(await storedOrigin(world.page), { messageId: shared.body.messageId, via: "share" });

  // Saved from an attachment (its message, `attachment`): a link in its home leaves it.
  const attachmentMessage = await post(app, world.who.owner, world.dm.id, "a file");
  await getDb().update(artifactItems).set({ originMessageId: attachmentMessage, originVia: "attachment" }).where(eq(artifactItems.id, world.note.id));
  await post(app, world.who.reader, world.dm.id, linkOf(world.note));
  assert.deepEqual(await storedOrigin(world.note), { messageId: attachmentMessage, via: "attachment" });
});

test("a sent message's links are its object_references (source `message`, #proj-workspace:#336 step 2), wherever it is; a link in code, or none, none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const targets = async (messageId: string) => (await referencesOfSource(getDb(), "message", messageId)).map((ref) => [ref.kind, ref.id, ref.detail.bare]);
  // Outside the Artifact's home too: a reference isn't an origin, and who may see it is the read's to check.
  const elsewhere = await post(app, world.who.owner, world.open.id, `both: ${linkOf(world.page)} and [the note](${linkOf(world.note)}), the page again ${linkOf(world.page)}/v/1`);
  assert.deepEqual(await targets(elsewhere), [["artifact", world.page.id, true], ["artifact", world.note.id, false]]);
  const inCode = await post(app, world.who.owner, world.team.id, `\`${linkOf(world.page)}\``);
  assert.deepEqual(await targets(inCode), []);
  const plain = await post(app, world.who.owner, world.team.id, "nothing linked");
  assert.deepEqual(await targets(plain), []);
});
