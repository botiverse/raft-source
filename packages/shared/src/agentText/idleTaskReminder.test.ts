// Idle task reminder (#wg-task-v2:#9): the notice text the Server builds and
// a Computer delivers as it is. Pins the line shape, the "why" wording, and
// that the optional sections appear only when they have something to say.
import assert from "node:assert/strict";

import {
  IDLE_TASK_REMINDER_ITEM_REASONS,
  IDLE_TASK_REMINDER_SKIP_REASONS,
  formatIdleTaskReminderDuration,
  formatIdleTaskReminderLine,
  formatIdleTaskReminderNotice,
  formatIdleTaskReminderWhy,
  idleTaskReminderNoticeHasRules,
} from "./idleTaskReminder";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("formatIdleTaskReminderWhy says why each task is listed", () => {
  assert.equal(formatIdleTaskReminderWhy({ reason: "new_session" }), "new session");
  assert.equal(formatIdleTaskReminderWhy({ reason: "newly_assigned", actorHandle: "stdrc" }), "newly yours (assigned by @stdrc)");
  assert.equal(formatIdleTaskReminderWhy({ reason: "newly_assigned" }), "newly yours");
  assert.equal(formatIdleTaskReminderWhy({ reason: "others_acted", actorHandle: "tenny", othersAction: "message" }), "@tenny replied");
  assert.equal(formatIdleTaskReminderWhy({ reason: "others_acted", actorHandle: "tenny", othersAction: "status" }), "@tenny changed its status");
  assert.equal(formatIdleTaskReminderWhy({ reason: "others_acted", actorHandle: "tenny", othersAction: "assignee" }), "@tenny changed its assignee");
  assert.equal(formatIdleTaskReminderWhy({ reason: "others_acted", actorHandle: "tenny", othersAction: "amend" }), "@tenny edited it");
  assert.equal(formatIdleTaskReminderWhy({ reason: "others_acted", othersAction: "message" }), "someone replied", "an unresolved sender is not @-mentioned");
  assert.equal(formatIdleTaskReminderWhy({ reason: "stale", untouchedMs: 2 * HOUR + 5 * MIN }), "untouched for 2h");
  assert.equal(formatIdleTaskReminderWhy({ reason: "stale" }), "untouched");
  assert.equal(formatIdleTaskReminderWhy({ reason: "stale", untouchedMs: 9 * HOUR, noAssignee: true }), "no assignee, you created it (untouched for 9h)");
});

test("the wire's reasons stay the closed set old Computers strict-parse: a task with no assignee is a why, not a reason", () => {
  assert.deepEqual([...IDLE_TASK_REMINDER_ITEM_REASONS], ["new_session", "newly_assigned", "others_acted", "stale"]);
  assert.deepEqual([...IDLE_TASK_REMINDER_SKIP_REASONS], ["disabled", "no_open_tasks", "no_change", "hourly_cap"]);
});

test("formatIdleTaskReminderDuration is coarse: minutes, hours up to two days, then days", () => {
  assert.equal(formatIdleTaskReminderDuration(0), "1m");
  assert.equal(formatIdleTaskReminderDuration(35 * MIN), "35m");
  assert.equal(formatIdleTaskReminderDuration(60 * MIN), "1h");
  assert.equal(formatIdleTaskReminderDuration(47 * HOUR + 59 * MIN), "47h");
  assert.equal(formatIdleTaskReminderDuration(72 * HOUR), "3d");
});

test("one line per task: ref, [status], title on one line, then why", () => {
  assert.equal(
    formatIdleTaskReminderLine({ ref: "#wg-task-v2:#9", status: "in_progress", title: "Idle nudge:\nshow open tasks", why: "untouched for 2h" }),
    "#wg-task-v2:#9 [in_progress] Idle nudge: show open tasks — untouched for 2h",
  );
});

test("the notice: items, the rules (a way out for each task), and no-change-no-reply; no backlog or background line when there is none", () => {
  const text = formatIdleTaskReminderNotice({
    items: [
      { ref: "#proj:#4", status: "todo", title: "Rollout checklist", why: "newly yours (assigned by @stdrc)" },
      { ref: "#wg-task-v2:#9", status: "in_progress", title: "Idle nudge", why: "untouched for 2h" },
    ],
  });
  assert.equal(text, [
    "[Raft task notice: 2 tasks are waiting on you.",
    "#proj:#4 [todo] Rollout checklist — newly yours (assigned by @stdrc)",
    "#wg-task-v2:#9 [in_progress] Idle nudge — untouched for 2h",
    "For each task:",
    "- A todo you can work on now: start it (set it in_progress with raft task update).",
    "- In progress and still yours to do: continue it.",
    "- Waiting on someone (a decision, their input, another task): assign it to them with what you need as the reason (raft task assign \"#channel:#N\" @who --reason \"what you need from them\"); they see it in their notification and in the task, so no separate message.",
    "- Better done by someone else: assign it to them with why as the reason.",
    "- Finished: set it done and send the result to whoever asked.",
    "- Won't be done: set it closed and say why in its conversation.",
    "No change → no reply needed.]",
  ].join("\n"));
  assert.doesNotMatch(text, /backlog|background/i);
});

test("the notice: one task, parked tasks, background tasks and the backlog rule when the status exists", () => {
  const text = formatIdleTaskReminderNotice({
    items: [{ ref: "dm:@stdrc:#3", status: "in_review", title: "Review retry design", why: "@stdrc replied" }],
    backlog: [{ ref: "#proj-ops:#12", title: "Migrate cron to reminders" }],
    backgroundTasks: 2,
    backlogActive: true,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "[Raft task notice: 1 task is waiting on you.");
  assert.equal(lines[1], "dm:@stdrc:#3 [in_review] Review retry design — @stdrc replied");
  assert.equal(lines[2], "Parked (backlog): optional. Pick one up if it can be done now and is worth doing:");
  assert.equal(lines[3], "#proj-ops:#12 Migrate cron to reminders");
  assert.equal(lines[4], "You have 2 background tasks running; a task they are moving forward needs nothing now.");
  assert.ok(lines.includes("- Not now: set it to backlog and say in its conversation what would bring it back."));
  assert.equal(lines.at(-1), "No change → no reply needed.]");

  const single = formatIdleTaskReminderNotice({ items: [{ ref: "#a:#1", status: "todo", title: "t", why: "new session" }], backgroundTasks: 1 });
  assert.match(single, /^You have 1 background task running;/m);
  assert.doesNotMatch(single, /Not now: set it to backlog/, "no backlog rule before the status exists");
});

const NO_ASSIGNEE_ITEM = { ref: "#proj:#7", status: "todo", title: "Split-off work", why: "no assignee, you created it (untouched for 8h)", noAssignee: true };

test("the notice for a task with no assignee: says so, gives its exits (claim, assign, close), and not the rules for a task someone holds", () => {
  const text = formatIdleTaskReminderNotice({ items: [NO_ASSIGNEE_ITEM] });
  assert.equal(text, [
    "[Raft task notice: 1 task is waiting on you.",
    "#proj:#7 [todo] Split-off work — no assignee, you created it (untouched for 8h)",
    "For a task with no assignee that you created, nobody is on it until you do one of these:",
    "- Yours to do: claim it (raft task claim).",
    "- For someone else: assign it to them with why as the reason (raft task assign \"#channel:#N\" @who --reason \"what you need from them\"); they see it in their notification, so no separate message.",
    "- Won't be done: set it closed (raft task update) and say why in its conversation.",
    "No change → no reply needed.]",
  ].join("\n"));
  assert.doesNotMatch(text, /backlog/i, "nothing here depends on the backlog status");
});

test("the notice with both kinds: the exits for no assignee first, then the usual rules for each other task", () => {
  const lines = formatIdleTaskReminderNotice({
    items: [{ ref: "#a:#1", status: "in_progress", title: "Mine", why: "untouched for 2h" }, NO_ASSIGNEE_ITEM],
  }).split("\n");
  const exits = lines.indexOf("For a task with no assignee that you created, nobody is on it until you do one of these:");
  const others = lines.indexOf("For each other task:");
  assert.ok(exits > 0 && others > exits, lines.join("\n"));
  assert.ok(lines.includes("- In progress and still yours to do: continue it."));
  assert.ok(!lines.includes("For each task:"));
});

test("the backlog exit appears for a task with no assignee only when the status exists", () => {
  const rule = "- Not now: set it to backlog and say in its conversation what would bring it back.";
  assert.ok(formatIdleTaskReminderNotice({ items: [NO_ASSIGNEE_ITEM], backlogActive: true }).split("\n").includes(rule));
  assert.ok(!formatIdleTaskReminderNotice({ items: [NO_ASSIGNEE_ITEM], backlogActive: false }).split("\n").includes(rule));
});

test("past the limit of a notice: one line says how many more, that they come later, and how to see them now", () => {
  const lines = formatIdleTaskReminderNotice({ items: [NO_ASSIGNEE_ITEM], moreNoAssignee: { count: 3, boards: ["#ops", "#proj"] } }).split("\n");
  assert.equal(lines[1], "#proj:#7 [todo] Split-off work — no assignee, you created it (untouched for 8h)");
  assert.equal(lines[2], "…and 3 more with no assignee that you created, in later notices. To see them now: raft task list --target <board> (#ops, #proj).");
  assert.doesNotMatch(formatIdleTaskReminderNotice({ items: [NO_ASSIGNEE_ITEM] }), /more with no assignee/);
});

test("#wg-ax:#32: rules: false leaves out the rules for held tasks and keeps the no-assignee block and the closing line", () => {
  const held = { ref: "#proj:#4", status: "todo", title: "Rollout", why: "newly yours" };
  const mine = { ref: "#proj:#7", status: "todo", title: "Split-off", why: "no assignee, you created it (untouched for 8h)", noAssignee: true };
  const without = formatIdleTaskReminderNotice({ items: [held], rules: false });
  assert.equal(without, "[Raft task notice: 1 task is waiting on you.\n#proj:#4 [todo] Rollout — newly yours\nNo change → no reply needed.]");
  assert.equal(idleTaskReminderNoticeHasRules({ items: [held], rules: false }), false);
  assert.equal(idleTaskReminderNoticeHasRules({ items: [held] }), true);
  assert.equal(idleTaskReminderNoticeHasRules({ items: [mine] }), false, "the no-assignee block alone is not the held-task rules");
  const mixed = formatIdleTaskReminderNotice({ items: [held, mine], rules: false });
  assert.match(mixed, /For a task with no assignee that you created/);
  assert.doesNotMatch(mixed, /For each (other )?task:/);
  assert.ok(formatIdleTaskReminderNotice({ items: [held] }).includes("For each task:"), "default keeps the rules");
});
