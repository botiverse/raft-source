import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { createTestApp } from "../test/integration/app";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { attestedSendEvents, inboxNotificationFacts, messages, tasks, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getAgentLegacyReadCursor, getOrCreateThreadForChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import * as attestedSendService from "../services/attestedSendService";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";

// A task write runs the send's freshness check against the conversation its
// result lands in (shared agentWriteLanding.ts): the task's own conversation
// for a claim, release, assignment, status update or amend; the source
// message's thread for a create from a message. It runs only when the request
// attests what its model has seen of that landing (`seenFor`). A create, claim
// or assignment holds with the send's envelope (at most once per catch-up);
// a release, status update or amend is applied with the unseen messages
// attached. In a task conversation only chat messages count.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Fixture = {
  serverId: string;
  channelId: string;
  channelName: string;
  agentId: string;
  ownerId: string;
  ownerToken: string;
  agentApiKey: string;
};

type Result = { status: number; body: any };

const originalAttestedSendMode = process.env.SLOCK_ATTESTED_SEND_MODE;

beforeEach(() => {
  process.env.SLOCK_ATTESTED_SEND_MODE = "on";
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
  const email = `task-write-freshness-${suffix}@slock.test`;
  const [owner] = await db.insert(users).values({
    email,
    name: `task-write-freshness-${suffix}`,
    displayName: "Task Freshness Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Task Write Freshness", `task-write-freshness-${suffix}`, owner.id);
  await enableTaskV2ConversationsForServer(server.id);
  const agent = await createAgent(server.id, "BoardBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "board");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks"],
    name: "task-write-freshness",
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
  };
}

function agentHeaders(f: Fixture) {
  return { Authorization: `Bearer ${f.agentApiKey}`, "Content-Type": "application/json" };
}

async function postJson(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Result> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

/** A person's message in `channelId` (the board, a task conversation, a thread). */
async function humanPost(baseUrl: string, f: Fixture, channelId: string, content: string): Promise<{ id: string; seq: number }> {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.serverId },
    body: JSON.stringify({ channelId, content }),
  });
  assert.equal(res.status, 200, `human send must succeed (${content})`);
  return await res.json() as { id: string; seq: number };
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

type HumanTask = { id: string; taskNumber: number; conversationId: string };

/**
 * A human-created task whose conversation the person opened, so the agent's
 * own writes are not what is new there.
 */
async function humanTask(baseUrl: string, f: Fixture, title: string): Promise<HumanTask> {
  const headers = { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.serverId };
  const res = await fetch(`${baseUrl}/api/tasks/channel/${f.channelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tasks: [{ title }] }),
  });
  assert.equal(res.status, 200, `human task create failed: ${await res.text()}`);
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.title, title)));
  assert.ok(row, `task ${title} must exist`);
  const opened = await fetch(`${baseUrl}/api/tasks/${row.id}/conversation`, { method: "POST", headers });
  assert.equal(opened.status, 200, await opened.clone().text());
  const { conversationChannelId } = await opened.json() as { conversationChannelId: string };
  return { id: row.id, taskNumber: row.taskNumber, conversationId: conversationChannelId };
}

/** What the agent's model has seen of the task's conversation, as a current Computer attests it. */
function seenAt(seq: number, extra: Record<string, unknown> = {}) {
  return { seenFor: "task_conversation", seenUpToSeq: seq, ...extra };
}

function claim(baseUrl: string, f: Fixture, taskNumber: number, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks/claim`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    task_numbers: [taskNumber],
    ...seen,
  });
}

function updateStatus(baseUrl: string, f: Fixture, taskNumber: number, status: string, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks/update-status`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    task_number: taskNumber,
    status,
    ...seen,
  });
}

function amend(baseUrl: string, f: Fixture, taskNumber: number, title: string, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks/amend`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    task_number: taskNumber,
    title,
    ...seen,
  });
}

function unclaim(baseUrl: string, f: Fixture, taskNumber: number, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks/unclaim`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    task_number: taskNumber,
    ...seen,
  });
}

function assign(baseUrl: string, f: Fixture, taskNumber: number, assignee: string, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks/assign`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    task_number: taskNumber,
    assignee,
    ...seen,
  });
}

function createFrom(baseUrl: string, f: Fixture, sourceMessageId: string, title: string, seen: Record<string, unknown> = {}) {
  return postJson(`${baseUrl}/internal/agent-api/tasks`, agentHeaders(f), {
    channel: `#${f.channelName}`,
    tasks: [{ title, source_message_id: sourceMessageId }],
    ...seen,
  });
}

async function claimedBy(f: Fixture, taskNumber: number): Promise<string | null> {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.taskNumber, taskNumber)));
  return row?.claimedById ?? null;
}

function assertHeld(result: Result) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, "held", JSON.stringify(result.body));
}

function assertApplied(result: Result) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.state, "held", JSON.stringify(result.body));
}

test("a task write without an attestation is never held, even with unread messages", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "no attestation");
  await humanPost(app.baseUrl, f, task.conversationId, "something the agent has not seen");

  assertApplied(await claim(app.baseUrl, f, task.taskNumber));
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId);
  assertApplied(await updateStatus(app.baseUrl, f, task.taskNumber, "in_review"));
  assertApplied(await amend(app.baseUrl, f, task.taskNumber, "no attestation, renamed"));
});

test("a boundary attested for the board (an older Computer: no seenFor) is not checked", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "old computer");
  await humanPost(app.baseUrl, f, task.conversationId, "unseen in the conversation");

  assertApplied(await claim(app.baseUrl, f, task.taskNumber, { seenUpToSeq: 0 }));
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId);
});

test("claim: unseen messages in the task conversation hold it; rerunning after reading applies it", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "stale claim");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen by the agent");
  const unseen = await humanPost(app.baseUrl, f, task.conversationId, "posted after the agent read");

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assertHeld(held);
  assert.equal(held.body.decision, "syncing_hold");
  assert.deepEqual(held.body.available_actions, ["check_messages", "retry_action"]);
  assert.ok(held.body.heldMessages.some((m: { id: string }) => m.id === unseen.id), JSON.stringify(held.body));
  assert.equal(held.body.newMessageCount, 1);
  assert.equal(held.body.continueAnywaySuggested, undefined, "task writes have no --anyway");
  assert.equal(await claimedBy(f, task.taskNumber), null, "a held claim is not applied");

  const rerun = await claim(app.baseUrl, f, task.taskNumber, seenAt(held.body.seenUpToSeq));
  assertApplied(rerun);
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId);
  assert.equal(rerun.body.results[0].title, "stale claim", "the claim names the task its lifecycle line names");
});

test("board messages do not hold a task write: only its conversation does", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "busy board, quiet task");
  const latest = await humanPost(app.baseUrl, f, task.conversationId, "the newest in the conversation");
  await humanPost(app.baseUrl, f, f.channelId, "unrelated board chatter");
  assertApplied(await claim(app.baseUrl, f, task.taskNumber, seenAt(latest.seq)));
});

test("a task without a conversation yet is not checked: nothing there to have missed", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const res = await fetch(`${app.baseUrl}/api/tasks/channel/${f.channelId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.serverId },
    body: JSON.stringify({ tasks: [{ title: "no conversation" }] }),
  });
  assert.equal(res.status, 200);
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.title, "no conversation")));
  assert.equal(row!.conversationChannelId, null);
  assertApplied(await claim(app.baseUrl, f, row!.taskNumber, seenAt(0)));
});

test("one hold per catch-up: newer messages after a hold do not hold the rerun again", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "busy conversation");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  await humanPost(app.baseUrl, f, task.conversationId, "unseen 1");

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assertHeld(held);
  // While the agent reads the hold, the conversation keeps moving.
  await humanPost(app.baseUrl, f, task.conversationId, "arrived during the read");

  assertApplied(await claim(app.baseUrl, f, task.taskNumber, seenAt(held.body.seenUpToSeq)));
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId);
});

test("a rerun that did not catch up to its last hold is held again", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "not caught up");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  await humanPost(app.baseUrl, f, task.conversationId, "unseen");

  assertHeld(await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq)));
  // Same stale boundary: the agent did not take in what the hold showed.
  assertHeld(await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq)));
  assert.equal(await claimedBy(f, task.taskNumber), null);
});

test("a hold covers only its own write: another task's write is checked against its own conversation", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const first = await humanTask(app.baseUrl, f, "first");
  const second = await humanTask(app.baseUrl, f, "second");
  const seen = await humanPost(app.baseUrl, f, first.conversationId, "seen");
  await humanPost(app.baseUrl, f, first.conversationId, "unseen");

  const held = await claim(app.baseUrl, f, first.taskNumber, seenAt(seen.seq));
  assertHeld(held);
  assertApplied(await claim(app.baseUrl, f, first.taskNumber, seenAt(held.body.seenUpToSeq)));

  await humanPost(app.baseUrl, f, second.conversationId, "news on the second task");
  assertHeld(await claim(app.baseUrl, f, second.taskNumber, seenAt(0)));
  assert.equal(await claimedBy(f, second.taskNumber), null);
});

test("the last hold is found from another server instance (a rerun on another replica)", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "two replicas");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  await humanPost(app.baseUrl, f, task.conversationId, "unseen");

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assertHeld(held);
  await humanPost(app.baseUrl, f, task.conversationId, "arrived during the read");

  const replica = await createTestApp(0);
  try {
    assertApplied(await claim(replica.baseUrl, f, task.taskNumber, seenAt(held.body.seenUpToSeq)));
  } finally {
    await replica.close();
  }
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId);
});

test("the agent's own claim lines do not hold its next status update", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "own lines");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "go ahead");

  assertApplied(await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq)));
  // The claim posts "took" / "moved to In Progress" in the conversation.
  await waitFor("claim lines", async () => {
    const lines = await getDb().select({ id: messages.id }).from(messages).where(and(
      eq(messages.systemSubtype, "task.lifecycle_thread"),
      eq(messages.causalActorId, f.agentId),
    ));
    return lines.length > 0 ? lines : null;
  });
  const updated = await updateStatus(app.baseUrl, f, task.taskNumber, "in_review", seenAt(seen.seq));
  assertApplied(updated);
  assert.equal(updated.body.title, "own lines");
  assert.equal(updated.body.unseen, undefined, "its own lines are not unseen to it");
});

test("update-status and amend are applied, with the conversation's unseen messages attached", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "update and amend");
  assertApplied(await claim(app.baseUrl, f, task.taskNumber));
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  const unseen = await humanPost(app.baseUrl, f, task.conversationId, "one more thing before review");

  const updated = await updateStatus(app.baseUrl, f, task.taskNumber, "done", seenAt(seen.seq));
  assertApplied(updated);
  const [{ status }] = await getDb().select({ status: tasks.status }).from(tasks)
    .where(and(eq(tasks.channelId, f.channelId), eq(tasks.taskNumber, task.taskNumber)));
  assert.equal(status, "done", "an attached write is applied");
  assert.equal(updated.body.unseen.target, `#${f.channelName}:#${task.taskNumber}`);
  assert.equal(updated.body.unseen.newMessageCount, 1);
  assert.ok(updated.body.unseen.messages.some((m: { id: string }) => m.id === unseen.id), JSON.stringify(updated.body));
  const holds = await getDb().select().from(attestedSendEvents)
    .where(and(eq(attestedSendEvents.agentId, f.agentId), eq(attestedSendEvents.eventType, "gate_triggered")));
  assert.equal(holds.length, 0, "nothing was held");

  // What it attached is now seen: the same boundary attaches nothing more.
  const amended = await amend(app.baseUrl, f, task.taskNumber, "renamed", seenAt(updated.body.unseen.seenUpToSeq));
  assertApplied(amended);
  assert.equal(amended.body.unseen, undefined);
  await humanPost(app.baseUrl, f, task.conversationId, "newer still");
  const amendedAgain = await amend(app.baseUrl, f, task.taskNumber, "renamed again", seenAt(updated.body.unseen.seenUpToSeq));
  assertApplied(amendedAgain);
  assert.equal(amendedAgain.body.unseen.newMessageCount, 1);
});

test("release attaches; assignment to someone else holds", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "release and assign");
  assertApplied(await claim(app.baseUrl, f, task.taskNumber));
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  await humanPost(app.baseUrl, f, task.conversationId, "actually, hold on");

  const [owner] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, f.ownerId));
  const heldAssign = await assign(app.baseUrl, f, task.taskNumber, `@${owner!.name}`, seenAt(seen.seq));
  assertHeld(heldAssign);
  assert.equal(await claimedBy(f, task.taskNumber), f.agentId, "a held assignment is not applied");

  const released = await unclaim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assertApplied(released);
  assert.equal(released.body.unseen.newMessageCount, 1);
  assert.equal(await claimedBy(f, task.taskNumber), null, "the release is applied");
});

test("a claim counts only chat messages: a lifecycle line someone else caused does not hold it", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "system lines only");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  // A person's status change posts a lifecycle line in the conversation.
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.serverId },
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.ok(res.status < 300, await res.text());
  await waitFor("the lifecycle line", async () => {
    const [line] = await getDb().select({ id: messages.id }).from(messages).where(and(
      eq(messages.systemSubtype, "task.lifecycle_thread"),
      eq(messages.causalActorId, f.ownerId),
    ));
    return line ?? null;
  });
  const claimed = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assert.notEqual(claimed.body.state, "held", JSON.stringify(claimed.body));
});

test("create from a message: a reply in its thread holds the create; with no thread it is not held", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const quiet = await humanPost(app.baseUrl, f, f.channelId, "could someone write the retry note?");
  assertApplied(await createFrom(app.baseUrl, f, quiet.id, "retry note", { seenFor: "source_thread", seenUpToSeq: 0 }));

  const asked = await humanPost(app.baseUrl, f, f.channelId, "could someone write the timeout note?");
  const thread = await getOrCreateThreadForChannel(f.channelId, asked.id, f.ownerId, "user");
  const reply = await humanPost(app.baseUrl, f, thread.id, "never mind, Bob has it");
  const held = await createFrom(app.baseUrl, f, asked.id, "timeout note", { seenFor: "source_thread", seenUpToSeq: 0 });
  assertHeld(held);
  assert.ok(held.body.heldMessages.some((m: { id: string }) => m.id === reply.id), JSON.stringify(held.body));
  const created = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.title, "timeout note")));
  assert.equal(created.length, 0, "a held create creates nothing");

  // A boundary for another landing is not read against the thread.
  assertApplied(await createFrom(app.baseUrl, f, asked.id, "timeout note", { seenFor: "task_conversation", seenUpToSeq: 0 }));
});

// A fresh model context: the Computer attests 0 (so the write is checked) but
// that proves nothing seen. The first hold shows a first-touch slice of the
// newest messages, as a send without a boundary does, not "N unread" for the
// whole conversation with N minus 3 "skipped". Whether it holds, and the
// rerun it covers (seenUpToSeq), are unchanged.
test("a fresh context's first hold of a claim, assignment or create is a first-touch slice, not the conversation's count", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const [owner] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, f.ownerId));
  const busy = async (channelId: string) => {
    for (let i = 1; i <= 6; i++) await humanPost(app.baseUrl, f, channelId, `history ${i}`);
  };
  const asked = await humanPost(app.baseUrl, f, f.channelId, "could someone write the release note?");
  const thread = await getOrCreateThreadForChannel(f.channelId, asked.id, f.ownerId, "user");
  await busy(thread.id);
  const claimTask = await humanTask(app.baseUrl, f, "fresh claim");
  await busy(claimTask.conversationId);
  const assignTask = await humanTask(app.baseUrl, f, "fresh assign");
  await busy(assignTask.conversationId);

  const writes: Array<[string, () => Promise<Result>, (seenUpToSeq: number) => Promise<Result>]> = [
    ["claim", () => claim(app.baseUrl, f, claimTask.taskNumber, seenAt(0)), (seq) => claim(app.baseUrl, f, claimTask.taskNumber, seenAt(seq))],
    ["assign", () => assign(app.baseUrl, f, assignTask.taskNumber, `@${owner!.name}`, seenAt(0)), (seq) => assign(app.baseUrl, f, assignTask.taskNumber, `@${owner!.name}`, seenAt(seq))],
    ["create", () => createFrom(app.baseUrl, f, asked.id, "release note", { seenFor: "source_thread", seenUpToSeq: 0 }), (seq) => createFrom(app.baseUrl, f, asked.id, "release note", { seenFor: "source_thread", seenUpToSeq: seq })],
  ];
  const conversations = { claim: claimTask.conversationId, assign: assignTask.conversationId, create: thread.id };
  for (const [name, write, rerun] of writes) {
    const held = await write();
    assertHeld(held);
    assert.equal(held.body.heldMessages.length, 3, `${name}: the bounded slice`);
    assert.equal(held.body.newMessageCount, 3, `${name}: counts the slice it shows, not the whole conversation`);
    assert.equal(held.body.omittedMessageCount, 0, `${name}: nothing "skipped": there was no boundary to skip from`);
    // The slice is only how the hold reads: the older messages it did not
    // show are still unread, so the read position stays short of the latest.
    const readTo = await getAgentLegacyReadCursor(f.agentId, conversations[name as keyof typeof conversations]);
    assert.ok(readTo < held.body.seenUpToSeq, `${name}: the unshown messages stay unread (read to ${readTo}, latest ${held.body.seenUpToSeq})`);
    assertApplied(await rerun(held.body.seenUpToSeq));
  }

  // Control: a hold that shows every message does read through.
  const quiet = await humanTask(app.baseUrl, f, "fresh, quiet");
  await humanPost(app.baseUrl, f, quiet.conversationId, "only one");
  const shownAll = await claim(app.baseUrl, f, quiet.taskNumber, seenAt(0));
  assertHeld(shownAll);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, quiet.conversationId), shownAll.body.seenUpToSeq);
});

test("reviewer isolation with a 0 attestation: the withheld count is the first-touch slice's, like a send without a boundary", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "isolated, fresh");
  for (let i = 1; i <= 6; i++) await humanPost(app.baseUrl, f, task.conversationId, `history ${i}`);

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(0, { freshnessContextMode: "withheld" }));
  assertHeld(held);
  assert.equal(held.body.freshnessContextMode, "withheld");
  assert.equal(held.body.withheldMessageCount, 3, "min(6, 3): no count of the whole conversation");
  assert.equal(held.body.heldMessages, undefined);
});

test("with a real boundary (or exact seen seqs) a hold still counts every unseen message", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "seen some");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  const unseen = [];
  for (let i = 1; i <= 5; i++) unseen.push(await humanPost(app.baseUrl, f, task.conversationId, `unseen ${i}`));

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq));
  assertHeld(held);
  assert.equal(held.body.newMessageCount, 5);
  assert.equal(held.body.omittedMessageCount, 2);

  // Boundary 0 with a message it saw exactly is proof too.
  const exact = await claim(app.baseUrl, f, task.taskNumber, seenAt(0, { seenExactSeqs: [unseen[0]!.seq] }));
  assertHeld(exact);
  assert.equal(exact.body.newMessageCount, 5, "the conversation's 6 messages minus the one it saw");
  assert.equal(exact.body.omittedMessageCount, 2);
});

// The Computer attests a create from a reply for the thread the reply is in
// (agentCredentialProxy sideEffectTarget): that is the thread checked, and the
// rerun attesting the hold's seenUpToSeq is applied.
test("create from a reply inside a thread: checked on that thread; the rerun covering the hold is applied", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const asked = await humanPost(app.baseUrl, f, f.channelId, "could someone write the backoff note?");
  const thread = await getOrCreateThreadForChannel(f.channelId, asked.id, f.ownerId, "user");
  const seen = await humanPost(app.baseUrl, f, thread.id, "yes, a task please");
  const unseen = await humanPost(app.baseUrl, f, thread.id, "and mention the jitter");

  const held = await createFrom(app.baseUrl, f, seen.id, "backoff note", { seenFor: "source_thread", seenUpToSeq: seen.seq });
  assertHeld(held);
  assert.equal(held.body.newMessageCount, 1, "only what is after the attested boundary in the reply's thread counts");
  assert.deepEqual(held.body.heldMessages.map((m: { id: string }) => m.id), [unseen.id]);

  assertApplied(await createFrom(app.baseUrl, f, seen.id, "backoff note", { seenFor: "source_thread", seenUpToSeq: held.body.seenUpToSeq }));
  const created = await getDb().select().from(tasks).where(and(eq(tasks.channelId, f.channelId), eq(tasks.title, "backoff note")));
  assert.equal(created.length, 1);
});

test("reviewer isolation: a count-only hold, and the rerun passes since it cannot catch up", async ({ app }) => {
  const f = await seedFixture(app.baseUrl);
  const task = await humanTask(app.baseUrl, f, "isolated");
  const seen = await humanPost(app.baseUrl, f, task.conversationId, "seen");
  await humanPost(app.baseUrl, f, task.conversationId, "withheld");

  const held = await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq, { freshnessContextMode: "withheld" }));
  assertHeld(held);
  assert.equal(held.body.freshnessContextMode, "withheld");
  assert.equal(held.body.withheldMessageCount, 1);
  assert.equal(held.body.heldMessages, undefined, "no context bytes in isolation");

  assertApplied(await claim(app.baseUrl, f, task.taskNumber, seenAt(seen.seq, { freshnessContextMode: "withheld" })));
});
