// Snapshot-style tests for agent-facing task output format.
// Pins the exact text shape of the AX contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMyTaskList, formatTaskList, formatTasksCreated, formatClaimResults, formatTaskUnclaimed, formatTaskStatusUpdated } from "./_format.js";

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
        messageId: "abcd1234efgh5678",
      },
    ],
  });
  assert.equal(
    out,
    [
      "## Task Board for #proj-slock (1 tasks)",
      "",
      "#1 [in_progress] implement CLI transport → @akko (by @xxchan) msg=abcd1234",
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
        createdByMembershipStatus: "active",
        messageId: "1111111100000000",
      },
      {
        taskNumber: 2,
        status: "todo",
        title: "historical creator",
        createdByName: "departed_alice",
        createdByMembershipStatus: "removed",
        messageId: "2222222200000000",
      },
    ],
  });

  const lines = out.split("\n");
  assert.equal(lines[2], "#1 [todo] live creator (by @alice) msg=11111111");
  assert.equal(lines[3], "#2 [todo] historical creator (by @departed_alice [departed]) msg=22222222");
});

test("formatMyTaskList: departed creator state remains visible in the cross-channel view", () => {
  const out = formatMyTaskList({
    tasks: [{
      taskNumber: 2,
      status: "in_review",
      title: "historical creator",
      channelRef: "#proj-release",
      createdByName: "departed_alice",
      createdByMembershipStatus: "left",
      messageId: "2222222200000000",
    }],
  });

  assert.match(
    out,
    /#proj-release task #2 \[in_review\] by=@departed_alice creator=departed msg=22222222 historical creator/,
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
      { taskNumber: 1, status: "done", title: "set up repo", claimedById: "user-1", claimedByName: "bob", createdByName: "alice", messageId: "1111111100000000" },
      { taskNumber: 2, status: "todo", title: "write tests", claimedByName: null, createdByName: "alice", messageId: "2222222200000000" },
      { taskNumber: 3, status: "in_progress", title: "fix flaky CI", claimedById: "agent-3", claimedByName: "akko", createdByName: null, messageId: "3333333300000000" },
    ],
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "## Task Board for #engineering (3 tasks)");
  assert.equal(lines[2], "#1 [done] set up repo → @bob (by @alice) msg=11111111");
  assert.equal(lines[3], "#2 [todo] write tests (by @alice) msg=22222222");
  assert.equal(lines[4], "#3 [in_progress] fix flaky CI → @akko msg=33333333");
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
  assert.match(out, /#4 \[in_progress\] hold ownership → <unresolved> msg=44444444/);
  assert.doesNotMatch(out, /6e6ef0c5/);
  assert.doesNotMatch(out, /agent:6e6ef0c5/);
});

test("formatTaskList: legacy task", () => {
  const out = formatTaskList("#general", {
    tasks: [
      { taskNumber: 5, status: "todo", title: "old migration", messageId: "aaaa000000000000", isLegacy: true },
    ],
  });
  assert.match(out, /#5 \[todo\] old migration msg=aaaa0000 \[LEGACY — read-only\]/);
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
      "#1 [todo] no msg id task",
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
  assert.match(out, /#8 \[todo\] No stamps/);
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
