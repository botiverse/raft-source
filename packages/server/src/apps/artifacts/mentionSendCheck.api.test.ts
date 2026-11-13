// The send-time check behind every mention picker (core's
// POST /api/mentions/audience is a list, not a permission): a mention of a
// person who can't see the Artifact reaches them nowhere. On the web the
// comment is refused (422 MENTION_NOT_VISIBLE, webComments.ts step 3) and
// nothing is written: no comment, no object event, no recipient, no Activity
// row. An agent's `@name` of such a person (the agent API, comments.ts) is
// written, as text, and reported `cannot_see` (as an agent that can't see it
// is; one who can is `not_agent`, which the agent's text lists as notified,
// #proj-workspace:#141); the person's Activity list and badge never show it
// (core's read-time visibility, services/objectActivity.ts).
// An Artifact homed in a joint channel may name the joint's other servers'
// members who can see it, as `@` offers them (platform/mentions
// jointObjectPeers). Each refusal has a witness: the same request for someone
// who can see it goes through.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { artifactWebPaths, asArtifactCommentId, asArtifactId, type ObjectInboxItem } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectEventRecipients, objectEvents, objectInboxStates } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { artifactComments, artifactItems } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-mention-send-check-hmac-secret-0123");
});
afterEach(() => {
  vi.unstubAllEnvs();
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

/**
 * A server (Artifacts on) with #room (owner, reader, agent A); `other` a member
 * outside it. Agent A publishes `page` (v1) in #room.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  const owner = await seed.human();
  const reader = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner, members: [reader, other] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const agentA = await createAgent(server.id, `msc-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const room = await createChannel(server.id, `msc-room-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(room.id, human.id);
  await addAgent(room.id, agentA.id);
  __setArtifactR2StoreForTests(memoryR2());
  const keyA = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `msc-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const created = await agentCall(app, "POST", "/artifacts/push", keyA, { target: `#${room.name}`, title: "Plan", files: [{ path: "index.md", content: "# plan" }] });
  assert.equal(created.status, 201, created.text);
  const page = asArtifactId(created.body.artifact.id as string);
  const as = async (userId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return { server, owner, reader, other, agentA, keyA, room, page, who: { owner: await as(owner.id), reader: await as(reader.id), other: await as(other.id) } };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const text = (value: string) => ({ type: "text" as const, text: value });
const mention = (user: { id: string }) => ({ type: "mention" as const, actor: { type: "user" as const, id: user.id } });
const commentInput = (body: unknown[]) => ({ body, version: 1, target: { scope: "artifact" }, replyTo: null });

/** What reaches a person: their Activity list's object rows and their badge's object count. */
async function reaching(app: { baseUrl: string }, world: World, who: Who) {
  const inbox = await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "all", limit: "100" })}`, who);
  assert.equal(inbox.status, 200, inbox.text);
  const mentions = await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "mentions", limit: "100" })}`, who);
  const summary = await call(app, "GET", "/api/servers/unread-summary", who);
  const objectRows = (body: { items: Array<{ kind: string; objectId?: string }> }) => body.items.filter((item): item is ObjectInboxItem => item.kind === "object" && item.objectId === world.page);
  return {
    rows: objectRows(inbox.body).length,
    mentionRows: objectRows(mentions.body).length,
    badge: (summary.body as Array<{ serverId: string; activityObjectUnreadCount?: number }>).find((row) => row.serverId === who.serverId)?.activityObjectUnreadCount ?? 0,
  };
}

/** The rows the page's events have for a person: object_event_recipients, and the Activity row (object_inbox_states). */
const recipientRows = (world: World, userId: string) => getDb().select().from(objectEventRecipients)
  .innerJoin(objectEvents, eq(objectEvents.id, objectEventRecipients.eventId))
  .where(and(eq(objectEvents.objectId, world.page), eq(objectEventRecipients.recipientId, userId)));
const inboxStates = (world: World, userId: string) => getDb().select().from(objectInboxStates)
  .where(and(eq(objectInboxStates.objectId, world.page), eq(objectInboxStates.userId, userId)));

test("a person's web comment naming a person who can't see the Artifact is refused, and nothing reaches them; the same comment naming one who can goes through", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const path = artifactWebPaths.comments(world.page);

  // The person's id passed directly in a mention part, whatever a picker offered.
  const refused = await call(app, "POST", path, world.who.reader, commentInput([text("see this "), mention(world.other)]));
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.body.code, "MENTION_NOT_VISIBLE");
  assert.deepEqual(refused.body.details, { actors: [{ type: "user", id: world.other.id }] });
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, world.page))).length, 0, "no comment");
  assert.equal((await getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, world.page), eq(objectEvents.eventKind, "comment")))).length, 0, "no event");
  assert.equal((await recipientRows(world, world.other.id)).length, 0, "no recipient row");
  assert.equal((await inboxStates(world, world.other.id)).length, 0, "no Activity row");
  assert.deepEqual(await reaching(app, world, world.who.other), { rows: 0, mentionRows: 0, badge: 0 });

  // Witness: naming the owner, who can see it, writes the comment and reaches them as a mention.
  const written = await call(app, "POST", path, world.who.reader, commentInput([text("see this "), mention(world.owner)]));
  assert.equal(written.status, 201, written.text);
  assert.equal((await inboxStates(world, world.owner.id)).length, 1);
  assert.deepEqual(await reaching(app, world, world.who.owner), { rows: 1, mentionRows: 1, badge: 1 });

  // An edit that adds them is refused the same way, and leaves the comment as it was.
  const commentId = asArtifactCommentId(written.body.comment.id as string);
  const edit = await call(app, "PATCH", artifactWebPaths.comment(world.page, commentId), world.who.reader, { body: [text("and "), mention(world.other)] });
  assert.equal(edit.status, 422, edit.text);
  assert.equal(edit.body.code, "MENTION_NOT_VISIBLE");
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, commentId));
  assert.deepEqual(row!.mentions, [{ type: "user", id: world.owner.id }]);
  assert.equal((await recipientRows(world, world.other.id)).length, 0);
  assert.equal((await inboxStates(world, world.other.id)).length, 0);
  assert.deepEqual(await reaching(app, world, world.who.other), { rows: 0, mentionRows: 0, badge: 0 });
});

test("an agent's @name of a person who can't see the Artifact keeps its text, reaches them nowhere (no Activity row shown, no badge) and is reported `cannot_see`; one who can sees it, `not_agent`", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const res = await agentCall(app, "POST", `/artifacts/${world.page}/comments`, world.keyA, { body: `@${world.other.name} and @${world.reader.name}, have a look` });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.comment.body, `@${world.other.name} and @${world.reader.name}, have a look`, "the text keeps the name");
  assert.deepEqual(res.body.notNotified, [{ name: world.other.name, reason: "cannot_see" }, { name: world.reader.name, reason: "not_agent" }], "in the order written");
  assert.deepEqual(await reaching(app, world, world.who.other), { rows: 0, mentionRows: 0, badge: 0 }, "nothing reaches the person who can't see it");
  // Witness: the reader, in the home, has the mention in Activity.
  assert.deepEqual(await reaching(app, world, world.who.reader), { rows: 1, mentionRows: 1, badge: 1 });
});

// A joint channel between the server and a peer (#68, xxchan): on an
// Artifact homed there a person's comment may name the joint's members of the
// other server who can see it (in their server's projection), as the joint's
// own messages name them; the mention is kept on the comment, and the peer's
// agent is told, in its own server (#68). Never anyone else of the peer: not
// its person outside the joint, and not on an Artifact homed anywhere but the
// joint (a public one included, which the peer reads).
test("a joint home: the other server's members of the joint who can see it may be named, in a new comment or an edit; not one outside the joint, nor on any other home", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const peerMember = await seed.human();
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
  const peerAgent = await createAgent(peer.id, `msc-p-${label()}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `msc-joint-${label()}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addAgent(hostProjection.id, world.agentA.id);
  await addHuman(peerProjection.id, peerMember.id);
  await addAgent(peerProjection.id, peerAgent.id);
  const pushed = await agentCall(app, "POST", "/artifacts/push", world.keyA, { target: `#${hostProjection.name}`, title: "Joint", files: [{ path: "index.md", content: "# joint" }] });
  assert.equal(pushed.status, 201, pushed.text);
  const jointPage = asArtifactId(pushed.body.artifact.id as string);
  const path = artifactWebPaths.comments(jointPage);
  const agentMention = (agent: { id: string }) => ({ type: "mention" as const, actor: { type: "agent" as const, id: agent.id } });
  const mentionsOf = async (commentId: string) => (await getDb().select().from(artifactComments).where(eq(artifactComments.id, commentId)))[0]!.mentions;

  const named = await call(app, "POST", path, world.who.reader, commentInput([text("for you "), mention(peerMember), text(" and "), agentMention(peerAgent)]));
  assert.equal(named.status, 201, named.text);
  assert.deepEqual(await mentionsOf(named.body.comment.id), [{ type: "user", id: peerMember.id }, { type: "agent", id: peerAgent.id }], "kept on the comment");
  assert.ok((named.body.notified as Array<{ actor: { id: string }; reason: string }>).some((entry) => entry.actor.id === peerAgent.id && entry.reason === "mentioned"), "the peer's agent is told");

  // The peer's person outside the joint can't see it: refused, nothing written.
  const before = (await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, jointPage))).length;
  const outside = await call(app, "POST", path, world.who.reader, commentInput([text("and "), mention(peerOwner)]));
  assert.equal(outside.status, 422, outside.text);
  assert.equal(outside.body.code, "MENTION_NOT_VISIBLE");
  assert.deepEqual(outside.body.details, { actors: [{ type: "user", id: peerOwner.id }] });
  assert.equal((await getDb().select().from(artifactComments).where(eq(artifactComments.itemId, jointPage))).length, before, "no comment");

  // An edit that adds the peer's member is checked the same way, and goes through.
  const witness = await call(app, "POST", path, world.who.reader, commentInput([text("witness "), agentMention(world.agentA)]));
  assert.equal(witness.status, 201, `witness: the server's own agent in the joint: ${witness.text}`);
  const commentId = asArtifactCommentId(witness.body.comment.id as string);
  const edited = await call(app, "PATCH", artifactWebPaths.comment(jointPage, commentId), world.who.reader, { body: [text("witness "), agentMention(world.agentA), text(" and "), mention(peerMember)] });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(await mentionsOf(commentId), [{ type: "agent", id: world.agentA.id }, { type: "user", id: peerMember.id }]);

  // Never on another home: the page in #room, and the same page made public (the peer's member reads it there).
  for (const home of ["conversation", "public"] as const) {
    if (home === "public") await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, world.page));
    const elsewhere = await call(app, "POST", artifactWebPaths.comments(world.page), world.who.reader, commentInput([text("see "), mention(peerMember)]));
    assert.equal(elsewhere.status, 422, `${home}: ${elsewhere.text}`);
    assert.deepEqual(elsewhere.body.details, { actors: [{ type: "user", id: peerMember.id }] }, home);
  }
});
