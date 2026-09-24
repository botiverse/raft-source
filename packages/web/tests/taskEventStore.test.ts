import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import api from "../src/api/client";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";
import { useTaskStore } from "../src/store/taskStore";
import type { Task, TaskHistoryEvent } from "../src/store/taskStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    createdByName: "Cindy",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

class FakeTaskSocket {
  private readonly emitter = new EventEmitter();

  on(event: string, handler: (data: any) => void) {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (data: any) => void) {
    this.emitter.off(event, handler);
  }

  emit(event: string, data: any) {
    this.emitter.emit(event, data);
  }
}

function resetTaskStore() {
  useTaskStore.setState({
    tasks: [],
    loading: false,
    currentChannelId: null,
    tasksByChannelId: {},
    loadingByChannelId: {},
    loadedByChannelId: {},
    serverTasks: [],
    serverLoading: false,
    serverTasksLoaded: false,
    serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    taskMetadataByMessageId: {},
    taskMessageIdByTaskId: {},
    taskHistoryByTaskId: {},
    taskHistoryLoadingByTaskId: {},
    taskHistoryErrorByTaskId: {},
    taskHistoryConsumersByTaskId: {},
    taskHistoryGeneration: 0,
  });
}

test("loadTasks preserves concurrent channel buckets while stale responses cannot pollute the classic projection", async (t) => {
  resetTaskStore();
  const channelOne = deferred<{ data: { tasks: Task[] } }>();
  const channelTwo = deferred<{ data: { tasks: Task[] } }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/tasks/channel/channel-1") return channelOne.promise;
    if (url === "/tasks/channel/channel-2") return channelTwo.promise;
    throw new Error(`unexpected GET ${url}`);
  });

  const firstLoad = useTaskStore.getState().loadTasks("channel-1");
  const secondLoad = useTaskStore.getState().loadTasks("channel-2");

  channelTwo.resolve({ data: { tasks: [fullTask({ id: "task-2", messageId: "message-2", channelId: "channel-2" })] } });
  await secondLoad;
  assert.equal(useTaskStore.getState().currentChannelId, "channel-2");
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-2"]);
  assert.equal(useTaskStore.getState().loading, false);
  assert.deepEqual(useTaskStore.getState().tasksByChannelId["channel-2"].map((task) => task.id), ["task-2"]);

  channelOne.resolve({ data: { tasks: [fullTask({ id: "task-1", messageId: "message-1", channelId: "channel-1" })] } });
  await firstLoad;
  assert.equal(useTaskStore.getState().currentChannelId, "channel-2");
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-2"]);
  assert.equal(useTaskStore.getState().loading, false);
  assert.deepEqual(useTaskStore.getState().tasksByChannelId["channel-1"].map((task) => task.id), ["task-1"]);
  assert.equal(useTaskStore.getState().loadedByChannelId["channel-1"], true);
  assert.equal(useTaskStore.getState().loadedByChannelId["channel-2"], true);
});

test("task realtime patch upserts idempotently, respects current channel, and reconciles serverTasks membership", () => {
  resetTaskStore();
  const socket = new FakeTaskSocket();
  const cleanup = registerTaskRealtimeHandlers(socket);
  try {
    useTaskStore.setState({
      currentChannelId: "channel-1",
      tasks: [
        fullTask({ id: "task-1", status: "todo" }),
        fullTask({ id: "task-existing-other", messageId: "message-existing-other", taskNumber: 99, status: "todo" }),
      ],
      serverTasks: [
        fullTask({ id: "task-1", status: "todo" }),
        fullTask({ id: "task-existing-other", messageId: "message-existing-other", taskNumber: 99, status: "todo" }),
      ],
    });

    socket.emit("task:updated", {
      channelId: "channel-1",
      task: fullTask({ id: "task-1", status: "in_progress", updatedAt: "2026-07-07T00:01:00.000Z" }),
    });
    socket.emit("task:updated", {
      channelId: "channel-1",
      task: fullTask({ id: "task-1", status: "in_progress", updatedAt: "2026-07-07T00:01:00.000Z" }),
    });

    assert.deepEqual(useTaskStore.getState().tasks.map((task) => `${task.id}:${task.status}`), [
      "task-1:in_progress",
      "task-existing-other:todo",
    ]);
    assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => `${task.id}:${task.status}`), [
      "task-1:in_progress",
      "task-existing-other:todo",
    ]);
    assert.equal(useTaskStore.getState().tasks.length, 2, "updating an existing task must replace, not duplicate");
    assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"]?.status, "in_progress");
    assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-1"], "message-1");

    socket.emit("task:created", {
      channelId: "channel-1",
      tasks: [fullTask({ id: "task-3", messageId: "message-3", channelId: "channel-1", taskNumber: 3 })],
    });
    assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-1", "task-existing-other", "task-3"]);
    assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => task.id), ["task-1", "task-existing-other", "task-3"]);

    socket.emit("task:created", {
      channelId: "channel-2",
      tasks: [fullTask({ id: "task-2", messageId: "message-2", channelId: "channel-2", taskNumber: 2 })],
    });
    assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-1", "task-existing-other", "task-3"]);
    assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => task.id), [
      "task-1",
      "task-existing-other",
      "task-3",
      "task-2",
    ]);
    assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-2"]?.status, "todo");
    assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-2"], "message-2");

    socket.emit("task:updated", {
      channelId: "dm-channel",
      task: fullTask({ id: "task-2", messageId: "message-2", channelId: "dm-channel", channelType: "dm" }),
    });
    assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => task.id), [
      "task-1",
      "task-existing-other",
      "task-3",
    ]);
    assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-2"]?.status, "todo");

    socket.emit("task:deleted", { channelId: "dm-channel", taskId: "task-2" });
    assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-2"], undefined);
    assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-2"], undefined);

    socket.emit("task:deleted", { channelId: "channel-1", taskId: "task-1" });
    assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-existing-other", "task-3"]);
    assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => task.id), ["task-existing-other", "task-3"]);
  } finally {
    cleanup();
  }
});

test("observed task realtime updates queue one history refresh without remounting", async (t) => {
  resetTaskStore();
  const firstHistory = deferred<{ data: { events: TaskHistoryEvent[] } }>();
  const secondHistory = deferred<{ data: { events: TaskHistoryEvent[] } }>();
  let historyRequests = 0;
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/tasks/task-1/history");
    historyRequests += 1;
    return historyRequests === 1 ? firstHistory.promise : secondHistory.promise;
  });

  const initial = fullTask({ revision: 1 });
  useTaskStore.setState({
    tasks: [initial],
    serverTasks: [initial],
    tasksByChannelId: { [initial.channelId]: [initial] },
  });
  const socket = new FakeTaskSocket();
  const cleanup = registerTaskRealtimeHandlers(socket);
  const stopObserving = useTaskStore.getState().registerTaskHistoryConsumer(initial.id);
  try {
    assert.equal(historyRequests, 1);
    socket.emit("task:updated", {
      channelId: initial.channelId,
      task: fullTask({ revision: 2, claimedByType: "agent", claimedById: "agent-2" }),
    });
    assert.equal(historyRequests, 1, "the first request should stay single-flight while it is pending");

    firstHistory.resolve({ data: { events: [{
      id: "event-1", eventType: "created", actorType: "user", actorName: "Cindy",
      createdAt: "2026-07-07T00:00:00.000Z", payload: { taskNumber: 1, status: "todo" },
    }] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(historyRequests, 2, "the socket update should queue one follow-up request");

    secondHistory.resolve({ data: { events: [{
      id: "event-2", eventType: "assignee_changed", actorType: "agent", actorName: "agent-2",
      createdAt: "2026-07-07T00:01:00.000Z", payload: { assigneeType: "agent", assigneeId: "agent-2" },
    }] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(useTaskStore.getState().taskHistoryByTaskId[initial.id]?.[0]?.id, "event-2");
  } finally {
    stopObserving();
    cleanup();
  }
});

test("loadServerTasks hydrates task-domain metadata and settles loading state", async (t) => {
  resetTaskStore();
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/tasks/server");
    return {
      data: {
        tasks: [
          fullTask({ id: "task-4", messageId: "message-4", taskNumber: 4, status: "todo" }),
          fullTask({ id: "task-5", messageId: "message-5", taskNumber: 5, status: "done" }),
        ],
      },
    };
  });

  await useTaskStore.getState().loadServerTasks();

  assert.equal(useTaskStore.getState().serverLoading, false);
  assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => `${task.id}:${task.status}`), [
    "task-4:todo",
    "task-5:done",
  ]);
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-4"]?.taskNumber, 4);
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-5"]?.status, "done");
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-4"], "message-4");
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-5"], "message-5");
});

test("large server task hydration clones each metadata index at most once", async (t) => {
  resetTaskStore();
  const tasks = Array.from({ length: 5_000 }, (_, index) => fullTask({
    id: `task-${index}`,
    messageId: `message-${index}`,
    taskNumber: index,
  }));

  let metadataOwnKeysReads = 0;
  let taskIdOwnKeysReads = 0;
  const taskMetadataByMessageId = new Proxy(useTaskStore.getState().taskMetadataByMessageId, {
    ownKeys(target) {
      metadataOwnKeysReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  const taskMessageIdByTaskId = new Proxy(useTaskStore.getState().taskMessageIdByTaskId, {
    ownKeys(target) {
      taskIdOwnKeysReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  useTaskStore.setState({ taskMetadataByMessageId, taskMessageIdByTaskId });

  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/tasks/server");
    return { data: { tasks } };
  });

  await useTaskStore.getState().loadServerTasks();

  assert.equal(metadataOwnKeysReads, 1, "metadata cache must be copied once, not once per task");
  assert.equal(taskIdOwnKeysReads, 1, "task-id index must be copied once, not once per task");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-4999"]?.taskNumber, 4_999);
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-4999"], "message-4999");

  const hydratedMetadata = useTaskStore.getState().taskMetadataByMessageId;
  const hydratedTaskIds = useTaskStore.getState().taskMessageIdByTaskId;
  metadataOwnKeysReads = 0;
  taskIdOwnKeysReads = 0;
  const unchangedMetadata = new Proxy(hydratedMetadata, {
    ownKeys(target) {
      metadataOwnKeysReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  const unchangedTaskIds = new Proxy(hydratedTaskIds, {
    ownKeys(target) {
      taskIdOwnKeysReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  useTaskStore.setState({
    taskMetadataByMessageId: unchangedMetadata,
    taskMessageIdByTaskId: unchangedTaskIds,
  });

  await useTaskStore.getState().loadServerTasks();

  assert.equal(metadataOwnKeysReads, 0, "an unchanged refresh must reuse the metadata cache");
  assert.equal(taskIdOwnKeysReads, 0, "an unchanged refresh must reuse the task-id index");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId, unchangedMetadata);
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId, unchangedTaskIds);
});

test("task removal evicts only the removed task metadata, even when the message id is recovered from visible lists", () => {
  resetTaskStore();
  const metadata = {
    "message-1": {
      messageId: "message-1",
      taskNumber: 1,
      status: "todo" as const,
      claimedByName: null,
    },
    "message-other": {
      messageId: "message-other",
      taskNumber: 99,
      status: "done" as const,
      claimedByName: "Cody",
    },
    "message-server": {
      messageId: "message-server",
      taskNumber: 100,
      status: "todo" as const,
      claimedByName: null,
    },
  };
  useTaskStore.setState({
    tasks: [fullTask({ id: "task-1", messageId: "message-1" })],
    serverTasks: [fullTask({ id: "task-server", messageId: "message-server" })],
    taskMetadataByMessageId: metadata,
    taskMessageIdByTaskId: {
      "task-other": "message-other",
    },
  });

  useTaskStore.getState().removeTask("task-1");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"], undefined);
  assert.deepEqual(useTaskStore.getState().taskMetadataByMessageId["message-other"], metadata["message-other"]);
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-other"], "message-other");
  assert.equal(useTaskStore.getState().tasks.length, 0);
  assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => task.id), ["task-server"]);

  useTaskStore.getState().removeTask("task-server");
  assert.deepEqual(useTaskStore.getState().serverTasks, []);
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-server"], undefined);
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-other"]?.taskNumber, 99);

  const beforeUnknownMetadata = useTaskStore.getState().taskMetadataByMessageId;
  const beforeUnknownMapping = useTaskStore.getState().taskMessageIdByTaskId;
  useTaskStore.setState({
    taskMessageIdByTaskId: {
      ...beforeUnknownMapping,
      "task-with-missing-metadata": "message-with-missing-metadata",
    },
  });
  const beforeMissingMetadata = useTaskStore.getState().taskMetadataByMessageId;
  useTaskStore.getState().removeTask("task-with-missing-metadata");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId, beforeMissingMetadata);

  useTaskStore.getState().removeTask("missing-task");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId, beforeUnknownMetadata);
  assert.equal(useTaskStore.getState().taskMessageIdByTaskId["task-other"], "message-other");
});

test("local task intents patch task metadata before any socket echo", async (t) => {
  resetTaskStore();
  useTaskStore.setState({
    currentChannelId: "channel-1",
    tasks: [fullTask({ id: "task-1", status: "todo", claimedByName: null })],
    serverTasks: [fullTask({ id: "task-1", status: "todo", claimedByName: null })],
  });

  t.mock.method(api, "patch", async (url: string, body?: unknown) => {
    if (url === "/tasks/task-1/status") {
      assert.deepEqual(body, { status: "done" });
      return { data: { task: fullTask({ id: "task-1", status: "done", completedAt: "2026-07-07T00:02:00.000Z" }) } };
    }
    if (url === "/tasks/task-1/claim") {
      return { data: { task: fullTask({ id: "task-1", status: "done", claimedByType: "agent", claimedById: "agent-1", claimedByName: "Dozy" }) } };
    }
    if (url === "/tasks/task-1/unclaim") {
      return { data: { task: fullTask({ id: "task-1", status: "done", claimedByType: null, claimedById: null, claimedByName: null }) } };
    }
    throw new Error(`unexpected PATCH ${url}`);
  });
  t.mock.method(api, "delete", async (url: string) => {
    assert.equal(url, "/tasks/task-1");
    return { data: {} };
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/tasks/convert-message");
    assert.deepEqual(body, { messageId: "message-convert" });
    return {
      data: {
        task: fullTask({
          id: "task-convert",
          messageId: "message-convert",
          taskNumber: 10,
          title: "Converted message",
        }),
      },
    };
  });

  await useTaskStore.getState().updateTaskStatus("channel-1", "task-1", "done");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"]?.status, "done");
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => `${task.id}:${task.status}`), ["task-1:done"]);
  assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => `${task.id}:${task.status}`), ["task-1:done"]);

  await useTaskStore.getState().claimTask("channel-1", "task-1");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"]?.claimedByName, "Dozy");
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => `${task.id}:${task.claimedByName}`), ["task-1:Dozy"]);
  assert.deepEqual(useTaskStore.getState().serverTasks.map((task) => `${task.id}:${task.claimedByName}`), ["task-1:Dozy"]);

  await useTaskStore.getState().unclaimTask("channel-1", "task-1");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"]?.claimedByName, null);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => `${task.id}:${task.claimedByName}`), ["task-1:null"]);

  await useTaskStore.getState().deleteTask("channel-1", "task-1");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"], undefined);
  assert.deepEqual(useTaskStore.getState().tasks, []);
  assert.deepEqual(useTaskStore.getState().serverTasks, []);

  const converted = await useTaskStore.getState().convertMessage("message-convert");
  assert.equal(converted.id, "task-convert");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-convert"]?.taskNumber, 10);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["task-convert"]);
});

test("unassigned todo -> in_progress uses the authoritative claim/start transition", async (t) => {
  resetTaskStore();
  const unassigned = fullTask({ id: "task-1", status: "todo", claimedById: null, claimedAt: null });
  useTaskStore.setState({
    currentChannelId: "channel-1",
    tasks: [unassigned],
    serverTasks: [unassigned],
  });

  let patchCalls = 0;
  t.mock.method(api, "patch", async (url: string, body?: unknown) => {
    patchCalls += 1;
    assert.equal(url, "/tasks/task-1/claim");
    assert.equal(body, undefined);
    return {
      data: {
        task: fullTask({
          id: "task-1",
          status: "in_progress",
          claimedByType: "user",
          claimedById: "user-1",
          claimedByName: "Cindy",
          claimedAt: "2026-07-13T01:30:00.000Z",
        }),
      },
    };
  });

  await useTaskStore.getState().updateTaskStatus("channel-1", "task-1", "in_progress");

  assert.equal(patchCalls, 1);
  assert.equal(useTaskStore.getState().tasks[0]?.status, "in_progress");
  assert.equal(useTaskStore.getState().tasks[0]?.claimedById, "user-1");
  assert.equal(useTaskStore.getState().serverTasks[0]?.status, "in_progress");
  assert.equal(useTaskStore.getState().taskMetadataByMessageId["message-1"]?.status, "in_progress");
});

test("assigned todo -> in_progress remains an explicit status transition", async (t) => {
  resetTaskStore();
  const assigned = fullTask({
    id: "task-1",
    status: "todo",
    claimedByType: "user",
    claimedById: "user-2",
    claimedByName: "Box",
    claimedAt: null,
  });
  useTaskStore.setState({
    currentChannelId: "channel-1",
    tasks: [assigned],
    serverTasks: [assigned],
  });

  t.mock.method(api, "patch", async (url: string, body?: unknown) => {
    assert.equal(url, "/tasks/task-1/status");
    assert.deepEqual(body, { status: "in_progress" });
    return {
      data: {
        task: fullTask({
          ...assigned,
          status: "in_progress",
          claimedAt: "2026-07-13T01:31:00.000Z",
        }),
      },
    };
  });

  await useTaskStore.getState().updateTaskStatus("channel-1", "task-1", "in_progress");

  assert.equal(useTaskStore.getState().tasks[0]?.status, "in_progress");
  assert.equal(useTaskStore.getState().tasks[0]?.claimedById, "user-2");
});
