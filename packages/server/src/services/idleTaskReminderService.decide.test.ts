// Idle task reminder (#wg-task-v2:#9): the per-task decision, without a
// database. Change-based: a task is listed when it is newly the agent's, when
// someone else acted after the agent, or when it went untouched past a
// threshold (30m todo / in_review, 2h in_progress, then 8h, then daily); a
// recorded reminder is never repeated for the same news; a new session lists
// everything once; background tasks pause the "untouched" reminders only.
import assert from "node:assert/strict";

import {
  decideIdleTaskReminder,
  IDLE_TASK_REMINDER_UNASSIGNED_TODO_FIRST_STALE_MS,
  idleTaskStaleStep,
  isIdleTaskDue,
  type IdleTaskReminderFacts,
  type IdleTaskReminderRecord,
} from "./idleTaskReminderService";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date("2026-10-31T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A todo someone else (@stdrc) assigned to the agent at T0; the agent has not acted on it. */
function facts(overrides: Partial<IdleTaskReminderFacts> = {}): IdleTaskReminderFacts {
  return {
    status: "todo",
    taskCreatedAt: T0,
    myLastActionAt: null,
    assignment: { at: T0, bySelf: false, actorHandle: "stdrc" },
    othersLastAction: { at: T0, kind: "assignee", actorHandle: "stdrc" },
    ...overrides,
  };
}

function decide(f: IdleTaskReminderFacts, record: IdleTaskReminderRecord | null, nowMs: number, opts: { freshSession?: boolean; staleSuspended?: boolean } = {}) {
  return decideIdleTaskReminder(f, record, { now: at(nowMs), freshSession: opts.freshSession ?? false, staleSuspended: opts.staleSuspended ?? false });
}

test("idleTaskStaleStep: first threshold per status, then 8h, then one step a day", () => {
  assert.equal(idleTaskStaleStep("todo", 29 * MIN), 0);
  assert.equal(idleTaskStaleStep("todo", 30 * MIN), 1);
  assert.equal(idleTaskStaleStep("in_review", 30 * MIN), 1);
  assert.equal(idleTaskStaleStep("in_progress", 2 * HOUR - 1), 0);
  assert.equal(idleTaskStaleStep("in_progress", 2 * HOUR), 1);
  assert.equal(idleTaskStaleStep("in_progress", 8 * HOUR - 1), 1);
  assert.equal(idleTaskStaleStep("todo", 8 * HOUR), 2);
  assert.equal(idleTaskStaleStep("todo", DAY - 1), 2);
  assert.equal(idleTaskStaleStep("todo", DAY), 3);
  assert.equal(idleTaskStaleStep("todo", 2 * DAY), 4);
  assert.equal(idleTaskStaleStep("todo", 3 * DAY + HOUR), 5);
});

test("newly yours: assigned by someone else after the agent's last action; recorded, it is not listed again", () => {
  const first = decide(facts(), null, MIN);
  assert.equal(first?.reason, "newly_assigned");
  assert.deepEqual(first?.why, { reason: "newly_assigned", actorHandle: "stdrc" });
  assert.deepEqual(first?.record, { seenOthersActionAt: T0, staleSinceAt: T0, staleStep: 0 });

  assert.equal(decide(facts(), first!.record, 2 * MIN), null, "same news, already reminded: nothing");
  // Assigned to the agent before its last action: it knows already.
  assert.equal(decide(facts({ myLastActionAt: at(MIN) }), null, 2 * MIN), null);
});

test("the agent's own claim is not news; it goes stale from the claim", () => {
  const own = facts({
    myLastActionAt: T0,
    assignment: { at: T0, bySelf: true, actorHandle: "me" },
    othersLastAction: null,
  });
  assert.equal(decide(own, null, 29 * MIN), null);
  const stale = decide(own, null, 31 * MIN);
  assert.equal(stale?.reason, "stale");
  assert.deepEqual(stale?.why, { reason: "stale", untouchedMs: 31 * MIN });
  assert.deepEqual(stale?.record, { seenOthersActionAt: null, staleSinceAt: T0, staleStep: 1 });
});

test("untouched: each threshold is reminded once (30m, 8h, then daily); the agent's own action restarts the clock", () => {
  const own = facts({ myLastActionAt: T0, assignment: { at: T0, bySelf: true, actorHandle: null }, othersLastAction: null });
  const first = decide(own, null, 31 * MIN)!;
  assert.equal(decide(own, first.record, 2 * HOUR), null, "still the first threshold");
  const second = decide(own, first.record, 8 * HOUR)!;
  assert.equal(second.reason, "stale");
  assert.equal(second.record.staleStep, 2);
  assert.equal(decide(own, second.record, 20 * HOUR), null);
  const third = decide(own, second.record, DAY + MIN)!;
  assert.equal(third.record.staleStep, 3);
  assert.equal(decide(own, third.record, 2 * DAY - MIN), null);
  assert.equal(decide(own, third.record, 2 * DAY + MIN)?.record.staleStep, 4);

  // The agent acted at +1h: the clock restarts there.
  const acted = facts({ ...own, myLastActionAt: at(HOUR) });
  assert.equal(decide(acted, first.record, HOUR + 29 * MIN), null);
  const again = decide(acted, first.record, HOUR + 31 * MIN)!;
  assert.equal(again.reason, "stale");
  assert.deepEqual(again.record, { seenOthersActionAt: null, staleSinceAt: at(HOUR), staleStep: 1 });
});

test("in_progress goes stale after 2h, not 30m", () => {
  const working = facts({ status: "in_progress", myLastActionAt: T0, assignment: { at: T0, bySelf: true, actorHandle: null }, othersLastAction: null });
  assert.equal(decide(working, null, HOUR), null);
  assert.equal(decide(working, null, 2 * HOUR + MIN)?.reason, "stale");
});

test("someone else acted after the agent's last action; again only for a newer action", () => {
  const replied = facts({
    status: "in_progress",
    myLastActionAt: at(10 * MIN),
    othersLastAction: { at: at(20 * MIN), kind: "message", actorHandle: "tenny" },
  });
  const first = decide(replied, null, 21 * MIN)!;
  assert.equal(first.reason, "others_acted");
  assert.deepEqual(first.why, { reason: "others_acted", actorHandle: "tenny", othersAction: "message" });
  assert.deepEqual(first.record.seenOthersActionAt, at(20 * MIN));
  assert.equal(decide(replied, first.record, 22 * MIN), null);

  const newer = facts({ ...replied, othersLastAction: { at: at(30 * MIN), kind: "status", actorHandle: "eric" } });
  const second = decide(newer, first.record, 31 * MIN)!;
  assert.equal(second.reason, "others_acted");
  assert.deepEqual(second.why, { reason: "others_acted", actorHandle: "eric", othersAction: "status" });

  // The agent answered after it: nothing.
  assert.equal(decide(facts({ ...newer, myLastActionAt: at(40 * MIN) }), first.record, 41 * MIN), null);
});

test("reassigned back to the agent after it acted: newly yours again", () => {
  const back = facts({
    myLastActionAt: at(HOUR),
    assignment: { at: at(2 * HOUR), bySelf: false, actorHandle: "tenny" },
    othersLastAction: { at: at(2 * HOUR), kind: "assignee", actorHandle: "tenny" },
  });
  const earlier: IdleTaskReminderRecord = { seenOthersActionAt: T0, staleSinceAt: T0, staleStep: 1 };
  const decided = decide(back, earlier, 2 * HOUR + MIN)!;
  assert.equal(decided.reason, "newly_assigned");
  assert.deepEqual(decided.why, { reason: "newly_assigned", actorHandle: "tenny" });
  assert.deepEqual(decided.record.staleSinceAt, at(2 * HOUR), "the untouched clock starts at the new assignment");
  assert.equal(decided.record.staleStep, 0);
});

test("a new session lists the task once whatever was reminded; afterwards back to change-based", () => {
  const quiet = facts({ myLastActionAt: at(HOUR), othersLastAction: { at: T0, kind: "assignee", actorHandle: "stdrc" } });
  assert.equal(decide(quiet, null, HOUR + MIN), null, "nothing new without a new session");
  const fresh = decide(quiet, null, HOUR + MIN, { freshSession: true })!;
  assert.equal(fresh.reason, "new_session");
  assert.deepEqual(fresh.why, { reason: "new_session" });
  assert.equal(decide(quiet, fresh.record, HOUR + 2 * MIN), null);
  // A threshold already passed when the session started is not reminded again.
  const late = decide(quiet, null, HOUR + 40 * MIN, { freshSession: true })!;
  assert.equal(late.record.staleStep, 1);
  assert.equal(decide(quiet, late.record, HOUR + 41 * MIN), null);
});

test("background tasks pause the untouched reminders, not the news; the paused threshold comes afterwards", () => {
  const own = facts({ myLastActionAt: T0, assignment: { at: T0, bySelf: true, actorHandle: null }, othersLastAction: null });
  assert.equal(decide(own, null, 31 * MIN, { staleSuspended: true }), null);

  const replied = facts({ ...own, othersLastAction: { at: at(40 * MIN), kind: "message", actorHandle: "tenny" } });
  const news = decide(replied, null, 41 * MIN, { staleSuspended: true })!;
  assert.equal(news.reason, "others_acted");
  assert.equal(news.record.staleStep, 0, "the threshold it crossed while paused is still owed");

  const after = decide(replied, news.record, 42 * MIN)!;
  assert.equal(after.reason, "stale");
  assert.equal(after.record.staleStep, 1);
  assert.equal(decide(replied, after.record, 43 * MIN), null);
});

test("a pre-v2 task the agent left in in_review waits the usual 30m", () => {
  const reviewing = facts({
    status: "in_review",
    myLastActionAt: at(HOUR),
    assignment: { at: T0, bySelf: true, actorHandle: null },
    othersLastAction: null,
  });
  assert.equal(decide(reviewing, null, HOUR + 2 * MIN), null);
  assert.equal(decide(reviewing, null, HOUR + 31 * MIN)?.reason, "stale");
});

test("a task the in_review retirement moved is not reminded as untouched; news still is", () => {
  const moved = facts({ status: "in_progress", myLastActionAt: at(-DAY), othersLastAction: null, assignment: { at: at(-2 * DAY), bySelf: true, actorHandle: null }, retiredInReview: true });
  assert.equal(decide(moved, null, 3 * HOUR), null, "untouched for a day, but moved by the retirement: nothing");
  assert.equal(decide({ ...moved, retiredInReview: false }, null, 3 * HOUR)?.reason, "stale", "without the retirement it is stale");
  const replied = { ...moved, othersLastAction: { at: at(2 * HOUR), kind: "message" as const, actorHandle: "stdrc" } };
  assert.equal(decide(replied, null, 3 * HOUR)?.reason, "others_acted");
  assert.equal(decide(moved, null, 3 * HOUR, { freshSession: true })?.reason, "new_session");
});

/** A todo this agent created at T0 that nobody holds; it has not acted on it since. */
function unassigned(overrides: Partial<IdleTaskReminderFacts> = {}): IdleTaskReminderFacts {
  return {
    status: "todo",
    taskCreatedAt: T0,
    myLastActionAt: T0,
    assignment: null,
    othersLastAction: null,
    unassigned: { since: null },
    ...overrides,
  };
}

test("no assignee: the first threshold is 8h for a todo, 2h for in_progress, then the same 8h and daily", () => {
  assert.equal(IDLE_TASK_REMINDER_UNASSIGNED_TODO_FIRST_STALE_MS, 8 * HOUR);
  assert.equal(idleTaskStaleStep("todo", 8 * HOUR - 1, true), 0);
  assert.equal(idleTaskStaleStep("todo", 8 * HOUR, true), 2, "the first threshold and the 8h one are the same reminder");
  assert.equal(idleTaskStaleStep("todo", DAY - 1, true), 2);
  assert.equal(idleTaskStaleStep("todo", DAY, true), 3);
  assert.equal(idleTaskStaleStep("todo", 2 * DAY, true), 4);
  assert.equal(idleTaskStaleStep("in_progress", 2 * HOUR - 1, true), 0);
  assert.equal(idleTaskStaleStep("in_progress", 2 * HOUR, true), 1);
  assert.equal(idleTaskStaleStep("in_progress", 8 * HOUR, true), 2);
  // An assigned todo keeps its 30m.
  assert.equal(idleTaskStaleStep("todo", 30 * MIN), 1);
});

test("no assignee, todo: reminded at 8h, a day and two days, once each; nothing before 8h", () => {
  const todo = unassigned();
  assert.equal(decide(todo, null, 8 * HOUR - 1), null);
  const first = decide(todo, null, 8 * HOUR)!;
  assert.equal(first.reason, "stale");
  assert.deepEqual(first.why, { reason: "stale", untouchedMs: 8 * HOUR, noAssignee: true });
  assert.deepEqual(first.record, { seenOthersActionAt: null, staleSinceAt: T0, staleStep: 2 });
  assert.equal(decide(todo, first.record, 8 * HOUR + MIN), null, "no second reminder for the 8h threshold");
  assert.equal(decide(todo, first.record, DAY - 1), null);
  const second = decide(todo, first.record, DAY)!;
  assert.equal(second.record.staleStep, 3);
  assert.equal(decide(todo, second.record, 2 * DAY - 1), null);
  assert.equal(decide(todo, second.record, 2 * DAY)?.record.staleStep, 4);
});

test("no assignee, in_progress: reminded at 2h, 8h, a day", () => {
  const working = unassigned({ status: "in_progress" });
  assert.equal(decide(working, null, 2 * HOUR - 1), null);
  const first = decide(working, null, 2 * HOUR)!;
  assert.equal(first.reason, "stale");
  assert.equal(first.record.staleStep, 1);
  assert.equal(decide(working, first.record, 8 * HOUR - 1), null);
  const second = decide(working, first.record, 8 * HOUR)!;
  assert.equal(second.record.staleStep, 2);
  assert.equal(decide(working, second.record, DAY)?.record.staleStep, 3);
});

test("no assignee: the creator's own action restarts the clock, and the thresholds with it", () => {
  const first = decide(unassigned(), null, 9 * HOUR)!;
  const acted = unassigned({ myLastActionAt: at(10 * HOUR) });
  assert.equal(decide(acted, first.record, 18 * HOUR - 1), null);
  const again = decide(acted, first.record, 18 * HOUR)!;
  assert.equal(again.reason, "stale");
  assert.deepEqual(again.record, { seenOthersActionAt: null, staleSinceAt: at(10 * HOUR), staleStep: 2 });
});

test("no assignee: released after days, its clock starts at the release, not the creator's old action", () => {
  const released = unassigned({ unassigned: { since: at(5 * DAY) } });
  assert.equal(decide(released, null, 5 * DAY + HOUR), null);
  assert.equal(isIdleTaskDue(released, at(5 * DAY + HOUR)), false);
  const stale = decide(released, null, 5 * DAY + 8 * HOUR)!;
  assert.deepEqual(stale.why, { reason: "stale", untouchedMs: 8 * HOUR, noAssignee: true });
  assert.deepEqual(stale.record.staleSinceAt, at(5 * DAY));
});

test("no assignee: someone else's action is no reminder by itself, does not restart the clock, and is not recorded as seen", () => {
  const replied = unassigned({ othersLastAction: { at: at(HOUR), kind: "message", actorHandle: "tenny" } });
  assert.equal(decide(replied, null, 2 * HOUR), null);
  const stale = decide(replied, null, 8 * HOUR)!;
  assert.equal(stale.reason, "stale");
  assert.deepEqual(stale.record.staleSinceAt, T0);
  assert.equal(stale.record.seenOthersActionAt, null);
  assert.equal(decide(unassigned({ othersLastAction: { at: at(9 * HOUR), kind: "status", actorHandle: "eric" } }), stale.record, 10 * HOUR), null);
});

test("no assignee, new session: never listed for being one; a threshold it has not been reminded of still comes, and the record survives the session", () => {
  const todo = unassigned();
  assert.equal(decide(todo, null, HOUR, { freshSession: true }), null);
  // Never reminded and past 8h: the threshold is what lists it, in any session.
  const first = decide(todo, null, 9 * HOUR, { freshSession: true })!;
  assert.equal(first.reason, "stale");
  assert.deepEqual(first.why, { reason: "stale", untouchedMs: 9 * HOUR, noAssignee: true });
  assert.equal(first.record.staleStep, 2);
  // A later new session: the record is per agent and task, so nothing until the next threshold.
  assert.equal(decide(todo, first.record, 10 * HOUR, { freshSession: true }), null);
  assert.equal(decide(todo, first.record, DAY - 1, { freshSession: true }), null);
  assert.equal(decide(todo, first.record, DAY, { freshSession: true })?.reason, "stale");
});

test("no assignee: background tasks pause the reminder; the threshold still comes afterwards", () => {
  const todo = unassigned();
  assert.equal(decide(todo, null, 9 * HOUR, { staleSuspended: true }), null);
  assert.equal(decide(todo, null, 9 * HOUR)?.reason, "stale");
});

test("no assignee: a task the in_review retirement moved is not due, even for a new session; its next real status change ends that", () => {
  const moved = unassigned({ status: "in_progress", retiredInReview: true });
  assert.equal(isIdleTaskDue(moved, at(3 * DAY)), false);
  assert.equal(decide(moved, null, 3 * DAY), null);
  assert.equal(decide(moved, null, 3 * DAY, { freshSession: true }), null);
  assert.equal(decide({ ...moved, retiredInReview: false }, null, 3 * DAY)?.reason, "stale");
});

test("no assignee: due only from the first threshold on; a task assigned to the agent always counts", () => {
  assert.equal(isIdleTaskDue(unassigned(), at(8 * HOUR - 1)), false);
  assert.equal(isIdleTaskDue(unassigned(), at(8 * HOUR)), true);
  assert.equal(isIdleTaskDue(unassigned({ status: "in_progress" }), at(2 * HOUR)), true);
  assert.equal(isIdleTaskDue(facts(), at(0)), true);
});

test("the same record row works across the two paths: claiming, then being released, each starts a new clock", () => {
  const remindedUnassigned = decide(unassigned(), null, 9 * HOUR)!;
  const claimed = facts({ myLastActionAt: at(10 * HOUR), assignment: { at: at(10 * HOUR), bySelf: true, actorHandle: null }, othersLastAction: null });
  assert.equal(decide(claimed, remindedUnassigned.record, 10 * HOUR + 29 * MIN), null);
  const remindedClaimed = decide(claimed, remindedUnassigned.record, 10 * HOUR + 30 * MIN)!;
  assert.deepEqual(remindedClaimed.record, { seenOthersActionAt: null, staleSinceAt: at(10 * HOUR), staleStep: 1 });

  const released = unassigned({ myLastActionAt: at(10 * HOUR), unassigned: { since: at(11 * HOUR) } });
  assert.equal(decide(released, remindedClaimed.record, 11 * HOUR + MIN), null);
  assert.deepEqual(decide(released, remindedClaimed.record, 19 * HOUR)?.record.staleSinceAt, at(11 * HOUR));
});
