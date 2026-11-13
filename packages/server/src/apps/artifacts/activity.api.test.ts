// People's Activity rows for Artifacts (S6) end to end: events recorded by
// the real write paths (a person's comment on the web, an agent's publish on
// the agent API), read through core's `GET /api/channels/inbox` and
// `GET /api/servers/unread-summary`, acted on through core's
// `/api/objects/activity/*` (services/objectActivity.ts,
// objectActivityInbox.ts), with the app's hooks (activity.ts) and its read
// positions reported back to core (apiCommon reportRead).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  ACTIVITY_CHANGED_EVENT,
  artifactWebPaths,
  asArtifactCommentId,
  asArtifactId,
  asServerId,
  objectActivityWebPaths,
  type ActivityChangedEvent,
  type ObjectInboxItem,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, objectEventRecipients, objectEvents, objectInboxStates, serverMembers, servers } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { setActivityRealtimeIO } from "../../services/activityRealtime";
import { addAgent, addHuman, createChannel, findOrCreateDM, removeHuman } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { objectActivityUnreadBatch } from "../../services/objectActivity";
import { pruneObjectEvents } from "../../services/objectEventRetention";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { forgetArtifactActivity, markArtifactsRead } from "./activity";
import { advanceReadPosition, takesPartIn } from "./apiCommon";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { recordArtifactEvent } from "./events";
import { artifactsApp } from "./register";
import { artifactItems, artifactReadPositions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-activity-tests-hmac-secret-0123456789");
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
    async read() { return null; },
    async presign() { return null; },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any; text: string };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

function setFlag(on: boolean) {
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, on);
}

/**
 * A server (flag on unless `flag: false`) with #room (owner, reader, agent A)
 * and #general (owner, reader); `other` is a member in neither. Agent A
 * publishes `page` (v1) in #room, so A follows it; nobody else does.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }, opts: { flag?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner, members: [reader, other] });
  setFlag(true);
  const agentA = await createAgent(server.id, `act-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const room = await createChannel(server.id, `room-${label()}`, undefined, "private");
  const general = await createChannel(server.id, `general-${label()}`);
  for (const human of [owner, reader]) {
    await addHuman(room.id, human.id);
    await addHuman(general.id, human.id);
  }
  await addAgent(room.id, agentA.id);
  __setArtifactR2StoreForTests(memoryR2());
  const keyA = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `act-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const created = await agentCall(app, "POST", "/artifacts/push", keyA, { target: `#${room.name}`, title: "Plan", files: [{ path: "index.md", content: "# plan v1" }] });
  assert.equal(created.status, 201, created.text);
  const page = asArtifactId(created.body.artifact.id as string);
  if (opts.flag === false) setFlag(false);
  const as = async (userId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return { server, owner, reader, other, agentA, keyA, room, general, page, who: { owner: await as(owner.id), reader: await as(reader.id), other: await as(other.id) } };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const text = (value: string) => ({ type: "text" as const, text: value });
const mention = (user: { id: string }) => ({ type: "mention" as const, actor: { type: "user" as const, id: user.id } });

async function comment(app: { baseUrl: string }, world: World, who: Who, body: unknown[], version = 1, page = world.page): Promise<string> {
  const res = await call(app, "POST", artifactWebPaths.comments(page), who, { body, version, target: { scope: "artifact" }, replyTo: null });
  assert.equal(res.status, 201, res.text);
  return res.body.comment.id as string;
}

async function publishVersion(app: { baseUrl: string }, world: World, base: number, content: string) {
  const publish = () => agentCall(app, "POST", "/artifacts/push", world.keyA, { artifact: world.page, base, files: [{ path: "index.md", content }] });
  let res = await publish();
  // Held for comments the agent hasn't seen in full: as the hold says, it lists them (which marks
  // them seen, page by page), then the same request goes through. A notice never marks anything seen.
  for (let attempt = 0; attempt < 5 && res.status === 409 && res.body?.code === "UNSEEN_CHANGES"; attempt += 1) {
    assert.equal((await agentCall(app, "GET", `/artifacts/${world.page}/comments`, world.keyA)).status, 200);
    res = await publish();
  }
  assert.equal(res.status, 201, res.text);
}

async function inbox(app: { baseUrl: string }, who: Who, params: Record<string, string> = {}): Promise<Reply> {
  const query = new URLSearchParams({ filter: "all", limit: "100", ...params });
  const res = await call(app, "GET", `/api/channels/inbox?${query}`, who);
  assert.equal(res.status, 200, res.text);
  return res;
}
const objectRows = (body: { items: Array<{ kind: string }> }) => body.items.filter((item): item is ObjectInboxItem => item.kind === "object");

async function summaryEntry(app: { baseUrl: string }, who: Who): Promise<Record<string, unknown>> {
  const res = await call(app, "GET", "/api/servers/unread-summary", who);
  assert.equal(res.status, 200, res.text);
  const entry = (res.body as Array<Record<string, unknown>>).find((row) => row.serverId === who.serverId);
  assert.ok(entry);
  return entry;
}

/** The inbox's object counts, the rows', and the badge's, which must agree. */
async function assertAgree(app: { baseUrl: string }, who: Who): Promise<number> {
  const all = await inbox(app, who);
  const rows = objectRows(all.body);
  const unreadRows = rows.filter((row) => row.unreadCount > 0).length;
  assert.equal(all.body.objectUnreadCount, unreadRows, "objectUnreadCount = the unread object rows");
  assert.equal(all.body.objectCount, rows.length, "objectCount = the object rows");
  const mentionRows = objectRows((await inbox(app, who, { filter: "mentions" })).body);
  assert.equal(all.body.objectMentionUnreadCount, mentionRows.filter((row) => row.unreadCount > 0).length, "objectMentionUnreadCount = the unread rows Mentions lists");
  // Pagination doesn't change it.
  assert.equal((await inbox(app, who, { limit: "1" })).body.objectUnreadCount, unreadRows);
  assert.equal((await summaryEntry(app, who)).activityObjectUnreadCount, unreadRows, "the badge = the list");
  return unreadRows;
}

// ---- rows ---------------------------------------------------------------------------

test("a mention, a comment on what one follows and a new version each give the person one row; agents get none", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0, "nothing yet: the reader neither follows nor was mentioned");

  // (a) a mention.
  const first = await comment(app, world, world.who.owner, [text("look "), mention(world.reader), text(" at\nthis")]);
  let rows = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(rows.length, 1);
  let row = rows[0]!;
  assert.equal(row.objectKind, "artifact");
  assert.equal(row.objectId, world.page);
  assert.equal(row.latestEvent.eventKind, "comment");
  assert.equal(row.latestEvent.reason, "mentioned");
  assert.deepEqual(row.latestEvent.actor, { type: "user", id: world.owner.id, name: world.owner.name });
  assert.equal(row.unreadCount, 1);
  assert.equal(row.hasMention, true);
  assert.equal(row.isFollowing, false);
  assert.deepEqual(row.home, { kind: "channel", label: world.room.name, channelId: world.room.id });
  assert.deepEqual(row.target, { version: 1, comment: first });
  assert.equal(row.preview?.text, `look @${world.reader.name} at this`);
  assert.equal(row.preview?.author.id, world.owner.id);
  assert.equal((row.summary as { title: string } | null)?.title, "Plan");
  assert.equal(row.lastActivityAt, row.latestEvent.at);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  // The owner made the event: no row for them; the agent author follows and is a recipient, but agents get no rows.
  assert.equal(objectRows((await inbox(app, world.who.owner)).body).length, 0);
  const agentRows = await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.userId, world.agentA.id));
  assert.equal(agentRows.length, 0, "agent recipients never get Activity rows");

  // (b) a comment on an Artifact the reader follows.
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 0, "starting to follow reads everything up to now (v1 and the mention)");
  const second = await comment(app, world, world.who.owner, [text("second")]);
  row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.latestEvent.reason, "following");
  assert.equal(row.isFollowing, true);
  // While following: every version and comment by others after the read position, which following moved to then.
  assert.equal(row.unreadCount, 1, "the comment since following");
  assert.equal(row.hasMention, false, "the mention was read when following started");
  assert.deepEqual(row.target, { version: 1, comment: second });
  assert.equal(row.preview?.text, "second");

  // (c) a new version.
  await publishVersion(app, world, 1, "# plan v2");
  rows = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(rows.length, 1, "one row per object");
  row = rows[0]!;
  assert.equal(row.latestEvent.eventKind, "version");
  assert.equal(row.latestEvent.reason, "following");
  assert.equal(row.latestEvent.actor.type, "agent");
  assert.deepEqual(row.target, { version: 2 });
  assert.equal(row.unreadCount, 2, "the comment and v2");
  assert.equal(row.preview?.text, "second", "the newest unread comment");
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

test("a DM home is labelled as the sidebar labels the DM: the peer's handle, plus its display name when it has one", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const dm = (await findOrCreateDM(world.server.id, world.reader.id, world.agentA.id))!;
  const created = await agentCall(app, "POST", "/artifacts/push", world.keyA, { target: `dm:@${world.reader.name}`, title: "Note", files: [{ path: "note.md", content: "# note" }] });
  assert.equal(created.status, 201, created.text);
  const note = created.body.artifact.id as string;
  const said = await agentCall(app, "POST", `/artifacts/${note}/comments`, world.keyA, { body: `@${world.reader.name} have a look` });
  assert.equal(said.status, 201, said.text);
  const homeOf = async () => objectRows((await inbox(app, world.who.reader)).body).find((row) => row.objectId === note)!.home;
  // No display name: the handle, and no peerDisplayName (older clients read `label` as before).
  await getDb().update(agents).set({ displayName: null }).where(eq(agents.id, world.agentA.id));
  assert.deepEqual(await homeOf(), { kind: "dm", label: world.agentA.name, channelId: dm.id });
  await getDb().update(agents).set({ displayName: "Agent Alpha" }).where(eq(agents.id, world.agentA.id));
  assert.deepEqual(await homeOf(), { kind: "dm", label: world.agentA.name, channelId: dm.id, peerDisplayName: "Agent Alpha" });
});

test("only objects the person can see now: a row goes when its home does, and comes back", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" ping")]);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 1);
  await removeHuman(world.room.id, world.reader.id, { self: true });
  const gone = await inbox(app, world.who.reader);
  assert.equal(objectRows(gone.body).length, 0);
  assert.equal(gone.body.objectUnreadCount, 0);
  assert.equal(gone.body.objectCount, 0);
  assert.equal((await summaryEntry(app, world.who.reader)).activityObjectUnreadCount, 0);
  // And no Done or read of it either.
  for (const path of [objectActivityWebPaths.done(), objectActivityWebPaths.read(), objectActivityWebPaths.undone()]) {
    const res = await call(app, "POST", path, world.who.reader, { kind: "artifact", objectId: world.page });
    assert.equal(res.status, 404, path);
    assert.equal(res.body.code, "NOT_FOUND");
  }
  await addHuman(world.room.id, world.reader.id);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 1);
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

test("rows are ordered and paged with conversation rows by time", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const post = async (channelId: string, content: string) => {
    const res = await call(app, "POST", "/api/messages", world.who.owner, { channelId, content });
    assert.equal(res.status, 200, res.text);
  };
  await post(world.general.id, "older message");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" in between")]);
  await post(world.room.id, "newer message");
  const keyOf = (item: { kind: string; channelId?: string; objectId?: string }) => (item.kind === "object" ? `object:${item.objectId}` : `${item.kind}:${item.channelId}`);
  const all = (await inbox(app, world.who.reader)).body;
  const expected = [`channel:${world.room.id}`, `object:${world.page}`, `channel:${world.general.id}`];
  assert.deepEqual(all.items.map(keyOf), expected);
  assert.equal(all.hasMore, false);
  const paged: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const page = (await inbox(app, world.who.reader, { limit: "1", offset: String(offset) })).body;
    paged.push(...page.items.map(keyOf));
    assert.equal(page.hasMore, offset < 2, `hasMore at offset ${offset}`);
  }
  assert.deepEqual(paged, expected);
  const ascending = (await inbox(app, world.who.reader, { sort: "asc" })).body;
  assert.deepEqual(ascending.items.map(keyOf), [...expected].reverse());
  // The filters: unread and mentions list it, a channel or a search does not.
  assert.equal(objectRows((await inbox(app, world.who.reader, { filter: "unread" })).body).length, 1);
  assert.equal(objectRows((await inbox(app, world.who.reader, { filter: "unread_mentions" })).body).length, 1);
  assert.equal(objectRows((await inbox(app, world.who.reader, { channelId: world.room.id })).body).length, 0);
});

test("the Artifacts filter (scope=artifacts) lists Artifact rows only, paged, with their counts; none for a search or a channel", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const post = async (channelId: string, content: string) => {
    const res = await call(app, "POST", "/api/messages", world.who.owner, { channelId, content });
    assert.equal(res.status, 200, res.text);
  };
  await post(world.general.id, "a message, not an Artifact");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" only this one")]);
  await post(world.room.id, "another message");
  const scoped = (await inbox(app, world.who.reader, { scope: "artifacts" })).body;
  assert.deepEqual(scoped.items.map((item: { kind: string }) => item.kind), ["object"], "no conversation rows");
  assert.equal((scoped.items[0] as ObjectInboxItem).objectId, world.page);
  assert.equal(scoped.hasMore, false);
  assert.equal(scoped.objectCount, 1);
  assert.equal(scoped.objectUnreadCount, 1);
  assert.equal(scoped.objectMentionUnreadCount, 1);
  assert.equal(scoped.totalCount, 0, "the conversation counts are this list's: none");
  // The read filters apply within it.
  assert.equal((await inbox(app, world.who.reader, { scope: "artifacts", filter: "mentions" })).body.items.length, 1);
  // Paged: one row, then none.
  assert.equal((await inbox(app, world.who.reader, { scope: "artifacts", limit: "1", offset: "1" })).body.items.length, 0);
  // Object rows aren't searched or listed per channel.
  assert.equal((await inbox(app, world.who.reader, { scope: "artifacts", q: "only" })).body.items.length, 0);
  assert.equal((await inbox(app, world.who.reader, { scope: "artifacts", channelId: world.room.id })).body.items.length, 0);
  // The unscoped list is unchanged: both kinds, the cache kept apart.
  assert.equal((await inbox(app, world.who.reader)).body.items.length, 3);
  assert.equal((await inbox(app, world.who.reader, { scope: "artifacts" })).body.items.length, 1);
});

test("the existing counts never include object rows; the new ones agree with the rows and the badge", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const res = await call(app, "POST", "/api/messages", world.who.owner, { channelId: world.general.id, content: "hello" });
  assert.equal(res.status, 200);
  const before = (await inbox(app, world.who.reader)).body;
  const beforeEntry = await summaryEntry(app, world.who.reader);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" one")]);
  await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader);
  await comment(app, world, world.who.owner, [text("two")]);
  const after = (await inbox(app, world.who.reader)).body;
  for (const field of ["totalCount", "totalUnreadCount", "activeUnreadCount"]) assert.equal(after[field], before[field], field);
  const afterEntry = await summaryEntry(app, world.who.reader);
  assert.equal(afterEntry.activityUnreadCount, beforeEntry.activityUnreadCount);
  assert.equal(afterEntry.unreadCount, beforeEntry.unreadCount);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  assert.equal(objectRows(after)[0]!.unreadCount, 1, "the comment since following (which read the mention)");
});

test("objectMentionUnreadCount counts the unread rows the Mentions filter lists, with mixed reasons, whatever the filter", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const publish = async (title: string) => {
    const created = await agentCall(app, "POST", "/artifacts/push", world.keyA, { target: `#${world.room.name}`, title, files: [{ path: "index.md", content: `# ${title}` }] });
    assert.equal(created.status, 201, created.text);
    return asArtifactId(created.body.artifact.id as string);
  };
  const act = async (path: string, objectId: string) => assert.equal((await call(app, "POST", path, world.who.reader, { kind: "artifact", objectId })).status, 200, path);
  // An unread mention.
  const mentioned = world.page;
  await comment(app, world, world.who.owner, [mention(world.reader), text(" unread mention")], 1, mentioned);
  // A mention read, then a comment while following: Mentions lists it, unread, without an unread mention.
  const mentionedThenFollowed = await publish("Followed after a mention");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" read mention")], 1, mentionedThenFollowed);
  await act(objectActivityWebPaths.read(), mentionedThenFollowed);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(mentionedThenFollowed), world.who.reader)).status, 200);
  await comment(app, world, world.who.owner, [text("new since following")], 1, mentionedThenFollowed);
  // Following only: unread, never a mention.
  const followed = await publish("Followed");
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(followed), world.who.reader)).status, 200);
  await comment(app, world, world.who.owner, [text("following only")], 1, followed);
  // A mention read: Mentions lists it, read.
  const readMention = await publish("Read mention");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" read")], 1, readMention);
  await act(objectActivityWebPaths.read(), readMention);
  // A mention Done: listed nowhere.
  const doneMention = await publish("Done mention");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" done")], 1, doneMention);
  await act(objectActivityWebPaths.done(), doneMention);

  const byId = new Map(objectRows((await inbox(app, world.who.reader)).body).map((row) => [row.objectId as string, row]));
  // Witnesses: each row is in the state named above.
  assert.deepEqual([mentioned, mentionedThenFollowed, followed, readMention].map((id) => [byId.get(id)?.unreadCount ?? -1, byId.get(id)?.hasMention]), [[1, true], [1, false], [1, false], [0, false]]);
  assert.equal(byId.has(doneMention), false);
  assert.equal(byId.get(followed)!.latestEvent.reason, "following");
  const mentions = objectRows((await inbox(app, world.who.reader, { filter: "mentions" })).body).map((row) => row.objectId as string).sort();
  assert.deepEqual(mentions, [mentioned, mentionedThenFollowed, readMention].sort(), "Mentions: a mention since Done, read or not");

  for (const filter of ["all", "unread", "mentions", "unread_mentions"]) {
    const body = (await inbox(app, world.who.reader, { filter })).body;
    assert.equal(body.objectUnreadCount, 3, `${filter}: objectUnreadCount, every unread row`);
    assert.equal(body.objectMentionUnreadCount, 2, `${filter}: the unread mention and the row unread since following after its mention; not the following-only, read or Done rows`);
  }
  assert.equal((await inbox(app, world.who.reader, { filter: "unread_mentions" })).body.objectCount, 1, "unread_mentions: only the row with an unread mention");
  // A search or a channel lists no object rows; the person's counts are still there.
  assert.equal((await inbox(app, world.who.reader, { channelId: world.room.id })).body.objectMentionUnreadCount, 2);
  assert.equal(await assertAgree(app, world.who.reader), 3);

  // Reading the unread mention takes it out; mark all read leaves none.
  await act(objectActivityWebPaths.read(), mentioned);
  assert.equal((await inbox(app, world.who.reader, { filter: "mentions" })).body.objectMentionUnreadCount, 1);
  assert.equal((await call(app, "POST", "/api/channels/inbox/read-all", world.who.reader)).status, 200);
  assert.equal((await inbox(app, world.who.reader)).body.objectMentionUnreadCount, 0);
  assert.equal(await assertAgree(app, world.who.reader), 0);
});

// ---- Done, read, unfollow ---------------------------------------------------------

test("Done hides the row until a newer event, reading what it showed; undo shows it again", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader);
  await comment(app, world, world.who.owner, [text("one")]);
  await comment(app, world, world.who.owner, [text("two")]);
  const row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 2, "both comments since following");
  const beyond = await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: String(Number(row.doneFrontierSeq) + 1) });
  assert.equal(beyond.status, 409);
  assert.equal(beyond.body.code, "DONE_FRONTIER_BEYOND_LATEST");
  const done = await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: row.doneFrontierSeq });
  assert.equal(done.status, 200, done.text);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  assert.equal(await assertAgree(app, world.who.reader), 0);
  // Undo: it shows again, read.
  assert.equal((await call(app, "POST", objectActivityWebPaths.undone(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  let shown = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.unreadCount, 0, "Done read what it showed");
  await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page });
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  // A newer event brings it back, with only what is new.
  await comment(app, world, world.who.owner, [text("three")]);
  shown = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.unreadCount, 1);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  // Refusals.
  assert.equal((await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "nope", objectId: world.page })).body.code, "UNKNOWN_OBJECT_KIND");
  assert.equal((await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact" })).body.code, "INVALID_REQUEST");
  assert.equal((await call(app, "POST", objectActivityWebPaths.done(), world.who.other, { kind: "artifact", objectId: world.page })).body.code, "NOT_FOUND");
});

// #triage:#157: a read seen on screen covers what the row showed when it was seen; a
// later event (a comment, a new version) stays unread.
test("read through the row's frontier reads up to that event, not what came after", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader);
  await comment(app, world, world.who.owner, [text("one")]);
  const seen = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  await comment(app, world, world.who.owner, [text("two")]);
  const beyond = await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: String(Number(objectRows((await inbox(app, world.who.reader)).body)[0]!.doneFrontierSeq) + 1) });
  assert.equal(beyond.status, 409);
  assert.equal(beyond.body.code, "DONE_FRONTIER_BEYOND_LATEST");
  const read = await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: seen.doneFrontierSeq });
  assert.equal(read.status, 200, read.text);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body)[0]!.unreadCount, 1, "the comment after what was seen stays unread");
  assert.equal(await assertAgree(app, world.who.reader), 1);
  assert.equal((await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: "x" })).body.code, "INVALID_REQUEST");
  // A frontier before the first event reads nothing, not everything.
  assert.equal((await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page, throughSeq: "0" })).status, 200);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body)[0]!.unreadCount, 1);
});

test("mark read, opening the Artifact and mark all read clear unread; the row stays in All", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" hi")]);
  assert.equal((await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  let row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 0);
  assert.equal(row.hasMention, false);
  assert.equal(objectRows((await inbox(app, world.who.reader, { filter: "unread" })).body).length, 0);
  assert.equal(objectRows((await inbox(app, world.who.reader, { filter: "mentions" })).body).length, 1, "mentions: a mention since Done, read or not");
  assert.equal(await assertAgree(app, world.who.reader), 0);

  await comment(app, world, world.who.owner, [mention(world.reader), text(" again")]);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(world.page), world.who.reader)).status, 200);
  row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 0, "opening the current version reads it");
  assert.equal(await assertAgree(app, world.who.reader), 0);

  await comment(app, world, world.who.owner, [mention(world.reader), text(" thrice")]);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  assert.equal((await call(app, "POST", "/api/channels/inbox/read-all", world.who.reader)).status, 200);
  assert.equal(await assertAgree(app, world.who.reader), 0);
});

test("after unfollowing, comments and versions no longer reach the person; mentions still do", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  assert.equal((await call(app, "DELETE", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  await comment(app, world, world.who.owner, [text("not for you")]);
  await publishVersion(app, world, 1, "# v2");
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" for you")], 2);
  const row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.latestEvent.reason, "mentioned");
  assert.equal(row.isFollowing, false);
  assert.equal(row.unreadCount, 1, "not following: only what mentions the person");
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

// ---- the flag, the badge's cost, realtime, retention ------------------------------

test("flag off: the inbox and the unread summary are byte-identical to before, whatever object rows exist", async ({ app, seed }) => {
  const world = await seedWorld(seed, app, { flag: false });
  const res = await call(app, "POST", "/api/messages", world.who.owner, { channelId: world.general.id, content: "hello" });
  assert.equal(res.status, 200);
  const snapshot = async () => {
    const out: string[] = [];
    for (const filter of ["all", "unread", "mentions", "unread_mentions"]) {
      out.push((await inbox(app, world.who.reader, { filter })).text);
      out.push((await inbox(app, world.who.reader, { filter, limit: "1", offset: "1" })).text);
    }
    const summary = await call(app, "GET", "/api/servers/unread-summary", world.who.reader);
    out.push(summary.text);
    return out;
  };
  const before = await snapshot();
  assert.ok(!before.some((body) => ["objectUnreadCount", "objectMentionUnreadCount", "activityObjectUnreadCount"].some((field) => body.includes(field))));
  // Rows made while it was on, then switched off again.
  setFlag(true);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" while on")]);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 1);
  setFlag(false);
  assert.deepEqual(await snapshot(), before);
});

test("the Artifacts flag can't be read: the inbox, mark all read and the unread summary answer as with the flag off, not 500", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" while readable")]);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 1);
  const featureFlagService = await import("../../services/featureFlagService");
  const original = featureFlagService.evaluateFeatureFlags;
  const evaluate = vi.spyOn(featureFlagService, "evaluateFeatureFlags").mockImplementation(async (inputs, executor) => {
    if (inputs.some((input) => input.key === WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY)) throw new Error("flag store unavailable");
    return original(inputs, executor);
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const all = await inbox(app, world.who.reader);
  assert.equal(objectRows(all.body).length, 0);
  assert.ok(!["objectUnreadCount", "objectMentionUnreadCount", "objectCount"].some((field) => field in all.body), "no object fields, as flag off");
  assert.equal((await call(app, "POST", "/api/channels/inbox/read-all", world.who.reader)).status, 200);
  assert.ok(!("activityObjectUnreadCount" in (await summaryEntry(app, world.who.reader))));
  assert.ok(logged.mock.calls.some(([message]) => String(message).includes("flag read failed")));
  // Readable again: the row is back and still unread (the failed read-all marked no object row).
  evaluate.mockRestore();
  const back = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(back.length, 1);
  assert.ok(back[0]!.unreadCount > 0);
});

test("the badge reads only core's rows: no app hook, the same queries however many events", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const [kind] = artifactsApp.objectKinds;
  const hooks = (["homes", "summarize", "unreadFor", "activityDetails", "markRead"] as const).map((name) => vi.spyOn(kind as Required<typeof kind>, name));
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const countQueries = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const original = pg.query.bind(pg);
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return original(...args);
    }) as PgliteLike["query"];
    try {
      const counts = await objectActivityUnreadBatch([{ serverId: world.server.id }], world.reader.id);
      return { queries, unread: counts.get(world.server.id) };
    } finally {
      pg.query = original;
    }
  };
  await comment(app, world, world.who.owner, [mention(world.reader), text(" one")]);
  for (const spy of hooks) spy.mockClear();
  const few = await countQueries();
  assert.equal(few.unread, 1);
  await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader);
  for (let index = 0; index < 12; index += 1) await comment(app, world, world.who.owner, [text(`more ${index}`)]);
  await publishVersion(app, world, 1, "# v2");
  for (const spy of hooks) spy.mockClear();
  const many = await countQueries();
  assert.equal(many.unread, 1, "one unread object");
  assert.equal(many.queries, few.queries, "the same number of queries however many events");
  // The flag, the person's rows, their visible homes in that server, the count.
  assert.ok(many.queries <= 10, `a few queries (${many.queries})`);
  await summaryEntry(app, world.who.reader);
  for (const spy of hooks) assert.equal(spy.mock.calls.length, 0, `${spy.getMockName()} is never asked for the badge`);
});

test("activity:changed reaches the people an event is for, after the commit", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const frames: Array<{ room: string; event: string; payload: ActivityChangedEvent }> = [];
  setActivityRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: ActivityChangedEvent) => { frames.push({ room, event, payload }); return true; } }) } as never);
  try {
    await comment(app, world, world.who.owner, [mention(world.reader), text(" ping")]);
    assert.deepEqual(frames, [{ room: `user:${world.reader.id}`, event: ACTIVITY_CHANGED_EVENT, payload: { serverId: world.server.id, source: "object" } }]);
    frames.length = 0;
    await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page });
    assert.deepEqual(frames.map((frame) => frame.room), [`user:${world.reader.id}`], "the person's own Done, for their other clients");
  } finally {
    setActivityRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});

test("retention: a row goes with its newest event after 90 days", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" old")]);
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  await getDb().update(objectEvents).set({ createdAt: old }).where(eq(objectEvents.objectId, world.page));
  await getDb().update(objectInboxStates).set({ lastEventAt: old }).where(eq(objectInboxStates.objectId, world.page));
  await pruneObjectEvents();
  const left = await getDb().select().from(objectInboxStates).where(and(eq(objectInboxStates.objectId, world.page), eq(objectInboxStates.userId, world.reader.id)));
  assert.equal(left.length, 0);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  assert.equal(Number((await getDb().execute(sql`SELECT count(*) AS n FROM object_events WHERE object_id = ${world.page}`)).rows[0]!.n), 0);
});

// ---- read positions as core keeps them ------------------------------------------

/** The reader's row as core keeps it, and the app's read position. */
async function readState(world: World) {
  const [row] = await getDb().select().from(objectInboxStates).where(and(eq(objectInboxStates.objectId, world.page), eq(objectInboxStates.userId, world.reader.id)));
  const [position] = await getDb().select().from(artifactReadPositions).where(and(eq(artifactReadPositions.itemId, world.page), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, world.reader.id)));
  return { row, position: position?.position ?? null };
}

const lastPositionOf = async (world: World) => (await getDb().select({ lastPosition: artifactItems.lastPosition }).from(artifactItems).where(eq(artifactItems.id, world.page)))[0]!.lastPosition;

test("an edit of an older comment carries that comment's place: Done through it, then undo, leaves the newer comment unread, as the app counts it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  const older = await comment(app, world, world.who.owner, [text("older")]);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(world.page), world.who.reader)).status, 200, "the reader reads it");
  await comment(app, world, world.who.owner, [text("newer")]);
  // The edit names the reader: it moves their row, and its event carries the older comment's position.
  const edited = await call(app, "PATCH", artifactWebPaths.comment(world.page, older as never), world.who.owner, { body: [text("older, "), mention(world.reader)] });
  assert.equal(edited.status, 200, edited.text);
  let row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.latestEvent.eventKind, "comment_edited");
  assert.equal(row.unreadCount, 1, "the newer comment");

  assert.equal((await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  assert.equal((await call(app, "POST", objectActivityWebPaths.undone(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 1, "Done read through the edit's place, the older comment: the newer one is still unread, in the app and in core");
  assert.equal(await assertAgree(app, world.who.reader), 1);
  const { row: state, position } = await readState(world);
  assert.ok(position !== null && position < await lastPositionOf(world), "witness: the app's read position stopped before the newer comment");
  assert.ok(Number(state!.readThroughSeq) < Number(state!.lastEventSeq));

  assert.equal((await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  assert.equal(await assertAgree(app, world.who.reader), 0);
});

test("a read reported from a position read before newer events committed leaves them unread, an edit of an older comment among them", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  const older = await comment(app, world, world.who.owner, [text("older")]);
  // The viewer reads the Artifact's last position ...
  const seen = await lastPositionOf(world);
  // ... meanwhile a newer comment, then an edit of the older one (its event carries the older position), commit ...
  await comment(app, world, world.who.owner, [text("newer")]);
  const edited = await call(app, "PATCH", artifactWebPaths.comment(world.page, older as never), world.who.owner, { body: [text("older, edited")] });
  assert.equal(edited.status, 200, edited.text);
  // ... and then the viewer writes the position it read.
  await advanceReadPosition({ type: "user", id: world.reader.id }, world.page, seen);
  const row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 1, "the newer comment stays unread");
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

test("Done and the app's read are one transaction: when the app's markRead fails, the row is not Done and nothing is read", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" ping")]);
  const before = await readState(world);
  const [kind] = artifactsApp.objectKinds;
  // The app moves its read position and core's, then fails.
  const markRead = vi.spyOn(kind as Required<typeof kind>, "markRead").mockImplementationOnce(async (reader, targets, executor) => {
    await markArtifactsRead(reader, targets, executor);
    throw new Error("the app failed after moving its read position");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const done = await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page });
  assert.equal(done.status, 500, done.text);
  assert.equal(markRead.mock.calls.length, 1);
  const after = await readState(world);
  assert.equal(after.row!.doneThroughSeq, null, "not Done");
  assert.equal(after.row!.readThroughSeq, before.row!.readThroughSeq, "core's read didn't move");
  assert.equal(after.position, before.position, "the app's read position didn't move");
  const rows = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.unreadCount, 1);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  // It works again once the app does.
  assert.equal((await call(app, "POST", objectActivityWebPaths.done(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
});

test("starting to follow an Artifact never opened makes nothing unread: only what comes after it is", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [text("before following")]);
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  assert.equal((await readState(world)).position, await lastPositionOf(world), "the read position is the Artifact's last position");
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  assert.equal((await summaryEntry(app, world.who.reader)).activityObjectUnreadCount, 0);

  await comment(app, world, world.who.owner, [text("after following")]);
  const row = objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal(row.unreadCount, 1, "only the comment since following; not v1 or the comment before");
  assert.equal(await assertAgree(app, world.who.reader), 1);
  // Following again while following reads nothing.
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

// ---- the list's order, the windows ------------------------------------------------

test("object rows in the same millisecond page in the order they were read: none repeated or skipped across pages", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const ids: string[] = [world.page];
  for (const title of ["Second", "Third"]) {
    const created = await agentCall(app, "POST", "/artifacts/push", world.keyA, { target: `#${world.room.name}`, title, files: [{ path: "index.md", content: `# ${title}` }] });
    assert.equal(created.status, 201, created.text);
    ids.push(created.body.artifact.id as string);
  }
  for (const id of ids) await comment(app, world, world.who.owner, [mention(world.reader), text(" ping")], 1, asArtifactId(id));
  // One millisecond, three microseconds; the newest has the smallest id, the oldest the largest,
  // so ordering by milliseconds then id would disagree with the page's ORDER BY.
  const [small, middle, large] = [...ids].sort();
  const millisecond = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const at = (micros: string) => millisecond.replace(/Z$/, `${micros}Z`);
  for (const [id, micros] of [[small!, "900"], [middle!, "500"], [large!, "100"]] as const) {
    await getDb().execute(sql`UPDATE object_inbox_states SET last_event_at = ${at(micros)}::timestamptz WHERE object_id = ${id} AND user_id = ${world.reader.id}::uuid`);
  }
  for (const sort of ["desc", "asc"] as const) {
    const expected = sort === "desc" ? [small, middle, large] : [large, middle, small];
    const all = (await inbox(app, world.who.reader, { sort })).body;
    assert.deepEqual(objectRows(all).map((row) => row.objectId), expected, `${sort}: one page`);
    const paged: string[] = [];
    for (let offset = 0; offset < all.items.length; offset += 1) {
      paged.push(...objectRows((await inbox(app, world.who.reader, { sort, limit: "1", offset: String(offset) })).body).map((row) => row.objectId));
    }
    assert.deepEqual(paged, expected, `${sort}: a row a page`);
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
async function ageRows(world: World, ageMs: number) {
  const then = new Date(Date.now() - ageMs);
  await getDb().update(objectEvents).set({ createdAt: then }).where(eq(objectEvents.objectId, world.page));
  await getDb().update(objectInboxStates).set({ lastEventAt: then }).where(eq(objectInboxStates.objectId, world.page));
}
const setPlan = (world: World, plan: "free" | "founder") => getDb().update(servers).set({ plan }).where(eq(servers.id, world.server.id));

test("a row past retention that the prune hasn't reached yet counts nowhere: the list and the badge agree", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await setPlan(world, "founder");
  await comment(app, world, world.who.owner, [mention(world.reader), text(" old")]);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  await ageRows(world, 91 * DAY_MS);
  // Not pruned (the prune's batches stopped short of it).
  assert.equal((await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.objectId, world.page))).length, 1, "witness: the row is still there");
  const body = (await inbox(app, world.who.reader)).body;
  assert.equal(objectRows(body).length, 0);
  assert.equal(body.objectCount, 0);
  assert.equal(body.objectUnreadCount, 0);
  assert.equal(await assertAgree(app, world.who.reader), 0);
  // Inside retention it counts.
  await ageRows(world, 89 * DAY_MS);
  assert.equal(await assertAgree(app, world.who.reader), 1);
});

test("Free plan: object rows whose newest event is behind the 30-day history window are in neither the list nor the badge", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" a while ago")]);
  await ageRows(world, 31 * DAY_MS);
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0, "Free: behind the window");
  assert.equal(await assertAgree(app, world.who.reader), 0);
  await setPlan(world, "founder");
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 1, "a plan with all history: listed");
  assert.equal(await assertAgree(app, world.who.reader), 1);
  await setPlan(world, "free");
  await ageRows(world, 29 * DAY_MS);
  assert.equal(await assertAgree(app, world.who.reader), 1, "Free: inside the window");
});

// ---- delete ------------------------------------------------------------------------

test("DELETE /api/artifacts/:id: the Artifact leaves Activity with its delete, the badge with it, and the people whose rows went are told", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await comment(app, world, world.who.owner, [mention(world.reader), text(" ping")]);
  assert.equal(await assertAgree(app, world.who.reader), 1);
  const frames: Array<{ room: string; payload: ActivityChangedEvent }> = [];
  setActivityRealtimeIO({ to: (room: string) => ({ emit: (_event: string, payload: ActivityChangedEvent) => { frames.push({ room, payload }); return true; } }) } as never);
  try {
    const deleted = await call(app, "DELETE", artifactWebPaths.artifact(world.page), world.who.owner);
    assert.equal(deleted.status, 204, deleted.text);
    assert.deepEqual(frames, [{ room: `user:${world.reader.id}`, payload: { serverId: world.server.id, source: "object" } }]);
  } finally {
    setActivityRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
  assert.equal((await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.objectId, world.page))).length, 0, "the rows went in the delete");
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
  assert.equal(await assertAgree(app, world.who.reader), 0);
});

// ---- joint channels ----------------------------------------------------------------

/**
 * A second server, joined to the first by a joint channel; `peer` is a
 * person of the second server only, in its projection of the joint, and the
 * Artifact `joint` is homed in the joint (the first server's). The event
 * names `peer` as the app would once a peer can follow or be mentioned.
 */
async function seedJointWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  const world = await seedWorld(seed, app);
  const peer = await seed.human();
  const peerServer = await seed.server({ owner: peer });
  const joint = await seedJointChannel({ name: `act-joint-${label()}`, serverIds: [world.server.id, peerServer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addHuman(peerProjection.id, peer.id);
  const created = await agentCall(app, "POST", "/artifacts/push", world.keyA, { target: `#${hostProjection.name}`, title: "Joint", files: [{ path: "index.md", content: "# joint" }] });
  assert.equal(created.status, 201, created.text);
  const id = created.body.artifact.id as string;
  const tell = async (reason: "mentioned" | "following") => {
    await getDb().transaction(async (tx) => {
      const [item] = await tx.select().from(artifactItems).where(eq(artifactItems.id, id)).for("update");
      await recordArtifactEvent(tx, { item: item!, eventKind: "comment", actor: { type: "user", id: world.owner.id }, data: { position: item!.lastPosition }, recipients: [{ actor: { type: "user", id: peer.id }, reason }] });
    });
  };
  const who: Who = { token: await accessTokenForTest(peer.id), serverId: peerServer.id };
  return { world, peer, peerServer, id, tell, who, hostProjection, peerProjection };
}

// A joint channel is one conversation of each server in it, so an Artifact
// homed there reaches the other server's people who follow it or are
// mentioned, in their own server's Activity (#68: a joint's object is a
// message there): events.ts records them (platform/visibility jointViewersOf)
// and core lists and badges the row of the Artifact's server in the reader's
// (objectActivity jointRowsSeen).
test("a joint channel: the other server's person who is mentioned or follows gets the row in its own server's Activity", async ({ app, seed }) => {
  const joint = await seedJointWorld(seed, app);
  for (const reason of ["mentioned", "following"] as const) {
    await joint.tell(reason);
    const rows = objectRows((await inbox(app, joint.who)).body);
    assert.deepEqual(rows.map((row) => row.objectId), [joint.id], reason);
    assert.equal(rows[0]!.latestEvent.reason, reason);
    assert.deepEqual(rows[0]!.home, { kind: "channel", label: joint.peerProjection.name, channelId: joint.peerProjection.id }, "its home as the reader's server has it");
    assert.equal(await assertAgree(app, joint.who), 1);
  }
});

// The rule a joint's member of another server writes by (apiCommon
// takesPartIn) is the one its Activity rows are listed by (Tenny on #68), so
// leaving the joint takes its row, its badge, its writes and what it hears
// next away at once; and it holds only for a joint: another server's person
// never takes part in an object homed in a plain conversation, however it
// came to see it.
test("a joint channel: the other server's person follows, comments and reads from its own server; leaving the joint takes its row, badge, writes and next events away at once", async ({ app, seed }) => {
  const joint = await seedJointWorld(seed, app);
  const artifact = asArtifactId(joint.id);
  const fromHost = async (body: string) => {
    let res = await agentCall(app, "POST", `/artifacts/${joint.id}/comments`, joint.world.keyA, { body });
    // Held for the peer's comment it hasn't seen: as the hold says, it lists the comments, then the same request goes through.
    if (res.status === 409 && res.body?.code === "UNSEEN_CHANGES") {
      assert.equal((await agentCall(app, "GET", `/artifacts/${joint.id}/comments`, joint.world.keyA)).status, 200);
      res = await agentCall(app, "POST", `/artifacts/${joint.id}/comments`, joint.world.keyA, { body });
    }
    assert.equal(res.status, 201, res.text);
  };
  const peerComment = () => call(app, "POST", artifactWebPaths.comments(artifact), joint.who, { body: [text("from the peer")], version: 1, target: { scope: "artifact" }, replyTo: null });
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(artifact), joint.who)).status, 200);
  await fromHost("hello");
  assert.deepEqual(objectRows((await inbox(app, joint.who)).body).map((row) => row.objectId), [joint.id]);
  assert.equal(await assertAgree(app, joint.who), 1, "unread, badged in its own server");
  assert.equal((await peerComment()).status, 201);
  // Opening it reads it, its read position on the person (one row, read wherever it is).
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(artifact), joint.who)).status, 200);
  assert.equal(await assertAgree(app, joint.who), 0, "read");
  await fromHost("again");
  assert.equal(await assertAgree(app, joint.who), 1);

  // Someone else of the peer server stays in, so its copy stays connected
  // (an emptied copy is disconnected: computed joint membership).
  const stays = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: joint.peerServer.id, userId: stays.id, role: "member" });
  await addHuman(joint.peerProjection.id, stays.id);
  await removeHuman(joint.peerProjection.id, joint.peer.id, { self: true });
  assert.deepEqual(objectRows((await inbox(app, joint.who)).body), [], "no row");
  assert.equal(await assertAgree(app, joint.who), 0, "no badge");
  const wrote = await peerComment();
  assert.deepEqual([wrote.status, wrote.body.code], [404, "NOT_VISIBLE"], "no write");
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(artifact), joint.who)).status, 404);
  const heard = async () => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.recipientId, joint.peer.id))).length;
  const before = await heard();
  await fromHost("after it left");
  assert.equal(await heard(), before, "its follow tells it nothing more");

  // Only a joint: another server's person never takes part in an object of a plain conversation.
  const [plain] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, joint.world.page));
  const [jointItem] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, joint.id));
  await addHuman(joint.peerProjection.id, joint.peer.id);
  const peerActor = { type: "user" as const, id: joint.peer.id, serverId: asServerId(joint.peerServer.id) };
  assert.equal(plain!.homeKind, "conversation");
  assert.equal(await takesPartIn(peerActor, plain!), false, "a plain conversation's object, whatever its sight");
  assert.equal(await takesPartIn(peerActor, jointItem!), true, "witness: the joint's, back in it");
});

test("a review (S8) is one row naming it: target.review { id, comments } with the summary counted; a reader who can't see the Artifact gets none", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  for (const body of [[text("first "), mention(world.reader)], [text("second")]]) {
    const draft = await call(app, "POST", artifactWebPaths.reviewDrafts(world.page), world.who.owner, { version: 1, target: { scope: "artifact" }, body });
    assert.equal(draft.status, 201, draft.text);
  }
  const submitted = await call(app, "POST", artifactWebPaths.reviewSubmit(world.page), world.who.owner, { version: 1, summary: [text("overall")], clientKey: `k-${label()}` });
  assert.equal(submitted.status, 201, submitted.text);
  const comments = submitted.body.comments as Array<{ id: string; reviewId: string }>;
  assert.equal(comments.length, 3, "two drafts and the summary");

  const rows = objectRows((await inbox(app, world.who.reader)).body);
  assert.equal(rows.length, 1, "one row for the whole review");
  const row = rows[0]!;
  assert.equal(row.latestEvent.eventKind, "review");
  assert.equal(row.latestEvent.reason, "mentioned");
  assert.deepEqual(row.target, { version: 1, comment: comments[0]!.id, review: { id: comments[0]!.reviewId, comments: 3 } });

  // A single comment's row names no review.
  await comment(app, world, world.who.reader, [text("reply "), mention(world.owner)]);
  const ownerRow = objectRows((await inbox(app, world.who.owner)).body)[0]!;
  assert.equal(ownerRow.latestEvent.eventKind, "comment");
  assert.equal(ownerRow.target?.review, undefined);

  // Out of the Artifact's home: the review's row is gone with it.
  await removeHuman(world.room.id, world.reader.id, { self: true });
  assert.equal(objectRows((await inbox(app, world.who.reader)).body).length, 0);
});

test("a row whose newest event is a comment by someone else shows that comment's text, read or not; gone with the comment; none for a version (#80)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const said = await comment(app, world, world.who.owner, [text("look "), mention(world.reader), text(" here")]);
  const read = () => call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page });
  const rowOf = async () => objectRows((await inbox(app, world.who.reader)).body)[0]!;
  assert.equal((await rowOf()).preview?.text, `look @${world.reader.name} here`, "unread");
  assert.equal((await read()).status, 200);
  let row = await rowOf();
  assert.equal(row.unreadCount, 0);
  assert.deepEqual([row.preview?.text, row.preview?.author.id], [`look @${world.reader.name} here`, world.owner.id], "read: still its text");

  // Followed, read by opening it: a comment that doesn't mention the reader, its text too.
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  const plain = await comment(app, world, world.who.owner, [text("plain words")]);
  assert.equal((await call(app, "GET", artifactWebPaths.viewer(world.page), world.who.reader)).status, 200);
  row = await rowOf();
  assert.deepEqual([row.unreadCount, row.preview?.text, row.target], [0, "plain words", { version: 1, comment: plain }]);

  // The comment deleted (no replies: the row goes): no text, the row opens at its version.
  assert.equal((await call(app, "DELETE", artifactWebPaths.comment(world.page, asArtifactCommentId(plain)), world.who.owner)).status, 204);
  row = await rowOf();
  assert.deepEqual([row.latestEvent.eventKind, row.preview, row.target], ["comment", null, { version: 1 }]);
  assert.ok(said, "the first comment still stands");

  // A new version, read: no text (unchanged).
  await publishVersion(app, world, 1, "# plan v2");
  assert.equal((await read()).status, 200);
  row = await rowOf();
  assert.deepEqual([row.latestEvent.eventKind, row.unreadCount, row.preview], ["version", 0, null]);
});

test("a row says how many new versions and comments it has, by the unread rule: following, both; not following, the comments that mention the person; zeros once read (#81)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const rowOf = async () => objectRows((await inbox(app, world.who.reader)).body)[0]!;
  // Not following: only comments that mention the reader count, as comments; versions never.
  await comment(app, world, world.who.owner, [mention(world.reader), text(" one")]);
  await comment(app, world, world.who.owner, [text("not for you")]);
  let row = await rowOf();
  assert.deepEqual([row.unreadCount, row.unreadParts], [1, { versions: 0, comments: 1 }]);

  // Following (which reads everything up to now): a new version and two new comments.
  assert.equal((await call(app, "PUT", artifactWebPaths.subscription(world.page), world.who.reader)).status, 200);
  await publishVersion(app, world, 1, "# plan v2");
  await comment(app, world, world.who.owner, [text("first")], 2);
  await comment(app, world, world.who.owner, [text("second")], 2);
  row = await rowOf();
  assert.deepEqual([row.unreadCount, row.unreadParts], [3, { versions: 1, comments: 2 }]);

  // Read: zeros.
  assert.equal((await call(app, "POST", objectActivityWebPaths.read(), world.who.reader, { kind: "artifact", objectId: world.page })).status, 200);
  row = await rowOf();
  assert.deepEqual([row.unreadCount, row.unreadParts], [0, { versions: 0, comments: 0 }]);
});
