// Snapshot-style tests for agent-facing task output format.
// Pins the exact text shape of the AX contract.

import assert from "node:assert/strict";

import { formatMyTaskList, formatTaskList, formatTasksCreated, formatClaimResults, formatTaskUnclaimed, formatTaskStatusUpdated, formatTaskAssigned, formatTaskDeleted } from "./_format";

test("formatTaskList: empty with no filter", () => {
  assert.equal(formatTaskList("#engineering", { tasks: [] }), "No tasks in #engineering.");
});

test("formatTaskList: empty with status filter", () => {
  assert.equal(
    formatTaskList("#engineering", { tasks: [] }, "todo"),
    "No todo tasks in #engineering.",
  );
});

test("formatTaskList: single task with assignee and creator", () => {
  const out = formatTaskList("#proj-slock", {
    tasks: [
      {
        taskNumber: 1,
        status: "in_progress",
        title: "implement CLI transport",
        claimedById: "agent-1",
        claimedByName: "akko",
        createdByName: "xxchan",
        createdByHandle: "xxchan",
        messageId: "abcd1234efgh5678",
      },
    ],
  });
  assert.equal(
    out,
    [
      "## Task Board for #proj-slock (1 tasks)",
      "",
      "#1 [in_progress] → @akko (by @xxchan) msg=abcd1234 Current title: implement CLI transport",
    ].join("\n"),
  );
});

test("formatTaskList: departed creator is distinct while an active creator stays unchanged", () => {
  const out = formatTaskList("#proj-release", {
    tasks: [
      {
        taskNumber: 1,
        status: "todo",
        title: "live creator",
        createdByName: "alice",
        createdByHandle: "alice",
        createdByMembershipStatus: "active",
        messageId: "1111111100000000",
      },
      {
        taskNumber: 2,
        status: "todo",
        title: "historical creator",
        createdByName: "departed_alice",
        createdByHandle: "departed_alice",
        createdByMembershipStatus: "removed",
        messageId: "2222222200000000",
      },
    ],
  });

  const lines = out.split("\n");
  assert.equal(lines[2], "#1 [todo] (by @alice) msg=11111111 Current title: live creator");
  assert.equal(lines[3], "#2 [todo] (by @departed_alice [departed]) msg=22222222 Current title: historical creator");
});

test("formatMyTaskList: departed creator state remains visible in the cross-channel view", () => {
  const out = formatMyTaskList({
    tasks: [{
      taskNumber: 2,
      status: "in_review",
      title: "historical creator",
      channelRef: "#proj-release",
      createdByName: "departed_alice",
      createdByHandle: "departed_alice",
      createdByMembershipStatus: "left",
      messageId: "2222222200000000",
    }],
  });

  assert.match(
    out,
    /#proj-release task #2 \[in_review\] by=@departed_alice creator=departed msg=22222222 Current title: historical creator/,
  );
});

test("formatTaskList: resource receipt state is visible", () => {
  const pending = formatTaskList("#ops", {
    tasks: [{
      taskNumber: 7,
      status: "in_review",
      title: "Create staging resource",
      requiresResourceReceipt: true,
      resourceReceiptRecordedAt: null,
    }],
  });
  assert.match(pending, /resource-receipt=pending/);

  const recorded = formatTaskList("#ops", {
    tasks: [{
      taskNumber: 7,
      status: "in_review",
      title: "Create staging resource",
      requiresResourceReceipt: true,
      resourceReceiptRecordedAt: "2026-08-11T20:00:00.000Z",
    }],
  });
  assert.match(recorded, /resource-receipt=recorded/);
});

test("formatTaskList: multiple tasks with mixed states", () => {
  const out = formatTaskList("#engineering", {
    tasks: [
      { taskNumber: 1, status: "done", title: "set up repo", claimedById: "user-1", claimedByName: "bob", createdByName: "alice", createdByHandle: "alice", messageId: "1111111100000000" },
      { taskNumber: 2, status: "todo", title: "write tests", claimedByName: null, createdByName: "alice", createdByHandle: "alice", messageId: "2222222200000000" },
      { taskNumber: 3, status: "in_progress", title: "fix flaky CI", claimedById: "agent-3", claimedByName: "akko", createdByName: null, messageId: "3333333300000000" },
    ],
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "## Task Board for #engineering (3 tasks)");
  assert.equal(lines[2], "#1 [done] → @bob (by @alice) msg=11111111 Current title: set up repo");
  assert.equal(lines[3], "#2 [todo] (by @alice) msg=22222222 Current title: write tests");
  assert.equal(lines[4], "#3 [in_progress] → @akko msg=33333333 Current title: fix flaky CI");
});

test("formatTaskList: unresolved claimed assignee never prints opaque id", () => {
  const out = formatTaskList("#engineering", {
    tasks: [
      {
        taskNumber: 4,
        status: "in_progress",
        title: "hold ownership",
        claimedById: "6e6ef0c5-0da7-4983-a69d-b072a072d355",
        claimedByName: null,
        messageId: "4444444400000000",
      },
    ],
  });
  assert.match(out, /#4 \[in_progress\] → <unresolved> msg=44444444 Current title: hold ownership/);
  assert.doesNotMatch(out, /6e6ef0c5/);
  assert.doesNotMatch(out, /agent:6e6ef0c5/);
});

test("formatTaskList: legacy task", () => {
  const out = formatTaskList("#general", {
    tasks: [
      { taskNumber: 5, status: "todo", title: "old migration", messageId: "aaaa000000000000", isLegacy: true },
    ],
  });
  assert.match(out, /#5 \[todo\] msg=aaaa0000 \[LEGACY — read-only\] Current title: old migration/);
});

test("formatTaskList: task without messageId", () => {
  const out = formatTaskList("#general", {
    tasks: [
      { taskNumber: 1, status: "todo", title: "no msg id task", messageId: null },
    ],
  });
  assert.equal(
    out,
    [
      "## Task Board for #general (1 tasks)",
      "",
      "#1 [todo] Current title: no msg id task",
    ].join("\n"),
  );
});

// ── formatTasksCreated ──────────────────────────────────────────────

test("formatTasksCreated: batch create", () => {
  const out = formatTasksCreated("#engineering", {
    tasks: [
      {
        taskNumber: 1,
        messageId: "aaaa111100000000",
        title: "task A",
        status: "todo",
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
      },
      {
        taskNumber: 2,
        messageId: "bbbb222200000000",
        title: "task B",
        status: "in_progress",
        claimedByType: "agent",
        claimedById: "agent-2",
        claimedByName: "akko",
        claimedAt: "2026-07-12T02:00:00.000Z",
      },
    ],
  });
  assert.equal(
    out,
    [
      'Created 2 task(s) in #engineering:',
      '#1 [todo] assignee=unassigned claimedAt=null msg=aaaa1111 "task A"',
      '#2 [in_progress] assignee=@akko claimedAt=2026-07-12T02:00:00.000Z msg=bbbb2222 "task B"',
      '',
      'To follow up in each task\'s thread:',
      '#1 → raft message send --target "#engineering:aaaa1111"',
      '#2 → raft message send --target "#engineering:bbbb2222"',
    ].join("\n"),
  );
});

test("formatTasksCreated: unresolved assignee never prints opaque id", () => {
  const out = formatTasksCreated("#engineering", {
    tasks: [
      {
        taskNumber: 2,
        messageId: "bbbb222200000000",
        title: "task B",
        status: "in_progress",
        claimedByType: "agent",
        claimedById: "6e6ef0c5-0da7-4983-a69d-b072a072d355",
        claimedAt: "2026-07-12T02:00:00.000Z",
      },
    ],
  });
  assert.match(out, /assignee=<unresolved>/);
  assert.doesNotMatch(out, /6e6ef0c5/);
  assert.doesNotMatch(out, /agent:6e6ef0c5/);
});

// ── formatClaimResults ──────────────────────────────────────────────

test("formatClaimResults: mixed success and failure", () => {
  const out = formatClaimResults("#engineering", {
    results: [
      { taskNumber: 1, messageId: "aaaa111100000000", success: true },
      { taskNumber: 2, messageId: "bbbb222200000000", success: false, reason: "already claimed by @kuku" },
    ],
  });
  assert.match(out, /Claim results \(1 claimed, 1 failed\)/);
  assert.match(out, /#1 \(msg:aaaa1111\): claimed/);
  // Conservative fallback (no structured conflict): blocks conflicting
  // execution only, and never re-adjudicates lane ownership.
  assert.match(
    out,
    /#2: FAILED — already claimed by @kuku\. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership\./,
  );
  assert.doesNotMatch(out, /Do not work on this task/);
  assert.match(out, /Follow up in each task's thread/);
  assert.match(out, /#1 → raft message send --target "#engineering:aaaa1111"/);
});

const CONFLICT = {
  kind: "claim_conflict" as const,
  conflictScope: "implementation_execution" as const,
  blockedActions: ["start_conflicting_execution"],
  unblockedActionExamples: ["read", "coordinate", "review", "request_reassign", "handoff"],
  currentAssignee: { type: "agent" as const, name: "Jianwei" },
  taskStatus: "in_progress",
  claimedAt: "2026-07-27T10:00:00.000Z",
  observedAt: "2026-07-27T12:34:56.000Z",
};

test("formatClaimConflict: effect-boundary receipt renders from structured fields", () => {
  const out = formatClaimResults("#proj", {
    results: [{ taskNumber: 7, success: false, reason: "already assigned to @Jianwei", conflict: CONFLICT }],
  });
  assert.match(out, /#7: Claim failed — @Jianwei currently holds the implementation lock \(assignment state as of 2026-07-27T12:34:56\.000Z\)\./);
  assert.match(out, /Blocked: starting conflicting implementation\/change work\./);
  assert.match(out, /Not blocked by this claim conflict \(each still subject to its own authority\/policy\): read · coordinate · review · request_reassign · handoff\./);
  assert.match(out, /This is not a ruling on who owns or leads this lane\./);
  assert.match(out, /file request_reassign \(a request — it does not itself reassign\)/);
  // The retired blanket adjudication never renders on the conflict path.
  assert.doesNotMatch(out, /Do not work on this task/);
});

test("formatClaimConflict: copy is projected, not hardcoded — field changes change copy", () => {
  const out = formatClaimResults("#proj", {
    results: [{
      taskNumber: 7,
      success: false,
      conflict: {
        ...CONFLICT,
        currentAssignee: { type: "user" as const, name: "richard" },
        unblockedActionExamples: ["read", "escalate"],
        blockedActions: ["start_conflicting_execution", "custom_future_block"],
      },
    }],
  });
  assert.match(out, /@richard currently holds the implementation lock/);
  assert.match(out, /: read · escalate\./);
  // Unknown blocked-action ids surface as raw ids instead of vanishing.
  assert.match(out, /Blocked: starting conflicting implementation\/change work; custom_future_block\./);
});

test("formatClaimConflict: placement — restriction, non-ruling, and remedy are one contiguous block", () => {
  const out = formatClaimResults("#proj", {
    results: [{ taskNumber: 7, success: false, conflict: CONFLICT }],
  });
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.includes("Claim failed —"));
  assert.ok(start >= 0);
  // Decision-unit co-location: the three roles sit on consecutive lines of the
  // same conflict block — none of them may sink into a generic footer.
  assert.match(lines[start + 1]!, /^ {2}Blocked: /);
  assert.match(lines[start + 2]!, /^ {2}Not blocked by this claim conflict/);
  assert.match(lines[start + 3]!, /^ {2}This is not a ruling on who owns or leads this lane\. If you are its canonical owner or believe it is misrouted: correct the routing in the original thread, or file request_reassign/);
});

test("formatClaimConflict: unresolved assignee never fabricates a handle", () => {
  const out = formatClaimResults("#proj", {
    results: [{ taskNumber: 8, success: false, conflict: { ...CONFLICT, currentAssignee: null } }],
  });
  assert.match(out, /#8: Claim failed — another actor currently holds the implementation lock/);
});

test("formatClaimResults: all success", () => {
  const out = formatClaimResults("#proj", {
    results: [
      { taskNumber: 3, messageId: "cccc333300000000", success: true },
    ],
  });
  assert.match(out, /Claim results \(1 claimed\)/);
  assert.match(out, /#3 \(msg:cccc3333\): claimed/);
});

test("formatClaimResults: DM hints use CLI-addressable target syntax", () => {
  const out = formatClaimResults("dm:user:Dozy", {
    results: [
      { taskNumber: 3, messageId: "cccc333300000000", success: true },
    ],
  });
  assert.match(out, /#3 → raft message send --target "dm:@Dozy:cccc3333"/);
  assert.doesNotMatch(out, /dm:user:/);
});

test("formatClaimResults: self-claim failure omits owner/admin redirect guidance", () => {
  const out = formatClaimResults("#proj", {
    results: [
      { taskNumber: 4, messageId: "dddd444400000000", success: false, reason: "already claimed by you" },
    ],
  });
  assert.match(out, /Claim results \(0 claimed, 1 failed\)/);
  assert.match(out, /#4: already claimed by you\./);
  assert.doesNotMatch(out, /owner\/admin explicitly redirects/);
  assert.doesNotMatch(out, /FAILED/);
});

// ── formatTaskUnclaimed / formatTaskStatusUpdated ───────────────────

test("formatTaskUnclaimed", () => {
  assert.equal(formatTaskUnclaimed(5), "#5 unclaimed — now open.");
});

test("formatTaskStatusUpdated", () => {
  assert.equal(formatTaskStatusUpdated(3, "in_review"), "#3 moved to in_review.");
});

test("formatTaskList: renders created/updated as explicit UTC", () => {
  const out = formatTaskList("#proj-slock", {
    tasks: [{
      taskNumber: 7,
      status: "todo",
      title: "Ship it",
      // A non-UTC-looking offset input must still render as UTC with Z, which is
      // what routing through the shared formatUtcTimestamp buys (PR #6991).
      createdAt: "2026-08-28T10:30:44.000Z",
      updatedAt: "2026-08-28T18:30:44.000+08:00",
    }],
  });
  assert.match(out, / created=2026-08-28 10:30:44Z/);
  assert.match(out, / updated=2026-08-28 10:30:44Z/);
  assert.doesNotMatch(out, /\+08:00/);
});

test("formatTaskList: omits the stamps entirely when absent", () => {
  const out = formatTaskList("#proj-slock", {
    tasks: [{ taskNumber: 8, status: "todo", title: "No stamps" }],
  });
  assert.doesNotMatch(out, /created=/);
  assert.doesNotMatch(out, /updated=/);
  assert.match(out, /#8 \[todo\] Current title: No stamps/);
});

test("formatMyTaskList: the cross-channel view carries the same stamps", () => {
  const out = formatMyTaskList({
    tasks: [{
      taskNumber: 9,
      status: "in_progress",
      title: "Mine",
      channelRef: "#proj-slock",
      createdAt: "2026-08-28T10:30:44.000Z",
    }],
  });
  assert.match(out, / created=2026-08-28 10:30:44Z/);
});

// task #123 — a multiline task title must not break the task-number line apart.
// The card's own title names the target: "normalize channel-board titles to one line".
// The report-block shape (blank-line separated, label: value) is the one that escaped:
// it is how agent-issue reports arrive, and it is a real specimen from #wg-agent-issue #4.
const REPORT_BLOCK_TITLE = [
  "reportId: a433ea30-b2de-4acc-982d-521f93c5ba94",
  "serverId: 36e6355e-bcca-4e36-9679-d13c1b250ba8",
  "",
  "issueDescription:",
  "not responding 谁帮忙看一下这个issue是为什么没有响应",
].join("\n");

function taskBodyLines(out: string): string[] {
  // output is "## Task Board …\n\n<tasks>" — everything after the header/blank is the board
  return out.split("\n").slice(2);
}

test("formatTaskList: a report-block title collapses to one physical line carrying the assignee (task #123)", () => {
  const out = formatTaskList("#wg-agent-issue", {
    tasks: [
      {
        taskNumber: 4,
        status: "in_review",
        title: REPORT_BLOCK_TITLE,
        claimedById: "agent-1",
        claimedByName: "HaoHao",
        createdByName: "RC",
        createdByHandle: "RC",
        messageId: "983f3882aaaabbbb",
      },
    ],
  });
  const body = taskBodyLines(out);
  // rev3 acceptance: exactly one physical task line, and the #N line carries the assignee.
  assert.equal(body.length, 1, `expected 1 physical task line, got ${body.length}:\n${body.join("\n")}`);
  assert.ok(body[0].startsWith("#4 "), `task line must start with #4: ${body[0]}`);
  assert.ok(body[0].includes("→ @HaoHao"), `assignee must sit on the #N line: ${body[0]}`);
});

test("formatTaskList: collapsing the title leaves the deliberate details block expanded (task #123)", () => {
  // Huaihuai's boundary: fix the title, ⛔ do not flatten the description block — it is
  // intentionally multi-line and indented, and is a separate contract from the title.
  const out = formatTaskList("#wg-agent-issue", {
    tasks: [
      {
        taskNumber: 5,
        status: "todo",
        title: "line one\nline two",
        description: "first detail\nsecond detail",
        claimedById: null,
        claimedByName: null,
        createdByName: "RC",
        createdByHandle: "RC",
      },
    ],
  });
  const body = taskBodyLines(out);
  assert.equal(body.length, 3, `1 task line + 2 details lines expected, got:\n${body.join("\n")}`);
  assert.ok(body[0].startsWith("#5 ") && body[0].includes("line one line two"));
  assert.ok(body[1].startsWith("  Current description: first detail"));
  assert.ok(body[2].startsWith("  │ second detail"));
  assert.doesNotMatch(out, /\n  details:/);
});

test("formatMyTaskList: the same report-block title stays on one line (task #123, other render path)", () => {
  // The --mine path already collapses. Kept as the paired guard so a future change
  // cannot fix one path and regress the other — that asymmetry is the whole defect.
  const out = formatMyTaskList({
    tasks: [
      {
        taskNumber: 4,
        channelRef: "#wg-agent-issue",
        status: "in_review",
        title: REPORT_BLOCK_TITLE,
        createdByName: "RC",
        createdByHandle: "RC",
        messageId: "983f3882aaaabbbb",
      },
    ],
  });
  const taskLines = out.split("\n").filter((l) => l.startsWith("- #wg-agent-issue task #4 "));
  assert.equal(taskLines.length, 1, `expected exactly 1 task line, got ${taskLines.length}`);
});

// Task v2 (server has task_v2_conversations_v0 on): a task is named by its
// ref (`#channel:#7`) — it has its own conversation, or (pending) gets one on
// its first write. No `conversation=` field; `source=` is the chat message it
// came from. Tasks without either flag keep the exact pre-v2 bytes (pinned above).
test("formatTaskList: task v2 tasks are named by their ref, with their source message", () => {
  const out = formatTaskList("#proj-slock", {
    tasks: [
      {
        taskNumber: 3,
        status: "todo",
        title: "hero section",
        createdByName: "xxchan",
        createdByHandle: "xxchan",
        messageId: "33333333-0000-0000-0000-000000000000",
        hostMessageId: null,
        sourceMessageId: "src67890-0000-0000-0000-000000000000",
        conversationAnchored: true,
      },
      {
        taskNumber: 4,
        status: "todo",
        title: "pricing",
        messageId: "44444444-0000-0000-0000-000000000000",
        hostMessageId: null,
        sourceMessageId: null,
        conversationAnchored: true,
      },
    ],
  });
  assert.equal(
    out,
    [
      "## Task Board for #proj-slock (2 tasks)",
      "",
      "#proj-slock:#3 [todo] (by @xxchan) source=src67890 Current title: hero section",
      "#proj-slock:#4 [todo] Current title: pricing",
    ].join("\n"),
  );
  assert.doesNotMatch(out, /conversation=|msg=/);
});

test("formatTaskList: a pre-v2 task with its own conversation names its earlier thread", () => {
  const out = formatTaskList("dm:@cody", {
    tasks: [{
      taskNumber: 2,
      status: "in_progress",
      title: "old one",
      messageId: "host1234-0000-0000-0000-000000000000",
      hostMessageId: "host1234-0000-0000-0000-000000000000",
      sourceMessageId: null,
      conversationAnchored: true,
    }],
  });
  assert.match(out, /^dm:@cody:#2 \[in_progress\] earlier=dm:@cody:host1234 Current title: old one$/m);
});

test("formatTasksCreated: task v2 tasks print their ref and the task reply command", () => {
  const out = formatTasksCreated("#general", {
    tasks: [{
      taskNumber: 7,
      messageId: "77777777-0000-0000-0000-000000000000",
      title: "hero",
      status: "todo",
      claimedByType: null,
      claimedById: null,
      claimedAt: null,
      conversationAnchored: true,
      sourceMessageId: "src67890-0000-0000-0000-000000000000",
    }],
  });
  assert.match(out, /^#general:#7 \[todo\] assignee=unassigned claimedAt=null source=src67890 "hero"$/m);
  assert.match(out, /To discuss each task in its own conversation \(the reply body is read from stdin\):\n#general:#7 → raft task reply "#general:#7"$/);
  assert.doesNotMatch(out, /msg=|conversation=|raft message send/);
});

test("formatClaimResults: task v2 results are named by ref and follow up with raft task reply", () => {
  const out = formatClaimResults("#general", {
    results: [
      { taskNumber: 7, success: true, messageId: "77777777-0000-0000-0000-000000000000", taskRef: "#general:#7" },
      { taskNumber: 8, success: false, reason: "already claimed", taskRef: "#general:#8" },
    ],
  });
  assert.match(out, /^#general:#7: claimed$/m);
  assert.match(out, /^#general:#8: FAILED — already claimed\./m);
  assert.match(out, /Follow up in each task's conversation \(the reply body is read from stdin\):\n#general:#7 → raft task reply "#general:#7"\n/);
  // Where to answer the person who asked: task view names the creator and the source.
  assert.match(out, /Answer the person who asked where they spoke \(the source message's thread, or the task if they created it or wrote in it\); this shows who created the task and its source:\nraft task view "#general:#7"$/);
  assert.doesNotMatch(out, /msg:|raft message send/);
});

test("formatTasksCreated: a task v2 task taken from a message points back to the message's thread", () => {
  const out = formatTasksCreated("#general", {
    tasks: [{
      taskNumber: 7,
      messageId: "77777777-0000-0000-0000-000000000000",
      title: "hero",
      status: "in_progress",
      claimedByType: "agent",
      claimedById: "agent-1",
      claimedByName: "cody",
      claimedAt: "2026-10-26T08:00:00.000Z",
      conversationAnchored: true,
      sourceMessageId: "src67890-0000-0000-0000-000000000000",
    }],
  });
  assert.match(out, /To discuss each task in its own conversation \(the reply body is read from stdin\):\n#general:#7 → raft task reply "#general:#7"\n/);
  assert.match(out, /The source message's thread now names this task\. If you have not confirmed it there yet \(what you understood and will do\), do it now:\n#general:#7 → raft message send --target "#general:src67890"/);
});

test("formatTaskStatusUpdated: a task v2 task moved to in_review is steered to done or in_progress, and where to answer", () => {
  const out = formatTaskStatusUpdated(7, "in_review", "#general:#7");
  assert.match(out, /^#general:#7 moved to in_review\.\n\nDon't leave it in in_review: it is no longer used\. Finished: set it done\. Waiting on someone's decision or input: set it in_progress, assign it to them/);
  assert.match(out, /raft task view "#general:#7"$/);
  const done = formatTaskStatusUpdated(7, "done", "#general:#7");
  assert.match(done, /^#general:#7 moved to done\.\n\nNot sent the result yet\? Answer the person who asked where they spoke/);
  assert.match(done, /raft task view "#general:#7"$/);
  assert.equal(formatTaskStatusUpdated(7, "in_progress", "#general:#7"), "#general:#7 moved to in_progress.");
});

test("formatTaskList / formatMyTaskList: a pre-v2 task without its conversation on a task v2 server is named by ref", () => {
  const task = {
    taskNumber: 2,
    status: "todo",
    title: "old one",
    messageId: "host1234-0000-0000-0000-000000000000",
    sourceMessageId: "host1234-0000-0000-0000-000000000000",
    conversationAnchored: false,
    conversationPending: true,
  };
  const board = formatTaskList("#proj-slock", { tasks: [task] });
  assert.match(board, /^#proj-slock:#2 \[todo\] source=host1234 Current title: old one$/m);
  assert.doesNotMatch(board, /msg=host1234|conversation=/);
  const mine = formatMyTaskList({ tasks: [{ ...task, channelRef: "#proj-slock" }] });
  assert.match(mine, /^- #proj-slock:#2 \[todo\] source=host1234 /m);
});

test("task mutation receipts: the server's taskRef names the task (task v2); #N otherwise", () => {
  assert.equal(formatTaskStatusUpdated(7, "closed", "#general:#7"), "#general:#7 moved to closed.");
  assert.equal(formatTaskAssigned(7, "@cody", "#general:#7"), "#general:#7 assigned to @cody.");
  assert.equal(formatTaskUnclaimed(7, "#general:#7"), "#general:#7 unclaimed — now open.");
  assert.equal(formatTaskDeleted(7, "#general:#7"), "#general:#7 deleted.");
  assert.equal(formatTaskStatusUpdated(7, "done"), "#7 moved to done.");
});

test("formatTaskList / formatMyTaskList: the creator is named by handle; a display name is never @-prefixed", () => {
  const withHandle = { taskNumber: 7, status: "todo", title: "埋点", createdByName: "林晓", createdByHandle: "Developer", messageId: "abcd1234efgh5678" };
  // A server from before `createdByHandle`: only the display name is known.
  const displayOnly = { taskNumber: 8, status: "todo", title: "OG 图", createdByName: "周航", messageId: "bcde2345fghi6789" };
  const board = taskBodyLines(formatTaskList("#proj-launch", { tasks: [withHandle, displayOnly] }));
  assert.equal(board[0], "#7 [todo] (by @Developer) msg=abcd1234 Current title: 埋点");
  assert.equal(board[1], "#8 [todo] (by 周航) msg=bcde2345 Current title: OG 图");
  const mine = formatMyTaskList({ tasks: [{ ...withHandle, channelRef: "#proj-launch" }, { ...displayOnly, channelRef: "#proj-launch" }] });
  assert.match(mine, /^- #proj-launch task #7 \[todo\] by=@Developer msg=abcd1234 Current title: 埋点$/m);
  assert.match(mine, /^- #proj-launch task #8 \[todo\] by="周航" msg=bcde2345 Current title: OG 图$/m);
  assert.doesNotMatch(`${board.join("\n")}\n${mine}`, /@(林晓|周航)/);
});
