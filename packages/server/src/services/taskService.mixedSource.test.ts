import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { messages, tasks, users } from "../db/schema.js";
import { createChannel, addHuman } from "./channelService.js";
import { createServer } from "./serverService.js";
import * as messageService from "./messageService.js";
import * as taskService from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * Source coverage after P3 closed the v1.4 compatibility window.
 *
 * The window ran from shipping the code to finishing the prod backfill
 * (2026-07-31), during which a channel could hold three shapes at once:
 *
 *   1. **legacy** — task state on `messages.task_*`, no `tasks` row (0% backfilled)
 *   2. **backfilled** — the same message, now ALSO mirrored into `tasks`
 *   3. **canonical** — a v1.4 task, `tasks` row + plain host message
 *
 * **P3 collapsed reads onto `tasks` alone, so shape 1 is now INERT** — such a
 * row can still be written by an older client or left by a partial restore, but
 * nothing lists or resolves it. These tests were kept rather than deleted, and
 * each one's assertion was inverted rather than dropped: the file's job is now
 * to pin that shape 1 stays invisible while 2 and 3 behave exactly as before.
 * That is what stops the union quietly coming back.
 *
 * Shape 2 remains the interesting one: it is the only state where a task is
 * physically represented twice, and it is what every backfilled prod row looks
 * like. It must surface exactly once, from the canonical side.
 */

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

/** A pre-v1.4 task: state on the message row, nothing in `tasks`. */
async function seedLegacyMessageTask(
  channelId: string,
  ownerId: string,
  title: string,
  taskNumber: number,
) {
  const db = getDb();
  const [row] = await db.insert(messages).values({
    channelId,
    senderType: "user",
    senderId: ownerId,
    messageType: "chat",
    content: title,
    taskStatus: "todo",
    taskNumber,
  }).returning();
  return row;
}

/**
 * What P2's backfill will do to a legacy row: copy it into `tasks`, preserving
 * the task number, and leave `messages.task_*` in place (the backfill does not
 * clear the old columns — that is P4).
 */
async function backfillLegacyTask(message: typeof messages.$inferSelect, ownerId: string) {
  const db = getDb();
  const [row] = await db.insert(tasks).values({
    channelId: message.channelId,
    taskNumber: message.taskNumber!,
    title: message.content,
    status: message.taskStatus as "todo",
    createdByType: "user",
    createdById: ownerId,
    messageId: message.id,
  }).returning();
  return row;
}

/**
 * A **task v0** row: lives in `tasks` with **no host message at all**
 * (`message_id IS NULL`). These predate message-tasks entirely, so there is no
 * thread to open and nothing on the message side to dedupe against. This is the
 * third shape stdrc named, and the one with no prior list-path coverage.
 */
async function seedV0OrphanTask(
  channelId: string,
  ownerId: string,
  title: string,
  taskNumber: number,
  status: "todo" | "in_progress" | "in_review" | "done" | "closed" = "todo",
) {
  const db = getDb();
  const [row] = await db.insert(tasks).values({
    channelId,
    taskNumber,
    title,
    status,
    createdByType: "user",
    createdById: ownerId,
  }).returning();
  return row;
}

async function setupChannel(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Mixed ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner.id);
  return { owner, server, channel };
}

test("0% backfilled: legacy message-tasks are inert — the board is empty", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-zero");
  const one = await seedLegacyMessageTask(channel.id, owner.id, "legacy one", 1);
  await seedLegacyMessageTask(channel.id, owner.id, "legacy two", 2);

  // Pre-P3 this asserted [1, 2] -- message-only rows WERE the whole list.
  // P3 makes them inert, so the inverse is the contract now. Asserting the
  // empty list (rather than deleting the test) is what makes a re-introduced
  // `messages` read fail here.
  const listed = await taskService.listTasks(channel.id);
  assert.deepEqual(listed, [], "a message-only row must not surface after P3");

  // Inert, not corrupt: the rows are still physically present. Without this
  // the assertion above would also pass if the seed helper silently no-oped.
  const shadows = await getDb().select().from(messages).where(eq(messages.channelId, channel.id));
  assert.equal(
    shadows.filter((m) => m.taskStatus != null).length, 2,
    "precondition: both message-side rows must still exist",
  );
  assert.equal(await taskService.resolveTaskById(one.id), null, "and must not resolve");
});

test("100% backfilled: each task surfaces once, from the canonical row", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-full");
  const legacyOne = await seedLegacyMessageTask(channel.id, owner.id, "backfilled one", 1);
  const legacyTwo = await seedLegacyMessageTask(channel.id, owner.id, "backfilled two", 2);
  const canonicalOne = await backfillLegacyTask(legacyOne, owner.id);
  const canonicalTwo = await backfillLegacyTask(legacyTwo, owner.id);

  const listed = await taskService.listTasks(channel.id);
  assert.equal(listed.length, 2, "a backfilled task must not appear twice");
  assert.deepEqual(listed.map((task) => task.taskNumber), [1, 2], "numbering is preserved by backfill");
  // The rows come from `tasks` (ids are task ids), and each still points at
  // its host message so threads/URLs keep resolving.
  assert.deepEqual(listed.map((task) => task.id), [canonicalOne.id, canonicalTwo.id]);
  assert.deepEqual(listed.map((task) => task.messageId), [legacyOne.id, legacyTwo.id]);
});

test("partially backfilled: no task lost, no task doubled, order preserved", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-partial");

  // #1 stays legacy, #2 is backfilled, #3 is a native v1.4 task.
  const stillLegacy = await seedLegacyMessageTask(channel.id, owner.id, "still legacy", 1);
  const toBackfill = await seedLegacyMessageTask(channel.id, owner.id, "already backfilled", 2);
  const backfilled = await backfillLegacyTask(toBackfill, owner.id);
  const { tasks: [native] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "native v1.4" }],
  );

  // P3: the un-backfilled #1 is inert, so the board shows #2 and #3 only.
  // "No task lost, no task doubled, order preserved" still holds -- over the
  // tasks that are actually reachable.
  const listed = await taskService.listTasks(channel.id);
  assert.equal(listed.length, 2, "expected exactly one entry per reachable task");
  assert.deepEqual(listed.map((task) => task.taskNumber), [2, 3]);
  assert.deepEqual(
    listed.map((task) => task.title),
    ["already backfilled", "native v1.4"],
  );
  assert.deepEqual(
    listed.map((task) => task.id),
    [backfilled.id, native.id],
  );

  // ⭐ Retained across P3 and worth its own assertion: number ALLOCATION still
  // consults `messages.task_number`, even though number LOOKUP no longer does.
  // Collapsing reads must not collapse this, or a new task would reuse #1 and
  // collide with the shadow the moment anyone reads the old side again.
  assert.equal(native.taskNumber, 3, "numbering must not collide across the two tables");

  // Lookup agrees with the list: #1 is unreachable, #2/#3 resolve canonically.
  const byNumber = await Promise.all(
    [1, 2, 3].map((n) => taskService.resolveTaskByNumber(channel.id, n)),
  );
  assert.equal(byNumber[0], null, "an un-backfilled message-task must not resolve by number");
  assert.deepEqual(byNumber.slice(1).map((owned) => owned?.source), ["tasks", "tasks"]);
  assert.deepEqual(
    byNumber.slice(1).map((owned) => owned?.row.id),
    [backfilled.id, native.id],
  );
  // The shadow row is still physically there -- #1 is inert, not deleted.
  assert.ok(stillLegacy.taskNumber === 1);

  // The host message of a backfilled task resolves to the canonical row, not
  // to its own stale `messages.task_*` shadow.
  const byMessage = await taskService.resolveTaskByMessageId(toBackfill.id);
  assert.equal(byMessage?.source, "tasks");
  assert.equal(byMessage?.row.id, backfilled.id);
});

test("status filter cannot resurrect the suppressed twin of a backfilled task", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-filter");
  const legacy = await seedLegacyMessageTask(channel.id, owner.id, "diverged twin", 1);
  const canonical = await backfillLegacyTask(legacy, owner.id);

  // Drive the canonical row forward without touching the stale message
  // columns — exactly what a claim does after the cut.
  await taskService.claimTask(canonical.id, "user", owner.id);

  const todo = await taskService.listTasks(channel.id, "todo");
  assert.deepEqual(
    todo.map((task) => task.id),
    [],
    "the stale todo shadow must stay suppressed even when the filter matches only it",
  );

  const inProgress = await taskService.listTasks(channel.id, "in_progress");
  assert.deepEqual(inProgress.map((task) => task.id), [canonical.id]);
  assert.equal(inProgress[0]?.status, "in_progress");

  // The shadow really is still there — this test would pass trivially if the
  // backfill had cleared it, so pin that it did not.
  const [shadow] = await getDb().select().from(messages).where(eq(messages.id, legacy.id));
  assert.equal(shadow.taskStatus, "todo", "P2 backfill leaves the legacy columns in place");
});

test("host message reads project the canonical task fields back on", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-projection");
  const legacy = await seedLegacyMessageTask(channel.id, owner.id, "legacy task body", 1);
  const { tasks: [native], hostMessages: [nativeHost] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "canonical task body" }],
  );
  await taskService.claimTask(native.id, "user", owner.id);

  // Stored truth: the host message row itself has no task columns.
  const [storedHost] = await getDb().select().from(messages).where(eq(messages.id, nativeHost.id));
  assert.equal(storedHost.taskStatus, null);

  // Published truth: the read path still hands out the `task_*` shape the CLI
  // renders `[task #N status=... @assignee]` from, for BOTH representations.
  const listed = await messageService.listMessages(channel.id, 50);
  const byId = new Map(listed.map((row) => [row.id, row]));

  const legacyRead = byId.get(legacy.id) as { taskStatus: string | null; taskNumber: number | null };
  assert.equal(legacyRead.taskStatus, "todo");
  assert.equal(legacyRead.taskNumber, 1);

  const nativeRead = byId.get(nativeHost.id) as {
    taskStatus: string | null;
    taskNumber: number | null;
    taskAssigneeId: string | null;
    taskAssigneeName: string | null;
  };
  assert.equal(nativeRead.taskStatus, "in_progress", "claiming the canonical task must show on its host message");
  assert.equal(nativeRead.taskNumber, native.taskNumber);
  assert.equal(nativeRead.taskAssigneeId, owner.id);
  assert.equal(nativeRead.taskAssigneeName, owner.name, "assignee handle must resolve, not leak an opaque id");
});

test("historical shapes in one channel: v0 orphan and v1.4 coexist, message-task is inert", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-three-shapes");

  // #1 task v0 — tasks row, NO host message (message_id IS NULL)
  const v0 = await seedV0OrphanTask(channel.id, owner.id, "v0 orphan task", 1);
  // #2 message-task — state on messages.task_*, no tasks row
  const messageTask = await seedLegacyMessageTask(channel.id, owner.id, "message task", 2);
  // #3 v1.4 — tasks row + plain host message
  const { tasks: [native], hostMessages: [nativeHost] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "v1.4 task" }],
  );

  // P3: the message-task (#2) is inert; the two canonical shapes still coexist
  // and neither hides the other. Note #2 is deliberately seeded BETWEEN them,
  // so a gap in the middle of the number sequence is part of the pin.
  const listed = await taskService.listTasks(channel.id);
  assert.equal(listed.length, 2, "each reachable shape must appear exactly once");
  assert.deepEqual(listed.map((task) => task.taskNumber), [1, 3]);
  assert.deepEqual(
    listed.map((task) => task.title),
    ["v0 orphan task", "v1.4 task"],
  );
  assert.deepEqual(listed.map((task) => task.id), [v0.id, native.id]);
  assert.ok(
    !listed.some((task) => task.id === messageTask.id),
    "the message-only shape must not surface",
  );

  // Only the v0 orphan is flagged legacy — it is the one with no thread to
  // open. Flagging the v1.4 task here would make every new task read-only.
  assert.deepEqual(listed.map((task) => task.isLegacy), [true, false]);

  // A task with no host message falls back to its own id, so callers always
  // have a non-null handle; the native one points at its real host message.
  assert.equal(listed[0].messageId, v0.id);
  assert.equal(listed[1].messageId, nativeHost.id);

  // Numbering is still allocated above BOTH tables, including the orphan and
  // the inert message-task — #3, not #2.
  assert.equal(native.taskNumber, 3);
});

test("v0 orphans survive alongside inert message-tasks — neither suppresses the other", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-null-antijoin");

  // Several orphans (all message_id NULL) alongside message-tasks.
  //
  // Honest note on strength: this is a behaviour pin, not a proven guard. The
  // suppression set is a JS `Set` and membership is tested with `has(row.id)`,
  // so a null/undefined entry simply never matches a real message id — it
  // cannot suppress anything. I mutated away BOTH null guards
  // (`isNotNull(tasks.messageId)` in the query and `.filter(Boolean)` on the
  // result) and this test still passed, so those two are redundant defence
  // rather than load-bearing. Kept because the *behaviour* — orphans and
  // message-tasks coexisting, neither hiding the other — is what callers rely
  // on, and a future rewrite to a SQL `NOT IN` would make null handling real.
  await seedV0OrphanTask(channel.id, owner.id, "orphan a", 1);
  await seedV0OrphanTask(channel.id, owner.id, "orphan b", 2);
  const msgA = await seedLegacyMessageTask(channel.id, owner.id, "message a", 3);
  const msgB = await seedLegacyMessageTask(channel.id, owner.id, "message b", 4);

  // P3: the message-tasks are inert, so only the orphans list. The property
  // under test survives the collapse and is the reason to keep this: the
  // orphans must still come back in full. An anti-join bug that over-suppressed
  // on NULL `messageId` would drop them, and that failure mode is unchanged.
  const listed = await taskService.listTasks(channel.id);
  assert.equal(listed.length, 2, "orphans must not be suppressed by anything");
  assert.deepEqual(listed.map((task) => task.title), ["orphan a", "orphan b"]);
  assert.deepEqual(listed.map((task) => task.isLegacy), [true, true]);
  assert.ok(
    !listed.some((task) => task.id === msgA.id || task.id === msgB.id),
    "message-only rows must not surface",
  );
});

test("every lookup route resolves a v0 orphan to its canonical row", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-v0-lookup");
  const v0 = await seedV0OrphanTask(channel.id, owner.id, "v0 lookup", 7, "in_progress");

  const byId = await taskService.resolveTaskById(v0.id);
  assert.equal(byId?.source, "tasks");
  assert.equal(byId?.row.id, v0.id);

  const byNumber = await taskService.resolveTaskByNumber(channel.id, 7);
  assert.equal(byNumber?.source, "tasks");
  assert.equal(byNumber?.row.id, v0.id);

  // There is no host message, so a by-message lookup must simply miss rather
  // than matching on the NULL.
  assert.equal(await taskService.resolveTaskByMessageId(v0.id), null);

  // Status filtering sees orphans like any other canonical row.
  const inProgress = await taskService.listTasks(channel.id, "in_progress");
  assert.deepEqual(inProgress.map((task) => task.id), [v0.id]);
  assert.deepEqual((await taskService.listTasks(channel.id, "todo")).map((t) => t.id), []);
});

test("mutations only ever write the canonical table — the message side is never touched", async ({ app }) => {
  const { owner, channel } = await setupChannel("mixed-route");
  const legacy = await seedLegacyMessageTask(channel.id, owner.id, "legacy claim target", 1);
  const { tasks: [native], hostMessages: [nativeHost] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "canonical claim target" }],
  );

  // P3: there is exactly one owning side now, so the routing question becomes
  // "does anything still reach the message side?" -- and nothing may.
  const legacyClaim = await taskService.claimTask(legacy.id, "user", owner.id);
  assert.equal(typeof legacyClaim, "string", "a message-only row is not claimable after P3");
  const nativeClaim = await taskService.claimTask(native.id, "user", owner.id);
  assert.equal(typeof nativeClaim === "string" ? nativeClaim : nativeClaim.source, "tasks");

  const db = getDb();
  // Unchanged and still load-bearing: a failed legacy claim must not mint a
  // canonical row. `batchClaimTasks` used to do exactly that via a fallback --
  // it was the last live writer of `messages.task_*` and it survived the
  // typecheck, so this stays asserted.
  const spawned = await db.select().from(tasks).where(eq(tasks.messageId, legacy.id));
  assert.deepEqual(spawned, [], "a legacy claim must not create a second representation");

  // ...and it must not have mutated the shadow either.
  const [shadow] = await db.select().from(messages).where(eq(messages.id, legacy.id));
  assert.equal(shadow.taskAssigneeId, null, "a rejected claim must not write the message side");
  assert.equal(shadow.taskClaimedAt, null);

  // Claiming a canonical task must not write back into its host message.
  const [host] = await db.select().from(messages).where(eq(messages.id, nativeHost.id));
  assert.equal(host.taskStatus, null, "host message must stay a plain message");
  assert.equal(host.taskAssigneeId, null);
  assert.equal(host.taskNumber, null);
});
