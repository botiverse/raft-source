import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 with daemons and CLIs from BEFORE task v2 (origin/staging today),
 * flag ON. Those clients never invent a task target: they copy the target the
 * agent sees, which the old daemon builds from the delivery's fields —
 * `#${parent_channel_name}:${channel_name}` for a thread (`thread-` prefix
 * stripped; daemon/inbox take the first 8 characters). A task conversation is
 * delivered as a thread whose `channel_name` is the task ref's tail (`#7`),
 * so they show `#proj:#7`; `message send` / `message read` at that target
 * reach the task conversation (created on the first write for an older task).
 * Task outputs carry `messageId` = `#7`, so the old `msg=` field and the old
 * "follow up at `<board>:<messageId[0..8]>`" hint name the ref too.
 *
 * Always on: the staging rendering formulas (frozen copies below, verbatim
 * from origin/staging d642d06e5) applied to the real payloads, and the old
 * HTTP calls. Opt-in end to end: with `RAFT_LEGACY_SLOCK_ROOT` pointing at a
 * staging checkout with dependencies installed and `packages/cli` built
 * (`git worktree add /tmp/slock-old origin/staging && cd /tmp/slock-old &&
 * pnpm install && pnpm --filter @botiverse/raft build`), the staging daemon's
 * real formatter renders the deliveries and the staging CLI binary reads,
 * replies, creates, claims, updates, assigns and lists against this server.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { inboxNotificationFacts, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const execFileAsync = promisify(execFile);
const LEGACY_ROOT = process.env.RAFT_LEGACY_SLOCK_ROOT ?? "";

// ── origin/staging rendering, verbatim (d642d06e5) ──────────────────────────

/** staging packages/daemon/src/agentVisibleDeliveryLedger.ts computeTarget (+ getMessageShortId). */
function stagingDaemonTarget(m: { channel_type?: string; channel_name?: string; parent_channel_name?: string; parent_channel_type?: string }): string {
  const getMessageShortId = (messageId: string) => (messageId.startsWith("thread-") ? messageId.slice(7) : messageId.slice(0, 8));
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = getMessageShortId(String(m.channel_name ?? ""));
    if (m.parent_channel_type === "dm") return `dm:@${m.parent_channel_name}:${shortId}`;
    return `#${m.parent_channel_name}:${shortId}`;
  }
  if (m.channel_type === "dm") return `dm:@${m.channel_name}`;
  return `#${m.channel_name}`;
}

/** staging packages/shared/src/agentMessageText.ts formatAgentMessageTarget (CLI `message check`, SDK). */
function stagingSharedTarget(m: { channel_type?: string; channel_name?: string; parent_channel_name?: string; parent_channel_type?: string }): string {
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = m.channel_name?.startsWith("thread-") ? m.channel_name.slice(7) : m.channel_name;
    if (m.parent_channel_type === "dm") return `dm:@${m.parent_channel_name}:${shortId}`;
    return `#${m.parent_channel_name}:${shortId}`;
  }
  if (m.channel_type === "dm") return `dm:@${m.channel_name}`;
  return `#${m.channel_name}`;
}

/** staging agentText/tasks.ts: ` msg=${messageId.slice(0, 8)}` and agentTaskThreadTarget. */
const stagingTaskMsgField = (messageId: string) => ` msg=${messageId.slice(0, 8)}`;
const stagingTaskThreadTarget = (channel: string, messageId: string) => `${channel.replace(/^dm:user:/i, "dm:@")}:${messageId.slice(0, 8)}`;

// ── fixtures ────────────────────────────────────────────────────────────────

type Delivery = { agentId: string; payload: Record<string, unknown> };

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>) => {
    deliveries.push({ agentId, payload });
    return { status: "queued" as const };
  };
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown> }>) =>
      batch.map(({ agentId, message }) => deliverMessage(agentId, message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  return deliveries;
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `legacy-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return apiKey;
}

async function agentApi(baseUrl: string, apiKey: string, method: "GET" | "POST", apiPath: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

/** Task v2: a task always has a source; the creating agent's own message in the channel. */
async function ownSource(channelId: string, agentId: string, content: string) {
  return (await createMessage(channelId, "agent", agentId, content)).id;
}

async function seedScenario(app: { app: { set: (key: string, value: unknown) => void } }, slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Legacy ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await getDb().insert(serverMembers).values([{ serverId: server.id, userId: member.id, role: "member" }]);
  for (const user of [owner, member]) await addHuman(channel.id, user.id);
  const newAgent = await createAgent(server.id, `${slug}-new-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const oldAgent = await createAgent(server.id, `${slug}-old-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [newAgent, oldAgent]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  const deliveries = installRecordingOrchestrator(app.app);
  return {
    server, channel, member, deliveries,
    newAgent: { ...newAgent, key: await agentKey(newAgent.id) },
    oldAgent: { ...oldAgent, key: await agentKey(oldAgent.id) },
  };
}

test("pre-task-v2 clients (flag on): the delivered target is the task ref, and message send / read at it work", async ({ app }) => {
  const db = getDb();
  const s = await seedScenario(app, "legacy");
  const board = `#${s.channel.name}`;

  // The new agent hands the old agent a task.
  const created = await agentApi(app.baseUrl, s.newAgent.key, "POST", "tasks", { channel: board, tasks: [{ title: "hero copy", source_message_id: await ownSource(s.channel.id, s.newAgent.id, "hero copy") }], assignee: `@${s.oldAgent.name}` });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const ref = `${board}:#${taskNumber}`;
  // The old CLI's create receipt (` msg=…`, follow up at `<board>:<msg>`) names the ref.
  assert.equal(stagingTaskMsgField(created.body.tasks[0].messageId), ` msg=#${taskNumber}`);
  assert.equal(stagingTaskThreadTarget(board, created.body.tasks[0].messageId), ref);

  // The assignment notice reaches the old agent; every staging renderer prints the ref.
  const notice = await waitFor("assignment delivery", async () => s.deliveries.find((d) => d.agentId === s.oldAgent.id));
  assert.equal(stagingDaemonTarget(notice.payload), ref);
  assert.equal(stagingSharedTarget(notice.payload), ref);
  assert.equal(notice.payload.mentioned, true);

  // Old `message read --target <ref>` reads the task conversation.
  const read = await agentApi(app.baseUrl, s.oldAgent.key, "GET", `history?channel=${encodeURIComponent(ref)}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok((read.body.messages as Array<{ id: string }>).some((m) => m.id === notice.payload.message_id));

  // Old `message send --target <ref>` (v2 route, typed mention) posts there and wakes the follower.
  const sent = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "v2/send", {
    target: ref,
    content: `@${s.member.name} on it`,
    idempotencyKey: randomUUID(),
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent");
  const [row] = await db.select().from(messages).where(eq(messages.id, sent.body.messageId));
  const [task] = await db.select().from(tasks).where(and(eq(tasks.channelId, s.channel.id), eq(tasks.taskNumber, taskNumber)));
  assert.equal(row!.channelId, task!.conversationChannelId);
  const toNew = await waitFor("reply wakes the creator", async () => s.deliveries.find((d) => d.agentId === s.newAgent.id && d.payload.message_id === sent.body.messageId));
  assert.equal(toNew.payload.task_conversation_number, taskNumber, "the new agent sees the reply in the task conversation");
  const mentionFact = await waitFor("mention fact", async () => {
    const [fact] = await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, sent.body.messageId),
      eq(inboxNotificationFacts.receiverId, s.member.id),
    ));
    return fact;
  });
  assert.equal(mentionFact.personalMention, true, "the @mentioned person is notified");

  // The new agent @mentions the old agent in the task conversation (`raft task reply`):
  // the old agent is woken, and every staging renderer names the ref.
  const mentionOld = await agentApi(app.baseUrl, s.newAgent.key, "POST", "tasks/reply", {
    channel: board, task_number: taskNumber, content: `@${s.oldAgent.name} can you also check the pricing copy?`,
  });
  assert.equal(mentionOld.status, 200, JSON.stringify(mentionOld.body));
  const mentionDelivery = await waitFor("mention wakes the old agent", async () => s.deliveries.find((d) => d.agentId === s.oldAgent.id && d.payload.message_id === mentionOld.body.messageId));
  assert.equal(mentionDelivery.payload.mentioned, true);
  assert.equal(stagingDaemonTarget(mentionDelivery.payload), ref);
  assert.equal(stagingSharedTarget(mentionDelivery.payload), ref);

  // The old CLI's task outputs: `msg=#N`, claims follow up at the ref.
  const listed = await agentApi(app.baseUrl, s.oldAgent.key, "GET", `tasks?channel=${encodeURIComponent(board)}&status=all`);
  const listedTask = (listed.body.tasks as Array<{ taskNumber: number; messageId: string }>).find((t) => t.taskNumber === taskNumber)!;
  assert.equal(stagingTaskMsgField(listedTask.messageId), ` msg=#${taskNumber}`);
  const second = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "tasks", { channel: board, tasks: [{ title: "pricing", source_message_id: await ownSource(s.channel.id, s.oldAgent.id, "pricing") }] });
  const secondNumber = second.body.tasks[0].taskNumber as number;
  // Lazy: an unassigned task v2 task has no conversation until something needs it.
  const [secondBefore] = await db.select().from(tasks).where(and(eq(tasks.channelId, s.channel.id), eq(tasks.taskNumber, secondNumber)));
  assert.equal(secondBefore!.conversationChannelId, null);
  const claimed = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "tasks/claim", { channel: board, task_numbers: [secondNumber] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  // The claim created it; the old agent (creator and claimer) follows it.
  const [secondAfter] = await db.select().from(tasks).where(eq(tasks.id, secondBefore!.id));
  assert.ok(secondAfter!.conversationChannelId, "the claim created the task conversation");
  const [claimerFollow] = await db.select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, secondAfter!.conversationChannelId!),
    eq(threadFollows.followerType, "agent"),
    eq(threadFollows.followerId, s.oldAgent.id),
  ));
  assert.equal(claimerFollow?.reason, "authored", "its creator follows from the conversation's creation");
  assert.equal(stagingTaskThreadTarget(board, claimed.body.results[0].messageId), `${board}:#${secondNumber}`);
  const updated = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "tasks/update-status", { channel: board, task_number: secondNumber, status: "in_review" });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  // Old `task assign` (typed handle) hands it to the new agent, who is notified at the ref.
  const assigned = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "tasks/assign", { channel: board, task_number: secondNumber, assignee: s.newAgent.name });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const assignNotice = await waitFor("assignment reaches the new agent", async () => s.deliveries.find((d) => d.agentId === s.newAgent.id && d.payload.task_conversation_number === secondNumber));
  assert.equal(stagingDaemonTarget(assignNotice.payload), `${board}:#${secondNumber}`);
});

test("pre-task-v2 clients (flag on): a task from before task v2 gets its conversation from an old message send at the ref", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("legacy-lazy-owner");
  const server = await createServer("Legacy lazy", `legacy-lazy-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "legacy-lazy");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `legacy-lazy-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const created = await agentApi(app.baseUrl, key, "POST", "tasks", { channel: `#${channel.name}`, tasks: [{ title: "old" }] });
  const taskNumber = created.body.tasks[0].taskNumber as number;
  await enableTaskV2ConversationsForServer(server.id);

  const ref = `#${channel.name}:#${taskNumber}`;
  const listed = await agentApi(app.baseUrl, key, "GET", `tasks?channel=${encodeURIComponent(`#${channel.name}`)}&status=all`);
  assert.equal(stagingTaskThreadTarget(`#${channel.name}`, listed.body.tasks[0].messageId), ref, "the old follow-up target is the ref");
  const emptyRead = await agentApi(app.baseUrl, key, "GET", `history?channel=${encodeURIComponent(ref)}`);
  assert.deepEqual([emptyRead.status, emptyRead.body.target, emptyRead.body.messages], [200, ref, []]);
  const sent = await agentApi(app.baseUrl, key, "POST", "send", { target: ref, content: "first reply" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [task] = await db.select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, taskNumber)));
  assert.ok(task!.conversationChannelId, "the old send created the conversation");
  const [follow] = await db.select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, task!.conversationChannelId!),
    eq(threadFollows.followerType, "agent"),
    eq(threadFollows.followerId, agent.id),
  ));
  assert.equal(follow?.reason, "authored", "creating it makes the pre-v2 task's creator follow (replying keeps that reason)");
});

// ── opt-in: the real staging daemon formatter and CLI binary ────────────────

test.skipIf(!LEGACY_ROOT)("staging daemon + CLI end to end against this server (RAFT_LEGACY_SLOCK_ROOT)", async ({ app }) => {
  const s = await seedScenario(app, "legacy-e2e");
  const board = `#${s.channel.name}`;
  const work = mkdtempSync(path.join(tmpdir(), "raft-legacy-e2e-"));

  // Staging CLI as the old agent (profile credential mode).
  const raftHome = path.join(work, "home");
  mkdirSync(path.join(raftHome, "profiles", "old"), { recursive: true });
  writeFileSync(path.join(raftHome, "profiles", "old", "credential.json"), JSON.stringify({
    serverUrl: app.baseUrl, agentId: s.oldAgent.id, serverId: s.server.id, apiKey: s.oldAgent.key,
  }));
  const cliEntry = path.join(LEGACY_ROOT, "packages/cli/dist/raft.js");
  const oldCliWithStdin = (args: string[], stdin: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const proc = execFile(process.execPath, [cliEntry, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: work, RAFT_HOME: raftHome, RAFT_PROFILE: "old" },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }));
    proc.stdin!.end(stdin);
  });
  // Staging daemon formatter on a real payload (its own module graph).
  const renderScript = path.join(work, "render.ts");
  writeFileSync(renderScript, [
    `import { readFileSync } from "node:fs";`,
    `import { formatConcreteMessagesRuntimeInput } from ${JSON.stringify(path.join(LEGACY_ROOT, "packages/daemon/src/agentRuntimeInput.ts"))};`,
    `import { exampleStdinDriver } from ${JSON.stringify(path.join(LEGACY_ROOT, "packages/daemon/src/axExampleFixtures.ts"))};`,
    `process.stdout.write(String(formatConcreteMessagesRuntimeInput([JSON.parse(readFileSync(process.argv[2], "utf8"))], exampleStdinDriver)));`,
  ].join("\n"));
  const oldDaemonRender = async (payload: Record<string, unknown>) => {
    const file = path.join(work, `payload-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(payload));
    const { stdout } = await execFileAsync(process.execPath, ["--import", "@oxc-node/core/register", renderScript, file], {
      cwd: path.join(LEGACY_ROOT, "packages/daemon"),
      timeout: 60_000,
    });
    return stdout;
  };

  // 1. Assignment notice → the staging daemon renders the task ref.
  const created = await agentApi(app.baseUrl, s.newAgent.key, "POST", "tasks", { channel: board, tasks: [{ title: "hero copy", source_message_id: await ownSource(s.channel.id, s.newAgent.id, "hero copy") }], assignee: `@${s.oldAgent.name}` });
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const ref = `${board}:#${taskNumber}`;
  const notice = await waitFor("assignment delivery", async () => s.deliveries.find((d) => d.agentId === s.oldAgent.id));
  const rendered = await oldDaemonRender(notice.payload);
  assert.ok(rendered.includes(`[target=${ref} msg=`), rendered);

  // 2. Old `raft message read --target <ref>`.
  const read = await oldCliWithStdin(["message", "read", "--target", ref], "");
  assert.equal(read.code, 0, read.stderr + read.stdout);
  assert.match(read.stdout, /assigned/);

  // 3. Old `raft message send --target <ref>` with an @mention.
  const send = await oldCliWithStdin(["message", "send", "--target", ref], `@${s.member.name} on it — draft soon`);
  assert.equal(send.code, 0, send.stderr + send.stdout);
  assert.match(send.stdout, new RegExp(`Message sent to ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Message ID: `));
  const messageId = /Message ID: ([0-9a-f-]{36})/.exec(send.stdout)![1]!;
  const toNew = await waitFor("reply wakes the new agent", async () => s.deliveries.find((d) => d.agentId === s.newAgent.id && d.payload.message_id === messageId));
  assert.equal(toNew.payload.task_conversation_number, taskNumber);
  await waitFor("mention fact", async () => {
    const [fact] = await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, messageId),
      eq(inboxNotificationFacts.receiverId, s.member.id),
    ));
    return fact;
  });

  // 3b. The new agent @mentions the old one in the task: the staging daemon renders the ref.
  const mention = await agentApi(app.baseUrl, s.newAgent.key, "POST", "tasks/reply", {
    channel: board, task_number: taskNumber, content: `@${s.oldAgent.name} please check pricing too`,
  });
  assert.equal(mention.status, 200, JSON.stringify(mention.body));
  const mentionDelivery = await waitFor("mention reaches the old agent", async () => s.deliveries.find((d) => d.agentId === s.oldAgent.id && d.payload.message_id === mention.body.messageId));
  const mentionRendered = await oldDaemonRender(mentionDelivery.payload);
  assert.ok(mentionRendered.includes(`[target=${ref} msg=`), mentionRendered);
  const reread = await oldCliWithStdin(["message", "read", "--target", ref], "");
  assert.equal(reread.code, 0, reread.stderr + reread.stdout);
  assert.ok(reread.stdout.includes("please check pricing too"), reread.stdout);

  // 4. Old task commands against the task v2 DTOs.
  const list = await oldCliWithStdin(["task", "list", "--target", board, "--status", "all"], "");
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`#${taskNumber} \\[todo\\].* msg=#${taskNumber} `));
  assert.doesNotMatch(list.stdout, /undefined|null/);
  // A task always has a source: the old CLI's create without one is refused,
  // and its printed error carries the rule.
  const create = await oldCliWithStdin(["task", "create", "--target", board, "--title", "pricing"], "");
  assert.notEqual(create.code, 0, create.stdout);
  assert.ok((create.stderr + create.stdout).includes("A task needs a source"), create.stderr + create.stdout);
  const created2 = await agentApi(app.baseUrl, s.oldAgent.key, "POST", "tasks", {
    channel: board, tasks: [{ title: "pricing", source_message_id: await ownSource(s.channel.id, s.oldAgent.id, "pricing") }],
  });
  assert.equal(created2.status, 200, JSON.stringify(created2.body));
  const newNumber = created2.body.tasks[0].taskNumber as number;
  const claim = await oldCliWithStdin(["task", "claim", "--target", board, "--number", String(newNumber)], "");
  assert.equal(claim.code, 0, claim.stderr);
  assert.ok(claim.stdout.includes(`#${newNumber} (msg:#${newNumber}): claimed`), claim.stdout);
  assert.ok(claim.stdout.includes(`raft message send --target "${board}:#${newNumber}"`), claim.stdout);
  const followUp = await oldCliWithStdin(["message", "send", "--target", `${board}:#${newNumber}`], "starting on pricing");
  assert.equal(followUp.code, 0, followUp.stderr + followUp.stdout);
  for (const args of [
    ["task", "update", "--target", board, "--number", String(newNumber), "--status", "in_review"],
    ["task", "assign", "--target", board, "--number", String(newNumber), "--assignee", `@${s.newAgent.name}`],
    ["task", "unassign", "--target", board, "--number", String(newNumber)],
    ["task", "show", "--target", board, "--number", String(newNumber)],
    ["task", "history", "--target", board, "--number", String(newNumber)],
  ]) {
    const out = await oldCliWithStdin(args, "");
    assert.equal(out.code, 0, `${args.join(" ")}: ${out.stderr}${out.stdout}`);
    assert.doesNotMatch(out.stdout, /undefined/, args.join(" "));
  }
});
