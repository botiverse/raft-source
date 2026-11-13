// #wg-ax:#19: the View Context parser reads what the shared formatters write.
// A format change the parser does not follow fails here, in the same PR.
// (The daemon's own envelopes, inbox notice and message headers, are covered
// in packages/daemon/src/agentRuntimeInput.deliveryParse.test.ts.)
import assert from "node:assert/strict";
import { formatIdleTaskReminderNotice, type IdleTaskReminderNoticeInput } from "./idleTaskReminder";
import { parseRaftDelivery } from "./raftDeliveryParse";

const ITEMS: IdleTaskReminderNoticeInput["items"] = [
  { ref: "#wg-task-v2:#9", status: "in_progress", title: "Idle nudge [draft", why: "untouched for 2h" },
  { ref: "dm:@stdrc:#4", status: "todo", title: "Rollout — checklist", why: "newly yours (assigned by @stdrc)" },
  { ref: "#proj:#7", status: "todo", title: "Split-off work", why: "no assignee, you created it (untouched for 8h)", noAssignee: true },
];

function taskSegment(text: string) {
  const delivery = parseRaftDelivery(text);
  assert.ok(delivery, "parsed as a Raft delivery");
  const tasks = delivery.segments.filter((segment) => segment.kind === "task");
  assert.equal(tasks.length, 1, "one task notice");
  assert.equal(delivery.segments.some((segment) => segment.kind === "generic"), false, "never a generic fallback");
  return tasks[0] as Extract<(typeof delivery.segments)[number], { kind: "task" }>;
}

const variants: Array<[string, IdleTaskReminderNoticeInput]> = [
  ["plain", { items: ITEMS.slice(0, 2) }],
  ["one task", { items: ITEMS.slice(0, 1) }],
  ["with a no-assignee task", { items: ITEMS }],
  ["with more no-assignee tasks", { items: ITEMS, moreNoAssignee: { count: 3, boards: ["#proj", "dm:@peer"] } }],
  ["with backlog", { items: ITEMS.slice(0, 2), backlog: [{ ref: "#proj:#11", title: "Someday" }], backlogActive: true }],
  ["with background tasks", { items: ITEMS.slice(0, 2), backgroundTasks: 2 }],
];

for (const [name, input] of variants) {
  test(`idle task notice (${name}) parses back to the tasks it lists`, () => {
    const segment = taskSegment(formatIdleTaskReminderNotice(input));
    assert.equal(segment.count, input.items.length);
    assert.deepEqual(
      segment.tasks.map((task) => [task.ref, task.status]),
      input.items.map((item) => [item.ref, item.status]),
    );
    for (const [index, task] of segment.tasks.entries()) assert.match(task.title, new RegExp(input.items[index]!.title.slice(0, 6).replace(/[[\]]/gu, "\\$&")));
  });
}
