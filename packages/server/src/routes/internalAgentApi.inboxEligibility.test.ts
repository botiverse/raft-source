import { accessTokenForTest, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// One unread rule for every transport (services/inboxUnreadEligibility.ts).
//
// When an agent adds itself to a channel, "@X was added to this channel."
// (channel.agent_membership, causal actor = the agent) is born-read for it in
// the inbox chain, yet delivery used to hand it to the agent anyway, so a
// notice / managed wake announced a message /events never returns. (The prod
// report that led here was a human-added agent racing the chain; that case is
// correctly unread and is pinned in 3 below.) Pins:
//   1. a system message the agent caused is not delivered to it (no notice, no
//      managed wake) and /events does not return it either;
//   2. the next ordinary message is announced and returned, alone;
//   3. a membership message someone else caused stays unread for the agent,
//      on every transport;
//   4. the chain SQL's noise-subtype list is the registry's skip producers.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { BasicTracer, MemoryTraceSink, type AgentMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, type AgentInboxChainSelection } from "../services/channelService";
import {
  broadcastSystemMessage,
  broadcastAndDeliver,
  __setExternalAgentInboxChainSelectorForTests,
} from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import { startAgentInboxPushWorker, type AgentInboxNotice } from "../services/agentInboxPushService";
import type { WebhookPost } from "../services/appNotificationDeliveryService";
import { INBOX_NOISE_SYSTEM_SUBTYPES, countsTowardTaskConversationUnread, isMessageUnreadEligibleForReceiver } from "../services/inboxUnreadEligibility";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

__setExternalAgentInboxChainSelectorForTests(async (agentId: string): Promise<AgentInboxChainSelection> => (
  { source: "chain", rows: await referenceAgentInboxChain(agentId) }
));
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));

const SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x";

const ioStub = {
  to: () => ({ emit: () => true }),
  in: () => ({ socketsJoin: () => undefined }),
} as any;

async function seed(runtime: "external" | "claude") {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `inbox-elig-${suffix}@slock.test`,
    name: `inbox-elig-${suffix}`,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Inbox Eligibility", `inbox-elig-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `Elig${suffix.slice(0, 6)}`, runtime === "external"
    ? { runtime: "external", model: "external" }
    : { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `elig-room-${suffix.slice(0, 6)}`);
  await addHuman(channel.id, owner!.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "elig-test", issuedVia: "computer", createdByUserId: null });
  return { ownerId: owner!.id, serverId: server.id, channelId: channel.id, agentId: agent.id, agentName: agent.name, apiKey: minted.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function api(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

/** A fresh orchestrator whose deliveries are recorded (external signal + every deliverMessage). */
function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator() as AgentOrchestrator;
  app.app.set("agentOrchestrator", orchestrator);
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const original = orchestrator.deliverMessage.bind(orchestrator);
  orchestrator.deliverMessage = async (agentId, message, options) => {
    delivered.push({ agentId, message });
    return original(agentId, message, options);
  };
  return { orchestrator, delivered };
}

/** The agent joins, and the membership system message it caused is broadcast. */
async function agentAddsItself(orchestrator: AgentOrchestrator, f: Fixture) {
  await addAgent(f.channelId, f.agentId);
  return broadcastSystemMessage(ioStub, orchestrator, f.channelId, `@${f.agentName} was added to this channel.`, {
    inboxFactPolicy: {
      mode: "record",
      producer: "channel.agent_membership",
      reason: "agent membership changes are shared channel activity",
      causalActor: { type: "agent", id: f.agentId },
    },
  });
}

async function humanSays(orchestrator: AgentOrchestrator, f: Fixture, content: string) {
  await broadcastAndDeliver(ioStub, orchestrator, {
    channelId: f.channelId, senderType: "user", senderId: f.ownerId, senderName: "Owner", content,
  });
  const [message] = await getDb().select().from(messages)
    .where(eq(messages.channelId, f.channelId)).orderBy(desc(messages.seq)).limit(1);
  assert.equal(message!.content, content);
  return message!;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "condition not reached in time");
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

test("external agent: its own membership message is neither announced nor pulled; the next message is both", async ({ app }) => {
  const f = await seed("external");
  assert.equal((await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: "https://receiver.example.com/hook", secret: SECRET })).status, 200);
  const { orchestrator, delivered } = freshProcess(app);
  const notices: AgentInboxNotice[] = [];
  const post: WebhookPost = async (input) => {
    notices.push(JSON.parse(input.body));
    return { status: 200 };
  };
  const worker = startAgentInboxPushWorker({
    agentOrchestrator: orchestrator,
    post,
    sweepIntervalMs: 60 * 60_000,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
  });
  try {
    const joined = await agentAddsItself(orchestrator, f);
    await settle();
    await worker.idle();
    assert.equal(delivered.filter((d) => d.message.message_id === joined.id).length, 0, "not delivered to its causal actor");
    assert.deepEqual(notices, [], "no notice for a born-read message");
    const pulledAfterJoin = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
    assert.deepEqual(pulledAfterJoin.body.events, [], "the pull agrees: nothing unread");

    const hello = await humanSays(orchestrator, f, "welcome aboard");
    await waitFor(() => notices.length === 1);
    await worker.idle();
    const [target] = (notices as AgentInboxNotice[])[0]!.targets;
    assert.equal(target!.pendingCount, 1);
    assert.equal(target!.firstPendingMsgId, hello.id);
    const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
    assert.deepEqual(pulled.body.events.map((e: any) => e.message_id), [hello.id], "the born-read row between is not returned");
  } finally {
    worker.stop();
  }
});

test("managed agent: its own membership message is not delivered (no wake, no Inbox update); the next message is", async ({ app }) => {
  const f = await seed("claude");
  const { orchestrator, delivered } = freshProcess(app);
  const joined = await agentAddsItself(orchestrator, f);
  await settle();
  assert.deepEqual(delivered.filter((d) => d.agentId === f.agentId && d.message.message_id === joined.id), []);
  const hello = await humanSays(orchestrator, f, "welcome aboard");
  await waitFor(() => delivered.some((d) => d.agentId === f.agentId && d.message.message_id === hello.id));
});

test("a membership message someone else caused stays unread for the added agent on every transport", async ({ app }) => {
  const f = await seed("external");
  const { orchestrator, delivered } = freshProcess(app);
  await addAgent(f.channelId, f.agentId);
  const added = await broadcastSystemMessage(ioStub, orchestrator, f.channelId, `@${f.agentName} was added to this channel.`, {
    inboxFactPolicy: {
      mode: "record",
      producer: "channel.agent_membership",
      reason: "agent membership changes are shared channel activity",
      causalActor: { type: "user", id: f.ownerId },
    },
  });
  await waitFor(() => delivered.some((d) => d.agentId === f.agentId && d.message.message_id === added.id));
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  assert.deepEqual(pulled.body.events.map((e: any) => e.message_id), [added.id]);
});

for (const route of ["/members", "/members/batch"] as const) {
  test(`human adds an external agent via web POST ${route}: notice and /events agree on the membership message`, async ({ app }) => {
    const f = await seed("external");
    assert.equal((await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: "https://receiver.example.com/hook", secret: SECRET })).status, 200);
    const { orchestrator, delivered } = freshProcess(app);
    const notices: AgentInboxNotice[] = [];
    const worker = startAgentInboxPushWorker({
      agentOrchestrator: orchestrator,
      post: async (input) => { notices.push(JSON.parse(input.body)); return { status: 200 }; },
      sweepIntervalMs: 60 * 60_000,
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    });
    try {
      const res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessTokenForTest(f.ownerId)}`, "X-Server-Id": f.serverId },
        body: JSON.stringify(route === "/members" ? { agentId: f.agentId } : { agentIds: [f.agentId] }),
      });
      assert.equal(res.status, 200, await res.text());
      const [added] = await getDb().select().from(messages)
        .where(and(eq(messages.channelId, f.channelId), eq(messages.messageType, "system"))).orderBy(desc(messages.seq)).limit(1);
      assert.equal(added!.content, `@${f.agentName} was added to this channel.`);
      assert.equal(added!.causalActorType, "user");
      assert.equal(added!.causalActorId, f.ownerId);
      await settle();
      await worker.idle();
      const deliveredIt = delivered.some((d) => d.agentId === f.agentId && d.message.message_id === added!.id);
      const noticed = notices.some((n) => n.targets.some((t) => t.firstPendingMsgId === added!.id));
      const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
      const pulledIds = pulled.body.events.map((e: any) => e.message_id);
      // One rule: delivered and announced iff the pull returns it.
      assert.equal(noticed, deliveredIt);
      assert.deepEqual(pulledIds, deliveredIt ? [added!.id] : []);
      assert.equal(deliveredIt, true, "someone else caused it: unread for the added agent");
    } finally {
      worker.stop();
    }
  });
}

test("the rule: born-read for the causal actor only, noise for everyone, a personal mention pierces both", () => {
  const joined = { senderType: "user", senderId: "system", messageType: "system" as const, causalActorType: "agent", causalActorId: "a1", systemSubtype: "channel.agent_membership" };
  assert.equal(isMessageUnreadEligibleForReceiver(joined, { type: "agent", id: "a1" }), false);
  assert.equal(isMessageUnreadEligibleForReceiver(joined, { type: "agent", id: "a2" }), true);
  assert.equal(isMessageUnreadEligibleForReceiver(joined, { type: "agent", id: "a1" }, { personallyMentioned: true }), true);
  assert.equal(isMessageUnreadEligibleForReceiver({ ...joined, causalActorType: null, causalActorId: null }, { type: "agent", id: "a1" }), true, "NULL causal actor: no exclusion");
  assert.equal(isMessageUnreadEligibleForReceiver({ ...joined, systemSubtype: "task.deleted_summary" }, { type: "agent", id: "a2" }), false);
  assert.equal(isMessageUnreadEligibleForReceiver({ senderType: "agent", senderId: "a1" }, { type: "agent", id: "a1" }, { personallyMentioned: true }), false, "own message never");
});

// Reads private infra SQL that the source-available snapshot does not carry;
// skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));
const chainSql = (file: string) => readFileSync(new URL(`../../../../infra/risingwave/sql/${file}`, import.meta.url), "utf8");

test.skipIf(inSourceSnapshot)("the chain SQL's noise subtypes are exactly the registry's skip producers", () => {
  // 063 (the v4 arms) and 075 (the cursor-decoupled arms the server's views
  // read; 078 builds on them): every literal list in each.
  for (const file of ["063-unified-inbox-chain.sql", "075-inbox-cursor-decouple.sql"]) {
    const lists = [...chainSql(file).matchAll(/system_subtype NOT IN \(([^)]*)\)/g)].map((match) => (
      match[1]!.split(",").map((item) => item.trim().replace(/^'|'$/g, "")).sort()
    ));
    assert.ok(lists.length > 0, file);
    for (const list of lists) assert.deepEqual(list, [...INBOX_NOISE_SYSTEM_SUBTYPES], file);
  }
});

test("a task conversation's unread is on the reply basis; the transport rule is unchanged", () => {
  // Lifecycle lines ("moved to In Review", the assignment receipt) are system
  // messages: not replies, so not "new" on the task's row either.
  const lifecycle = { senderType: "user", senderId: "u1", messageType: "system" as const, causalActorType: "user", causalActorId: "u1", systemSubtype: "task.lifecycle_thread" };
  assert.equal(countsTowardTaskConversationUnread(lifecycle), false);
  assert.equal(countsTowardTaskConversationUnread({ messageType: "chat" }), true);
  assert.equal(countsTowardTaskConversationUnread({ messageType: null }), true, "column default is chat");
  // Agent delivery and the inbox facts keep the transport rule: an agent is
  // still woken by a status change it did not cause, and the assignee's
  // personal mention on the assignment notice still pierces.
  assert.equal(isMessageUnreadEligibleForReceiver(lifecycle, { type: "agent", id: "a1" }), true);
  const receipt = { ...lifecycle, systemSubtype: "task.assignment_receipt" };
  assert.equal(isMessageUnreadEligibleForReceiver(receipt, { type: "agent", id: "a1" }, { personallyMentioned: true }), true);
});

test.skipIf(inSourceSnapshot)("078's task conversation unread counts chat messages only, in serving and conversation unread", () => {
  const sql = chainSql("078-task-conversations.sql");
  const view = sql.match(/CREATE MATERIALIZED VIEW rw_task_conversation_unread_v1 AS([\s\S]*?);/)?.[1] ?? "";
  assert.match(view, /COUNT\(u\.seq\) FILTER \(WHERE u\.message_type = 'chat'/);
  assert.match(view, /c\.type = 'task'/);
  assert.match(sql, /CASE WHEN c\.type = 'task' THEN tu\.unread_count ELSE p\.unread_count END/, "serving v9");
  assert.match(sql, /CASE WHEN c\.type = 'task' THEN COALESCE\(tu\.unread_count, 0\) ELSE u\.unread_count END/, "conversation unread v4");
  // The mention arm is untouched: the assignment notice still reaches the assignee.
  assert.doesNotMatch(sql.match(/CREATE MATERIALIZED VIEW rw_inbox_mention_v7 AS([\s\S]*?);/)?.[1] ?? "", /message_type/);
});
