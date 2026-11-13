import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PLAN_UPGRADE_CARD_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setAgentHistoryBlockStoreForTests, countAgentHistoryBlocks7d } from "../services/agentHistoryBlocks";
import { useStripeBillingConfigured } from "../test/stripeBillingEnv";

const test = createApiTest();
// Billing set up for the pending #14512's test of the search card sentence (upgrade cards need it).
useStripeBillingConfigured();

// Message search on a Free server: a hit inside the 30-day window whose thread
// starts behind it names that first message by a 40-character preview only,
// as Activity and the saved list do (services/historyPreview.ts; cindyz,
// #proj-commercial task #8).

const PARENT = "the old plan we agreed on two months ago, with every detail of the budget spelled out";
const PARENT_PREVIEW = "the old plan we agreed on two months ag…";

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `history-search-${suffix}@slock.test`,
    name: `history-search-${suffix}`,
    displayName: "Search Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("History Search", `history-search-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `SearchBot${suffix}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `search-${suffix}`);
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const parent = await createMessage(channel.id, "user", owner!.id, PARENT, "chat");
  const thread = await getOrCreateThread(parent.id, owner!.id, "user");
  const marker = `picking-up-${suffix}`;
  const reply = await createMessage(thread.id, "user", owner!.id, `${marker} this week`, "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${parent.id}::uuid`);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: `history-search-${suffix}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { server, reply, marker, apiKey, token: await tokenForHuman(owner!.email) };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
type SearchBody = { error?: string; results: Array<{ id: string; parentMessageContent: string | null }> };

async function humanSearch(baseUrl: string, fx: Fixture): Promise<SearchBody> {
  const res = await fetch(`${baseUrl}/api/messages/search?q=${encodeURIComponent(fx.marker)}&limit=10`, {
    headers: { Authorization: `Bearer ${fx.token}`, "X-Server-Id": fx.server.id },
  });
  const body = await res.json() as SearchBody;
  assert.equal(res.status, 200, body.error);
  return body;
}

async function agentSearch(baseUrl: string, fx: Fixture): Promise<SearchBody> {
  const res = await fetch(`${baseUrl}/internal/agent-api/search?${new URLSearchParams({ q: fx.marker, limit: "10" })}`, {
    headers: { Authorization: `Bearer ${fx.apiKey}` },
  });
  const body = await res.json() as SearchBody;
  assert.equal(res.status, 200, body.error);
  return body;
}

test("a person's search hit in a thread that starts behind the window shows its first message cut to 40 characters", async ({ app }) => {
  const fx = await seedFixture();
  const free = await humanSearch(app.baseUrl, fx);
  assert.deepEqual(free.results.map((result) => result.id), [fx.reply.id]);
  assert.equal(free.results[0]?.parentMessageContent, PARENT_PREVIEW);

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await humanSearch(app.baseUrl, fx)).results[0]?.parentMessageContent, PARENT, "Pro shows it in full");
});

test("an agent's search hit in a thread that starts behind the window shows its first message cut to 40 characters", async ({ app }) => {
  const fx = await seedFixture();
  const free = await agentSearch(app.baseUrl, fx);
  assert.deepEqual(free.results.map((result) => result.id), [fx.reply.id]);
  assert.equal(free.results[0]?.parentMessageContent, PARENT_PREVIEW);

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await agentSearch(app.baseUrl, fx)).results[0]?.parentMessageContent, PARENT, "Pro shows it in full");
});

test("an agent's search says how many matches the window hides, so it doesn't report nothing found (task #24, F)", async ({ app }) => {
  const fx = await seedFixture();
  const search = async (q: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/search?${new URLSearchParams({ q, limit: "10" })}`, {
      headers: { Authorization: `Bearer ${fx.apiKey}` },
    });
    const body = await res.json() as SearchBody & { historyLimited?: boolean; historyLimitMessage?: string; olderHidden?: { count: number; capped: boolean } };
    assert.equal(res.status, 200, body.error);
    return body;
  };
  const hidden = await search("budget");
  assert.deepEqual(hidden.results, [], "the only match is behind the window");
  assert.equal(hidden.historyLimited, true);
  assert.deepEqual(hidden.olderHidden, { count: 1, capped: false });
  assert.match(
    hidden.historyLimitMessage ?? "",
    /^1 older match is hidden: this server is on the Free plan, which keeps the last 30 days, so don't say nothing older exists\. Upgrading to Pro restores the full history\./,
  );

  // A range all behind the window never runs the page; its count still falls
  // back to any of the words, as the page would (Cody, #14467 review).
  const res = await fetch(`${app.baseUrl}/internal/agent-api/search?${new URLSearchParams({
    q: "budget roadmap",
    before: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
    limit: "10",
  })}`, { headers: { Authorization: `Bearer ${fx.apiKey}` } });
  const behind = await res.json() as { results: unknown[]; historyLimited?: boolean; olderHidden?: { count: number; capped: boolean } };
  assert.equal(res.status, 200);
  assert.deepEqual(behind.results, []);
  assert.deepEqual(behind.olderHidden, { count: 1, capped: false }, "the old message has only one of the words");
  assert.equal(behind.historyLimited, true);
  const nowhere = await search("budget roadmap");
  assert.deepEqual(nowhere.olderHidden, { count: 1, capped: false }, "the page fell back to any word, and so did the count");

  const inside = await search(fx.marker);
  assert.equal(inside.historyLimited, undefined, "nothing older matches: no line");
  assert.deepEqual(inside.olderHidden, { count: 0, capped: false });

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = await search("budget");
  assert.equal(pro.results.length, 1, "Pro finds it");
  assert.equal(pro.historyLimited, undefined);
  assert.equal(pro.olderHidden, undefined);
});

test("an agent's search whose window hid matches counts as one reach a day (task #24, C+ step 2)", async ({ app }) => {
  const fx = await seedFixture();
  const sets = new Map<string, Set<string>>();
  __setAgentHistoryBlockStoreForTests({
    async add(key, member) {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
    },
    async sizes(keys) {
      return keys.map((key) => sets.get(key)?.size ?? 0);
    },
  });
  const search = (q: string) => fetch(`${app.baseUrl}/internal/agent-api/search?${new URLSearchParams({ q, limit: "10" })}`, {
    headers: { Authorization: `Bearer ${fx.apiKey}` },
  });
  try {
    assert.equal((await search(fx.marker)).status, 200);
    assert.equal(await countAgentHistoryBlocks7d(fx.server.id), 0, "nothing hidden: not a reach");
    assert.equal((await search("budget")).status, 200);
    assert.equal((await search("budget")).status, 200);
    assert.equal(await countAgentHistoryBlocks7d(fx.server.id), 1, "hidden matches: once a day");
    assert.deepEqual([...sets.values()].flatMap((set) => [...set]).map((member) => member.split(":")[1]), ["search"]);
  } finally {
    __setAgentHistoryBlockStoreForTests(null);
  }
});

test("an agent's hidden-matches line offers the upgrade card only to a client that can post it, on Free", async ({ app }) => {
  const fx = await seedFixture();
  const search = async (headers: Record<string, string> = {}) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/search?${new URLSearchParams({ q: "budget", limit: "10" })}`, {
      headers: { Authorization: `Bearer ${fx.apiKey}`, ...headers },
    });
    assert.equal(res.status, 200);
    return await res.json() as { historyLimited?: boolean; historyLimitMessage?: string };
  };
  const capable = await search({ [RAFT_CLIENT_CAPABILITIES_HEADER]: PLAN_UPGRADE_CARD_CAPABILITY });
  assert.match(
    capable.historyLimitMessage ?? "",
    / If someone asked you for these, you can offer an upgrade card in their conversation: pipe \{"type":"plan:upgrade","gate":"history_30d",.*\} into raft action prepare --target "<their conversation>" \(a heredoc, as with raft message send\)\.$/,
  );
  const older = await search();
  assert.equal(older.historyLimited, true);
  assert.doesNotMatch(older.historyLimitMessage ?? "", /raft action prepare/, "a client that can't post the card isn't offered one");
});
