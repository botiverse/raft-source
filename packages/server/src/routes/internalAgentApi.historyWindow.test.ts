import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, servers, users } from "../db/schema";
import { MANUAL_CONTEXT_CAPABILITY, PLAN_UPGRADE_CARD_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { recordMachineComputerVersion, registerMachine } from "../services/machineService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { prepareActionCard } from "../services/actionCardsService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { __setAgentHistoryBlockStoreForTests, countAgentHistoryBlocks7d } from "../services/agentHistoryBlocks";
import { useStripeBillingConfigured } from "../test/stripeBillingEnv";

const test = createApiTest();
useStripeBillingConfigured();

// Agents read a Free server's history as its people do: the last 30 days, no
// further back, and told why (cindyz, #proj-commercial task #8: "agent也不应该
// 例外" + "需要一个解释告诉他们为什么读不到").

const NOTE = "Older messages are hidden: this server is on the Free plan, which keeps the last 30 days. Upgrading to Pro restores the full history.";
/** The note as a client that can post an upgrade card reads it in #history-window, outside its cooldown. */
const NOTE_WITH_CARD = `${NOTE} If someone here needs these older messages, you can offer an upgrade card: pipe {"type":"plan:upgrade","gate":"history_30d","reason":"<one sentence: why they need the older messages>"} into raft action prepare --target "#history-window" (a heredoc, as with raft message send).`;
const BY_ID = "This message is older than the 30-day history on the Free plan. Upgrading to Pro restores the full history.";

/** What the current CLI declares in `X-Raft-Client-Capabilities`, guide-app tokens aside; MANUAL_CONTEXT_CAPABILITY alone is an older CLI's. */
const CAPABLE_CLI = `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`;

function agentHeaders(apiKey: string, capabilities: string = CAPABLE_CLI): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", [RAFT_CLIENT_CAPABILITIES_HEADER]: capabilities };
}

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `history-window-${suffix}@slock.test`,
    name: `history-window-${suffix}`,
    displayName: "History Window Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("History Window", `history-window-${suffix.slice(0, 8)}`, owner!.id);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const agent = await createAgent(server.id, "HistoryWindowBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "history-window");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const secret = await createChannel(server.id, "history-window-private", undefined, "private");
  await addHuman(secret.id, owner!.id);

  const oldOne = await createMessage(channel.id, "user", owner!.id, "the first old message", "chat");
  const oldTwo = await createMessage(channel.id, "user", owner!.id, "the second old message", "chat");
  const recentOne = await createMessage(channel.id, "user", owner!.id, "a message inside the window", "chat");
  const recentTwo = await createMessage(channel.id, "user", owner!.id, "the newest message", "chat");
  const secretOld = await createMessage(secret.id, "user", owner!.id, "an old private message", "chat");
  for (const message of [oldOne, oldTwo, secretOld]) {
    await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${message.id}::uuid`);
  }

  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "history-window",
    issuedVia: "computer",
    createdByUserId: null,
  });
  const otherChannel = await createChannel(server.id, "history-window-other");
  await addHuman(otherChannel.id, owner!.id);
  await addAgent(otherChannel.id, agent.id);
  const otherOld = await createMessage(otherChannel.id, "user", owner!.id, "an old message elsewhere", "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${otherOld.id}::uuid`);
  return { owner: owner!, server, agent, channel, apiKey: credential.apiKey, oldOne, oldTwo, recentOne, recentTwo, secretOld, otherOld };
}

type HistoryBody = {
  read_through_seq?: number | null;
  suggestedNextAction?: string;
  messages?: Array<{ message_id?: string; id?: string; content?: string }>;
  has_older?: boolean;
  historyLimited?: boolean;
  historyLimitMessage?: string;
  error?: string;
  errorCode?: string;
  code?: string;
  historyLimit?: unknown;
};

async function read(baseUrl: string, apiKey: string, params: Record<string, string>, capabilities?: string) {
  const query = new URLSearchParams({ channel: "#history-window", ...params });
  const res = await fetch(`${baseUrl}/internal/agent-api/history?${query}`, { headers: agentHeaders(apiKey, capabilities) });
  return { status: res.status, body: await res.json() as HistoryBody };
}

async function resolve(baseUrl: string, apiKey: string, messageId: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/messages/${messageId}/resolve`, { headers: agentHeaders(apiKey) });
  return { status: res.status, body: await res.json() as HistoryBody & { message?: { content?: string } } };
}

const contents = (body: HistoryBody) => (body.messages ?? []).map((message) => message.content);

test("an agent's read of a Free channel stops at the history window and says why", async ({ app }) => {
  const fx = await seedFixture();

  const latest = await read(app.baseUrl, fx.apiKey, { consume: "false" });
  assert.equal(latest.status, 200, JSON.stringify(latest.body));
  assert.deepEqual(contents(latest.body), ["a message inside the window", "the newest message"]);
  assert.equal(latest.body.has_older, false);
  assert.equal(latest.body.historyLimited, true);
  assert.equal(latest.body.historyLimitMessage, NOTE_WITH_CARD);

  // Paging back past the window brings nothing older, with the same note.
  const before = await read(app.baseUrl, fx.apiKey, { before: String(fx.recentOne.seq), consume: "false" });
  assert.deepEqual(contents(before.body), []);
  assert.equal(before.body.historyLimitMessage, NOTE_WITH_CARD);

  // Read up to date, a forward read has nothing to skip: no note.
  await read(app.baseUrl, fx.apiKey, { unread: "true" });
  const caughtUp = await read(app.baseUrl, fx.apiKey, { unread: "true" });
  assert.deepEqual(contents(caughtUp.body), []);
  assert.equal(caughtUp.body.historyLimited, undefined);

  // Pro keeps everything.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = await read(app.baseUrl, fx.apiKey, { consume: "false" });
  assert.deepEqual(contents(pro.body), ["the first old message", "the second old message", "a message inside the window", "the newest message"]);
  assert.equal(pro.body.historyLimited, undefined);
});

test("an agent asking for one message behind the window is told it is older than the history, not that it is missing", async ({ app }) => {
  const fx = await seedFixture();

  const around = await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id.slice(0, 8) });
  assert.equal(around.status, 404);
  assert.equal(around.body.errorCode, "HISTORY_LIMITED");
  assert.equal(around.body.error, BY_ID);
  // The plan and its days are in the sentence; the body is the refusal envelope.
  assert.equal(around.body.code, "HISTORY_LIMITED");
  assert.equal(around.body.historyLimit, undefined);

  const missing = await read(app.baseUrl, fx.apiKey, { around: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.errorCode, "NOT_FOUND");

  const aroundRecent = await read(app.baseUrl, fx.apiKey, { around: fx.recentOne.id });
  assert.equal(aroundRecent.status, 200);
  assert.deepEqual(contents(aroundRecent.body), ["a message inside the window", "the newest message"]);

  const resolvedOld = await resolve(app.baseUrl, fx.apiKey, fx.oldOne.id);
  assert.equal(resolvedOld.status, 404);
  assert.equal(resolvedOld.body.errorCode, "HISTORY_LIMITED");
  assert.equal(resolvedOld.body.message, undefined, "no content behind the window");

  const resolvedRecent = await resolve(app.baseUrl, fx.apiKey, fx.recentTwo.id);
  assert.equal(resolvedRecent.status, 200);

  // A message the agent may not read is not said to be behind the window.
  const resolvedSecret = await resolve(app.baseUrl, fx.apiKey, fx.secretOld.id);
  assert.equal(resolvedSecret.status, 404);
  assert.notEqual(resolvedSecret.body.errorCode, "HISTORY_LIMITED");

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await resolve(app.baseUrl, fx.apiKey, fx.oldOne.id)).status, 200);
});

test("forward reads that start behind the window skip what it hides, say so, and move the read position over it", async ({ app }) => {
  const fx = await seedFixture();

  // `--after` an old message, by id or by seq: a position, paged forward inside the window.
  for (const after of [fx.oldOne.id, String(fx.oldOne.seq)]) {
    const page = await read(app.baseUrl, fx.apiKey, { after, consume: "false" });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(contents(page.body), ["a message inside the window", "the newest message"]);
    assert.equal(page.body.historyLimitMessage, NOTE_WITH_CARD);
  }
  // From the newest hidden message on, nothing is skipped: no note.
  const fromWindow = await read(app.baseUrl, fx.apiKey, { after: String(fx.oldTwo.seq), consume: "false" });
  assert.equal(fromWindow.body.historyLimited, undefined);

  // `--unread` from a read position behind the window.
  const unread = await read(app.baseUrl, fx.apiKey, { unread: "true" });
  assert.deepEqual(contents(unread.body), ["a message inside the window", "the newest message"]);
  assert.equal(unread.body.historyLimitMessage, NOTE_WITH_CARD);
});

test("an unread read with only hidden messages after the read position says why and marks them read", async ({ app }) => {
  const fx = await seedFixture();
  const db = getDb();
  // Everything in the channel is behind the window.
  for (const message of [fx.recentOne, fx.recentTwo]) {
    await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${message.id}::uuid`);
  }

  const first = await read(app.baseUrl, fx.apiKey, { unread: "true" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(contents(first.body), []);
  assert.equal(first.body.historyLimitMessage, NOTE_WITH_CARD);
  assert.equal(first.body.read_through_seq, fx.recentTwo.seq, "the read position moves over what can never be read");

  const again = await read(app.baseUrl, fx.apiKey, { unread: "true" });
  assert.deepEqual(contents(again.body), []);
  assert.equal(again.body.historyLimited, undefined, "nothing left to skip");
});

test("--around behind the window by seq or by a short id only hidden messages match; a short id from another channel stays not found", async ({ app }) => {
  const fx = await seedFixture();

  const bySeq = await read(app.baseUrl, fx.apiKey, { around: String(fx.oldOne.seq) });
  assert.equal(bySeq.status, 404);
  assert.equal(bySeq.body.errorCode, "HISTORY_LIMITED");

  const elsewhere = await read(app.baseUrl, fx.apiKey, { around: fx.otherOld.id.slice(0, 8) });
  assert.equal(elsewhere.status, 404);
  assert.equal(elsewhere.body.errorCode, "NOT_FOUND", "an old message in another channel is not this channel's history");
});

// An 8-digit `around` that matches no visible short id reads as a seq (seqs
// passed 10M). A hidden message whose short id is all digits must still be
// reported as older than the history, not taken for a seq.
test("--around with an all-digit short id of a hidden message is history-limited, not read as a seq", async ({ app }) => {
  const fx = await seedFixture();
  const id = "87654321-0000-4000-8000-000000000000";
  await getDb().insert(messages).values({ id, channelId: fx.channel.id, senderType: "user", senderId: fx.owner.id, content: "an old message with an all-digit short id" });
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${id}::uuid`);

  const around = await read(app.baseUrl, fx.apiKey, { around: "87654321" });
  assert.equal(around.status, 404);
  assert.equal(around.body.errorCode, "HISTORY_LIMITED");
});

test("where the server allows upgrade cards, the note and the by-id answer offer one", async ({ app }) => {
  const fx = await seedFixture();

  const latest = await read(app.baseUrl, fx.apiKey, { consume: "false" });
  assert.ok(latest.body.historyLimitMessage?.startsWith(`${NOTE} If someone here needs these older messages, you can offer an upgrade card:`), latest.body.historyLimitMessage);
  assert.match(latest.body.historyLimitMessage ?? "", /raft action prepare --target "#history-window"/);

  const around = await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id });
  assert.equal(around.body.errorCode, "HISTORY_LIMITED");
  assert.match(around.body.suggestedNextAction ?? "", /"gate":"history_30d"/);
});

test("in a conversation in its upgrade-card cooldown, the note and the by-id answer offer no card", async ({ app }) => {
  const fx = await seedFixture();
  // An upgrade card the agent offered there earlier, for an upload.
  await prepareActionCard({
    serverId: fx.server.id,
    requesterAgentId: fx.agent.id,
    targetChannelId: fx.channel.id,
    action: { type: "plan:upgrade", gate: "upload_monthly_quota", reason: "The weekly report didn't fit this month's upload allowance." },
  });

  // (g) Prepare would refuse another card there: the note alone, and no next action by id.
  const latest = await read(app.baseUrl, fx.apiKey, { consume: "false" });
  assert.equal(latest.body.historyLimitMessage, NOTE);
  const around = await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id });
  assert.equal(around.body.errorCode, "HISTORY_LIMITED");
  assert.equal(around.body.suggestedNextAction, undefined);
});

test("the history note offers the upgrade card only to a client that can post it; any other gets the note alone", async ({ app }) => {
  const fx = await seedFixture();
  const undeclared = MANUAL_CONTEXT_CAPABILITY;
  const offered = (body: HistoryBody) => body.historyLimitMessage?.startsWith(`${NOTE} If someone here needs these older messages, you can offer an upgrade card:`) ?? false;

  // No declaration and no known Computer: the note alone, and the by-id answer has no next action.
  const unknown = await read(app.baseUrl, fx.apiKey, { consume: "false" }, undeclared);
  assert.equal(unknown.body.historyLimitMessage, NOTE);
  const unknownAround = await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id }, undeclared);
  assert.equal(unknownAround.body.errorCode, "HISTORY_LIMITED");
  assert.equal(unknownAround.body.suggestedNextAction, undefined);

  // Computer 1.0.52, whose CLI refuses plan:upgrade: no hint either.
  const { machine } = await registerMachine(fx.server.id, fx.owner.id, "history-window-computer");
  await placeAgentOnMachine(fx.agent.id, machine.id);
  await recordMachineComputerVersion(machine.id, "1.0.52");
  assert.equal((await read(app.baseUrl, fx.apiKey, { consume: "false" }, undeclared)).body.historyLimitMessage, NOTE);
  assert.equal((await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id }, undeclared)).body.suggestedNextAction, undefined);

  // Computer 1.0.53 posts it without declaring anything: the hint.
  await recordMachineComputerVersion(machine.id, "1.0.53");
  const onCapableComputer = await read(app.baseUrl, fx.apiKey, { consume: "false" }, undeclared);
  assert.ok(offered(onCapableComputer.body), onCapableComputer.body.historyLimitMessage);
  assert.match((await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id }, undeclared)).body.suggestedNextAction ?? "", /"gate":"history_30d"/);
  await recordMachineComputerVersion(machine.id, "1.0.54-rc.1");
  assert.ok(offered((await read(app.baseUrl, fx.apiKey, { consume: "false" }, undeclared)).body), "1.0.54-rc.1");
});

test("in a Joint Channel each agent reads inside its own server's window", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `history-joint-${suffix}@slock.test`,
    name: `history-joint-${suffix}`,
    displayName: "Joint Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const freeServer = await createServer("Joint Free", `joint-free-${suffix}`, owner!.id);
  const proServer = await createServer("Joint Pro", `joint-pro-${suffix}`, owner!.id);
  const joint = await seedJointChannel({ name: `history-joint-${suffix}`, serverIds: [freeServer.id, proServer.id], createdByUserId: owner!.id });
  const keys: string[] = [];
  for (const [index, server] of [freeServer, proServer].entries()) {
    const agent = await createAgent(server.id, `JointReader${index}${suffix}`, { runtime: "claude", model: "sonnet" });
    await addHuman(joint.projections[index]!.id, owner!.id);
    await addAgent(joint.projections[index]!.id, agent.id);
    keys.push((await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: `joint-${index}`, issuedVia: "computer", createdByUserId: null })).apiKey);
  }
  // Plans after the agents exist (Pro counts agent seats).
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, freeServer.id));
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));
  const old = await createMessage(joint.canonical.id, "user", owner!.id, "an old joint message", "chat");
  await createMessage(joint.canonical.id, "user", owner!.id, "a recent joint message", "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);

  const readJoint = async (apiKey: string) => {
    const query = new URLSearchParams({ channel: `#history-joint-${suffix}`, consume: "false" });
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?${query}`, { headers: agentHeaders(apiKey) });
    return { status: res.status, body: await res.json() as HistoryBody };
  };
  const free = await readJoint(keys[0]!);
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.deepEqual(contents(free.body), ["a recent joint message"]);
  assert.equal(free.body.historyLimitMessage, NOTE, "no upgrade-card offer in a shared channel either way");
  const pro = await readJoint(keys[1]!);
  assert.deepEqual(contents(pro.body), ["an old joint message", "a recent joint message"]);
  assert.equal(pro.body.historyLimited, undefined);
});

// C+ step 2 (task #proj-commercial:#24): the owner is told how often agents
// reached behind the window; only explicit reaches count, once per agent,
// conversation and day.
test("a Free server counts its agents' explicit reaches behind the window, not a default page that touches it", async ({ app }) => {
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
  const count = () => countAgentHistoryBlocks7d(fx.server.id);
  try {
    const latest = await read(app.baseUrl, fx.apiKey, { consume: "false" });
    assert.equal(latest.body.historyLimited, true);
    assert.equal(await count(), 0, "a default page that touches the window is not a reach");

    // Each reach on its own (the set cleared between), so dedup can't hide a missing one.
    const around = await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id.slice(0, 8) });
    assert.equal(around.status, 404);
    assert.equal(await count(), 1, "an --around message id behind the window");
    sets.clear();
    const aroundSeq = await read(app.baseUrl, fx.apiKey, { around: String(fx.oldTwo.seq) });
    assert.equal(aroundSeq.status, 404);
    assert.equal(await count(), 1, "an --around seq behind the window");
    sets.clear();
    const elsewhere = await resolve(app.baseUrl, fx.apiKey, fx.otherOld.id);
    assert.equal(elsewhere.status, 404);
    assert.equal(await count(), 1, "a message lookup behind the window");
    sets.clear();

    await read(app.baseUrl, fx.apiKey, { before: String(fx.recentOne.seq), consume: "false" });
    await read(app.baseUrl, fx.apiKey, { before: String(fx.recentOne.seq), consume: "false" });
    assert.equal(await count(), 1, "paging back into the window: once a day for this agent and conversation");
    await read(app.baseUrl, fx.apiKey, { around: fx.oldTwo.id.slice(0, 8) });
    assert.equal(await count(), 1, "another reach in the same conversation the same day");
    await resolve(app.baseUrl, fx.apiKey, fx.otherOld.id);
    assert.equal(await count(), 2, "a reach in another conversation");

    // A message the agent may not see is refused for access, never counted.
    sets.clear();
    const secret = await resolve(app.baseUrl, fx.apiKey, fx.secretOld.id);
    assert.notEqual(secret.status, 200);
    assert.equal(await count(), 0, "no access: not a reach");
  } finally {
    __setAgentHistoryBlockStoreForTests(null);
  }
});
