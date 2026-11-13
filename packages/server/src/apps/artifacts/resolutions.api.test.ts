// Resolving comment threads (#249, resolutions.ts) over HTTP, the agent API
// and the web API together: who may (the thread's author, the Artifact's
// author, the server's owners and admins; anyone else 403, a reply 409, an
// unseen Artifact 404), the resolution on every list (`resolvedAt`,
// `resolvedBy`), a reply reopening the thread, a note posted as the
// resolver's reply, the agent's hold, the thread author's notice (an agent)
// or Activity (a person, with its `activity:changed` ping), and a reopen
// telling no one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { artifactWebPaths, asArtifactCommentId, asArtifactId, type AgentMessage, type ArtifactAgentAppEvent, type ArtifactId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectEventRecipients, objectEvents } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { setActivityRealtimeIO } from "../../services/activityRealtime";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests } from "./blobStore";
import { artifactComments } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-resolve-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

type Reply = { status: number; body: any };
type Who = { token: string; serverId: string };
type App = { baseUrl: string; app: { get(key: string): unknown } };

/**
 * A server with the flag on: the owner, reader and manager (people) and
 * agents A, B, C in #priv (private); agentOut an agent outside it. manager
 * made A (so manages it), reader made C. Site: an Artifact in #priv pushed by
 * A (index.html, a.html). Notices pushed land in `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: App) {
  const owner = await seed.human();
  const reader = await seed.human();
  const manager = await seed.human();
  const server = await seed.server({ owner, members: [reader, manager] });
  const make = (prefix: string, creatorId?: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet", ...(creatorId ? { creatorType: "user" as const, creatorId } : {}) });
  const agentA = await make("rs-a", manager.id);
  const agentB = await make("rs-b");
  const agentC = await make("rs-c", reader.id);
  const agentOut = await make("rs-out");
  const priv = await createChannel(server.id, `rs-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader, manager]) await addHuman(priv.id, human.id);
  for (const agent of [agentA, agentB, agentC]) await addAgent(priv.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests({ read: async () => null, presign: async () => null, put: async () => {}, delete: async () => {} });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `rs-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { a: await key(agentA.id), b: await key(agentB.id), c: await key(agentC.id), out: await key(agentOut.id) };
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  const published = await agentCall(app, "POST", "/artifacts/push", keys.a, {
    target: `#${priv.name}`, title: "Site", files: [{ path: "index.html", content: "<h1>home</h1>" }, { path: "a.html", content: "a1" }],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    owner, reader, manager, agentA, agentB, agentC, keys, delivered,
    site: asArtifactId(published.body.artifact.id as string),
    who: { owner: await as(owner.id), reader: await as(reader.id), manager: await as(manager.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function agentCall(app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function web(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** An agent's comment, sent again once when held (the hold showed what it hadn't seen: not what these tests are about). */
async function comment(app: App, apiKey: string, site: ArtifactId, body: Record<string, unknown>): Promise<Reply> {
  const first = await agentCall(app, "POST", `/artifacts/${site}/comments`, apiKey, body);
  return first.status === 409 && first.body.code === "UNSEEN_CHANGES" ? agentCall(app, "POST", `/artifacts/${site}/comments`, apiKey, body) : first;
}
const resolve = (app: App, apiKey: string, site: ArtifactId, id: string, body: Record<string, unknown> = {}) => agentCall(app, "POST", `/artifacts/${site}/comments/${id}/resolve`, apiKey, body);
/** A resolve the agent sends again once when held by what it hadn't seen (the hold test sends it raw). */
async function resolveSeen(app: App, apiKey: string, site: ArtifactId, id: string): Promise<Reply> {
  const first = await resolve(app, apiKey, site, id);
  return first.status === 409 && first.body.code === "UNSEEN_CHANGES" ? resolve(app, apiKey, site, id) : first;
}
const reopen = (app: App, apiKey: string, site: ArtifactId, id: string) => agentCall(app, "POST", `/artifacts/${site}/comments/${id}/reopen`, apiKey);
const webResolve = (app: App, who: Who, site: ArtifactId, id: string, body: unknown = {}) => web(app, "POST", artifactWebPaths.commentResolve(site, asArtifactCommentId(id)), who, body);
const webReopen = (app: App, who: Who, site: ArtifactId, id: string) => web(app, "POST", artifactWebPaths.commentReopen(site, asArtifactCommentId(id)), who);
const rowOf = async (id: string) => (await getDb().select().from(artifactComments).where(eq(artifactComments.id, id)))[0]!;
const eventsOf = (itemId: string, eventKind: string) => getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, itemId), eq(objectEvents.eventKind, eventKind)));
const recipientsOf = async (eventId: string) => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, eventId)))
  .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
const noticesTo = (world: World, agentId: string) => world.delivered.filter((entry) => entry.agentId === agentId).map((entry) => entry.message.app_event as ArtifactAgentAppEvent);

/** B's thread on a.html, A having read it (so A's resolve isn't held). */
async function threadByB(app: App, world: World): Promise<string> {
  const posted = await comment(app, world.keys.b, world.site, { body: "Put the states side by side.", path: "a.html" });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal((await agentCall(app, "GET", `/artifacts/${world.site}/comments`, world.keys.a)).status, 200);
  world.delivered.length = 0;
  return posted.body.comment.id as string;
}

test("who may: the thread's author, the artifact's author, an owner on the web; another agent or member 403, a reply 409 naming its thread, an unknown id 404, an agent that can't see it the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await threadByB(app, world);

  const other = await resolve(app, world.keys.c, world.site, thread);
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.equal(other.body.code, "FORBIDDEN");
  assert.equal(other.body.details.reason, "not_resolver");
  assert.deepEqual(other.body.details.threadAuthor, { type: "agent", name: world.agentB.name });
  assert.deepEqual(other.body.details.author, { type: "agent", name: world.agentA.name });
  const member = await webResolve(app, world.who.reader, world.site, thread);
  assert.equal(member.status, 403, JSON.stringify(member.body));
  assert.equal(member.body.code, "FORBIDDEN");
  assert.equal((await rowOf(thread)).resolvedAt, null, "refused: nothing written");

  // The thread's author: resolved by B, then reopened by B.
  const byAuthor = await resolve(app, world.keys.b, world.site, thread);
  assert.equal(byAuthor.status, 200, JSON.stringify(byAuthor.body));
  assert.equal(byAuthor.body.changed, true);
  assert.deepEqual(byAuthor.body.comment.resolvedBy, { type: "agent", name: world.agentB.name });
  assert.equal(typeof byAuthor.body.comment.resolvedAt, "string");
  assert.deepEqual(byAuthor.body.notified, [], "one's own thread tells no one");
  assert.equal((await reopen(app, world.keys.b, world.site, thread)).body.changed, true);

  // The artifact's author, twice: the second changes nothing.
  const byArtifactAuthor = await resolve(app, world.keys.a, world.site, thread);
  assert.equal(byArtifactAuthor.status, 200, JSON.stringify(byArtifactAuthor.body));
  assert.deepEqual(byArtifactAuthor.body.comment.resolvedBy, { type: "agent", name: world.agentA.name });
  const again = await resolve(app, world.keys.a, world.site, thread, { note: "never posted" });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.note, null);
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.replyTo, thread))).length, 0, "no note on a resolve that changed nothing");

  // The server's owner, on the web (neither author): reopens it, and the web's comment carries the fields.
  const byOwner = await webReopen(app, world.who.owner, world.site, thread);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.equal(byOwner.body.changed, true);
  assert.equal(byOwner.body.comment.resolvedAt, null);
  assert.equal(byOwner.body.comment.resolvedBy, null);
  const ownerResolves = await webResolve(app, world.who.owner, world.site, thread);
  assert.equal(ownerResolves.status, 200, JSON.stringify(ownerResolves.body));
  assert.equal(ownerResolves.body.comment.resolvedBy.id, world.owner.id);

  // A reply is never resolved: 409 naming the thread's first comment, also two replies down.
  const reply = await comment(app, world.keys.c, world.site, { body: "first answer", replyTo: thread });
  const deeper = await comment(app, world.keys.c, world.site, { body: "second answer", replyTo: reply.body.comment.id });
  for (const id of [reply.body.comment.id, deeper.body.comment.id]) {
    const refused = await resolve(app, world.keys.c, world.site, id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "COMMENT_IS_REPLY");
    assert.equal(refused.body.details.thread, thread);
  }
  const webReply = await webResolve(app, world.who.owner, world.site, reply.body.comment.id);
  assert.equal(webReply.status, 409);
  assert.equal(webReply.body.details.thread, thread);

  assert.equal((await resolve(app, world.keys.a, world.site, "c_nope")).body.code, "COMMENT_NOT_FOUND");
  assert.equal((await webResolve(app, world.who.owner, world.site, "c_nope")).body.code, "COMMENT_NOT_FOUND");
  const unseen = await resolve(app, world.keys.out, world.site, thread);
  assert.equal(unseen.status, 404);
  assert.equal(unseen.body.code, "NOT_VISIBLE");
});

test("a reply in a resolved thread reopens it, in the reply's transaction; every list carries resolvedAt / resolvedBy (agent and web)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await threadByB(app, world);
  assert.equal((await resolve(app, world.keys.a, world.site, thread)).status, 200);

  const listed = await agentCall(app, "GET", `/artifacts/${world.site}/comments?all=true`, world.keys.c);
  const root = listed.body.comments.find((c: { id: string }) => c.id === thread);
  assert.deepEqual(root.resolvedBy, { type: "agent", name: world.agentA.name });
  assert.equal(typeof root.resolvedAt, "string");
  const page = await web(app, "GET", artifactWebPaths.comments(world.site), world.who.reader);
  const webRoot = page.body.comments.find((c: { id: string }) => c.id === thread);
  assert.equal(webRoot.resolvedBy.id, world.agentA.id);
  assert.equal(webRoot.resolvedBy.type, "agent");

  // A person's reply on the web reopens it; so does an agent's two replies down, after resolving again.
  const webReply = await web(app, "POST", artifactWebPaths.comments(world.site), world.who.reader, { version: 1, target: { scope: "artifact" }, replyTo: thread, body: [{ type: "text", text: "not quite" }] });
  assert.equal(webReply.status, 201, JSON.stringify(webReply.body));
  assert.equal((await rowOf(thread)).resolvedAt, null);
  assert.equal(webReply.body.comment.resolvedAt, null, "a reply carries no resolution");
  assert.equal((await resolveSeen(app, world.keys.a, world.site, thread)).status, 200);
  const deeper = await comment(app, world.keys.c, world.site, { body: "still off", replyTo: webReply.body.comment.id });
  assert.equal(deeper.status, 201, JSON.stringify(deeper.body));
  const after = await rowOf(thread);
  assert.equal(after.resolvedAt, null);
  assert.equal(after.resolvedById, null);
  // A review's reply too.
  assert.equal((await resolveSeen(app, world.keys.a, world.site, thread)).status, 200);
  const reviewBody = { comments: [{ body: "and in the review", replyTo: thread }] };
  const heldReview = await agentCall(app, "POST", `/artifacts/${world.site}/reviews`, world.keys.c, reviewBody);
  const review = heldReview.status === 409 ? await agentCall(app, "POST", `/artifacts/${world.site}/reviews`, world.keys.c, reviewBody) : heldReview;
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal((await rowOf(thread)).resolvedAt, null);
});

test("a note is the resolver's reply in the thread; the thread's author (an agent) is told once, of the resolve, and the note's mention as a mention", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await threadByB(app, world);
  const resolved = await resolve(app, world.keys.a, world.site, thread, { note: `Done in v1, @${world.agentC.name} please check` });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const note = resolved.body.note;
  assert.equal(note.replyTo, thread);
  assert.equal(note.path, "a.html", "at the thread's place");
  assert.deepEqual(note.author, { type: "agent", name: world.agentA.name });
  assert.equal(note.resolvedAt, null);
  assert.equal((await rowOf(note.id)).replyTo, thread);
  assert.equal(typeof (await rowOf(thread)).resolvedAt?.toISOString(), "string", "the note didn't leave it open");
  assert.deepEqual(resolved.body.notified.map((n: { actor: { name: string }; reason: string }) => `${n.actor.name}:${n.reason}`).sort(), [`${world.agentB.name}:resolved`, `${world.agentC.name}:mentioned`].sort());

  // B follows (it commented), but hears of the resolve alone, not of the note as a follower too.
  const toB = noticesTo(world, world.agentB.id);
  assert.equal(toB.length, 1, JSON.stringify(toB));
  assert.equal(toB[0]!.reason, "your_comment_resolved");
  assert.equal(toB[0]!.resolved?.comment.id, thread);
  assert.equal(toB[0]!.resolved?.noteExcerpt, `Done in v1, @${world.agentC.name} please check`);
  assert.deepEqual(toB[0]!.resolved?.by, { type: "agent", name: world.agentA.name });
  const summary = world.delivered.find((entry) => entry.agentId === world.agentB.id)!.message.content;
  assert.ok(summary.includes(`@${world.agentA.name} resolved your comment on "Site" (a.html), noting: "Done in v1`), summary);
  assert.equal(noticesTo(world, world.agentC.id)[0]?.reason, "mentioned");

  // A reopen tells no one.
  world.delivered.length = 0;
  assert.equal((await reopen(app, world.keys.a, world.site, thread)).status, 200);
  assert.equal(world.delivered.length, 0);
  const [reopened] = await eventsOf(world.site, "comment_reopened");
  assert.deepEqual(await recipientsOf(reopened!.id), []);
});

test("a person's thread: resolving it records comment_resolved for them and pings their Activity; an agent's resolve is held as a reply there would be", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const posted = await web(app, "POST", artifactWebPaths.comments(world.site), world.who.reader, { version: 1, target: { scope: "file", path: "a.html", anchor: null }, replyTo: null, body: [{ type: "text", text: "Spacing looks off." }] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const thread = posted.body.comment.id as string;
  // C answers in the thread before A has looked: A's resolve is held, then goes through.
  assert.equal((await comment(app, world.keys.c, world.site, { body: "still off on phones", replyTo: thread })).status, 201);
  const rooms: string[] = [];
  setActivityRealtimeIO({ to: (room: string) => ({ emit: () => { rooms.push(room); return true; } }) } as never);
  try {
    const held = await resolve(app, world.keys.a, world.site, thread);
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.equal(held.body.code, "UNSEEN_CHANGES");
    assert.equal((await rowOf(thread)).resolvedAt, null);
    const resolved = await resolve(app, world.keys.a, world.site, thread);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const [event] = await eventsOf(world.site, "comment_resolved");
    assert.ok(event, "the event is recorded");
    assert.deepEqual(await recipientsOf(event.id), [`user:${world.reader.id}:following`]);
    assert.ok(rooms.some((room) => room.includes(world.reader.id)), `activity:changed for the thread's author: ${rooms.join(", ")}`);
    // The web's own resolve by the person whose thread it is: no recipient (it is theirs).
    assert.equal((await webReopen(app, world.who.reader, world.site, thread)).status, 200);
    assert.equal((await webResolve(app, world.who.reader, world.site, thread, { note: [{ type: "text", text: "fixed now" }] })).body.note.body[0].text, "fixed now");
    const events = await eventsOf(world.site, "comment_resolved");
    assert.equal(events.length, 2);
    const own = events.find((e) => e.id !== event.id)!;
    assert.deepEqual(await recipientsOf(own.id), []);
  } finally {
    setActivityRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});

test("the person who manages an agent author resolves and reopens as its author would; one who manages a different agent is refused", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await threadByB(app, world);
  // The reader made C, not A (the Artifact's author): neither the thread's author, nor A's manager.
  const other = await webResolve(app, world.who.reader, world.site, thread);
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.ok(other.body.error.includes("or whoever manages it, when it's an agent"), other.body.error);
  assert.equal((await webReopen(app, world.who.reader, world.site, thread)).status, 403);
  // The manager made A.
  const resolved = await webResolve(app, world.who.manager, world.site, thread);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.changed, true);
  assert.equal(resolved.body.comment.resolvedBy.id, world.manager.id);
  assert.equal(noticesTo(world, world.agentB.id)[0]?.reason, "your_comment_resolved", "the thread's author is told");
  const reopened = await webReopen(app, world.who.manager, world.site, thread);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.comment.resolvedAt, null);
  // Still refused for the reader after it changed hands.
  assert.equal((await webResolve(app, world.who.reader, world.site, thread)).status, 403);
});
