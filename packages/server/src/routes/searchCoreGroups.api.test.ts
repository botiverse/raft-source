// Core's own groups of `GET /api/search` (services/coreSearchService.ts,
// contract docs/contracts/web-search.md), over HTTP with real user tokens at
// the paths the shared contract builds: `channels` returns every channel the
// reader can read (archived and not-joined ones included, with their flags),
// never a private channel the reader isn't in, ranked by the server; a joint
// is `external`; `guest` channels and Guest people only for owners and
// admins (the Members page's rule), nothing at all for a Guest reader's
// people; `total` and the group's own cursor page through every match; the
// answer an existing caller gets (no `include`, no core `app`) is unchanged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PLAN_CONFIG, webSearchPath, type WebSearchQuery } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, channels } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addHuman, createChannel, findOrCreateDM } from "../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { __answerFlagForTests } from "../services/deploymentAnsweredFlags";
import { seedBoundGuest } from "../test/guestFixture";
import { accessTokenForTest } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedJointChannel } from "../test/integration/jointFixture";
import type { createSeed } from "../test/integration/seed";

const test = createApiTest();

type Who = { token: string; serverId: string };
type Reply = { status: number; body: any };

async function get(app: { baseUrl: string }, path: string, who: Who): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const search = (app: { baseUrl: string }, who: Who, query: WebSearchQuery) => get(app, webSearchPath(query), who);

/** The one group of a `?app=<core group>` answer. */
async function group(app: { baseUrl: string }, who: Who, query: WebSearchQuery) {
  const reply = await search(app, who, query);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.groups.length, 1);
  return reply.body.groups[0] as { app: string; items: any[]; nextCursor: string | null; total: number };
}

/**
 * A server where every channel's name or description holds the word `w`:
 * `w` itself (public, owner only), `w-alpha` (public, owner and member),
 * `w-beta` (public, owner only), `w-gamma` (public, member, archived),
 * `w-secret` (private, owner only), `w-guests` (private, owner and member,
 * the Guest's channel), `w-joint` (a joint with a peer server, member in it)
 * and `notes-…` (public, owner only, `w` only in its description). People:
 * owner and member (display names `W Owner`, `W Member`), the Guest (`W
 * Guest`), agent `w` and agent `w-bot`, and the owner's personal assistant
 * `w-helper` (made one after creation). The member has a DM with agent `w-bot`.
 */
async function world(seed: ReturnType<typeof createSeed>) {
  const w = `zeta${randomUUID().slice(0, 6)}`;
  const owner = await seed.human({ displayName: `${w.toUpperCase()} Owner` });
  const member = await seed.human({ displayName: `${w.toUpperCase()} Member` });
  const guest = await seed.human({ displayName: `${w.toUpperCase()} Guest` });
  const server = await seed.server({ owner, members: [member] });
  const peer = await seed.server({ owner: await seed.human() });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);

  const exact = await seed.channel({ server, members: [owner], name: w });
  const alpha = await seed.channel({ server, members: [owner, member], name: `${w}-alpha` });
  const beta = await seed.channel({ server, members: [owner], name: `${w}-beta` });
  const gamma = await seed.channel({ server, members: [member], name: `${w}-gamma`, archivedAt: new Date() });
  const secret = await seed.channel({ server, members: [owner], name: `${w}-secret`, visibility: "private" });
  const guests = await seed.channel({ server, members: [owner, member], name: `${w}-guests`, visibility: "private" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guests.id });
  const described = await createChannel(server.id, `notes-${w.slice(4)}`, `Where ${w} keeps notes`);
  await addHuman(described.id, owner.id);
  const joint = await seedJointChannel({ name: `${w}-joint`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const jointHere = joint.projections[0]!;
  await addHuman(jointHere.id, member.id);

  const agentExact = await createAgent(server.id, w, { runtime: "claude", model: "sonnet" });
  const bot = await createAgent(server.id, `${w}-bot`, { runtime: "claude", model: "sonnet" });
  const assistant = await createAgent(server.id, `${w}-helper`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const dm = await findOrCreateDM(server.id, member.id, bot.id);
  assert.ok(dm);

  const as = async (userId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    w, server, owner, member, guest, dm,
    channels: { exact, alpha, beta, gamma, secret, guests, described, joint: jointHere },
    agents: { agentExact, bot, assistant },
    who: { owner: await as(owner.id), member: await as(member.id), guest: await as(guest.id) },
  };
}

test("channels: archived and not-joined channels come back with their flags, a private channel the reader isn't in never does; ranked exact, then live joined, not joined, archived, then description-only", async ({ app, seed }) => {
  const x = await world(seed);
  const found = await group(app, x.who.member, { q: x.w, app: "channels", limit: 50 });
  assert.equal(found.app, "channels");
  const c = x.channels;
  assert.deepEqual(found.items.map((item) => item.id), [
    c.exact.id, // exact name first, though not joined
    c.alpha.id, c.guests.id, c.joint.id, // live, joined (by name)
    c.beta.id, // live, not joined
    c.gamma.id, // archived
    c.described.id, // only the description matches
  ]);
  assert.equal(found.total, 7);
  assert.equal(found.nextCursor, null);
  assert.ok(!found.items.some((item) => item.id === c.secret.id), "a private channel the reader isn't in is never found");

  const byId = new Map(found.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(c.alpha.id), {
    id: c.alpha.id, name: c.alpha.name, description: null, type: "channel",
    archived: false, joined: true, external: false, guest: false, canPost: true, requiredAction: null,
  });
  assert.deepEqual(
    pick(byId.get(c.beta.id)),
    { archived: false, joined: false, external: false, guest: false, canPost: false, requiredAction: "join_channel" },
  );
  assert.deepEqual(
    pick(byId.get(c.gamma.id)),
    { archived: true, joined: true, external: false, guest: false, canPost: false, requiredAction: null },
    "archived: readable, never writable, nothing to join",
  );
  assert.deepEqual(pick(byId.get(c.joint.id)), { archived: false, joined: true, external: true, guest: false, canPost: true, requiredAction: null });
  assert.equal(byId.get(c.joint.id).type, "joint");
  // The member may not see Guests: the Guest's channel isn't marked to them.
  assert.equal(byId.get(c.guests.id).guest, false);

  // The owner reads the private channel and sees the Guest's channel marked.
  const ownerFound = await group(app, x.who.owner, { q: x.w, app: "channels", limit: 50 });
  const ownerById = new Map(ownerFound.items.map((item) => [item.id, item]));
  assert.equal(ownerById.get(c.secret.id)?.joined, true);
  assert.equal(ownerById.get(c.guests.id)?.guest, true);
  assert.ok(!ownerById.has(c.joint.id), "a joint the owner isn't in is not readable to them");

  // A leading `#` is the same search.
  assert.deepEqual((await group(app, x.who.member, { q: `#${x.w}`, app: "channels", limit: 50 })).items.map((item) => item.id), found.items.map((item) => item.id));
});

test("channels: a Guest finds only its own channel; its people group is empty", async ({ app, seed }) => {
  const x = await world(seed);
  const found = await group(app, x.who.guest, { q: x.w, app: "channels" });
  assert.deepEqual(found.items.map((item) => item.id), [x.channels.guests.id]);
  assert.deepEqual(pick(found.items[0]), { archived: false, joined: true, external: false, guest: false, canPost: true, requiredAction: null });
  assert.deepEqual(await group(app, x.who.guest, { q: x.w, app: "people" }), { app: "people", items: [], nextCursor: null, total: 0 });
});

test("people: members and findable agents, exact name first; Guests only for owners and admins; another person's assistant never; DM status per person", async ({ app, seed }) => {
  const x = await world(seed);
  const asMember = await group(app, x.who.member, { q: x.w, app: "people", limit: 50 });
  const ids = asMember.items.map((item) => `${item.kind}:${item.id}`);
  assert.equal(ids[0], `agent:${x.agents.agentExact.id}`, "the exact name leads");
  assert.deepEqual([...ids].sort(), [
    `agent:${x.agents.agentExact.id}`, `agent:${x.agents.bot.id}`, `human:${x.member.id}`, `human:${x.owner.id}`,
  ].sort(), "no Guest, no other person's assistant");
  assert.equal(asMember.total, 4);
  const byId = new Map(asMember.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(x.agents.bot.id), {
    kind: "agent", id: x.agents.bot.id, name: x.agents.bot.name, displayName: byId.get(x.agents.bot.id).displayName,
    avatarUrl: byId.get(x.agents.bot.id).avatarUrl, role: byId.get(x.agents.bot.id).role,
    guest: false, dmChannelId: x.dm!.id, canPost: true, requiredAction: null,
  });
  assert.deepEqual(
    { role: byId.get(x.owner.id).role, guest: byId.get(x.owner.id).guest, dmChannelId: byId.get(x.owner.id).dmChannelId, canPost: byId.get(x.owner.id).canPost, requiredAction: byId.get(x.owner.id).requiredAction },
    { role: "owner", guest: false, dmChannelId: null, canPost: false, requiredAction: "create_dm" },
  );

  const asOwner = await group(app, x.who.owner, { q: x.w, app: "people", limit: 50 });
  const ownerById = new Map(asOwner.items.map((item) => [item.id, item]));
  assert.deepEqual({ role: ownerById.get(x.guest.id)?.role, guest: ownerById.get(x.guest.id)?.guest }, { role: "guest", guest: true });
  assert.ok(ownerById.has(x.agents.assistant.id), "the owner finds their own assistant");
  // A leading `@` is the same search.
  assert.equal((await group(app, x.who.owner, { q: `@${x.w}`, app: "people", limit: 50 })).total, asOwner.total);
});

test("people: an existing DM that is read-only by the plan's channel quota is not canPost (no action either); within the quota it is", async ({ app, seed }) => {
  const x = await world(seed);
  const botOf = async () => (await group(app, x.who.member, { q: x.agents.bot.name, app: "people" })).items.find((item) => item.id === x.agents.bot.id);
  assert.deepEqual({ dm: (await botOf()).dmChannelId, canPost: (await botOf()).canPost }, { dm: x.dm!.id, canPost: true });
  const originalMaxChannels = PLAN_CONFIG.free.limits.maxChannels;
  try {
    // Over the quota every DM of the server is read-only (the send gate, isChannelReadOnlyByQuota).
    PLAN_CONFIG.free.limits.maxChannels = 0;
    const bot = await botOf();
    assert.deepEqual(
      { dmChannelId: bot.dmChannelId, canPost: bot.canPost, requiredAction: bot.requiredAction },
      { dmChannelId: x.dm!.id, canPost: false, requiredAction: null },
      "the DM exists but the reader can't post there now",
    );
  } finally {
    PLAN_CONFIG.free.limits.maxChannels = originalMaxChannels;
  }
});

test("show all: `total` with the first page, and the group alone pages through every match with its cursor, in the same order; another search's cursor is 400 INVALID_CURSOR", async ({ app, seed }) => {
  const x = await world(seed);
  const all = await group(app, x.who.member, { q: x.w, app: "channels", limit: 50 });
  const first = await group(app, x.who.member, { q: x.w, app: "channels", limit: 2 });
  assert.equal(first.total, all.total);
  assert.equal(first.items.length, 2);
  const paged = [...first.items];
  for (let cursor = first.nextCursor; cursor !== null;) {
    const next = await group(app, x.who.member, { q: x.w, app: "channels", limit: 2, cursor: cursor as never });
    assert.equal(next.total, all.total);
    paged.push(...next.items);
    cursor = next.nextCursor;
  }
  assert.deepEqual(paged.map((item) => item.id), all.items.map((item) => item.id));

  // Without `limit` a core group holds 10 (WEB_SEARCH_CORE_DEFAULT_LIMIT).
  for (let i = 0; i < 10; i += 1) await seed.channel({ server: x.server, members: [], name: `${x.w}-more-${i}` });
  const defaulted = await group(app, x.who.member, { q: x.w, app: "channels" });
  assert.equal(defaulted.items.length, 10);
  assert.equal(defaulted.total, 17);
  assert.ok(defaulted.nextCursor);

  for (const query of [
    { q: `${x.w}-alpha`, app: "channels" as const, cursor: first.nextCursor as never },
    { q: x.w, app: "people" as const, cursor: first.nextCursor as never },
    { q: x.w, app: "channels" as const, cursor: "channels.1.not-a-real-tag!" as never },
  ]) {
    const reply = await search(app, x.who.member, query);
    assert.equal(reply.status, 400, JSON.stringify(query));
    assert.equal(reply.body.code, "INVALID_CURSOR");
  }
});

test("old consumers are unaffected: without `include` or a core `app` the answer is the app groups alone, as before; `include` adds the core groups after them", async ({ app, seed }) => {
  const x = await world(seed);
  const plain = await search(app, x.who.member, { q: x.w });
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.groups.map((g: { app: string }) => g.app), ["artifacts"]);
  assert.ok(!("total" in plain.body.groups[0]), "an app group's shape is unchanged");
  const artifactsOnly = await search(app, x.who.member, { q: x.w, app: "artifacts" });
  assert.deepEqual(artifactsOnly.body.groups.map((g: { app: string }) => g.app), ["artifacts"]);

  const both = await search(app, x.who.member, { q: x.w, include: ["people", "channels"] });
  assert.equal(both.status, 200);
  assert.deepEqual(both.body.groups.map((g: { app: string }) => g.app), ["artifacts", "channels", "people"], "in the contract's order, after the app groups");
  const channelsGroup = both.body.groups[1];
  assert.equal(channelsGroup.total, 7);
  assert.equal(channelsGroup.items.length, 7);

  // Artifacts off: the core groups still answer (they have no flag).
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const coreOnly = await search(app, x.who.member, { q: x.w, include: ["channels"] });
  assert.deepEqual(coreOnly.body.groups.map((g: { app: string }) => g.app), ["channels"]);
  assert.equal((await search(app, x.who.member, { q: x.w })).body.groups.length, 0);

  for (const path of [
    `/api/search?q=${x.w}&include=bogus`,
    `/api/search?q=${x.w}&include=`,
    `/api/search?q=${x.w}&include=channels&app=artifacts`,
    `/api/search?q=${x.w}&include=channels&cursor=x`,
  ]) {
    const reply = await get(app, path, x.who.member);
    assert.equal(reply.status, 400, path);
    assert.equal(reply.body.code, "INVALID_REQUEST", path);
  }
});

test("a deleted channel is never found", async ({ app, seed }) => {
  const x = await world(seed);
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, x.channels.beta.id));
  const found = await group(app, x.who.owner, { q: x.w, app: "channels", limit: 50 });
  assert.ok(!found.items.some((item) => item.id === x.channels.beta.id));
});

function pick(item: any) {
  const { archived, joined, external, guest, canPost, requiredAction } = item;
  return { archived, joined, external, guest, canPost, requiredAction };
}
