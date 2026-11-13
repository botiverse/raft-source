// The Artifacts page's All tab (webDashboard.ts `dashboardAll`, task #115)
// over HTTP with real user tokens, at the path the shared contract builds
// (artifactWebPaths.dashboardAll): every Artifact the reader can see in the
// current server, exactly what canViewArtifacts opens by id (but orphans,
// which only open by id): a private channel's only for its members, a DM's
// only for its two, server-wide and public ones, never a deleted, revoked or
// unpublished one, never another server's; each card core's summary (the
// viewer's card); newest update first only, a title search too; the `home`
// filter and `q` (Artifacts' title search) in the statement; 50 a page by
// keyset cursor; reads only; the request's refusals, the flag off, the
// dashboard's rate limit. Then the `author` filter (task #133) on the All
// tab and the sections (me, my agents, a person, an agent, several; never
// more than the reader sees), the authors route (`dashboardAuthors`: who
// wrote what the reader sees, the most first, `q`, its cap) and whose
// assistant an agent author is (`onBehalfOf`, never to an outsider). Then
// the order (`sort`, `dir`): by update, title or live comments, both ways,
// each by its own keyset cursor (another order's refused), the filters held;
// and the cards' publish-check screenshots (ArtifactPreview `screenshot`):
// the shown version's, only on a deployment with a check Worker, one query
// a page. Then the home page's one list
// (#proj-workspace:#210): `sort=opened`, a never-opened Artifact after the
// opened ones in both directions and across a page; `relevant=1`, every
// Artifact the reader is involved with (made, follows, mentioned on), read or
// not, what has news first and waiting first of all (#proj-workspace:#276); each row's
// `openedAt` and `news`, the same with the filter on or off; and `counts`.
// Then the `conversation` filter and the conversations route
// (#proj-workspace:#221): one conversation's Artifacts, the counts following;
// one the reader can't see the same empty page as one that doesn't exist; a
// joint by the reader's projection; a private channel's name never told.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT,
  ARTIFACT_DASHBOARD_AUTHORS_LIMIT,
  ARTIFACT_DASHBOARD_AUTHORS_MAX,
  ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  artifactWebPaths,
  asArtifactId,
  asObjectFileId,
  asServerId,
  objectWebPaths,
  type ArtifactDashboardAllDir,
  type ArtifactDashboardAllSort,
  type ArtifactDashboardAuthor,
  type ArtifactDashboardHome,
  type ArtifactDashboardSection,
  type ObjectFileId,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, channels } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV } from "../../services/agentCredentialService";
import { addHuman, findOrCreateDM, removeHuman } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { readableConversation, readableConversations } from "../../platform/conversations";
import { addMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { artifactComments, artifactItems, artifactReadPositions, artifactSubscriptions, artifactVersionChecks, artifactVersions } from "./schema";
import { indexArtifactSearch } from "./search";
import { canViewArtifacts } from "./visibility";
import { createArtifactWebApi } from "./webRoutes";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.dashboard": 2 } });

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-dashboard-all-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const label = () => randomUUID().slice(0, 8);
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + second * 1000);

type Actor = { type: "user" | "agent"; id: string };

/** An Artifact with its search row, as a publish leaves it; published (version 1, current) unless `unpublished`. */
async function artifact(input: {
  serverId: ServerId;
  title: string;
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
  const [item] = await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: input.title,
    description: null,
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
    updatedAt: input.updatedAt,
  }).returning();
  const versionId = input.unpublished ? null : `v_${randomUUID()}`;
  if (versionId) {
    await db.insert(artifactVersions).values({
      id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
      status: "published", publisherType: input.author.type, publisherId: input.author.id, position: 1,
    });
    await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1, updatedAt: input.updatedAt }).where(eq(artifactItems.id, id));
  }
  await indexArtifactSearch(db, item!);
  return { id, versionId };
}

/**
 * A server (flag on unless `enabled: false`): owner, reader and outsider
 * (a member in no channel); #team (owner, reader, private), #secret (owner
 * only, private), #doomed (owner, reader; hard-deleted once its Artifact
 * is made, so that one is an orphan); an agent with a DM with the reader and one with the
 * owner. Artifacts, oldest first: `older` and `newer` in #team, `secret`,
 * `serverWide`, `open` (public), `readerDm`, `ownerDm`, then `unpublished`,
 * `deleted` and `revoked` in #team and `orphan` in #doomed. A peer server
 * (flag on) the reader is a member of too, with its own Artifacts in every
 * kind of home, newer than all of those.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, members: [reader] });
  const peerId = asServerId(peer.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const team = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `team-${label()}` });
  const secret = await seed.channel({ server, members: [owner], visibility: "private", name: `secret-${label()}` });
  const doomed = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `doomed-${label()}` });
  const agent = await createAgent(server.id, `all-${label()}`, { runtime: "claude", model: "sonnet" });
  const readerDm = (await findOrCreateDM(server.id, reader.id, agent.id))!;
  const ownerDm = (await findOrCreateDM(server.id, owner.id, agent.id))!;
  const byOwner: Actor = { type: "user", id: owner.id };
  const byAgent: Actor = { type: "agent", id: agent.id };
  const items = {
    // Ranked first for "budget plan" (both words twice), yet older: the tab orders by update only.
    older: await artifact({ serverId, title: "Budget plan, budget plan", author: byOwner, homeChannelId: team.id, updatedAt: at(10) }),
    newer: await artifact({ serverId, title: "Budget plan for Q3", author: { type: "user", id: reader.id }, homeChannelId: team.id, updatedAt: at(20) }),
    secret: await artifact({ serverId, title: "Budget secret", author: byOwner, homeChannelId: secret.id, updatedAt: at(21) }),
    serverWide: await artifact({ serverId, title: "Roadmap for everyone here", author: byOwner, serverHome: true, updatedAt: at(22) }),
    open: await artifact({ serverId, title: "Budget review, public", author: byOwner, updatedAt: at(23) }),
    readerDm: await artifact({ serverId, title: "Notes for the reader", author: byAgent, homeChannelId: readerDm.id, updatedAt: at(24) }),
    ownerDm: await artifact({ serverId, title: "Budget notes for the owner", author: byAgent, homeChannelId: ownerDm.id, updatedAt: at(25) }),
    unpublished: await artifact({ serverId, title: "Budget unpublished", author: byOwner, homeChannelId: team.id, updatedAt: at(26), unpublished: true }),
    deleted: await artifact({ serverId, title: "Budget deleted", author: byOwner, homeChannelId: team.id, updatedAt: at(27), deleted: true }),
    revoked: await artifact({ serverId, title: "Budget revoked", author: byOwner, homeChannelId: team.id, updatedAt: at(28), revoked: true }),
    orphan: await artifact({ serverId, title: "Budget orphan", author: byOwner, homeChannelId: doomed.id, updatedAt: at(29) }),
  };
  // #doomed is hard-deleted: its Artifact is an orphan (home_channel_id SET NULL), which only opens by id.
  await getDb().delete(channels).where(eq(channels.id, doomed.id));
  const peerRoom = await seed.channel({ server: peer, members: [peerOwner, reader], visibility: "private", name: `peer-${label()}` });
  const byPeer: Actor = { type: "user", id: peerOwner.id };
  const peerItems = {
    room: await artifact({ serverId: peerId, title: "Budget of the peer", author: byPeer, homeChannelId: peerRoom.id, updatedAt: at(40) }),
    serverWide: await artifact({ serverId: peerId, title: "Budget peer-wide", author: byPeer, serverHome: true, updatedAt: at(41) }),
    open: await artifact({ serverId: peerId, title: "Budget peer public", author: byPeer, updatedAt: at(42) }),
  };
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, peer, serverId, peerId, owner, reader, outsider, peerOwner, agent, team, secret, doomed, peerRoom, readerDm, items, peerItems,
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id), readerInPeer: await as(reader.id, peer.id), peerOwner: await as(peerOwner.id, peer.id) },
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

const all = (app: { baseUrl: string }, who: Who, options: Parameters<typeof artifactWebPaths.dashboardAll>[0] = {}) =>
  call(app, "GET", artifactWebPaths.dashboardAll(options), who);

/** A page's Artifact ids, in order (a section's page in the dashboard's answer, or a section route's). */
const rowIdsOf = (page: { rows: Array<{ card: { id: string } }> }): string[] => page.rows.map((row) => row.card.id);

/** The rows' Artifact ids, in order (asserting a 200). */
function idsOf(reply: Reply): string[] {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.rows.map((row: { card: { id: string } }) => row.card.id);
}

const sorted = (ids: readonly string[]) => [...ids].sort();

test("every Artifact the reader can see, newest update first, each card core's summary; never a private channel it isn't in, another's DM, an unpublished, deleted or revoked one, an orphan or another server's; reads only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const res = await all(app, world.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(res.body).sort(), ["counts", "nextCursor", "rows"]);
  assert.deepEqual(Object.keys(res.body.rows[0]), ["card", "openedAt", "news"]);
  assert.deepEqual(idsOf(res), [items.readerDm.id, items.open.id, items.serverWide.id, items.newer.id, items.older.id]);
  assert.equal(res.body.nextCursor, null);
  const byId = new Map<string, any>(res.body.rows.map((row: { card: { id: string } }) => [row.card.id, row.card]));
  assert.deepEqual(byId.get(items.newer.id).home, { kind: "conversation", conversation: { id: world.team.id, name: world.team.name, type: "private" } });
  assert.deepEqual(byId.get(items.open.id).home, { kind: "public" });
  assert.deepEqual(byId.get(items.serverWide.id).home, { kind: "server" });
  assert.equal(byId.get(items.readerDm.id).home.conversation.type, "dm");
  assert.equal(byId.get(items.newer.id).version, 1);
  assert.equal(byId.get(items.newer.id).commentCount, 0);

  // Each card is exactly the summary core answers for the same reader (the viewer's card), but the summaries' own `unseen`.
  const summaries = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: res.body.rows.map((row: { card: { id: string } }) => ({ id: row.card.id })) });
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body));
  assert.deepEqual(
    summaries.body.summaries.map((entry: { summary: Record<string, unknown> }) => Object.fromEntries(Object.entries(entry.summary).filter(([key]) => key !== "unseen"))),
    res.body.rows.map((row: { card: unknown }) => row.card),
  );

  // A member in no channel: what the whole server and anyone with the link see.
  assert.deepEqual(idsOf(await all(app, world.who.outsider)), [items.open.id, items.serverWide.id]);
  // The owner: its own DM and #secret, never the reader's DM.
  const owner = idsOf(await all(app, world.who.owner));
  assert.deepEqual(owner, [items.ownerDm.id, items.open.id, items.serverWide.id, items.secret.id, items.newer.id, items.older.id]);
  // Only the request's server: the reader's peer server lists the peer's own, never this one's (and this one never the peer's).
  assert.deepEqual(idsOf(await all(app, world.who.readerInPeer)), [world.peerItems.open.id, world.peerItems.serverWide.id, world.peerItems.room.id]);

  // Exactly what canViewArtifacts opens by id, for each reader, but an orphan: it only opens by id.
  const rows = await getDb().select().from(artifactItems).where(inArray(artifactItems.id, Object.values(items).map((row) => row.id)));
  for (const [who, userId] of [["owner", world.owner.id], ["reader", world.reader.id], ["outsider", world.outsider.id]] as const) {
    const listed = idsOf(await all(app, world.who[who]));
    const opens = await canViewArtifacts({ type: "user", id: userId, serverId: world.serverId }, rows);
    // Unpublished: visible by id (its home is seen), never listed (no card).
    const expected = rows.filter((row, index) => opens[index] && row.id !== items.orphan.id && row.id !== items.unpublished.id).map((row) => row.id);
    assert.deepEqual(sorted(listed), sorted(expected), who);
    assert.ok(!listed.includes(items.orphan.id), `${who}: never an orphan`);
  }

  // Reads only: no read position moved for anyone.
  assert.deepEqual(await getDb().select().from(artifactReadPositions).where(inArray(artifactReadPositions.itemId, Object.values(items).map((row) => row.id))), []);
});

test("`home` narrows to one kind of home, by the same rule; an unknown home is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  assert.deepEqual(idsOf(await all(app, world.who.reader, { home: "channel" })), [items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { home: "dm" })), [items.readerDm.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { home: "server" })), [items.serverWide.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { home: "public" })), [items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { home: "channel" })), [items.secret.id, items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { home: "dm" })), [items.ownerDm.id]);
  for (const path of ["/api/artifacts/dashboard/all?home=nowhere", "/api/artifacts/dashboard/all?home=dm&home=public"]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }
});

test("`q` is Artifacts' title search, every word, by update time not rank; with `home` too; no words matches nothing, blank is none; one string of at most 200 characters", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  // "older" says both words twice (it ranks first), but "newer" is newer.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "budget plan" })), [items.newer.id, items.older.id]);
  // Visibility holds within the search: #secret and the owner's DM say "budget" too.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "Budget" })), [items.open.id, items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { q: "budget" })), [items.ownerDm.id, items.open.id, items.secret.id, items.newer.id, items.older.id]);
  // A prefix of three or more ASCII characters matches, as everywhere the title is searched.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "budg" })), [items.open.id, items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "budget", home: "public" })), [items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "budget", home: "dm" })), []);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "nowhere-in-a-title" })), []);
  // Only punctuation: no words, nothing matches; blank: no search at all.
  const punctuation = await all(app, world.who.reader, { q: "!!! ..." });
  assert.deepEqual(idsOf(punctuation), []);
  assert.equal(punctuation.body.nextCursor, null);
  assert.deepEqual(punctuation.body.counts, { total: 5, filtered: 0, relevant: 0 });
  assert.equal(idsOf(await all(app, world.who.reader, { q: "   " })).length, 5);

  for (const path of [
    artifactWebPaths.dashboardAll({ q: "x".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) }),
    "/api/artifacts/dashboard/all?q=a&q=b",
  ]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }
  // At the limit once trimmed: answered.
  assert.equal((await all(app, world.who.reader, { q: ` ${"x".repeat(WEB_SEARCH_QUERY_MAX_CHARS)} ` })).status, 200);
});

test("50 a page, newest first, counting only what is listed; the next page by cursor, with `home` and `q` too; ties below a millisecond page by id, each once; a bad cursor is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const newest: string[] = [];
  // 48 more in #team, the newest of all, interleaved with ones in #secret and deleted ones.
  for (let index = 0; index < 48; index += 1) {
    const item = await artifact({ serverId: world.serverId, title: `Paged item ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(100 + 2 * index) });
    newest.unshift(item.id);
    if (index < 10) {
      await artifact({ serverId: world.serverId, title: `Paged secret ${index}`, author: byOwner, homeChannelId: world.secret.id, updatedAt: at(101 + 2 * index) });
      await artifact({ serverId: world.serverId, title: `Paged deleted ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(101 + 2 * index), deleted: true });
    }
  }
  // Three whose times differ only below a millisecond (the cursor's
  // precision), older than those and newer than the seed's: ordered by id,
  // and the first page ends among them.
  const ties: string[] = [];
  for (const micros of [100, 300, 200]) {
    const item = await artifact({ serverId: world.serverId, title: "Paged tie", author: byOwner, homeChannelId: world.team.id, updatedAt: at(50) });
    await getDb().execute(sql`UPDATE ${artifactItems} SET updated_at = ${at(50).toISOString()}::timestamptz + make_interval(secs => ${micros / 1_000_000}::float8) WHERE id = ${item.id}`);
    ties.push(item.id);
  }
  const tiesInOrder = [...ties].sort().reverse();
  assert.equal(ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT, 50);

  const everything = [...newest, ...tiesInOrder, items.readerDm.id, items.open.id, items.serverWide.id, items.newer.id, items.older.id];
  assert.equal(everything.length, 56);
  const first = await all(app, world.who.reader);
  assert.deepEqual(idsOf(first), everything.slice(0, 50));
  assert.ok(first.body.nextCursor);
  const second = await all(app, world.who.reader, { cursor: first.body.nextCursor });
  assert.deepEqual(idsOf(second), everything.slice(50));
  assert.equal(second.body.nextCursor, null);

  // `home` pages within its homes.
  const inChannels = [...newest, ...tiesInOrder, items.newer.id, items.older.id];
  const channelsFirst = await all(app, world.who.reader, { home: "channel" });
  assert.deepEqual(idsOf(channelsFirst), inChannels.slice(0, 50));
  const channelsNext = await all(app, world.who.reader, { home: "channel", cursor: channelsFirst.body.nextCursor });
  assert.deepEqual(idsOf(channelsNext), inChannels.slice(50));
  assert.equal(channelsNext.body.nextCursor, null);

  // `q` pages by update time too: the 48 items and the 3 ties say "paged" (never #secret's or the deleted ones to the reader).
  const paged = [...newest, ...tiesInOrder];
  const searchFirst = await all(app, world.who.reader, { q: "paged" });
  assert.deepEqual(idsOf(searchFirst), paged.slice(0, 50));
  const searchNext = await all(app, world.who.reader, { q: "paged", cursor: searchFirst.body.nextCursor });
  assert.deepEqual(idsOf(searchNext), paged.slice(50));
  assert.equal(searchNext.body.nextCursor, null);

  for (const cursor of [
    "not-a-cursor",
    Buffer.from(JSON.stringify(["never", "pt_x"])).toString("base64url"),
    Buffer.from(JSON.stringify(["0000-01-01T00:00:00.000Z", `pt_${randomUUID()}`])).toString("base64url"),
    Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", "x"])).toString("base64url"),
    // A ranked search's cursor (digest and rank first) is no cursor of this list.
    Buffer.from(JSON.stringify(["0123456789abcdef", 0.1, "2026-01-01T00:00:00.000Z", `pt_${randomUUID()}`])).toString("base64url"),
  ]) {
    const res = await all(app, world.who.reader, { cursor });
    assert.equal(res.status, 400, cursor);
    assert.equal(res.body.code, "INVALID_REQUEST", cursor);
  }
});

test("flag off: 403 ARTIFACTS_NOT_ENABLED before the query, as every route; `all` is never taken for a section", async ({ app, seed }) => {
  const off = await seedWorld(seed, { enabled: false });
  for (const path of [
    artifactWebPaths.dashboardAll(),
    artifactWebPaths.dashboardAll({ q: "budget", home: "public" }),
    "/api/artifacts/dashboard/all?home=nowhere",
    artifactWebPaths.dashboardAll({ cursor: "not-a-cursor" }),
  ]) {
    const res = await call(app, "GET", path, off.who.reader);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", path);
    assert.equal(res.headers.get("cache-control"), "private, no-store", path);
  }
  // With the flag on, `/dashboard/all` is the All tab, not a section the sections route refuses.
  const on = await seedWorld(seed);
  const res = await all(app, on.who.reader);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.rows));
});

limitedTest("the All tab shares the dashboard's per-user budget (429 RATE_LIMITED past it)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await call(app, "GET", artifactWebPaths.dashboard(), world.who.reader)).status, 200);
  assert.equal((await all(app, world.who.reader)).status, 200);
  const limited = await all(app, world.who.reader);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await all(app, world.who.owner)).status, 200, "another user's own budget");
});

// ---- the `author` filter, the authors, onBehalfOf (task #133) ----------------

/**
 * Agents of the world's server, by who manages them (canManageObject's rule:
 * a personal assistant's owner, else its human creator): `mine`, made by the
 * reader; `assistant`, made by the owner and the reader's personal
 * assistant; `ownersAssistant`, made by the reader and the owner's
 * assistant; `deleted`, made by the reader and deleted. The world's own
 * `agent` was made by no one.
 */
async function agentsOf(world: Awaited<ReturnType<typeof seedWorld>>) {
  const make = (prefix: string, creatorId: string) =>
    createAgent(world.server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId });
  const mine = await make("mine", world.reader.id);
  const assistant = await make("pa", world.owner.id);
  await getDb().update(agents).set({ assistantOwnerUserId: world.reader.id }).where(eq(agents.id, assistant.id));
  const ownersAssistant = await make("opa", world.reader.id);
  await getDb().update(agents).set({ assistantOwnerUserId: world.owner.id }).where(eq(agents.id, ownersAssistant.id));
  const deleted = await make("gone", world.reader.id);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deleted.id));
  const actor = (agent: { id: string }): Actor => ({ type: "agent", id: agent.id });
  return { mine, assistant, ownersAssistant, deleted, by: { mine: actor(mine), assistant: actor(assistant), ownersAssistant: actor(ownersAssistant), deleted: actor(deleted) } };
}

/** The world with agentsOf's agents and their Artifacts: each in #team (the reader's), and `mineSecret` by `mine` in #secret (the owner's only). */
async function seedAuthors(seed: ReturnType<typeof createSeed>) {
  const world = await seedWorld(seed);
  const crew = await agentsOf(world);
  const inTeam = (title: string, author: Actor, second: number) => artifact({ serverId: world.serverId, title, author, homeChannelId: world.team.id, updatedAt: at(second) });
  const authored = {
    byMine: await inTeam("By my agent", crew.by.mine, 30),
    byAssistant: await inTeam("By my assistant", crew.by.assistant, 31),
    byOwnersAssistant: await inTeam("By the owner's assistant", crew.by.ownersAssistant, 32),
    byDeleted: await inTeam("By a deleted agent", crew.by.deleted, 33),
    mineSecret: await artifact({ serverId: world.serverId, title: "By my agent, secret", author: crew.by.mine, homeChannelId: world.secret.id, updatedAt: at(34) }),
  };
  return { ...world, crew, authored };
}

const author = {
  user: (id: string): ArtifactDashboardAuthor => `user:${id}`,
  agent: (id: string): ArtifactDashboardAuthor => `agent:${id}`,
};

test("`author` on the All tab: me, my agents (my assistant and the agents I made that are no one's assistant), a person, an agent, several as any of them; only what the reader sees", async ({ app, seed }) => {
  const world = await seedAuthors(seed);
  const { items, authored, crew } = world;
  const reader = world.who.reader;
  assert.deepEqual(idsOf(await all(app, reader, { author: ["me"] })), [items.newer.id]);
  // Not the owner's assistant the reader made, nor its deleted one; never #secret's.
  assert.deepEqual(idsOf(await all(app, reader, { author: ["my-agents"] })), [authored.byAssistant.id, authored.byMine.id]);
  // The owner's: its assistant only (it made the reader's assistant, which is the reader's now).
  assert.deepEqual(idsOf(await all(app, world.who.owner, { author: ["my-agents"] })), [authored.byOwnersAssistant.id]);
  // Someone else's, as the reader sees them: never #secret's.
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.user(world.owner.id)] })), [items.open.id, items.serverWide.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { author: [author.user(world.owner.id)] })), [items.open.id, items.serverWide.id, items.secret.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.agent(world.agent.id)] })), [items.readerDm.id], "never the owner's DM");
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.agent(crew.mine.id)] })), [authored.byMine.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { author: [author.agent(crew.mine.id)] })), [authored.mineSecret.id, authored.byMine.id]);
  // An id in any case.
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.agent(crew.mine.id.toUpperCase())] })), [authored.byMine.id]);
  // Several: any of them, each Artifact once.
  assert.deepEqual(idsOf(await all(app, reader, { author: ["me", author.agent(world.agent.id)] })), [items.readerDm.id, items.newer.id]);
  assert.deepEqual(idsOf(await all(app, reader, { author: ["me", "my-agents", author.user(world.reader.id)] })), [authored.byAssistant.id, authored.byMine.id, items.newer.id]);
  // No one, and my agents when I have none: nothing.
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.user(randomUUID())] })), []);
  assert.deepEqual(idsOf(await all(app, world.who.outsider, { author: ["my-agents"] })), []);
  // With `home` and `q` too.
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.user(world.owner.id)], home: "public" })), [items.open.id]);
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.user(world.owner.id)], q: "budget" })), [items.open.id, items.older.id]);
  // Only the request's server: the peer's own by the reader's peer server.
  assert.deepEqual(idsOf(await all(app, world.who.readerInPeer, { author: [author.user(world.peerOwner.id)] })), [world.peerItems.open.id, world.peerItems.serverWide.id, world.peerItems.room.id]);
  assert.deepEqual(idsOf(await all(app, reader, { author: [author.user(world.peerOwner.id)] })), []);
});

/** A live comment by `by` on the item's current version, mentioning `mentions`, after everything on it so far. */
async function comment(item: { id: string }, by: Actor, mentions: Actor[]) {
  const db = getDb();
  const [row] = await db.update(artifactItems).set({ lastPosition: sql`${artifactItems.lastPosition} + 1` }).where(eq(artifactItems.id, item.id)).returning();
  await db.insert(artifactComments).values({
    id: `c_${randomUUID()}`, itemId: item.id, versionId: row!.currentVersionId!, authorType: by.type, authorId: by.id, body: "look", mentions, position: row!.lastPosition,
  });
}

test("`author` on the sections, the first pages and the next one alike: only the Artifacts by those authors, never one the reader can't see however much it has on it", async ({ app, seed }) => {
  const world = await seedAuthors(seed);
  const { items, authored } = world;
  const me: Actor = { type: "user", id: world.reader.id };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  // In every section: read once, followed, then a comment by the owner that mentions the reader. #secret's too, as if it had seen it once.
  const concerned = [items.newer, items.older, items.readerDm, authored.byMine, authored.byAssistant, authored.byOwnersAssistant, authored.mineSecret];
  for (const item of concerned) {
    await getDb().insert(artifactReadPositions).values({ itemId: item.id, actorType: "user", actorId: me.id, position: 1, updatedAt: at(60) });
    await getDb().insert(artifactSubscriptions).values({ itemId: item.id, actorType: "user", actorId: me.id, reason: "followed" });
    await comment(item, byOwner, [me]);
  }
  const sections = ["waiting", "following", "recent"] as const satisfies readonly ArtifactDashboardSection[];
  const listed = async (options: { author?: readonly ArtifactDashboardAuthor[]; home?: ArtifactDashboardHome } = {}) => {
    const res = await call(app, "GET", artifactWebPaths.dashboard(options), world.who.reader);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return sections.map((section) => sorted(rowIdsOf(res.body[section])));
  };
  const each = (ids: readonly string[]) => sections.map(() => sorted(ids));
  assert.deepEqual(await listed(), each([items.newer.id, items.older.id, items.readerDm.id, authored.byMine.id, authored.byAssistant.id, authored.byOwnersAssistant.id]), "never #secret's");
  assert.deepEqual(await listed({ author: ["my-agents"] }), each([authored.byMine.id, authored.byAssistant.id]));
  assert.deepEqual(await listed({ author: ["me"] }), each([items.newer.id]));
  assert.deepEqual(await listed({ author: [author.user(world.owner.id), author.agent(world.agent.id)] }), each([items.older.id, items.readerDm.id]));
  assert.deepEqual(await listed({ author: [author.agent(world.crew.mine.id)] }), each([authored.byMine.id]), "not #secret's by the same agent");
  assert.deepEqual(await listed({ author: ["my-agents"], home: "dm" }), each([]));
  // One section's page, by the same filter.
  for (const section of sections) {
    const res = await call(app, "GET", artifactWebPaths.dashboardSection(section, { author: ["my-agents"] }), world.who.reader);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sorted(rowIdsOf(res.body)), sorted([authored.byMine.id, authored.byAssistant.id]), section);
  }
});

test("`author` refused: anything but me, my-agents, user:<uuid> or agent:<uuid>, or more than 20 of them, on every dashboard route (400 INVALID_REQUEST)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const bad = [
    "author=",
    "author=them",
    "author=ME",
    "author=me,my-agents",
    "author=user:not-a-uuid",
    `author=user:${randomUUID()}x`,
    "author=agent:",
    `author=group:${randomUUID()}`,
    `author=${randomUUID()}`,
    Array.from({ length: ARTIFACT_DASHBOARD_AUTHORS_MAX + 1 }, () => "author=me").join("&"),
  ];
  for (const base of ["/api/artifacts/dashboard", "/api/artifacts/dashboard/recent", "/api/artifacts/dashboard/all"]) {
    for (const params of bad) {
      const res = await call(app, "GET", `${base}?${params}`, world.who.reader);
      assert.equal(res.status, 400, `${base}?${params}`);
      assert.equal(res.body.code, "INVALID_REQUEST", `${base}?${params}`);
    }
    const most = await call(app, "GET", `${base}?${Array.from({ length: ARTIFACT_DASHBOARD_AUTHORS_MAX }, () => "author=me").join("&")}`, world.who.reader);
    assert.equal(most.status, 200, `${base}: ${ARTIFACT_DASHBOARD_AUTHORS_MAX} are answered`);
  }
});

const authorsOf = async (app: { baseUrl: string }, who: Who, q?: string) => {
  const res = await call(app, "GET", artifactWebPaths.dashboardAuthors(q === undefined ? {} : { q }), who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ["authors"]);
  return res.body.authors as Array<{ type: string; id: string; name: string; displayName: string; count: number; gone?: string; onBehalfOf?: unknown }>;
};
const countsOf = (authors: Awaited<ReturnType<typeof authorsOf>>) => authors.map((entry) => [entry.type, entry.id, entry.count]);

test("authors: who wrote the Artifacts the reader sees, each once with how many, the most first then by display name; only what it sees; `q` on the handle or display name, any case; at most 50", async ({ app, seed }) => {
  const world = await seedAuthors(seed);
  const { crew } = world;
  const more = await artifact({ serverId: world.serverId, title: "By my agent, again", author: crew.by.mine, homeChannelId: world.team.id, updatedAt: at(35) });
  assert.ok(more.id);
  // The reader: the owner's open, serverWide and older; mine's two in #team (not #secret's); then one each, by
  // display name: the deleted agent (no name), the world's agent (`all-…`, its DM with the reader), the reader
  // (`human-…`), the owner's assistant (`opa-…`) and the reader's (`pa-…`).
  const reader = await authorsOf(app, world.who.reader);
  assert.deepEqual(countsOf(reader), [
    ["user", world.owner.id, 3],
    ["agent", crew.mine.id, 2],
    ["agent", crew.deleted.id, 1],
    ["agent", world.agent.id, 1],
    ["user", world.reader.id, 1],
    ["agent", crew.ownersAssistant.id, 1],
    ["agent", crew.assistant.id, 1],
  ]);
  const ofReader = (id: string) => reader.find((entry) => entry.id === id)!;
  assert.deepEqual(ofReader(world.owner.id), { type: "user", id: world.owner.id, name: world.owner.name, displayName: world.owner.displayName, avatarUrl: null, count: 3 });
  assert.equal(ofReader(crew.deleted.id).gone, "deleted");
  // The owner: #secret and its own DM too, never the reader's DM.
  assert.deepEqual(countsOf(await authorsOf(app, world.who.owner)).slice(0, 2), [["user", world.owner.id, 4], ["agent", crew.mine.id, 3]]);
  assert.deepEqual(countsOf(await authorsOf(app, world.who.owner)).find(([, id]) => id === world.agent.id), ["agent", world.agent.id, 1]);
  // A member in no channel: the server-wide and public ones only.
  assert.deepEqual(countsOf(await authorsOf(app, world.who.outsider)), [["user", world.owner.id, 2]]);
  // Only the request's server.
  assert.deepEqual(countsOf(await authorsOf(app, world.who.readerInPeer)), [["user", world.peerOwner.id, 3]]);

  // `q`: contained in the handle or the display name, any case; trimmed; blank is none.
  assert.deepEqual(countsOf(await authorsOf(app, world.who.reader, " HUMAN-")), [["user", world.owner.id, 3], ["user", world.reader.id, 1]]);
  assert.deepEqual(countsOf(await authorsOf(app, world.who.reader, crew.mine.name.slice(2).toUpperCase())), [["agent", crew.mine.id, 2]]);
  assert.deepEqual(await authorsOf(app, world.who.reader, "no-one-is-called-this"), []);
  assert.equal((await authorsOf(app, world.who.reader, "   ")).length, 7);
  for (const path of [artifactWebPaths.dashboardAuthors({ q: "x".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) }), "/api/artifacts/dashboard/authors?q=a&q=b"]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }

  // At most 50: 50 more public ones, each by someone no longer here.
  for (let index = 0; index < ARTIFACT_DASHBOARD_AUTHORS_LIMIT; index += 1) {
    await artifact({ serverId: world.serverId, title: `By someone ${index}`, author: { type: "user", id: randomUUID() }, updatedAt: at(200 + index) });
  }
  const capped = await authorsOf(app, world.who.reader);
  assert.equal(capped.length, ARTIFACT_DASHBOARD_AUTHORS_LIMIT);
  assert.deepEqual(countsOf(capped).slice(0, 2), [["user", world.owner.id, 3], ["agent", crew.mine.id, 2]]);
});

test("onBehalfOf: a personal assistant author names whose it is, inside its server; never to a reader outside it, and never for an agent that is no one's assistant", async ({ app, seed }) => {
  const world = await seedAuthors(seed);
  const { crew, authored } = world;
  const reader = { id: world.reader.id, name: world.reader.name, displayName: world.reader.displayName ?? world.reader.name };
  const cardOf = (res: Reply, id: string) => res.body.rows.find((row: { card: { id: string } }) => row.card.id === id).card;
  const listed = await all(app, world.who.owner);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(cardOf(listed, authored.byAssistant.id).author.onBehalfOf, reader);
  const owner = { id: world.owner.id, name: world.owner.name, displayName: world.owner.displayName ?? world.owner.name };
  assert.deepEqual(cardOf(listed, authored.byOwnersAssistant.id).author.onBehalfOf, owner);
  assert.ok(!("onBehalfOf" in cardOf(listed, authored.byMine.id).author), "an agent that is no one's assistant");
  assert.ok(!("onBehalfOf" in cardOf(listed, world.items.older.id).author), "a person");
  // The authors and the cards in messages alike.
  assert.deepEqual((await authorsOf(app, world.who.reader)).find((entry) => entry.id === crew.assistant.id)!.onBehalfOf, reader);

  // A public one by the assistant: a member of its server is told whose it is; another server's reader is shown its name and avatar only.
  const open = await artifact({ serverId: world.serverId, title: "By my assistant, public", author: crew.by.assistant, updatedAt: at(40) });
  const summaryFor = async (who: Who) => {
    const res = await call(app, "POST", objectWebPaths.summaries(), who, { kind: "artifact", refs: [{ id: open.id }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.summaries[0].ok, true, JSON.stringify(res.body));
    return res.body.summaries[0].summary;
  };
  const inside = await summaryFor(world.who.outsider);
  assert.deepEqual(inside.author.onBehalfOf, reader);
  assert.equal(inside.author.id, crew.assistant.id);
  const outside = await summaryFor(world.who.peerOwner);
  assert.equal(outside.fromAnotherServer, true);
  assert.deepEqual(Object.keys(outside.author).sort(), ["avatarUrl", "displayName", "name", "type"]);
  assert.ok(!JSON.stringify(outside).includes(world.reader.id), "no one of that server by id");
});

limitedTest("the authors share the dashboard's per-user budget (429 RATE_LIMITED past it)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await all(app, world.who.reader)).status, 200);
  assert.equal((await call(app, "GET", artifactWebPaths.dashboardAuthors(), world.who.reader)).status, 200);
  const limited = await call(app, "GET", artifactWebPaths.dashboardAuthors(), world.who.reader);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
});

// ---- the order: `sort` and `dir` ----------------------------------------------

/** `live` comments by `by` on the item's current version, then `deleted` deleted ones, each after everything on it so far. */
async function commentsOn(item: { id: string }, by: Actor, live: number, deleted = 0) {
  const db = getDb();
  for (let index = 0; index < live + deleted; index += 1) {
    const [row] = await db.update(artifactItems).set({ lastPosition: sql`${artifactItems.lastPosition} + 1` }).where(eq(artifactItems.id, item.id)).returning();
    await db.insert(artifactComments).values({
      id: `c_${randomUUID()}`, itemId: item.id, versionId: row!.currentVersionId!, authorType: by.type, authorId: by.id, body: "note", mentions: [], position: row!.lastPosition,
      deletedAt: index < live ? null : new Date(),
    });
  }
}

/** Ids in JavaScript's order, as the database orders these (a fixed prefix, then hex and dashes at the same places). */
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

test("`sort`: by update (the default, newest first), title (any case, from A) or live comments (the most first), each in both directions and then by id; the card's own title and commentCount; with every filter", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const inTeam = (title: string, second: number) => artifact({ serverId: world.serverId, title, author: byOwner, homeChannelId: world.team.id, updatedAt: at(second) });
  // Titles that differ in case only (apple, appleAgain) tie, and so do their comment counts: by id.
  const z = {
    cherry: await inTeam("ZEBRA cherry", 60),
    apple: await inTeam("Zebra apple", 61),
    banana: await inTeam("zebra Banana", 62),
    appleAgain: await inTeam("zebra APPLE", 63),
    date: await inTeam("Zebra date", 64),
  };
  await commentsOn(z.cherry, byOwner, 5);
  // Deleted comments never count, as on the card.
  await commentsOn(z.apple, byOwner, 2, 3);
  await commentsOn(z.appleAgain, byOwner, 2);
  await commentsOn(z.date, byOwner, 1, 4);
  const apples = [z.apple, z.appleAgain].sort(byId).map((row) => row.id);
  const zebra = (options: Parameters<typeof artifactWebPaths.dashboardAll>[0] = {}) => all(app, world.who.reader, { q: "zebra", ...options });

  const newestFirst = [z.date.id, z.appleAgain.id, z.banana.id, z.apple.id, z.cherry.id];
  assert.deepEqual(idsOf(await zebra()), newestFirst);
  assert.deepEqual(idsOf(await zebra({ sort: "updated" })), newestFirst);
  assert.deepEqual(idsOf(await zebra({ sort: "updated", dir: "desc" })), newestFirst);
  assert.deepEqual(idsOf(await zebra({ dir: "asc" })), [...newestFirst].reverse(), "`dir` alone orders the default sort");
  assert.deepEqual(idsOf(await zebra({ sort: "updated", dir: "asc" })), [...newestFirst].reverse());

  const fromA = [...apples, z.banana.id, z.cherry.id, z.date.id];
  const byTitle = await zebra({ sort: "title" });
  assert.deepEqual(idsOf(byTitle), fromA);
  assert.deepEqual(byTitle.body.rows.map((row: { card: { title: string } }) => row.card.title.toLowerCase()), ["zebra apple", "zebra apple", "zebra banana", "zebra cherry", "zebra date"]);
  assert.deepEqual(idsOf(await zebra({ sort: "title", dir: "asc" })), fromA);
  assert.deepEqual(idsOf(await zebra({ sort: "title", dir: "desc" })), [...fromA].reverse());

  const mostFirst = [z.cherry.id, ...[...apples].reverse(), z.date.id, z.banana.id];
  const byComments = await zebra({ sort: "comments" });
  assert.deepEqual(idsOf(byComments), mostFirst);
  assert.deepEqual(byComments.body.rows.map((row: { card: { commentCount: number } }) => row.card.commentCount), [5, 2, 2, 1, 0], "the cards' own counts");
  assert.deepEqual(idsOf(await zebra({ sort: "comments", dir: "desc" })), mostFirst);
  assert.deepEqual(idsOf(await zebra({ sort: "comments", dir: "asc" })), [...mostFirst].reverse());

  // Visibility and the filters hold in every order: #secret's many comments never reach the reader, they lead for the owner.
  await commentsOn(items.secret, byOwner, 9);
  await commentsOn(items.deleted, byOwner, 9);
  await commentsOn(items.open, byOwner, 3);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "comments" })).slice(0, 2), [z.cherry.id, items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { sort: "comments" })).slice(0, 3), [items.secret.id, z.cherry.id, items.open.id]);
  assert.ok(!idsOf(await all(app, world.who.reader, { sort: "title" })).includes(items.secret.id));
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "comments", home: "public" })), [items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "title", author: ["me"] })), [items.newer.id]);
  assert.deepEqual(idsOf(await all(app, world.who.outsider, { sort: "comments", dir: "asc" })), [items.serverWide.id, items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "title", dir: "desc", home: "channel", q: "zebra cherry" })), [z.cherry.id]);
});

test("each order pages by its own keyset cursor (50, then the rest, each once, also within ties); a cursor of another `sort` or `dir` is 400", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const shelf: Array<{ id: string; title: string; comments: number; second: number }> = [];
  for (let index = 0; index < 53; index += 1) {
    // Titles out of update order, the last 13 repeating the first ones' (a tie: by id); 0 to 3 live comments.
    const title = `Shelf ${String((index * 7) % 40).padStart(2, "0")}`;
    const row = await artifact({ serverId: world.serverId, title, author: byOwner, homeChannelId: world.team.id, updatedAt: at(300 + index) });
    await commentsOn(row, byOwner, index % 4);
    shelf.push({ id: row.id, title: title.toLowerCase(), comments: index % 4, second: index });
  }
  const byTitle = (a: (typeof shelf)[number], b: (typeof shelf)[number]) => (a.title < b.title ? -1 : a.title > b.title ? 1 : byId(a, b));
  const orders = {
    "updated desc": [...shelf].sort((a, b) => b.second - a.second),
    "updated asc": [...shelf].sort((a, b) => a.second - b.second),
    "title asc": [...shelf].sort(byTitle),
    "title desc": [...shelf].sort((a, b) => byTitle(b, a)),
    "comments desc": [...shelf].sort((a, b) => b.comments - a.comments || byId(b, a)),
    "comments asc": [...shelf].sort((a, b) => a.comments - b.comments || byId(a, b)),
  } as const;
  const optionsOf = (order: keyof typeof orders) => {
    const [sort, dir] = order.split(" ") as [ArtifactDashboardAllSort, ArtifactDashboardAllDir];
    return { sort, dir };
  };
  const cursors = new Map<keyof typeof orders, string>();
  for (const order of Object.keys(orders) as Array<keyof typeof orders>) {
    const expected = orders[order].map((row) => row.id);
    const first = await all(app, world.who.reader, { q: "shelf", ...optionsOf(order) });
    assert.deepEqual(idsOf(first), expected.slice(0, ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT), order);
    assert.ok(first.body.nextCursor, order);
    cursors.set(order, first.body.nextCursor);
    const second = await all(app, world.who.reader, { q: "shelf", ...optionsOf(order), cursor: first.body.nextCursor });
    assert.deepEqual(idsOf(second), expected.slice(ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT), order);
    assert.equal(second.body.nextCursor, null, order);
  }
  // With `home` too, and the default order's cursor without `sort` or `dir`, or with them said.
  const channels = await all(app, world.who.reader, { q: "shelf", home: "channel", sort: "title" });
  assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "shelf", home: "channel", sort: "title", cursor: channels.body.nextCursor })), orders["title asc"].slice(50).map((row) => row.id));
  const plain = await all(app, world.who.reader, { q: "shelf" });
  assert.equal(plain.body.nextCursor, cursors.get("updated desc"));
  for (const options of [{}, { sort: "updated" }, { dir: "desc" }, { sort: "updated", dir: "desc" }] as const) {
    assert.deepEqual(idsOf(await all(app, world.who.reader, { q: "shelf", ...options, cursor: plain.body.nextCursor })), orders["updated desc"].slice(50).map((row) => row.id), JSON.stringify(options));
  }

  // A cursor pages only its own order: every other order refuses it.
  for (const [from, cursor] of cursors) {
    for (const order of Object.keys(orders) as Array<keyof typeof orders>) {
      if (order === from) continue;
      const res = await all(app, world.who.reader, { q: "shelf", ...optionsOf(order), cursor });
      assert.equal(res.status, 400, `${from}'s cursor with ${order}`);
      assert.equal(res.body.code, "INVALID_REQUEST", `${from}'s cursor with ${order}`);
    }
  }
  // `dir` alone changes the default order: its cursor is the plain one's no more.
  assert.equal((await all(app, world.who.reader, { q: "shelf", dir: "asc", cursor: plain.body.nextCursor })).status, 400);
});

test("`sort` and `dir` refused: anything but the contract's values, or either twice; a forged cursor of an order (its key not that order's) is 400; the flag first", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const params of ["sort=author", "sort=Title", "sort=", "sort=updated,title", "sort=title&sort=comments", "dir=up", "dir=ASC", "dir=", "dir=asc&dir=desc", "sort=title&dir=descending"]) {
    const res = await call(app, "GET", `/api/artifacts/dashboard/all?${params}`, world.who.reader);
    assert.equal(res.status, 400, params);
    assert.equal(res.body.code, "INVALID_REQUEST", params);
  }
  const id = `pt_${randomUUID()}`;
  const forged = (value: unknown[]) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const [options, cursor] of [
    [{ sort: "comments" }, forged(["comments", "desc", -1, id])],
    [{ sort: "comments" }, forged(["comments", "desc", 1.5, id])],
    [{ sort: "comments" }, forged(["comments", "desc", "3", id])],
    [{ sort: "comments" }, forged(["comments", "desc", 3])],
    [{ sort: "title" }, forged(["title", "asc", 5, id])],
    [{ sort: "title" }, forged(["title", "asc", "x".repeat(2001), id])],
    [{ sort: "title" }, forged(["title", "asc", "budget", "pt_x"])],
    [{ sort: "title" }, forged(["2026-01-01T00:00:00.000Z", id])],
    [{ dir: "asc" }, forged(["updated", "asc", "never", id])],
    [{ dir: "asc" }, forged(["updated", "asc", "0000-01-01T00:00:00.000Z", id])],
    // The default order takes only the plain cursor.
    [{}, forged(["updated", "desc", "2026-01-01T00:00:00.000Z", id])],
  ] as const) {
    const res = await all(app, world.who.reader, { ...options, cursor });
    assert.equal(res.status, 400, `${JSON.stringify(options)} ${cursor}`);
    assert.equal(res.body.code, "INVALID_REQUEST", `${JSON.stringify(options)} ${cursor}`);
  }
  // A well-formed one of the order asked is a place in it: after the public one's title and id, the reader's titles from A.
  const after = await all(app, world.who.reader, { sort: "title", cursor: forged(["title", "asc", "budget review, public", world.items.open.id]) });
  assert.deepEqual(idsOf(after), [world.items.readerDm.id, world.items.serverWide.id]);

  const off = await seedWorld(seed, { enabled: false });
  for (const path of ["/api/artifacts/dashboard/all?sort=author", artifactWebPaths.dashboardAll({ sort: "title", dir: "desc" })]) {
    const res = await call(app, "GET", path, off.who.reader);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", path);
  }
});

// ---- the home page's one list (#proj-workspace:#210) ---------------------------

/** A comment by `by` at the item's next position, mentioning `mentions`; deleted when asked. It moves the item's update time to now, as a real comment does (comments.ts). */
async function noteOn(item: { id: string }, by: Actor, mentions: Actor[] = [], opts: { deleted?: boolean } = {}) {
  const db = getDb();
  const [row] = await db.update(artifactItems).set({ lastPosition: sql`${artifactItems.lastPosition} + 1`, updatedAt: sql`now()` }).where(eq(artifactItems.id, item.id)).returning();
  await db.insert(artifactComments).values({
    id: `c_${randomUUID()}`, itemId: item.id, versionId: row!.currentVersionId!, authorType: by.type, authorId: by.id, body: "look", mentions, position: row!.lastPosition,
    deletedAt: opts.deleted ? new Date() : null,
  });
}

/** The actor's read position on the item, as the viewer leaves it: through all of it so far (or at `position`), last moved at `when`. */
async function openedBy(item: { id: string }, actor: Actor, when: Date, position?: number) {
  const db = getDb();
  const [row] = await db.select({ last: artifactItems.lastPosition }).from(artifactItems).where(eq(artifactItems.id, item.id));
  const values = { position: position ?? row!.last, updatedAt: when };
  await db.insert(artifactReadPositions).values({ itemId: item.id, actorType: actor.type, actorId: actor.id, ...values })
    .onConflictDoUpdate({ target: [artifactReadPositions.itemId, artifactReadPositions.actorType, artifactReadPositions.actorId], set: values });
}

async function followedBy(item: { id: string }, actor: Actor, opts: { stopped?: boolean } = {}) {
  await getDb().insert(artifactSubscriptions).values({ itemId: item.id, actorType: actor.type, actorId: actor.id, reason: "followed", unsubscribedAt: opts.stopped ? new Date() : null });
}

const noNews = { mentions: 0, versions: 0, comments: 0 };

/** The ids newest update first, at the millisecond the list orders by, then by id: as a segment of `relevant` orders them. */
async function byUpdate(rows: ReadonlyArray<{ id: string }>): Promise<string[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const found = await getDb().select({ id: artifactItems.id, updatedAt: artifactItems.updatedAt }).from(artifactItems).where(inArray(artifactItems.id, ids));
  return found.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || byId(b, a)).map((row) => row.id);
}

/** A new version by `by`, published at the item's next position and current, as a publish leaves it. */
async function publishedBy(item: { id: string }, by: Actor) {
  const db = getDb();
  const [row] = await db.update(artifactItems).set({ lastPosition: sql`${artifactItems.lastPosition} + 1` }).where(eq(artifactItems.id, item.id)).returning();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(artifactVersions).where(eq(artifactVersions.itemId, item.id)) as [{ n: number }];
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: item.id, number: Number(n) + 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
    status: "published", publisherType: by.type, publisherId: by.id, position: row!.lastPosition,
  });
  await db.update(artifactItems).set({ currentVersionId: versionId }).where(eq(artifactItems.id, item.id));
}

/** Each row's `field`, by Artifact id. */
const fieldOf = (reply: Reply, field: "news" | "openedAt"): Map<string, unknown> =>
  new Map(reply.body.rows.map((row: { card: { id: string }; news: unknown; openedAt: unknown }) => [row.card.id, row[field]]));

/**
 * The reader of seedWorld, with something of each kind. `serverWide`, never
 * opened: followed and mentioned. `older`, never opened: mentioned, not
 * followed. `open`, opened: followed, 2 new comments. `newer`, opened and
 * followed: only the reader's own since. `readerDm`, opened: 3 new comments
 * but not followed (following stopped), and mentions that don't count.
 * `secret`: followed, mentioned, not visible to the reader.
 */
async function seedNews(world: Awaited<ReturnType<typeof seedWorld>>) {
  const { items } = world;
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const agent: Actor = { type: "agent", id: world.agent.id };
  await followedBy(items.serverWide, me);
  await noteOn(items.serverWide, owner, [me]);
  await noteOn(items.older, owner, [me]);
  await noteOn(items.older, agent, [me]);
  await followedBy(items.open, me);
  await openedBy(items.open, me, at(90));
  await commentsOn(items.open, owner, 2);
  await followedBy(items.newer, me);
  await openedBy(items.newer, me, at(100));
  await noteOn(items.newer, me, [me]);
  await noteOn(items.readerDm, owner, [me]);
  await openedBy(items.readerDm, me, at(101));
  await followedBy(items.readerDm, me, { stopped: true });
  await commentsOn(items.readerDm, agent, 3);
  await noteOn(items.readerDm, owner, [me], { deleted: true });
  await followedBy(items.secret, me);
  await noteOn(items.secret, owner, [me]);
}

test("`sort=opened`: what the reader opened, the latest first, then what it never opened by update, in both directions; each row says when; only this reader's opens; `sort` left out stays the update order", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const me: Actor = { type: "user", id: world.reader.id };
  await openedBy(items.older, me, at(100));
  await openedBy(items.open, me, at(200));
  // Someone else's open is theirs: the owner's list moves, the reader's doesn't, and no row doubles.
  await openedBy(items.newer, { type: "user", id: world.owner.id }, at(300));
  await openedBy(items.open, { type: "user", id: world.owner.id }, at(50));

  const res = await all(app, world.who.reader, { sort: "opened" });
  assert.deepEqual(idsOf(res), [items.open.id, items.older.id, items.readerDm.id, items.serverWide.id, items.newer.id]);
  const opened = fieldOf(res, "openedAt");
  assert.equal(opened.get(items.open.id), at(200).toISOString());
  assert.equal(opened.get(items.older.id), at(100).toISOString());
  assert.equal(opened.get(items.newer.id), null);
  assert.equal(opened.get(items.readerDm.id), null);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "opened", dir: "asc" })), [items.older.id, items.open.id, items.newer.id, items.serverWide.id, items.readerDm.id]);
  assert.deepEqual(idsOf(await all(app, world.who.owner, { sort: "opened" })).slice(0, 3), [items.newer.id, items.open.id, items.ownerDm.id]);
  // With the filters too.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "opened", q: "budget", home: "channel" })), [items.older.id, items.newer.id]);

  // The default is what it was, and each row still says when it was opened.
  const plain = await all(app, world.who.reader);
  assert.deepEqual(idsOf(plain), [items.readerDm.id, items.open.id, items.serverWide.id, items.newer.id, items.older.id]);
  assert.equal(fieldOf(plain, "openedAt").get(items.open.id), at(200).toISOString());
});

test("`sort=opened` pages by keyset across the never-opened: a page ending on the last opened one, a page ending among the never-opened, ties below a millisecond, both directions, each row once; counts only on the first page", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const me: Actor = { type: "user", id: world.reader.id };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const shelf: Array<{ id: string; second: number }> = [];
  for (let index = 0; index < 53; index += 1) {
    const row = await artifact({ serverId: world.serverId, title: `Shelf ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(300 + index) });
    shelf.push({ id: row.id, second: index });
  }
  const pagesOf = async (dir: ArtifactDashboardAllDir) => {
    const first = await all(app, world.who.reader, { q: "shelf", sort: "opened", dir });
    assert.ok(first.body.nextCursor, dir);
    assert.deepEqual(first.body.counts, { total: 58, filtered: 53, relevant: 0 }, dir);
    const second = await all(app, world.who.reader, { q: "shelf", sort: "opened", dir, cursor: first.body.nextCursor });
    assert.equal(second.body.nextCursor, null, dir);
    assert.equal(second.body.counts, null, dir);
    return { first: idsOf(first), second: idsOf(second) };
  };
  const expectOrder = async (dir: ArtifactDashboardAllDir, opened: typeof shelf, never: typeof shelf) => {
    const sign = dir === "desc" ? -1 : 1;
    const expected = [
      ...[...opened].sort((a, b) => sign * (a.second - b.second)),
      ...[...never].sort((a, b) => sign * (a.second - b.second)),
    ].map((row) => row.id);
    const pages = await pagesOf(dir);
    assert.deepEqual([...pages.first, ...pages.second], expected, dir);
    assert.equal(pages.first.length, ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT, dir);
  };

  // 47 opened, the open times running with the update times: page one ends among the 6 never-opened.
  for (const row of shelf.slice(0, 47)) await openedBy(row, me, at(1000 + row.second));
  await expectOrder("desc", shelf.slice(0, 47), shelf.slice(47));
  await expectOrder("asc", shelf.slice(0, 47), shelf.slice(47));
  // 50 opened: page one ends on the last opened one, and page two starts on the first never-opened.
  for (const row of shelf.slice(47, 50)) await openedBy(row, me, at(1000 + row.second));
  await expectOrder("desc", shelf.slice(0, 50), shelf.slice(50));
  await expectOrder("asc", shelf.slice(0, 50), shelf.slice(50));

  // Opened within one millisecond, and no update apart: ordered and paged by id, each once.
  const [x, y, z] = shelf.slice(0, 50).sort(byId);
  await getDb().update(artifactItems).set({ updatedAt: at(2000) }).where(inArray(artifactItems.id, [x!.id, y!.id, z!.id]));
  for (const [row, micros] of [[x!, "111"], [y!, "999"], [z!, "500"]] as const) {
    await getDb().update(artifactReadPositions).set({ updatedAt: sql`${`2026-02-01 00:00:00.123${micros}+00`}::timestamptz` }).where(eq(artifactReadPositions.itemId, row.id));
  }
  await getDb().update(artifactReadPositions).set({ updatedAt: at(0) })
    .where(and(eq(artifactReadPositions.actorId, world.reader.id), notInArray(artifactReadPositions.itemId, [x!.id, y!.id, z!.id])));
  const first = await all(app, world.who.reader, { q: "shelf", sort: "opened" });
  assert.deepEqual(idsOf(first).slice(0, 3), [z!.id, y!.id, x!.id]);
  // The row says the time at the precision the cursor carries.
  assert.equal(fieldOf(first, "openedAt").get(x!.id), "2026-02-01T00:00:00.123Z");
});

test("`relevant=1`: every Artifact the reader is involved with, read or not (made, follows, mentioned on), what has news first, waiting first, then the rest by update, whatever `sort` says; never what the reader can't see, a stopped follow, a deleted or own mention, or the unrelated; every row's `news`, the same with the filter off", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  await seedNews(world);
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const ownerDm = await findOrCreateDM(world.server.id, world.owner.id, world.agent.id);
  // Visible to the reader, and nothing of theirs: no author, a follow stopped, a mention deleted, a mention of someone else, its own mention.
  const unrelated = await artifact({ serverId: world.serverId, title: "Unrelated", author: owner, serverHome: true, updatedAt: at(30) });
  await followedBy(unrelated, owner);
  await noteOn(unrelated, owner, [owner]);
  const stopped = await artifact({ serverId: world.serverId, title: "Stopped", author: owner, serverHome: true, updatedAt: at(31) });
  await followedBy(stopped, me, { stopped: true });
  const unmentioned = await artifact({ serverId: world.serverId, title: "Unmentioned", author: owner, serverHome: true, updatedAt: at(32) });
  await noteOn(unmentioned, owner, [me], { deleted: true });
  await noteOn(unmentioned, me, [me]);
  // The reader's own, in a DM it isn't in: still not listed.
  await artifact({ serverId: world.serverId, title: "Mine, out of sight", author: me, homeChannelId: ownerDm!.id, updatedAt: at(33) });

  const on = await all(app, world.who.reader, { relevant: true });
  // News first: waiting (`serverWide`, `older`), then `open`'s new comments; then read or nothing new, by update:
  // `readerDm` (mentioned, read; its follow stopped), `newer` (the reader's own, followed, read). Each by update (a comment moves it).
  assert.deepEqual(idsOf(on), [...await byUpdate([items.serverWide, items.older]), items.open.id, ...await byUpdate([items.readerDm, items.newer])]);
  assert.deepEqual(on.body.counts, { total: 8, filtered: 5, relevant: 3 });
  const news = fieldOf(on, "news");
  // Never opened, so the version is new too (the `following` rule); one row, though it is in both.
  assert.deepEqual(news.get(items.serverWide.id), { mentions: 1, versions: 1, comments: 1 });
  assert.deepEqual(news.get(items.older.id), { mentions: 2, versions: 0, comments: 0 });
  assert.deepEqual(news.get(items.open.id), { mentions: 0, versions: 0, comments: 2 });
  assert.deepEqual(news.get(items.readerDm.id), noNews);
  assert.deepEqual(news.get(items.newer.id), noNews);

  // The filter's order is its own: `sort` and `dir` are checked, and order nothing.
  for (const options of [{ sort: "opened" }, { sort: "updated" }, { sort: "title", dir: "desc" }, { sort: "comments", dir: "asc" }] as const) {
    assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, ...options })), idsOf(on), JSON.stringify(options));
  }

  // The sections agree on the news: the same definition.
  const sections = await call(app, "GET", artifactWebPaths.dashboard(), world.who.reader);
  assert.equal(sections.status, 200, JSON.stringify(sections.body));
  assert.deepEqual(sorted(rowIdsOf(sections.body.waiting)), sorted([items.serverWide.id, items.older.id]));
  assert.deepEqual(sorted(rowIdsOf(sections.body.following)), sorted([items.serverWide.id, items.open.id]));

  // Off: everything, the same news on the same cards, nothing on the rest (`readerDm` has new comments, but the reader doesn't follow it).
  const off = await all(app, world.who.reader, { sort: "opened" });
  assert.deepEqual(sorted(idsOf(off)), sorted([...idsOf(on), unrelated.id, stopped.id, unmentioned.id]));
  assert.deepEqual(off.body.counts, { total: 8, filtered: 8, relevant: 3 });
  const offNews = fieldOf(off, "news");
  for (const id of idsOf(on)) assert.deepEqual(offNews.get(id), news.get(id), id);

  // Opening clears the news, not the involvement: `older` stays, among the read, and leaves N.
  await openedBy(items.older, me, at(400));
  const after = await all(app, world.who.reader, { relevant: true });
  assert.deepEqual(idsOf(after), [items.serverWide.id, items.open.id, ...await byUpdate([items.readerDm, items.newer, items.older])]);
  assert.deepEqual(after.body.counts, { total: 8, filtered: 5, relevant: 2 });
  assert.deepEqual(fieldOf(after, "news").get(items.older.id), noNews);

  // Read everything: the list is the same Artifacts, by update alone, and N is 0.
  for (const item of [items.serverWide, items.open]) await openedBy(item, me, at(500));
  const read = await all(app, world.who.reader, { relevant: true });
  assert.deepEqual(idsOf(read), await byUpdate([items.readerDm, items.open, items.serverWide, items.newer, items.older]));
  assert.deepEqual(read.body.counts, { total: 8, filtered: 5, relevant: 0 });

  // Involved with nothing: an empty list (the page's empty state), the counts still saying what there is.
  const quiet = await all(app, world.who.outsider, { relevant: true });
  assert.deepEqual(idsOf(quiet), []);
  assert.deepEqual(quiet.body.counts, { total: 5, filtered: 0, relevant: 0 });
});

test("`relevant=1` each way in: made it (published v1, or only v2, or by an agent the reader created), follows it (read), mentioned on it (read); never by someone else's agent, a deleted agent, or where the reader can't see; leaving the channel takes out what it made and followed there", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const me: Actor = { type: "user", id: world.reader.id };
  const owner: Actor = { type: "user", id: world.owner.id };
  const outsider: Actor = { type: "user", id: world.outsider.id };
  const viaAuthor = await artifact({ serverId: world.serverId, title: "Made by me", author: me, serverHome: true, updatedAt: at(50) });
  const viaFollow = await artifact({ serverId: world.serverId, title: "Followed", author: owner, homeChannelId: world.team.id, updatedAt: at(51) });
  await followedBy(viaFollow, me);
  await openedBy(viaFollow, me, at(60));
  const viaMention = await artifact({ serverId: world.serverId, title: "Mentioned", author: owner, homeChannelId: world.team.id, updatedAt: at(52) });
  await noteOn(viaMention, outsider, [me]);
  await openedBy(viaMention, me, at(61));
  // The owner made it; the reader published only v2 (and follows nothing, is mentioned nowhere).
  const viaV2 = await artifact({ serverId: world.serverId, title: "My v2", author: owner, homeChannelId: world.team.id, updatedAt: at(53) });
  await publishedBy(viaV2, me);
  // A version the reader published and was revoked is not "made it".
  const revokedV2 = await artifact({ serverId: world.serverId, title: "My revoked v2", author: owner, serverHome: true, updatedAt: at(54) });
  await publishedBy(revokedV2, me);
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(and(eq(artifactVersions.itemId, revokedV2.id), eq(artifactVersions.number, 2)));
  await getDb().update(artifactItems).set({ currentVersionId: revokedV2.versionId }).where(eq(artifactItems.id, revokedV2.id));
  // Agents: one the reader created, one the owner created (the seeded one), one the reader created and deleted.
  const mine = await createAgent(world.server.id, `mine-${label()}`, { runtime: "claude", model: "sonnet" });
  const gone = await createAgent(world.server.id, `gone-${label()}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ creatorType: "user", creatorId: world.reader.id }).where(inArray(agents.id, [mine.id, gone.id]));
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  await getDb().update(agents).set({ creatorType: "user", creatorId: world.owner.id }).where(eq(agents.id, world.agent.id));
  const viaMyAgent = await artifact({ serverId: world.serverId, title: "By my agent", author: { type: "agent", id: mine.id }, serverHome: true, updatedAt: at(55) });
  await artifact({ serverId: world.serverId, title: "By the owner's agent", author: { type: "agent", id: world.agent.id }, serverHome: true, updatedAt: at(56) });
  await artifact({ serverId: world.serverId, title: "By my deleted agent", author: { type: "agent", id: gone.id }, serverHome: true, updatedAt: at(57) });
  // My agent in #secret, which the agent may see and the reader can't: never listed for the reader.
  await artifact({ serverId: world.serverId, title: "By my agent, out of sight", author: { type: "agent", id: mine.id }, homeChannelId: world.secret.id, updatedAt: at(58) });
  // The seeded `newer` is the reader's too, in #team.
  const expected = await byUpdate([viaMyAgent, viaV2, viaMention, viaFollow, viaAuthor, world.items.newer]);

  const on = await all(app, world.who.reader, { relevant: true });
  assert.deepEqual(idsOf(on), expected);
  for (const id of expected) assert.deepEqual(fieldOf(on, "news").get(id), noNews, id);
  assert.deepEqual(on.body.counts, { total: 13, filtered: 6, relevant: 0 });
  // Its narrowing still applies: the #team ones.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, home: "channel" })), await byUpdate([viaV2, viaMention, viaFollow, world.items.newer]));

  // The reader is removed from #team: what it made (created or published), followed and was mentioned on there leaves the list and the counts.
  await removeHuman(world.team.id, world.reader.id, { self: true });
  const left = await all(app, world.who.reader, { relevant: true });
  assert.deepEqual(idsOf(left), [viaMyAgent.id, viaAuthor.id]);
  assert.deepEqual(left.body.counts, { total: 8, filtered: 2, relevant: 0 });
});

test("`counts`: total is everything the reader can see whatever was asked; filtered and relevant keep `home`, `author` and `q`", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await seedNews(world);
  const countsOf = async (options: Parameters<typeof artifactWebPaths.dashboardAll>[0]) => {
    const res = await all(app, world.who.reader, options);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.counts;
  };
  assert.deepEqual(await countsOf({}), { total: 5, filtered: 5, relevant: 3 });
  // `older` and `newer` in #team, the first waiting.
  assert.deepEqual(await countsOf({ home: "channel" }), { total: 5, filtered: 2, relevant: 1 });
  // With the filter on, `filtered` is what it lists: everything involved (`newer` is the reader's own), news or not.
  assert.deepEqual(await countsOf({ relevant: true }), { total: 5, filtered: 5, relevant: 3 });
  assert.deepEqual(await countsOf({ home: "channel", relevant: true }), { total: 5, filtered: 2, relevant: 1 });
  assert.deepEqual(await countsOf({ home: "public" }), { total: 5, filtered: 1, relevant: 1 });
  assert.deepEqual(await countsOf({ home: "dm" }), { total: 5, filtered: 1, relevant: 0 });
  // `older`, `newer` and `open` are about the budget.
  assert.deepEqual(await countsOf({ q: "budget" }), { total: 5, filtered: 3, relevant: 2 });
  assert.deepEqual(await countsOf({ q: "budget", relevant: true }), { total: 5, filtered: 3, relevant: 2 });
  assert.deepEqual(await countsOf({ q: "nowhere-in-a-title" }), { total: 5, filtered: 0, relevant: 0 });
  // The reader wrote `newer`, the owner `older`, `serverWide` and `open`.
  assert.deepEqual(await countsOf({ author: ["me"] }), { total: 5, filtered: 1, relevant: 0 });
  assert.deepEqual(await countsOf({ author: [`user:${world.owner.id}`] }), { total: 5, filtered: 3, relevant: 3 });
  assert.deepEqual(await countsOf({ author: [`user:${world.owner.id}`], home: "server", q: "roadmap" }), { total: 5, filtered: 1, relevant: 1 });
  // The sorts count the same.
  assert.deepEqual(await countsOf({ sort: "comments" }), { total: 5, filtered: 5, relevant: 3 });
  // Another server's, by its own reader: nothing of this one.
  assert.deepEqual((await all(app, world.who.readerInPeer)).body.counts, { total: 3, filtered: 3, relevant: 0 });
});

test("`relevant=1` pages by keyset: waiting, then other news, then the read, across pages; a page ending among the read and one ending on the last with news, each row once; counts only on the first page", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const me: Actor = { type: "user", id: world.reader.id };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const shelf: Array<{ id: string }> = [];
  for (let index = 0; index < 53; index += 1) {
    shelf.push(await artifact({ serverId: world.serverId, title: `Shelf ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(300 + index) }));
  }
  // Every third waits; the next is followed and new (never opened: its version); the next followed and read. So the update order alone would mix them.
  const waiting = shelf.filter((_, index) => index % 3 === 0);
  const followedNew = shelf.filter((_, index) => index % 3 === 1);
  const read = shelf.filter((_, index) => index % 3 === 2);
  for (const row of waiting) await noteOn(row, byOwner, [me]);
  for (const row of [...followedNew, ...read]) await followedBy(row, me);
  for (const row of read) await openedBy(row, me, at(900));
  // `newer`, the reader's own (read: nothing new), is the oldest of the read.
  const newer = world.items.newer;
  const walk = async (relevantCount: number) => {
    const first = await all(app, world.who.reader, { relevant: true });
    assert.deepEqual(first.body.counts, { total: 58, filtered: 54, relevant: relevantCount });
    assert.equal(first.body.rows.length, ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT);
    assert.ok(first.body.nextCursor);
    const second = await all(app, world.who.reader, { relevant: true, cursor: first.body.nextCursor });
    assert.equal(second.body.counts, null);
    assert.equal(second.body.nextCursor, null);
    return [...idsOf(first), ...idsOf(second)];
  };
  const newestFirst = (rows: Array<{ id: string }>) => [...rows].reverse().map((row) => row.id);
  // 18 waiting, 18 new, then 17 read and `newer`: page one ends among the read.
  // The waiting ones were commented on, which moved them to now: by that update.
  assert.deepEqual(await walk(36), [...await byUpdate(waiting), ...newestFirst(followedNew), ...newestFirst(read), newer.id]);
  // 14 of the read get a new comment: 50 with news, so page one ends on the last of them and page two is the read.
  const renewed = read.slice(3);
  for (const row of renewed) await commentsOn(row, byOwner, 1);
  const withNews = shelf.filter((row) => followedNew.includes(row) || renewed.includes(row));
  const stillRead = read.slice(0, 3);
  const pages = await walk(50);
  assert.deepEqual(pages, [...await byUpdate(waiting), ...newestFirst(withNews), ...newestFirst(stillRead), newer.id]);
  assert.deepEqual(pages.slice(ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT), [...newestFirst(stillRead), newer.id]);
});

test("`relevant=1` across pages: a read between pages moves an Artifact down, never skips it; one shown comes back once lower (the web drops it), one not shown yet is listed once; news arriving since lifts nothing past the cursor", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const me: Actor = { type: "user", id: world.reader.id };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const make = async (title: string, second: number) => artifact({ serverId: world.serverId, title, author: byOwner, homeChannelId: world.team.id, updatedAt: at(second) });
  const waiting: Array<{ id: string }> = [];
  for (let index = 0; index < 20; index += 1) waiting.push(await make(`Waiting ${index}`, 300 + index));
  for (const row of waiting) await noteOn(row, byOwner, [me]);
  const news: Array<{ id: string }> = [];
  for (let index = 0; index < 40; index += 1) news.push(await make(`New ${index}`, 400 + index));
  for (const row of news) await followedBy(row, me);
  const read: Array<{ id: string }> = [];
  for (let index = 0; index < 5; index += 1) read.push(await make(`Read ${index}`, 500 + index));
  for (const row of read) {
    await followedBy(row, me);
    await openedBy(row, me, at(900));
  }
  // Remy's case: followed, an old mention it has read, one plain comment it hasn't; long ago, so last of the other news.
  const x = await make("Old mention, new comment", 1);
  await followedBy(x, me);
  await noteOn(x, byOwner, [me]);
  await openedBy(x, me, at(900));
  await commentsOn(x, byOwner, 1);
  // One that waits, last of the waiting: shown on page one.
  const w = waiting[0]!;
  await getDb().update(artifactItems).set({ updatedAt: at(2) }).where(inArray(artifactItems.id, [x.id, w.id]));
  const newer = world.items.newer;

  const first = await all(app, world.who.reader, { relevant: true });
  assert.deepEqual(first.body.counts, { total: 71, filtered: 67, relevant: 61 });
  // 20 waiting, then 30 of the 41 with other news: `x`, the oldest of them, is not shown yet.
  const tier1 = [...[...news].reverse().map((row) => row.id), x.id];
  assert.deepEqual(idsOf(first), [...await byUpdate(waiting), ...tier1.slice(0, 30)]);
  assert.equal(idsOf(first).at(19), w.id);

  // Between the pages (real times: the cursor's moment is the database's clock): both are read, and news arrives on a read one.
  const later = () => new Date(Date.now() + 5);
  await openedBy(x, me, later());
  await openedBy(w, me, later());
  await commentsOn(read[0]!, byOwner, 1);
  const second = await all(app, world.who.reader, { relevant: true, cursor: first.body.nextCursor });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.nextCursor, null);
  // The rest of the other news, then everything with nothing new as of the first page, `x` and `w` lowered among it.
  // `read[0]`'s new comment came after the first page: it stays with the read.
  assert.deepEqual(idsOf(second), [...tier1.slice(30, 40), ...await byUpdate([...read, newer, x, w])]);
  const pages = [...idsOf(first), ...idsOf(second)];
  assert.equal(pages.filter((id) => id === x.id).length, 1, "x listed exactly once");
  assert.equal(pages.filter((id) => id === w.id).length, 2, "w comes back once, lower (the web keeps the first)");
  assert.deepEqual(sorted([...new Set(pages)]), sorted([...waiting, ...news, ...read, x, newer].map((row) => row.id)), "nothing skipped");
});

test("`relevant` refused: anything but 1, or twice; a cursor pages only its own list; a forged `opened` or `relevant` cursor is 400, a well-formed one a place; the flag first", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const me: Actor = { type: "user", id: world.reader.id };
  for (const params of ["relevant=0", "relevant=true", "relevant=", "relevant=1&relevant=1"]) {
    const res = await call(app, "GET", `/api/artifacts/dashboard/all?${params}`, world.who.reader);
    assert.equal(res.status, 400, params);
    assert.equal(res.body.code, "INVALID_REQUEST", params);
  }
  const id = `pt_${randomUUID()}`;
  const when = at(1).toISOString();
  const forged = (value: unknown[]) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const place = { relevant: forged(["relevant", "desc", when, 1, 1, when, id]), opened: forged(["opened", "desc", when, when, id]), never: forged(["opened", "desc", null, when, id]), plain: forged([when, id]) };
  // Each list's cursor is no other's.
  for (const [options, cursor] of [
    [{}, place.relevant],
    [{ sort: "opened" }, place.relevant],
    [{ relevant: true }, place.opened],
    [{ relevant: true }, place.plain],
    [{ sort: "opened" }, place.plain],
    [{ sort: "opened", dir: "asc" }, place.opened],
    [{ sort: "updated" }, place.opened],
    // Opened: the key a time or null, the update a time, five in all.
    [{ sort: "opened" }, forged(["opened", "desc", "never", when, id])],
    [{ sort: "opened" }, forged(["opened", "desc", 5, when, id])],
    [{ sort: "opened" }, forged(["opened", "desc", null, null, id])],
    [{ sort: "opened" }, forged(["opened", "desc", null, "0000-01-01T00:00:00.000Z", id])],
    [{ sort: "opened" }, forged(["opened", "desc", when, id])],
    [{ sort: "opened" }, forged(["opened", "desc", null, when, "pt_x"])],
    // Relevant: the moment a time, news and waiting each 1 or 0, never waiting without news, seven in all (the filter's older five-long one is none).
    [{ relevant: true }, forged(["relevant", "desc", 1, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", 1, 1, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", when, 0, 1, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", when, 2, 0, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", when, "1", 1, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", when, null, 0, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", when, 1, 0, null, id])],
    [{ relevant: true }, forged(["relevant", "desc", null, 1, 0, when, id])],
    [{ relevant: true }, forged(["relevant", "desc", "soon", 1, 0, when, id])],
    [{ relevant: true }, forged(["relevant", "asc", when, 1, 1, when, id])],
  ] as const) {
    const res = await all(app, world.who.reader, { ...options, cursor });
    assert.equal(res.status, 400, `${JSON.stringify(options)} ${cursor}`);
    assert.equal(res.body.code, "INVALID_REQUEST", `${JSON.stringify(options)} ${cursor}`);
  }
  // A well-formed one is a place: past the never-opened `serverWide`, the rest of them; from an opened one, into them.
  const after = forged(["opened", "desc", null, at(22).toISOString(), items.serverWide.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "opened", cursor: after })), [items.newer.id, items.older.id]);
  await openedBy(items.open, me, at(100));
  const fromOpened = forged(["opened", "desc", at(100).toISOString(), at(23).toISOString(), items.open.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { sort: "opened", cursor: fromOpened })), [items.readerDm.id, items.serverWide.id, items.newer.id, items.older.id]);
  // `relevant`: the reader made `newer` (nothing new on it): past any tier above it, and past it among the read, nothing.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, cursor: place.relevant })), [items.newer.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, cursor: forged(["relevant", "desc", when, 1, 0, when, id]) })), [items.newer.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, cursor: forged(["relevant", "desc", when, 0, 0, at(30).toISOString(), id]) })), [items.newer.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { relevant: true, cursor: forged(["relevant", "desc", when, 0, 0, at(20).toISOString(), items.newer.id]) })), []);

  const off = await seedWorld(seed, { enabled: false });
  for (const path of ["/api/artifacts/dashboard/all?relevant=0", artifactWebPaths.dashboardAll({ relevant: true, sort: "opened" })]) {
    const res = await call(app, "GET", path, off.who.reader);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", path);
  }
});

// ---- the cards' screenshots (ArtifactPreview `screenshot`, task #130) -----------

const shotId = () => asObjectFileId(randomUUID());

/** The publish check of a version: `done` with these screenshots, or `failed` or `pending` (none). */
async function checkOf(versionId: string, check: { status: "done"; desktop: ObjectFileId | null; phone: ObjectFileId | null } | { status: "failed" | "pending" }) {
  await getDb().insert(artifactVersionChecks).values(check.status === "done"
    ? { versionId, status: "done", desktopFileId: check.desktop, phoneFileId: check.phone, finishedAt: new Date() }
    : { versionId, status: check.status, finishedAt: check.status === "failed" ? new Date() : null, errorClass: check.status === "failed" ? "load_timeout" : null });
}

/** A deployment with a check Worker, or (`false`) without one: only the first runs publish checks and shows their screenshots (checkWorkerToken.ts checksConfigured). */
const checkWorker = (configured: boolean) => vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", configured ? "k".repeat(40) : "");

test("a card shows the publish check's screenshots of the version it shows (desktop, and phone or null) on a deployment with a check Worker; else none, as without a finished check or with its screenshots cleared", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const [newerDesktop, newerPhone, olderDesktop] = [shotId(), shotId(), shotId()];
  await checkOf(items.newer.versionId!, { status: "done", desktop: newerDesktop, phone: newerPhone });
  await checkOf(items.older.versionId!, { status: "done", desktop: olderDesktop, phone: null });
  // Cleared (no longer among the newest three versions with screenshots), failed, still pending: none.
  await checkOf(items.open.versionId!, { status: "done", desktop: null, phone: null });
  await checkOf(items.serverWide.versionId!, { status: "failed" });
  await checkOf(items.readerDm.versionId!, { status: "pending" });
  const previews = async (who: Who) => {
    const res = await all(app, who);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return new Map<string, unknown>(res.body.rows.map((row: { card: { id: string; preview: unknown } }) => [row.card.id, row.card.preview]));
  };

  // No check Worker: every card as before.
  checkWorker(false);
  for (const [id, preview] of await previews(world.who.reader)) assert.deepEqual(preview, { kind: "none" }, id);

  checkWorker(true);
  const on = await previews(world.who.reader);
  const newerShots = { kind: "screenshot", desktop: newerDesktop, phone: newerPhone };
  assert.deepEqual(on.get(items.newer.id), newerShots);
  assert.deepEqual(on.get(items.older.id), { kind: "screenshot", desktop: olderDesktop, phone: null });
  for (const id of [items.open.id, items.serverWide.id, items.readerDm.id]) assert.deepEqual(on.get(id), { kind: "none" }, id);
  // Ids only: the client builds each address (objectWebPaths.file), core's route checks sight again.
  assert.equal(objectWebPaths.file("artifact", items.newer.id, newerDesktop), `/api/objects/artifact/${items.newer.id}/files/${newerDesktop}`);

  // The one card builder: the summaries' and the viewer's are the same.
  const summary = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: [{ id: items.newer.id }] });
  assert.deepEqual(summary.body.summaries[0].summary.preview, newerShots);
  const details = await call(app, "GET", artifactWebPaths.details(asArtifactId(items.newer.id)), world.who.reader);
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.deepEqual(details.body.card.preview, newerShots);

  // The version the card shows: a v2 not checked shows none; the card pinned at v1 shows v1's.
  const v2 = `v_${randomUUID()}`;
  await getDb().insert(artifactVersions).values({
    id: v2, itemId: items.newer.id, number: 2, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest-2",
    status: "published", publisherType: "user", publisherId: world.reader.id, position: 2,
  });
  await getDb().update(artifactItems).set({ currentVersionId: v2, lastPosition: 2 }).where(eq(artifactItems.id, items.newer.id));
  assert.deepEqual((await previews(world.who.reader)).get(items.newer.id), { kind: "none" });
  const pinned = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: [{ id: items.newer.id, version: 1 }] });
  assert.deepEqual(pinned.body.summaries[0].summary.preview, newerShots);
  const pinnedDetails = await call(app, "GET", artifactWebPaths.details(asArtifactId(items.newer.id), 1), world.who.reader);
  assert.deepEqual(pinnedDetails.body.card.preview, newerShots);

  // Without the check Worker again: none, on a message card's summary too.
  checkWorker(false);
  assert.deepEqual((await previews(world.who.reader)).get(items.older.id), { kind: "none" });
  const offSummary = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: [{ id: items.older.id }] });
  assert.deepEqual(offSummary.body.summaries[0].summary.preview, { kind: "none" });

  // Another server's reader of a public one (core serves it none of its files) gets none;
  // a member of its server gets the same card with them.
  const open = await artifact({ serverId: world.serverId, title: "Checked, public", author: { type: "user", id: world.owner.id }, updatedAt: at(70) });
  const openDesktop = shotId();
  await checkOf(open.versionId!, { status: "done", desktop: openDesktop, phone: null });
  checkWorker(true);
  const summaryOf = async (who: Who) => {
    const res = await call(app, "POST", objectWebPaths.summaries(), who, { kind: "artifact", refs: [{ id: open.id }] });
    assert.equal(res.body.summaries[0].ok, true, JSON.stringify(res.body));
    return res.body.summaries[0].summary;
  };
  assert.deepEqual((await summaryOf(world.who.outsider)).preview, { kind: "screenshot", desktop: openDesktop, phone: null });
  const outside = await summaryOf(world.who.peerOwner);
  assert.equal(outside.fromAnotherServer, true);
  assert.deepEqual(outside.preview, { kind: "none" });
  assert.ok(!JSON.stringify(outside).includes(openDesktop));
});

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as web.api.test.ts). */
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

test("the screenshots are one query for a page, however many of its cards have them (and the comment sort one statement)", async ({ seed }) => {
  const world = await seedWorld(seed);
  checkWorker(true);
  const api = createArtifactWebApi();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const shotted = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const row = await artifact({ serverId: world.serverId, title: `Shot ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(500 + index) });
      await checkOf(row.versionId!, { status: "done", desktop: shotId(), phone: index % 2 === 0 ? shotId() : null });
      await commentsOn(row, byOwner, index % 3);
    }
  };
  const screenshots = ({ value }: { value: Awaited<ReturnType<typeof api.dashboardAll>> }) =>
    value.kind === "json" ? value.body.rows.filter((row) => row.card.preview.kind === "screenshot").length : value.body.code;
  await shotted(2);
  const small = await countQueries(() => api.dashboardAll(reader, {}));
  const smallByComments = await countQueries(() => api.dashboardAll(reader, { sort: "comments" }));
  await shotted(8);
  const large = await countQueries(() => api.dashboardAll(reader, {}));
  const largeByComments = await countQueries(() => api.dashboardAll(reader, { sort: "comments" }));
  assert.equal(screenshots(small), 2);
  assert.equal(screenshots(large), 10);
  assert.equal(screenshots(largeByComments), 10);
  assert.ok(small.queries > 0, "the count observes queries");
  assert.equal(large.queries, small.queries, `${small.queries} queries for 2 screenshots, ${large.queries} for 10`);
  assert.equal(largeByComments.queries, smallByComments.queries);
  assert.equal(smallByComments.queries, small.queries, "the comment count is part of the statement that orders");
});

test("a Markdown version's card shows its excerpt, as plain words, with or without a check Worker; a screenshot it still has comes first; none without either; a pinned card shows its own version's", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  const preview = async (id: string, who: Who = world.who.reader) => {
    const res = await all(app, who);
    return res.body.rows.find((row: { card: { id: string } }) => row.card.id === id)?.card.preview;
  };
  const markdown = async (itemId: string, excerpt: string | null) =>
    getDb().update(artifactVersions).set({ entry: "index.md", excerpt }).where(eq(artifactVersions.itemId, itemId));
  await markdown(items.newer.id, "Line one\nLine two");
  await markdown(items.older.id, "Has a screenshot too");
  await markdown(items.open.id, null);

  checkWorker(false);
  assert.deepEqual(await preview(items.newer.id), { kind: "excerpt", text: "Line one\nLine two" }, "the excerpt isn't the check's: no check Worker needed");
  assert.deepEqual(await preview(items.older.id), { kind: "excerpt", text: "Has a screenshot too" });
  assert.deepEqual(await preview(items.open.id), { kind: "none" }, "neither: as before");
  // Its blocks beside the text, which stays whole for older clients; none (a version from before them): no key at all.
  const excerptBlocks = [{ type: "heading" as const, level: 2, spans: [{ text: "Line one" }] }];
  await getDb().update(artifactVersions).set({ excerptBlocks }).where(eq(artifactVersions.itemId, items.newer.id));
  assert.deepEqual(await preview(items.newer.id), { kind: "excerpt", text: "Line one\nLine two", blocks: excerptBlocks });

  // An older Markdown version that was checked keeps showing what the check took.
  checkWorker(true);
  const desktop = shotId();
  await checkOf(items.older.versionId!, { status: "done", desktop, phone: null });
  assert.deepEqual(await preview(items.older.id), { kind: "screenshot", desktop, phone: null });

  // The next version has no check: its excerpt, and the pinned older one its own.
  const v2 = `v_${randomUUID()}`;
  await getDb().insert(artifactVersions).values({
    id: v2, itemId: items.older.id, number: 2, entry: "index.md", fileCount: 1, sizeBytes: 10, publishDigest: "digest-2", excerpt: "The new words",
    status: "published", publisherType: "user", publisherId: world.owner.id, position: 2,
  });
  await getDb().update(artifactItems).set({ currentVersionId: v2, lastPosition: 2 }).where(eq(artifactItems.id, items.older.id));
  assert.deepEqual(await preview(items.older.id), { kind: "excerpt", text: "The new words" });
  const pinned = await call(app, "POST", objectWebPaths.summaries(), world.who.reader, { kind: "artifact", refs: [{ id: items.older.id, version: 1 }] });
  assert.deepEqual(pinned.body.summaries[0].summary.preview, { kind: "screenshot", desktop, phone: null });

  // A revoked version's card is no card: nothing of its words goes out.
  await getDb().update(artifactVersions).set({ revokedAt: new Date(), revokedByType: "user", revokedById: world.owner.id }).where(eq(artifactVersions.id, v2));
  assert.equal(JSON.stringify((await all(app, world.who.reader)).body).includes("The new words"), false);
});

test("excerpts are no query at all: a page of them costs what a page without them does", async ({ seed }) => {
  const world = await seedWorld(seed);
  const api = createArtifactWebApi();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const excerpted = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const row = await artifact({ serverId: world.serverId, title: `Words ${index}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(900 + index) });
      await getDb().update(artifactVersions).set({ entry: "index.md", excerpt: `Words ${index}` }).where(eq(artifactVersions.id, row.versionId!));
    }
  };
  const excerpts = ({ value }: { value: Awaited<ReturnType<typeof api.dashboardAll>> }) =>
    value.kind === "json" ? value.body.rows.filter((row) => row.card.preview.kind === "excerpt").length : value.body.code;
  await excerpted(2);
  const small = await countQueries(() => api.dashboardAll(reader, {}));
  await excerpted(8);
  const large = await countQueries(() => api.dashboardAll(reader, {}));
  assert.equal(excerpts(small), 2);
  assert.equal(excerpts(large), 10);
  assert.ok(small.queries > 0, "the count observes queries");
  assert.equal(large.queries, small.queries, `${small.queries} queries for 2 excerpts, ${large.queries} for 10`);
});

test("the list stays a constant number of queries however long it is, with `relevant` and `sort=opened` alike", async ({ seed }) => {
  const world = await seedWorld(seed);
  const api = createArtifactWebApi();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const me: Actor = { type: "user", id: world.reader.id };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const more = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const row = await artifact({ serverId: world.serverId, title: `Note ${label()}`, author: byOwner, homeChannelId: world.team.id, updatedAt: at(700 + index) });
      await noteOn(row, byOwner, [me]);
      await followedBy(row, me);
    }
  };
  const lengths = ({ value }: { value: Awaited<ReturnType<typeof api.dashboardAll>> }) => (value.kind === "json" ? value.body.rows.length : value.body.code);
  await more(2);
  const small = await countQueries(() => api.dashboardAll(reader, { sort: "opened" }));
  const smallRelevant = await countQueries(() => api.dashboardAll(reader, { relevant: "1" }));
  await more(8);
  const large = await countQueries(() => api.dashboardAll(reader, { sort: "opened" }));
  const largeRelevant = await countQueries(() => api.dashboardAll(reader, { relevant: "1" }));
  assert.equal(lengths(small), 7);
  // The reader's own `newer` too.
  assert.equal(lengths(smallRelevant), 3);
  assert.equal(lengths(large), 15);
  assert.equal(lengths(largeRelevant), 11);
  assert.equal(large.queries, small.queries);
  assert.equal(largeRelevant.queries, smallRelevant.queries);
});

/** The conversations route's rows (asserting a 200). */
async function conversationsOf(app: { baseUrl: string }, who: Who, q?: string): Promise<Array<{ id: string; name: string; type: string; count: number; updatedAt: string; peer?: { type: string; id: string } }>> {
  const res = await call(app, "GET", artifactWebPaths.dashboardConversations(q === undefined ? {} : { q }), who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.conversations;
}

test("`conversation` keeps that conversation's Artifacts, in the statement, with `author`, `q`, `home` and paging's filters beside it; `home` still answers every kind", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id })), [items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.readerDm.id })), [items.readerDm.id]);
  // Any case: an id is an id.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id.toUpperCase() })), [items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id, author: ["me"] })), [items.newer.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id, q: "q3" })), [items.newer.id]);
  // Beside `home`, both apply: a conversation is no `public` home, and a channel no `dm`.
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id, home: "channel" })), [items.newer.id, items.older.id]);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id, home: "dm" })), []);
  assert.deepEqual(idsOf(await all(app, world.who.reader, { conversation: world.team.id, home: "public" })), []);
  // Additive: without it, the list as it was, every `home` value still taken.
  assert.equal(idsOf(await all(app, world.who.reader)).length, 5);
  for (const [home, expected] of [["public", items.open.id], ["server", items.serverWide.id], ["dm", items.readerDm.id]] as const) {
    assert.deepEqual(idsOf(await all(app, world.who.reader, { home })), [expected], home);
  }
  // `home=public` is the reader's server's: another server's public Artifact isn't listed, as it never was.
  assert.ok(!idsOf(await all(app, world.who.outsider, { home: "public" })).includes(world.peerItems.open.id));
  assert.deepEqual(idsOf(await all(app, world.who.outsider, { home: "public" })), [items.open.id]);
});

test("a conversation the reader can't see is one ordinary empty page, the same as an unknown id, another server's or a deleted one: no rows, 0 and 0, `total` as ever, nothing that tells them apart (reverse: a 404 or a count for #secret only)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const unknown = await all(app, world.who.reader, { conversation: randomUUID() });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { rows: [], nextCursor: null, counts: { total: 5, filtered: 0, relevant: 0 } });
  const answers = {
    "a private channel it isn't in": world.secret.id,
    "another's DM": (await getDb().select({ channelId: artifactItems.homeChannelId }).from(artifactItems).where(eq(artifactItems.id, world.items.ownerDm.id)))[0]!.channelId!,
    "another server's": world.peerRoom.id,
    "a hard-deleted one": world.doomed.id,
  };
  for (const [why, conversation] of Object.entries(answers)) {
    const reply = await all(app, world.who.reader, { conversation });
    assert.equal(reply.status, unknown.status, why);
    assert.deepEqual(reply.body, unknown.body, why);
    // With every other filter too, the toggle's included.
    const relevant = await all(app, world.who.reader, { conversation, relevant: true, q: "budget", sort: "title" });
    assert.equal(relevant.status, 200, why);
    assert.deepEqual(relevant.body.rows, [], why);
    assert.deepEqual(relevant.body.counts, { total: 5, filtered: 0, relevant: 0 }, why);
  }
  // Its member gets it: it was the reader, not the id.
  assert.deepEqual(idsOf(await all(app, world.who.owner, { conversation: world.secret.id })), [world.items.secret.id]);
});

test("`conversation` refused: anything but one uuid, before the conversation is looked at", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const path of [
    `${artifactWebPaths.dashboardAll()}?conversation=not-a-uuid`,
    `${artifactWebPaths.dashboardAll()}?conversation=`,
    `${artifactWebPaths.dashboardAll()}?conversation=${world.team.id}&conversation=${world.secret.id}`,
    `${artifactWebPaths.dashboardAll()}?conversation=${world.team.id}%27`,
  ]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }
});

test("flag off: 403 ARTIFACTS_NOT_ENABLED before the conversation, on the filter and the conversations alike", async ({ app, seed }) => {
  const off = await seedWorld(seed, { enabled: false });
  for (const path of [artifactWebPaths.dashboardAll({ conversation: off.team.id }), artifactWebPaths.dashboardConversations()]) {
    const res = await call(app, "GET", path, off.who.reader);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED", path);
  }
});

test("`counts` honour `conversation`: filtered and relevant keep it, with `q` and `relevant` too, total doesn't; pages by the same cursor", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await seedNews(world);
  const countsOf = async (options: Parameters<typeof artifactWebPaths.dashboardAll>[0]) => {
    const res = await all(app, world.who.reader, options);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.counts;
  };
  // `older` and `newer` in #team, the first waiting.
  assert.deepEqual(await countsOf({ conversation: world.team.id }), { total: 5, filtered: 2, relevant: 1 });
  assert.deepEqual(await countsOf({ conversation: world.team.id, relevant: true }), { total: 5, filtered: 2, relevant: 1 });
  assert.deepEqual(await countsOf({ conversation: world.team.id, q: "q3" }), { total: 5, filtered: 1, relevant: 0 });
  assert.deepEqual(await countsOf({ conversation: world.readerDm.id }), { total: 5, filtered: 1, relevant: 0 });

  for (let index = 0; index < ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT; index += 1) {
    // Newer than `older` and `newer`, which seedNews's comments moved to now.
    await artifact({ serverId: world.serverId, title: `In the team ${index}`, author: { type: "user", id: world.owner.id }, homeChannelId: world.team.id, updatedAt: new Date(Date.now() + 3_600_000 + index * 1000) });
  }
  const first = await all(app, world.who.reader, { conversation: world.team.id });
  assert.equal(first.body.rows.length, ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT);
  const next = await all(app, world.who.reader, { conversation: world.team.id, cursor: first.body.nextCursor });
  assert.deepEqual(idsOf(next), [world.items.newer.id, world.items.older.id]);
  assert.equal(next.body.nextCursor, null);
});

test("a joint: asked by the reader's own projection, `conversation` keeps its Artifacts of every server, homed on the canonical channel or a projection; the conversations name it once, by that projection", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `all-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addHuman(peerProjection.id, peerMember.id);
  const byReader: Actor = { type: "user", id: world.reader.id };
  const canonicalHomed = await artifact({ serverId: world.serverId, title: "Canonical", author: byReader, homeChannelId: joint.canonical.id, updatedAt: at(50) });
  const projectionHomed = await artifact({ serverId: world.serverId, title: "Projection", author: byReader, homeChannelId: hostProjection.id, updatedAt: at(51) });
  const peerHomed = await artifact({ serverId: world.peerId, title: "From the peer", author: { type: "user", id: peerMember.id }, homeChannelId: joint.canonical.id, updatedAt: at(52) });
  const member: Who = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };

  assert.deepEqual(idsOf(await all(app, member, { conversation: peerProjection.id })), [peerHomed.id, projectionHomed.id, canonicalHomed.id]);
  // Another server's projection is no conversation of this reader's server: the one empty page.
  assert.deepEqual((await all(app, member, { conversation: hostProjection.id })).body.rows, []);

  const listed = await conversationsOf(app, member);
  assert.deepEqual(listed.map(({ id, name, type, count, updatedAt }) => ({ id, name, type, count, updatedAt })), [
    { id: peerProjection.id, name: peerProjection.name, type: "joint", count: 3, updatedAt: at(52).toISOString() },
  ]);
  // The server that has it by another projection names it by its own, with the same Artifacts.
  assert.deepEqual((await conversationsOf(app, world.who.reader)).map(({ id }) => id)[0], hostProjection.id);
});

test("conversations: what holds Artifacts the reader sees, most recently updated first, each with how many and the newest; only what it sees; a DM by its peer; never one with only unpublished, deleted or revoked Artifacts", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const empty = await seed.channel({ server: world.server, members: [world.owner, world.reader], visibility: "private", name: `empty-${label()}` });
  const unpublishedOnly = await seed.channel({ server: world.server, members: [world.owner, world.reader], visibility: "private", name: `drafty-${label()}` });
  await artifact({ serverId: world.serverId, title: "Never published", author: { type: "user", id: world.owner.id }, homeChannelId: unpublishedOnly.id, updatedAt: at(90), unpublished: true });

  const listed = await conversationsOf(app, world.who.reader);
  assert.deepEqual(listed.map(({ id, type, count, updatedAt }) => ({ id, type, count, updatedAt })), [
    { id: world.readerDm.id, type: "dm", count: 1, updatedAt: at(24).toISOString() },
    { id: world.team.id, type: "private", count: 2, updatedAt: at(20).toISOString() },
  ]);
  const [dm, team] = listed as [typeof listed[number], typeof listed[number]];
  assert.equal(team.name, world.team.name);
  assert.equal(team.peer, undefined);
  assert.equal(dm.name, world.agent.name, "by its peer");
  assert.deepEqual({ type: dm.peer?.type, id: dm.peer?.id }, { type: "agent", id: world.agent.id }, "its avatar's");
  assert.ok(!listed.some(({ id }) => id === empty.id || id === unpublishedOnly.id || id === world.doomed.id));

  // Every id it gives is one `conversation` takes.
  for (const { id, count } of listed) assert.equal(idsOf(await all(app, world.who.reader, { conversation: id })).length, count);

  // The owner: #secret and its own DM too, never the reader's DM.
  const ofOwner = (await conversationsOf(app, world.who.owner)).map(({ id }) => id);
  assert.ok(ofOwner.includes(world.secret.id));
  assert.ok(!ofOwner.includes(world.readerDm.id));
  // A member in no channel, and the request's server only.
  assert.deepEqual(await conversationsOf(app, world.who.outsider), []);
  assert.deepEqual((await conversationsOf(app, world.who.readerInPeer)).map(({ id }) => id), [world.peerRoom.id]);
});

test("a private channel's name never reaches a reader outside it: not listed, and no search finds it, by its whole name or a part (reverse: `q` matched before visibility)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const who of [world.who.reader, world.who.outsider]) {
    for (const q of [world.secret.name, world.secret.name.slice(0, 7), `#${world.secret.name}`, "secret"]) {
      assert.deepEqual(await conversationsOf(app, who, q), [], q);
    }
    const raw = await call(app, "GET", artifactWebPaths.dashboardConversations(), who);
    assert.ok(!JSON.stringify(raw.body).includes(world.secret.name));
    assert.ok(!JSON.stringify(raw.body).includes(world.secret.id));
  }
  // Its member finds it, so the search was looking.
  assert.deepEqual((await conversationsOf(app, world.who.owner, world.secret.name)).map(({ id }) => id), [world.secret.id]);
});

test("conversations' `q`: contained in the name or a DM peer's, any case, trimmed, a leading # dropped; blank is none; 50 at most, the newest; refused as the authors' are", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const ids = async (q: string) => (await conversationsOf(app, world.who.reader, q)).map(({ id }) => id);
  const teamName = world.team.name;
  assert.deepEqual(await ids(teamName.slice(0, 6).toUpperCase()), [world.team.id]);
  assert.deepEqual(await ids(`  #${teamName}  `), [world.team.id]);
  assert.deepEqual(await ids(world.agent.name.slice(2)), [world.readerDm.id], "a DM by its peer's handle");
  assert.deepEqual(await ids("no-conversation-is-called-this"), []);
  assert.equal((await ids("   ")).length, 2);
  assert.equal((await ids("#")).length, 2, "a # alone says nothing");
  for (const path of [artifactWebPaths.dashboardConversations({ q: "x".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) }), "/api/artifacts/dashboard/conversations?q=a&q=b"]) {
    const res = await call(app, "GET", path, world.who.reader);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "INVALID_REQUEST", path);
  }

  const made: string[] = [];
  for (let index = 0; index < ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT; index += 1) {
    const channel = await seed.channel({ server: world.server, members: [world.owner, world.reader], visibility: "private", name: `many-${label()}` });
    await artifact({ serverId: world.serverId, title: `In ${index}`, author: { type: "user", id: world.owner.id }, homeChannelId: channel.id, updatedAt: at(300 + index) });
    made.unshift(channel.id);
  }
  assert.deepEqual((await conversationsOf(app, world.who.reader)).map(({ id }) => id), made);
});

limitedTest("the conversations share the dashboard's rate limit: 429 RATE_LIMITED past it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await call(app, "GET", artifactWebPaths.dashboardConversations(), world.who.reader)).status, 200);
  assert.equal((await all(app, world.who.reader, { conversation: world.team.id })).status, 200);
  const res = await call(app, "GET", artifactWebPaths.dashboardConversations(), world.who.reader);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
});

test("conversations and the `conversation` filter stay a constant number of queries however many conversations hold Artifacts, DMs among them", async ({ seed }) => {
  const world = await seedWorld(seed);
  const api = createArtifactWebApi();
  const reader = { userId: world.reader.id, serverId: world.serverId, sessionFamilyId: null };
  const byOwner: Actor = { type: "user", id: world.owner.id };
  const more = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const channel = await seed.channel({ server: world.server, members: [world.owner, world.reader], visibility: "private", name: `count-${label()}` });
      await artifact({ serverId: world.serverId, title: `Note ${label()}`, author: byOwner, homeChannelId: channel.id, updatedAt: at(700 + index) });
      const peer = await createAgent(world.server.id, `peer-${label()}`, { runtime: "claude", model: "sonnet" });
      const dm = (await findOrCreateDM(world.server.id, world.reader.id, peer.id))!;
      await artifact({ serverId: world.serverId, title: `Note ${label()}`, author: byOwner, homeChannelId: dm.id, updatedAt: at(800 + index) });
    }
  };
  const lengths = ({ value }: { value: Awaited<ReturnType<typeof api.dashboardConversations>> }) => (value.kind === "json" ? value.body.conversations.length : value.body.code);
  await more(1);
  const small = await countQueries(() => api.dashboardConversations(reader, {}));
  const smallFiltered = await countQueries(() => api.dashboardAll(reader, { conversation: world.team.id }));
  await more(4);
  const large = await countQueries(() => api.dashboardConversations(reader, {}));
  const largeFiltered = await countQueries(() => api.dashboardAll(reader, { conversation: world.team.id }));
  assert.equal(lengths(small), 4);
  assert.equal(lengths(large), 12);
  assert.equal(large.queries, small.queries);
  assert.equal(largeFiltered.queries, smallFiltered.queries);
});

test("an Artifact moved from a private channel to the whole server is in a non-member's list and under no conversation: the channel isn't offered, by name, id or `q`, and its member's count is what the filter lists", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const stays = await artifact({ serverId: world.serverId, title: "Stays in the secret room", author: { type: "user", id: world.owner.id }, homeChannelId: world.secret.id, updatedAt: at(60) });
  // As manage.ts widens one: the home is the server, no channel (the items' `items_home_channel` check).
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, world.items.secret.id));

  for (const who of [world.who.reader, world.who.outsider]) {
    // It stays in the list: only the filter can't reach it.
    assert.ok(idsOf(await all(app, who)).includes(world.items.secret.id));
    assert.ok(!idsOf(await all(app, who)).includes(stays.id));
    assert.deepEqual(idsOf(await all(app, who, { conversation: world.secret.id })), []);
    const raw = await call(app, "GET", artifactWebPaths.dashboardConversations(), who);
    assert.equal(raw.status, 200);
    assert.ok(!JSON.stringify(raw.body).includes(world.secret.id));
    assert.ok(!JSON.stringify(raw.body).includes(world.secret.name));
    for (const q of [world.secret.name, `#${world.secret.name}`, world.secret.name.slice(0, 7)]) {
      assert.deepEqual(await conversationsOf(app, who, q), [], q);
    }
  }

  // Its member: the channel, for what is still homed there; the moved one is in the list, not under it.
  const row = (await conversationsOf(app, world.who.owner)).find(({ id }) => id === world.secret.id);
  assert.equal(row?.name, world.secret.name);
  assert.equal(row?.count, 1);
  const filtered = idsOf(await all(app, world.who.owner, { conversation: world.secret.id }));
  assert.deepEqual(filtered, [stays.id]);
  assert.equal(row?.count, filtered.length, "a row's count is what the filter lists");
  assert.deepEqual((await conversationsOf(app, world.who.owner, world.secret.name)).map(({ id }) => id), [world.secret.id]);

  // All of its Artifacts gone to the server: nothing is homed there, so not its member either.
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, stays.id));
  assert.ok(!(await conversationsOf(app, world.who.owner)).some(({ id }) => id === world.secret.id));
});

test("readableConversations answers as readableConversation does for each id, in a constant number of queries; a row of the picker is one the filter takes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `read-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.reader.id);
  await addHuman(peerProjection.id, peerMember.id);
  const ownerDm = (await getDb().select({ channelId: artifactItems.homeChannelId }).from(artifactItems).where(eq(artifactItems.id, world.items.ownerDm.id)))[0]!.channelId!;
  const ids = [world.team.id, world.secret.id, world.readerDm.id, ownerDm, world.doomed.id, world.peerRoom.id, hostProjection.id, peerProjection.id, joint.canonical.id, randomUUID()];
  for (const userId of [world.reader.id, world.owner.id, world.outsider.id]) {
    const reader = { userId, serverId: world.serverId };
    const batch = await readableConversations(reader, [...ids, "not-a-uuid", world.team.id]);
    for (const id of ids) assert.deepEqual(batch.get(id) ?? null, await readableConversation(reader, id), id);
  }
  const reader = { userId: world.reader.id, serverId: world.serverId };
  const readable = await readableConversations(reader, ids);
  for (const id of [world.team.id, world.readerDm.id, hostProjection.id]) assert.ok(readable.has(id), id);
  for (const id of [world.secret.id, ownerDm, world.doomed.id, world.peerRoom.id, peerProjection.id]) assert.ok(!readable.has(id), id);
  assert.equal(readable.get(hostProjection.id)?.homeChannelId, joint.canonical.id);

  const someOfEach = [world.team.id, world.readerDm.id, hostProjection.id, world.peerRoom.id];
  const few = await countQueries(() => readableConversations(reader, someOfEach));
  const many = await countQueries(() => readableConversations(reader, [...someOfEach, world.secret.id, ownerDm, world.doomed.id, randomUUID()]));
  assert.equal(many.queries, few.queries);

  // Every row, for every reader: the filter takes it and lists its count.
  for (const who of [world.who.reader, world.who.owner, world.who.outsider]) {
    for (const { id, count } of await conversationsOf(app, who)) assert.equal(idsOf(await all(app, who, { conversation: id })).length, count, id);
  }
});
