import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  emitTaskCreated,
  emitTaskDeleted,
  projectTaskMessageNew,
  emitTaskMessageUpdated,
  emitTaskUpdated,
  projectTaskMessageUpdated,
} from "./taskRealtimeEvents.js";

function createIoRecorder() {
  const emissions: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
  const io = {
    rooms: [] as string[],
    to(room: string) {
      this.rooms.push(room);
      return this;
    },
    emit(event: string, payload: unknown) {
      emissions.push({ rooms: [...this.rooms], event, payload });
      this.rooms = [];
      return true;
    },
  };
  return { io: io as any, emissions };
}

test("public channel task events stay in the authorized channel room", () => {
  const { io, emissions } = createIoRecorder();
  const target = { channelId: "channel-1", channelType: "channel" as const, serverId: "server-1" };

  emitTaskCreated(io, target, { channelId: "channel-1", tasks: [{ id: "task-1" }] });
  emitTaskUpdated(io, target, { channelId: "channel-1", task: { id: "task-1", status: "done" } });
  emitTaskDeleted(io, target, { channelId: "channel-1", taskId: "task-1" });

  assert.deepEqual(emissions.map((item) => item.event), [
    "task:created",
    "task:updated",
    "task:deleted",
  ]);
  assert.deepEqual(emissions.map((item) => item.rooms), [
    ["channel:channel-1"],
    ["channel:channel-1"],
    ["channel:channel-1"],
  ]);
});

test("task:created emits only the explicit task-domain allowlist", () => {
  const { io, emissions } = createIoRecorder();
  const now = new Date("2026-07-12T00:00:00.000Z");

  emitTaskCreated(io, {
    channelId: "channel-allowlist",
    channelType: "channel",
    serverId: "server-allowlist",
  }, {
    channelId: "channel-allowlist",
    tasks: [{
      id: "task-allowlist",
      messageId: "task-allowlist",
      channelId: "channel-allowlist",
      channelName: "allowlist",
      channelType: "channel",
      taskNumber: 73,
      title: "Allowlisted task",
      description: null,
      status: "todo",
      claimedByType: null,
      claimedById: null,
      claimedByName: null,
      claimedAt: null,
      completedAt: null,
      createdByType: "agent",
      createdById: "agent-author",
      createdByName: "author",
      createdAt: now,
      updatedAt: now,
      revision: 2,
      taskCurrentProjection: {
        title: "Current allowlisted task",
        description: "Current details",
        revision: 2,
        superseded: true,
        amendedAt: now.toISOString(),
        amendedByType: "agent",
        amendedByName: "author",
        source: "tasks_current_projection",
      },
      isLegacy: false,
      agentSendKey: "must-not-leak",
      searchText: "must-not-leak",
      futureInternalColumn: "must-not-leak",
    }],
  });

  assert.equal(emissions.length, 1);
  const payload = emissions[0]?.payload as { tasks: Array<Record<string, unknown>> };
  assert.equal(payload.tasks[0]?.status, "todo");
  assert.equal(payload.tasks[0]?.claimedById, null);
  assert.equal(payload.tasks[0]?.revision, 2);
  assert.deepEqual(payload.tasks[0]?.taskCurrentProjection, {
    title: "Current allowlisted task",
    description: "Current details",
    revision: 2,
    superseded: true,
    amendedAt: now.toISOString(),
    amendedByType: "agent",
    amendedByName: "author",
    source: "tasks_current_projection",
  });
  assert.equal("agentSendKey" in payload.tasks[0]!, false);
  assert.equal("searchText" in payload.tasks[0]!, false);
  assert.equal("futureInternalColumn" in payload.tasks[0]!, false);
});

test("private task events stay channel-scoped", () => {
  const { io, emissions } = createIoRecorder();

  emitTaskUpdated(io, {
    channelId: "private-1",
    channelType: "private",
    serverId: "server-1",
  }, {
    channelId: "private-1",
    task: { id: "task-1", status: "done" },
  });

  assert.deepEqual(emissions, [{
    rooms: ["channel:private-1"],
    event: "task:updated",
    payload: { channelId: "private-1", task: { id: "task-1", status: "done" } },
  }]);
});

test("task message updates expose only the explicit public projection", () => {
  const createdAt = new Date("2026-07-12T00:00:00.000Z");
  const updatedAt = new Date("2026-07-12T00:01:00.000Z");
  const taskClaimedAt = new Date("2026-07-12T00:00:30.000Z");
  const source = {
    id: "message-1",
    seq: 42,
    channelId: "channel-1",
    senderType: "agent" as const,
    senderId: "agent-1",
    agentSendKey: "must-not-leak",
    randomId: null,
    messageType: "chat" as const,
    content: "Task body",
    actionMetadata: null,
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    threadId: null,
    taskStatus: "in_progress" as const,
    taskNumber: 7,
    taskAssigneeType: "agent" as const,
    taskAssigneeId: "agent-2",
    taskAssigneeName: "target-agent",
    taskClaimedAt,
    taskCompletedAt: null,
    createdAt,
    updatedAt,
    futureInternalColumn: "must-not-leak",
  };

  const payload = projectTaskMessageUpdated(source, "Task author");

  assert.deepEqual(payload, {
    id: "message-1",
    seq: 42,
    channelId: "channel-1",
    senderType: "agent" as const,
    senderId: "agent-1",
    randomId: null,
    messageType: "chat" as const,
    content: "Task body",
    actionMetadata: null,
    threadId: null,
    taskStatus: "in_progress",
    taskNumber: 7,
    taskAssigneeType: "agent",
    taskAssigneeId: "agent-2",
    taskAssigneeName: "target-agent",
    taskClaimedAt,
    taskCompletedAt: null,
    createdAt,
    updatedAt,
    senderName: "Task author",
  });
  assert.equal("agentSendKey" in payload, false);
  assert.equal("searchText" in payload, false);
  assert.equal("searchVector" in payload, false);
  assert.equal("futureInternalColumn" in payload, false);
});

test("assigned todo first realtime state is exact and storage-safe", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const source = {
    id: "message-assigned-todo",
    seq: 44,
    channelId: "channel-1",
    senderType: "agent" as const,
    senderId: "dispatcher-agent",
    agentSendKey: "must-not-leak",
    randomId: null,
    messageType: "chat" as const,
    content: "Reserved work",
    actionMetadata: null,
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    threadId: null,
    taskStatus: "todo" as const,
    taskNumber: 9,
    taskAssigneeType: "agent" as const,
    taskAssigneeId: "target-agent",
    taskAssigneeName: "target-agent",
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const payload = projectTaskMessageNew(source, "Dispatcher");

  assert.equal(payload.taskStatus, "todo");
  assert.equal(payload.taskAssigneeType, "agent");
  assert.equal(payload.taskAssigneeId, "target-agent");
  assert.equal(payload.taskAssigneeName, "target-agent");
  assert.equal(payload.taskClaimedAt, null);
  assert.equal("agentSendKey" in payload, false);
  assert.equal("searchText" in payload, false);
  assert.equal("searchVector" in payload, false);
});

test("task message update emission uses the row channel and projected payload", () => {
  const events: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: Record<string, unknown>) {
          events.push({ room, event, payload });
        },
      };
    },
  };
  const now = new Date("2026-07-12T00:00:00.000Z");
  const row = {
    id: "message-2",
    seq: 43,
    channelId: "channel-2",
    senderType: "user" as const,
    senderId: "user-1",
    agentSendKey: "must-not-leak",
    randomId: "optimistic-1",
    messageType: "chat" as const,
    content: "Converted task",
    actionMetadata: null,
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    threadId: null,
    taskStatus: "todo" as const,
    taskNumber: 8,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  emitTaskMessageUpdated(io as never, row, "Human author");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.room, "channel:channel-2");
  assert.equal(events[0]?.event, "message:updated");
  assert.equal(events[0]?.payload.senderName, "Human author");
  assert.equal("agentSendKey" in events[0]!.payload, false);
  assert.equal("searchText" in events[0]!.payload, false);
  assert.equal("searchVector" in events[0]!.payload, false);
});

test("task mutation routes cannot restore raw row spreads in message:updated", async () => {
  // v1.4 added an indirection: most routes now reach the projector through
  // `taskMutationBroadcast.emitTaskMutation` (or its joint-surface fanout
  // variant), which also decides whether a `message:updated` is emitted at all
  // (a canonical task's host message did not change). Counting only direct
  // `emitTaskMessageUpdated(` calls would have quietly reduced this ratchet's
  // scope to one file, so it counts projector-reaching calls and scans the new
  // indirection too.
  //
  // ⚠️ P3 LOWERED `tasks.ts` FROM 1 TO 0. That is a ratchet being relaxed, so it
  // is spelled out: the removed call was the `result.source === "message"` arm
  // of `emitTaskUpdate`, and message-owned tasks no longer resolve, so the arm
  // was unreachable rather than merely unused. Nothing else about the guard is
  // weakened -- `noRawSpread` below is the assertion that actually prevents a
  // raw DB row reaching the socket, it still runs over `tasks.ts`, and the
  // agent-facing counts are untouched. If a future change makes `tasks.ts` emit
  // `message:updated` again it must go through the projector, and the extra
  // assertion under this loop will fail until this number is raised again.
  const routes = [
    ["tasks.ts", 0],
    ["internal.ts", 5],
    // 6 -> 8: the agent-facing resource-receipt and amendment routes. Raising
    // this number is the SAFE direction for this guard -- each new task
    // mutation reaches the shared projector instead of hand-rolling realtime.
    ["internalAgentApi.ts", 8],
  ] as const;

  const noRawSpread = /emit\(\s*["']message:updated["']\s*,\s*\{\s*\.\.\./s;
  const projectorReaching = /emitTaskMessageUpdated\(|emitTaskMutation(?:ToSurfaces)?\(|describeTaskMutation\(/g;

  for (const [filename, expectedProjectionCalls] of routes) {
    const source = await readFile(new URL(`../routes/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      noRawSpread,
      `${filename} must not spread a DB row into message:updated`,
    );
    assert.equal(
      source.match(projectorReaching)?.length ?? 0,
      expectedProjectionCalls,
      `${filename} must route every task-family message update through the projector`,
    );
  }

  // The indirection itself must not become the escape hatch.
  const broadcast = await readFile(new URL("./taskMutationBroadcast.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    broadcast,
    noRawSpread,
    "taskMutationBroadcast must not spread a DB row into message:updated",
  );
  // P3: the message-owned branch is gone, so the indirection reaches the
  // projector zero times. Same reasoning as the `tasks.ts` count above.
  assert.equal(
    broadcast.match(/emitTaskMessageUpdated\(/g)?.length ?? 0,
    0,
    "taskMutationBroadcast must not reach the message projector after P3",
  );

  // The replacement teeth for what the count above used to guard: `tasks.ts`
  // must emit no `message:updated` at all now. A count of 0 alone would also be
  // satisfied by someone emitting it *without* the projector -- which is the
  // exact regression this file exists to stop.
  const tasksSource = await readFile(new URL("../routes/tasks.ts", import.meta.url), "utf8");
  assert.equal(
    tasksSource.match(/["']message:updated["']/g)?.length ?? 0,
    0,
    "tasks.ts must not emit message:updated after P3, by any route",
  );
});
