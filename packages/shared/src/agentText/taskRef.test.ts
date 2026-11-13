// Task v2: the agent-facing task ref (`#channel:#7`, `dm:@peer:#7`) — how
// task conversation messages are addressed, the refusal text for message
// commands, and the Tasks guide on flag-on servers (flag off: unchanged).
import assert from "node:assert/strict";

import { formatInboxMessageTarget } from "../agentInboxProjection";
import { formatAgentMessageLine, formatAgentMessageTarget, formatAgentSourceTasksSuffix } from "../agentMessageText";
import { buildRaftCliGuideMarkdown, buildRaftCliGuideSections } from "../raftCliGuide";
import { formatRaftChannelTaskRef } from "../raftRefs";
import { formatAgentTaskRef, formatTaskTargetUseTaskCommand, parseAgentTaskRef } from "./taskRef";
import { formatAgentClaimResults, formatAgentTasksCreated, formatAgentTaskStatusUpdated, formatAgentTaskView } from "./tasks";

test("formatAgentTaskRef / parseAgentTaskRef: channel and DM boards round-trip through raftRefs", () => {
  assert.equal(formatAgentTaskRef("#proj", 7), formatRaftChannelTaskRef("proj", 7));
  assert.equal(formatAgentTaskRef("#proj", 7), "#proj:#7");
  assert.equal(formatAgentTaskRef("dm:@cody", 3), "dm:@cody:#3");
  assert.equal(formatAgentTaskRef("dm:user:cody", 3), "dm:@cody:#3");
  assert.equal(formatAgentTaskRef("dm:@cody~agent", 3), "dm:@cody~agent:#3");
  assert.equal(formatAgentTaskRef("#proj:abcd1234", 7), null, "a thread is not a task board");
  assert.equal(formatAgentTaskRef("@cody", 7), null);

  assert.deepEqual(parseAgentTaskRef("#proj:#7"), { ref: "#proj:#7", target: "#proj", taskNumber: 7 });
  assert.deepEqual(parseAgentTaskRef(" dm:@cody:#3 "), { ref: "dm:@cody:#3", target: "dm:@cody", taskNumber: 3 });
  assert.equal(parseAgentTaskRef("task #7"), null, "the legacy form names no conversation");
  assert.equal(parseAgentTaskRef("#proj"), null);
  assert.equal(parseAgentTaskRef("#proj:abcd1234"), null);
  assert.equal(parseAgentTaskRef("#proj:#0"), null);
});

test("formatTaskTargetUseTaskCommand names the exact task command", () => {
  const send = formatTaskTargetUseTaskCommand({ ref: "#proj:#7", action: "send" });
  assert.match(send, /^#proj:#7 is a task conversation, not a message target\. Nothing was sent\./);
  assert.match(send, /\n  raft task reply "#proj:#7" <<'RAFTMSG'\n  reply body\n  RAFTMSG$/);
  const read = formatTaskTargetUseTaskCommand({ ref: "dm:@cody:#3", action: "read" });
  assert.match(read, /\n  raft task read "dm:@cody:#3"$/);
});

const TASK_CONVERSATION_MESSAGE = {
  channel_type: "thread",
  channel_name: "task-77777777",
  parent_channel_type: "channel",
  parent_channel_name: "proj",
  task_conversation_number: 7,
  message_id: "abcd1234-0000-0000-0000-000000000000",
  timestamp: "2026-10-20T01:02:03.000Z",
  sender_type: "agent",
  sender_name: "cody",
  content: "draft is in the PR",
};

test("a task conversation message is addressed by its ref everywhere (line, target, inbox row)", () => {
  assert.equal(formatAgentMessageTarget(TASK_CONVERSATION_MESSAGE), "#proj:#7");
  assert.equal(formatInboxMessageTarget(TASK_CONVERSATION_MESSAGE), "#proj:#7");
  assert.equal(formatAgentMessageTarget({ ...TASK_CONVERSATION_MESSAGE, parent_channel_type: "dm", parent_channel_name: "richard" }), "dm:@richard:#7");
  assert.match(formatAgentMessageLine(TASK_CONVERSATION_MESSAGE), /^\[target=#proj:#7 msg=abcd1234 .*\] @cody: draft is in the PR \[task conversation — reply: raft task reply "#proj:#7"\]$/);
  assert.doesNotMatch(formatAgentMessageLine(TASK_CONVERSATION_MESSAGE, "cli", { omitTaskReplyHint: true }), /task conversation —/);
  // Without the number (flag off, older servers) a thread is a thread.
  const { task_conversation_number: _number, ...thread } = TASK_CONVERSATION_MESSAGE;
  assert.equal(formatAgentMessageTarget({ ...thread, channel_name: "thread-abcd1234" }), "#proj:abcd1234");
});

test("source tasks: listed by ref in a channel or DM, by number elsewhere", () => {
  const tasks = [{ number: 2, status: "in_progress", assignee_id: "a-1", assignee_name: "cody" }, { number: 4, status: "todo" }];
  assert.equal(formatAgentSourceTasksSuffix(tasks, "#proj"), " [tasks #proj:#2 in_progress @cody, #proj:#4 todo]");
  assert.equal(formatAgentSourceTasksSuffix(tasks, "dm:@rc"), " [tasks dm:@rc:#2 in_progress @cody, dm:@rc:#4 todo]");
  assert.equal(formatAgentSourceTasksSuffix(tasks), " [tasks #2 in_progress @cody, #4 todo]");
});

test("task view: the ref names the task, a pre-v2 task without its conversation says the first reply starts it", () => {
  const text = formatAgentTaskView({
    taskRef: "#proj:#2",
    task: { taskNumber: 2, status: "todo", title: "old one", createdByName: "rc", createdByHandle: "rc", description: "keep it short" },
    following: false,
    conversation: { exists: false, replyCount: 0 },
    earlierDiscussion: { target: "#proj:host1234", replyCount: 4 },
    recentMessages: [],
    hasOlder: false,
  });
  assert.match(text, /^## Task #proj:#2 \[todo\]$/m);
  assert.match(text, /^Earlier discussion \(before task conversations\): #proj:host1234 — 4 replies; read it with raft message read --target "#proj:host1234"$/m);
  assert.match(text, /^Following: no — replies do not wake you unless you are @mentioned$/m);
  assert.match(text, /^Discussion: none yet — the first reply starts the task's conversation\.$/m);
  assert.match(text, /^  follow: raft task follow "#proj:#2"$/m);
  // No recorded source (a pre-v2 task posted as its own message): said, as on the web.
  assert.match(text, /^Source: \(not recorded\)$/m);
});

test("task create: a thread reply given as the source names the thread's root message once", () => {
  const root = "root5678-0000-4000-8000-000000000000";
  const text = formatAgentTasksCreated("#proj", {
    tasks: [1, 2].map((taskNumber) => ({
      taskNumber,
      messageId: `#${taskNumber}`,
      title: `part ${taskNumber}`,
      status: "todo",
      claimedByType: null,
      claimedById: null,
      claimedAt: null,
      conversationAnchored: true,
      sourceMessageId: root,
      sourceThreadReplyId: "reply123-0000-4000-8000-000000000000",
    })),
  });
  const notes = text.split("\n").filter((line) => line.startsWith("Source: "));
  assert.deepEqual(notes, ["Source: the thread's root message msg=root5678 (you gave a reply in its thread, msg=reply123)."]);
});

test("raftCliGuide: task conversations are taught only on flag-on servers", () => {
  const identity = { handle: "a", displayName: "A" };
  const off = buildRaftCliGuideSections({ audience: "managed-runner", identity });
  const on = buildRaftCliGuideSections({ audience: "managed-runner", identity, taskConversations: true });
  assert.doesNotMatch(off.tasks + off.communication + off.formattingMentionsChannels, /raft task reply|#channel:#7/);
  assert.match(off.communication, /`raft task convert`, `raft task delete`\./);
  assert.match(on.communication, /`raft task view`, `raft task reply`, `raft task read`, `raft task follow`, `raft task unfollow`/);
  assert.doesNotMatch(on.communication, /raft task convert/);
  assert.match(on.tasks, /Reply with `raft task reply "#channel:#7" <<'RAFTMSG'`/);
  assert.match(on.tasks, /`raft message send` and `raft message read` refuse task refs\./);
  assert.match(on.formattingMentionsChannels, /- #engineering:#7 — links to task 7 of #engineering/);
  const manual = buildRaftCliGuideMarkdown();
  assert.doesNotMatch(manual, /raft task reply/, "the generated manual is the flag-off guide");
  assert.match(buildRaftCliGuideMarkdown(undefined, { taskConversations: true }), /raft task reply "#channel:#7"/);
});

test("task view: a source behind the plan's history window reads as Raft's note, not as the sender's words; so does an empty discussion", () => {
  const byId = "This message is older than the 30-day history on the Free plan. Upgrading to Pro restores the full history.";
  const note = "Older messages are hidden: this server is on the Free plan, which keeps the last 30 days. Upgrading to Pro restores the full history.";
  const text = formatAgentTaskView({
    taskRef: "#proj:#3",
    task: { taskNumber: 3, status: "todo", title: "last quarter's plan", createdByName: "rc", createdByHandle: "rc" },
    following: true,
    conversation: { exists: true, replyCount: 5 },
    sourceMessage: { id: "abcd1234-0000-0000-0000-000000000000", target: "#proj", senderName: "richard", content: "", createdAt: "2026-08-01T09:00:00.000Z", historyLimitMessage: byId },
    recentMessages: [],
    hasOlder: false,
    historyLimited: true,
    historyLimitMessage: note,
  });
  assert.ok(text.includes(`Source: msg=abcd1234 in #proj — a message from @richard at 2026-08-01 09:00:00Z. ${byId}`), text);
  assert.doesNotMatch(text, /@richard: This message/);
  assert.ok(text.includes(`Discussion: nothing in the history window. ${note}`));
});

// Where to answer the person who asked (#wg-task-v2:98488173): a tool-mode
// caller gets the pointer in prose, never a command it cannot run; several
// tasks from one message share one source-thread target.
test("task v2 report-back hints: tool style names task view in prose; one source thread target per message", () => {
  const claimed = formatAgentClaimResults("#general", { results: [{ taskNumber: 7, success: true, taskRef: "#general:#7" }] }, "tool");
  assert.match(claimed, /Answer the person who asked where they spoke \(.*\); viewing the task shows who created it and its source\.$/);
  // The new line only: the pre-existing reply line's tool-mode fallback is not this change's.
  assert.doesNotMatch(claimed.split("\n\n").at(-1)!, /actions_prepare/);
  const moved = formatAgentTaskStatusUpdated(7, "in_review", "#general:#7", "tool");
  assert.match(moved, /viewing the task shows who created it and its source\.$/);
  assert.doesNotMatch(moved, /actions_prepare/);

  const task = (n: number) => ({
    taskNumber: n,
    messageId: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-0000-0000-000000000000`,
    title: `t${n}`,
    status: "in_progress",
    claimedByType: "agent" as const,
    claimedById: "agent-1",
    claimedByName: "cody",
    claimedAt: "2026-10-26T08:00:00.000Z",
    conversationAnchored: true,
    sourceMessageId: "src67890-0000-0000-0000-000000000000",
  });
  const created = formatAgentTasksCreated("#general", { tasks: [task(7), task(8)] });
  assert.match(created, /\n#general:#7, #general:#8 → raft message send --target "#general:src67890"/);
  assert.equal(created.match(/raft message send/g)?.length, 1);
});

test("formatAgentTaskStatusUpdated: a task v2 task asked for in_review was stored in_progress, and the receipt says so", () => {
  // in_review is not used for task v2 tasks (#wg-task-v2:f7043517): the
  // server stores in_progress and names it; the receipt reports what was stored.
  const retired = formatAgentTaskStatusUpdated(7, "in_progress", "#general:#7", "cli", "in_review");
  assert.equal(
    retired,
    "#general:#7 moved to in_progress.\nin_review is not used for task v2 tasks; it is in_progress instead, assignee unchanged.",
  );
  assert.doesNotMatch(retired, /Assign it to whoever should accept it/, "no in_review hand-off advice for a status it is not in");

  // A pre-v2 task stored the in_review it asked for: the receipt is as before.
  const stored = formatAgentTaskStatusUpdated(7, "in_review", null, "cli", "in_review");
  assert.equal(stored, "#7 moved to in_review.");
  assert.match(formatAgentTaskStatusUpdated(7, "done", "#general:#7", "cli", "done"), /^#general:#7 moved to done\.\n\nNot sent the result yet\? /);
});
