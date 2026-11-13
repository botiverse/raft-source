import assert from "node:assert/strict";

import { canApplyBatchAction, isBatchNoop, runTaskBatch } from "../src/components/task/tasksPage/tasksBatch";
import type { BatchAction, BatchViewer } from "../src/components/task/tasksPage/tasksBatch";
import type { Task } from "../src/store/taskStore";

// The Tasks page's selection bar acts on many tasks with the per-task APIs:
// who may change what (per action, the rule of the same change on one task
// and the server's), what is skipped, what failed, how many writes run at
// once, and the toast's words.

const ME = "user-me";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    messageId: `anchor-${overrides.id}`,
    channelId: "ch-a",
    taskNumber: 1,
    title: "A task",
    status: "todo",
    claimedByType: null,
    claimedById: null,
    createdById: "user-other",
    createdByType: "user",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const member: BatchViewer = { userId: ME, canAssign: true, canDeleteAny: false };
const admin: BatchViewer = { userId: ME, canAssign: true, canDeleteAny: true };

const created = task({ id: "created", createdById: ME });
const assigned = task({ id: "assigned", claimedByType: "user", claimedById: ME });
const others = task({ id: "others" });
const readOnly = task({ id: "read-only", createdById: ME, readOnlyReason: "historical_joint_task" });
const legacy = task({ id: "legacy", createdById: ME, isLegacy: true });

test("per action, the single task's rule: status any member, assign the capability, delete the creator or deleteAnyTask, follow anyone", () => {
  const status: BatchAction = { kind: "status", status: "done" };
  const assign: BatchAction = { kind: "assignee", assignee: { type: "user", id: ME } };
  // Status: any member who may write the task, as a card's drag (canEditTaskStatus); never a read-only or legacy one.
  assert.equal(canApplyBatchAction(status, others, member), true, "someone else's task, as a single drag");
  assert.equal(canApplyBatchAction(status, created, member), true);
  assert.equal(canApplyBatchAction(status, readOnly, admin), false);
  assert.equal(canApplyBatchAction(status, legacy, admin), false);
  // …but no unassigned To-do to In progress: that is a single task's claim, which a batch makes for no one.
  assert.equal(canApplyBatchAction({ kind: "status", status: "in_progress" }, others, member), false);
  assert.equal(canApplyBatchAction({ kind: "status", status: "in_progress" }, assigned, member), true);
  // Assignee: the capability (a Guest's included, useBatchViewer), on a task not done and writable, whoever's.
  assert.equal(canApplyBatchAction(assign, others, member), true);
  assert.equal(canApplyBatchAction(assign, created, { ...member, canAssign: false }), false);
  assert.equal(canApplyBatchAction(assign, task({ id: "done", status: "done" }), member), false);
  assert.equal(canApplyBatchAction(assign, readOnly, admin), false);
  // Delete: the creator, or deleteAnyTask.
  assert.equal(canApplyBatchAction({ kind: "delete" }, created, member), true, "the creator deletes");
  assert.equal(canApplyBatchAction({ kind: "delete" }, assigned, member), false, "the assignee does not");
  assert.equal(canApplyBatchAction({ kind: "delete" }, others, admin), true);
  assert.equal(canApplyBatchAction({ kind: "delete" }, created, { ...member, userId: null }), false);
  // Follow: anyone who sees it.
  assert.equal(canApplyBatchAction({ kind: "follow" }, others, member), true);
  assert.equal(canApplyBatchAction({ kind: "follow" }, legacy, member), false);
});

test("a task already so is done without a write", () => {
  assert.equal(isBatchNoop({ kind: "status", status: "todo" }, created), true);
  assert.equal(isBatchNoop({ kind: "status", status: "done" }, created), false);
  assert.equal(isBatchNoop({ kind: "assignee", assignee: null }, created), true);
  assert.equal(isBatchNoop({ kind: "assignee", assignee: { type: "user", id: ME } }, assigned), true);
  assert.equal(isBatchNoop({ kind: "assignee", assignee: { type: "agent", id: ME } }, assigned), false);
  assert.equal(isBatchNoop({ kind: "follow" }, created), false);
});

test("the batch writes the permitted tasks, skips the rest and the ones the server refuses", async () => {
  const written: string[] = [];
  const refused = task({ id: "refused", createdById: ME });
  const outcome = await runTaskBatch(
    { kind: "delete" },
    [created, assigned, others, readOnly, refused],
    member,
    async (_action, target) => {
      if (target.id === "refused") throw Object.assign(new Error("403"), { response: { status: 403 } });
      written.push(target.id);
    },
  );
  assert.deepEqual(written, ["created"], "no write for what is not mine to delete, nor a read-only task");
  assert.deepEqual(outcome, { done: 1, skipped: 4, failedIds: ["refused"] }, "the refused one is skipped, and named: it stays selected");

  const statuses = await runTaskBatch(
    { kind: "status", status: "done" },
    [created, others, task({ id: "already", status: "done" })],
    member,
    async () => {},
  );
  assert.deepEqual(statuses, { done: 3, skipped: 0, failedIds: [] }, "already done counts as done, without a write");
});

test("at most four writes are in flight at once, and every task is written once", async () => {
  const tasks = Array.from({ length: 11 }, (_, index) => task({ id: `t${index}`, createdById: ME }));
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const outcome = await runTaskBatch({ kind: "status", status: "closed" }, tasks, member, async (_action, target) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(target.id);
    inFlight -= 1;
  });
  assert.equal(peak, 4);
  assert.deepEqual(seen.sort(), tasks.map((t) => t.id).sort());
  assert.deepEqual(outcome, { done: 11, skipped: 0, failedIds: [] });
  assert.deepEqual(await runTaskBatch({ kind: "status", status: "done" }, [], member, async () => {}), { done: 0, skipped: 0, failedIds: [] });
});

test("a batch status claims nothing: To-do to In progress is the plain status write, not the viewer's claim", async () => {
  const { useTaskStore } = await import("../src/store/taskStore");
  const api = (await import("../src/api/client")).default;
  const unassigned = task({ id: "u1" });
  useTaskStore.setState({ serverTasks: [unassigned] } as never);
  const claim = vi.fn(async () => {});
  useTaskStore.setState({ claimTask: claim } as never);
  const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: { task: { ...unassigned, status: "in_progress" } } } as never);
  await useTaskStore.getState().updateTaskStatus("ch-a", "u1", "in_progress", undefined, { claimUnassigned: false });
  assert.equal(claim.mock.calls.length, 0);
  assert.equal(patch.mock.calls[0]?.[0], "/tasks/u1/status");
  patch.mockRestore();
});
