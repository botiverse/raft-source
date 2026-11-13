import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { resetPaywallHitsForTest } from "../services/serverProductEvents";

const test = createApiTest();

// paywall_hit where the server cuts or refuses for the plan
// (#proj-analytics:8fc671a3): the 30-day history only when it did leave older
// messages out of what this person reads, once per person, server, gate and day.

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID().slice(0, 8)}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function memorySink() {
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
  return { rows, sink };
}

/** Wait for what a request records without awaiting it (fire-and-forget), up to two seconds. */
async function waitFor(check: () => boolean, label: string) {
  const until = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** For "nothing more was recorded": give the requests' own writes time to land first. */
async function quiet() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("the 30-day history is a paywall hit when it left messages out: channel page, a context window, a jump behind it, search; once a day; never on Pro", async ({ app }) => {
  resetPaywallHitsForTest();
  const { rows, sink } = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
  const owner = await seedUser("hits-owner");
  const member = await seedUser("hits-member");
  const server = await createServer("Hits", `hits-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const channel = await createChannel(server.id, `hits-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const fresh = await createChannel(server.id, `hits-fresh-${randomUUID().slice(0, 6)}`);
  await addHuman(fresh.id, member.id);
  const old = await createMessage(channel.id, "user", owner.id, "an old message", "chat");
  const recent = await createMessage(channel.id, "user", owner.id, "a recent message", "chat");
  await createMessage(fresh.id, "user", owner.id, "only recent here", "chat");
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  // The server predates the cutoff, so a search over it is cut too.
  await getDb().execute(sql`UPDATE servers SET created_at = now() - interval '60 days', plan = 'free' WHERE id = ${server.id}::uuid`);
  const token = await tokenForHuman(member.email);
  const get = (path: string) => fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id } });
  const hits = () => rows.filter((row) => row.event === "paywall_hit").map((row) => row.properties);
  const HIT = { gate: "history_30d", actor: "person", plan: "free", viewer_role: "member" };

  // A channel with nothing behind the window: no hit.
  assert.equal((await get(`/api/messages/channel/${fresh.id}`)).status, 200);
  await quiet();
  assert.deepEqual(hits(), []);

  // Each route alone records it (a new day for each: the hit is once a day).
  assert.equal((await get(`/api/messages/channel/${channel.id}`)).status, 200);
  await waitFor(() => hits().length === 1, "channel page");
  assert.deepEqual(hits(), [HIT]);

  resetPaywallHitsForTest();
  assert.equal((await get(`/api/messages/context/${old.id}?channelId=${channel.id}`)).status, 404);
  await waitFor(() => hits().length === 2, "jump behind the window");

  resetPaywallHitsForTest();
  assert.equal((await get(`/api/messages/context/${recent.id}?channelId=${channel.id}`)).status, 200);
  await waitFor(() => hits().length === 3, "context window reaching the cutoff");

  resetPaywallHitsForTest();
  const search = await get(`/api/messages/search?q=message`);
  assert.equal(search.status, 200);
  assert.equal((await search.json() as { historyLimited?: boolean }).historyLimited, true, "the search was cut");
  await waitFor(() => hits().length === 4, "search");

  // The same day, again: nothing more.
  assert.equal((await get(`/api/messages/channel/${channel.id}`)).status, 200);
  await quiet();
  assert.equal(hits().length, 4, "once per person, server, gate and day");

  // Pro: nothing, on any route.
  resetPaywallHitsForTest();
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  assert.equal((await get(`/api/messages/channel/${channel.id}`)).status, 200);
  assert.equal((await get(`/api/messages/search?q=message`)).status, 200);
  await quiet();
  assert.equal(hits().length, 4, "no hit on Pro");
});
