import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, gt, max } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, messages, tasks, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { registerMachine } from "../services/machineService";
import { broadcastSystemMessage } from "../services/messageService";
import * as attestedSendService from "../services/attestedSendService";

// Send freshness must not hold an agent's send on a system notice the server
// recorded as caused by that same agent (`messages.causal_actor_*`) when the
// notice kind is in SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES. Notices caused by
// anyone else, with no recorded causal actor, or of an unlisted kind (the
// agent's own channel.rename included) still hold.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Fixture = {
  serverId: string;
  channelId: string;
  channelName: string;
  agentId: string;
  ownerId: string;
  ownerToken: string;
  agentApiKey: string;
  machineApiKey: string;
};

type Notice = typeof messages.$inferSelect;
type SendResult = { status: number; body: any };

const originalAttestedSendMode = process.env.SLOCK_ATTESTED_SEND_MODE;

beforeEach(() => {
  process.env.SLOCK_ATTESTED_SEND_MODE = "force";
});

afterEach(() => {
  attestedSendService.__resetAttestedSendStateForTest();
  if (originalAttestedSendMode === undefined) {
    delete process.env.SLOCK_ATTESTED_SEND_MODE;
  } else {
    process.env.SLOCK_ATTESTED_SEND_MODE = originalAttestedSendMode;
  }
});

async function seedFixture(baseUrl: string): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID();
  const email = `self-caused-notice-${suffix}@slock.test`;
  const [owner] = await db.insert(users).values({
    email,
    name: `self-caused-notice-${suffix}`,
    displayName: "Self Caused Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Self Caused Notice", `self-caused-notice-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "NoticeBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "notice-room");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const { machine, apiKey: machineApiKey } = await registerMachine(server.id, owner.id, "self-caused-notice-daemon");
  await placeAgentOnMachine(agent.id, machine.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks"],
    name: "self-caused-notice",
    issuedVia: "computer",
    createdByUserId: null,
  });

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(loginRes.status, 200, "owner login must succeed");
  const { accessToken } = await loginRes.json() as { accessToken: string };

  return {
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    ownerId: owner.id,
    ownerToken: accessToken,
    agentApiKey: minted.apiKey,
    machineApiKey,
  };
}

/** A second agent in the same channel, acting through its own credential. */
async function seedPeerAgent(f: Fixture): Promise<Fixture> {
  const peer = await createAgent(f.serverId, "PeerBot", { runtime: "claude", model: "sonnet" });
  await addAgent(f.channelId, peer.id);
  const minted = await mintAgentCredential({
    agentId: peer.id,
    scopes: ["send", "read", "tasks"],
    name: "self-caused-notice-peer",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { ...f, agentId: peer.id, agentApiKey: minted.apiKey };
}

function agentHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function userHeaders(f: Fixture) {
  return { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.serverId };
}

async function postJson(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<SendResult> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

function sendViaAgentApi(baseUrl: string, f: Fixture, body: Record<string, unknown>) {
  return postJson(`${baseUrl}/internal/agent-api/send`, agentHeaders(f.agentApiKey), body);
}

function sendViaAgentApiV2(baseUrl: string, f: Fixture, body: Record<string, unknown>) {
  return postJson(`${baseUrl}/internal/agent-api/v2/send`, agentHeaders(f.agentApiKey), body);
}

function sendViaLegacyRoute(baseUrl: string, f: Fixture, body: Record<string, unknown>) {
  return postJson(`${baseUrl}/internal/agent/${f.agentId}/send`, agentHeaders(f.machineApiKey), body);
}

async function taskRow(f: Fixture, title: string) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.title, title)));
  assert.ok(row?.messageId, `task ${title} must exist with a host message`);
  const [host] = await getDb().select().from(messages).where(eq(messages.id, row.messageId));
  return { id: row.id, taskNumber: row.taskNumber, messageId: row.messageId, hostSeq: host.seq };
}

async function agentCreateTask(baseUrl: string, f: Fixture, title: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: agentHeaders(f.agentApiKey),
    body: JSON.stringify({ channel: `#${f.channelName}`, tasks: [{ title }] }),
  });
  assert.ok(res.status < 300, `agent task create failed ${res.status}: ${await res.text()}`);
  return taskRow(f, title);
}

async function humanCreateTask(baseUrl: string, f: Fixture, title: string) {
  const res = await fetch(`${baseUrl}/api/tasks/channel/${f.channelId}`, {
    method: "POST",
    headers: userHeaders(f),
    body: JSON.stringify({ tasks: [{ title }] }),
  });
  assert.equal(res.status, 200, `human task create failed: ${await res.text()}`);
  return taskRow(f, title);
}

async function agentCloseTask(baseUrl: string, f: Fixture, taskNumber: number) {
  const res = await fetch(`${baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: agentHeaders(f.agentApiKey),
    body: JSON.stringify({ channel: `#${f.channelName}`, task_number: taskNumber, status: "closed" }),
  });
  assert.equal(res.status, 200, `agent update-status failed: ${await res.text()}`);
}

async function humanCloseTask(baseUrl: string, f: Fixture, taskId: string) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: userHeaders(f),
    body: JSON.stringify({ status: "closed" }),
  });
  assert.equal(res.status, 200, `human status change failed: ${await res.text()}`);
}

async function globalMaxSeq(): Promise<number> {
  const [row] = await getDb().select({ m: max(messages.seq) }).from(messages);
  return Number(row?.m ?? 0);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Task notices are produced asynchronously after the task request returns. */
async function waitForNotice(channelId: () => Promise<string | null>, subtype: string, afterSeq: number): Promise<Notice> {
  return waitFor(`${subtype} notice`, async () => {
    const id = await channelId();
    if (!id) return null;
    const [row] = await getDb().select().from(messages).where(and(
      eq(messages.channelId, id),
      eq(messages.messageType, "system"),
      eq(messages.systemSubtype, subtype),
      gt(messages.seq, afterSeq),
    ));
    return row ?? null;
  });
}

async function threadChannelIdFor(parentMessageId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: channels.id }).from(channels).where(eq(channels.parentMessageId, parentMessageId));
  return row?.id ?? null;
}

async function agentFacts(agentId: string, messageId: string) {
  return waitFor("agent inbox fact", async () => {
    const rows = await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, agentId),
      eq(inboxNotificationFacts.messageId, messageId),
    ));
    return rows.length > 0 ? rows : null;
  }, 2_000);
}

/** Agent creates a task and its channel summary lands, so it cannot interleave later. */
async function agentTaskSettled(baseUrl: string, f: Fixture, title: string) {
  const task = await agentCreateTask(baseUrl, f, title);
  await waitForNotice(async () => f.channelId, "task.created_summary", task.hostSeq);
  return task;
}

function threadTarget(f: Fixture, hostMessageId: string) {
  return `#${f.channelName}:${hostMessageId.slice(0, 8)}`;
}

function assertSent(result: SendResult) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, "sent", JSON.stringify(result.body));
}

function assertHeldOnly(result: SendResult, notice: Notice) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, "held", JSON.stringify(result.body));
  assert.deepEqual(result.body.heldMessages.map((m: { id: string }) => m.id), [notice.id]);
}

function assertCausalActor(notice: Notice, type: "user" | "agent" | null, id: string | null) {
  assert.equal(notice.messageType, "system");
  assert.equal(notice.causalActorType, type);
  assert.equal(notice.causalActorId, id);
}

// ---- channel target, POST /internal/agent-api/send ----

test("channel: agent has seen the human-caused notice -> sent", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanCreateTask(app.baseUrl, f, "channel baseline task");
  await waitForNotice(async () => f.channelId, "task.created_summary", task.hostSeq);

  assertSent(await sendViaAgentApi(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "baseline", seenUpToSeq: await globalMaxSeq(),
  }));
});

test("channel: human-caused task.created_summary after boundary -> held", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanCreateTask(app.baseUrl, f, "channel human task");
  const notice = await waitForNotice(async () => f.channelId, "task.created_summary", task.hostSeq);

  // Boundary = the task host message, so only the notice is unseen.
  assertHeldOnly(await sendViaAgentApi(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "control", seenUpToSeq: task.hostSeq,
  }), notice);
});

test("channel: agent's own task.created_summary after boundary -> sent", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await agentCreateTask(app.baseUrl, f, "channel own task");
  const notice = await waitForNotice(async () => f.channelId, "task.created_summary", task.hostSeq);
  assertCausalActor(notice, "agent", f.agentId);
  const facts = await agentFacts(f.agentId, notice.id);
  assert.deepEqual(facts.map((fact) => fact.unreadEligible), [false]);

  assertSent(await sendViaAgentApi(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "own notice", seenUpToSeq: task.hostSeq,
  }));
});

test("channel: another agent's self-caused notice after boundary -> held", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const peer = await seedPeerAgent(f);
  const task = await agentCreateTask(app.baseUrl, peer, "channel peer task");
  const notice = await waitForNotice(async () => f.channelId, "task.created_summary", task.hostSeq);
  assertCausalActor(notice, "agent", peer.agentId);

  assertHeldOnly(await sendViaAgentApi(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "peer notice", seenUpToSeq: task.hostSeq,
  }), notice);
});

test("channel: system notice with no recorded causal actor after boundary -> held", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const boundary = await globalMaxSeq();
  // A notify-exclude producer: persisted with NULL causal_actor_*.
  const notice = await broadcastSystemMessage(
    app.app.get("io"),
    app.app.get("agentOrchestrator"),
    f.channelId,
    "Reminder: check the board.",
    { inboxFactPolicy: { mode: "record", producer: "app.agent_reminder", reason: "source-missing freshness regression" } },
  );
  assertCausalActor(notice, null, null);

  assertHeldOnly(await sendViaAgentApi(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "source missing", seenUpToSeq: boundary,
  }), notice);
});

// ---- thread target, POST /internal/agent-api/send ----

test("thread: agent has seen the human-caused lifecycle notice -> sent", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await agentTaskSettled(app.baseUrl, f, "thread baseline task");
  const boundary = await globalMaxSeq();
  await humanCloseTask(app.baseUrl, f, task.id);
  await waitForNotice(() => threadChannelIdFor(task.messageId), "task.lifecycle_thread", boundary);

  assertSent(await sendViaAgentApi(app.baseUrl, f, {
    target: threadTarget(f, task.messageId), content: "baseline", seenUpToSeq: await globalMaxSeq(),
  }));
});

test("thread: human-caused task.lifecycle_thread after boundary -> held", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await agentTaskSettled(app.baseUrl, f, "thread human close task");
  const boundary = await globalMaxSeq();
  await humanCloseTask(app.baseUrl, f, task.id);
  const notice = await waitForNotice(() => threadChannelIdFor(task.messageId), "task.lifecycle_thread", boundary);
  assertCausalActor(notice, "user", f.ownerId);

  assertHeldOnly(await sendViaAgentApi(app.baseUrl, f, {
    target: threadTarget(f, task.messageId), content: "control", seenUpToSeq: boundary,
  }), notice);
});

test("thread: agent's own task.lifecycle_thread after boundary -> sent (its response names the task)", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await agentTaskSettled(app.baseUrl, f, "thread own close task");
  const boundary = await globalMaxSeq();
  await agentCloseTask(app.baseUrl, f, task.taskNumber);
  const notice = await waitForNotice(() => threadChannelIdFor(task.messageId), "task.lifecycle_thread", boundary);
  assertCausalActor(notice, "agent", f.agentId);

  assertSent(await sendViaAgentApi(app.baseUrl, f, {
    target: threadTarget(f, task.messageId), content: "own notice", seenUpToSeq: boundary,
  }));
});

test("thread: agent's own exempt-kind notice in the thread after boundary -> sent", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await agentTaskSettled(app.baseUrl, f, "thread own exempt task");
  // Create the thread with a human close, then mark everything so far as seen.
  await humanCloseTask(app.baseUrl, f, task.id);
  const threadId = await waitFor("task thread", () => threadChannelIdFor(task.messageId));
  await waitForNotice(async () => threadId, "task.lifecycle_thread", task.hostSeq);
  const boundary = await globalMaxSeq();
  const notice = await selfCausedNotice(app, f, threadId, "agent.join_channel");

  assertSent(await sendViaAgentApi(app.baseUrl, f, {
    target: threadTarget(f, task.messageId), content: "own exempt notice", seenUpToSeq: boundary,
  }));
  assertCausalActor(notice, "agent", f.agentId);
});

// ---- notice kind allowlist, channel target ----

/** A system notice recorded as caused by the fixture agent, of the given kind. */
async function selfCausedNotice(app: any, f: Fixture, channelId: string, producer: string): Promise<Notice> {
  return broadcastSystemMessage(
    app.app.get("io"),
    app.app.get("agentOrchestrator"),
    channelId,
    `self-caused ${producer}`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: producer as any,
        reason: "self-caused notice kind allowlist regression",
        causalActor: { type: "agent", id: f.agentId },
      },
    },
  );
}

// Pinned here, not read from the production list: dropping a kind from the
// allowlist must fail its case below instead of silently removing it.
const EXPECTED_EXEMPT_KINDS = [
  "agent.join_channel",
  "channel.agent_membership",
  "channel.human_membership",
  "channel.archive",
  "channel.unarchive",
  "task.created_summary",
  "task.assignment_receipt",
  "task.converted_summary",
  "task.lifecycle_thread",
];

test("exempt kind allowlist is exactly the checked kinds", () => {
  assert.deepEqual([...attestedSendService.SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES].sort(), [...EXPECTED_EXEMPT_KINDS].sort());
});

for (const producer of EXPECTED_EXEMPT_KINDS) {
  test(`channel: agent's own ${producer} after boundary -> sent`, async ({ app }) => {
    const f = await seedFixture(app.baseUrl);
    const boundary = await globalMaxSeq();
    const notice = await selfCausedNotice(app, f, f.channelId, producer);
    assertCausalActor(notice, "agent", f.agentId);
    assert.equal(notice.systemSubtype, producer);

    assertSent(await sendViaAgentApi(app.baseUrl, f, {
      target: `#${f.channelName}`, content: `own ${producer}`, seenUpToSeq: boundary,
    }));
  });
}

for (const producer of ["channel.rename", "test.self_caused_unlisted_kind"]) {
  test(`channel: agent's own ${producer} after boundary -> held (kind not exempt)`, async ({ app }) => {
    const f = await seedFixture(app.baseUrl);
    const boundary = await globalMaxSeq();
    const notice = await selfCausedNotice(app, f, f.channelId, producer);
    assertCausalActor(notice, "agent", f.agentId);
    assert.equal(notice.systemSubtype, producer);

    assertHeldOnly(await sendViaAgentApi(app.baseUrl, f, {
      target: `#${f.channelName}`, content: `own ${producer}`, seenUpToSeq: boundary,
    }), notice);
  });
}

// ---- other entry points, channel target ----

test("v2 send: human-caused notice holds, agent's own notice does not", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const humanTask = await humanCreateTask(app.baseUrl, f, "v2 human task");
  const humanNotice = await waitForNotice(async () => f.channelId, "task.created_summary", humanTask.hostSeq);
  assertHeldOnly(await sendViaAgentApiV2(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "v2 control", seenUpToSeq: humanTask.hostSeq,
  }), humanNotice);

  const ownBoundary = await globalMaxSeq();
  const ownTask = await agentCreateTask(app.baseUrl, f, "v2 own task");
  const ownNotice = await waitForNotice(async () => f.channelId, "task.created_summary", ownTask.hostSeq);
  assertCausalActor(ownNotice, "agent", f.agentId);
  assertSent(await sendViaAgentApiV2(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "v2 own notice", seenUpToSeq: ownBoundary,
  }));
});

test("legacy /internal/agent/:id/send: human-caused notice holds, agent's own notice does not", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const humanTask = await humanCreateTask(app.baseUrl, f, "legacy human task");
  const humanNotice = await waitForNotice(async () => f.channelId, "task.created_summary", humanTask.hostSeq);
  assertHeldOnly(await sendViaLegacyRoute(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "legacy control", seenUpToSeq: humanTask.hostSeq,
  }), humanNotice);

  const ownBoundary = await globalMaxSeq();
  const ownTask = await agentCreateTask(app.baseUrl, f, "legacy own task");
  const ownNotice = await waitForNotice(async () => f.channelId, "task.created_summary", ownTask.hostSeq);
  assertCausalActor(ownNotice, "agent", f.agentId);
  assertSent(await sendViaLegacyRoute(app.baseUrl, f, {
    target: `#${f.channelName}`, content: "legacy own notice", seenUpToSeq: ownBoundary,
  }));
});
