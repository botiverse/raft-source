// What links to an Artifact, for the reader who asks ("Linked from",
// backlinks.ts; core's services/messageBacklinks.ts; #proj-workspace:#336
// step 2, part A2), over HTTP at the path the shared contract builds
// (artifactWebPaths.backlinks) with real user tokens. The references are
// core's object_references rows as the writers leave them (an Artifact's
// current version's: platform/references replaceReferences; a message's:
// services/messageReferences writeMessageReferences). Proves: the target
// read as the viewer reads it (one it can't see is the one 404); `documents`
// only the other live Artifacts with a published current version the reader
// sees, never the target itself, newest current version first, as cards with
// the live title, the count after the same filter; `discussions` only the
// messages the reader can read (not a private channel's it isn't in, not a
// retracted one), where it reads them (a thread's reply by its parent
// conversation and root), with the text's excerpt now, the count after the
// same filter; a row whose message was edited away from the link left off
// the page (counted only while the text still names a Raft host: the known
// limit); a reader outside the Artifact's server told of no messages; the
// count capped at ARTIFACT_BACKLINKS_COUNT_CAP and the page at
// ARTIFACT_BACKLINKS_PAGE_LIMIT; a constant number of queries however many
// links; `private, no-store`; and its own per-user limit.
//
// The agent read's `linkedFrom` (`raft artifact read`'s "Linked from", PR-C:
// backlinks.ts agentLinkedFromOf), over the agent API with real agent
// credentials: the same groups with the agent as the viewer (not a private
// channel's Artifact or message it isn't in), the newest
// AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN of each; a message by the
// conversation as the agent names it (`#channel`, a thread's reply by
// `#channel:<root short id>`, `dm:@peer`) and its sender's handle; an agent
// outside the Artifact's server told of no messages; constant queries.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN,
  ARTIFACT_BACKLINKS_COUNT_CAP,
  ARTIFACT_BACKLINKS_PAGE_LIMIT,
  artifactLinkId,
  artifactWebPaths,
  asArtifactId,
  asServerId,
  type ArtifactBacklinkMessage,
  type ArtifactCard,
  type ArtifactId,
  type ArtifactWebBacklinks,
  type AgentApiArtifactLinkedFrom,
  type AgentApiArtifactReadResponse,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { messages, objectReferences } from "../../db/schema";
import { replaceReferences } from "../../platform/references";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM, getOrCreateThread } from "../../services/channelService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { drainMessageReferencesForTests, writeMessageReferences } from "../../services/messageReferences";
import { createMessage } from "../../services/messageService";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setAgentLinkedFromFailsForTests, createBacklinkOperations } from "./backlinks";
import { createArtifactAgentApi } from "./routes";
import { artifactItems, artifactVersions } from "./schema";
import { webNotVisible } from "./webCommon";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.backlinks": 2 } });

// Agent keys verify by HMAC, not argon2 (as routes.api.test.ts).
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-backlinks-tests-hmac-secret-0123456789");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // A message's references are written on a later tick: none left running into the next test.
  await drainMessageReferencesForTests();
});

const label = () => randomUUID().slice(0, 8);
/** The one 404 every route answers for an Artifact the reader can't open (webCommon webNotVisible). */
const NOT_VISIBLE = webNotVisible().body;
/** A link to an Artifact on the canonical app host (every deployment's), in the short form Raft builds. */
const linkTo = (id: string) => `https://app.raft.build/artifacts/${artifactLinkId(asArtifactId(id))}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

type Who = { token: string; serverId: string };
type Reply = { status: number; headers: Headers; body: any };

async function web(app: { baseUrl: string }, path: string, who: Who): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const backlinksAs = (app: { baseUrl: string }, who: Who, id: ArtifactId) => web(app, artifactWebPaths.backlinks(id), who);

/**
 * A server with Artifacts on: #pub (public: owner, reader), #secret (private:
 * owner only); a peer server whose only member is peerUser.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const server = await seed.server({ owner, members: [reader] });
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const pub = await createChannel(server.id, `backlinks-pub-${label()}`);
  const secret = await createChannel(server.id, `backlinks-secret-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(pub.id, human.id);
  await addHuman(secret.id, owner.id);
  const as = async (userId: string, serverId: string = server.id): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId });
  return {
    server, peer, owner, reader, peerUser, pub, secret,
    who: { owner: await as(owner.id), reader: await as(reader.id), peerUser: await as(peerUser.id, peer.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** An Artifact homed in `channelId` with one published version (v1, current) published at `at`: written straight to its tables. */
async function insertArtifact(world: World, channelId: string, at: Date = new Date()): Promise<ArtifactId> {
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id, serverId: asServerId(world.server.id), urlKey: id, name: `bl-${label()}`, title: `Doc ${id.slice(3, 11)}`,
    homeKind: "conversation", homeChannelId: channelId, createdByType: "user", createdById: world.owner.id,
  });
  const versionId = `v_${randomUUID()}`;
  await getDb().insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.md", fileCount: 1, sizeBytes: 1,
    publishDigest: "digest", status: "published", publisherType: "user", publisherId: world.owner.id, position: 1, createdAt: at,
  });
  await getDb().update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id));
  return asArtifactId(id);
}

/** `source`'s current version links `targets` (the rows a push leaves: references.ts). */
async function linksFrom(world: World, source: string, targets: readonly string[]) {
  await replaceReferences(getDb(), { serverId: asServerId(world.server.id), kind: "artifact", id: source }, targets.map((target) => ({
    kind: "artifact", id: target, detail: { href: linkTo(target), path: "index.md", bare: true, version: null },
  })));
}

/** A chat message in `channelId` by the owner at `at`, its references written as a send writes them; its id. */
async function say(world: World, channelId: string, content: string, at: Date): Promise<string> {
  const message = await createMessage(channelId, "user", world.owner.id, content);
  await getDb().update(messages).set({ createdAt: at }).where(eq(messages.id, message.id));
  assert.equal(await writeMessageReferences(message.id, content), "written");
  return message.id;
}

const cardIds = (group: ArtifactWebBacklinks["documents"]) => group.items.map((card: ArtifactCard) => card.id);
const messageIds = (group: ArtifactWebBacklinks["discussions"]) => group.items.map((message: ArtifactBacklinkMessage) => message.messageId);

test("a target the reader can't see is the one 404, the same as one that doesn't exist; a readable one answers private, no-store", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const hidden = await insertArtifact(world, world.secret.id);
  const refused = await backlinksAs(app, world.who.reader, hidden);
  assert.equal(refused.status, 404);
  assert.deepEqual(refused.body, NOT_VISIBLE);
  const missing = await backlinksAs(app, world.who.reader, asArtifactId(`pt_${randomUUID()}`));
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, NOT_VISIBLE);
  const own = await backlinksAs(app, world.who.owner, hidden);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(own.body, {
    documents: { items: [], total: 0, capped: false },
    discussions: { items: [], total: 0, capped: false },
  } satisfies ArtifactWebBacklinks);
});

test("documents: other live Artifacts whose current version links it, only those the reader sees (listed and counted), never itself, newest version first, with the live title", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = await insertArtifact(world, world.pub.id);
  const older = await insertArtifact(world, world.pub.id, minutesAgo(30));
  const newer = await insertArtifact(world, world.pub.id, minutesAgo(10));
  const secret = await insertArtifact(world, world.secret.id, minutesAgo(5));
  const gone = await insertArtifact(world, world.pub.id, minutesAgo(1));
  const unrelated = await insertArtifact(world, world.pub.id, minutesAgo(2));
  for (const source of [older, newer, secret, gone]) await linksFrom(world, source, [target]);
  await linksFrom(world, unrelated, [older]);
  // The target names itself too (rows a push could leave): never a backlink of its own.
  await linksFrom(world, target, [target, older]);
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, gone));
  await getDb().update(artifactItems).set({ title: "Renamed since" }).where(eq(artifactItems.id, newer));

  const asReader = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.deepEqual(cardIds(asReader.documents), [newer, older], "the private channel's and the deleted one left out; newest version first");
  assert.equal(asReader.documents.total, 2, "counted after the reader's filter");
  assert.equal(asReader.documents.capped, false);
  assert.equal(asReader.documents.items[0]!.title, "Renamed since", "the live title");
  assert.equal(asReader.documents.items[0]!.version, 1);

  const asOwner = (await backlinksAs(app, world.who.owner, target)).body as ArtifactWebBacklinks;
  assert.deepEqual(cardIds(asOwner.documents), [secret, newer, older]);
  assert.equal(asOwner.documents.total, 3);

  // A source whose current version isn't readable (revoked) has no card: not listed, not counted.
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.itemId, newer));
  const afterRevoke = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.deepEqual(cardIds(afterRevoke.documents), [older]);
  assert.equal(afterRevoke.documents.total, 1);
});

test("discussions: the messages the reader can read (not a private channel's, not a retracted one), where it reads them, with the text's excerpt now; a row edited away from the link isn't listed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = await insertArtifact(world, world.pub.id);
  const other = await insertArtifact(world, world.pub.id);
  const inPubAt = minutesAgo(50);
  const inPub = await say(world, world.pub.id, `Plan: [the target](${linkTo(target)}) is **ready**`, inPubAt);
  const root = (await createMessage(world.pub.id, "user", world.owner.id, "a thread starts here")).id;
  const thread = await getOrCreateThread(root, world.owner.id, "user");
  const reply = await say(world, thread.id, `in the thread: ${linkTo(target)}`, minutesAgo(40));
  const inSecret = await say(world, world.secret.id, `secret ${linkTo(target)}`, minutesAgo(30));
  const retracted = await say(world, world.pub.id, `retracted ${linkTo(target)}`, minutesAgo(20));
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted));
  // Edited after its rows were written, the new rows' write not (yet) run: one still names a Raft address
  // (counted, the known limit, but never listed), the other none (neither).
  const editedToOther = await say(world, world.pub.id, `see ${linkTo(target)}`, minutesAgo(10));
  await getDb().update(messages).set({ content: `now ${linkTo(other)} instead` }).where(eq(messages.id, editedToOther));
  const editedToNone = await say(world, world.pub.id, `see ${linkTo(target)}`, minutesAgo(5));
  await getDb().update(messages).set({ content: "no link any more" }).where(eq(messages.id, editedToNone));

  const asReader = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.deepEqual(messageIds(asReader.discussions), [reply, inPub], "newest first; the private channel's, the retracted and the edited ones left out");
  assert.equal(asReader.discussions.total, 3, "the edited one still naming a Raft address is counted (known limit); none the reader can't read");
  assert.equal(asReader.discussions.capped, false);
  const [threadReply, plain] = asReader.discussions.items;
  assert.deepEqual(
    { conversationId: threadReply!.conversationId, threadRootId: threadReply!.threadRootId },
    { conversationId: world.pub.id, threadRootId: root },
    "a thread's reply by its parent conversation and the message the thread hangs off",
  );
  assert.deepEqual(plain, {
    messageId: inPub,
    conversationId: world.pub.id,
    author: plain!.author,
    createdAt: inPubAt.toISOString(),
    excerpt: "Plan: the target is ready",
  });
  assert.equal(plain!.threadRootId, undefined);
  assert.equal(plain!.author?.type, "user");
  assert.equal(plain!.author?.id, world.owner.id);

  const asOwner = (await backlinksAs(app, world.who.owner, target)).body as ArtifactWebBacklinks;
  assert.deepEqual(messageIds(asOwner.discussions), [inSecret, reply, inPub]);
  assert.equal(asOwner.discussions.total, 4);

  // An excerpt is the text now, cut on one line.
  const long = await say(world, world.pub.id, `${"word ".repeat(60)}${linkTo(target)}`, minutesAgo(1));
  const withLong = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  const excerpt = withLong.discussions.items.find((message) => message.messageId === long)!.excerpt;
  assert.ok(Array.from(excerpt).length <= 120 && excerpt.endsWith("…") && !excerpt.includes("\n"), excerpt);
});

test("a reader outside the Artifact's server is told of no messages, and of none of its server's Artifacts", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = await insertArtifact(world, world.pub.id);
  await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, target));
  const source = await insertArtifact(world, world.pub.id);
  await linksFrom(world, source, [target]);
  await say(world, world.pub.id, `public one: ${linkTo(target)}`, minutesAgo(1));

  const outside = await backlinksAs(app, world.who.peerUser, target);
  assert.equal(outside.status, 200, JSON.stringify(outside.body));
  assert.deepEqual(outside.body, {
    documents: { items: [], total: 0, capped: false },
    discussions: { items: [], total: 0, capped: false },
  } satisfies ArtifactWebBacklinks);
  const inside = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.equal(inside.documents.total, 1);
  assert.equal(inside.discussions.total, 1);
});

test("the count stops at the cap (`capped`), the page at its limit, newest first", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = await insertArtifact(world, world.pub.id);
  const many = ARTIFACT_BACKLINKS_COUNT_CAP + 1;
  const base = Date.now() - many * 1000;
  // Written straight to the tables (as many sends and their reference writes would leave them).
  const rows = await getDb().insert(messages).values(Array.from({ length: many }, (_, index) => ({
    channelId: world.pub.id, senderType: "user" as const, senderId: world.owner.id,
    content: `#${index} ${linkTo(target)}`, createdAt: new Date(base + index * 1000),
  }))).returning({ id: messages.id, createdAt: messages.createdAt });
  await getDb().insert(objectReferences).values(rows.map((row) => ({
    serverId: world.server.id, sourceKind: "message", sourceId: row.id, position: 0,
    targetKind: "artifact", targetId: target, targetDetail: { href: linkTo(target), bare: true },
  })));
  const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, ARTIFACT_BACKLINKS_PAGE_LIMIT).map((row) => row.id);

  const answer = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.equal(answer.discussions.total, ARTIFACT_BACKLINKS_COUNT_CAP);
  assert.equal(answer.discussions.capped, true);
  assert.deepEqual(messageIds(answer.discussions), newest);

  // Two of them retracted: under the cap, the exact count.
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, rows[0]!.id));
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, rows[1]!.id));
  const under = (await backlinksAs(app, world.who.reader, target)).body as ArtifactWebBacklinks;
  assert.equal(under.discussions.total, ARTIFACT_BACKLINKS_COUNT_CAP - 1);
  assert.equal(under.discussions.capped, false);
});

// ---- the agent read's `linkedFrom` (`raft artifact read`'s "Linked from") ----

/** An agent of `serverId` in `channelIds`, and its key. */
async function agentIn(serverId: string, channelIds: readonly string[]) {
  const agent = await createAgent(serverId, `bl-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  for (const channelId of channelIds) await addAgent(channelId, agent.id);
  const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: `bl-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  return { agent, key };
}

/** `raft artifact read <id>` as the agent with `key`: its `linkedFrom`. */
async function linkedFromAs(app: { baseUrl: string }, key: string, id: ArtifactId): Promise<AgentApiArtifactLinkedFrom | undefined> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.json() as AgentApiArtifactReadResponse;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.linkedFrom;
}

test("agent read: `linkedFrom` lists what links it as the agent sees it, each message where the agent names its conversation, with its sender's handle", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { agent, key } = await agentIn(world.server.id, [world.pub.id]);
  const target = await insertArtifact(world, world.pub.id);
  const source = await insertArtifact(world, world.pub.id, minutesAgo(10));
  const secretSource = await insertArtifact(world, world.secret.id, minutesAgo(5));
  for (const from of [source, secretSource]) await linksFrom(world, from, [target]);
  await getDb().update(artifactItems).set({ title: "Plan \"B\"" }).where(eq(artifactItems.id, source));

  const inPub = await say(world, world.pub.id, `see ${linkTo(target)}`, minutesAgo(50));
  const root = (await createMessage(world.pub.id, "user", world.owner.id, "a thread starts here")).id;
  const thread = await getOrCreateThread(root, world.owner.id, "user");
  const reply = await say(world, thread.id, `in the thread: ${linkTo(target)}`, minutesAgo(40));
  await say(world, world.secret.id, `secret ${linkTo(target)}`, minutesAgo(30));
  const dm = (await findOrCreateDM(world.server.id, world.owner.id, agent.id))!;
  const inDm = await say(world, dm.id, `for you: ${linkTo(target)}`, minutesAgo(20));

  const linkedFrom = await linkedFromAs(app, key, target);
  assert.deepEqual(linkedFrom!.documents, {
    items: [{ id: source, title: "Plan \"B\"" }],
    total: 1,
    capped: false,
  }, "the private channel's Artifact the agent isn't in: not listed, not counted; the live title");
  const author = { type: "user", name: world.owner.name };
  const [inDmShown, ...inChannels] = linkedFrom!.discussions.items;
  // A DM as the agent names it (routes.api.test.ts holds the form: `dm:@<peer>`).
  assert.match(inDmShown!.target, new RegExp(`^dm:@${world.owner.name}`));
  assert.deepEqual({ ...inDmShown, target: undefined }, { target: undefined, messageId: inDm, author });
  assert.deepEqual(inChannels, [
    { target: `#${world.pub.name}:${root.slice(0, 8)}`, messageId: reply, author },
    { target: `#${world.pub.name}`, messageId: inPub, author },
  ], "newest first; a thread's reply by its thread target");
  assert.equal(linkedFrom!.discussions.total, 3, "the private channel's message the agent isn't in: not listed, not counted");
  assert.equal(linkedFrom!.discussions.capped, false);

  // Nothing links another one: both groups empty, the field still there.
  const alone = await insertArtifact(world, world.pub.id);
  assert.deepEqual(await linkedFromAs(app, key, alone), {
    documents: { items: [], total: 0, capped: false },
    discussions: { items: [], total: 0, capped: false },
  });
});

test("agent read: `linkedFrom` lists the newest few of each group and counts them all; an agent outside the Artifact's server is told of no messages", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { key } = await agentIn(world.server.id, [world.pub.id]);
  const target = await insertArtifact(world, world.pub.id);
  const many = AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN + 2;
  const sources: string[] = [];
  const said: string[] = [];
  for (let index = 0; index < many; index++) {
    const from = await insertArtifact(world, world.pub.id, minutesAgo(index + 1));
    await linksFrom(world, from, [target]);
    sources.push(from);
    said.push(await say(world, world.pub.id, `#${index} ${linkTo(target)}`, minutesAgo(index + 1)));
  }
  const linkedFrom = (await linkedFromAs(app, key, target))!;
  assert.deepEqual(linkedFrom.documents.items.map((document) => document.id), sources.slice(0, AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN));
  assert.equal(linkedFrom.documents.total, many);
  assert.deepEqual(linkedFrom.discussions.items.map((message) => message.messageId), said.slice(0, AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN));
  assert.equal(linkedFrom.discussions.total, many);

  // A public Artifact read by another server's agent: no messages of this server, none of its Artifacts it can't see.
  await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, target));
  const outsider = await agentIn(world.peer.id, []);
  assert.deepEqual(await linkedFromAs(app, outsider.key, target), {
    documents: { items: [], total: 0, capped: false },
    discussions: { items: [], total: 0, capped: false },
  });
});

test("agent read: a \"Linked from\" lookup that fails leaves the field out, and the read still answers 200 (Tenny on #15753)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { key } = await agentIn(world.server.id, [world.pub.id]);
  const target = await insertArtifact(world, world.pub.id);
  const source = await insertArtifact(world, world.pub.id, minutesAgo(1));
  await linksFrom(world, source, [target]);
  __setAgentLinkedFromFailsForTests(true);
  try {
    // linkedFromAs asserts the 200.
    assert.equal(await linkedFromAs(app, key, target), undefined);
  } finally {
    __setAgentLinkedFromFailsForTests(false);
  }
  assert.equal((await linkedFromAs(app, key, target))?.documents.total, 1);
});

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as links.api.test.ts). */
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

test("a constant number of queries however many links", async ({ seed }) => {
  const world = await seedWorld(seed);
  const reader = { userId: world.reader.id, serverId: asServerId(world.server.id), sessionFamilyId: null };
  const answerFor = async (count: number) => {
    const target = await insertArtifact(world, world.pub.id);
    for (let index = 0; index < count; index++) {
      await linksFrom(world, await insertArtifact(world, world.pub.id, minutesAgo(index + 1)), [target]);
      await say(world, world.pub.id, `#${index} ${linkTo(target)}`, minutesAgo(index + 1));
    }
    // Once first, so a per-process cache a read fills (a flag's) is filled for both counts alike.
    await createBacklinkOperations().backlinks(reader, target);
    return countQueries(() => createBacklinkOperations().backlinks(reader, target));
  };
  const few = await answerFor(1);
  const more = await answerFor(12);
  const body = (answer: Awaited<ReturnType<typeof answerFor>>) => (answer.value as { body: ArtifactWebBacklinks }).body;
  assert.equal(body(few).documents.total, 1);
  assert.equal(body(few).discussions.total, 1);
  assert.equal(body(more).documents.total, 12);
  assert.equal(body(more).discussions.total, 12);
  assert.equal(more.queries, few.queries, `${few.queries} queries for one link of each, ${more.queries} for twelve`);
});

test("agent read: `linkedFrom` costs a constant number of queries however many links", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { agent } = await agentIn(world.server.id, [world.pub.id]);
  const reader = { agentId: agent.id, serverId: asServerId(world.server.id) };
  const answerFor = async (count: number) => {
    const target = await insertArtifact(world, world.pub.id);
    for (let index = 0; index < count; index++) {
      await linksFrom(world, await insertArtifact(world, world.pub.id, minutesAgo(index + 1)), [target]);
      await say(world, world.pub.id, `#${index} ${linkTo(target)}`, minutesAgo(index + 1));
    }
    // Once first: the first read moves the agent's read position (later reads don't), and fills per-process caches alike.
    await createArtifactAgentApi().read(reader, { artifact: target }, {});
    return countQueries(() => createArtifactAgentApi().read(reader, { artifact: target }, {}));
  };
  const few = await answerFor(1);
  const more = await answerFor(AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN + 2);
  const linkedFrom = (answer: Awaited<ReturnType<typeof answerFor>>) => (answer.value as { body: AgentApiArtifactReadResponse }).body.linkedFrom!;
  assert.equal(linkedFrom(few).documents.total, 1);
  assert.equal(linkedFrom(few).discussions.total, 1);
  assert.equal(linkedFrom(more).documents.items.length, AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN);
  assert.equal(linkedFrom(more).discussions.total, AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN + 2);
  assert.equal(more.queries, few.queries, `${few.queries} queries for one link of each, ${more.queries} for ${AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN + 2}`);
});

limitedTest("the route is limited per user on its own budget (429 RATE_LIMITED past it, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = await insertArtifact(world, world.pub.id);
  assert.equal((await backlinksAs(app, world.who.reader, target)).status, 200);
  assert.equal((await backlinksAs(app, world.who.reader, target)).status, 200);
  const limited = await backlinksAs(app, world.who.reader, target);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await backlinksAs(app, world.who.owner, target)).status, 200, "another user's own budget");
});
