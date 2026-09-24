import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Shape coverage entered through the *surfaces*, not the service functions.
 *
 * `taskService.allShapesOperations.test.ts` walks the same four shapes by
 * calling taskService directly. That is where this suite's sibling bug hid:
 * `deleteTaskByOwner` was written, tested, and green, while the HTTP route next
 * to it still ran its own inlined delete — so the service test proved a
 * function nobody called. A fix is only real at the layer a user can reach it
 * from, so these tests go over HTTP and over the agent internal API.
 *
 * The mutation that must stay lethal here: delete the `deleteTaskByOwner` call
 * out of `routes/tasks.ts` and this file goes red. Nothing in the pre-existing
 * suite did.
 */
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { users, messages, tasks } from "../db/schema.js";
import { createChannel, addHuman, addAgent } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type ShapeName = "v0" | "message" | "backfilled" | "v14";

/**
 * The shapes a task can still be reachable in after P3.
 *
 * `"message"` is deliberately NOT here any more. A row that lives only in
 * `messages.task_*` used to be a real, listable, deletable task; after P3 the
 * board reads `tasks` alone, so that shape is inert rather than broken. It is
 * still constructible via `makeShape("message")`, and the inertness is pinned
 * by its own test below -- dropping it from this list moves the assertion, it
 * does not delete it.
 */
const SHAPES: ShapeName[] = ["v0", "backfilled", "v14"];

async function seedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    email: `${email}@slock.test`,
    name: email,
    displayName: email,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function setup(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Surf ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner.id);
  return { owner, server, channel };
}

async function seedAgentWithMachine(serverId: string, channelId: string, ownerId: string, name: string) {
  const agent = await createAgent(serverId, name, { runtime: "claude" });
  const { machine, apiKey } = await registerMachine(serverId, ownerId, `${name}-machine`);
  await assignMachine(agent.id, machine.id);
  await addAgent(channelId, agent.id);
  return { agent, apiKey };
}

/** Next free task number across BOTH tables, so shapes never collide. */
async function nextNumber(channelId: string): Promise<number> {
  const db = getDb();
  const msgRows = await db.select({ n: messages.taskNumber }).from(messages);
  const taskRows = await db.select({ n: tasks.taskNumber }).from(tasks);
  const all = [...msgRows, ...taskRows].map((r) => r.n ?? 0);
  return (all.length ? Math.max(...all) : 0) + 1;
}

async function makeShape(shape: ShapeName, channelId: string, ownerId: string) {
  const db = getDb();
  const taskNumber = await nextNumber(channelId);

  if (shape === "v14") {
    const { tasks: [row] } = await taskService.createTasks(
      channelId, "user", ownerId, [{ title: `${shape} task` }],
    );
    return { id: row.id, taskNumber: row.taskNumber };
  }

  if (shape === "v0") {
    const [row] = await db.insert(tasks).values({
      channelId, taskNumber, title: `${shape} task`, status: "todo",
      createdByType: "user", createdById: ownerId,
    }).returning();
    return { id: row.id, taskNumber: row.taskNumber };
  }

  const [msg] = await db.insert(messages).values({
    channelId, senderType: "user", senderId: ownerId, messageType: "chat",
    content: `${shape} task`, taskStatus: "todo", taskNumber,
  }).returning();
  if (shape === "message") return { id: msg.id, taskNumber };

  const [row] = await db.insert(tasks).values({
    channelId, taskNumber, title: msg.content, status: "todo",
    createdByType: "user", createdById: ownerId, messageId: msg.id,
  }).returning();
  return { id: row.id, taskNumber: row.taskNumber };
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${email}@slock.test`, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/**
 * A backfilled task lives on both sides. Deleting only the canonical row also
 * removes the anti-join that suppresses its `messages.task_*` shadow, so the
 * task reappears on the board and the delete silently did nothing. This is the
 * bug the service-level suite could not see.
 */
test("DELETE /api/tasks/:id removes every shape for good — no shadow resurrection", async ({ app }) => {
  const { owner, server, channel } = await setup("surf-delete");
  const token = await login(app.baseUrl, "surf-delete-owner");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": server.id,
  };

  const made: Record<string, { id: string; taskNumber: number }> = {};
  for (const shape of SHAPES) made[shape] = await makeShape(shape, channel.id, owner.id);

  const remaining = [...SHAPES];
  for (const shape of SHAPES) {
    const res = await fetch(`${app.baseUrl}/api/tasks/${made[shape].id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(res.status, 200, `${shape}: delete should succeed`);

    remaining.shift();

    // Read back through the same surface the board uses.
    const listRes = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers });
    assert.equal(listRes.status, 200);
    const body = await listRes.json() as { tasks: { taskNumber: number }[] };
    const listed = (body.tasks ?? body as unknown as { taskNumber: number }[]).map((t) => t.taskNumber);

    assert.ok(
      !listed.includes(made[shape].taskNumber),
      `${shape}: deleted task #${made[shape].taskNumber} came back on the board (listed: ${listed})`,
    );
    assert.deepEqual(
      [...listed].sort((a, b) => a - b),
      remaining.map((s) => made[s].taskNumber).sort((a, b) => a - b),
      `${shape}: delete must remove exactly one task`,
    );
  }
});

/**
 * The other half of the shape that P3 retired. Un-backfilled `messages.task_*`
 * rows are gone from prod (2026-07-31 backfill), but nothing stops one being
 * written by an older client or left by a partial restore. P3's claim is that
 * such a row is INERT: invisible to the board and unreachable through the task
 * surface -- not that it cannot exist.
 *
 * This is what stops a silent regression where the union quietly comes back:
 * re-add a `messages` read to `listTasks` and this test goes red.
 */
test("a message-only task row is inert after P3 — not on the board, not reachable", async ({ app }) => {
  const { owner, server, channel } = await setup("surf-inert");
  const token = await login(app.baseUrl, "surf-inert-owner");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": server.id,
  };

  const stray = await makeShape("message", channel.id, owner.id);
  const real = await makeShape("v14", channel.id, owner.id);

  // Precondition: without this the assertions below pass vacuously if
  // `makeShape("message")` ever stops writing a shadow row.
  const strayRows = await getDb().select().from(messages);
  assert.ok(
    strayRows.some((m) => m.id === stray.id && m.taskStatus != null),
    "precondition: the message-only row must actually exist with task columns set",
  );

  const listRes = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers });
  assert.equal(listRes.status, 200);
  const body = await listRes.json() as { tasks: { taskNumber: number }[] };
  const listed = (body.tasks ?? body as unknown as { taskNumber: number }[]).map((t) => t.taskNumber);

  assert.deepEqual(
    listed, [real.taskNumber],
    `only the canonical task may be listed (got ${listed}); a message-only row must not surface`,
  );

  // ...and the row is not addressable through the task surface either.
  const delRes = await fetch(`${app.baseUrl}/api/tasks/${stray.id}`, { method: "DELETE", headers });
  assert.equal(delRes.status, 404, "a message-only row must not resolve as a task");
});

/**
 * Storage-level proof of the same thing: after deleting a backfilled task the
 * message-side shadow must be gone too, not merely hidden. A shadow left behind
 * would resurface the moment R2 drops the union.
 */
test("deleting a backfilled task clears the message-side shadow, not just the canonical row", async ({ app }) => {
  const db = getDb();
  const { owner, server, channel } = await setup("surf-shadow");
  const token = await login(app.baseUrl, "surf-shadow-owner");

  const made = await makeShape("backfilled", channel.id, owner.id);
  const before = await db.select().from(messages);
  assert.ok(
    before.some((m) => m.taskStatus != null && m.taskNumber === made.taskNumber),
    "precondition: the backfilled shape must have a message-side shadow",
  );

  const res = await fetch(`${app.baseUrl}/api/tasks/${made.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Server-Id": server.id,
    },
  });
  assert.equal(res.status, 200);

  const canonical = await db.select().from(tasks);
  assert.equal(canonical.length, 0, "canonical row must be gone");

  const shadows = await db.select().from(messages);
  assert.ok(
    !shadows.some((m) => m.taskStatus != null),
    "message-side task columns must be cleared too — a leftover shadow resurrects the task",
  );
});

/**
 * Pre-thread orphans have no host message, so the agent surface has no way to
 * show or discuss a change to them. Before v1.4 the agent task endpoints read
 * `messages` alone and answered "task not found"; ownership routing made them
 * reachable for the first time. This pins the pre-migration answer.
 *
 * Note this is deliberately narrower than "orphans are read-only": the human
 * REST surface has always been able to write them (`requireTaskInServer`
 * resolves them), and widening or closing that is not this migration's call.
 */
test("agent task endpoints cannot reach a v0 orphan", async ({ app }) => {
  const { owner, server, channel } = await setup("surf-agentorphan");
  const { agent, apiKey } = await seedAgentWithMachine(server.id, channel.id, owner.id, "surf-agent");

  const orphan = await makeShape("v0", channel.id, owner.id);
  const reachable = await makeShape("backfilled", channel.id, owner.id);

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const base = `${app.baseUrl}/internal/agent/${agent.id}/tasks`;

  // claim by number: the orphan is reported as absent, its neighbour is not
  const claimRes = await fetch(`${base}/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channel: `#${channel.name}`,
      task_numbers: [orphan.taskNumber, reachable.taskNumber],
    }),
  });
  assert.equal(claimRes.status, 200);
  const claim = await claimRes.json() as { results: { taskNumber: number; success: boolean; reason?: string }[] };
  const orphanResult = claim.results.find((r) => r.taskNumber === orphan.taskNumber);
  const otherResult = claim.results.find((r) => r.taskNumber === reachable.taskNumber);
  assert.equal(orphanResult?.success, false, "orphan must not be claimable by an agent");
  assert.equal(orphanResult?.reason, "task not found", "orphan must answer exactly as it did pre-migration");
  assert.equal(otherResult?.success, true, "a backfilled task next to it must still be claimable");

  // and the orphan really was not written
  const [orphanRow] = await getDb().select().from(tasks);
  const stillUnclaimed = (await getDb().select().from(tasks)).find((t) => t.id === orphan.id);
  assert.equal(stillUnclaimed?.claimedById, null, "a rejected claim must not write the orphan");
  assert.ok(orphanRow, "sanity: rows exist");

  // status: same answer
  const statusRes = await fetch(`${base}/update-status`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channel: `#${channel.name}`,
      task_number: orphan.taskNumber,
      status: "in_review",
    }),
  });
  assert.equal(statusRes.status, 404, "agent status update on an orphan must 404");
});
