import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agents, channelAgents, messages, tasks, users } from "../db/schema.js";
import { createChannel, addHuman } from "./channelService.js";
import { createServer } from "./serverService.js";
import * as taskService from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// Force is an admin override; the actor is now required so the audit trail can
// name who overrode the state machine. These call sites are arrangement, not
// the property under test.
const ADMIN_FORCE_ACTOR_ID = "00000000-0000-0000-0000-0000000000ad";

/**
 * **Every operation, on every shape a task can have, by both actor kinds.**
 *
 * stdrc's requirement (#proj-task:c06b64b7): a task created under *any* of the
 * historical models must remain fully operable after the v1.4 storage move —
 * claim, unclaim, status transitions, admin force-override, batch claim by
 * number, and delete — for humans and for agents alike.
 *
 * The four shapes:
 *
 *  - **v0**         `tasks` row with **no** host message (`message_id IS NULL`)
 *  - **message**    state on `messages.task_*`, no `tasks` row
 *  - **backfilled** both: `messages.task_*` AND a `tasks` row pointing at it
 *  - **v14**        `tasks` row + plain host message (what v1.4 creates)
 *
 * **P3 update.** The prod backfill (2026-07-31) gave every real task a canonical
 * row, and P3 then collapsed reads onto `tasks` alone. So `message` is no longer
 * an operable shape — it is inert. It is therefore removed from `SHAPES` and
 * covered by its own test below, which asserts every operation refuses it. That
 * is a deliberate inversion of stdrc's requirement for exactly one shape, and it
 * is safe only because no such row remains in prod; the requirement still holds
 * in full for v0, backfilled and v14, which is what the loops below cover.
 *
 * The risk this pins down is unchanged: every mutation must write only the
 * canonical side. A shape that silently became read-only, or that got written on
 * both sides, would still show up here.
 */

type ShapeName = "v0" | "message" | "backfilled" | "v14";

async function seedUser(name: string) {
  const db = getDb();
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    email: `${name}-${suffix}@slock.test`,
    name: `${name}-${suffix}`,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function seedAgent(serverId: string, channelId: string, name: string) {
  const db = getDb();
  const [agent] = await db.insert(agents).values({
    serverId,
    name: `${name}-${randomUUID().slice(0, 8)}`,
    displayName: name,
    status: "active",
    runtime: "claude_code",
    model: "sonnet",
    reasoningEffort: "medium",
    executionMode: "cloud",
    creatorType: "user",
    creatorId: "00000000-0000-0000-0000-000000000000",
  }).returning();
  await db.insert(channelAgents).values({ channelId, agentId: agent.id }).onConflictDoNothing();
  return agent;
}

async function setup(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Ops ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner.id);
  const agent = await seedAgent(server.id, channel.id, `${slug}-agent`);
  return { owner, server, channel, agent };
}

/** Next free task number across BOTH tables, so shapes never collide. */
async function nextNumber(channelId: string): Promise<number> {
  const db = getDb();
  const msgRows = await db.select({ n: messages.taskNumber }).from(messages)
    .where(eq(messages.channelId, channelId));
  const taskRows = await db.select({ n: tasks.taskNumber }).from(tasks)
    .where(eq(tasks.channelId, channelId));
  const all = [...msgRows, ...taskRows].map((r) => r.n ?? 0);
  return (all.length ? Math.max(...all) : 0) + 1;
}

/** Build one task of the requested shape; returns its id + number. */
async function makeShape(
  shape: ShapeName,
  channelId: string,
  ownerId: string,
): Promise<{ id: string; taskNumber: number; hostMessageId: string | null }> {
  const db = getDb();
  const taskNumber = await nextNumber(channelId);

  if (shape === "v14") {
    const { tasks: [row], hostMessages: [host] } = await taskService.createTasks(
      channelId, "user", ownerId, [{ title: `${shape} task` }],
    );
    return { id: row.id, taskNumber: row.taskNumber, hostMessageId: host.id };
  }

  if (shape === "v0") {
    const [row] = await db.insert(tasks).values({
      channelId, taskNumber, title: `${shape} task`, status: "todo",
      createdByType: "user", createdById: ownerId,
    }).returning();
    return { id: row.id, taskNumber: row.taskNumber, hostMessageId: null };
  }

  const [msg] = await db.insert(messages).values({
    channelId, senderType: "user", senderId: ownerId, messageType: "chat",
    content: `${shape} task`, taskStatus: "todo", taskNumber,
  }).returning();

  if (shape === "message") {
    return { id: msg.id, taskNumber, hostMessageId: msg.id };
  }

  // backfilled: the tasks row becomes authoritative and owns the mutations
  const [row] = await db.insert(tasks).values({
    channelId, taskNumber, title: msg.content, status: "todo",
    createdByType: "user", createdById: ownerId, messageId: msg.id,
  }).returning();
  return { id: row.id, taskNumber: row.taskNumber, hostMessageId: msg.id };
}

function unwrap(result: taskService.TaskMutationResult, label: string) {
  assert.notEqual(typeof result, "string", `${label} failed: ${String(result)}`);
  return result as Exclude<taskService.TaskMutationResult, string>;
}

function statusOf(result: taskService.TaskMutationResult): string {
  // P3: `TaskOwner` has a single variant, so there is no message-side branch.
  return unwrap(result, "status read").row.status;
}

function assigneeOf(result: taskService.TaskMutationResult): string | null {
  return unwrap(result, "assignee read").row.claimedById;
}

/** The shapes that remain operable after P3. `message` is inert — see below. */
const SHAPES: ShapeName[] = ["v0", "backfilled", "v14"];

for (const actorKind of ["user", "agent"] as const) {
  test(`every shape supports the full claim → unclaim → reclaim → status lifecycle (${actorKind})`, async ({ app }) => {
    const { owner, channel, agent } = await setup(`ops-life-${actorKind}`);
    const actorId = actorKind === "user" ? owner.id : agent.id;

    for (const shape of SHAPES) {
      const made = await makeShape(shape, channel.id, owner.id);
      const where = `${shape}/${actorKind}`;

      // claim → auto-advances todo to in_progress
      const claimed = unwrap(await taskService.claimTask(made.id, actorKind, actorId), `${where} claim`);
      assert.equal(statusOf(claimed), "in_progress", `${where}: claim must start the task`);
      assert.equal(assigneeOf(claimed), actorId, `${where}: claim must record the assignee`);

      // unclaim → assignee cleared, status preserved
      const unclaimed = unwrap(await taskService.unclaimTask(made.id, actorKind, actorId), `${where} unclaim`);
      assert.equal(assigneeOf(unclaimed), null, `${where}: unclaim must clear the assignee`);
      assert.equal(statusOf(unclaimed), "in_progress", `${where}: unclaim must not change status`);

      // re-claim, then walk the rest of the state machine
      unwrap(await taskService.claimTask(made.id, actorKind, actorId), `${where} reclaim`);
      const review = unwrap(
        await taskService.updateTaskStatus(made.id, "in_review", actorId, actorKind),
        `${where} → in_review`,
      );
      assert.equal(statusOf(review), "in_review", where);
      const done = unwrap(
        await taskService.updateTaskStatus(made.id, "done", actorId, actorKind),
        `${where} → done`,
      );
      assert.equal(statusOf(done), "done", where);
    }
  });
}

/**
 * Claim-by-number is the *agent* surface — every caller of `batchClaimTasks` is
 * an agent task route. It is therefore the one path where v0 orphans behave
 * differently from the by-id lifecycle above: before v1.4 this query ran
 * against `messages` alone, so an orphan had no row and the agent got "task not
 * found". Ownership routing would otherwise have handed agents write access to
 * tasks that have no thread to show the change in, which is not something a
 * storage migration gets to decide.
 *
 * The by-id functions exercised in the lifecycle test are the human REST path,
 * which has always been able to write orphans. That asymmetry is pre-existing
 * and deliberately left alone here.
 */
test("claim-by-number reaches every shape except the v0 orphan (agent surface)", async ({ app }) => {
  const { owner, channel } = await setup("ops-batch");

  const made: Record<string, { id: string; taskNumber: number }> = {};
  for (const shape of SHAPES) made[shape] = await makeShape(shape, channel.id, owner.id);

  const results = await taskService.batchClaimTasks(
    channel.id,
    SHAPES.map((s) => made[s].taskNumber),
    "user",
    owner.id,
  );

  assert.equal(results.length, SHAPES.length);
  for (const [i, shape] of SHAPES.entries()) {
    assert.equal(results[i].taskNumber, made[shape].taskNumber, shape);
    if (shape === "v0") {
      assert.equal(results[i].success, false, "v0 orphan must not be claimable by number");
      assert.equal(
        results[i].reason,
        "task not found",
        "v0 orphan must answer exactly as it did before the migration",
      );
      continue;
    }
    assert.equal(results[i].success, true, `${shape}: batch claim must succeed (${results[i].reason})`);
  }

  // and the rejection must not have written the orphan
  const [orphanRow] = await getDb().select().from(tasks).where(eq(tasks.id, made.v0.id));
  assert.equal(orphanRow.claimedById, null, "a rejected claim must leave the orphan untouched");
  assert.equal(orphanRow.status, "todo", "a rejected claim must not advance the orphan");
});

/**
 * The `message` shape's half of stdrc's requirement, inverted by P3.
 *
 * Pre-P3 this shape went through the same claim/unclaim/status/force/delete loop
 * as the others. It is now inert, and that has to be asserted rather than merely
 * un-tested: an un-asserted shape is one nobody notices creeping back. Every
 * mutation must refuse it, and — the part that actually matters — no mutation may
 * write EITHER table on the way to refusing.
 */
test("the message-only shape is inert — every operation refuses it and writes nothing", async ({ app }) => {
  const { owner, channel, agent } = await setup("ops-inert");
  const db = getDb();
  const made = await makeShape("message", channel.id, owner.id);

  // Precondition, so none of the below can pass vacuously.
  const [seeded] = await db.select().from(messages).where(eq(messages.id, made.id));
  assert.equal(seeded.taskStatus, "todo", "precondition: the shadow row must exist");

  assert.equal(await taskService.resolveTaskById(made.id), null, "must not resolve by id");
  assert.equal(
    await taskService.resolveTaskByNumber(channel.id, made.taskNumber), null,
    "must not resolve by number",
  );
  assert.equal(await taskService.resolveTaskByMessageId(made.id), null, "must not resolve by message");
  assert.deepEqual(await taskService.listTasks(channel.id), [], "must not list");

  for (const [label, run] of [
    ["claim(user)", () => taskService.claimTask(made.id, "user", owner.id)],
    ["claim(agent)", () => taskService.claimTask(made.id, "agent", agent.id)],
    ["unclaim", () => taskService.unclaimTask(made.id, "user", owner.id)],
    ["status", () => taskService.updateTaskStatus(made.id, "in_review", owner.id, "user")],
    ["force", () => taskService.forceUpdateTaskStatus(made.id, "closed", "user", ADMIN_FORCE_ACTOR_ID)],
  ] as const) {
    assert.equal(typeof await run(), "string", `${label} must refuse an inert row`);
  }

  // Batch claim answers the same way the agent surface always has.
  const batch = await taskService.batchClaimTasks(
    channel.id, [made.taskNumber], "user", owner.id,
  );
  assert.equal(batch[0].success, false, "batch claim must refuse");
  assert.equal(batch[0].reason, "task not found");

  // Nothing above may have written either side.
  const [after] = await db.select().from(messages).where(eq(messages.id, made.id));
  assert.equal(after.taskStatus, "todo", "the shadow must not be advanced");
  assert.equal(after.taskAssigneeId, null, "the shadow must not gain an assignee");
  assert.deepEqual(
    await db.select().from(tasks).where(eq(tasks.messageId, made.id)), [],
    "and no canonical row may be minted for it",
  );
});

test("every shape accepts the admin force-override on status", async ({ app }) => {
  const { owner, channel } = await setup("ops-force");

  for (const shape of SHAPES) {
    const made = await makeShape(shape, channel.id, owner.id);
    // force-close works without a claim; `closed` is the non-success terminal
    const closed = unwrap(
      await taskService.forceUpdateTaskStatus(made.id, "closed", "user", ADMIN_FORCE_ACTOR_ID),
      `${shape} force-close`,
    );
    assert.equal(statusOf(closed), "closed", shape);

    // and a closed task can be reopened to todo by the same override
    const reopened = unwrap(
      await taskService.forceUpdateTaskStatus(made.id, "todo", "user", ADMIN_FORCE_ACTOR_ID),
      `${shape} force-reopen`,
    );
    assert.equal(statusOf(reopened), "todo", shape);
  }
});

test("every shape can be deleted, and deleting one never removes another", async ({ app }) => {
  const { owner, channel } = await setup("ops-delete");

  const made: Record<string, { id: string; taskNumber: number }> = {};
  for (const shape of SHAPES) made[shape] = await makeShape(shape, channel.id, owner.id);
  assert.equal((await taskService.listTasks(channel.id)).length, SHAPES.length);

  const remaining = [...SHAPES];
  for (const shape of SHAPES) {
    const owned = await taskService.resolveTaskById(made[shape].id);
    assert.ok(owned, `${shape} must resolve before delete`);
    await taskService.deleteTaskByOwner(owned!);

    remaining.shift();
    const listed = await taskService.listTasks(channel.id);
    assert.equal(listed.length, remaining.length, `${shape}: delete must remove exactly one`);
    assert.deepEqual(
      listed.map((t) => t.taskNumber).sort((a, b) => a - b),
      remaining.map((s) => made[s].taskNumber).sort((a, b) => a - b),
      `${shape}: the surviving tasks must be exactly the ones not yet deleted`,
    );
  }
});

test("mutating any shape writes only its owning table", async ({ app }) => {
  const { owner, channel } = await setup("ops-isolation");
  const db = getDb();

  for (const shape of SHAPES) {
    const made = await makeShape(shape, channel.id, owner.id);
    await taskService.claimTask(made.id, "user", owner.id);
    await taskService.updateTaskStatus(made.id, "in_review", owner.id, "user");

    const owned = await taskService.resolveTaskById(made.id);
    assert.equal(owned?.source, "tasks", `${shape}: unexpected owning table`);

    if (shape === "v14") {
      // the host message must stay a plain chat row
      const [host] = await db.select().from(messages).where(eq(messages.id, made.hostMessageId!));
      assert.equal(host.taskStatus, null, "v14 host message must not gain task state");
      assert.equal(host.taskNumber, null, "v14 host message must not gain a task number");
    }

    if (shape === "backfilled") {
      // the stale message-side shadow must not be advanced by the mutation
      const [shadow] = await db.select().from(messages).where(eq(messages.id, made.hostMessageId!));
      assert.equal(shadow.taskStatus, "todo", "backfilled: stale shadow must not be written");
    }
  }
});
