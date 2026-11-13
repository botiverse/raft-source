// A conversation's Artifacts (its Files panel, webConversation.ts) over HTTP
// with real user tokens, at the path the shared contract builds
// (artifactWebPaths.conversationArtifacts): the live Artifacts homed in that
// conversation, newest first, each card exactly core's summary (the viewer's
// card); never another conversation's, a server-wide or public one only
// linked there, an unpublished, deleted or revoked one; a conversation the
// reader can't see now answers as one that doesn't exist; a thread means its
// conversation; a joint is asked by the reader's own projection and lists the
// joint's Artifacts of every server whose flag is on; 20 a page by keyset
// cursor; the flag off; the dashboard's rate limit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  ARTIFACT_CONVERSATION_PAGE_LIMIT,
  artifactWebPaths,
  asChannelId,
  asServerId,
  objectWebPaths,
  type ServerId,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { addHuman, getOrCreateThreadForChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { refusalBody } from "../../platform/refusals";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { TARGET_NOT_FOUND_ERROR } from "./apiCommon";
import { artifactItems, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.dashboard": 2 } });

const label = () => randomUUID().slice(0, 8);
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + second * 1000);

type Actor = { type: "user" | "agent"; id: string };

/** An Artifact; published (version 1, current) unless `unpublished`. */
async function artifact(input: {
  serverId: ServerId;
  author: Actor;
  homeChannelId?: string;
  serverHome?: boolean;
  updatedAt: Date;
  deleted?: boolean;
  revoked?: boolean;
  unpublished?: boolean;
}) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    description: null,
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
    updatedAt: input.updatedAt,
  });
  if (!input.unpublished) {
    const versionId = `v_${randomUUID()}`;
    await db.insert(artifactVersions).values({
      id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
      status: "published", publisherType: input.author.type, publisherId: input.author.id, position: 1,
    });
    await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1, updatedAt: input.updatedAt }).where(eq(artifactItems.id, id));
  }
  return { id };
}

/**
 * A server (Artifacts on unless `enabled: false`): #team (owner, reader), #secret
 * (owner only, private), and outsider, a member in neither. In #team, from
 * newest: `newer`, `older`; `unpublished`, `deleted`, `revoked` too; one in
 * #secret; a server-wide and a public one, both linked in a #team message.
 * A peer server whose owner is peerOwner.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const team = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `team-${label()}` });
  const secret = await seed.channel({ server, members: [owner], visibility: "private", name: `secret-${label()}` });
  const byOwner: Actor = { type: "user", id: owner.id };
  const items = {
    older: await artifact({ serverId, author: byOwner, homeChannelId: team.id, updatedAt: at(10) }),
    newer: await artifact({ serverId, author: { type: "user", id: reader.id }, homeChannelId: team.id, updatedAt: at(20) }),
    unpublished: await artifact({ serverId, author: byOwner, homeChannelId: team.id, updatedAt: at(30), unpublished: true }),
    deleted: await artifact({ serverId, author: byOwner, homeChannelId: team.id, updatedAt: at(31), deleted: true }),
    revoked: await artifact({ serverId, author: byOwner, homeChannelId: team.id, updatedAt: at(32), revoked: true }),
    secret: await artifact({ serverId, author: byOwner, homeChannelId: secret.id, updatedAt: at(33) }),
    serverWide: await artifact({ serverId, author: byOwner, serverHome: true, updatedAt: at(34) }),
    open: await artifact({ serverId, author: byOwner, updatedAt: at(35) }),
  };
  // Linked (sent) in #team, homed elsewhere: not #team's.
  const linked = await seed.message({ channel: team, author: owner, content: `see ${getAppUrl()}/artifacts/${items.serverWide.id} and ${getAppUrl()}/artifacts/${items.open.id}` });
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, serverId, peer, owner, reader, outsider, peerOwner, team, secret, items, linked,
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id), peerOwner: await as(peerOwner.id, peer.id) },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; headers: Headers; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (res.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : null };
}

const list = (app: { baseUrl: string }, who: Who, conversationId: string, cursor?: string) =>
  call(app, "GET", artifactWebPaths.conversationArtifacts(asChannelId(conversationId), cursor === undefined ? {} : { cursor }), who);
const idsOf = (body: { rows: Array<{ card: { id: string } }> }) => body.rows.map((row) => row.card.id);
const notFound = (conversationId: string) => refusalBody({ code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: { conversationId } });

test("a member gets the conversation's live Artifacts, newest first, each card core's summary; never another conversation's, one only linked there, unpublished, deleted or revoked; reads only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const res = await list(app, world.who.reader, world.team.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(res.body).sort(), ["nextCursor", "rows"]);
  assert.deepEqual(idsOf(res.body), [world.items.newer.id, world.items.older.id]);
  assert.equal(res.body.nextCursor, null);
  assert.deepEqual(res.body.rows[0].card.home, { kind: "conversation", conversation: { id: world.team.id, name: world.team.name, type: "private" } });

  // Each card is exactly the summary core answers for the same reader (the viewer's card), but the summaries' own `unseen`.
  const summaries = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: res.body.rows.map((row: { card: { id: string } }) => ({ id: row.card.id })) });
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body));
  assert.deepEqual(
    summaries.body.summaries.map((entry: { summary: Record<string, unknown> }) => Object.fromEntries(Object.entries(entry.summary).filter(([key]) => key !== "unseen"))),
    res.body.rows.map((row: { card: unknown }) => row.card),
  );

  // The owner sees #secret and gets its Artifact there, not #team's.
  const secret = await list(app, world.who.owner, world.secret.id);
  assert.equal(secret.status, 200, JSON.stringify(secret.body));
  assert.deepEqual(idsOf(secret.body), [world.items.secret.id]);
  assert.deepEqual(idsOf((await list(app, world.who.owner, world.team.id)).body), [world.items.newer.id, world.items.older.id]);

  // A thread means its conversation.
  const thread = await getOrCreateThreadForChannel(world.team.id, world.linked.id, world.owner.id, "user");
  const inThread = await list(app, world.who.reader, thread.id);
  assert.equal(inThread.status, 200, JSON.stringify(inThread.body));
  assert.deepEqual(idsOf(inThread.body), [world.items.newer.id, world.items.older.id]);
});

test("a conversation the reader can't see now is one 404 TARGET_NOT_FOUND, the same as one that doesn't exist, another server's, or an id that isn't one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerRoom = await seed.channel({ server: world.peer, members: [world.peerOwner], visibility: "channel", name: `peer-${label()}` });
  const unknown = randomUUID();
  const cases: Array<[string, Who, string]> = [
    ["a private conversation the reader isn't in", world.who.reader, world.secret.id],
    ["a member in neither conversation", world.who.outsider, world.team.id],
    ["no such conversation", world.who.reader, unknown],
    ["another server's conversation", world.who.reader, peerRoom.id],
    ["not an id", world.who.reader, "not-a-conversation"],
  ];
  for (const [why, who, conversationId] of cases) {
    const res = await list(app, who, conversationId);
    assert.equal(res.status, 404, why);
    assert.deepEqual(res.body, notFound(conversationId), why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  // A path segment that isn't valid percent-encoding names no conversation either.
  const undecodable = await call(app, "GET", "/api/artifacts/conversations/%E0%A4%A", world.who.reader);
  assert.equal(undecodable.status, 404);
  assert.equal(undecodable.body.code, "TARGET_NOT_FOUND");

  // Witnesses: the same readers where they are members; and the reader loses
  // #team when removed from it, though every Artifact there is unchanged.
  assert.equal((await list(app, world.who.owner, world.secret.id)).status, 200);
  assert.equal((await list(app, world.who.reader, world.team.id)).status, 200);
  await addHuman(world.secret.id, world.reader.id);
  assert.deepEqual(idsOf((await list(app, world.who.reader, world.secret.id)).body), [world.items.secret.id], "once a member");
});

test("a joint: asked by the reader's own projection, it lists the joint's Artifacts of every server, homed on the canonical channel or a projection, named by the reader's projection; only for its members", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `conv-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addHuman(peerProjection.id, peerMember.id);
  const byReader: Actor = { type: "user", id: world.reader.id };
  const canonicalHomed = await artifact({ serverId: world.serverId, author: byReader, homeChannelId: joint.canonical.id, updatedAt: at(40) });
  // Published before publish stored the canonical channel: homed on the server's projection.
  const projectionHomed = await artifact({ serverId: world.serverId, author: byReader, homeChannelId: hostProjection.id, updatedAt: at(41) });
  const peerHomed = await artifact({ serverId: asServerId(world.peer.id), author: { type: "user", id: peerMember.id }, homeChannelId: joint.canonical.id, updatedAt: at(42) });
  const deletedInJoint = await artifact({ serverId: world.serverId, author: byReader, homeChannelId: joint.canonical.id, updatedAt: at(43), deleted: true });
  const member: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };
  const all = [peerHomed.id, projectionHomed.id, canonicalHomed.id];

  const fromPeer = await list(app, member, peerProjection.id);
  assert.equal(fromPeer.status, 200, JSON.stringify(fromPeer.body));
  assert.deepEqual(idsOf(fromPeer.body), all);
  assert.ok(!idsOf(fromPeer.body).includes(deletedInJoint.id));
  for (const row of fromPeer.body.rows) {
    assert.deepEqual(row.card.home, { kind: "conversation", conversation: { id: peerProjection.id, name: peerProjection.name, type: "joint" } }, "by the reader's own projection");
  }
  const fromHost = await list(app, world.who.reader, hostProjection.id);
  assert.equal(fromHost.status, 200, JSON.stringify(fromHost.body));
  assert.deepEqual(idsOf(fromHost.body), all);
  assert.equal(fromHost.body.rows[0].card.home.conversation.id, hostProjection.id);

  // The canonical channel and the other server's projection are no conversation of the reader's server.
  for (const conversationId of [joint.canonical.id, hostProjection.id]) assert.deepEqual((await list(app, member, conversationId)).body, notFound(conversationId));
  // Members of either server outside the joint: the one 404.
  assert.deepEqual((await list(app, world.who.outsider, hostProjection.id)).body, notFound(hostProjection.id));
  assert.deepEqual((await list(app, world.who.peerOwner, peerProjection.id)).body, notFound(peerProjection.id));
});

test("20 a page, newest first, counting only what is listed; the next page by cursor; ties below a millisecond page by id, each once; a bad cursor is 400 before the conversation is looked at", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const expected: string[] = [];
  // 19 more in #team, the newest of all, interleaved with deleted ones there and ones in #secret.
  for (let index = 0; index < 19; index += 1) {
    const item = await artifact({ serverId: world.serverId, author: byOwner, homeChannelId: world.team.id, updatedAt: at(100 + 2 * index) });
    expected.unshift(item.id);
    await artifact({ serverId: world.serverId, author: byOwner, homeChannelId: world.secret.id, updatedAt: at(101 + 2 * index) });
    await artifact({ serverId: world.serverId, author: byOwner, homeChannelId: world.team.id, updatedAt: at(101 + 2 * index), deleted: true });
  }
  // Three whose times differ only below a millisecond (the cursor's
  // precision), older than those and newer than the seed's two: ordered by
  // id, and the first page ends among them.
  const ties: string[] = [];
  for (const micros of [100, 300, 200]) {
    const item = await artifact({ serverId: world.serverId, author: byOwner, homeChannelId: world.team.id, updatedAt: at(50) });
    await getDb().execute(sql`UPDATE ${artifactItems} SET updated_at = ${at(50).toISOString()}::timestamptz + make_interval(secs => ${micros / 1_000_000}::float8) WHERE id = ${item.id}`);
    ties.push(item.id);
  }
  expected.push(...[...ties].sort().reverse(), world.items.newer.id, world.items.older.id);
  assert.equal(expected.length, 24);
  assert.equal(ARTIFACT_CONVERSATION_PAGE_LIMIT, 20);

  const first = await list(app, world.who.reader, world.team.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(idsOf(first.body), expected.slice(0, 20));
  assert.ok(first.body.nextCursor);
  const second = await list(app, world.who.reader, world.team.id, first.body.nextCursor);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(idsOf(second.body), expected.slice(20));
  assert.equal(second.body.nextCursor, null);

  for (const [conversationId, cursor] of [
    [world.team.id, "not-a-cursor"],
    [world.team.id, Buffer.from(JSON.stringify(["never", "pt_x"])).toString("base64url")],
    [world.team.id, Buffer.from(JSON.stringify(["0000-01-01T00:00:00.000Z", `pt_${randomUUID()}`])).toString("base64url")],
    [world.team.id, Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", "x"])).toString("base64url")],
    [world.secret.id, "not-a-cursor"],
  ] as const) {
    const res = await list(app, world.who.reader, conversationId, cursor);
    assert.equal(res.status, 400, cursor);
    assert.equal(res.body.code, "INVALID_REQUEST", cursor);
  }
});

test("flag off: 403 ARTIFACTS_NOT_ENABLED before the query or the conversation, as every route", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  for (const [conversationId, cursor] of [[world.team.id, undefined], [world.secret.id, undefined], [randomUUID(), undefined], [world.team.id, "not-a-cursor"]] as const) {
    const res = await list(app, world.who.reader, conversationId, cursor);
    assert.equal(res.status, 403, conversationId);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", conversationId);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await call(app, "GET", "/api/artifacts/conversations/%E0%A4%A", world.who.reader)).body.code, "ARTIFACTS_NOT_ENABLED");
});

limitedTest("a conversation's Artifacts share the dashboard's per-user budget (429 RATE_LIMITED past it)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await call(app, "GET", artifactWebPaths.dashboard(), world.who.reader)).status, 200);
  assert.equal((await list(app, world.who.reader, world.team.id)).status, 200);
  const limited = await list(app, world.who.reader, world.team.id);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await list(app, world.who.owner, world.team.id)).status, 200, "another user's own budget");
});
