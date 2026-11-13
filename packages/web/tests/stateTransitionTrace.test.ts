import assert from "node:assert/strict";
import api from "../src/api/client";
import { __setStateTransitionEmitterForTest, emitStateTransitionTrace } from "../src/utils/stateTransitionTrace";
import {
  __resetStateViolationCoalescerForTest,
  __setStateViolationEmitterForTest,
  emitStateViolationTrace,
} from "../src/utils/stateViolationTrace";
import { useChannelStore } from "../src/store/channelStore";
import type { ApiChannel } from "../src/store/channelStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";
import { triggerServerReset } from "../src/store/serverResetRegistry";
// Server reset loads announcements (the task store test below answers that GET once);
// this used to come in through the inbox skeleton's imports.
import "../src/store/announcementStore";

function captureStateTransitions() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setStateTransitionEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

function captureStateViolations() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __resetStateViolationCoalescerForTest();
  __setStateViolationEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

function resetChannelStore() {
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: true,
  });
}

function resetTaskStore() {
  useTaskStore.setState({
    tasks: [],
    loading: false,
    currentChannelId: null,
    serverTasks: [],
    serverLoading: false,
    serverTasksLoaded: false,
    serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    taskMetadataByMessageId: {},
    taskMessageIdByTaskId: {},
  });
}

const PRODUCER_SEQ_VERDICT_BASIS = {
  same_activity: true,
  same_detail_kind: false,
  same_detail_presence: true,
  same_detail_bucket: false,
} as const;

function apiChannel(overrides: Partial<ApiChannel> = {}): ApiChannel {
  return {
    id: "channel-1",
    name: "general",
    description: null,
    type: "channel",
    createdAt: "2026-07-07T00:00:00.000Z",
    joined: true,
    lastMessageAt: null,
    ...overrides,
  };
}

function fullTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    messageId: "message-1",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    taskNumber: 1,
    title: "Task one",
    status: "todo",
    claimedByType: null,
    claimedById: null,
    claimedByName: null,
    claimedAt: null,
    completedAt: null,
    createdById: "user-1",
    createdByType: "user",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

test("state transition helper emits RFC 040 key/meta attrs", () => {
  const records = captureStateTransitions();
  emitStateTransitionTrace({
    domain: "channel",
    event: "patch",
    entityId: "channel-1",
    touched: 1,
    outcomeDetail: "applied",
  });
  __setStateTransitionEmitterForTest(null);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, "slock.state.transition");
  assert.deepEqual(records[0].attrs, {
    key: {
      domain: "channel",
      event: "patch",
      outcome: "applied",
      entityId: "channel-1",
    },
    meta: {
      outcomeDetail: "applied",
      touched: 1,
    },
  });
});

test("state violation helper coalesces repeated producer violations by stable signature", () => {
  const records = captureStateViolations();
  const violation = {
    domain: "agents" as const,
    entityId: "agent-1",
    violationKind: "producer_seq_conflict" as const,
    ...PRODUCER_SEQ_VERDICT_BASIS,
    event: "patch:trajectory-append",
    outcomeDetail: "producer_seq_conflict",
    serverSeq: 10,
    timestamp: 100,
    currentActivity: "working",
    projectedActivity: "working",
    currentDetailKind: "running_command",
    projectedDetailKind: "other",
  };

  emitStateViolationTrace(violation, 1_000);
  emitStateViolationTrace({ ...violation, serverSeq: 11, timestamp: 101 }, 2_000);
  emitStateViolationTrace({ ...violation, serverSeq: 12, timestamp: 102 }, 3_000);
  emitStateViolationTrace({ ...violation, serverSeq: 13, timestamp: 103 }, 61_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.equal(records.length, 2);
  assert.equal(records[0].name, "slock.state.violation");
  assert.deepEqual(records[0].attrs, {
    key: {
      domain: "agents",
      entityId: "agent-1",
      violationKind: "producer_seq_conflict",
      epoch: "unknown",
      ...PRODUCER_SEQ_VERDICT_BASIS,
    },
    meta: {
      count: 1,
      event: "patch:trajectory-append",
      outcomeDetail: "producer_seq_conflict",
      serverSeq: 10,
      timestamp: 100,
      currentActivity: "working",
      projectedActivity: "working",
      currentDetailKind: "running_command",
      projectedDetailKind: "other",
    },
  });
  assert.deepEqual(records[1].attrs, {
    key: {
      domain: "agents",
      entityId: "agent-1",
      violationKind: "producer_seq_conflict",
      epoch: "unknown",
      ...PRODUCER_SEQ_VERDICT_BASIS,
    },
    meta: {
      count: 3,
      event: "patch:trajectory-append",
      outcomeDetail: "producer_seq_conflict",
      serverSeq: 13,
      timestamp: 103,
      currentActivity: "working",
      projectedActivity: "working",
      currentDetailKind: "running_command",
      projectedDetailKind: "other",
    },
  });
  assert.equal("serverSeq" in (records[1].attrs.key as Record<string, unknown>), false);
  assert.equal("timestamp" in (records[1].attrs.key as Record<string, unknown>), false);
});

test("state violation coalescing partitions by entity, kind, and epoch", () => {
  const records = captureStateViolations();

  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 40_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-2",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 41_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "stale_flood",
    epoch: "epoch-a",
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: false,
    same_detail_bucket: false,
  }, 42_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-b",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 43_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 50_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.deepEqual(records.map((record) => record.attrs.key), [
    { domain: "agents", entityId: "agent-1", violationKind: "producer_seq_conflict", epoch: "epoch-a", ...PRODUCER_SEQ_VERDICT_BASIS },
    { domain: "agents", entityId: "agent-2", violationKind: "producer_seq_conflict", epoch: "epoch-a", ...PRODUCER_SEQ_VERDICT_BASIS },
    {
      domain: "agents",
      entityId: "agent-1",
      violationKind: "stale_flood",
      epoch: "epoch-a",
      same_activity: false,
      same_detail_kind: false,
      same_detail_presence: false,
      same_detail_bucket: false,
    },
    { domain: "agents", entityId: "agent-1", violationKind: "producer_seq_conflict", epoch: "epoch-b", ...PRODUCER_SEQ_VERDICT_BASIS },
  ]);
});

test("state violation coalescing partitions by verdict basis", () => {
  const records = captureStateViolations();

  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 40_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    same_activity: false,
    same_detail_kind: true,
    same_detail_presence: true,
    same_detail_bucket: true,
  }, 41_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "epoch-a",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 42_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.deepEqual(records.map((record) => record.attrs.key), [
    { domain: "agents", entityId: "agent-1", violationKind: "producer_seq_conflict", epoch: "epoch-a", ...PRODUCER_SEQ_VERDICT_BASIS },
    {
      domain: "agents",
      entityId: "agent-1",
      violationKind: "producer_seq_conflict",
      epoch: "epoch-a",
      same_activity: false,
      same_detail_kind: true,
      same_detail_presence: true,
      same_detail_bucket: true,
    },
  ]);
});

test("state violation signature keeps missing and explicit empty dimensions distinct", () => {
  const records = captureStateViolations();

  emitStateViolationTrace({
    domain: "agents",
    violationKind: "producer_seq_conflict",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 1_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "",
    violationKind: "producer_seq_conflict",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 2_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 3_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 4_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.deepEqual(records.map((record) => record.attrs.key), [
    { domain: "agents", entityId: "none", violationKind: "producer_seq_conflict", epoch: "unknown", ...PRODUCER_SEQ_VERDICT_BASIS },
    { domain: "agents", entityId: "", violationKind: "producer_seq_conflict", epoch: "unknown", ...PRODUCER_SEQ_VERDICT_BASIS },
    { domain: "agents", entityId: "agent-1", violationKind: "producer_seq_conflict", epoch: "unknown", ...PRODUCER_SEQ_VERDICT_BASIS },
    { domain: "agents", entityId: "agent-1", violationKind: "producer_seq_conflict", epoch: "", ...PRODUCER_SEQ_VERDICT_BASIS },
  ]);
});

test("state violation signature separator avoids tuple collisions", () => {
  const records = captureStateViolations();

  emitStateViolationTrace({
    domain: "agents",
    entityId: "a",
    violationKind: "producer_seq_conflict",
    epoch: "producer_seq_conflictb",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 1_000);
  emitStateViolationTrace({
    domain: "agents",
    entityId: "aproducer_seq_conflict",
    violationKind: "producer_seq_conflict",
    epoch: "b",
    ...PRODUCER_SEQ_VERDICT_BASIS,
  }, 2_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.equal(records.length, 2);
});

test("state violation coalescer reset clears buckets", () => {
  const records = captureStateViolations();
  const violation = {
    domain: "agents" as const,
    entityId: "agent-1",
    violationKind: "producer_seq_conflict" as const,
    ...PRODUCER_SEQ_VERDICT_BASIS,
  };

  emitStateViolationTrace(violation, 1_000);
  __resetStateViolationCoalescerForTest();
  emitStateViolationTrace(violation, 2_000);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();

  assert.equal(records.length, 2);
});

test("channel domain store actions emit state transition traces", () => {
  resetChannelStore();
  const records = captureStateTransitions();

  useChannelStore.getState().applyChannelPatch(apiChannel());
  useChannelStore.getState().applyChannelPatch(apiChannel({
    id: "dm-1",
    name: "Dozy",
    type: "dm",
    lastMessageAt: "2026-07-07T00:01:00.000Z",
  }));
  useChannelStore.getState().touchChannelActivity("channel-1", "2026-07-07T00:02:00.000Z");
  useChannelStore.getState().setActivityMuteState("channel-1", {
    activityMuted: true,
    muteFromSeq: "12",
  });

  __setStateTransitionEmitterForTest(null);
  assert.deepEqual(records.map((record) => (record.attrs.key as Record<string, unknown>).event), [
    "patch",
    "patch",
    "activity:touch",
    "activity-mute:set",
  ]);
  assert.deepEqual(records[0].attrs, {
    key: {
      domain: "channel",
      event: "patch",
      outcome: "applied",
      entityId: "channel-1",
    },
    meta: {
      outcomeDetail: "applied",
      touched: 1,
    },
  });
  assert.equal(useChannelStore.getState().channels[0]?.id, "channel-1");
  assert.equal(useChannelStore.getState().dmChannels[0]?.id, "dm-1");
  assert.equal(useChannelStore.getState().channelActivity["channel-1"], "2026-07-07T00:02:00.000Z");
  assert.deepEqual(records[1].attrs.key, {
    domain: "channel",
    event: "patch",
    outcome: "applied",
    entityId: "dm-1",
  });
  assert.deepEqual(records[1].attrs.meta, {
    outcomeDetail: "applied",
    touched: 1,
  });
  assert.deepEqual(records[2].attrs.key, {
    domain: "channel",
    event: "activity:touch",
    outcome: "applied",
    entityId: "channel-1",
  });
  assert.deepEqual(records[2].attrs.meta, {
    outcomeDetail: "applied",
    touched: 1,
  });
  assert.deepEqual(records[3].attrs.meta, {
    outcomeDetail: "muted",
    touched: 1,
  });
});

test("task domain store actions emit state transition traces", async () => {
  assert.deepEqual(useTaskStore.getState().tasks, []);
  assert.equal(useTaskStore.getState().loading, false);
  assert.deepEqual(useTaskStore.getState().serverTasks, []);
  assert.equal(useTaskStore.getState().serverLoading, false);

  resetTaskStore();
  const records = captureStateTransitions();
  const taskOne = fullTask();
  const taskServer = fullTask({
    id: "task-server",
    messageId: "message-server",
    taskNumber: 2,
  });

  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/tasks/channel/channel-1") return { data: { tasks: [taskOne] } };
    if (url === "/tasks/server") return { data: { tasks: [taskServer] } };
    throw new Error(`unexpected GET ${url}`);
  });
  vi.spyOn(api, "patch").mockImplementation(async (url: string, body?: unknown) => {
    if (url === "/tasks/task-1/status") {
      assert.deepEqual(body, { status: "done" });
      return { data: { task: fullTask({ status: "done", completedAt: "2026-07-07T00:03:00.000Z" }) } };
    }
    if (url === "/tasks/task-1/claim") {
      return { data: { task: fullTask({ status: "done", claimedByType: "agent", claimedById: "agent-1", claimedByName: "Dozy" }) } };
    }
    if (url === "/tasks/task-1/unclaim") {
      return { data: { task: fullTask({ status: "done", claimedByType: null, claimedById: null, claimedByName: null }) } };
    }
    throw new Error(`unexpected PATCH ${url}`);
  });
  vi.spyOn(api, "delete").mockImplementation(async (url: string) => {
    assert.equal(url, "/tasks/task-1");
    return { data: {} };
  });
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    if (url === "/tasks/convert-message") {
      assert.deepEqual(body, { messageId: "message-convert" });
      return { data: { task: fullTask({ id: "task-convert", messageId: "message-convert", taskNumber: 3 }) } };
    }
    throw new Error(`unexpected POST ${url}`);
  });

  await useTaskStore.getState().loadTasks("channel-1");
  await useTaskStore.getState().loadServerTasks();
  await useTaskStore.getState().updateTaskStatus("channel-1", "task-1", "done");
  await useTaskStore.getState().claimTask("channel-1", "task-1");
  await useTaskStore.getState().unclaimTask("channel-1", "task-1");
  await useTaskStore.getState().deleteTask("channel-1", "task-1");
  await useTaskStore.getState().convertMessage("message-convert");
  useTaskStore.getState().upsertTask(fullTask({ id: "task-upsert", messageId: "message-upsert", taskNumber: 4 }));
  useTaskStore.getState().removeTask("task-upsert");

  __setStateTransitionEmitterForTest(null);
  assert.deepEqual(records.map((record) => (record.attrs.key as Record<string, unknown>).event), [
    "hydrate:channel",
    "hydrate:server",
    "status",
    "claim",
    "unclaim",
    "delete",
    "convert-message",
    "upsert",
    "remove",
  ]);
  assert.deepEqual(records[0].attrs, {
    key: {
      domain: "task",
      event: "hydrate:channel",
      outcome: "applied",
      entityId: "channel-1",
    },
    meta: {
      outcomeDetail: "applied",
      touched: 1,
    },
  });
  assert.deepEqual(records[1].attrs.key, {
    domain: "task",
    event: "hydrate:server",
    outcome: "applied",
    entityId: "server-tasks",
  });
  assert.equal(useTaskStore.getState().tasks[0]?.id, "task-convert");
  assert.equal(useTaskStore.getState().loading, false);
  assert.equal(useTaskStore.getState().serverLoading, false);
  assert.equal(useTaskStore.getState().serverTasks.some((task) => task.id === "task-server"), true);
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-convert"]?.taskNumber, 3);
  assert.deepEqual(records.map((record) => (record.attrs.meta as Record<string, unknown>).outcomeDetail), [
    "applied",
    "applied",
    "done",
    "claimed",
    "unclaimed",
    "deleted",
    "converted",
    "todo",
    "removed",
  ]);
});

test("task store non-trace loading and create paths stay pinned for mutation gate", async () => {
  const consoleErrors: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
  });

  useTaskStore.setState({
    tasks: [fullTask({ id: "stale-task" })],
    loading: true,
    currentChannelId: "stale-channel",
    tasksByChannelId: { "stale-channel": [fullTask({ id: "stale-task" })] },
    loadingByChannelId: { "stale-channel": true },
    loadedByChannelId: { "stale-channel": true },
    serverTasks: [fullTask({ id: "stale-server-task" })],
    serverLoading: true,
    serverTasksLoaded: false,
    serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    taskMetadataByMessageId: { stale: { taskNumber: 99, status: "todo", claimedByName: null } },
    taskMessageIdByTaskId: { "stale-task": "stale" },
  });
  // Server reset also loads announcements; keep this unrelated fixture off the real API.
  vi.spyOn(api, "get").mockResolvedValueOnce({ data: { announcements: [] } });
  triggerServerReset();
  assert.deepEqual(useTaskStore.getState().tasks, []);
  assert.equal(useTaskStore.getState().loading, false);
  assert.equal(useTaskStore.getState().currentChannelId, null);
  assert.deepEqual(useTaskStore.getState().tasksByChannelId, {});
  assert.deepEqual(useTaskStore.getState().loadingByChannelId, {});
  assert.deepEqual(useTaskStore.getState().loadedByChannelId, {});
  assert.deepEqual(useTaskStore.getState().serverTasks, []);
  assert.equal(useTaskStore.getState().serverLoading, false);
  assert.deepEqual(useTaskStore.getState().taskMetadataByMessageId, {});
  assert.deepEqual(useTaskStore.getState().taskMessageIdByTaskId, {});

  let releaseLoadTasks!: (value: unknown) => void;
  const loadTasksPromise = new Promise((resolve) => {
    releaseLoadTasks = resolve;
  });
  let releaseStaleLoad!: (value: unknown) => void;
  const staleLoadPromise = new Promise((resolve) => {
    releaseStaleLoad = resolve;
  });
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/tasks/channel/channel-1") {
      await loadTasksPromise;
      return { data: { tasks: [fullTask()] } };
    }
    if (url === "/tasks/channel/stale-channel") {
      await staleLoadPromise;
      throw new Error("stale load failed");
    }
    if (url === "/tasks/channel/failing-channel") {
      throw new Error("load failed");
    }
    if (url === "/tasks/server") {
      throw new Error("server load failed");
    }
    throw new Error(`unexpected GET ${url}`);
  });
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    assert.equal(url, "/tasks/channel/channel-1");
    assert.deepEqual(body, { tasks: [{ title: "first" }, { title: "second" }] });
    return {
      data: {
        tasks: [
          fullTask({ id: "created-1", title: "first" }),
          fullTask({ id: "created-2", title: "second" }),
        ],
      },
    };
  });

  const pending = useTaskStore.getState().loadTasks("channel-1");
  assert.equal(useTaskStore.getState().loading, true);
  assert.equal(useTaskStore.getState().currentChannelId, "channel-1");
  releaseLoadTasks(undefined);
  await pending;
  assert.equal(useTaskStore.getState().loading, false);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-1"]);

  useTaskStore.setState({ loading: false, currentChannelId: null });
  const staleLoad = useTaskStore.getState().loadTasks("stale-channel");
  assert.equal(useTaskStore.getState().loading, true);
  assert.equal(useTaskStore.getState().currentChannelId, "stale-channel");
  useTaskStore.setState({ currentChannelId: "newer-channel" });
  releaseStaleLoad(undefined);
  await staleLoad;
  assert.equal(useTaskStore.getState().loading, true);
  assert.equal(useTaskStore.getState().currentChannelId, "newer-channel");
  useTaskStore.setState({ loading: false });

  await useTaskStore.getState().loadTasks("failing-channel");
  assert.equal(useTaskStore.getState().loading, false);
  assert.equal(useTaskStore.getState().currentChannelId, "failing-channel");

  useTaskStore.setState({ serverLoading: false });
  const serverLoad = useTaskStore.getState().loadServerTasks();
  assert.equal(useTaskStore.getState().serverLoading, true);
  await serverLoad;
  assert.equal(useTaskStore.getState().serverLoading, false);

  const created = await useTaskStore.getState().createTasks("channel-1", ["first", "second"]);
  assert.deepEqual(created.map((task) => task.id), ["created-1", "created-2"]);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-1"]);
  assert.deepEqual(consoleErrors.map((args) => args[0]), [
    "Failed to load tasks:",
    "Failed to load tasks:",
    "Failed to load server tasks:",
  ]);
});
