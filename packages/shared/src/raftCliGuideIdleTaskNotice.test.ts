// Idle task reminder (#wg-task-v2:#9): the standing prompt says what a
// `[Raft task notice: …]` is, on both task flag states; the notice it names
// is the one the Server builds.
import assert from "node:assert/strict";

import { formatIdleTaskReminderNotice } from "./agentText/idleTaskReminder";
import { buildRaftCliGuideMarkdown, buildRaftCliGuideSections } from "./raftCliGuide";

const RULE = "A `[Raft task notice: …]` lists tasks waiting on you: assigned to you, or with no assignee when you created them. Handle each as its line says. If none needs a change, no reply is needed.";

test("the managed-runner Tasks section ends with the task notice rule, with and without task conversations", () => {
  const identity = { handle: "a", displayName: "A" };
  for (const taskConversations of [false, true]) {
    const { tasks } = buildRaftCliGuideSections({ audience: "managed-runner", identity, taskConversations });
    assert.ok(tasks.endsWith(`\n\n${RULE}`), `taskConversations=${taskConversations}`);
  }
  assert.doesNotMatch(buildRaftCliGuideMarkdown(), /Raft task notice/, "the generated manual does not carry it");
});

test("the rule names the notice the Server sends", () => {
  const notice = formatIdleTaskReminderNotice({ items: [{ ref: "#a:#1", status: "todo", title: "t", why: "new session" }] });
  assert.ok(notice.startsWith("[Raft task notice: "));
  assert.ok(notice.endsWith("]"));
});
