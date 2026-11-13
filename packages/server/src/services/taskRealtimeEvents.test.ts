import assert from "node:assert/strict";
import {
  emitTaskCreated,
  emitTaskDeleted,
  projectTaskMessageNew,
  emitTaskMessageUpdated,
  emitTaskUpdated,
  projectTaskMessageUpdated,
} from "./taskRealtimeEvents";

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
      hostMessageId: null,
      sourceMessageId: "message-source",
      conversationReplyCount: 3,
      conversationChannelId: "conversation-allowlist",
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
  assert.equal(payload.tasks[0]?.sourceMessageId, "message-source");
  // Task v2: the real host message (none for a v2 task), as on the task DTO.
  assert.equal(payload.tasks[0]?.hostMessageId, null);
  assert.equal(payload.tasks[0]?.conversationReplyCount, 3);
  assert.equal(payload.tasks[0]?.conversationChannelId, "conversation-allowlist");
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
