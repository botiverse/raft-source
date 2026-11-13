// Comments, following and notices through the Artifacts agent API (S1c), over
// HTTP with real agent credentials: writing comments (path, anchor, reply,
// version), @mentions, the comment hold (freshness v2 §2.2), following
// (automatic, sticky stop), who a comment or a version tells (at once, a
// follower as a mentioned agent: #55), visibility checked again when a notice
// is sent and when a legacy pending batch is flushed, object events, and the
// flag.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS, artifactLinkId, asArtifactId, asServerId, type AgentMessage, type ArtifactAgentAppEvent } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, objectEventRecipients, objectEvents, thirdPartyAgentEvents } from "../../db/schema";
import { AgentOrchestrator } from "../../services/agentOrchestrator";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, removeAgent } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { OBJECT_EVENT_RETENTION_MS, pruneObjectEvents } from "../../services/objectEventRetention";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { appNoticeOutbox } from "../../services/firstPartyAppHost";
import type { SystemAppAgentEventDeliverer } from "../../services/systemAppAgentEvents";
import { createArtifactAgentApi } from "./routes";
import { artifactNoticeDeliveryVerdicts, flushDueArtifactNotices, sendQueued } from "./notices";
import { artifactsApp } from "./register";
import { __setArtifactR2StoreForTests } from "./blobStore";
import {
  artifactComments,
  artifactItems,
  artifactPendingNotices,
  artifactReadPositions,
  artifactSubscriptions,
} from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

// What core hands the app: its notice outbox (services/firstPartyAppHost).
const artifactNoticeOutbox = (deliverer: SystemAppAgentEventDeliverer | undefined) => appNoticeOutbox(artifactsApp, deliverer);
const flushDue = (deliverer: SystemAppAgentEventDeliverer, opts?: { now?: Date }) => flushDueArtifactNotices(artifactNoticeOutbox(deliverer), opts);
/** The Artifacts notice a message carries (AgentMessage.app_event). */
const appEventOf = (message: AgentMessage): ArtifactAgentAppEvent | undefined => message.app_event as ArtifactAgentAppEvent | undefined;

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-comment-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

type Delivered = { agentId: string; message: AgentMessage };

/**
 * A server, Artifacts on: the owner (a person) and
 * agents A, B, C in #priv (private); agentOut in none of it; an agent of
 * another server. Notices pushed through the test app's orchestrator land in
 * `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { app: { get(key: string): unknown } }) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const make = (serverId: string, prefix: string) => createAgent(serverId, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentA = await make(server.id, "cm-a");
  const agentB = await make(server.id, "cm-b");
  const agentC = await make(server.id, "cm-c");
  const agentOut = await make(server.id, "cm-out");
  const peerAgent = await make(peer.id, "cm-peer");
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  for (const agent of [agentA, agentB, agentC]) await addAgent(priv.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `cm-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  __setArtifactR2StoreForTests({
    read: async () => null,
    presign: async () => null,
    put: async () => {},
    delete: async () => {},
  });
  const delivered: Delivered[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  return {
    server, serverId: asServerId(server.id), owner, agentA, agentB, agentC, agentOut, peerAgent, priv, delivered, orchestrator,
    keys: { a: await key(agentA.id), b: await key(agentB.id), c: await key(agentC.id), out: await key(agentOut.id), peer: await key(peerAgent.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

type Reply = { status: number; body: any };

async function call(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

type App = { baseUrl: string };
const text = (path: string, content: string) => ({ path, content });
const publish = (app: App, apiKey: string, body: unknown) => call(app.baseUrl, "POST", "/artifacts/push", apiKey, body);
const read = (app: App, apiKey: string, artifact: string) => call(app.baseUrl, "GET", `/artifacts/${artifact}`, apiKey);
const comment = (app: App, apiKey: string, artifact: string, body: unknown) => call(app.baseUrl, "POST", `/artifacts/${artifact}/comments`, apiKey, body);
const follow = (app: App, apiKey: string, artifact: string) => call(app.baseUrl, "PUT", `/artifacts/${artifact}/subscription`, apiKey);
const unfollow = (app: App, apiKey: string, artifact: string) => call(app.baseUrl, "DELETE", `/artifacts/${artifact}/subscription`, apiKey);

/** An artifact in #priv with index.html, a.html, b.html, v1 by A (who now follows it). */
async function createSite(world: World, app: App) {
  const res = await publish(app, world.keys.a, {
    target: `#${world.priv.name}`,
    title: "Site",
    files: [text("index.html", "<h1>home</h1>"), text("a.html", "a1"), text("b.html", "b1")],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.newlySubscribed, true);
  return res.body.artifact.id as string;
}

/** Publish a new version on the current one. */
async function publishOn(app: App, apiKey: string, artifact: string, files: Array<{ path: string; content: string }>) {
  const current = await read(app, apiKey, artifact);
  const res = await publish(app, apiKey, { artifact, base: current.body.artifact.currentVersion, files });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const subscriptionOf = async (itemId: string, agentId: string) =>
  (await getDb().select().from(artifactSubscriptions).where(and(eq(artifactSubscriptions.itemId, itemId), eq(artifactSubscriptions.actorId, agentId))))[0] ?? null;
const pendingOf = async (itemId: string, agentId: string) =>
  (await getDb().select().from(artifactPendingNotices).where(and(eq(artifactPendingNotices.itemId, itemId), eq(artifactPendingNotices.agentId, agentId))))[0] ?? null;
const eventsOf = (agentId: string) => getDb().select().from(thirdPartyAgentEvents)
  .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.artifacts")));
const noticesTo = (world: World, agentId: string) => world.delivered.filter((entry) => entry.agentId === agentId).map((entry) => entry.message);
const later = (ms: number) => new Date(Date.now() + ms);
/** A followers' batch as queued before #55 (nothing writes them now; the flush job drains what is left). */
const queueLegacyBatch = (itemId: string, agentId: string, commentIds: string[], dueAt: Date) =>
  getDb().insert(artifactPendingNotices).values({ itemId, agentId, commentIds, dueAt });
const LEGACY_BATCH_MS = 2 * 60 * 1000;

// ---- tests ---------------------------------------------------------------------

test("flag off: comment, follow and unfollow answer 403 ARTIFACTS_NOT_ENABLED and write nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const before = (await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id))).length;
  for (const res of [
    await comment(app, world.keys.b, id, { body: `hi @${world.agentA.name}` }),
    await follow(app, world.keys.b, id),
    await unfollow(app, world.keys.a, id),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED");
  }
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, id))).length, 0);
  assert.equal(await subscriptionOf(id, world.agentB.id), null);
  assert.equal((await subscriptionOf(id, world.agentA.id))!.unsubscribedAt, null);
  assert.equal((await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id))).length, before);
  assert.equal((await eventsOf(world.agentA.id)).length, 0);
  // A batch queued before the flag went off is dropped, not sent.
  await getDb().insert(artifactPendingNotices).values({ itemId: id, agentId: world.agentA.id, commentIds: ["c_x"], dueAt: new Date(Date.now() - 1000) });
  assert.equal(await flushDue(world.orchestrator as never), 0);
  assert.equal(await pendingOf(id, world.agentA.id), null);
  assert.equal(world.delivered.length, 0);
});

test("a comment: on a file and place, a reply in the same place, on an older version; listed as S1a lists comments", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await publishOn(app, world.keys.a, id, [text("a.html", "a2")]);
  await read(app, world.keys.b, id);
  const anchor = { type: "html-region", data: { selector: "#card", text: "three states" } };

  const first = await comment(app, world.keys.b, id, { body: "  three card states?  ", path: "a.html", anchor });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // No name: the deprecated field is its short id, for older CLIs.
  assert.deepEqual(first.body.artifact, { id, name: artifactLinkId(asArtifactId(id)), title: "Site", currentVersion: 2 });
  assert.equal(first.body.comment.body, "three card states?");
  assert.equal(first.body.comment.version, 2);
  assert.equal(first.body.comment.path, "a.html");
  assert.deepEqual(first.body.comment.anchor, anchor);
  assert.equal(first.body.comment.author.name, world.agentB.name);
  assert.equal(first.body.newlySubscribed, true);
  // A follows (it published): told at once.
  assert.deepEqual(first.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" }]);
  assert.deepEqual(first.body.notNotified, []);

  // B's read position moved over its own comment; the item's position is the comment's.
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, first.body.comment.id));
  assert.equal(row!.position, item!.lastPosition);
  const [position] = await getDb().select().from(artifactReadPositions).where(and(eq(artifactReadPositions.itemId, id), eq(artifactReadPositions.actorId, world.agentB.id)));
  assert.equal(position!.position, row!.position);

  // A reply without a path is on its parent's file and place; one on v1 says so.
  const reply = await comment(app, world.keys.b, id, { body: "and the empty one", replyTo: first.body.comment.id });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.comment.replyTo, first.body.comment.id);
  assert.equal(reply.body.comment.path, "a.html");
  assert.deepEqual(reply.body.comment.anchor, anchor);
  assert.equal(reply.body.newlySubscribed, false);
  const old = await comment(app, world.keys.b, id, { body: "the old page was better", path: "b.html", version: 1 });
  assert.equal(old.status, 201, JSON.stringify(old.body));
  assert.equal(old.body.comment.version, 1);

  const listed = await call(app.baseUrl, "GET", `/artifacts/${id}/comments?all=1`, world.keys.a);
  assert.deepEqual(listed.body.comments.map((c: { id: string; body: string }) => [c.id, c.body]), [
    [first.body.comment.id, "three card states?"],
    [reply.body.comment.id, "and the empty one"],
    [old.body.comment.id, "the old page was better"],
  ]);
  assert.deepEqual(listed.body.comments[0], first.body.comment);

  // One object event per comment and version, in the same order as positions.
  const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id)).orderBy(objectEvents.seq);
  assert.deepEqual(events.map((event) => [event.eventKind, event.data.position]), [
    ["version", 1], ["version", 2], ["comment", 3], ["comment", 4], ["comment", 5],
  ]);
  assert.deepEqual(events[2]!.data, { position: 3, comment: first.body.comment.id, version: 2 });
  assert.equal(events[2]!.actorId, world.agentB.id);
});

test("object events carry the Artifact's home and whom they are for: those mentioned, its followers (its maker as owner), never the actor", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  // C follows; so does the owner (a person, as the web would make them).
  assert.equal((await follow(app, world.keys.c, id)).status, 200);
  await getDb().insert(artifactSubscriptions).values({ itemId: id, actorType: "user", actorId: world.owner.id, reason: "followed" });
  await read(app, world.keys.b, id);
  const res = await comment(app, world.keys.b, id, { body: `@${world.agentC.name} and @${world.owner.name}, see a.html`, path: "a.html" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const v2 = await publishOn(app, world.keys.b, id, [text("b.html", "b2")]);
  assert.equal(v2.version.number, 2);

  const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id)).orderBy(objectEvents.seq);
  assert.deepEqual(events.map((event) => [event.objectKind, event.eventKind, event.homeKind, event.homeChannelId]), [
    ["artifact", "version", "conversation", world.priv.id],
    ["artifact", "comment", "conversation", world.priv.id],
    ["artifact", "version", "conversation", world.priv.id],
  ]);
  const recipientsOf = async (eventId: string) => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, eventId)))
    .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
  // v1: nobody followed it yet but its publisher.
  assert.deepEqual(await recipientsOf(events[0]!.id), []);
  // The comment: C and the owner mentioned (C's following counts once, as mentioned); A made it and follows it.
  assert.deepEqual(await recipientsOf(events[1]!.id), [
    `agent:${world.agentA.id}:owner`, `agent:${world.agentC.id}:mentioned`, `user:${world.owner.id}:mentioned`,
  ].sort());
  // v2 by B (who follows it now, by commenting): its other followers.
  assert.deepEqual(await recipientsOf(events[2]!.id), [
    `agent:${world.agentA.id}:owner`, `agent:${world.agentC.id}:following`, `user:${world.owner.id}:following`,
  ].sort());
});

test("the author's read position passes its own comment only when nothing unseen by others lies before it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  await read(app, world.keys.c, id);
  const positionOfB = async () => (await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, id), eq(artifactReadPositions.actorId, world.agentB.id))))[0]!.position;
  const seen = await positionOfB();
  // C comments on a.html; B, not having seen it, comments on b.html (not held: another file).
  assert.equal((await comment(app, world.keys.c, id, { body: "a looks off", path: "a.html" })).status, 201);
  const mine = await comment(app, world.keys.b, id, { body: "b is fine", path: "b.html" });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(await positionOfB(), seen, "C's comment stays unseen: B's position doesn't pass it");
  // With nothing unseen before it, its own next comment is passed over.
  await read(app, world.keys.b, id);
  const next = await comment(app, world.keys.b, id, { body: "and b again", path: "b.html" });
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, next.body.comment.id));
  assert.equal(await positionOfB(), row!.position);
});

test("a comment makes its artifact the most recently active in the list", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const older = await createSite(world, app);
  const newer = (await publish(app, world.keys.a, { target: `#${world.priv.name}`, title: "Newer", files: [text("index.html", "n")] })).body.artifact.id as string;
  const list = async () => (await call(app.baseUrl, "GET", "/artifacts", world.keys.b)).body.artifacts.map((artifact: { id: string }) => artifact.id);
  assert.deepEqual(await list(), [newer, older]);
  const before = (await getDb().select().from(artifactItems).where(eq(artifactItems.id, older)))[0]!.updatedAt;
  await read(app, world.keys.b, older);
  assert.equal((await comment(app, world.keys.b, older, { body: "bump" })).status, 201);
  assert.deepEqual(await list(), [older, newer]);
  assert.ok((await getDb().select().from(artifactItems).where(eq(artifactItems.id, older)))[0]!.updatedAt > before);
  // A held comment writes nothing, so it moves nothing.
  await comment(app, world.keys.c, newer, { body: "first look" });
  assert.deepEqual(await list(), [older, newer]);
});

test("comment refusals: path, anchor, reply, version, length; who may comment", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const refused = async (key: string, body: unknown, status: number, code: string, details?: unknown) => {
    const res = await comment(app, key, id, body);
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(res.body.code, code);
    if (details !== undefined) assert.deepEqual(res.body.details, details);
  };
  await refused(world.keys.b, { body: "x", path: "nope.html" }, 404, "FILE_NOT_FOUND", { path: "nope.html", version: 1 });
  await refused(world.keys.b, { body: "x", path: "../a.html" }, 400, "INVALID_PATH");
  await refused(world.keys.b, { body: "x", anchor: { type: "html-region", data: {} } }, 400, "ANCHOR_WITHOUT_PATH");
  await refused(world.keys.b, { body: "x", replyTo: "c_missing" }, 404, "COMMENT_NOT_FOUND", { replyTo: "c_missing" });
  await refused(world.keys.b, { body: "x", version: 9 }, 404, "VERSION_NOT_FOUND", { version: 9, currentVersion: 1 });
  await refused(world.keys.b, { body: "x".repeat(8001) }, 400, "FIELD_TOO_LONG", { field: "body", limit: 8000 });
  await refused(world.keys.b, { body: "x", path: "a.html", anchor: { type: "t", data: { s: "y".repeat(5000) } } }, 400, "FIELD_TOO_LONG", { field: "anchor", limit: 4096 });
  await refused(world.keys.b, { body: "   " }, 400, "agent_api_contract_invalid");
  // More than 20 distinct @names: refused, not cut short.
  const many = Array.from({ length: 21 }, (_, index) => `@someone-${index}`).join(" ");
  await refused(world.keys.b, { body: many }, 400, "TOO_MANY_MENTIONS", { limit: 20 });
  assert.equal((await comment(app, world.keys.b, id, { body: Array.from({ length: 20 }, (_, index) => `@someone-${index}`).join(" ") })).status, 409, "20 is allowed (held: B never read it)");
  // Not visible: the uniform 404. Visible from another server (public): 403.
  await refused(world.keys.out, { body: "x" }, 404, "NOT_VISIBLE");
  await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, id));
  await refused(world.keys.peer, { body: "x" }, 403, "FORBIDDEN");
  assert.equal((await follow(app, world.keys.peer, id)).status, 403);
  const stop = await unfollow(app, world.keys.peer, id);
  assert.equal(stop.status, 200);
  assert.equal(stop.body.following, false);
  assert.equal(await subscriptionOf(id, world.peerAgent.id), null);
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, id))).length, 0);
});

// Only its owner finds a personal assistant (agentFindableBy): another agent
// naming its handle reads exactly as a name nobody has, wherever the Artifact is.
test("mentions: another person's assistant is an unknown name to an agent", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const assistant = await createAgent(world.server.id, `cm-assistant-${label()}`, {
    runtime: "external", model: "external", creatorType: "user", creatorId: world.owner.id, kind: "personal_assistant",
  });
  await getDb().update(agents).set({ assistantOwnerUserId: world.owner.id }).where(eq(agents.id, assistant.id));
  for (const home of [{ homeKind: "conversation" as const, homeChannelId: world.priv.id }, { homeKind: "server" as const, homeChannelId: null }]) {
    await getDb().update(artifactItems).set(home).where(eq(artifactItems.id, id));
    const res = await comment(app, world.keys.b, id, { body: `@${assistant.name} are you there?` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.notified.some((entry: { actor: { name: string } }) => entry.actor.name === assistant.name), false, home.homeKind);
    assert.deepEqual(res.body.notNotified, [{ name: assistant.name, reason: "unknown_name" }], home.homeKind);
  }
});

test("mentions: an agent that sees it is told at once; a person, an unknown name and an agent that can't see it are not; mentions don't follow", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const res = await comment(app, world.keys.b, id, {
    body: `@${world.agentC.name} can you check? cc @${world.owner.name} @nobody-${label()} @${world.agentOut.name} @${world.agentB.name} \`@${world.agentA.name}\``,
    path: "a.html",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // A follows it (published) and wasn't mentioned (the mention in code isn't one): told at once too.
  assert.deepEqual(res.body.notified, [
    { actor: { type: "agent", name: world.agentC.name }, reason: "mentioned" },
    { actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" },
  ]);
  assert.deepEqual(res.body.notNotified.map((entry: { reason: string }) => entry.reason), ["not_agent", "unknown_name", "cannot_see"]);
  assert.equal(res.body.notNotified[0].name, world.owner.name);
  assert.equal(res.body.notNotified[2].name, world.agentOut.name);
  // Stored: the text as written and who it named who can see it (resolved actors, not oneself; agentOut can't, so
  // it isn't kept: a stored mention would surface in `waiting` and the unread count once it could, Tenny).
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, res.body.comment.id));
  assert.deepEqual(row!.mentions, [{ type: "agent", id: world.agentC.id }, { type: "user", id: world.owner.id }]);

  // C was pushed one notice, now: old daemons read the third-party event; new ones app_event.
  const [message, ...rest] = noticesTo(world, world.agentC.id);
  assert.equal(rest.length, 0);
  assert.equal(message!.third_party_event!.kind, "notification");
  assert.equal(message!.third_party_event!.client_id, "system.artifacts");
  assert.ok(message!.content.startsWith(`System notification: @${world.agentB.name} mentioned you in a comment on "Site" (a.html)`), message!.content);
  const notice = appEventOf(message!)!;
  assert.deepEqual(message!.third_party_event!.payload, { app_event: notice });
  assert.equal(notice.app, "artifacts");
  assert.equal(notice.kind, "artifact");
  assert.equal(notice.reason, "mentioned");
  assert.deepEqual(notice.artifact, { id, title: "Site" });
  assert.equal(notice.following, null);
  assert.equal(notice.comments!.count, 1);
  assert.equal(notice.comments!.latest[0]!.id, res.body.comment.id);
  assert.equal(notice.comments!.latest[0]!.author.name, world.agentB.name);
  // Mentioned isn't following; C's read position covers the comment it was shown.
  assert.equal(await subscriptionOf(id, world.agentC.id), null);
  assert.equal(noticesTo(world, world.agentOut.id).length, 0);
  assert.equal((await eventsOf(world.agentOut.id)).length, 0);
  // A, a follower, was pushed its own notice at once, as a message reaches it (#55): nothing waits.
  const [followerMessage, ...moreToA] = noticesTo(world, world.agentA.id);
  assert.equal(moreToA.length, 0);
  const followerNotice = appEventOf(followerMessage!)!;
  assert.equal(followerNotice.reason, "subscribed");
  assert.deepEqual(followerNotice.following, { kind: "published", version: 1 });
  assert.equal(followerNotice.comments!.count, 1);
  assert.deepEqual(followerNotice.comments!.latest.map((c) => c.id), [res.body.comment.id]);
  assert.ok(followerMessage!.content.includes(`New comment by @${world.agentB.name} on "Site"`), followerMessage!.content);
  assert.equal(await pendingOf(id, world.agentA.id), null);

  // A follower who is mentioned is told once, as mentioned (not also as a follower).
  const toA = await comment(app, world.keys.b, id, { body: `@${world.agentA.name} and you?` });
  assert.deepEqual(toA.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "mentioned" }]);
  assert.deepEqual(noticesTo(world, world.agentA.id).map((message) => appEventOf(message)!.reason), ["subscribed", "mentioned"]);
  assert.equal(await pendingOf(id, world.agentA.id), null);
});

test("the comment hold (freshness v2 §2.2): by others' comments on the file or the whole artifact and versions changing the file; once", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  // A stops following, so others' comments aren't told to it (a notice marks nothing seen either way).
  assert.equal((await unfollow(app, world.keys.a, id)).status, 200);

  // Others' comment on another file and a version changing another file: A's comment on a.html goes through.
  assert.equal((await comment(app, world.keys.b, id, { body: "b looks off", path: "b.html" })).status, 201);
  await publishOn(app, world.keys.b, id, [text("b.html", "b2")]);
  const free = await comment(app, world.keys.a, id, { body: "fine by me", path: "a.html" });
  assert.equal(free.status, 201, JSON.stringify(free.body));

  // Others' comment on a.html holds a.html, once; the retry goes through.
  await read(app, world.keys.b, id);
  const onA = await comment(app, world.keys.b, id, { body: "a needs a title", path: "a.html" });
  assert.equal(onA.status, 201);
  const held = await comment(app, world.keys.a, id, { body: "renamed it", path: "a.html" });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.deepEqual(held.body.details.unseen.comments.map((c: { id: string }) => c.id), [onA.body.comment.id]);
  assert.equal(held.body.details.unseen.commentCount, 1);
  assert.deepEqual(held.body.details.unseen.versions, []);
  assert.equal(held.body.details.unseen.versionCount, 0);
  // The position moves over what the hold showed in full, but not past B's
  // comment on b.html before it, which A never saw (task #71): onA stays
  // unseen behind it, and holds the same request again.
  const bLooksOff = (await getDb().select().from(artifactComments).where(eq(artifactComments.body, "b looks off")))[0]!;
  assert.equal(held.body.details.seen, bLooksOff.position - 1);
  assert.equal(held.body.details.unseen.unread, 1);
  const heldAgain = await comment(app, world.keys.a, id, { body: "renamed it", path: "a.html" });
  assert.equal(heldAgain.status, 409, JSON.stringify(heldAgain.body));
  // Reading the Artifact shows both comments whole: now it goes through.
  await read(app, world.keys.a, id);
  assert.equal((await comment(app, world.keys.a, id, { body: "renamed it", path: "a.html" })).status, 201);

  // A version by someone else that changed a.html: A (following again) is told about it
  // (a.html was A's file), but a notice marks nothing seen (Tenny): A's comment there is
  // held by it, once (the hold shows the version)...
  assert.equal((await follow(app, world.keys.a, id)).status, 200);
  await read(app, world.keys.c, id);
  const v = await publishOn(app, world.keys.b, id, [text("a.html", "a-by-b")]);
  assert.deepEqual(v.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "your_file_changed" }]);
  const toldOfVersion = await comment(app, world.keys.a, id, { body: "seen it", path: "a.html" });
  assert.equal(toldOfVersion.status, 409, JSON.stringify(toldOfVersion.body));
  assert.deepEqual(toldOfVersion.body.details.unseen.versions.map((s: { number: number }) => s.number), [v.version.number]);
  assert.equal(toldOfVersion.body.details.unseen.unread, 0);
  assert.equal((await comment(app, world.keys.a, id, { body: "seen it", path: "a.html" })).status, 201);
  // ...while it holds C's comment on a.html (with A's comment there).
  const byVersion = await comment(app, world.keys.c, id, { body: "looks good", path: "a.html" });
  assert.equal(byVersion.status, 409, JSON.stringify(byVersion.body));
  assert.deepEqual(byVersion.body.details.unseen.versions.map((s: { number: number; changedPaths: string[] }) => [s.number, s.changedPaths]), [[v.version.number, ["a.html"]]]);
  assert.equal(byVersion.body.details.unseen.versionCount, 1);
  assert.equal(byVersion.body.details.unseen.commentCount, 1);
  assert.equal((await comment(app, world.keys.c, id, { body: "looks good", path: "a.html" })).status, 201);
  // A version changing only another file doesn't hold it.
  await read(app, world.keys.c, id);
  await publishOn(app, world.keys.b, id, [text("b.html", "b3")]);
  assert.equal((await comment(app, world.keys.c, id, { body: "still good", path: "a.html" })).status, 201);
  assert.equal((await unfollow(app, world.keys.a, id)).status, 200);

  // A whole-artifact comment by others holds a comment on any file.
  await read(app, world.keys.b, id);
  assert.equal((await comment(app, world.keys.b, id, { body: "overall: ship it" })).status, 201);
  const byWhole = await comment(app, world.keys.a, id, { body: "one more thing", path: "b.html" });
  assert.equal(byWhole.status, 409);
  assert.equal(byWhole.body.details.unseen.comments[0].path, null);
  // C's comment on a.html came before it and wasn't shown: the whole-artifact one stays unseen behind it.
  assert.equal(byWhole.body.details.unseen.unread, 1);
  assert.equal((await comment(app, world.keys.a, id, { body: "one more thing", path: "b.html" })).status, 409);
  await read(app, world.keys.a, id);
  assert.equal((await comment(app, world.keys.a, id, { body: "one more thing", path: "b.html" })).status, 201);

  // A whole-artifact comment is held by anything new: a comment on another file, a version.
  await read(app, world.keys.b, id);
  assert.equal((await comment(app, world.keys.b, id, { body: "index too", path: "index.html" })).status, 201);
  await publishOn(app, world.keys.b, id, [text("index.html", "<h1>home 2</h1>")]);
  const whole = await comment(app, world.keys.a, id, { body: "summary" });
  assert.equal(whole.status, 409);
  assert.equal(whole.body.details.unseen.commentCount, 1);
  assert.equal(whole.body.details.unseen.versionCount, 1);
  assert.deepEqual(whole.body.details.skipped, { versions: 0, otherComments: 0 });
  assert.equal(whole.body.details.unseen.unread, 0);
  assert.equal((await comment(app, world.keys.a, id, { body: "summary" })).status, 201);

  // Acceptance 7: an agent that never read it is held with the newest few;
  // the older ones weren't shown, so it stays held until it lists the
  // comments (in full), then goes through.
  await addAgent(world.priv.id, world.agentOut.id);
  const first = await comment(app, world.keys.out, id, { body: "first look" });
  assert.equal(first.status, 409);
  assert.ok(first.body.details.unseen.commentCount > first.body.details.unseen.comments.length);
  assert.equal(first.body.details.unseen.comments.length, 5);
  assert.equal(first.body.details.unseen.commentsCursor, "0");
  assert.equal(first.body.details.unseen.unread, first.body.details.unseen.commentCount);
  assert.equal((await comment(app, world.keys.out, id, { body: "first look" })).status, 409);
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.out)).status, 200);
  assert.equal((await comment(app, world.keys.out, id, { body: "first look" })).status, 201);
});

test("a held comment with seen passes over versions that didn't hold it, counted in skipped, but stops before a comment it didn't show", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const seen = (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!.lastPosition;
  await publishOn(app, world.keys.b, id, [text("b.html", "b2")]);
  await comment(app, world.keys.b, id, { body: "on a", path: "a.html" });
  const held = await comment(app, world.keys.a, id, { body: "ok", path: "a.html", seen });
  assert.equal(held.status, 409);
  assert.deepEqual(held.body.details.skipped, { versions: 1, otherComments: 0 });
  assert.equal(held.body.details.unseen.unread, 0);
  assert.equal((await comment(app, world.keys.a, id, { body: "ok", path: "a.html", seen: held.body.details.seen })).status, 201);

  // A comment on another file before the held one wasn't shown: `seen` stops before it, and the held one stays unread.
  const from = (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!.lastPosition;
  await read(app, world.keys.b, id);
  const onB = await comment(app, world.keys.b, id, { body: "on b", path: "b.html" });
  await comment(app, world.keys.b, id, { body: "on a again", path: "a.html" });
  const stopped = await comment(app, world.keys.a, id, { body: "ok again", path: "a.html", seen: from });
  assert.equal(stopped.status, 409);
  assert.deepEqual(stopped.body.details.skipped, { versions: 0, otherComments: 0 });
  assert.equal(stopped.body.details.unseen.unread, 1);
  const onBPosition = (await getDb().select().from(artifactComments).where(eq(artifactComments.id, onB.body.comment.id)))[0]!.position;
  assert.equal(stopped.body.details.seen, onBPosition - 1);
  assert.equal((await comment(app, world.keys.a, id, { body: "ok again", path: "a.html", seen: stopped.body.details.seen })).status, 409);
});

test("following: publishing and commenting follow; a stop sticks and drops a legacy batch; following again clears it; mentions still reach", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  assert.equal((await subscriptionOf(id, world.agentA.id))!.reason, "published");

  const stop = await unfollow(app, world.keys.a, id);
  assert.equal(stop.status, 200);
  assert.deepEqual(stop.body, { artifact: { id, name: artifactLinkId(asArtifactId(id)), title: "Site", currentVersion: 1 }, following: false });
  assert.notEqual((await subscriptionOf(id, world.agentA.id))!.unsubscribedAt, null);

  await read(app, world.keys.b, id);
  const res = await comment(app, world.keys.b, id, { body: "anyone?" });
  assert.deepEqual(res.body.notified, []);
  assert.equal(await pendingOf(id, world.agentA.id), null);
  // Commenting and publishing don't follow it again.
  await read(app, world.keys.a, id);
  const mine = await comment(app, world.keys.a, id, { body: "me" });
  assert.equal(mine.body.newlySubscribed, false);
  assert.equal((await publishOn(app, world.keys.a, id, [text("a.html", "a2")])).newlySubscribed, false);
  assert.notEqual((await subscriptionOf(id, world.agentA.id))!.unsubscribedAt, null);
  // A mention still reaches it.
  await read(app, world.keys.b, id);
  const mention = await comment(app, world.keys.b, id, { body: `@${world.agentA.name} ?` });
  assert.deepEqual(mention.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "mentioned" }]);
  assert.equal(noticesTo(world, world.agentA.id).length, 1);

  const again = await follow(app, world.keys.a, id);
  assert.deepEqual(again.body, { artifact: { id, name: artifactLinkId(asArtifactId(id)), title: "Site", currentVersion: 2 }, following: true });
  assert.equal((await subscriptionOf(id, world.agentA.id))!.unsubscribedAt, null);
  await read(app, world.keys.b, id);
  const back = await comment(app, world.keys.b, id, { body: "welcome back" });
  assert.deepEqual(back.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" }]);
  assert.equal(noticesTo(world, world.agentA.id).length, 2, "the follower is told at once");
  // Stopping drops a batch still waiting from before #55.
  await queueLegacyBatch(id, world.agentA.id, [back.body.comment.id], later(LEGACY_BATCH_MS));
  await unfollow(app, world.keys.a, id);
  assert.equal(await pendingOf(id, world.agentA.id), null);
  // Following an artifact one never touched.
  const c = await follow(app, world.keys.c, id);
  assert.equal(c.body.following, true);
  assert.equal((await subscriptionOf(id, world.agentC.id))!.reason, "followed");
});

test("a new version tells only followers whose last-published files it changed (your_file_changed), at once", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  // C follows by commenting only; B becomes the last publisher of b.html.
  await read(app, world.keys.c, id);
  assert.equal((await comment(app, world.keys.c, id, { body: "hi" })).status, 201);
  const v2 = await publishOn(app, world.keys.b, id, [text("b.html", "b2")]);
  assert.equal(v2.newlySubscribed, true);
  // v2 changed b.html, which A published in v1 (A heard of C's comment before, at once).
  assert.deepEqual(v2.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "your_file_changed" }]);
  assert.deepEqual(noticesTo(world, world.agentA.id).map((message) => appEventOf(message)!.reason), ["subscribed", "your_file_changed"]);
  const toA = noticesTo(world, world.agentA.id)[1];
  assert.equal(appEventOf(toA!)!.reason, "your_file_changed");
  assert.deepEqual(appEventOf(toA!)!.version, { number: 2, publisher: { type: "agent", name: world.agentB.name }, note: null, yourFiles: ["b.html"], yourVersion: 1 });
  assert.deepEqual(appEventOf(toA!)!.following, { kind: "published", version: 1 });

  // A publishes a.html (its own file) and index.html: nobody else last published those.
  const v3 = await publishOn(app, world.keys.a, id, [text("a.html", "a3"), text("index.html", "<h1>3</h1>")]);
  assert.deepEqual(v3.notified, []);
  // A changes b.html (B's now): B is told; C (only commented) never is.
  const v4 = await publishOn(app, world.keys.a, id, [text("b.html", "b4")]);
  assert.deepEqual(v4.notified, [{ actor: { type: "agent", name: world.agentB.name }, reason: "your_file_changed" }]);
  assert.equal(appEventOf(noticesTo(world, world.agentB.id)[0]!)!.version!.yourVersion, 2);
  assert.equal(noticesTo(world, world.agentC.id).length, 0);
  // B stopped following: not told when A changes b.html again.
  await unfollow(app, world.keys.b, id);
  assert.deepEqual((await publishOn(app, world.keys.a, id, [text("b.html", "b5")])).notified, []);
  // A deleted file tells its last publisher too.
  const current = await read(app, world.keys.b, id);
  const deleted = await publish(app, world.keys.b, { artifact: id, base: current.body.artifact.currentVersion, files: [], delete: ["a.html"] });
  assert.equal(deleted.status, 201, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "your_file_changed" }]);
});

test("a follower hears each comment at once, one notice per comment, as a message (#55); being told marks nothing seen", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const one = await comment(app, world.keys.b, id, { body: "first", path: "a.html" });
  assert.equal(noticesTo(world, world.agentA.id).length, 1, "told of the first before the second is written");
  const two = await comment(app, world.keys.b, id, { body: "second" });
  const messages = noticesTo(world, world.agentA.id);
  assert.equal(messages.length, 2);
  for (const [message, written] of [[messages[0]!, one], [messages[1]!, two]] as const) {
    const notice = appEventOf(message)!;
    assert.equal(notice.reason, "subscribed");
    assert.equal(notice.comments!.count, 1);
    assert.deepEqual(notice.comments!.latest.map((c) => c.id), [written.body.comment.id]);
    assert.deepEqual(notice.following, { kind: "published", version: 1 });
    assert.ok(message.third_party_event!.payload.app_event, "the payload carries it for old daemons");
  }
  assert.equal((await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, id))).length, 0, "nothing is queued to batch");
  assert.equal(await flushDue(world.orchestrator as never, { now: later(10 * LEGACY_BATCH_MS) }), 0, "and the flush has nothing to send");
  // Being told isn't reading (Tenny): A's comment is held by them until A reads the Artifact.
  assert.equal((await comment(app, world.keys.a, id, { body: "thanks" })).status, 409);
  await read(app, world.keys.a, id);
  assert.equal((await comment(app, world.keys.a, id, { body: "thanks" })).status, 201);
  // A's comment is B's to hear at once (B follows by commenting); nothing more for A.
  assert.equal(appEventOf(noticesTo(world, world.agentB.id)[0]!)!.comments!.count, 1);
  assert.equal(noticesTo(world, world.agentA.id).length, 2);
});

// Tenny: a notice is only a notification. Neither queueing it nor the push
// that delivered it proves the model read it, so it never moves the read
// position; only a route that returns content to the agent does.
test("a notice marks nothing seen: right after a short comment's notice, the follower's publish is held; after a read it goes through (Tenny)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const publishA = () => publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a2")] });
  const positionOfA = async () => (await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, id), eq(artifactReadPositions.actorId, world.agentA.id))))[0]!.position;
  const before = await positionOfA();

  // B's short comment on a.html: A, a follower, was handed it whole in a notice.
  await read(app, world.keys.b, id);
  const short = await comment(app, world.keys.b, id, { body: "short and whole", path: "a.html" });
  assert.equal(short.status, 201, JSON.stringify(short.body));
  assert.deepEqual(short.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" }]);
  const told = appEventOf(noticesTo(world, world.agentA.id).at(-1)!)!;
  assert.deepEqual(told.comments!.latest.map((c) => [c.id, c.truncated]), [[short.body.comment.id, false]]);
  assert.equal(await positionOfA(), before, "the notice moved nothing");

  // Held: the notice proves nothing was read.
  const held = await publishA();
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.deepEqual(held.body.details.unseen.comments.map((c: { id: string }) => c.id), [short.body.comment.id]);

  // A reads the Artifact (as `raft artifact pull` does), which shows the comment whole: the same publish goes through.
  const pulled = await read(app, world.keys.a, id);
  assert.equal(pulled.status, 200);
  const published = await publishA();
  assert.equal(published.status, 201, JSON.stringify(published.body));
});

test("a follower told of a long comment: the notice and the read both cut it short, so the publish is held until the comments are listed", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const publishA = () => publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a2")] });
  await read(app, world.keys.b, id);
  const long = await comment(app, world.keys.b, id, { body: "x".repeat(AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS + 50), path: "a.html" });
  assert.equal(long.status, 201, JSON.stringify(long.body));
  const cut = appEventOf(noticesTo(world, world.agentA.id).at(-1)!)!;
  assert.equal(cut.reason, "subscribed");
  assert.equal(cut.comments!.latest[0]!.truncated, true);
  const pulled = await read(app, world.keys.a, id);
  assert.equal(pulled.body.unseen.unread, 1);
  const held = await publishA();
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.deepEqual(held.body.details.unseen.comments.map((c: { id: string }) => c.id), [long.body.comment.id]);
  assert.equal(held.body.details.unseen.unread, 1);
  assert.equal((await publishA()).status, 409);
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.a)).status, 200);
  assert.equal((await publishA()).status, 201);
});

// Task #71 (staging, InNOut): a 561-char comment, then pull → edit →
// publish went through: the read (what `raft artifact pull` and `read` call)
// moved the position to the end while it showed the comment cut short. A read
// now counts as seen only what it shows in full. (A stops following first;
// a notice would move nothing anyway.)
async function readThenPublish(app: App, world: World, bodies: string[]) {
  const id = await createSite(world, app);
  assert.equal((await unfollow(app, world.keys.a, id)).status, 200);
  await read(app, world.keys.b, id);
  for (const body of bodies) assert.equal((await comment(app, world.keys.b, id, { body, path: "a.html" })).status, 201);
  const pulled = await read(app, world.keys.a, id);
  assert.equal(pulled.status, 200);
  const publishA = () => publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a2")] });
  return { id, pulled: pulled.body, publishA };
}

test("task #71: a long comment read cut short stays unseen: the publish is held until the comments are listed in full", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { id, pulled, publishA } = await readThenPublish(app, world, ["z".repeat(561)]);
  assert.equal(pulled.unseen.commentCount, 1);
  assert.equal(pulled.unseen.comments[0].truncated, true);
  assert.equal(pulled.unseen.unread, 1);
  const held = await publishA();
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.equal(held.body.details.unseen.unread, 1);
  // Listing the new comments shows it whole: now the publish goes through.
  const listed = await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.a);
  assert.equal(listed.body.comments[0].body, "z".repeat(561));
  const published = await publishA();
  assert.equal(published.status, 201, JSON.stringify(published.body));
});

test("task #71: a short comment the read shows whole counts as seen: the publish goes through", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { pulled, publishA } = await readThenPublish(app, world, ["keep the header"]);
  assert.equal(pulled.unseen.comments[0].truncated, false);
  assert.equal(pulled.unseen.unread, 0);
  const published = await publishA();
  assert.equal(published.status, 201, JSON.stringify(published.body));
});

test("task #71: more comments than the read shows: those left out stay unseen, so the publish is held", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { id, pulled, publishA } = await readThenPublish(app, world, Array.from({ length: 7 }, (_, n) => `note ${n + 1}`));
  assert.equal(pulled.unseen.commentCount, 7);
  assert.equal(pulled.unseen.comments.length, 5);
  assert.equal(pulled.unseen.unread, 7, "the two oldest weren't shown, and the newer ones come after them");
  const held = await publishA();
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.a)).body.comments.length, 7);
  assert.equal((await publishA()).status, 201);
});

test("legacy: a followers' batch queued before #55 still goes out as one notice when due; not before", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const one = await comment(app, world.keys.b, id, { body: "first", path: "a.html" });
  const two = await comment(app, world.keys.b, id, { body: "second" });
  const before = noticesTo(world, world.agentA.id).length;
  await queueLegacyBatch(id, world.agentA.id, [one.body.comment.id, two.body.comment.id], later(LEGACY_BATCH_MS));

  assert.equal(await flushDue(world.orchestrator as never, { now: later(LEGACY_BATCH_MS - 10_000) }), 0);
  assert.equal(noticesTo(world, world.agentA.id).length, before);
  assert.equal(await flushDue(world.orchestrator as never, { now: later(LEGACY_BATCH_MS + 1000) }), 1);
  const [message, ...rest] = noticesTo(world, world.agentA.id).slice(before);
  assert.equal(rest.length, 0);
  const notice = appEventOf(message!)!;
  assert.equal(notice.reason, "subscribed");
  assert.equal(notice.comments!.count, 2);
  assert.deepEqual(notice.comments!.latest.map((c) => c.id), [one.body.comment.id, two.body.comment.id]);
  assert.deepEqual(notice.following, { kind: "published", version: 1 });
  assert.ok(message!.content.includes("2 new comments on \"Site\""), message!.content);
  assert.equal(await pendingOf(id, world.agentA.id), null);
});

test("visibility is checked again at the legacy flush: a follower removed from the home since its batch was queued gets nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  await read(app, world.keys.c, id);
  assert.equal((await comment(app, world.keys.c, id, { body: "following" })).status, 201);
  await read(app, world.keys.b, id);
  const res = await comment(app, world.keys.b, id, { body: "news" });
  assert.equal(res.body.notified.length, 2);
  for (const agent of [world.agentA, world.agentC]) await queueLegacyBatch(id, agent.id, [res.body.comment.id], later(LEGACY_BATCH_MS));
  const [toA, eventsToA, toC] = [noticesTo(world, world.agentA.id).length, (await eventsOf(world.agentA.id)).length, noticesTo(world, world.agentC.id).length];
  await removeAgent(world.priv.id, world.agentA.id);

  assert.equal(await flushDue(world.orchestrator as never, { now: later(LEGACY_BATCH_MS + 1000) }), 1);
  assert.equal(noticesTo(world, world.agentA.id).length, toA);
  assert.equal((await eventsOf(world.agentA.id)).length, eventsToA);
  assert.equal(await pendingOf(id, world.agentA.id), null);
  assert.equal(noticesTo(world, world.agentC.id).length, toC + 1);
});

test("a follower that can't see it is left out silently; an agent mentioned by name that can't is reported cannot_see", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.c, id);
  assert.equal((await comment(app, world.keys.c, id, { body: "following" })).status, 201);
  await removeAgent(world.priv.id, world.agentC.id);
  await read(app, world.keys.b, id);
  const res = await comment(app, world.keys.b, id, { body: "news" });
  assert.deepEqual(res.body.notified, [{ actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" }]);
  assert.deepEqual(res.body.notNotified, []);
  assert.equal(await pendingOf(id, world.agentC.id), null);
  const named = await comment(app, world.keys.b, id, { body: `@${world.agentC.name} are you there?` });
  assert.deepEqual(named.body.notNotified, [{ name: world.agentC.name, reason: "cannot_see" }]);
  assert.equal(noticesTo(world, world.agentC.id).length, 0);
});

test("a legacy flush handles each batch on its own: one that fails is dropped, the others go out", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.c, id);
  assert.equal((await comment(app, world.keys.c, id, { body: "following" })).status, 201);
  await read(app, world.keys.b, id);
  const news = await comment(app, world.keys.b, id, { body: "news" });
  assert.equal(news.body.notified.length, 2);
  for (const agent of [world.agentA, world.agentC]) await queueLegacyBatch(id, agent.id, [news.body.comment.id], later(LEGACY_BATCH_MS));
  const [toA, eventsToA, toC] = [noticesTo(world, world.agentA.id).length, (await eventsOf(world.agentA.id)).length, noticesTo(world, world.agentC.id).length];
  const real = artifactNoticeOutbox(world.orchestrator as never);
  const failing = {
    ...real,
    queue: async (executor: Parameters<typeof real.queue>[0], input: Parameters<typeof real.queue>[1]) => {
      // A's batch writes its event first, then fails: only the savepoint keeps
      // that half-written event from leaking into the committed flush.
      if (input.agentId === world.agentA.id) {
        await real.queue(executor, input);
        throw new Error("A's batch fails");
      }
      return real.queue(executor, input);
    },
  };
  const errors: unknown[][] = [];
  const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
  try {
    assert.equal(await flushDueArtifactNotices(failing, { now: later(LEGACY_BATCH_MS + 1000) }), 1);
  } finally {
    logged.mockRestore();
  }
  assert.ok(errors.some((args) => String(args[0]).includes("notice batch failed")), JSON.stringify(errors));
  assert.equal(noticesTo(world, world.agentC.id).length, toC + 1);
  assert.equal(noticesTo(world, world.agentA.id).length, toA);
  assert.equal((await eventsOf(world.agentA.id)).length, eventsToA);
  assert.equal(await pendingOf(id, world.agentA.id), null);
  assert.equal(await pendingOf(id, world.agentC.id), null);
});

test("visibility is checked again right before a notice is pushed: one that can't see it any more is taken back", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const outbox = artifactNoticeOutbox(world.orchestrator as never);
  const queue = (agentId: string) => getDb().transaction((tx) => outbox.queue(tx, {
    serverId: world.serverId, agentId, summary: "s", kind: "artifact", event: { artifact: { id, title: "Site" }, reason: "mentioned", following: null, comments: null, version: null }, ttlMs: 60_000, now: new Date(),
  }));
  const toA = await queue(world.agentA.id);
  const toB = await queue(world.agentB.id);
  await removeAgent(world.priv.id, world.agentA.id);
  await sendQueued(outbox, [{ ...toA, agentId: world.agentA.id, itemId: id }, { ...toB, agentId: world.agentB.id, itemId: id }]);
  assert.equal(noticesTo(world, world.agentA.id).length, 0);
  assert.equal((await eventsOf(world.agentA.id)).length, 0);
  assert.equal(noticesTo(world, world.agentB.id).length, 1);
});

test("delivery guard: a queued notice reaches its agent only while it can see the Artifact; after, it is never pulled and reads as no such event", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  // Left queued, as a failed or unacknowledged push leaves it.
  const outbox = artifactNoticeOutbox(undefined);
  const notice = { artifact: { id, title: "Site" }, reason: "mentioned" as const, following: null, comments: null, version: null };
  const queue = (agentId: string) => getDb().transaction((tx) => outbox.queue(tx, {
    serverId: world.serverId, agentId, summary: "secret title", kind: "artifact", event: notice, ttlMs: 60_000, now: new Date(),
  }));
  const toB = await queue(world.agentB.id);
  const toC = await queue(world.agentC.id);
  await removeAgent(world.priv.id, world.agentC.id);
  // A fresh process: the pull rebuilds the agents' pending events from the table.
  (app.app as unknown as { set(key: string, value: unknown): void }).set("agentOrchestrator", new AgentOrchestrator());
  const pull = async (apiKey: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return { status: res.status, raw: await res.text() };
  };
  const pulledB = await pull(world.keys.b);
  assert.equal(pulledB.status, 200, pulledB.raw);
  assert.ok(pulledB.raw.includes(toB.eventId), `an agent that still sees it gets it: ${pulledB.raw.slice(0, 1500)}`);
  const pulledC = await pull(world.keys.c);
  assert.equal(pulledC.status, 200, pulledC.raw);
  assert.ok(!pulledC.raw.includes(toC.eventId) && !pulledC.raw.includes("secret title"), "removed from the home: never pulled");
  const [rowC] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, toC.eventId));
  assert.equal(rowC!.status, "expired");
  // Re-read by id: the same answer as an id that never existed.
  const reread = async (target: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`, { headers: { Authorization: `Bearer ${world.keys.c}` } });
    return { status: res.status, text: await res.text() };
  };
  const unknown = await reread(`agent-event:${randomUUID()}`);
  assert.equal(unknown.status, 404, unknown.text);
  assert.deepEqual(await reread(`agent-event:${toC.eventId}`), unknown);
});

test("delivery guard verdicts: vetoed when the payload names no Artifact, the Artifact is another server's, or the flag is off", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const payload = { app_event: { app: "artifacts", kind: "artifact", artifact: { id, title: "Site" } } };
  const ev = (eventId: string, over: Partial<{ agentId: string; serverId: string; payload: Record<string, unknown> }> = {}) =>
    ({ id: eventId, agentId: world.agentB.id, serverId: world.server.id, payload, ...over });
  const verdicts = await artifactNoticeDeliveryVerdicts([
    ev("sees"),
    ev("no-artifact", { payload: { app_event: { reason: "mentioned" } } }),
    ev("not-an-object", { payload: { app_event: "x" } }),
    ev("unknown", { payload: { app_event: { artifact: { id: `pt_${randomUUID()}` } } } }),
    ev("other-server", { agentId: world.peerAgent.id, serverId: world.peerAgent.serverId }),
    ev("outsider", { agentId: world.agentOut.id }),
  ]);
  assert.deepEqual(Object.fromEntries(verdicts), {
    sees: true, "no-artifact": false, "not-an-object": false, unknown: false, "other-server": false, outsider: false,
  });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual(Object.fromEntries(await artifactNoticeDeliveryVerdicts([ev("sees")])), { sees: false }, "flag off");
});

// A joint channel between the server and the peer: an Artifact published
// there is homed on the joint's canonical channel and stays the publishing
// server's; the peer's agent in the joint reads it, its whole history and its
// comments, as it reads the joint's messages, and comments, reviews and
// follows as it writes there (Tenny on #68), but publishes nothing to it; it
// may be named by its handle, and is told, in its own server, as the
// Artifact's own agents are.
test("a joint channel: homed on its canonical channel; the peer's agent in it reads the Artifact and its comments, comments, reviews and follows, publishes nothing, and is told when named or following", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  for (const agent of [world.agentA, world.agentB]) await addAgent(hostProjection.id, agent.id);
  await addAgent(peerProjection.id, world.peerAgent.id);

  const res = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title: "Joint", files: [text("index.html", "<h1>v1</h1>")] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.artifact.id as string;
  const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
  assert.equal(row!.homeChannelId, joint.canonical.id, "the home is the joint's canonical channel, never a projection");
  assert.equal(row!.serverId, world.server.id, "the Artifact stays the publishing server's");
  // Each server names the home by its own projection.
  assert.deepEqual(res.body.artifact.home, { kind: "conversation", conversation: { id: hostProjection.id, type: "joint", target: `#${hostProjection.name}` } });
  await publishOn(app, world.keys.a, id, [text("index.html", "<h1>v2</h1>")]);
  await read(app, world.keys.b, id);
  const fromHost = await comment(app, world.keys.b, id, { body: `looks good @${world.peerAgent.name}` });
  assert.equal(fromHost.status, 201, JSON.stringify(fromHost.body));
  // The peer's agent is named by its handle, as in the joint's messages, and told.
  assert.deepEqual(fromHost.body.notNotified, []);
  const toldOfIt = (fromHost.body.notified as Array<{ actor: { name: string }; reason: string }>).map((entry) => `${entry.actor.name}:${entry.reason}`).sort();
  assert.deepEqual(toldOfIt, [`${world.agentA.name}:subscribed`, `${world.peerAgent.name}:mentioned`].sort(), "the peer's agent named, the publisher following");
  assert.ok(noticesTo(world, world.peerAgent.id).length > 0, "the mention reached it");

  // The peer's agent reads it: the whole history and the comments.
  const seen = await read(app, world.keys.peer, id);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.deepEqual(seen.body.artifact.home, { kind: "conversation", conversation: { id: peerProjection.id, type: "joint", target: `#${peerProjection.name}` } });
  const v1 = await call(app.baseUrl, "GET", `/artifacts/${id}?version=1`, world.keys.peer);
  assert.equal(v1.status, 200, `an older version too: ${JSON.stringify(v1.body)}`);
  const comments = await call(app.baseUrl, "GET", `/artifacts/${id}/comments?all=1`, world.keys.peer);
  assert.equal(comments.status, 200, JSON.stringify(comments.body));
  assert.deepEqual(comments.body.comments.map((entry: { id: string }) => entry.id), [fromHost.body.comment.id]);
  // Listed, in its own projection too.
  const listed = await call(app.baseUrl, "GET", `/artifacts?target=${encodeURIComponent(`#${peerProjection.name}`)}`, world.keys.peer);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.artifacts.map((entry: { id: string }) => entry.id), [id]);

  // It comments, reviews and follows, but publishes no version.
  const fromPeer = await comment(app, world.keys.peer, id, { body: "from the peer" });
  assert.equal(fromPeer.status, 201, JSON.stringify(fromPeer.body));
  const reviewed = await call(app.baseUrl, "POST", `/artifacts/${id}/reviews`, world.keys.peer, { body: "overall", comments: [{ body: "one point" }] });
  assert.equal(reviewed.status, 201, JSON.stringify(reviewed.body));
  assert.equal((await follow(app, world.keys.peer, id)).status, 200);
  assert.ok(await subscriptionOf(id, world.peerAgent.id), "it follows");
  assert.equal((await publish(app, world.keys.peer, { artifact: id, base: 2, files: [text("index.html", "peer")] })).status, 403);

  // Following, it is told of the next comment as the Artifact's own followers are, in its own server.
  // (B reads the peer's comments first: unseen, they'd hold its comment.)
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.b)).status, 200);
  const toldBefore = noticesTo(world, world.peerAgent.id).length;
  const again = await comment(app, world.keys.b, id, { body: "another one" });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const notified = (again.body.notified as Array<{ actor: { name: string }; reason: string }>).map((entry) => `${entry.actor.name}:${entry.reason}`).sort();
  assert.deepEqual(notified, [`${world.agentA.name}:subscribed`, `${world.peerAgent.name}:subscribed`].sort());
  assert.ok(noticesTo(world, world.agentA.id).length > 0, "witness: the publisher was told");
  assert.ok(noticesTo(world, world.peerAgent.id).length > toldBefore, "the peer's agent was told");
  assert.ok((await eventsOf(world.peerAgent.id)).every((event) => event.serverId === world.peerAgent.serverId), "in its own server");
  const recipients = await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.recipientId, world.peerAgent.id));
  assert.ok(recipients.length > 0, "a recipient of the events it hears of");
});

// A list reaches as far as reading one does: the peer's agent in the joint
// lists the server's Artifact homed there (all, by target, by query).
test("a joint channel: the peer's agent lists the server's Artifact homed there, by target and by query too", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const res = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title: "Zeppelin quarterly", files: [text("index.html", "<h1>v1</h1>")] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.artifact.id as string;

  const listed = async () => {
    const answers: Record<string, string[]> = {};
    for (const [name, path] of Object.entries({
      all: "/artifacts",
      target: `/artifacts?target=${encodeURIComponent(`#${peerProjection.name}`)}`,
      query: "/artifacts?query=zeppelin",
    })) {
      const reply = await call(app.baseUrl, "GET", path, world.keys.peer);
      assert.equal(reply.status, 200, `${name}: ${JSON.stringify(reply.body)}`);
      answers[name] = reply.body.artifacts.map((entry: { id: string }) => entry.id);
    }
    return answers;
  };
  assert.deepEqual(await listed(), { all: [id], target: [id], query: [id] });
});

// A joint's Artifact is read across servers: the peer's agent in the joint
// reads the server's Artifact homed there, its versions, its comments and the
// list.
test("a joint channel: the peer's agent reads the server's Artifact homed there, a version of it, its comments and the list", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const res = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title: "Joint", files: [text("index.html", "<h1>v1</h1>")] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.artifact.id as string;
  for (const path of [`/artifacts/${id}`, `/artifacts/${id}?version=1`, `/artifacts/${id}/comments`, `/artifacts/${id}/comments?all=1`, "/artifacts"]) {
    const reply = await call(app.baseUrl, "GET", path, world.keys.peer);
    assert.equal(reply.status, 200, `${path} ${JSON.stringify(reply.body)}`);
  }
});

// A joint is one namespace for lookups, whichever server published (Tenny,
// F6): the peer's agent finds the server's Artifact in the joint by its title
// (or its old name, an Artifact from before titles), and the other way round.
test("a joint channel: a title or an old name is looked up in the joint's one namespace: each server's agent finds the other's Artifact there", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const title = `Report ${label()}`;
  const fromHost = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title, files: [text("index.html", "<h1>host</h1>")] });
  assert.equal(fromHost.status, 201, JSON.stringify(fromHost.body));
  const hostId = fromHost.body.artifact.id as string;

  const found = await read(app, world.keys.peer, encodeURIComponent(title.toLowerCase()));
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.body.artifact.id, hostId, "the peer finds the server's Artifact by its title");
  const name = `report-${label()}`;
  await getDb().update(artifactItems).set({ name }).where(eq(artifactItems.id, hostId));
  assert.equal((await read(app, world.keys.peer, name)).body.artifact?.id, hostId, "and by its old name");

  // The other way round.
  const other = `Notes ${label()}`;
  const fromPeer = await publish(app, world.keys.peer, { target: `#${peerProjection.name}`, title: other, files: [text("index.html", "<h1>notes</h1>")] });
  assert.equal(fromPeer.status, 201, JSON.stringify(fromPeer.body));
  const back = await read(app, world.keys.a, encodeURIComponent(other));
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.artifact.id, fromPeer.body.artifact.id);

  // The same title in a home of the peer's own: two Artifacts, told apart by their ids.
  const peerRoom = await createChannel(world.peerAgent.serverId, `peer-room-${label()}`, undefined, "private");
  await addAgent(peerRoom.id, world.peerAgent.id);
  const own = await publish(app, world.keys.peer, { target: `#${peerRoom.name}`, title, files: [text("index.html", "<h1>own</h1>")] });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const ambiguous = await read(app, world.keys.peer, encodeURIComponent(title));
  assert.equal(ambiguous.status, 409, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.code, "AMBIGUOUS_ARTIFACT_NAME");
  assert.deepEqual(ambiguous.body.details.candidates.map((entry: { id: string }) => entry.id).sort(), [hostId, own.body.artifact.id].sort());
  assert.deepEqual(ambiguous.body.details.candidates.map((entry: { title: string }) => entry.title), [title, title]);
  assert.deepEqual(ambiguous.body.details.candidates.find((entry: { id: string }) => entry.id === hostId).home, { kind: "conversation", conversation: { id: peerProjection.id, type: "joint", target: `#${peerProjection.name}` } }, "named by the peer's own projection");

  // The server's agent outside the joint finds nothing by that title or name.
  assert.equal((await read(app, world.keys.out, encodeURIComponent(title))).status, 404, "witness: the server's agent outside the joint");
  assert.equal((await read(app, world.keys.out, name)).status, 404);
});

// An Artifact homed on a server's projection of a joint (published there
// before publish stored the canonical channel, or in a channel converted to a
// joint since) is read as homed in the joint (Tenny, F7): the peer's agent
// reads it, by id, by title and by its old name, and both servers list it under the joint.
test("a joint channel: an Artifact homed on the server's projection of the joint is the joint's: read by id, title and old name, listed and listed by target on both servers", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const name = `legacy-${label()}`;
  const title = `Legacy ${label()}`;
  const res = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title, files: [text("index.html", "<h1>old</h1>")] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.artifact.id as string;
  // As an older publish stored it: the host's projection, and an old name.
  await getDb().update(artifactItems).set({ homeChannelId: hostProjection.id, name }).where(eq(artifactItems.id, id));

  const seen = await read(app, world.keys.peer, id);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.deepEqual(seen.body.artifact.home, { kind: "conversation", conversation: { id: peerProjection.id, type: "joint", target: `#${peerProjection.name}` } }, "named by the peer's projection");
  assert.equal((await read(app, world.keys.peer, encodeURIComponent(title))).body.artifact?.id, id, "by title");
  assert.equal((await read(app, world.keys.peer, name)).body.artifact?.id, id, "by old name");
  for (const [key, projection] of [[world.keys.peer, peerProjection], [world.keys.a, hostProjection]] as const) {
    const all = await call(app.baseUrl, "GET", "/artifacts", key);
    assert.ok(all.body.artifacts.some((entry: { id: string }) => entry.id === id), `listed: ${JSON.stringify(all.body)}`);
    const byTarget = await call(app.baseUrl, "GET", `/artifacts?target=${encodeURIComponent(`#${projection.name}`)}`, key);
    assert.deepEqual(byTarget.body.artifacts.map((entry: { id: string }) => entry.id), [id], `listed by target #${projection.name}`);
  }
});

// The lookup searches a joint's canonical channel with every server's
// projection of it (Tenny, F6 with F7): an Artifact homed on a server's
// projection and one published under the canonical channel are both in the
// joint, so a title they share is ambiguous to either server's agent, and the
// old name only one of them has finds that one.
test("a joint channel: an Artifact homed on a server's projection shares the joint's namespace: a shared title answers both, an old name the one", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const name = `foo-${label()}`;
  const title = `Held ${label()}`;
  const held = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title, files: [text("index.html", "<h1>held</h1>")] });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const id = held.body.artifact.id as string;
  // The holder names the host's LOCAL projection, and has an old name, as an older publish stored it.
  await getDb().update(artifactItems).set({ homeChannelId: hostProjection.id, name }).where(eq(artifactItems.id, id));

  // An older CLI's `name` is ignored: a new one under the canonical channel is made, without a name.
  const made = await publish(app, world.keys.peer, { target: `#${peerProjection.name}`, name, title, files: [text("index.html", "<h1>made</h1>")] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  for (const key of [world.keys.peer, world.keys.a]) {
    const both = await read(app, key, encodeURIComponent(title));
    assert.equal(both.body.code, "AMBIGUOUS_ARTIFACT_NAME", JSON.stringify(both.body));
    assert.deepEqual(both.body.details.candidates.map((entry: { id: string }) => entry.id).sort(), [id, made.body.artifact.id].sort());
    const found = await read(app, key, name);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.artifact.id, id, "one Artifact by that old name in the joint");
  }
});

// A read position is per-actor state on the Artifact: whoever takes part in
// it keeps one, the joint's agent of another server too (Tenny on #68, in
// place of F5's stateless peer reads), so its reads move it as the server's
// own agents' do, and a comment's hold reads it.
test("a joint channel: the peer's agent reading the Artifact, or its unseen comments, moves its read position, as the server's own agents' reads do", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointChannel({ name: `cm-joint-${label()}`, serverIds: [world.server.id, world.peerAgent.serverId], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  for (const agent of [world.agentA, world.agentB]) await addAgent(hostProjection.id, agent.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const res = await publish(app, world.keys.a, { target: `#${hostProjection.name}`, title: "Joint", files: [text("index.html", "<h1>v1</h1>")] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.artifact.id as string;
  await read(app, world.keys.b, id);
  const said = await comment(app, world.keys.b, id, { body: "from the server" });
  assert.equal(said.status, 201, JSON.stringify(said.body));
  const positionsOf = (agentId: string) => getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, id), eq(artifactReadPositions.actorId, agentId)));

  const seen = await read(app, world.keys.peer, id);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal((await positionsOf(world.peerAgent.id)).length, 1, "reading moved it");
  const later = await comment(app, world.keys.b, id, { body: "a later one" });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const unseen = async () => {
    const listed = await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.peer);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    return listed.body.comments.map((entry: { id: string }) => entry.id);
  };
  assert.deepEqual(await unseen(), [later.body.comment.id], "only what came after its read");
  assert.deepEqual(await unseen(), [], "listing it marked it seen");
  // So its comment is not held for what it has seen.
  const fromPeer = await comment(app, world.keys.peer, id, { body: "from the peer" });
  assert.equal(fromPeer.status, 201, JSON.stringify(fromPeer.body));
});

test("a comment, its object event and its notices are one transaction", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  await read(app, world.keys.b, id);
  const failing = { ...artifactNoticeOutbox(world.orchestrator as never), queue: async () => { throw new Error("queue down"); } };
  const api = createArtifactAgentApi();
  await assert.rejects(api.comment({ agentId: world.agentB.id, serverId: world.serverId }, { artifact: id }, { body: `@${world.agentC.name} look` }, failing), /queue down/);
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, id))).length, 0);
  assert.deepEqual((await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id))).map((event) => event.eventKind), ["version"]);
  assert.equal(await subscriptionOf(id, world.agentB.id), null);
  assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!.lastPosition, 1);
});

test("object events older than 90 days are pruned", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const id = await createSite(world, app);
  const base = { serverId: world.serverId, objectKind: "artifact" as const, objectId: id, eventKind: "comment" as const, actorType: "agent" as const, actorId: world.agentA.id, data: {} };
  const now = new Date();
  await getDb().insert(objectEvents).values([
    { ...base, data: { old: true }, createdAt: new Date(now.getTime() - OBJECT_EVENT_RETENTION_MS - 60_000) },
    { ...base, data: { recent: true }, createdAt: new Date(now.getTime() - OBJECT_EVENT_RETENTION_MS + 60_000) },
  ]);
  assert.equal(await pruneObjectEvents({ now }), 1);
  const left = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id)).orderBy(objectEvents.seq);
  assert.deepEqual(left.map((event) => event.data), [{ position: 1, version: 1 }, { recent: true }]);
  // Data stays small: the CHECK refuses a large one.
  await assert.rejects(getDb().insert(objectEvents).values({ ...base, data: { big: randomBytes(6000).toString("base64") } }));
});
