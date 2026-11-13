import assert from "node:assert/strict";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

import api from "../src/api/client";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";

/**
 * `amendTask` (edit a task's title / description from the web): the request
 * is PATCH /tasks/:taskId with only the fields being changed plus the OCC
 * token, the answered task replaces the store's copy, and a refusal (409
 * stale revision) leaves the store as it was.
 *
 * Run: `pnpm run test tests/taskStoreAmend.test.ts` from packages/web.
 */

const originalPatch = api.patch.bind(api);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    messageId: "msg-1",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    taskNumber: 7,
    title: "Old title",
    description: "Old details",
    status: "todo",
    revision: 3,
    createdById: "user-1",
    createdByType: "user",
    createdByName: "alice",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    source: "tasks",
    ...overrides,
  };
}

function seed(initial: Task) {
  useTaskStore.setState({
    tasks: [initial],
    currentChannelId: initial.channelId,
    tasksByChannelId: { [initial.channelId]: [initial] },
    serverTasks: [initial],
  });
}

afterEach(() => {
  api.patch = originalPatch;
  useTaskStore.setState({
    tasks: [], currentChannelId: null, tasksByChannelId: {}, serverTasks: [],
  });
});

test("amendTask sends only the changed fields with the revision and applies the answered task", async () => {
  seed(task());
  const calls: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body: unknown) => {
    calls.push({ url, body });
    return { data: { task: task({ title: "New title", revision: 4, updatedAt: "2026-10-31T00:00:00.000Z" }) } };
  }) as typeof api.patch;

  await useTaskStore.getState().amendTask("task-1", { title: "New title" }, 3);

  assert.deepEqual(calls, [{ url: "/tasks/task-1", body: { title: "New title", expectedRevision: 3 } }]);
  const state = useTaskStore.getState();
  assert.equal(state.tasks[0]!.title, "New title");
  assert.equal(state.tasks[0]!.revision, 4);
  assert.equal(state.tasksByChannelId["channel-1"]![0]!.title, "New title");
  assert.equal(state.serverTasks[0]!.title, "New title");
});

test("clearing the description sends clearDescription and applies the null description", async () => {
  seed(task());
  const bodies: unknown[] = [];
  api.patch = (async (_url: string, body: unknown) => {
    bodies.push(body);
    return { data: { task: task({ description: null, revision: 4 }) } };
  }) as typeof api.patch;

  await useTaskStore.getState().amendTask("task-1", { clearDescription: true });

  assert.deepEqual(bodies, [{ clearDescription: true }], "no expectedRevision key when none is given");
  assert.equal(useTaskStore.getState().tasks[0]!.description, null);
});

test("a stale revision rejects and leaves the store unchanged", async () => {
  const initial = task();
  seed(initial);
  api.patch = (async () => {
    throw Object.assign(new Error("Request failed with status code 409"), {
      response: { status: 409, data: { error: "task changed concurrently; read the current card and retry", currentRevision: 5 } },
    });
  }) as typeof api.patch;

  await assert.rejects(useTaskStore.getState().amendTask("task-1", { title: "Overwrite" }, 3));
  assert.equal(useTaskStore.getState().tasks[0]!.title, initial.title);
  assert.equal(useTaskStore.getState().tasks[0]!.revision, initial.revision);
});
