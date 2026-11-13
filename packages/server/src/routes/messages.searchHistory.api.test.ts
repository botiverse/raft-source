import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, messages, serverMembers, servers, users } from "../db/schema";
import { createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { searchAfterWithinHistory } from "../services/searchService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("searchAfterWithinHistory keeps search inside the plan's history window", () => {
  const cutoff = new Date("2026-09-21T00:00:00.000Z");
  assert.equal(searchAfterWithinHistory(undefined, undefined, undefined), undefined, "unlimited plans search everything");
  assert.equal(searchAfterWithinHistory(undefined, undefined, cutoff), cutoff);
  assert.equal(searchAfterWithinHistory(new Date("2020-01-01T00:00:00.000Z"), undefined, cutoff), cutoff, "an earlier after is raised to the cutoff");
  const later = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(searchAfterWithinHistory(later, undefined, cutoff), later, "a later after is kept");
  assert.equal(searchAfterWithinHistory(undefined, new Date("2026-01-01T00:00:00.000Z"), cutoff), null, "a range that ends before the cutoff matches nothing");
});

test("GET /messages/search on a free server finds only messages inside the history window", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-history-owner@slock.test", "search-history-owner");
  const server = await createServer("Search History Server", "search-history-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  await db.update(servers).set({ plan: "free", createdAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "search-history-channel");
  const oldHit = await createMessage(channel.id, "user", owner.id, "lanternfish from long ago");
  const recentHit = await createMessage(channel.id, "user", owner.id, "lanternfish from this week");
  await db.update(messages).set({ createdAt: new Date("2020-01-02T00:00:00.000Z") }).where(eq(messages.id, oldHit.id));

  const token = await tokenForHuman(owner.email);
  const search = async (params: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    return await res.json() as { results: Array<{ id: string }>; historyLimited: boolean };
  };

  for (const sort of ["relevance", "recent"]) {
    const body = await search(`q=lanternfish&sort=${sort}`);
    assert.deepEqual(body.results.map((row) => row.id), [recentHit.id], `${sort}: the message older than the cutoff is not returned`);
    assert.equal(body.historyLimited, true, `${sort}: the page is told older history was left out`);
  }

  const beforeWindow = await search(`q=lanternfish&before=${encodeURIComponent("2021-01-01T00:00:00.000Z")}`);
  assert.deepEqual(beforeWindow.results, [], "a date range entirely before the cutoff finds nothing");
  assert.equal(beforeWindow.historyLimited, true);

  const insideWindow = await search(`q=lanternfish&after=${encodeURIComponent(new Date(Date.now() - DAY_MS).toISOString())}`);
  assert.deepEqual(insideWindow.results.map((row) => row.id), [recentHit.id]);
  assert.equal(insideWindow.historyLimited, false, "a range inside the window was not narrowed");

  const filterOnly = await search(`channelId=${channel.id}`);
  assert.deepEqual(filterOnly.results.map((row) => row.id), [recentHit.id], "filter-only search is bounded too");
  assert.equal(filterOnly.historyLimited, false, "a channel younger than the window has nothing older to mention");
  await db.update(channels).set({ createdAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(channels.id, channel.id));
  const olderChannel = await search(`channelId=${channel.id}&q=lanternfish`);
  assert.deepEqual(olderChannel.results.map((row) => row.id), [recentHit.id]);
  assert.equal(olderChannel.historyLimited, true, "a channel older than the window says its older history was left out");

  await db.update(servers).set({ createdAt: new Date() }).where(eq(servers.id, server.id));
  const newServer = await search("q=lanternfish");
  assert.deepEqual(newServer.results.map((row) => row.id), [recentHit.id]);
  assert.equal(newServer.historyLimited, false, "a server younger than the window has nothing older to mention");

  await db.update(servers).set({ plan: "founder", createdAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(servers.id, server.id));
  const unlimited = await search("q=lanternfish&sort=recent");
  assert.deepEqual(unlimited.results.map((row) => row.id), [recentHit.id, oldHit.id], "unlimited plans search all history");
  assert.equal(unlimited.historyLimited, false);
});
