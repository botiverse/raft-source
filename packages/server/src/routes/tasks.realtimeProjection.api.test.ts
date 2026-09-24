import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { messages, users } from "../db/schema.js";
import { addHuman, createChannel } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type EmittedEvent = { rooms: string[]; event: string; payload: unknown };
type FakeAudience = {
  to(room: string): FakeAudience;
  emit(event: string, payload: unknown): void;
};

function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const makeAudience = (rooms: string[]): FakeAudience => ({
    to(room: string) {
      return makeAudience([...rooms, room]);
    },
    emit(event: string, payload: unknown) {
      events.push({ rooms, event, payload });
    },
  });
  app.set("io", { to: (room: string) => makeAudience([room]) });
  return events;
}

async function seedOwner(email: string, name: string, displayName: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email,
    name,
    displayName,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return owner;
}

async function loginToken(baseUrl: string, email: string) {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json() as { accessToken: string };
  return accessToken;
}

/**
 * Pre-P3 this asserted that claiming a message-task emitted an ALLOWLISTED
 * `message:updated` — never a raw DB row, so `agentSendKey` / `searchText` /
 * `searchVector` could not leak to the channel. P3 removed that emission
 * entirely (the message-owned branch of `emitTaskUpdate` is gone), so the
 * trigger no longer exists at this layer.
 *
 * The allowlist property itself was NOT dropped: it is asserted directly on the
 * projector in `taskRealtimeEvents.test.ts` ("must-not-leak" row → payload has
 * no `agentSendKey`/`searchText`/`searchVector`), and `tasks.ts` is now pinned
 * to emit no `message:updated` at all by the ratchet in that same file.
 *
 * What this test pins instead is the P3 contract at the HTTP layer: the claim is
 * refused, and — the part worth asserting — the refusal is SILENT. A route that
 * 404s but still broadcasts would publish a task the board cannot open.
 */
test("a message-only task cannot be claimed over HTTP, and emits nothing", async ({ app }) => {
  const db = getDb();
  const owner = await seedOwner(
    "task-realtime-projection@slock.test",
    "task-realtime-projection",
    "Task Realtime Projection",
  );
  const server = await createServer("Task Realtime Projection", "task-realtime-projection", owner.id);
  const channel = await createChannel(server.id, "task-realtime-projection");
  await addHuman(channel.id, owner.id);

  // A pre-v1.4 message-task, carrying exactly the storage-only fields that
  // must never reach a socket.
  const [task] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    messageType: "chat",
    content: "Projection contract",
    taskStatus: "todo",
    taskNumber: 1,
    agentSendKey: "internal-agent-send-key",
    searchText: "internal search text",
  }).returning();

  const events = installFakeIo(app.app);
  const accessToken = await loginToken(app.baseUrl, owner.email);

  const claim = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(claim.status, 404, "a message-only row is not a task after P3");

  assert.deepEqual(
    events.filter((e) => e.event === "message:updated" || e.event === "task:updated"), [],
    "a refused claim must not broadcast anything",
  );

  // And the row is untouched — refusal, not a partial write.
  const [after] = await db.select().from(messages).where(eq(messages.id, task.id));
  assert.equal(after.taskStatus, "todo");
  assert.equal(after.taskAssigneeId, null);
});

test("canonical task claim emits only the task-board event, never a message row that did not change", async ({ app }) => {
  const db = getDb();
  const owner = await seedOwner(
    "task-realtime-canonical@slock.test",
    "task-realtime-canonical",
    "Task Realtime Canonical",
  );
  const server = await createServer("Task Realtime Canonical", "task-realtime-canonical", owner.id);
  const channel = await createChannel(server.id, "task-realtime-canonical");
  await addHuman(channel.id, owner.id);
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "Canonical projection contract" }],
  );

  const events = installFakeIo(app.app);
  const accessToken = await loginToken(app.baseUrl, owner.email);

  const claim = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(claim.status, 200, await claim.clone().text());

  // The host message row is untouched by a canonical claim, so broadcasting
  // it as `message:updated` would publish a row state that does not exist.
  const messageUpdate = events.find((candidate) =>
    candidate.event === "message:updated"
    && (candidate.payload as { id?: string }).id === host.id
  );
  assert.equal(messageUpdate, undefined, "an unchanged host message must not be re-broadcast");

  const taskUpdate = events.find((candidate) => candidate.event === "task:updated");
  assert.ok(taskUpdate, "the task board must still learn about the claim");
  const updated = (taskUpdate.payload as { task: Record<string, unknown> }).task;
  assert.equal(updated.id, task.id);
  assert.equal(updated.messageId, host.id, "the task keeps its host-message association");
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.claimedById, owner.id);

  // And the stored host message really did stay a plain message.
  const [storedHost] = await db.select().from(messages).where(eq(messages.id, host.id));
  assert.equal(storedHost.taskStatus, null);
  assert.equal(storedHost.taskNumber, null);
});
