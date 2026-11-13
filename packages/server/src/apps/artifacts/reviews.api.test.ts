// Batch comments (S8) over HTTP, beside the comment tests: a person's review
// drafts (private to their author, at most 50 per Artifact, gone 30 days
// after their last change) and submitting them as one review; an agent's
// review in one call. Proves the rules both share (reviews.ts submitReview):
// all or nothing (the first refused comment refuses the review with its own
// code and place, nothing written), access checked again at submit, one
// object event and one notice per recipient per review however many
// comments, and a person's submit idempotent per clientKey.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS, AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN, ARTIFACT_COMMENT_MAX_CHARS, artifactWebPaths, asArtifactId, asArtifactReviewId, type AgentMessage, type ArtifactAgentAppEvent, type ArtifactId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectEventRecipients, objectEvents, objectInboxStates } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, removeAgent, removeHuman } from "../../services/channelService";
import { setActivityRealtimeIO } from "../../services/activityRealtime";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests } from "./blobStore";
import { artifactCommentDrafts, artifactComments, artifactItems, artifactPendingNotices, artifactReadPositions, artifactReviews, artifactVersions } from "./schema";
import { artifactUnreadFor } from "./activity";
import { purgeExpiredArtifactDrafts } from "./webReviews";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
/** The same world, with a person's Artifact writes limited to four a minute. */
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.write": 4 } });

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-review-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
/** MENTION_NOT_VISIBLE's sentence (webComments resolveBody), the same in a draft's rejection. */
const MENTION_HIDDEN = "Someone you mention can't see this artifact, so they wouldn't be told: remove the mention, or share the artifact with them first.";

/**
 * A server with the flag on: the owner and reader (people) and agents A, B,
 * C in #priv (private); outsider a member outside it; agentOut an agent
 * outside it. Site: an Artifact in #priv published by A (index.html, a.html,
 * b.html; A follows it). Notices pushed land in `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string; app: { get(key: string): unknown } }) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const make = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentA = await make("rv-a");
  const agentB = await make("rv-b");
  const agentC = await make("rv-c");
  const agentOut = await make("rv-out");
  const priv = await createChannel(server.id, `rv-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  for (const agent of [agentA, agentB, agentC]) await addAgent(priv.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests({ read: async () => null, presign: async () => null, put: async () => {}, delete: async () => {} });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `rv-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { a: await key(agentA.id), b: await key(agentB.id), c: await key(agentC.id), out: await key(agentOut.id) };
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  const published = await agentCall(app, "POST", "/artifacts/push", keys.a, {
    target: `#${priv.name}`, title: "Site", files: [{ path: "index.html", content: "<h1>home</h1>" }, { path: "a.html", content: "a1" }, { path: "b.html", content: "b1" }],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    server, owner, reader, outsider, agentA, agentB, agentC, agentOut, priv, keys, delivered,
    site: asArtifactId(published.body.artifact.id as string),
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;
type Who = { token: string; serverId: string };
type Reply = { status: number; body: any };

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

const text = (value: string) => ({ type: "text" as const, text: value });
const mention = (actor: { id: string }, type: "user" | "agent") => ({ type: "mention" as const, actor: { type, id: actor.id } });
const input = (body: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, target: { scope: "file", path: "a.html", anchor: null }, body, ...extra });
const draft = (app: { baseUrl: string }, world: World, who: Who, value: unknown) => web(app, "POST", artifactWebPaths.reviewDrafts(world.site), who, value);
const submit = (app: { baseUrl: string }, world: World, who: Who, value: Record<string, unknown> = {}) =>
  web(app, "POST", artifactWebPaths.reviewSubmit(world.site), who, { version: 1, summary: null, clientKey: randomUUID(), ...value });
const agentReview = (app: { baseUrl: string }, apiKey: string, artifact: ArtifactId, body: unknown) => agentCall(app, "POST", `/artifacts/${artifact}/reviews`, apiKey, body);

const commentsOf = (itemId: string) => getDb().select().from(artifactComments).where(eq(artifactComments.itemId, itemId));
const draftsOf = (itemId: string) => getDb().select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.itemId, itemId));
const reviewsOf = (itemId: string) => getDb().select().from(artifactReviews).where(eq(artifactReviews.itemId, itemId));
const eventsOf = (itemId: string, eventKind: string) => getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, itemId), eq(objectEvents.eventKind, eventKind)));
const recipientsOf = async (eventId: string) => (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, eventId)))
  .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
const noticesTo = (world: World, agentId: string) => world.delivered.filter((entry) => entry.agentId === agentId).map((entry) => entry.message.app_event as ArtifactAgentAppEvent);
/** Nothing of a review was written: no comment, no review row, no review event, no notice. */
async function nothingWritten(world: World) {
  assert.equal((await commentsOf(world.site)).length, 0);
  assert.equal((await reviewsOf(world.site)).length, 0);
  assert.equal((await eventsOf(world.site, "review")).length, 0);
  assert.equal(world.delivered.length, 0);
}

// ---- drafts ----------------------------------------------------------------------

test("drafts are their author's alone: another member lists only their own and gets 404 DRAFT_NOT_FOUND for the draft; someone who can't see the Artifact 404 NOT_VISIBLE", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const made = await draft(app, world, world.who.reader, input([text("tighten "), mention(world.agentB, "agent")], { target: { scope: "file", path: "a.html", anchor: { type: "lines", data: { start: 1, end: 1 } } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const mine = made.body.draft;
  assert.deepEqual(Object.keys(mine).sort(), ["body", "createdAt", "expiresAt", "id", "replyTo", "target", "updatedAt", "version"]);
  assert.equal(mine.replyTo, null, "no replyTo sent (an older client): a comment of its own");
  assert.match(mine.id, /^[0-9a-f-]{36}$/);
  assert.equal(mine.body[1].actor.name, world.agentB.name);
  assert.deepEqual(mine.target, { scope: "file", path: "a.html", anchor: { type: "lines", data: { start: 1, end: 1 } } });
  assert.equal(Date.parse(mine.expiresAt) - Date.parse(mine.updatedAt), 30 * DAY);

  // The owner sees the Artifact, but not the reader's drafts.
  const theirs = await web(app, "GET", artifactWebPaths.reviewDrafts(world.site), world.who.owner);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.body, { drafts: [] });
  const missing = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, randomUUID() as never), world.who.owner, { body: [text("x")] });
  for (const res of [
    await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.owner, { body: [text("mine now")] }),
    await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.owner),
    // Even a body that would be refused: whose it is comes first.
    await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.owner, {}),
    // An id that isn't one.
    await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, "d_x" as never), world.who.owner),
  ]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, missing.body, "the same body as a draft that doesn't exist");
  }
  assert.equal(missing.body.code, "DRAFT_NOT_FOUND");
  // Discard all is the caller's own drafts only; submitting has none of theirs.
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDrafts(world.site), world.who.owner)).status, 204);
  assert.equal((await submit(app, world, world.who.owner)).body.code, "NO_DRAFTS");
  assert.equal((await draftsOf(world.site)).length, 1);

  // A member who can't see the Artifact: the one 404, on every draft route.
  for (const [method, path, body] of [
    ["GET", artifactWebPaths.reviewDrafts(world.site)],
    ["POST", artifactWebPaths.reviewDrafts(world.site), input([text("x")])],
    ["PATCH", artifactWebPaths.reviewDraft(world.site, mine.id), { body: [text("x")] }],
    ["DELETE", artifactWebPaths.reviewDraft(world.site, mine.id)],
    ["DELETE", artifactWebPaths.reviewDrafts(world.site)],
    ["POST", artifactWebPaths.reviewSubmit(world.site), { version: 1, summary: null }],
  ] as Array<[string, string, unknown?]>) {
    const res = await web(app, method, path, world.who.outsider, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.code, "NOT_VISIBLE", `${method} ${path}`);
  }

  // Its author edits its text (checked as a comment's: a mention who can't see it is refused) and deletes it.
  const refused = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.reader, { body: [text("hey "), mention(world.agentOut, "agent")] });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "MENTION_NOT_VISIBLE");
  const edited = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.reader, { body: [text("tighter")] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.draft.body, [text("tighter")]);
  assert.deepEqual(edited.body.draft.target, mine.target, "the place stays");
  const listed = await web(app, "GET", artifactWebPaths.reviewDrafts(world.site), world.who.reader);
  assert.deepEqual(listed.body.drafts, [edited.body.draft]);
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, mine.id), world.who.reader)).status, 204);
  assert.equal((await draftsOf(world.site)).length, 0);
});

test("at most 50 drafts per person and Artifact (the 51st 409 DRAFT_LIMIT); a draft expires 30 days after its last change, is left out, then purged", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const now = Date.now();
  // 49 in the table, then the 50th and 51st through the route.
  await getDb().insert(artifactCommentDrafts).values(Array.from({ length: 49 }, (_, index) => ({
    id: randomUUID(), itemId: world.site, authorId: world.reader.id, version: 1, path: null, anchor: null,
    body: [text(`note ${index}`)], createdAt: new Date(now - (60 - index) * 1000), updatedAt: new Date(now - (60 - index) * 1000),
  })));
  assert.equal((await draft(app, world, world.who.reader, input([text("fiftieth")]))).status, 201);
  const over = await draft(app, world, world.who.reader, input([text("fifty-first")]));
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "DRAFT_LIMIT");
  assert.deepEqual(over.body.details, { limit: 50 });
  // Another person's cap is their own.
  assert.equal((await draft(app, world, world.who.owner, input([text("mine")]))).status, 201);

  // Age by the last change: 26 days warns, 31 days is gone (and frees its place).
  const rows = (await draftsOf(world.site)).filter((row) => row.authorId === world.reader.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  await getDb().update(artifactCommentDrafts).set({ updatedAt: new Date(now - 26 * DAY) }).where(eq(artifactCommentDrafts.id, rows[0]!.id));
  await getDb().update(artifactCommentDrafts).set({ updatedAt: new Date(now - 31 * DAY) }).where(eq(artifactCommentDrafts.id, rows[1]!.id));
  const listed = await web(app, "GET", artifactWebPaths.reviewDrafts(world.site), world.who.reader);
  assert.equal(listed.body.drafts.length, 49);
  const warned = listed.body.drafts.find((entry: { id: string }) => entry.id === rows[0]!.id);
  // The web warns from day 25: four days left.
  assert.equal(Date.parse(warned.expiresAt), now - 26 * DAY + 30 * DAY);
  assert.ok(!listed.body.drafts.some((entry: { id: string }) => entry.id === rows[1]!.id), "an expired draft is not listed");
  assert.equal((await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, rows[1]!.id as never), world.who.reader, { body: [text("revive")] })).body.code, "DRAFT_NOT_FOUND");
  assert.equal((await draft(app, world, world.who.reader, input([text("in its place")]))).status, 201);

  // The purge deletes only what is past 30 days, by the clock it is given.
  assert.equal(await purgeExpiredArtifactDrafts({ now: new Date(now) }), 1);
  assert.equal((await getDb().select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.id, rows[1]!.id))).length, 0);
  assert.equal(await purgeExpiredArtifactDrafts({ now: new Date(now) }), 0);
  assert.equal(await purgeExpiredArtifactDrafts({ now: new Date(now + 5 * DAY) }), 1, "the 26-day-old one five days later");
});

// ---- submitting from the web ---------------------------------------------------------

test("submit: every draft becomes a comment in order, the summary last on the whole Artifact, the drafts go; one event and one notice per recipient; the same clientKey answers it again", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  for (const value of [
    input([text("first on a")]),
    input([text("ping "), mention(world.agentB, "agent")], { target: { scope: "file", path: "b.html", anchor: { type: "lines", data: { start: 2, end: 3 } } } }),
    input([text("whole thing")], { target: { scope: "artifact" } }),
  ]) {
    const res = await draft(app, world, world.who.reader, value);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const clientKey = randomUUID();
  const summary = [text("Looks close; cc "), mention(world.owner, "user")];
  const res = await submit(app, world, world.who.reader, { summary, clientKey });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "ok");
  const posted = res.body.comments;
  assert.deepEqual(posted.map((comment: { body: Array<{ text?: string }> }) => comment.body[0]!.text), ["first on a", "ping ", "whole thing", "Looks close; cc "]);
  assert.deepEqual(posted[1].target, { scope: "file", path: "b.html", anchor: { type: "lines", data: { start: 2, end: 3 } } });
  assert.deepEqual(posted[3].target, { scope: "artifact" });
  assert.equal(posted[3].body[1].actor.id, world.owner.id);
  const reviewId = asArtifactReviewId(posted[0].reviewId);
  assert.match(reviewId, /^[0-9a-f-]{36}$/);
  assert.ok(posted.every((comment: { reviewId: string }) => comment.reviewId === reviewId));

  // Stored at consecutive positions, the summary last; the drafts are gone.
  const rows = (await commentsOf(world.site)).sort((a, b) => a.position - b.position);
  assert.deepEqual(rows.map((row) => row.body), ["first on a", `ping @${world.agentB.name}`, "whole thing", `Looks close; cc @${world.owner.name}`]);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, world.site));
  assert.deepEqual(rows.map((row) => row.position), [item!.lastPosition - 3, item!.lastPosition - 2, item!.lastPosition - 1, item!.lastPosition]);
  assert.equal((await draftsOf(world.site)).length, 0);
  const [stored] = await reviewsOf(world.site);
  assert.equal(stored!.id, reviewId);
  assert.equal(stored!.summaryCommentId, rows[3]!.id);
  assert.equal(stored!.version, 1);

  // One object event for the whole review: the mentioned and the followers, never the reviewer.
  assert.equal((await eventsOf(world.site, "comment")).length, 0);
  const events = await eventsOf(world.site, "review");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.data, { review: reviewId, position: item!.lastPosition, comment: rows[0]!.id, version: 1, comments: 4 });
  assert.deepEqual(await recipientsOf(events[0]!.id), [`agent:${world.agentA.id}:owner`, `agent:${world.agentB.id}:mentioned`, `user:${world.owner.id}:mentioned`].sort());
  // The owner's Activity has one row for it, at that event.
  const inbox = await getDb().select().from(objectInboxStates).where(and(eq(objectInboxStates.userId, world.owner.id), eq(objectInboxStates.objectId, world.site)));
  assert.deepEqual(inbox.map((row) => row.lastEventId), [events[0]!.id]);
  // One notice each, at once: B mentioned, A (it follows) as a follower; no follower batch.
  assert.deepEqual(noticesTo(world, world.agentB.id).map((notice) => notice.reason), ["mentioned"]);
  assert.deepEqual(noticesTo(world, world.agentA.id).map((notice) => notice.reason), ["subscribed"]);
  assert.equal((await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, world.site))).length, 0);

  // Listed by review, on the web and for agents alike: the summary left out of the list, it is the review's body.
  const page = await web(app, "GET", artifactWebPaths.comments(world.site, { review: reviewId }), world.who.owner);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(page.body.comments.map((comment: { id: string }) => comment.id), rows.slice(0, 3).map((row) => row.id));
  assert.deepEqual(page.body.review, { id: reviewId, author: posted[3].author, body: posted[3].body, createdAt: stored!.createdAt.toISOString() });
  assert.equal(page.body.review.body[1].actor.id, world.owner.id, "the summary's mentions as actors, as a comment's");
  // Without `review` the page is as before: the summary is a comment of the list, with its reviewId, and no `review`.
  const whole = await web(app, "GET", artifactWebPaths.comments(world.site), world.who.owner);
  assert.deepEqual(whole.body.comments.map((comment: { id: string }) => comment.id), rows.map((row) => row.id));
  assert.equal(whole.body.comments[3].reviewId, reviewId);
  assert.equal("review" in whole.body, false);
  // An id that names no review of this Artifact: nothing listed, `review: null`.
  const unknownReview = await web(app, "GET", artifactWebPaths.comments(world.site, { review: asArtifactReviewId(randomUUID()) }), world.who.owner);
  assert.deepEqual(unknownReview.body, { comments: [], olderCursor: null, review: null });
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  const agentPage = await agentCall(app, "GET", `/artifacts/${world.site}/comments?review=${reviewId}`, world.keys.c);
  assert.equal(agentPage.status, 200, JSON.stringify(agentPage.body));
  assert.equal(agentPage.body.view, "all");
  assert.deepEqual(agentPage.body.comments.map((comment: { id: string }) => comment.id), rows.slice(0, 3).map((row) => row.id));
  assert.deepEqual(agentPage.body.review, { id: reviewId, author: { type: "user", name: world.reader.name }, version: 1, body: rows[3]!.body, createdAt: stored!.createdAt.toISOString() });

  // The same attempt again: the same comments, nothing new; the key with another summary is refused.
  const again = await submit(app, world, world.who.reader, { summary, clientKey });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, res.body);
  const reused = await submit(app, world, world.who.reader, { summary: [text("something else")], clientKey });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "CLIENT_KEY_REUSED");
  assert.equal((await commentsOf(world.site)).length, 4);
  assert.equal((await eventsOf(world.site, "review")).length, 1);
  assert.equal(world.delivered.length, 2);
  // Nothing left to submit under a new key.
  assert.equal((await submit(app, world, world.who.reader)).body.code, "NO_DRAFTS");
});

limitedTest("submit is one write whatever its drafts (each draft paid one when it was made): two drafts and their submit are three writes, one left, then refused; another person keeps their own", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  for (const n of [1, 2]) assert.equal((await draft(app, world, world.who.reader, input([text(`draft ${n}`)]))).status, 201);
  const res = await submit(app, world, world.who.reader);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.comments.length, 2);
  // Charged per draft, the submit would have spent the last write.
  assert.equal((await draft(app, world, world.who.reader, input([text("the fourth write")]))).status, 201);
  const refused = await web(app, "POST", artifactWebPaths.reviewDrafts(world.site), world.who.reader, input([text("one too many")]));
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "RATE_LIMITED");
  assert.equal(refused.body.error, "Too many artifact changes in a minute: wait a minute, then try the same change again.");
  assert.ok(refused.body.retryAfterSeconds >= 1 && refused.body.retryAfterSeconds <= 60);
  assert.equal((await draft(app, world, world.who.owner, input([text("the owner's")]))).status, 201, "another person's own budget");
});

test("one notice per recipient per review: five comments mentioning the same agent and person are one notice and one Activity event", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await draft(app, world, world.who.reader, input([text(`note ${index} `), mention(world.agentB, "agent"), mention(world.owner, "user")]))).status, 201);
  }
  const res = await submit(app, world, world.who.reader);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const toB = noticesTo(world, world.agentB.id);
  assert.equal(toB.length, 1);
  assert.equal(toB[0]!.reason, "mentioned");
  assert.equal(toB[0]!.comments!.count, 5);
  assert.equal(toB[0]!.comments!.latest.length, 5);
  assert.deepEqual({ ...toB[0]!.review, author: undefined }, { id: res.body.comments[0].reviewId, author: undefined, version: 1, commentCount: 5, fileCount: 1, mentionsYou: 5, summaryExcerpt: null });
  assert.deepEqual(toB[0]!.review!.author, { type: "user", name: world.reader.name });
  assert.equal(noticesTo(world, world.agentA.id).length, 1);
  // One event of any kind since the publish, and one recipient row for the person mentioned five times.
  const events = (await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, world.site))).filter((event) => event.eventKind !== "version");
  assert.deepEqual(events.map((event) => event.eventKind), ["review"]);
  const forOwner = (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.recipientId, world.owner.id)));
  assert.deepEqual(forOwner.map((row) => row.reason), ["mentioned"]);
});

test("all or nothing: a draft whose mention can no longer see it, or whose version was revoked, refuses the whole review naming it, and nothing is written", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const first = (await draft(app, world, world.who.reader, input([text("fine")]))).body.draft;
  const second = (await draft(app, world, world.who.reader, input([text("ask "), mention(world.agentC, "agent")]))).body.draft;
  await draft(app, world, world.who.reader, input([text("also fine")]));
  // C left #priv after the draft was made.
  await removeAgent(world.priv.id, world.agentC.id);
  const refused = await submit(app, world, world.who.reader, { summary: [text("summary")] });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, {
    status: "rejected", draftId: second.id, code: "MENTION_NOT_VISIBLE", error: MENTION_HIDDEN, details: { actors: [{ type: "agent", id: world.agentC.id }] },
  });
  await nothingWritten(world);
  assert.equal((await draftsOf(world.site)).length, 3, "the drafts stay");

  // Fix that one; then v2 is published and the first's version (v1) revoked: refused naming the first.
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, second.id), world.who.reader)).status, 204);
  assert.equal((await agentCall(app, "POST", "/artifacts/push", world.keys.a, { artifact: world.site, base: 1, files: [{ path: "a.html", content: "a2" }] })).status, 201);
  world.delivered.length = 0;
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(and(eq(artifactVersions.itemId, world.site), eq(artifactVersions.number, 1)));
  const revoked = await submit(app, world, world.who.reader, { version: 2 });
  assert.equal(revoked.status, 422);
  assert.deepEqual([revoked.body.status, revoked.body.draftId, revoked.body.code], ["rejected", first.id, "VERSION_NOT_FOUND"]);
  // Its details as ArtifactReviewRejected types them for the code: the draft's version and the current one.
  assert.deepEqual(revoked.body.details, { version: 1, currentVersion: 2 });
  await nothingWritten(world);

  // A summary refused is the review's: no draft named.
  await getDb().update(artifactVersions).set({ revokedAt: null }).where(eq(artifactVersions.itemId, world.site));
  const badSummary = await submit(app, world, world.who.reader, { version: 2, summary: [text("hey "), mention(world.agentOut, "agent")] });
  assert.deepEqual(badSummary.body, {
    status: "rejected", draftId: null, code: "MENTION_NOT_VISIBLE", error: MENTION_HIDDEN, details: { actors: [{ type: "agent", id: world.agentOut.id }] },
  });
  assert.equal(badSummary.status, 422);
  await nothingWritten(world);
  const longSummary = await submit(app, world, world.who.reader, { version: 2, summary: [text("x".repeat(ARTIFACT_COMMENT_MAX_CHARS + 1))] });
  assert.deepEqual([longSummary.status, longSummary.body.draftId, longSummary.body.code, longSummary.body.details], [422, null, "FIELD_TOO_LONG", { field: "body", limit: ARTIFACT_COMMENT_MAX_CHARS }]);
  await nothingWritten(world);
  // A version that isn't readable is the review's own refusal.
  assert.equal((await submit(app, world, world.who.reader, { version: 9 })).body.code, "VERSION_NOT_FOUND");
  await nothingWritten(world);
  assert.equal((await submit(app, world, world.who.reader, { version: 2 })).status, 201);
});

test("lost access: an author who can no longer see the Artifact since drafting is refused, and nothing is written", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await draft(app, world, world.who.reader, input([text("before I left")]))).status, 201);
  await removeHuman(world.priv.id, world.reader.id, { self: true });
  const res = await submit(app, world, world.who.reader);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_VISIBLE");
  await nothingWritten(world);
  assert.equal((await draftsOf(world.site)).length, 1);
});

// ---- reply drafts (xxchan, #proj-workspace:f07141a9) ------------------------------

/** The owner's posted comment on a.html, lines 2 to 3: a thread to reply to. */
async function ownerThread(app: { baseUrl: string }, world: World) {
  const res = await web(app, "POST", artifactWebPaths.comments(world.site), world.who.owner, {
    body: [text("is this right?")], version: 1, target: { scope: "file", path: "a.html", anchor: { type: "lines", data: { start: 2, end: 3 } } }, replyTo: null,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  world.delivered.length = 0;
  return res.body.comment as { id: string; target: unknown };
}
const replyInput = (replyTo: string, body: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, target: { scope: "artifact" }, body, replyTo, ...extra });

test("a reply draft: kept with its replyTo and no place of its own; its comment must be a live one of this Artifact; listed and edited as any draft", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await ownerThread(app, world);
  const made = await draft(app, world, world.who.reader, replyInput(thread.id, [text("yes, "), mention(world.agentB, "agent")]));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const reply = made.body.draft;
  assert.equal(reply.replyTo, thread.id);
  assert.deepEqual(reply.target, { scope: "artifact" }, "it takes its thread's place when posted");
  const [row] = await draftsOf(world.site);
  assert.deepEqual([row!.replyTo, row!.path, row!.anchor], [thread.id, null, null]);

  // A reply with a place of its own: 400; a comment that isn't one of this Artifact's, live: 404 COMMENT_NOT_FOUND.
  const placed = await draft(app, world, world.who.reader, replyInput(thread.id, [text("x")], { target: { scope: "file", path: "a.html", anchor: null } }));
  assert.deepEqual([placed.status, placed.body.code], [400, "INVALID_REQUEST"]);
  const nowhere = await draft(app, world, world.who.reader, replyInput("c_nope", [text("x")]));
  assert.deepEqual([nowhere.status, nowhere.body.code], [404, "COMMENT_NOT_FOUND"]);
  const other = await agentCall(app, "POST", "/artifacts/push", world.keys.a, { target: `#${world.priv.name}`, title: "Other", files: [{ path: "index.html", content: "<p>o</p>" }] });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const elsewhere = await web(app, "POST", artifactWebPaths.comments(asArtifactId(other.body.artifact.id)), world.who.owner, { body: [text("there")], version: 1, target: { scope: "artifact" }, replyTo: null });
  assert.equal(elsewhere.status, 201, JSON.stringify(elsewhere.body));
  const crossed = await draft(app, world, world.who.reader, replyInput(elsewhere.body.comment.id, [text("x")]));
  assert.deepEqual([crossed.status, crossed.body.code], [404, "COMMENT_NOT_FOUND"]);
  // Its body checked as a reply's: a mention who can't see it.
  const unseen = await draft(app, world, world.who.reader, replyInput(thread.id, [mention(world.agentOut, "agent")]));
  assert.deepEqual([unseen.status, unseen.body.code], [422, "MENTION_NOT_VISIBLE"]);
  assert.equal((await draftsOf(world.site)).length, 1);

  // Edited: its text; the reply stays.
  const edited = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, reply.id), world.who.reader, { body: [text("yes")] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.draft.replyTo, edited.body.draft.target], [thread.id, { scope: "artifact" }]);
  const listed = await web(app, "GET", artifactWebPaths.reviewDrafts(world.site), world.who.reader);
  assert.deepEqual(listed.body.drafts, [edited.body.draft]);
});

test("submit: a reply draft is posted as a reply to its thread, at the thread's place, in the review; told as a reply is (followers, mentions), one event", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await ownerThread(app, world);
  assert.equal((await draft(app, world, world.who.reader, input([text("a new thread")]))).status, 201);
  assert.equal((await draft(app, world, world.who.reader, replyInput(thread.id, [text("agreed, "), mention(world.agentB, "agent")]))).status, 201);
  const res = await submit(app, world, world.who.reader);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [fresh, posted] = res.body.comments;
  assert.equal(fresh.replyTo, null);
  assert.equal(posted.replyTo, thread.id);
  assert.deepEqual(posted.target, thread.target, "the thread's file and place");
  assert.equal(posted.reviewId, fresh.reviewId);
  const [stored] = (await commentsOf(world.site)).filter((row) => row.id === posted.id);
  assert.deepEqual([stored!.replyTo, stored!.path, stored!.anchor], [thread.id, "a.html", { type: "lines", data: { start: 2, end: 3 } }]);
  assert.equal((await draftsOf(world.site)).length, 0);

  // One review event: the mention and the followers (the thread's author follows it by commenting), as a single reply would tell them.
  const events = await eventsOf(world.site, "review");
  assert.equal(events.length, 1);
  assert.deepEqual(await recipientsOf(events[0]!.id), [`agent:${world.agentA.id}:owner`, `agent:${world.agentB.id}:mentioned`, `user:${world.owner.id}:following`].sort());
  assert.deepEqual(noticesTo(world, world.agentB.id).map((notice) => notice.reason), ["mentioned"]);
  assert.deepEqual(noticesTo(world, world.agentA.id).map((notice) => notice.reason), ["subscribed"]);

  // In the thread, for the web and agents alike.
  const page = await web(app, "GET", artifactWebPaths.comments(world.site), world.who.owner);
  assert.equal(page.body.comments.find((comment: { id: string }) => comment.id === posted.id).replyTo, thread.id);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  const agentPage = await agentCall(app, "GET", `/artifacts/${world.site}/comments?review=${posted.reviewId}`, world.keys.c);
  assert.equal(agentPage.body.comments.find((comment: { id: string }) => comment.id === posted.id).replyTo, thread.id);
});

test("a reply draft whose comment was deleted before submit refuses the review naming that draft (COMMENT_NOT_FOUND, no details), nothing written, never posted elsewhere; deleting that draft lets the rest go", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const thread = await ownerThread(app, world);
  assert.equal((await draft(app, world, world.who.reader, input([text("unrelated")]))).status, 201);
  const reply = (await draft(app, world, world.who.reader, replyInput(thread.id, [text("replying")]))).body.draft;
  // No posted replies: the comment goes outright (the draft's column has no foreign key, so the draft stays).
  assert.equal((await web(app, "DELETE", artifactWebPaths.comment(world.site, thread.id as never), world.who.owner)).status, 204);
  assert.equal((await commentsOf(world.site)).length, 0);
  assert.equal((await draftsOf(world.site)).length, 2);

  const refused = await submit(app, world, world.who.reader, { summary: [text("summary")] });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, { status: "rejected", draftId: reply.id, code: "COMMENT_NOT_FOUND", error: "That comment isn't there any more (it may have been deleted): reload the comments and try again." });
  await nothingWritten(world);
  assert.equal((await draftsOf(world.site)).length, 2, "the drafts stay");
  // Editing it says the same; the web offers deleting it.
  const edit = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, reply.id), world.who.reader, { body: [text("again")] });
  assert.deepEqual([edit.status, edit.body.code], [404, "COMMENT_NOT_FOUND"]);
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, reply.id), world.who.reader)).status, 204);
  const res = await submit(app, world, world.who.reader);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.comments.map((comment: { body: Array<{ text: string }>; replyTo: string | null }) => [comment.body[0]!.text, comment.replyTo]), [["unrelated", null]]);

  // A comment kept as a placeholder (it has replies) is no thread to reply to either.
  const second = await ownerThread(app, world);
  assert.equal((await web(app, "POST", artifactWebPaths.comments(world.site), world.who.owner, { body: [text("me too")], version: 1, target: { scope: "artifact" }, replyTo: second.id })).status, 201);
  const late = (await draft(app, world, world.who.reader, replyInput(second.id, [text("late")]))).body.draft;
  assert.equal((await web(app, "DELETE", artifactWebPaths.comment(world.site, second.id as never), world.who.owner)).status, 204);
  const placeholder = await submit(app, world, world.who.reader);
  assert.deepEqual([placeholder.status, placeholder.body.draftId, placeholder.body.code], [422, late.id, "COMMENT_NOT_FOUND"]);
});

// ---- an agent's review -------------------------------------------------------------

test("agent review: its comments in order, one notice per agent, reviewId on each; a refused comment refuses it with its own code, index and path; too many, a bad version, a lost Artifact", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  const before = await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: "earlier", path: "a.html" });
  assert.equal(before.status, 201);
  world.delivered.length = 0;
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.b);

  // Refusals first: nothing written by any of them.
  const missingFile = await agentReview(app, world.keys.b, world.site, { comments: [{ body: "ok", path: "a.html" }, { body: "where?", path: "nope.html" }] });
  assert.equal(missingFile.status, 404);
  assert.equal(missingFile.body.code, "FILE_NOT_FOUND");
  assert.deepEqual(missingFile.body.details, { path: "nope.html", version: 1, index: 1 });
  const badReply = await agentReview(app, world.keys.b, world.site, { comments: [{ body: "ok" }, { body: "ok" }, { body: "re", replyTo: "c_nope" }] });
  assert.equal(badReply.body.code, "COMMENT_NOT_FOUND");
  assert.deepEqual(badReply.body.details, { replyTo: "c_nope", index: 2, path: null });
  const tooMany = await agentReview(app, world.keys.b, world.site, { comments: Array.from({ length: 51 }, () => ({ body: "x" })) });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, "TOO_MANY_COMMENTS");
  assert.deepEqual(tooMany.body.details, { count: 51, limit: 50 });
  const badVersion = await agentReview(app, world.keys.b, world.site, { version: 9, comments: [{ body: "x" }] });
  assert.equal(badVersion.body.code, "VERSION_NOT_FOUND");
  assert.equal(badVersion.body.details.index, undefined, "the review's own refusal has no index");
  const longSummary = await agentReview(app, world.keys.b, world.site, { body: "x".repeat(8001), comments: [{ body: "x" }] });
  assert.equal(longSummary.body.code, "FIELD_TOO_LONG");
  assert.equal(longSummary.body.details.index, undefined);
  const outside = await agentReview(app, world.keys.out, world.site, { comments: [{ body: "x" }] });
  assert.equal(outside.body.code, "NOT_VISIBLE");
  assert.equal((await commentsOf(world.site)).length, 1);
  assert.equal((await reviewsOf(world.site)).length, 0);
  assert.equal(world.delivered.length, 0);

  const res = await agentReview(app, world.keys.b, world.site, {
    body: `Two notes, @${world.agentC.name}`,
    comments: [{ body: `fix this @${world.agentC.name}`, path: "b.html" }, { body: `and this @${world.agentC.name} @nobody-${label()}`, path: "b.html", anchor: { type: "html-region", data: { selector: "#x" } } }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.review.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...res.body.review, id: undefined, createdAt: undefined }, { id: undefined, author: { type: "agent", name: world.agentB.name }, version: 1, body: `Two notes, @${world.agentC.name}`, createdAt: undefined });
  assert.deepEqual(res.body.comments.map((comment: { path: string; reviewId: string }) => [comment.path, comment.reviewId]), [["b.html", res.body.review.id], ["b.html", res.body.review.id]]);
  // C mentioned three times (the summary once); A follows it. One notice each.
  assert.deepEqual(res.body.notified, [{ actor: { type: "agent", name: world.agentC.name }, reason: "mentioned" }, { actor: { type: "agent", name: world.agentA.name }, reason: "subscribed" }]);
  assert.equal(res.body.notNotified.length, 1);
  assert.equal(res.body.notNotified[0].reason, "unknown_name");
  assert.equal(res.body.newlySubscribed, true);
  const toC = noticesTo(world, world.agentC.id);
  assert.equal(toC.length, 1);
  assert.equal(toC[0]!.review!.mentionsYou, 3);
  assert.equal(toC[0]!.review!.commentCount, 2);
  assert.equal(toC[0]!.review!.fileCount, 1);
  assert.equal(toC[0]!.review!.summaryExcerpt, `Two notes, @${world.agentC.name}`);
  assert.equal(noticesTo(world, world.agentA.id).length, 1);
  assert.equal((await eventsOf(world.site, "review")).length, 1);

  // An unknown review lists nothing.
  const unknown = await agentCall(app, "GET", `/artifacts/${world.site}/comments?review=${randomUUID()}`, world.keys.a);
  assert.deepEqual([unknown.body.review, unknown.body.comments], [null, []]);

  // Lost access: B leaves #priv.
  await removeAgent(world.priv.id, world.agentB.id);
  const gone = await agentReview(app, world.keys.b, world.site, { comments: [{ body: "x" }] });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, "NOT_VISIBLE");
});

test("agent review: held once over every file it comments on (anything new when one is on the whole Artifact); the same request again goes through", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.b);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  // B stops following (it sticks), so C's comments aren't told to it (a notice marks nothing seen either way).
  assert.equal((await agentCall(app, "DELETE", `/artifacts/${world.site}/subscription`, world.keys.b)).status, 200);
  // C comments on a.html: a review of b.html isn't held by it.
  assert.equal((await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: "on a", path: "a.html" })).status, 201);
  const onB = await agentReview(app, world.keys.b, world.site, { comments: [{ body: "b1", path: "b.html" }] });
  assert.equal(onB.status, 201, JSON.stringify(onB.body));
  // C comments on b.html (having read B's review: told of it, C hasn't seen it): a review of a.html and b.html is held, once.
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  assert.equal((await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: "on b", path: "b.html" })).status, 201);
  const request = { comments: [{ body: "a2", path: "a.html" }, { body: "b2", path: "b.html" }] };
  const held = await agentReview(app, world.keys.b, world.site, request);
  assert.equal(held.status, 409);
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  // Both of C's comments since B last looked are on its files.
  assert.deepEqual(held.body.details.unseen.comments.map((comment: { excerpt: string }) => comment.excerpt), ["on a", "on b"]);
  const before = (await commentsOf(world.site)).length;
  assert.equal((await agentReview(app, world.keys.b, world.site, request)).status, 201);
  assert.equal((await commentsOf(world.site)).length, before + 2);
  // A comment on the whole Artifact: anything new from others holds it.
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  assert.equal((await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: "elsewhere", path: "index.html" })).status, 201);
  assert.equal((await agentReview(app, world.keys.b, world.site, { comments: [{ body: "b3", path: "b.html" }] })).status, 201);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  assert.equal((await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: "elsewhere again", path: "index.html" })).status, 201);
  assert.equal((await agentReview(app, world.keys.b, world.site, { comments: [{ body: "b4", path: "b.html" }, { body: "overall" }] })).body.code, "UNSEEN_CHANGES");
});

test("a review's notice marks nothing seen: the follower's publish is held by its short comments until a read, and by a long one until the comments are listed (Tenny)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  const readA = async () => (await getDb().select().from(artifactReadPositions).where(and(eq(artifactReadPositions.itemId, world.site), eq(artifactReadPositions.actorId, world.agentA.id))))[0]?.position ?? null;
  const before = await readA();
  const review = await agentReview(app, world.keys.c, world.site, { comments: [
    { body: "b is fine", path: "b.html" },
    { body: "y".repeat(AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS + 50), path: "a.html" },
  ] });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const [notice] = noticesTo(world, world.agentA.id);
  assert.deepEqual(notice!.comments!.latest.map((c) => c.truncated), [false, true]);
  assert.equal(await readA(), before, "the notice moved nothing, not even over the comment it showed whole");
  const [short, long] = review.body.comments as Array<{ id: string }>;
  const publishOn = (path: string) => agentCall(app, "POST", "/artifacts/push", world.keys.a, { artifact: world.site, base: 1, files: [{ path, content: `${path} 2` }] });
  // b.html's short comment holds a publish changing b.html.
  const onB = await publishOn("b.html");
  assert.equal(onB.status, 409, JSON.stringify(onB.body));
  assert.deepEqual(onB.body.details.unseen.comments.map((c: { id: string }) => c.id), [short!.id]);
  // A reads the Artifact: the short one counts as seen, the long one (cut short there too) doesn't.
  const pulled = await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.a);
  assert.equal(pulled.body.unseen.unread, 1);
  assert.equal((await publishOn("b.html")).status, 201);
  // Changing a.html is held by the long comment until A lists the comments, which shows it whole (task #71).
  const publishA = () => agentCall(app, "POST", "/artifacts/push", world.keys.a, { artifact: world.site, base: 2, files: [{ path: "a.html", content: "a2" }] });
  const onA = await publishA();
  assert.equal(onA.status, 409, JSON.stringify(onA.body));
  assert.equal(onA.body.code, "UNSEEN_CHANGES");
  assert.deepEqual(onA.body.details.unseen.comments.map((c: { id: string }) => c.id), [long!.id]);
  assert.equal(onA.body.details.unseen.unread, 1);
  assert.equal((await publishA()).status, 409);
  assert.equal((await agentCall(app, "GET", `/artifacts/${world.site}/comments`, world.keys.a)).status, 200);
  assert.equal((await publishA()).status, 201);
});

test("a review of more comments than its notice shows: those left out stay unread, so the follower's publish is still held (Tenny, Sage)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  const comments = Array.from({ length: AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN + 2 }, (_, index) => ({ body: `note ${index + 1}`, path: "a.html" }));
  const review = await agentReview(app, world.keys.c, world.site, { body: "short summary", comments });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const [notice] = noticesTo(world, world.agentA.id);
  assert.equal(notice!.comments!.count, comments.length);
  assert.equal(notice!.comments!.latest.length, AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN);
  assert.ok(notice!.comments!.latest.every((c) => !c.truncated), "every excerpt shown is whole");
  // The first comments aren't in the notice: unseen, so A's publish changing
  // a.html is held; the hold shows the newest few too, so it stays held
  // until A lists the comments in full (task #71).
  const publishA = () => agentCall(app, "POST", "/artifacts/push", world.keys.a, { artifact: world.site, base: 1, files: [{ path: "a.html", content: "a2" }] });
  const held = await publishA();
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.ok(held.body.details.unseen.unread > 0, JSON.stringify(held.body.details.unseen));
  assert.equal((await publishA()).status, 409);
  assert.equal((await agentCall(app, "GET", `/artifacts/${world.site}/comments`, world.keys.a)).status, 200);
  assert.equal((await publishA()).status, 201);
});

// ---- who an event is for ------------------------------------------------------------

test("a person who can't see the Artifact is never a recipient nor a stored mention: a comment or review mentioning them writes no recipient row, Activity row, ping or comments.mentions entry, and nothing shows (Activity, waiting, unread) once they can see it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const rooms: string[] = [];
  setActivityRealtimeIO({ to: (room: string) => ({ emit: () => { rooms.push(room); return true; } }) } as never);
  try {
    await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
    // The outsider is a member of the server, not of #priv: mentioned by handle, as agents write.
    const single = await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.c, { body: `@${world.outsider.name} look`, path: "a.html" });
    assert.equal(single.status, 201, JSON.stringify(single.body));
    const review = await agentReview(app, world.keys.c, world.site, {
      body: `cc @${world.reader.name}`,
      comments: [{ body: `@${world.outsider.name} and this`, path: "a.html" }],
    });
    assert.equal(review.status, 201, JSON.stringify(review.body));

    const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, world.site));
    const recipients = await getDb().select().from(objectEventRecipients).where(inArray(objectEventRecipients.eventId, events.map((event) => event.id)));
    assert.ok(!recipients.some((row) => row.recipientId === world.outsider.id), "no recipient row");
    // The reader, who sees it, is one (the summary mentions them): the filter keeps those who can.
    assert.ok(recipients.some((row) => row.recipientId === world.reader.id && row.reason === "mentioned"));
    const inboxOf = (userId: string) => getDb().select().from(objectInboxStates).where(and(eq(objectInboxStates.userId, userId), eq(objectInboxStates.objectId, world.site)));
    assert.equal((await inboxOf(world.outsider.id)).length, 0, "no Activity row");
    assert.equal((await inboxOf(world.reader.id)).length, 1);
    assert.ok(!rooms.includes(`user:${world.outsider.id}`), "no ping");
    assert.ok(rooms.includes(`user:${world.reader.id}`));

    // Nor is the mention kept on the comments: `waiting` and the unread mention count read them.
    const stored = await commentsOf(world.site);
    assert.ok(stored.some((row) => row.body.includes(`@${world.outsider.name}`)), "the text keeps what was written");
    assert.ok(stored.every((row) => !row.mentions.some((actor) => actor.id === world.outsider.id)), "no stored mention of who can't see it");
    assert.ok(stored.some((row) => row.mentions.some((actor) => actor.id === world.reader.id)), "one of who can is stored");

    // Joining #priv later shows nothing from before: no Activity, no `waiting`, no unread mention.
    await addHuman(world.priv.id, world.outsider.id);
    assert.equal((await inboxOf(world.outsider.id)).length, 0);
    assert.equal((await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.recipientId, world.outsider.id))).length, 0);
    const dashboard = await web(app, "GET", artifactWebPaths.dashboard(), world.who.outsider);
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.deepEqual(dashboard.body.waiting.rows, []);
    const unread = await artifactUnreadFor({ userId: world.outsider.id, serverId: world.server.id } as never, [world.site]);
    assert.deepEqual(unread.get(world.site), { following: false, unread: 0, parts: { versions: 0, comments: 0 } });
    // The reader, mentioned while they could see it, is waited on.
    const readerDashboard = await web(app, "GET", artifactWebPaths.dashboard(), world.who.reader);
    assert.deepEqual(readerDashboard.body.waiting.rows.map((row: { card: { id: string } }) => row.card.id), [world.site]);
  } finally {
    setActivityRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});

test("agent review with an idempotencyKey: the same request again answers the same review, nothing posted or told twice; another request under the key 409 IDEMPOTENCY_KEY_REUSED", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.b);
  const request = { body: "overall", comments: [{ body: `fix @${world.agentC.name}`, path: "a.html" }, { body: "and b", path: "b.html" }], idempotencyKey: "review-attempt-1" };
  const first = await agentReview(app, world.keys.b, world.site, request);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const delivered = world.delivered.length;
  assert.equal(delivered, 2, "C mentioned, A following");
  const again = await agentReview(app, world.keys.b, world.site, request);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.review, first.body.review);
  assert.deepEqual(again.body.comments, first.body.comments);
  assert.deepEqual([again.body.notified, again.body.notNotified], [[], []]);
  assert.equal(world.delivered.length, delivered, "no notice twice");
  assert.equal((await commentsOf(world.site)).length, 3);
  assert.equal((await reviewsOf(world.site)).length, 1);
  assert.equal((await eventsOf(world.site, "review")).length, 1);
  const other = await agentReview(app, world.keys.b, world.site, { ...request, body: "something else" });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "IDEMPOTENCY_KEY_REUSED");
  // The key is the agent's own: another agent's same key is its own review.
  await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.c);
  assert.equal((await agentReview(app, world.keys.c, world.site, request)).status, 201);
  assert.equal((await reviewsOf(world.site)).length, 2);
});
