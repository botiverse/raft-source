// Idle task reminder (#wg-task-v2:#9) against a database: facts read from
// task_events, the task rows and the task conversation's messages; what is
// listed is recorded in agent_task_nudges so the same news is never listed
// twice; at most three reminders an hour; the server's task v2 flag gates it
// all.
//
// Times: each task's events and messages are written at explicit times
// relative to a fixed `now` passed to the service, so the order of actions is
// exact (wall-clock writes in one millisecond would tie).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, agentTaskNudges, agentTaskNudgeSends, channelAgents, channels, messages, tasks, taskEvents } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { createAgent } from "./agentService";
import { addAgent, getOrCreateThread } from "./channelService";
import { computeIdleTaskReminder, IDLE_TASK_REMINDER_HOURLY_CAP, IDLE_TASK_REMINDER_MAX_UNASSIGNED_PER_NOTICE } from "./idleTaskReminderService";
import { TASK_V2_RETIRED_IN_REVIEW_REASON } from "./taskV2Mode";
import { createMessage } from "./messageService";
import { ensureTaskConversation } from "./taskConversationService";
import * as taskService from "./taskService";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The service's clock in these tests; every fact is written before it. */
const NOW = new Date(Date.now() + 10 * 24 * HOUR);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Actor = { type: "user" | "agent"; id: string };

async function fixture(seed: ReturnType<typeof createSeed>, opts: { flag?: boolean } = {}) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, `idle-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const peer = await createAgent(server.id, `peer-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  await addAgent(channel.id, agent.id);
  await addAgent(channel.id, peer.id);
  // The reminder shares the task v2 flag.
  if (opts.flag !== false) await enableTaskV2ConversationsForServer(server.id);
  const ownerActor: Actor = { type: "user", id: owner.id };
  const agentActor: Actor = { type: "agent", id: agent.id };
  const peerActor: Actor = { type: "agent", id: peer.id };
  return { owner, server, channel, agent, peer, ownerActor, agentActor, peerActor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function recordEvent(taskId: string, eventType: typeof taskEvents.$inferInsert.eventType, actor: Actor, createdAt: Date, payload: Record<string, unknown> = {}) {
  await getDb().insert(taskEvents).values({ taskId, eventType, actorType: actor.type, actorId: actor.id, payload, createdAt });
}

/**
 * A task assigned to the agent: created by the owner, assigned by `assignedBy`
 * at `assignedAt`, in `status`. Its event history is exactly what is written
 * here (the create path's own events are replaced).
 */
async function openTask(fx: Fixture, opts: { title?: string; status?: "backlog" | "todo" | "in_progress" | "in_review" | "done"; assignedBy: Actor; assignedAt: Date; assignee?: Actor; sourceMessageId?: string }) {
  const { tasks: [created] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{
    title: opts.title ?? `task ${randomUUID().slice(0, 6)}`,
    ...(opts.sourceMessageId ? { sourceMessageId: opts.sourceMessageId } : {}),
  }]);
  const assignee = opts.assignee ?? fx.agentActor;
  await getDb().update(tasks).set({
    status: opts.status ?? "todo",
    claimedByType: assignee.type,
    claimedById: assignee.id,
    createdAt: opts.assignedAt,
    updatedAt: opts.assignedAt,
  }).where(eq(tasks.id, created!.id));
  await getDb().delete(taskEvents).where(eq(taskEvents.taskId, created!.id));
  await recordEvent(created!.id, "created", fx.ownerActor, opts.assignedAt, { taskNumber: created!.taskNumber, status: "todo" });
  await recordEvent(created!.id, "assignee_changed", opts.assignedBy, opts.assignedAt, { assigneeType: assignee.type, assigneeId: assignee.id });
  return created!;
}

/** A message in the task's own conversation at `createdAt`. */
async function say(taskId: string, sender: Actor, createdAt: Date, content = "update") {
  const ensured = await ensureTaskConversation(taskId);
  assert.ok(ensured, "the task has a conversation");
  const message = await createMessage(ensured.conversation.canonicalChannelId, sender.type, sender.id, content);
  await getDb().update(messages).set({ createdAt }).where(eq(messages.id, message.id));
}

/** A message in the thread of `parentMessageId` (a task's source message) at `createdAt`. */
async function sayInThread(parentMessageId: string, sender: Actor, createdAt: Date, content = "on it") {
  const thread = await getOrCreateThread(parentMessageId, sender.id, sender.type);
  const message = await createMessage(thread.id, sender.type, sender.id, content);
  await getDb().update(messages).set({ createdAt }).where(eq(messages.id, message.id));
}

function remind(fx: Fixture, opts: { freshSession?: boolean; backgroundTasks?: number; now?: Date } = {}) {
  return computeIdleTaskReminder({ serverId: fx.server.id, agentId: fx.agent.id, now: opts.now ?? NOW, freshSession: opts.freshSession, backgroundTasks: opts.backgroundTasks });
}

async function nudgeRows(agentId: string) {
  return getDb().select().from(agentTaskNudges).where(eq(agentTaskNudges.agentId, agentId));
}

test("flag off: send false, reason disabled, nothing recorded", async ({ seed }) => {
  const fx = await fixture(seed, { flag: false });
  await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(HOUR) });
  assert.deepEqual(await remind(fx), { send: false, reason: "disabled", items: [], backlog: [], text: "" });
  assert.deepEqual(await nudgeRows(fx.agent.id), []);
});

test("no open task assigned to the agent: no_open_tasks (others' and finished tasks are not listed)", async ({ seed }) => {
  const fx = await fixture(seed);
  await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(HOUR), assignee: fx.peerActor });
  await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(HOUR), status: "done" });
  const result = await remind(fx);
  assert.equal(result.send, false);
  assert.equal(result.reason, "no_open_tasks");
});

test("newly yours: listed with who assigned it and the notice; recorded, a second idle sends nothing", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { title: "Rollout checklist", assignedBy: fx.ownerActor, assignedAt: ago(10 * MIN) });

  const first = await remind(fx);
  assert.equal(first.send, true, JSON.stringify(first));
  assert.equal(first.reason, undefined);
  assert.equal(first.items.length, 1);
  const [item] = first.items;
  assert.equal(item!.ref, `#${fx.channel.name}:#${task.taskNumber}`);
  assert.equal(item!.channel, `#${fx.channel.name}`);
  assert.equal(item!.taskNumber, task.taskNumber);
  assert.equal(item!.status, "todo");
  assert.equal(item!.reason, "newly_assigned");
  assert.equal(item!.why, `newly yours (assigned by @${fx.owner.name})`);
  assert.deepEqual(first.backlog, []);
  assert.match(first.text, /^\[Raft task notice: 1 task is waiting on you\.\n/);
  assert.ok(first.text.includes(`#${fx.channel.name}:#${task.taskNumber} [todo] Rollout checklist — newly yours (assigned by @${fx.owner.name})`));
  assert.ok(first.text.endsWith("No change → no reply needed.]"));
  assert.doesNotMatch(first.text, /background/);

  const [row] = await nudgeRows(fx.agent.id);
  assert.equal(row?.taskId, task.id);
  assert.equal(row?.lastReason, "newly_assigned");
  assert.deepEqual(row?.lastNudgedAt, NOW);

  const second = await remind(fx, { now: new Date(NOW.getTime() + MIN) });
  assert.deepEqual(second, { send: false, reason: "no_change", items: [], backlog: [], text: "" });
});

test("someone replied after the agent's last message: listed; the agent's reply quiets it; another agent's action lists it again", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { status: "in_progress", assignedBy: fx.agentActor, assignedAt: ago(HOUR) });
  await say(task.id, fx.agentActor, ago(50 * MIN), "started");
  assert.equal((await remind(fx)).reason, "no_change", "the agent's own claim and message are not news");

  await say(task.id, fx.ownerActor, ago(40 * MIN), "what is the status?");
  const replied = await remind(fx);
  assert.equal(replied.send, true);
  assert.equal(replied.items[0]!.reason, "others_acted");
  assert.equal(replied.items[0]!.why, `@${fx.owner.name} replied`);

  await say(task.id, fx.agentActor, ago(30 * MIN), "halfway");
  assert.equal((await remind(fx)).reason, "no_change");

  await recordEvent(task.id, "status_changed", fx.peerActor, ago(20 * MIN), { from: "in_progress", to: "in_review" });
  await getDb().update(tasks).set({ status: "in_review" }).where(eq(tasks.id, task.id));
  const peerActed = await remind(fx);
  assert.equal(peerActed.send, true);
  assert.equal(peerActed.items[0]!.reason, "others_acted");
  assert.equal(peerActed.items[0]!.status, "in_review");
  assert.equal(peerActed.items[0]!.why, `@${fx.peer.name} changed its status`);
});

test("untouched: paused while background tasks run, then listed once with how long", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { title: "Long job", status: "in_progress", assignedBy: fx.agentActor, assignedAt: ago(5 * HOUR) });
  await recordEvent(task.id, "status_changed", fx.agentActor, ago(3 * HOUR), { from: "todo", to: "in_progress" });

  assert.equal((await remind(fx, { backgroundTasks: 2 })).reason, "no_change", "stale reminders pause while background tasks run");
  assert.deepEqual(await nudgeRows(fx.agent.id), [], "nothing recorded while paused");

  const stale = await remind(fx);
  assert.equal(stale.send, true);
  assert.equal(stale.items[0]!.reason, "stale");
  assert.equal(stale.items[0]!.why, "untouched for 3h");
  assert.equal((await remind(fx)).reason, "no_change", "one reminder per threshold");
  const [row] = await nudgeRows(fx.agent.id);
  assert.equal(row?.staleStep, 1);
  assert.deepEqual(row?.staleSinceAt, ago(3 * HOUR));
});

test("background tasks: news is still listed, and the notice says how many are running", async ({ seed }) => {
  const fx = await fixture(seed);
  await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(5 * MIN) });
  const result = await remind(fx, { backgroundTasks: 2 });
  assert.equal(result.send, true);
  assert.ok(result.text.includes("You have 2 background tasks running; a task they are moving forward needs nothing now."));
});

test("new session: every open task listed once as new session; then back to change-based", async ({ seed }) => {
  const fx = await fixture(seed);
  const quiet = await openTask(fx, { status: "in_progress", assignedBy: fx.agentActor, assignedAt: ago(10 * MIN) });
  const review = await openTask(fx, { status: "in_review", assignedBy: fx.agentActor, assignedAt: ago(5 * MIN) });
  await openTask(fx, { status: "done", assignedBy: fx.agentActor, assignedAt: ago(5 * MIN) });
  assert.equal((await remind(fx)).reason, "no_change");

  const fresh = await remind(fx, { freshSession: true });
  assert.equal(fresh.send, true);
  assert.deepEqual(fresh.items.map((item) => [item.taskNumber, item.reason, item.why]).sort(), [
    [quiet.taskNumber, "new_session", "new session"],
    [review.taskNumber, "new_session", "new session"],
  ].sort());
  assert.equal((await remind(fx)).reason, "no_change");
});

test("at most three reminders an hour; a capped idle records nothing and the next hour sends", async ({ seed }) => {
  const fx = await fixture(seed);
  // in_progress: none of them goes untouched (2h) within the test's hour.
  for (let i = 0; i < IDLE_TASK_REMINDER_HOURLY_CAP; i += 1) {
    await openTask(fx, { status: "in_progress", assignedBy: fx.ownerActor, assignedAt: ago((10 - i) * MIN) });
    const sent = await remind(fx, { now: new Date(NOW.getTime() + i * MIN) });
    assert.equal(sent.send, true, `reminder ${i + 1}`);
    assert.equal(sent.items.length, 1, "only the new task");
  }
  const fourth = await openTask(fx, { status: "in_progress", assignedBy: fx.ownerActor, assignedAt: ago(MIN) });
  const capped = await remind(fx, { now: new Date(NOW.getTime() + 5 * MIN) });
  assert.deepEqual(capped, { send: false, reason: "hourly_cap", items: [], backlog: [], text: "" });
  const [fourthRow] = await getDb().select().from(agentTaskNudges).where(and(eq(agentTaskNudges.agentId, fx.agent.id), eq(agentTaskNudges.taskId, fourth.id)));
  assert.equal(fourthRow, undefined, "the capped reminder is not recorded");

  const later = await remind(fx, { now: new Date(NOW.getTime() + HOUR + 3 * MIN) });
  assert.equal(later.send, true);
  assert.deepEqual(later.items.map((item) => item.taskNumber), [fourth.taskNumber]);
  const sends = await getDb().select().from(agentTaskNudgeSends).where(eq(agentTaskNudgeSends.agentId, fx.agent.id));
  assert.equal(sends.length, 1, "sends older than the hour are pruned");
});

test("a deleted task's reminder record goes with it", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(MIN) });
  assert.equal((await remind(fx)).send, true);
  assert.equal((await nudgeRows(fx.agent.id)).length, 1);
  const owner = await taskService.resolveTaskById(task.id);
  assert.ok(owner);
  await taskService.deleteTaskByOwner(owner);
  assert.deepEqual(await nudgeRows(fx.agent.id), []);
});

test("the agent's reply in the source message's thread is its action: not newly yours after it; others' replies there are not news", async ({ seed }) => {
  const fx = await fixture(seed);
  const source = await createMessage(fx.channel.id, "user", fx.owner.id, "please look at the rollout");
  const task = await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(10 * MIN), sourceMessageId: source.id });
  const [row] = await getDb().select({ sourceMessageId: tasks.sourceMessageId }).from(tasks).where(eq(tasks.id, task.id));
  assert.equal(row?.sourceMessageId, source.id);

  await sayInThread(source.id, fx.agentActor, ago(5 * MIN), "on it");
  await sayInThread(source.id, fx.ownerActor, ago(2 * MIN), "thanks");
  assert.deepEqual(await remind(fx), { send: false, reason: "no_change", items: [], backlog: [], text: "" });

  // Without that reply it is newly the agent's.
  const other = await createMessage(fx.channel.id, "user", fx.owner.id, "and this one");
  await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(10 * MIN), sourceMessageId: other.id });
  const listed = await remind(fx);
  assert.equal(listed.items.length, 1, JSON.stringify(listed));
  assert.equal(listed.items[0]!.reason, "newly_assigned");
});

test("in_review retirement: a task moved by the system event is not untouched-reminded until its next real status change", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { status: "in_progress", assignedBy: fx.agentActor, assignedAt: ago(24 * HOUR) });
  await recordEvent(task.id, "status_changed", fx.agentActor, ago(24 * HOUR - MIN), { from: "in_progress", to: "in_review" });
  await getDb().insert(taskEvents).values({ taskId: task.id, eventType: "status_changed", actorType: "system", actorId: null, payload: { from: "in_review", to: "in_progress", reason: TASK_V2_RETIRED_IN_REVIEW_REASON }, createdAt: ago(3 * HOUR) });
  assert.equal((await remind(fx)).reason, "no_change");

  await recordEvent(task.id, "status_changed", fx.ownerActor, ago(2 * HOUR), { from: "in_progress", to: "todo" });
  await recordEvent(task.id, "status_changed", fx.ownerActor, ago(2 * HOUR - MIN), { from: "todo", to: "in_progress" });
  const after = await remind(fx);
  assert.equal(after.send, true, JSON.stringify(after));
  assert.equal(after.items[0]!.reason, "others_acted", "a real status change after the retirement counts again");
});

// ---------------------------------------------------------------------------
// A task with no assignee, chased with the agent that created it.
// ---------------------------------------------------------------------------

/**
 * A task v2 task nobody holds, created by `creator` (the agent by default) at
 * `createdAt`. Its event history is the `created` event only.
 */
async function unassignedTask(fx: Fixture, opts: { title?: string; status?: "todo" | "in_progress" | "in_review" | "backlog" | "done" | "closed"; createdAt: Date; creator?: Actor; sourceMessageId?: string; channelId?: string; legacy?: boolean }) {
  const creator = opts.creator ?? fx.agentActor;
  const { tasks: [created] } = await taskService.createTasks(opts.channelId ?? fx.channel.id, creator.type, creator.id, [{
    title: opts.title ?? `task ${randomUUID().slice(0, 6)}`,
    ...(opts.sourceMessageId ? { sourceMessageId: opts.sourceMessageId } : {}),
  }]);
  await getDb().update(tasks).set({
    status: opts.status ?? "todo",
    ownConversation: !opts.legacy,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  }).where(eq(tasks.id, created!.id));
  await getDb().delete(taskEvents).where(eq(taskEvents.taskId, created!.id));
  await recordEvent(created!.id, "created", creator, opts.createdAt, { taskNumber: created!.taskNumber, status: "todo" });
  return created!;
}

test("no assignee: a fresh todo sends nothing, new session or not, and is not an open task", async ({ seed }) => {
  const fx = await fixture(seed);
  await unassignedTask(fx, { createdAt: ago(7 * HOUR) });
  assert.deepEqual(await remind(fx), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
  assert.deepEqual(await remind(fx, { freshSession: true }), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
  assert.deepEqual(await nudgeRows(fx.agent.id), []);
});

test("no assignee: a todo past 8h is listed once with who and why, on the known reason; recorded in the usual row", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await unassignedTask(fx, { title: "Split-off work", createdAt: ago(9 * HOUR) });

  const first = await remind(fx);
  assert.equal(first.send, true, JSON.stringify(first));
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.reason, "stale");
  assert.equal(first.items[0]!.why, "no assignee, you created it (untouched for 9h)");
  assert.ok(first.text.includes(`#${fx.channel.name}:#${task.taskNumber} [todo] Split-off work — no assignee, you created it (untouched for 9h)`));
  assert.match(first.text, /^- Yours to do: claim it \(raft task claim\)\.$/m);
  assert.match(first.text, /^- For someone else: assign it to them with why as the reason \(raft task assign "#channel:#N" @who --reason /m);
  assert.match(first.text, /^- Won't be done: set it closed/m);
  assert.match(first.text, /^- Not now: set it to backlog and say in its conversation what would bring it back\.$/m);

  const [row] = await nudgeRows(fx.agent.id);
  assert.equal(row?.taskId, task.id);
  assert.equal(row?.lastReason, "stale");
  assert.equal(row?.staleStep, 2);
  assert.deepEqual(row?.staleSinceAt, ago(9 * HOUR));

  assert.deepEqual(await remind(fx, { now: new Date(NOW.getTime() + MIN) }), { send: false, reason: "no_change", items: [], backlog: [], text: "" });
  const nextDay = await remind(fx, { now: new Date(NOW.getTime() + 15 * HOUR + MIN) });
  assert.equal(nextDay.send, true, "the next threshold is a day from the clock's start");
  assert.equal(nextDay.items[0]!.why, "no assignee, you created it (untouched for 24h)");
});

test("no assignee: in_progress goes at 2h; in_review (a legacy status), parked and finished tasks are left out", async ({ seed }) => {
  const fx = await fixture(seed);
  await unassignedTask(fx, { status: "in_progress", createdAt: ago(HOUR) });
  assert.equal((await remind(fx)).reason, "no_open_tasks");
  const due = await unassignedTask(fx, { status: "in_progress", createdAt: ago(3 * HOUR) });
  await unassignedTask(fx, { status: "in_review", createdAt: ago(3 * 24 * HOUR) });
  await unassignedTask(fx, { status: "backlog", createdAt: ago(3 * 24 * HOUR) });
  await unassignedTask(fx, { status: "done", createdAt: ago(3 * 24 * HOUR) });
  await unassignedTask(fx, { status: "closed", createdAt: ago(3 * 24 * HOUR) });
  const listed = await remind(fx);
  assert.deepEqual(listed.items.map((item) => item.taskNumber), [due.taskNumber]);
  assert.equal(listed.items[0]!.why, "no assignee, you created it (untouched for 3h)");
});

test("no assignee: only the creator, and only an agent creator: a person's tasks and another agent's are not chased", async ({ seed }) => {
  const fx = await fixture(seed);
  await unassignedTask(fx, { creator: fx.ownerActor, createdAt: ago(3 * 24 * HOUR) });
  await unassignedTask(fx, { creator: fx.peerActor, createdAt: ago(3 * 24 * HOUR) });
  assert.equal((await remind(fx)).reason, "no_open_tasks");
});

test("no assignee: claimed by anyone, or assigned to a person, it leaves this path at once", async ({ seed }) => {
  const fx = await fixture(seed);
  const peerClaims = await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  const toHuman = await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  assert.equal((await remind(fx)).items.length, 2);

  assert.equal(typeof await taskService.claimTask(peerClaims.id, "agent", fx.peer.id), "object");
  assert.equal(typeof await taskService.assignTask(toHuman.id, { type: "user", id: fx.owner.id }, "agent", fx.agent.id), "object");
  assert.deepEqual(await remind(fx, { now: new Date(NOW.getTime() + 3 * 24 * HOUR) }), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
});

test("no assignee: not on another server, nor a pre-v2 task", async ({ seed }) => {
  const fx = await fixture(seed);
  const otherServer = await seed.server({ owner: fx.owner });
  const otherChannel = await seed.channel({ server: otherServer, members: [fx.owner] });
  await unassignedTask(fx, { channelId: otherChannel.id, createdAt: ago(3 * 24 * HOUR) });
  await unassignedTask(fx, { legacy: true, createdAt: ago(3 * 24 * HOUR) });
  assert.equal((await remind(fx)).reason, "no_open_tasks");
});

test("no assignee: not where it has no exit: an archived channel, or one the agent has left", async ({ seed }) => {
  const fx = await fixture(seed);
  const archived = await seed.channel({ server: fx.server, members: [fx.owner] });
  await addAgent(archived.id, fx.agent.id);
  await unassignedTask(fx, { channelId: archived.id, createdAt: ago(3 * 24 * HOUR) });
  await getDb().update(channels).set({ archivedAt: ago(HOUR) }).where(eq(channels.id, archived.id));
  const left = await seed.channel({ server: fx.server, members: [fx.owner] });
  await addAgent(left.id, fx.agent.id);
  await unassignedTask(fx, { channelId: left.id, createdAt: ago(3 * 24 * HOUR) });
  await getDb().delete(channelAgents).where(and(eq(channelAgents.channelId, left.id), eq(channelAgents.agentId, fx.agent.id)));
  assert.equal((await remind(fx)).reason, "no_open_tasks");
});

test("no assignee: a stopped or a deleted creator gets nothing", async ({ seed }) => {
  const stopped = await fixture(seed);
  await unassignedTask(stopped, { createdAt: ago(3 * 24 * HOUR) });
  await getDb().update(agents).set({ status: "stopped" }).where(eq(agents.id, stopped.agent.id));
  assert.equal((await remind(stopped)).reason, "no_open_tasks");

  const deleted = await fixture(seed);
  await unassignedTask(deleted, { createdAt: ago(3 * 24 * HOUR) });
  await getDb().update(agents).set({ deletedAt: ago(HOUR) }).where(eq(agents.id, deleted.agent.id));
  assert.equal((await remind(deleted)).reason, "no_open_tasks");
});

test("no assignee: the creator's own action resets the clock, though it does not hold the task: an event, its conversation, its source thread", async ({ seed }) => {
  const fx = await fixture(seed);
  const amended = await unassignedTask(fx, { createdAt: ago(3 * 24 * HOUR) });
  await recordEvent(amended.id, "amended", fx.agentActor, ago(HOUR));
  const replied = await unassignedTask(fx, { createdAt: ago(3 * 24 * HOUR) });
  await say(replied.id, fx.agentActor, ago(HOUR));
  const source = await createMessage(fx.channel.id, "user", fx.owner.id, "please split this up");
  await unassignedTask(fx, { createdAt: ago(3 * 24 * HOUR), sourceMessageId: source.id });
  await sayInThread(source.id, fx.agentActor, ago(HOUR));
  assert.equal((await remind(fx)).reason, "no_open_tasks", "all three acted on an hour ago");

  const later = await remind(fx, { now: new Date(NOW.getTime() + 7 * HOUR) });
  assert.equal(later.send, true, JSON.stringify(later));
  assert.equal(later.items.length, 3);
  for (const item of later.items) assert.equal(item.why, "no assignee, you created it (untouched for 8h)");
});

test("no assignee: someone else replying is no reminder by itself and does not reset the clock", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await unassignedTask(fx, { createdAt: ago(7 * HOUR) });
  await say(task.id, fx.peerActor, ago(MIN), "I may take this");
  assert.equal((await remind(fx)).reason, "no_open_tasks");
  const due = await remind(fx, { now: new Date(NOW.getTime() + HOUR) });
  assert.equal(due.items[0]!.reason, "stale");
  assert.equal(due.items[0]!.why, "no assignee, you created it (untouched for 8h)");
});

test("no assignee: released by someone after days, its clock starts at the release", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await unassignedTask(fx, { createdAt: ago(5 * 24 * HOUR) });
  await recordEvent(task.id, "assignee_changed", fx.peerActor, ago(2 * 24 * HOUR), { assigneeType: "agent", assigneeId: fx.peer.id });
  await recordEvent(task.id, "assignee_changed", fx.peerActor, ago(HOUR), { assigneeType: null, assigneeId: null, previousAssigneeType: "agent", previousAssigneeId: fx.peer.id });
  assert.equal((await remind(fx)).reason, "no_open_tasks");
  const due = await remind(fx, { now: new Date(NOW.getTime() + 7 * HOUR) });
  assert.equal(due.items[0]!.why, "no assignee, you created it (untouched for 8h)");
});

test("no assignee: a new session lists every assigned task, not a task with no assignee for being one; only an unreminded threshold lists it", async ({ seed }) => {
  const fx = await fixture(seed);
  const assigned = await openTask(fx, { status: "in_progress", assignedBy: fx.agentActor, assignedAt: ago(10 * MIN) });
  const old = await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  await unassignedTask(fx, { createdAt: ago(HOUR) });

  const fresh = await remind(fx, { freshSession: true });
  assert.equal(fresh.send, true, JSON.stringify(fresh));
  const byNumber = new Map(fresh.items.map((item) => [item.taskNumber, item]));
  assert.equal(fresh.items.length, 2);
  assert.equal(byNumber.get(assigned.taskNumber)?.reason, "new_session");
  assert.equal(byNumber.get(old.taskNumber)?.reason, "stale", "its 8h threshold, not the session");
  assert.equal(byNumber.get(old.taskNumber)?.why, "no assignee, you created it (untouched for 9h)");
  assert.ok(fresh.text.includes("For each other task:"));
  assert.equal((await remind(fx)).reason, "no_change", "the threshold it crossed is not reminded again");

  // Another new session: the record is per agent and task, so only the assigned task again.
  const again = await remind(fx, { freshSession: true, now: new Date(NOW.getTime() + MIN) });
  assert.deepEqual(again.items.map((item) => item.taskNumber), [assigned.taskNumber]);
});

test("no assignee: a new session with only reminded ones sends nothing and settles (no_open_tasks); the next threshold still comes", async ({ seed }) => {
  const fx = await fixture(seed);
  await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  assert.equal((await remind(fx)).send, true);
  assert.deepEqual(await remind(fx, { freshSession: true, now: new Date(NOW.getTime() + MIN) }), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
  const nextDay = await remind(fx, { freshSession: true, now: new Date(NOW.getTime() + 15 * HOUR + MIN) });
  assert.equal(nextDay.items[0]!.reason, "stale");
});

test("no assignee: at most 10 in a notice, longest untouched first, the rest counted with their boards; a later idle lists them, under the hourly cap", async ({ seed }) => {
  const fx = await fixture(seed);
  const created = [];
  // 20h down to 9h old: none crosses the next threshold (a day) within the test.
  for (let i = 0; i < 12; i += 1) created.push(await unassignedTask(fx, { createdAt: ago((20 - i) * HOUR) }));

  const first = await remind(fx);
  assert.equal(first.items.length, IDLE_TASK_REMINDER_MAX_UNASSIGNED_PER_NOTICE);
  assert.deepEqual(first.items.map((item) => item.taskNumber).sort((a, b) => a - b), created.slice(0, 10).map((task) => task.taskNumber).sort((a, b) => a - b));
  assert.ok(first.text.includes(`…and 2 more with no assignee that you created, in later notices. To see them now: raft task list --target <board> (#${fx.channel.name}).`), first.text);
  assert.ok(first.text.startsWith("[Raft task notice: 10 tasks are waiting on you.\n"));
  assert.equal((await nudgeRows(fx.agent.id)).length, 10, "only what was listed is recorded");

  // The hourly cap holds the rest back, and records nothing.
  await getDb().insert(agentTaskNudgeSends).values(Array.from({ length: IDLE_TASK_REMINDER_HOURLY_CAP }, () => ({ agentId: fx.agent.id, sentAt: ago(MIN), itemCount: 1 })));
  assert.equal((await remind(fx)).reason, "hourly_cap");
  assert.equal((await nudgeRows(fx.agent.id)).length, 10);

  const second = await remind(fx, { now: new Date(NOW.getTime() + HOUR) });
  assert.deepEqual(second.items.map((item) => item.taskNumber).sort((a, b) => a - b), created.slice(10).map((task) => task.taskNumber).sort((a, b) => a - b));
  assert.doesNotMatch(second.text, /more with no assignee/);
  assert.equal((await nudgeRows(fx.agent.id)).length, 12);
  assert.equal((await remind(fx, { now: new Date(NOW.getTime() + HOUR + MIN) })).reason, "no_change");
});

test("no assignee: the limit does not hold back assigned tasks", async ({ seed }) => {
  const fx = await fixture(seed);
  const assigned = await openTask(fx, { assignedBy: fx.ownerActor, assignedAt: ago(MIN) });
  for (let i = 0; i < 11; i += 1) await unassignedTask(fx, { createdAt: ago((20 + i) * HOUR) });
  const notice = await remind(fx);
  assert.equal(notice.items.length, 11);
  assert.ok(notice.items.some((item) => item.taskNumber === assigned.taskNumber && item.reason === "newly_assigned"));
  assert.ok(notice.text.includes("…and 1 more with no assignee"));
});

test("no assignee: past its threshold and already reminded, it still counts as open outside a new session: no_change, not no_open_tasks", async ({ seed }) => {
  const fx = await fixture(seed);
  await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  assert.equal((await remind(fx)).send, true);
  assert.equal((await remind(fx)).reason, "no_change");
});

test("no assignee: the in_review retirement's system event exempts it, even for a new session", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await unassignedTask(fx, { status: "in_progress", createdAt: ago(3 * 24 * HOUR) });
  await getDb().insert(taskEvents).values({ taskId: task.id, eventType: "status_changed", actorType: "system", actorId: null, payload: { from: "in_review", to: "in_progress", reason: TASK_V2_RETIRED_IN_REVIEW_REASON }, createdAt: ago(3 * HOUR) });
  assert.equal((await remind(fx)).reason, "no_open_tasks");
  assert.equal((await remind(fx, { freshSession: true })).reason, "no_open_tasks");
});

test("no assignee: the hourly cap holds and a capped idle records nothing; background tasks pause it", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await unassignedTask(fx, { createdAt: ago(9 * HOUR) });
  assert.equal((await remind(fx, { backgroundTasks: 1 })).reason, "no_change", "paused while background tasks run");
  await getDb().insert(agentTaskNudgeSends).values(Array.from({ length: IDLE_TASK_REMINDER_HOURLY_CAP }, () => ({ agentId: fx.agent.id, sentAt: ago(MIN), itemCount: 1 })));
  assert.equal((await remind(fx)).reason, "hourly_cap");
  assert.deepEqual((await nudgeRows(fx.agent.id)).filter((row) => row.taskId === task.id), []);
});

test("listUnassignedTasksCreatedByAgent: per-status cutoff, most recently updated first, the limit, and no assignee", async ({ seed }) => {
  const fx = await fixture(seed);
  const older = await unassignedTask(fx, { createdAt: ago(10 * HOUR) });
  const newer = await unassignedTask(fx, { status: "in_progress", createdAt: ago(3 * HOUR) });
  await unassignedTask(fx, { createdAt: ago(3 * HOUR) });
  const held = await unassignedTask(fx, { createdAt: ago(10 * HOUR) });
  await getDb().update(tasks).set({ claimedByType: "agent", claimedById: fx.peer.id }).where(eq(tasks.id, held.id));
  const createdByStatus = { todo: ago(8 * HOUR), in_progress: ago(2 * HOUR) };

  const rows = await taskService.listUnassignedTasksCreatedByAgent([fx.channel.id], fx.agent.id, { createdByStatus, limit: 50 });
  assert.deepEqual(rows.map((row) => row.id), [newer.id, older.id]);
  assert.equal(rows[0]!.channelId, fx.channel.id);
  assert.equal(rows[0]!.createdAt, ago(3 * HOUR).toISOString());
  const limited = await taskService.listUnassignedTasksCreatedByAgent([fx.channel.id], fx.agent.id, { createdByStatus, limit: 1 });
  assert.deepEqual(limited.map((row) => row.id), [newer.id]);
});

test("backlog: parked tasks alone are never a reason to send, whatever happened on them", async ({ seed }) => {
  const fx = await fixture(seed);
  // Long untouched, newly assigned by someone else, and replied to: each would list a todo.
  const parked = await openTask(fx, { title: "Parked", status: "backlog", assignedBy: fx.ownerActor, assignedAt: ago(3 * 24 * HOUR) });
  await say(parked.id, fx.ownerActor, ago(MIN));

  assert.deepEqual(await remind(fx), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
  assert.deepEqual(await remind(fx, { freshSession: true }), { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });
  assert.deepEqual(await nudgeRows(fx.agent.id), [], "nothing recorded for a parked task");
});

test("backlog: listed compactly on a reminder sent for another task, not counted, and the rules say how to park", async ({ seed }) => {
  const fx = await fixture(seed);
  const parked = await openTask(fx, { title: "Parked", status: "backlog", assignedBy: fx.ownerActor, assignedAt: ago(3 * 24 * HOUR) });
  const open = await openTask(fx, { title: "Open", assignedBy: fx.ownerActor, assignedAt: ago(10 * MIN) });
  await openTask(fx, { title: "Someone else's", status: "backlog", assignedBy: fx.ownerActor, assignedAt: ago(HOUR), assignee: fx.peerActor });

  const result = await remind(fx);
  assert.equal(result.send, true, JSON.stringify(result));
  assert.deepEqual(result.items.map((item) => item.taskNumber), [open.taskNumber]);
  assert.deepEqual(result.backlog, [{ ref: `#${fx.channel.name}:#${parked.taskNumber}`, taskNumber: parked.taskNumber, channel: `#${fx.channel.name}`, title: "Parked" }]);
  assert.match(result.text, /^\[Raft task notice: 1 task is waiting on you\.\n/);
  assert.ok(result.text.includes(`Parked (backlog): optional. Pick one up if it can be done now and is worth doing:\n#${fx.channel.name}:#${parked.taskNumber} Parked`));
  assert.ok(result.text.includes("- Not now: set it to backlog and say in its conversation what would bring it back."));
  assert.deepEqual((await nudgeRows(fx.agent.id)).map((row) => row.taskId), [open.id], "only the listed open task is recorded");
});

test("backlog: a task moved out of backlog by someone else is news again", async ({ seed }) => {
  const fx = await fixture(seed);
  const task = await openTask(fx, { title: "Back", status: "backlog", assignedBy: fx.agentActor, assignedAt: ago(3 * 24 * HOUR) });
  await getDb().update(tasks).set({ status: "todo" }).where(eq(tasks.id, task.id));
  await recordEvent(task.id, "status_changed", fx.ownerActor, ago(MIN), { from: "backlog", to: "todo", forced: false });

  const result = await remind(fx);
  assert.equal(result.send, true, JSON.stringify(result));
  assert.equal(result.items[0]?.reason, "others_acted");
  assert.equal(result.items[0]?.why, `@${fx.owner.name} changed its status`);
});
