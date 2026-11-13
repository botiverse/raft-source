// Core's mention audience for conversations (POST /api/mentions/audience,
// routes/mentions.ts, platform/mentions.ts): a member gets the members, a
// thread its parent's; whoever can't see it gets the one 404 an unknown
// audience gets; a guest gets whom it meets; where people are hidden, a
// member of #all gets only whom core shows it; a joint channel includes the
// other servers' members without their roles; `q`, the cap and a constant
// number of queries; read up to the cap in the database, every cap the first
// ones of the whole answer (hidden people and guests included). Object audiences: apps/artifacts/mentionAudience.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  MENTION_AUDIENCE_MAX_CANDIDATES,
  asServerId,
  mentionAudiencePaths,
  type MentionAudienceActor,
  type MentionAudienceCandidates,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, serverMembers, servers, users } from "../db/schema";
import { mentionAudience } from "../platform/mentions";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getOrCreateThreadForChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { apiTest as test, createApiTest } from "../test/integration/apiTest";
import type { createHttpClient } from "../test/integration/http";
import { seedJointChannel } from "../test/integration/jointFixture";
import type { createSeed } from "../test/integration/seed";
import { seedBoundGuest } from "../test/guestFixture";

type Seed = ReturnType<typeof createSeed>;
type Http = ReturnType<typeof createHttpClient>;
const label = () => randomUUID().slice(0, 8);
const limitedTest = createApiTest({ appRateLimitMax: { "mentions.audience": 2 } });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as visibilityService.homes.api.test.ts). */
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

/**
 * A server with owner, alice, bob, carol (members) and gus (a guest bound
 * to #room, #wg-rbac:#15); #priv (alice, bob, agent A); #room (gus, alice, agent
 * A); agent Z in no conversation; a peer server (peerOwner).
 */
async function fixture(seed: Seed) {
  const owner = await seed.human();
  const alice = await seed.human();
  const bob = await seed.human();
  const carol = await seed.human();
  const gus = await seed.human();
  const server = await seed.server({ owner, members: [alice, bob, carol, gus] });
  const db = getDb();
  const agentA = await createAgent(server.id, `ma-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentZ = await createAgent(server.id, `ma-z-${label()}`, { runtime: "claude", model: "sonnet" });
  const priv = await createChannel(server.id, `ma-priv-${label()}`, undefined, "private");
  for (const human of [alice, bob]) await addHuman(priv.id, human.id);
  await addAgent(priv.id, agentA.id);
  const room = await createChannel(server.id, `ma-room-${label()}`, undefined, "private");
  await addHuman(room.id, alice.id);
  await seedBoundGuest({ serverId: server.id, userId: gus.id, channelId: room.id });
  await addAgent(room.id, agentA.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const [all] = await db.select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  return { owner, alice, bob, carol, gus, server, agentA, agentZ, priv, room, peerOwner, peer, all: all! };
}

const conversation = (channelId: string) => ({ kind: "conversation", channelId });

async function ask(http: Http, who: { id: string }, server: { id: string }, body: unknown) {
  const response = await http.as(who, server).request(mentionAudiencePaths.audience(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() as any };
}

async function audience(http: Http, who: { id: string }, server: { id: string }, channelId: string, q?: string): Promise<MentionAudienceCandidates> {
  const answer = await ask(http, who, server, { audience: conversation(channelId), ...(q === undefined ? {} : { q }) });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.cacheControl, "private, no-store");
  return answer.body;
}

const keys = (answer: MentionAudienceCandidates) => answer.candidates.map((c) => `${c.type}:${c.id}`);
const set = (answer: MentionAudienceCandidates) => new Set(keys(answer));
const user = (id: string) => `user:${id}`;
const agent = (id: string) => `agent:${id}`;

test("a member gets the conversation's members, people first then by handle, with core's profile; a thread its parent's", async ({ seed, http }) => {
  const f = await fixture(seed);
  const answer = await audience(http, f.alice, f.server, f.priv.id);
  const people = [f.alice, f.bob].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(keys(answer), [...people.map((p) => user(p.id)), agent(f.agentA.id)]);
  assert.equal(answer.capped, false);
  assert.deepEqual(answer.candidates.find((c) => c.id === f.bob.id), {
    type: "user", id: f.bob.id, name: f.bob.name, displayName: f.bob.displayName || f.bob.name, avatarUrl: null, guest: false,
  } satisfies MentionAudienceActor);
  assert.deepEqual(answer.candidates.find((c) => c.id === f.agentA.id), {
    type: "agent", id: f.agentA.id, name: f.agentA.name, displayName: f.agentA.displayName || f.agentA.name, avatarUrl: f.agentA.avatarUrl ?? null, guest: false,
  } satisfies MentionAudienceActor);
  // A retired person is not offered.
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.bob.id));
  assert.equal(set(await audience(http, f.alice, f.server, f.priv.id)).has(user(f.bob.id)), false);
  await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, f.bob.id));

  // A thread stands for its parent conversation.
  const root = await createMessage(f.priv.id, "user", f.alice.id, "root");
  const thread = await getOrCreateThreadForChannel(f.priv.id, root.id, f.alice.id, "user");
  assert.deepEqual(keys(await audience(http, f.alice, f.server, thread.id)), keys(answer));
});

test("whoever can't see the conversation gets the one 404 an unknown audience gets", async ({ seed, http }) => {
  const f = await fixture(seed);
  const notFound = { error: "no such audience", code: "NOT_FOUND" };
  const refused = async (who: { id: string }, server: { id: string }, body: unknown, why: string) => {
    const answer = await ask(http, who, server, body);
    assert.equal(answer.status, 404, why);
    assert.deepEqual(answer.body, notFound, why);
    assert.equal(answer.cacheControl, "private, no-store");
  };
  assert.equal((await ask(http, f.bob, f.server, { audience: conversation(f.priv.id) })).status, 200, "witness: a member sees it");
  await refused(f.carol, f.server, { audience: conversation(f.priv.id) }, "a member of the server outside the private channel");
  await refused(f.gus, f.server, { audience: conversation(f.priv.id) }, "a guest outside it");
  await refused(f.carol, f.server, { audience: conversation(randomUUID()) }, "no such conversation");
  await refused(f.carol, f.server, { audience: conversation("not-a-uuid") }, "not an id");
  // Another server's conversation, even for someone in both.
  await getDb().insert(serverMembers).values({ serverId: f.peer.id, userId: f.alice.id, role: "member" });
  await refused(f.alice, f.peer, { audience: conversation(f.priv.id) }, "another server's conversation");
  // Thread of a private channel: its parent's rule.
  const root = await createMessage(f.priv.id, "user", f.alice.id, "root");
  const thread = await getOrCreateThreadForChannel(f.priv.id, root.id, f.alice.id, "user");
  await refused(f.carol, f.server, { audience: conversation(thread.id) }, "a thread of a channel the reader can't see");
  // An unknown app or kind, or a kind under another app's id.
  await refused(f.alice, f.server, { audience: { kind: "object", app: "nope", objectKind: "nope", objectId: "x" } }, "unknown app and kind");
  // Malformed bodies are 400.
  for (const body of [{}, { audience: conversation(f.priv.id), q: 3 }, { audience: { kind: "conversation" } }, { audience: conversation(f.priv.id), extra: 1 }, { audience: { kind: "people" } }]) {
    const answer = await ask(http, f.alice, f.server, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, "INVALID_REQUEST");
  }
});

test("a guest gets whom it meets (its conversation's members, marked guest where they are); where people are hidden, a member of #all gets only whom core shows it", async ({ seed, http }) => {
  const f = await fixture(seed);
  const room = await audience(http, f.gus, f.server, f.room.id);
  assert.deepEqual(set(room), new Set([user(f.gus.id), user(f.alice.id), agent(f.agentA.id)]));
  assert.equal(room.candidates.find((c) => c.id === f.gus.id)!.guest, true, "a guest is marked");
  assert.equal(room.candidates.find((c) => c.id === f.alice.id)!.guest, false);
  // A member sees the guest marked too.
  assert.equal((await audience(http, f.alice, f.server, f.room.id)).candidates.find((c) => c.id === f.gus.id)!.guest, true);

  // carol shares #shared with alice, nothing else (besides #all) with anyone.
  const shared = await createChannel(f.server.id, `ma-shared-${label()}`, undefined, "private");
  for (const human of [f.carol, f.alice]) await addHuman(shared.id, human.id);
  const everyoneInAll = set(await audience(http, f.carol, f.server, f.all.id));
  for (const id of [f.owner.id, f.alice.id, f.bob.id, f.carol.id]) assert.ok(everyoneInAll.has(user(id)), "witness: without the setting #all offers every member");
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));
  const hidden = set(await audience(http, f.carol, f.server, f.all.id));
  assert.ok(hidden.has(user(f.carol.id)) && hidden.has(user(f.alice.id)), "itself and whom it shares a conversation with");
  assert.equal(hidden.has(user(f.bob.id)), false, "not whom it shares only #all with");
  assert.equal(hidden.has(user(f.owner.id)), false);
  for (const id of [f.agentA.id, f.agentZ.id]) assert.ok(hidden.has(agent(id)), "every agent");
  // The same people as core's member profile route for carol.
  const profile = async (memberId: string) => (await http.as(f.carol, f.server).get(`/api/servers/${f.server.id}/members/${memberId}/profile`)).status;
  for (const person of [f.owner, f.alice, f.bob]) assert.equal(hidden.has(user(person.id)), await profile(person.id) === 200, `core and the picker agree on ${person.name}`);
  // The owner is shown everyone.
  const ownerView = set(await audience(http, f.owner, f.server, f.all.id));
  for (const id of [f.alice.id, f.bob.id, f.carol.id]) assert.ok(ownerView.has(user(id)));
});

test("a joint channel offers every server's members, another server's without roles; only to whoever sees the channel", async ({ seed, http }) => {
  const f = await fixture(seed);
  const peerHuman = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: f.peer.id, userId: peerHuman.id, role: "member" });
  const peerAgent = await createAgent(f.peer.id, `ma-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `ma-joint-${label()}`, serverIds: [f.server.id, f.peer.id], createdByUserId: f.owner.id });
  const [local, remote] = joint.projections;
  // Guests enter a joint channel only through the host's copy they are bound
  // to (P3, computed joint membership), so none is in this one.
  await addHuman(local!.id, f.alice.id);
  await addHuman(remote!.id, peerHuman.id);
  await addAgent(remote!.id, peerAgent.id);

  const answer = await audience(http, f.alice, f.server, local!.id);
  assert.deepEqual(set(answer), new Set([user(f.alice.id), user(peerHuman.id), agent(peerAgent.id)]));
  assert.equal(answer.candidates.find((c) => c.id === peerHuman.id)!.guest, false, "another server's role stays with it");
  assert.deepEqual(answer.candidates.find((c) => c.id === peerAgent.id), {
    type: "agent", id: peerAgent.id, name: peerAgent.name, displayName: peerAgent.displayName || peerAgent.name, avatarUrl: peerAgent.avatarUrl ?? null, guest: false,
  });
  // From the other side, the same channel offers this server's members.
  const fromPeer = await audience(http, peerHuman, f.peer, remote!.id);
  assert.ok(set(fromPeer).has(user(f.alice.id)));
  // `q` finds another server's member by handle.
  assert.deepEqual(keys(await audience(http, f.alice, f.server, local!.id, peerHuman.name)), [user(peerHuman.id)]);
  // A member of this server outside the joint channel: the one 404.
  assert.equal((await ask(http, f.carol, f.server, { audience: conversation(local!.id) })).status, 404);
});

test("q matches handles and display names in any case, `%` literal; the list is capped with `capped`", async ({ seed, http }) => {
  const f = await fixture(seed);
  assert.deepEqual(keys(await audience(http, f.alice, f.server, f.priv.id, f.bob.name.toUpperCase())), [user(f.bob.id)]);
  assert.deepEqual(keys(await audience(http, f.alice, f.server, f.priv.id, `  ${f.agentA.name}  `)), [agent(f.agentA.id)], "trimmed");
  assert.deepEqual(keys(await audience(http, f.alice, f.server, f.priv.id, "%")), []);
  assert.deepEqual(keys(await audience(http, f.alice, f.server, f.priv.id, f.carol.name)), [], "not someone outside it");
  await getDb().update(users).set({ displayName: "Zebra Person" }).where(eq(users.id, f.bob.id));
  assert.deepEqual(keys(await audience(http, f.alice, f.server, f.priv.id, "zebra")), [user(f.bob.id)], "by display name");

  // The cap (MENTION_AUDIENCE_MAX_CANDIDATES on the route), lowered here.
  const reader = { userId: f.alice.id, serverId: asServerId(f.server.id) };
  const target = { kind: "conversation" as const, channelId: f.priv.id };
  const two = await mentionAudience(reader, target, { q: "", limit: 2 });
  assert.equal(two!.candidates.length, 2);
  assert.equal(two!.capped, true);
  const three = await mentionAudience(reader, target, { q: "", limit: 3 });
  assert.equal(three!.candidates.length, 3);
  assert.equal(three!.capped, false);
  assert.deepEqual(two!.candidates, three!.candidates.slice(0, 2), "the first ones in order");
  assert.equal(MENTION_AUDIENCE_MAX_CANDIDATES, 200);
});

test("the number of queries doesn't grow with the number of people (2 vs 12)", async ({ seed }) => {
  const f = await fixture(seed);
  const extra = [];
  for (let index = 0; index < 11; index += 1) {
    const human = await seed.human();
    await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: human.id, role: "member" });
    extra.push(human);
  }
  const small = await createChannel(f.server.id, `ma-small-${label()}`, undefined, "private");
  const large = await createChannel(f.server.id, `ma-large-${label()}`, undefined, "private");
  for (const human of [f.alice, f.bob]) await addHuman(small.id, human.id);
  for (const human of [f.alice, ...extra]) await addHuman(large.id, human.id);
  const reader = { userId: f.alice.id, serverId: asServerId(f.server.id) };
  const run = (channelId: string) => countQueries(() => mentionAudience(reader, { kind: "conversation", channelId }, { q: "", limit: 200 }));
  const few = await run(small.id);
  const many = await run(large.id);
  assert.equal(few.value!.candidates.length, 2);
  assert.equal(many.value!.candidates.length, 12);
  assert.equal(many.queries, few.queries, `queries: ${few.queries} for 2 people, ${many.queries} for 12`);
  // And where people are hidden (the batched hidden-directory check).
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));
  const hiddenFew = await run(small.id);
  const hiddenMany = await run(large.id);
  assert.equal(hiddenMany.queries, hiddenFew.queries, `hidden: ${hiddenFew.queries} for 2 people, ${hiddenMany.queries} for 12`);
});

/** The most rows any one query `fn` sends returned (the pg client's answers). */
async function largestAnswer<T>(fn: () => Promise<T>): Promise<{ rows: number; value: T }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let rows = 0;
  pg.query = (async (...args: unknown[]) => {
    const result = await originalQuery(...args) as { rows?: unknown[] } | undefined;
    rows = Math.max(rows, result?.rows?.length ?? 0);
    return result;
  }) as PgliteLike["query"];
  try {
    const value = await fn();
    return { rows, value };
  } finally {
    pg.query = originalQuery;
  }
}

/** `count` more people of the server (named `name(index)` when given), each added to `channelIds`. */
async function crowd(seed: Seed, serverId: string, count: number, channelIds: readonly string[], name?: (index: number) => string) {
  const people = [];
  for (let index = 0; index < count; index += 1) {
    const human = await seed.human(name ? { name: name(index), email: `${name(index)}@test.invalid` } : {});
    await getDb().insert(serverMembers).values({ serverId, userId: human.id, role: "member" });
    for (const channelId of channelIds) await addHuman(channelId, human.id);
    people.push(human);
  }
  return people;
}

/** Every cap from 1 to the whole answer gives its first ones, `capped` while more are left. */
async function assertCapsArePrefixes(reader: { userId: string; serverId: ReturnType<typeof asServerId> }, channelId: string, q = "") {
  const target = { kind: "conversation" as const, channelId };
  const whole = (await mentionAudience(reader, target, { q, limit: 200 }))!;
  assert.equal(whole.capped, false);
  for (let limit = 1; limit <= whole.candidates.length; limit += 1) {
    const answer = (await mentionAudience(reader, target, { q, limit }))!;
    assert.deepEqual(answer.candidates, whole.candidates.slice(0, limit), `limit ${limit}`);
    assert.equal(answer.capped, limit < whole.candidates.length, `capped at limit ${limit}`);
  }
  return whole;
}

test("a small conversation's answer is the whole roster in the order it always had (people by handle as JavaScript compares them, then agents)", async ({ seed }) => {
  const f = await fixture(seed);
  // A database that sorts byte-wise puts "B…" before "a…"; the answer keeps localeCompare's order.
  await getDb().update(users).set({ name: `B-${label()}` }).where(eq(users.id, f.alice.id));
  await getDb().update(users).set({ name: `a-${label()}`, displayName: "Zebra" }).where(eq(users.id, f.bob.id));
  const [alice] = await getDb().select().from(users).where(eq(users.id, f.alice.id));
  const [bob] = await getDb().select().from(users).where(eq(users.id, f.bob.id));
  const reader = { userId: f.alice.id, serverId: asServerId(f.server.id) };
  const whole = await assertCapsArePrefixes(reader, f.priv.id);
  assert.deepEqual(keys(whole), [user(bob!.id), user(alice!.id), agent(f.agentA.id)]);
  assert.deepEqual(whole.candidates[0], { type: "user", id: bob!.id, name: bob!.name, displayName: "Zebra", avatarUrl: null, guest: false });
  // `q` in the database: by handle and by display name, the same order.
  assert.deepEqual(keys((await mentionAudience(reader, { kind: "conversation", channelId: f.priv.id }, { q: "zEbRa", limit: 200 }))!), [user(bob!.id)]);
  assert.deepEqual(keys((await mentionAudience(reader, { kind: "conversation", channelId: f.priv.id }, { q: "-", limit: 200 }))!), keys(whole));
});

test("a conversation larger than the cap is read up to the cap in the database: its first ones, `capped`, no query answering with the whole roster", async ({ seed }) => {
  const f = await fixture(seed);
  const big = await createChannel(f.server.id, `ma-big-${label()}`, undefined, "private");
  await addHuman(big.id, f.alice.id);
  await addAgent(big.id, f.agentA.id);
  const people = [f.alice, ...await crowd(seed, f.server.id, 30, [big.id])];
  const reader = { userId: f.alice.id, serverId: asServerId(f.server.id) };
  const byHandle = (list: Array<{ id: string; name: string }>) => [...list].sort((a, b) => a.name.localeCompare(b.name)).map((p) => user(p.id));

  const whole = await mentionAudience(reader, { kind: "conversation", channelId: big.id }, { q: "", limit: 200 });
  assert.deepEqual(keys(whole!), [...byHandle(people), agent(f.agentA.id)]);
  assert.equal(whole!.capped, false);
  const first = await largestAnswer(() => mentionAudience(reader, { kind: "conversation", channelId: big.id }, { q: "", limit: 5 }));
  assert.deepEqual(keys(first.value!), byHandle(people).slice(0, 5));
  assert.equal(first.value!.capped, true);
  assert.ok(first.rows <= 6, `the largest answer was ${first.rows} rows (the cap + 1 is 6, the roster 32)`);

  // #all is the server's audience (no guest): the same.
  const owner = { userId: f.owner.id, serverId: asServerId(f.server.id) };
  const everyone = [f.owner, f.alice, f.bob, f.carol, ...people.slice(1)];
  const all = await mentionAudience(owner, { kind: "conversation", channelId: f.all.id }, { q: "", limit: 200 });
  assert.deepEqual(keys(all!).filter((key) => key.startsWith("user:")), byHandle(everyone), "every member but the guest");
  const allFirst = await largestAnswer(() => mentionAudience(owner, { kind: "conversation", channelId: f.all.id }, { q: "", limit: 5 }));
  assert.deepEqual(keys(allFirst.value!), byHandle(everyone).slice(0, 5));
  assert.equal(allFirst.value!.capped, true);
  assert.ok(allFirst.rows <= 6, `#all: the largest answer was ${allFirst.rows} rows`);
  // A cap the people fill exactly: `capped` from the agents left.
  const exact = await mentionAudience(owner, { kind: "conversation", channelId: f.all.id }, { q: "", limit: everyone.length });
  assert.deepEqual(keys(exact!), byHandle(everyone));
  assert.equal(exact!.capped, true);
});

test("where people are hidden, or for a guest, every cap still gives the first ones the reader is shown, reading past those it isn't", async ({ seed }) => {
  const f = await fixture(seed);
  // Eight people who sort before everyone else, in #all only: hidden from carol.
  const tag = label();
  const ahead = await crowd(seed, f.server.id, 8, [], (index) => `aaa-${tag}-${index}`);
  const shared = await createChannel(f.server.id, `ma-shared-${label()}`, undefined, "private");
  for (const human of [f.carol, f.alice]) await addHuman(shared.id, human.id);
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));
  const carol = { userId: f.carol.id, serverId: asServerId(f.server.id) };
  const whole = await assertCapsArePrefixes(carol, f.all.id);
  const people = whole.candidates.filter((c) => c.type === "user").map((c) => c.id);
  assert.deepEqual(people, [f.alice, f.carol].sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.id), "only itself and whom it shares a conversation with");
  for (const hidden of [...ahead, f.bob, f.owner]) assert.equal(people.includes(hidden.id), false);
  const two = (await mentionAudience(carol, { kind: "conversation", channelId: f.all.id }, { q: "", limit: 2 }))!;
  assert.deepEqual(two.candidates.map((c) => c.id), people, "past the eight it isn't shown");
  assert.equal(two.capped, true);

  // A guest in a conversation larger than the cap: the members it meets, the guest marked.
  await crowd(seed, f.server.id, 6, [f.room.id], (index) => `aab-${tag}-${index}`);
  const gus = { userId: f.gus.id, serverId: asServerId(f.server.id) };
  const room = await assertCapsArePrefixes(gus, f.room.id);
  assert.equal(room.candidates.length, 9);
  assert.equal(room.candidates.find((c) => c.id === f.gus.id)!.guest, true);
  assert.equal(room.candidates.filter((c) => c.guest).length, 1);
  // Whoever can't see it still gets nothing, capped or not.
  assert.equal(await mentionAudience(gus, { kind: "conversation", channelId: f.priv.id }, { q: "", limit: 1 }), null);
});

limitedTest("limited per user: 429 RATE_LIMITED", async ({ seed, http }) => {
  const f = await fixture(seed);
  const body = { audience: conversation(f.priv.id) };
  assert.equal((await ask(http, f.alice, f.server, body)).status, 200);
  assert.equal((await ask(http, f.alice, f.server, body)).status, 200);
  const third = await ask(http, f.alice, f.server, body);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "RATE_LIMITED");
});
