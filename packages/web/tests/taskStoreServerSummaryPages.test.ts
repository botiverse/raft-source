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
import { mergeTaskFields, useTaskStore } from "../src/store/taskStore";
import type { Task, TaskStatus } from "../src/store/taskStore";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";

/**
 * Behavior (task #8): the Tasks board must not first-open on the unbounded
 * 32MB full-row /tasks/server load. The panel path is now:
 *   - first screen: one ?detail=summary&status=<active>&limit=100 page per
 *     ACTIVE status (todo/in_progress/in_review — the API takes exactly one
 *     status per call);
 *   - done/closed: lazy keyset pages (next_cursor) on section expand and on a
 *     "Load more" affordance;
 *   - summary rows merge upgrade-only into serverTasks: a summary upsert never
 *     wipes fields a full row has (description et al.), and a full socket
 *     upsert still applies on top of a summary row;
 *   - reconnect catch-up refetches the summary lanes, never the legacy load.
 *
 * Run: `pnpm run test tests/taskStoreServerSummaryPages.test.ts` from packages/web.
 */

const originalGet = api.get.bind(api);

function emptyPages() {
  return {
    backlog: { nextCursor: null, loading: false, loaded: false },
    todo: { nextCursor: null, loading: false, loaded: false },
    in_progress: { nextCursor: null, loading: false, loaded: false },
    in_review: { nextCursor: null, loading: false, loaded: false },
    done: { nextCursor: null, loading: false, loaded: false },
    closed: { nextCursor: null, loading: false, loaded: false },
  };
}

afterEach(() => {
  api.get = originalGet;
  useTaskStore.setState({
    tasks: [], loading: false, currentChannelId: null,
    tasksByChannelId: {}, loadingByChannelId: {}, loadedByChannelId: {},
    serverTasks: [], serverLoading: false, serverTasksLoaded: false, serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    serverTaskPages: emptyPages(),
    taskMetadataByMessageId: {}, taskMessageIdByTaskId: {},
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// Wire the realtime handlers to a fake socket and return its captured handlers.
function wireSocket() {
  const handlers: Record<string, (data: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (data: unknown) => void) => { handlers[event] = handler; },
    off: () => {},
  };
  const cleanup = registerTaskRealtimeHandlers(socket);
  return { handlers, cleanup };
}

function summaryTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    messageId: "msg-1",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    taskNumber: 1,
    title: "Task one",
    status: "todo",
    revision: 1,
    createdById: "user-1",
    createdByType: "user",
    createdByName: "alice",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    source: "tasks",
    hasDescription: false,
    descriptionBytes: 0,
    ...overrides,
  };
}

// api.get mock that records every URL and answers via the responder.
function mockApi(responder: (url: string) => { tasks: unknown[]; next_cursor?: string | null }) {
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: responder(url) };
  }) as typeof api.get;
  return urls;
}

test("first screen fetches one summary page per active status and never the unbounded load", async () => {
  const urls = mockApi((url) => {
    assert.match(url, /detail=summary/);
    assert.match(url, /limit=100/);
    return { tasks: [], next_cursor: null };
  });
  await useTaskStore.getState().loadActiveTaskSummaries();

  assert.equal(urls.length, 3, "expected exactly one call per active status");
  const statuses = urls
    .map((u) => new URLSearchParams(u.split("?")[1]).get("status"))
    .sort();
  assert.deepEqual(statuses, ["in_progress", "in_review", "todo"]);
  assert.ok(
    urls.every((u) => u.startsWith("/tasks/server?")),
    "the panel path issued an unparameterized /tasks/server load",
  );

  const pages = useTaskStore.getState().serverTaskPages;
  for (const status of ["todo", "in_progress", "in_review"] as const) {
    assert.equal(pages[status].loaded, true, `${status} lane did not settle`);
  }
  assert.equal(pages.done.loaded, false, "done must stay lazy on first screen");
  assert.equal(pages.closed.loaded, false, "closed must stay lazy on first screen");
  assert.equal(useTaskStore.getState().serverLoading, false);
});

test("summary items commit into serverTasks and a remount does not refetch", async () => {
  const rows: Record<string, Task[]> = {
    todo: [summaryTask({ id: "t-todo", status: "todo" })],
    in_progress: [summaryTask({ id: "t-prog", status: "in_progress" })],
    in_review: [summaryTask({ id: "t-review", status: "in_review" })],
  };
  const urls = mockApi((url) => {
    const status = new URLSearchParams(url.split("?")[1]).get("status") as string;
    return { tasks: rows[status] ?? [], next_cursor: null };
  });

  await useTaskStore.getState().loadActiveTaskSummaries();
  const ids = useTaskStore.getState().serverTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ["t-prog", "t-review", "t-todo"]);

  await useTaskStore.getState().loadActiveTaskSummaries();
  assert.equal(urls.length, 3, "loaded remount refetched instead of trusting the socket-maintained list");
});

test("a done/closed lane walks with the opaque cursor and stops when exhausted", async () => {
  const urls = mockApi((url) => {
    if (url.includes("cursor=")) {
      return { tasks: [summaryTask({ id: "d2", taskNumber: 2, status: "done" })], next_cursor: null };
    }
    return { tasks: [summaryTask({ id: "d1", taskNumber: 1, status: "done" })], next_cursor: "opaque-cursor-1" };
  });

  await useTaskStore.getState().loadServerTaskStatusPage("done");
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes("cursor="), "first page must not send a cursor");
  assert.equal(useTaskStore.getState().serverTaskPages.done.nextCursor, "opaque-cursor-1");

  await useTaskStore.getState().loadServerTaskStatusPage("done");
  assert.equal(urls.length, 2);
  assert.ok(
    urls[1].includes(`cursor=${encodeURIComponent("opaque-cursor-1")}`),
    "second page must resume from the returned cursor",
  );
  assert.equal(useTaskStore.getState().serverTaskPages.done.nextCursor, null);

  await useTaskStore.getState().loadServerTaskStatusPage("done");
  assert.equal(urls.length, 2, "an exhausted lane kept fetching");

  const ids = useTaskStore.getState().serverTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ["d1", "d2"]);
});

test("mergeTaskFields: undefined incoming fields keep existing values, null still overwrites", () => {
  const existing = summaryTask({ description: "full body", claimedById: "user-9" });
  const incoming = summaryTask({ claimedById: null, title: "renamed" });
  delete (incoming as Record<string, unknown>).description;

  const merged = mergeTaskFields(existing, incoming);
  assert.equal(merged.description, "full body", "an unprojected field was wiped");
  assert.equal(merged.claimedById, null, "a defined incoming null must still apply (unclaim)");
  assert.equal(merged.title, "renamed");
});

test("a summary upsert never downgrades an existing full row", () => {
  const full: Task = { ...summaryTask(), description: "fetched body", hasDescription: true, descriptionBytes: 12 };
  useTaskStore.getState().upsertTask(full);

  const summary = summaryTask({ title: "renamed live" }); // no description key, like detail=summary
  useTaskStore.getState().upsertTask(summary);

  const stored = useTaskStore.getState().serverTasks.find((t) => t.id === full.id);
  assert.equal(stored?.title, "renamed live");
  assert.equal(stored?.description, "fetched body", "summary row wiped a fetched description");
});

test("a full upsert upgrades an existing summary row", () => {
  useTaskStore.getState().upsertTask(summaryTask()); // summary row, no description

  const full: Task = { ...summaryTask(), description: "socket body", revision: 2 };
  useTaskStore.getState().upsertTask(full);

  const stored = useTaskStore.getState().serverTasks.find((t) => t.id === full.id);
  assert.equal(stored?.description, "socket body", "full socket row did not apply on top of the summary row");
  assert.equal(stored?.revision, 2);
});

test("a live socket update landing mid-fetch is not rolled back by the page commit", async () => {
  let resolveFetch: (() => void) | null = null;
  api.get = ((url: string) => {
    assert.match(url, /detail=summary/);
    return new Promise((res) => {
      resolveFetch = () => res({ data: { tasks: [summaryTask({ title: "stale snapshot title", status: "done" })], next_cursor: null } });
    });
  }) as typeof api.get;

  const p = useTaskStore.getState().loadServerTaskStatusPage("done");
  // Socket task:updated lands while the page GET is in flight — newer data.
  useTaskStore.getState().upsertTask(summaryTask({ title: "live title", status: "done", description: "live body" }));
  resolveFetch!();
  await p;

  const stored = useTaskStore.getState().serverTasks.find((t) => t.id === "task-1");
  assert.equal(stored?.title, "live title", "the page commit rolled back a newer live update");
  assert.equal(stored?.description, "live body");
});

test("a summary page in flight across a disconnect does not commit", async () => {
  let resolveFetch: (() => void) | null = null;
  api.get = (() => new Promise((res) => {
    resolveFetch = () => res({ data: { tasks: [summaryTask({ status: "done" })], next_cursor: null } });
  })) as typeof api.get;

  const p = useTaskStore.getState().loadServerTaskStatusPage("done");
  useTaskStore.getState().invalidateServerTasks(); // socket drops mid-flight
  resolveFetch!();
  await p;

  assert.equal(useTaskStore.getState().serverTasks.length, 0, "a pre-gap snapshot was committed");
  assert.equal(useTaskStore.getState().serverTaskPages.done.loaded, false);
});

test("an open Tasks view catches up on reconnect via summary pages, never the unbounded load", async () => {
  const urls = mockApi(() => ({ tasks: [], next_cursor: null }));
  useTaskStore.getState().registerServerTasksConsumer(); // TasksPanel mounted (server mode)
  await useTaskStore.getState().loadActiveTaskSummaries();
  assert.equal(urls.length, 3);

  const { handlers, cleanup } = wireSocket();
  handlers["disconnect"](undefined); // gap: generation bumps, lanes reset
  handlers["connect"](undefined);    // reconnect: open view catches up
  await flush();

  assert.equal(urls.length, 6, "an open Tasks view stayed stale after reconnect");
  assert.ok(
    urls.every((u) => u.includes("detail=summary")),
    "reconnect catch-up fell back to the unparameterized full load",
  );
  cleanup();
});

test("a 400 (stale cursor) resets the lane so the next walk restarts from the beginning", async () => {
  api.get = (async () => {
    throw { response: { status: 400 } };
  }) as typeof api.get;
  useTaskStore.setState({
    serverTaskPages: {
      ...emptyPages(),
      done: { nextCursor: "dead-cursor", loading: false, loaded: true },
    },
  });

  // Silence the expected error log for this negative test.
  const originalError = console.error;
  console.error = () => {};
  try {
    await useTaskStore.getState().loadServerTaskStatusPage("done");
  } finally {
    console.error = originalError;
  }

  const lane = useTaskStore.getState().serverTaskPages.done;
  assert.equal(lane.nextCursor, null, "the dead cursor was kept for the next retry");
  assert.equal(lane.loaded, false, "the lane must restart its walk from page one");
  assert.equal(lane.loading, false);
});

test("lane state survives for TypeScript-exhaustive statuses", () => {
  const pages = useTaskStore.getState().serverTaskPages;
  const statuses: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "closed"];
  for (const status of statuses) {
    assert.ok(pages[status], `missing page state for ${status}`);
  }
});
