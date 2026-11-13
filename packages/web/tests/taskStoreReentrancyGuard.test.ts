import assert from "node:assert/strict";
import api from "../src/api/client";
import { useTaskStore } from "../src/store/taskStore";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";

/**
 * Behavior (#210 re-entrancy guard): `/tasks` is a route-level surface, so every
 * rail switch back to Tasks remounts TasksPanel and re-fires loadServerTasks.
 * Re-fetching the unbounded /tasks/server and re-hydrating on each remount is
 * redundant work that forces a full re-render — the rail-switch jank Artea
 * reported.
 *
 * Completeness is event-based, not a wall-clock timer: once a load commits, the
 * socket keeps serverTasks live until it drops. loadServerTasks must therefore:
 *   - single-flight: concurrent callers await the SAME in-flight promise;
 *   - loaded skip: skip while loaded, WITHOUT a "non-empty" proxy (an empty
 *     board is a valid loaded state);
 *   - full initial load: request the complete server task set before rendering,
 *     without scroll-triggered network pagination;
 *   - generation gate: a load begun before a socket "disconnect" must not commit
 *     (its snapshot predates the gap);
 *   - catch-up: invalidateServerTasks (wired to "disconnect") forces the next
 *     load to re-fetch.
 *
 * Since task #8 the panel itself loads via the summary lanes
 * (loadActiveTaskSummaries), so the reconnect catch-up tests below assert the
 * summary path; loadServerTasks remains for non-panel consumers and keeps the
 * contract above.
 *
 * Run: `pnpm --filter @botiverse/raft-web test`.
 */

const originalGet = api.get.bind(api);

afterEach(() => {
  api.get = originalGet;
  useTaskStore.setState({
    tasks: [], loading: false, currentChannelId: null,
    tasksByChannelId: {}, loadingByChannelId: {}, loadedByChannelId: {},
    serverTasks: [], serverLoading: false, serverTasksLoaded: false, serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    serverTaskPages: {
      todo: { nextCursor: null, loading: false, loaded: false },
      in_progress: { nextCursor: null, loading: false, loaded: false },
      in_review: { nextCursor: null, loading: false, loaded: false },
      done: { nextCursor: null, loading: false, loaded: false },
      closed: { nextCursor: null, loading: false, loaded: false },
    },
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

const TASK = {
  id: "t1", messageId: "m1", channelId: "c1", taskNumber: 1, status: "todo",
  createdById: "u1", createdByType: "user", createdAt: "", updatedAt: "",
};

const SERVER_TASKS_URL = "/tasks/server";

// api.get mock that resolves immediately with `rows`, counting calls.
function mockServerTasks(rows: unknown[]) {
  let calls = 0;
  api.get = (async (url: string) => {
    assert.equal(url, SERVER_TASKS_URL);
    calls += 1;
    return { data: { tasks: rows } };
  }) as typeof api.get;
  return () => calls;
}

// api.get mock whose responses are resolved manually via the returned control.
function deferredServerTasks(rows: unknown[]) {
  let calls = 0;
  const resolvers: (() => void)[] = [];
  api.get = ((url: string) => {
    assert.equal(url, SERVER_TASKS_URL);
    calls += 1;
    return new Promise((res) => { resolvers.push(() => res({ data: { tasks: rows } })); });
  }) as typeof api.get;
  return { calls: () => calls, resolveAll: () => resolvers.forEach((r) => r()) };
}

test("a second load while loaded is skipped (no re-fetch)", async () => {
  const calls = mockServerTasks([TASK]);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls(), 1);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls(), 1, "loaded remount re-fetched instead of trusting the socket-maintained list");
});

test("an empty-but-loaded board does not re-fetch on remount (no non-empty proxy)", async () => {
  const calls = mockServerTasks([]); // legitimately empty server
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls(), 1);
  assert.equal(useTaskStore.getState().serverTasks.length, 0);
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls(), 1, "empty loaded board re-fetched every remount — validity used a non-empty proxy");
});

test("server Tasks loads the complete list in one request before enabling scroll", async () => {
  const tasks = Array.from({ length: 250 }, (_, index) => ({
    ...TASK,
    id: `task-${index}`,
    messageId: `message-${index}`,
    taskNumber: index + 1,
  }));
  const calls = mockServerTasks(tasks);

  await useTaskStore.getState().loadServerTasks();

  assert.equal(calls(), 1);
  assert.equal(useTaskStore.getState().serverTasks.length, 250);
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
});

test("concurrent callers share one in-flight fetch AND its completion", async () => {
  const ctl = deferredServerTasks([TASK]);
  const a = useTaskStore.getState().loadServerTasks();
  const b = useTaskStore.getState().loadServerTasks(); // while first in flight
  // Capture whether the second caller resolves only after completion (shared
  // promise) vs immediately (mere early-return dedup).
  let loadedWhenBResolved: boolean | undefined;
  const bDone = b.then(() => { loadedWhenBResolved = useTaskStore.getState().serverTasksLoaded; });
  assert.equal(ctl.calls(), 1, "concurrent second load stacked another fetch");
  ctl.resolveAll();
  await Promise.all([a, bDone]);
  assert.equal(loadedWhenBResolved, true, "second caller resolved before the load completed — not a shared promise");
});

test("a load in flight when the socket disconnects must not commit as loaded, and the next load re-fetches", async () => {
  const ctl = deferredServerTasks([TASK]);
  const p = useTaskStore.getState().loadServerTasks(); // starts under generation 0
  // Socket drops mid-flight -> generation bumps, list invalidated.
  useTaskStore.getState().invalidateServerTasks();
  ctl.resolveAll();
  await p;
  assert.equal(useTaskStore.getState().serverTasksLoaded, false, "a snapshot from before the reconnect gap was committed as current");

  // Next mount must catch up with a fresh fetch under the new generation.
  const calls2 = mockServerTasks([TASK]);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls2(), 1, "the invalidated list did not catch up after the gap");
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
});

test("invalidateServerTasks bumps the generation and forces a re-fetch", async () => {
  const calls = mockServerTasks([TASK]);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
  const gen = useTaskStore.getState().serverTasksGeneration;
  useTaskStore.getState().invalidateServerTasks();
  assert.equal(useTaskStore.getState().serverTasksLoaded, false);
  assert.equal(useTaskStore.getState().serverTasksGeneration, gen + 1, "generation did not advance on invalidate");
  await useTaskStore.getState().loadServerTasks();
  assert.equal(calls(), 2);
});

test("the socket 'disconnect' handler is wired to invalidateServerTasks", async () => {
  const calls = mockServerTasks([TASK]);
  await useTaskStore.getState().loadServerTasks();
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
  void calls;

  const handlers: Record<string, (data: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (data: unknown) => void) => { handlers[event] = handler; },
    off: () => {},
  };
  const cleanup = registerTaskRealtimeHandlers(socket);
  assert.equal(typeof handlers["disconnect"], "function", "no 'disconnect' handler — a socket drop can never invalidate serverTasks");
  handlers["disconnect"](undefined);
  assert.equal(useTaskStore.getState().serverTasksLoaded, false, "socket 'disconnect' did not invalidate serverTasks");
  cleanup();
});

test("after a disconnect mid-flight, a new-generation load issues its own fetch (not parked on the doomed old one)", async () => {
  const ctl = deferredServerTasks([TASK]);
  const p1 = useTaskStore.getState().loadServerTasks(); // generation 0, in flight
  assert.equal(ctl.calls(), 1);
  useTaskStore.getState().invalidateServerTasks(); // disconnect -> generation 1
  const p2 = useTaskStore.getState().loadServerTasks(); // generation 1 must fetch, not await p1
  assert.equal(ctl.calls(), 2, "new-generation caller parked on the doomed old-generation request instead of fetching");
  ctl.resolveAll();
  await Promise.all([p1, p2]);
  assert.equal(useTaskStore.getState().serverTasksLoaded, true, "new-generation load did not commit (stuck empty/stale after reconnect)");
});

test("a task created live during the fetch is preserved when the snapshot lands (no lost update)", async () => {
  // The snapshot GET returns the pre-event collection ([t1]); a task:created for
  // t2 lands via the realtime path while the GET is in flight. Committing the
  // snapshot must not drop t2.
  const ctl = deferredServerTasks([TASK]);
  const p = useTaskStore.getState().loadServerTasks();
  const TASK2 = { ...TASK, id: "t2", messageId: "m2", taskNumber: 2, channelType: "channel" as const };
  useTaskStore.getState().upsertTask(TASK2 as never); // realtime task:created mid-fetch
  ctl.resolveAll();
  await p;
  const ids = useTaskStore.getState().serverTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ["t1", "t2"], "the live-created task was dropped by the full-table snapshot overwrite");
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
});

test("an OPEN Tasks view catches up on reconnect (disconnect -> connect re-fetches)", async () => {
  // The panel path is the summary lanes (task #8): catch-up must refetch
  // those, never the legacy unbounded load.
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: { tasks: [], next_cursor: null } };
  }) as typeof api.get;
  useTaskStore.getState().registerServerTasksConsumer(); // TasksPanel mounted (server mode)
  await useTaskStore.getState().loadActiveTaskSummaries();
  assert.equal(urls.length, 3);

  const { handlers, cleanup } = wireSocket();
  handlers["disconnect"](undefined);          // gap: generation bumps, lanes reset
  handlers["connect"](undefined);             // reconnect: active consumer -> catch up
  await flush();
  assert.equal(urls.length, 6, "an open Tasks view stayed stale after reconnect instead of catching up");
  assert.ok(
    urls.every((url) => url.includes("detail=summary")),
    "reconnect catch-up fell back to the unparameterized /tasks/server load",
  );
  cleanup();
});

test("the initial app connect does not eager-fetch when no Tasks view is open", async () => {
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return { data: { tasks: [], next_cursor: null } };
  }) as typeof api.get;
  const { handlers, cleanup } = wireSocket();
  // No consumer registered, generation still 0 (no prior disconnect).
  handlers["connect"](undefined);
  await flush();
  assert.equal(calls, 0, "initial connect eager-fetched with no Tasks view open");
  cleanup();
});

test("with no Tasks view open, a reconnect does not fetch; the next mount does", async () => {
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: { tasks: [], next_cursor: null } };
  }) as typeof api.get;
  const { handlers, cleanup } = wireSocket();
  handlers["disconnect"](undefined);   // generation bumps
  handlers["connect"](undefined);      // no active consumer -> no eager fetch
  await flush();
  assert.equal(urls.length, 0, "a background reconnect eager-fetched with no Tasks view open");
  // Next TasksPanel mount loads lazily via the summary lanes.
  await useTaskStore.getState().loadActiveTaskSummaries();
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.includes("detail=summary")));
  cleanup();
});

// Screenshot review 5e: a per-channel load that arrives while the same channel
// is already loading used to return at once, before the tasks landed, so a
// caller reading tasksByChannelId right after `await loadTasks(id)` (the task
// window) saw an empty bucket. Concurrent callers share the in-flight request.
test("concurrent loadTasks callers for one channel share the fetch AND its completion", async () => {
  let calls = 0;
  let release: () => void = () => {};
  api.get = ((url: string) => {
    assert.equal(url, "/tasks/channel/c1");
    calls += 1;
    return new Promise((res) => { release = () => res({ data: { tasks: [TASK] } }); });
  }) as typeof api.get;
  const a = useTaskStore.getState().loadTasks("c1");
  const b = useTaskStore.getState().loadTasks("c1");
  let seenWhenBResolved: number | undefined;
  const bDone = b.then(() => { seenWhenBResolved = useTaskStore.getState().tasksByChannelId.c1?.length; });
  assert.equal(calls, 1, "the second caller stacked another fetch");
  release();
  await Promise.all([a, bDone]);
  assert.equal(seenWhenBResolved, 1, "the second caller resolved before the channel's tasks landed");
  assert.equal(useTaskStore.getState().loadingByChannelId.c1, false);

  // Once settled, a later call fetches again (no stale in-flight slot).
  const c = useTaskStore.getState().loadTasks("c1");
  assert.equal(calls, 2);
  release();
  await c;
});
