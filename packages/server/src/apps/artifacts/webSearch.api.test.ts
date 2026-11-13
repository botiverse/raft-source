// Artifacts' group of core's search (`GET /api/search`, webSearch.ts) over
// HTTP with real user tokens, at the path the shared contract builds
// (webSearchPath): titles found by word, grouped under `artifacts` with their
// cards and matches; visibility in the statement (a private conversation's
// Artifact only for its members, a guest only its own conversations and
// public, an orphan, a deleted or a revoked Artifact never); only the
// reader's current server, whatever another server's titles say; paging
// through core gives what the agent API's list with `query` gives (one
// search); Artifacts off leaves no group; the request's refusals.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  asSearchCursor,
  asServerId,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  webSearchPath,
  type ServerId,
  type WebSearchQuery,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { artifactItems, artifactVersions } from "./schema";
import { indexArtifactSearch } from "./search";
import { canViewArtifacts } from "./visibility";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { search: 2 } });

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-core-search-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

type Actor = { type: "user" | "agent"; id: string };

/** A published Artifact (one version, current) with its search row, as a publish leaves it. */
async function artifact(input: { serverId: ServerId; title: string; author: Actor; homeChannelId?: string; serverHome?: boolean; deleted?: boolean; revoked?: boolean; updatedAt?: Date }) {
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
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  }).returning();
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
    status: "published", publisherType: input.author.type, publisherId: input.author.id, position: 1,
  });
  const [current] = await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1, ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}) })
    .where(eq(artifactItems.id, id)).returning();
  await indexArtifactSearch(db, item!);
  return current!;
}

/**
 * A server with the flag on: owner; reader in #team and #guestroom; guest (a
 * guest member) in #guestroom only; agent A in #team, #secret and
 * #guestroom. Artifacts titled "Budget …": in #team, #secret (owner and A
 * only), #guestroom, server-wide, public, deleted, revoked, and one in
 * #doomed (owner and reader) whose channel is then hard-deleted (an orphan).
 * A peer server with the reader as a member too and its own "Budget"
 * Artifacts in every kind of home. Artifacts on.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [reader, guest] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, members: [reader] });
  const peerId = asServerId(peer.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);

  const agentA = await createAgent(server.id, `cs-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const team = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `team-${label()}` });
  const secret = await seed.channel({ server, members: [owner], visibility: "private", name: `secret-${label()}` });
  const guestroom = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `guestroom-${label()}` });
  // The guest reads #guestroom, its one channel (#wg-rbac:#15).
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guestroom.id });
  const doomed = await seed.channel({ server, members: [owner, reader], visibility: "private", name: `doomed-${label()}` });
  for (const channel of [team, secret, guestroom]) await addAgent(channel.id, agentA.id);
  const peerRoom = await seed.channel({ server: peer, members: [peerOwner, reader], visibility: "private", name: `peer-${label()}` });

  const byOwner: Actor = { type: "user", id: owner.id };
  const items = {
    team: await artifact({ serverId, title: "Budget for the team", author: byOwner, homeChannelId: team.id }),
    secret: await artifact({ serverId, title: "Budget secret", author: byOwner, homeChannelId: secret.id }),
    guestroom: await artifact({ serverId, title: "Budget in the guest room", author: byOwner, homeChannelId: guestroom.id }),
    serverWide: await artifact({ serverId, title: "Budget for everyone here", author: byOwner, serverHome: true }),
    open: await artifact({ serverId, title: "Budget, public", author: byOwner }),
    deleted: await artifact({ serverId, title: "Budget deleted", author: byOwner, homeChannelId: team.id, deleted: true }),
    revoked: await artifact({ serverId, title: "Budget revoked", author: byOwner, homeChannelId: team.id, revoked: true }),
    orphan: await artifact({ serverId, title: "Budget orphan", author: byOwner, homeChannelId: doomed.id }),
  };
  const byPeer: Actor = { type: "user", id: peerOwner.id };
  const peerItems = {
    room: await artifact({ serverId: peerId, title: "Budget of the peer", author: byPeer, homeChannelId: peerRoom.id }),
    serverWide: await artifact({ serverId: peerId, title: "Budget peer-wide", author: byPeer, serverHome: true }),
    open: await artifact({ serverId: peerId, title: "Budget peer public", author: byPeer }),
  };
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, serverId, peer, owner, reader, guest, agentA, channels: { team, secret, guestroom, doomed }, items, peerItems,
    who: { owner: await as(owner.id), reader: await as(reader.id), guest: await as(guest.id), readerInPeer: await as(reader.id, peer.id), peerOwner: await as(peerOwner.id, peer.id) },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; headers: Headers; body: any };

async function get(app: { baseUrl: string }, path: string, who: Who): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const search = (app: { baseUrl: string }, who: Who, query: WebSearchQuery) => get(app, webSearchPath(query), who);

/** The `artifacts` group's ids, in order (asserting a 200 with exactly that group). */
function artifactIds(reply: Reply): string[] {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body.groups.map((group: { app: string }) => group.app), ["artifacts"]);
  return reply.body.groups[0].items.map((item: { card: { id: string } }) => item.card.id);
}

const sorted = (ids: readonly string[]) => [...ids].sort();

test("titles are found by word, grouped under `artifacts`, each with its card and title matches; private, no-store", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const reply = await search(app, world.who.owner, { q: "budget team" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(reply.body, {
    groups: [{
      app: "artifacts",
      nextCursor: null,
      items: [{
        card: reply.body.groups[0].items[0].card,
        matches: [{ field: "title", snippet: "Budget for the team", highlights: [{ start: 0, length: 6 }, { start: 15, length: 4 }] }],
      }],
    }],
  });
  const card = reply.body.groups[0].items[0].card;
  assert.equal(card.id, world.items.team.id);
  assert.equal(card.title, "Budget for the team");
  assert.equal(card.version, 1);
  assert.deepEqual(card.home, { kind: "conversation", conversation: { id: world.channels.team.id, name: world.channels.team.name, type: "private" } });
  assert.equal(card.author.id, world.owner.id);
  // Only the title is searched: nothing matches a word that isn't in one.
  assert.deepEqual(artifactIds(await search(app, world.who.owner, { q: "nowhere-in-a-title" })), []);
  // A prefix of three or more ASCII characters matches.
  assert.ok(artifactIds(await search(app, world.who.owner, { q: "budg" })).includes(world.items.team.id));
});

test("visibility is the reader's: members only for a private conversation, a guest only its own conversations and public, never an orphan, a deleted or a revoked Artifact", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { items } = world;
  await getDb().delete(channels).where(eq(channels.id, world.channels.doomed.id));
  const expect = {
    owner: [items.team, items.secret, items.guestroom, items.serverWide, items.open],
    reader: [items.team, items.guestroom, items.serverWide, items.open],
    guest: [items.guestroom, items.open],
  };
  for (const [who, rows] of Object.entries(expect) as Array<[keyof typeof expect, typeof expect.owner]>) {
    const found = artifactIds(await search(app, world.who[who], { q: "budget", limit: WEB_SEARCH_MAX_LIMIT }));
    assert.deepEqual(sorted(found), sorted(rows.map((row) => row.id)), who);
  }
  // The same answers canViewArtifacts gives by id, for each of them, but for the orphan: it only opens by id (the owner may).
  // Read again: the orphan's channel is gone (SET NULL).
  const all = await getDb().select().from(artifactItems).where(inArray(artifactItems.id, Object.values(items).map((row) => row.id)));
  assert.equal(all.find((row) => row.id === items.orphan.id)!.homeChannelId, null);
  for (const [who, userId] of [["owner", world.owner.id], ["reader", world.reader.id], ["guest", world.guest.id]] as const) {
    const byId = await canViewArtifacts({ type: "user", id: userId, serverId: world.serverId }, all);
    const opens = all.filter((_, index) => byId[index]).map((row) => row.id);
    assert.deepEqual(sorted(opens), sorted([...expect[who], ...(who === "owner" ? [items.orphan] : [])].map((row) => row.id)), who);
  }
  // A private conversation's Artifact is not found by a non-member, whatever the words.
  assert.deepEqual(artifactIds(await search(app, world.who.reader, { q: "budget secret" })), []);
  assert.deepEqual(artifactIds(await search(app, world.who.owner, { q: "budget secret" })), [items.secret.id]);
  assert.deepEqual(artifactIds(await search(app, world.who.owner, { q: "budget orphan" })), []);
});

test("only the reader's current server is searched: another server's Artifacts never come back, in any home, whatever their titles", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peer = Object.values(world.peerItems).map((row) => row.id);
  const inServer = artifactIds(await search(app, world.who.reader, { q: "budget peer", limit: WEB_SEARCH_MAX_LIMIT }));
  assert.deepEqual(inServer, [], "the reader in its server: none of the peer's, though it is a member there and one is public");
  const fromPeer = artifactIds(await search(app, world.who.readerInPeer, { q: "budget", limit: WEB_SEARCH_MAX_LIMIT }));
  assert.deepEqual(sorted(fromPeer), sorted(peer), "the same reader in the peer server: the peer's only");
  // The public Artifact of the first server is not the peer owner's to find.
  const peerOwner = artifactIds(await search(app, world.who.peerOwner, { q: "budget public", limit: WEB_SEARCH_MAX_LIMIT }));
  assert.deepEqual(peerOwner, [world.peerItems.open.id]);
});

// Another server's Artifact comes back only through a joint the reader sees.
test("a joint channel: the server's Artifact homed there is found by a peer member in it, not by one outside the joint", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peerMember = await seed.human();
  await addMember(world.peer.id, peerMember.id);
  const joint = await seedJointChannel({ name: `cs-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, world.owner.id);
  await addHuman(peerProjection.id, peerMember.id);
  const item = await artifact({ serverId: world.serverId, title: "Zeppelin plan", author: { type: "user", id: world.owner.id }, homeChannelId: joint.canonical.id });
  const member = { token: await accessTokenForTest(peerMember.id), serverId: world.peer.id };

  const found = await search(app, member, { q: "zeppelin" });
  assert.deepEqual(artifactIds(found), [item.id]);
  assert.deepEqual(found.body.groups[0].items[0].card.home, { kind: "conversation", conversation: { id: peerProjection.id, name: peerProjection.name, type: "joint" } }, "named by the reader's own projection");
  assert.deepEqual(artifactIds(await search(app, world.who.peerOwner, { q: "zeppelin" })), [], "the peer's owner, not in the joint");
});

test("paging through core matches the agent API's list with `query`: one search, the same order, no gaps or repeats", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { serverId } = world;
  const byOwner: Actor = { type: "user", id: world.owner.id };
  // Ties on rank broken by updatedAt then id, with times apart and equal.
  const base = Date.UTC(2026, 9, 1);
  for (let index = 0; index < 7; index += 1) {
    await artifact({ serverId, title: `Roadmap ${index % 2 === 0 ? "roadmap" : "plan"} ${index}`, author: byOwner, homeChannelId: world.channels.team.id, updatedAt: new Date(base + Math.floor(index / 2) * 1000) });
  }
  const viaCore: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const reply: Reply = await search(app, world.who.owner, { q: "roadmap", app: "artifacts", limit: 2, ...(cursor ? { cursor: asSearchCursor(cursor) } : {}) });
    const rows = artifactIds(reply);
    cursor = reply.body.groups[0].nextCursor;
    assert.equal(rows.length, cursor ? 2 : rows.length, `page ${page} is full when another follows`);
    viaCore.push(...rows);
    if (!cursor) break;
  }
  assert.equal(viaCore.length, 7);
  assert.equal(new Set(viaCore).size, 7);
  assert.deepEqual(viaCore, artifactIds(await search(app, world.who.owner, { q: "roadmap", limit: WEB_SEARCH_MAX_LIMIT })), "pages joined are the one long page");

  // Agent A sees what the owner sees here (#team, #secret, #guestroom, the server, public).
  const { apiKey } = await mintAgentCredential({ agentId: world.agentA.id, scopes: ["read", "send"], name: `cs-${label()}`, issuedVia: "computer", createdByUserId: null });
  const viaAgent: string[] = [];
  let agentCursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const params: URLSearchParams = new URLSearchParams({ query: "roadmap", limit: "2", ...(agentCursor ? { cursor: agentCursor } : {}) });
    const res: Response = await fetch(`${app.baseUrl}/internal/agent-api/artifacts?${params}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = await res.json() as { artifacts: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(res.status, 200, JSON.stringify(body));
    viaAgent.push(...body.artifacts.map((row) => row.id));
    agentCursor = body.nextCursor;
    if (!agentCursor) break;
  }
  assert.deepEqual(viaCore, viaAgent);
});

test("an Artifact with no card (never published, its current version revoked) is not counted into a page: a page of one is the published match, with no cursor", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const author: Actor = { type: "user", id: world.owner.id };
  const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes));
  const published = await artifact({ serverId: world.serverId, title: "Zebra plan", author, updatedAt: at(1) });
  const unpublished = await artifact({ serverId: world.serverId, title: "Zebra plan", author, updatedAt: at(2) });
  await getDb().update(artifactItems).set({ currentVersionId: null }).where(eq(artifactItems.id, unpublished.id));
  const revoked = await artifact({ serverId: world.serverId, title: "Zebra plan", author, updatedAt: at(3) });
  await getDb().update(artifactVersions).set({ revokedAt: new Date(), revokedByType: "user", revokedById: world.owner.id }).where(eq(artifactVersions.id, revoked.currentVersionId!));
  const page = await search(app, world.who.owner, { q: "zebra", app: "artifacts", limit: 1 });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(page.body.groups[0].items.map((hit: { card: { id: string } }) => hit.card.id), [published.id]);
  assert.equal(page.body.groups[0].nextCursor, null, "nothing after it to page to");
});

test("Artifacts off: no Artifacts group, and asking for it is 404 APP_NOT_FOUND", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const reply = await search(app, world.who.owner, { q: "budget" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body, { groups: [] });
  const asked = await search(app, world.who.owner, { q: "budget", app: "artifacts" });
  assert.equal(asked.status, 404);
  assert.equal(asked.body.code, "APP_NOT_FOUND");
});

test("refusals: q missing, empty or too long 400 INVALID_QUERY; a bad limit or a cursor without app 400 INVALID_REQUEST; another search's cursor 400 INVALID_CURSOR; an unknown app 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const raw = (query: string) => get(app, `/api/search${query}`, world.who.owner);
  for (const query of ["", "?q=", "?q=%20%20%20", "?q=a&q=b", `?q=${"x".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1)}`, `?q=${"预".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1)}`]) {
    const reply = await raw(query);
    assert.equal(reply.status, 400, query);
    assert.equal(reply.body.code, "INVALID_QUERY", query);
    assert.equal(reply.headers.get("cache-control"), "private, no-store");
  }
  assert.match((await raw("")).body.error, /q is required/);
  assert.equal((await raw(`?q=${"预".repeat(WEB_SEARCH_QUERY_MAX_CHARS)}`)).status, 200, "the longest query is taken (code points, not UTF-16 units)");
  for (const query of ["?q=budget&limit=0", `?q=budget&limit=${WEB_SEARCH_MAX_LIMIT + 1}`, "?q=budget&limit=two", "?q=budget&limit=-1", "?q=budget&cursor=abc"]) {
    const reply = await raw(query);
    assert.equal(reply.status, 400, query);
    assert.equal(reply.body.code, "INVALID_REQUEST", query);
  }
  const first = await search(app, world.who.owner, { q: "budget", app: "artifacts", limit: 1 });
  const cursor = first.body.groups[0].nextCursor as string;
  assert.ok(cursor);
  for (const bad of [cursor, "not-a-cursor"]) {
    const reply = await search(app, world.who.owner, { q: bad === cursor ? "budget team" : "budget", app: "artifacts", cursor: asSearchCursor(bad) });
    assert.equal(reply.status, 400, bad);
    assert.equal(reply.body.code, "INVALID_CURSOR");
  }
  const unknown = await search(app, world.who.owner, { q: "budget", app: "nope" as "artifacts" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "APP_NOT_FOUND");
  // Signed out: 401, before anything is read.
  const res = await fetch(`${app.baseUrl}/api/search?q=budget`, { headers: { "X-Server-Id": world.server.id } });
  assert.equal(res.status, 401);
});

limitedTest("searches are limited per user (429 RATE_LIMITED past the budget, another user unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await search(app, world.who.owner, { q: "budget" })).status, 200);
  assert.equal((await search(app, world.who.owner, { q: "budget" })).status, 200);
  const limited = await search(app, world.who.owner, { q: "budget" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await search(app, world.who.reader, { q: "budget" })).status, 200, "another user's own budget");
});
