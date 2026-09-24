import { create } from "zustand";
import api from "../api/client";
import type { TaskStatus } from "@botiverse/raft-shared";
import {
  updateTaskMetadataCache,
  updateTaskMetadataCacheBatch,
} from "../utils/taskMetadata";
import type {
  TaskMetadataUpdate,
} from "../utils/taskMetadata";
import { registerServerReset } from "./serverResetRegistry";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { taskTraceStateChanged, transitionOutcomeDetail } from "../utils/stateTransitionChange";

export type { TaskStatus };

export interface TaskHistoryEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface Task {
  id: string;
  /** Same as id for message-based tasks; legacy tasks use their own ID */
  messageId: string;
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread";
  taskNumber: number;
  title: string;
  description?: string | null;
  /** Monotonic task projection revision used for amendment/OCC freshness. */
  revision?: number;
  taskCurrentProjection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: boolean;
    amendedAt: string | null;
    amendedByType: "user" | "agent" | "system" | null;
    amendedByName: string | null;
    source: "tasks_current_projection";
  };
  status: TaskStatus;
  claimedByType?: "agent" | "user" | null;
  claimedById?: string | null;
  claimedByName?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  createdById: string;
  createdByType: "agent" | "user";
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  /** True for tasks from the deprecated tasks table (not message-based) */
  isLegacy?: boolean;
}

interface TaskState {
  tasks: Task[];
  loading: boolean;
  currentChannelId: string | null;
  tasksByChannelId: Record<string, Task[]>;
  loadingByChannelId: Record<string, boolean>;
  loadedByChannelId: Record<string, boolean>;
  serverTasks: Task[];
  serverLoading: boolean;
  /** True once a full /tasks/server load has committed under the current
   *  connection generation and the socket has kept serverTasks live since.
   *  Empty-but-loaded is a valid state (an empty server has 0 tasks, or all
   *  were deleted live) — validity is this flag, never a "non-empty" proxy. */
  serverTasksLoaded: boolean;
  /** Bumped every time the socket drops (invalidateServerTasks). A load that
   *  started under an older generation must NOT commit serverTasksLoaded=true —
   *  its snapshot predates the reconnect gap and may be missing events. */
  serverTasksGeneration: number;
  taskMetadataByMessageId: Record<string, TaskMetadataUpdate>;
  taskMessageIdByTaskId: Record<string, string>;
  /** Canonical history read model for open task dialogs. */
  taskHistoryByTaskId: Record<string, TaskHistoryEvent[]>;
  taskHistoryLoadingByTaskId: Record<string, boolean>;
  taskHistoryErrorByTaskId: Record<string, boolean>;
  taskHistoryConsumersByTaskId: Record<string, number>;
  taskHistoryGeneration: number;
  loadTasks: (channelId: string) => Promise<void>;
  loadServerTasks: () => Promise<void>;
  /** Invalidate serverTasks completeness (wired to socket "disconnect"): mark
   *  it un-loaded and bump the connection generation so any in-flight load
   *  cannot commit as current. Lazy — does not re-fetch; catch-up happens on the
   *  next mount, or immediately via catchUpServerTasksOnReconnect if a Tasks view
   *  is currently open. */
  invalidateServerTasks: () => void;
  /** Count of mounted server-Tasks views. A TasksPanel in server mode
   *  registers on mount and unregisters on unmount so reconnect catch-up only
   *  fetches when someone is actually looking. */
  serverTasksActiveConsumers: number;
  registerServerTasksConsumer: () => void;
  unregisterServerTasksConsumer: () => void;
  /** Wired to socket "connect": if a Tasks view is open AND the list was
   *  invalidated by a prior disconnect (generation advanced, not loaded),
   *  re-fetch so an open-and-idle Tasks view becomes consistent after a
   *  reconnect instead of staying stale until the next mount. Does NOT fetch on
   *  the initial app connect (generation 0) or when no Tasks view is open. */
  catchUpServerTasksOnReconnect: () => void;
  createTasks: (channelId: string, titles: string[]) => Promise<Task[]>;
  claimTask: (channelId: string, taskId: string) => Promise<void>;
  unclaimTask: (channelId: string, taskId: string) => Promise<void>;
  updateTaskStatus: (channelId: string, taskId: string, status: TaskStatus) => Promise<void>;
  updateTaskAssignee: (
    channelId: string,
    taskId: string,
    assignee: { type: "user" | "agent"; id: string } | null,
    expectedRevision?: number,
  ) => Promise<void>;
  loadTaskHistory: (taskId: string) => Promise<void>;
  registerTaskHistoryConsumer: (taskId: string) => () => void;
  deleteTask: (channelId: string, taskId: string) => Promise<void>;
  convertMessage: (messageId: string) => Promise<Task>;
  // Called by socket events to update a single task in place
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
}

function shouldIncludeInServerTasks(task: Task): boolean {
  return task.channelType === "channel" || task.channelType === "private" || task.channelType === "joint";
}

function upsertTaskInList(list: Task[], task: Task): Task[] {
  const index = list.findIndex((item) => item.id === task.id);
  if (index === -1) return [...list, task];
  const next = [...list];
  next[index] = task;
  return next;
}

function removeTaskFromList(list: Task[], taskId: string): Task[] {
  return list.filter((task) => task.id !== taskId);
}

function findKnownTask(state: TaskState, taskId: string): Task | null {
  return state.tasks.find((task) => task.id === taskId)
    ?? state.serverTasks.find((task) => task.id === taskId)
    ?? Object.values(state.tasksByChannelId).flat().find((task) => task.id === taskId)
    ?? null;
}

function taskProjectionChanged(previous: Task, next: Task): boolean {
  return previous.revision !== next.revision
    || previous.updatedAt !== next.updatedAt
    || previous.status !== next.status
    || previous.claimedByType !== next.claimedByType
    || previous.claimedById !== next.claimedById
    || previous.claimedByName !== next.claimedByName
    || previous.title !== next.title
    || previous.description !== next.description;
}

function patchTaskState(state: TaskState, task: Task): Partial<TaskState> {
  const taskExists = state.tasks.some((item) => item.id === task.id);
  const tasks = taskExists
    ? state.tasks.map((item) => (item.id === task.id ? task : item))
    : state.currentChannelId === task.channelId
      ? [...state.tasks, task]
      : state.tasks;

  let serverTasks = state.serverTasks;
  if (shouldIncludeInServerTasks(task)) {
    serverTasks = upsertTaskInList(state.serverTasks, task);
  } else {
    serverTasks = removeTaskFromList(state.serverTasks, task.id);
  }

  const channelTasks = state.tasksByChannelId[task.channelId] ?? [];
  const tasksByChannelId = {
    ...state.tasksByChannelId,
    [task.channelId]: upsertTaskInList(channelTasks, task),
  };

  return {
    tasks,
    tasksByChannelId,
    serverTasks,
    taskMetadataByMessageId: updateTaskMetadataCache(state.taskMetadataByMessageId, task),
    taskMessageIdByTaskId: {
      ...state.taskMessageIdByTaskId,
      [task.id]: task.messageId,
    },
  };
}

function hydrateTaskMetadataState(
  state: TaskState,
  tasks: Task[],
): Pick<TaskState, "taskMetadataByMessageId" | "taskMessageIdByTaskId"> {
  let taskMessageIdByTaskId = state.taskMessageIdByTaskId;
  for (const task of tasks) {
    if (taskMessageIdByTaskId[task.id] === task.messageId) continue;
    if (taskMessageIdByTaskId === state.taskMessageIdByTaskId) {
      taskMessageIdByTaskId = { ...state.taskMessageIdByTaskId };
    }
    taskMessageIdByTaskId[task.id] = task.messageId;
  }
  return {
    taskMetadataByMessageId: updateTaskMetadataCacheBatch(state.taskMetadataByMessageId, tasks),
    taskMessageIdByTaskId,
  };
}

function removeTaskState(state: TaskState, taskId: string): Partial<TaskState> {
  const knownTask = state.tasks.find((task) => task.id === taskId)
    ?? state.serverTasks.find((task) => task.id === taskId)
    ?? Object.values(state.tasksByChannelId).flat().find((task) => task.id === taskId)
    ?? null;
  const messageId = knownTask?.messageId ?? state.taskMessageIdByTaskId[taskId] ?? null;
  let taskMetadataByMessageId = state.taskMetadataByMessageId;
  if (messageId && taskMetadataByMessageId[messageId]) {
    taskMetadataByMessageId = { ...taskMetadataByMessageId };
    delete taskMetadataByMessageId[messageId];
  }
  const taskMessageIdByTaskId = { ...state.taskMessageIdByTaskId };
  delete taskMessageIdByTaskId[taskId];
  const tasksByChannelId = Object.fromEntries(
    Object.entries(state.tasksByChannelId).map(([channelId, tasks]) => [
      channelId,
      removeTaskFromList(tasks, taskId),
    ]),
  );
  return {
    tasks: removeTaskFromList(state.tasks, taskId),
    tasksByChannelId,
    serverTasks: removeTaskFromList(state.serverTasks, taskId),
    taskMetadataByMessageId,
    taskMessageIdByTaskId,
  };
}

function reduceTaskWithTrace(
  state: TaskState,
  event: string,
  entityId: string,
  reduce: (state: TaskState) => Partial<TaskState>,
  outcomeDetail = "applied",
): Partial<TaskState> {
  const next = reduce(state);
  const touched = taskTraceStateChanged(state as unknown as Record<string, unknown>, next as Record<string, unknown>) ? 1 : 0;
  emitStateTransitionTrace({
    domain: "task",
    event,
    entityId,
    touched,
    outcomeDetail: transitionOutcomeDetail(touched, outcomeDetail),
  });
  return next;
}

// In-flight /tasks/server load, keyed by the connection generation it started
// under. Concurrent callers of the SAME generation await the SAME promise (true
// single-flight); a caller under a NEWER generation (after a disconnect/server
// switch) is not blocked by the doomed older-generation request and starts its
// own fetch.
let inFlightServerLoad: { generation: number; promise: Promise<void> } | null = null;

// Task history is fetched only while a task dialog is mounted. Keep one
// request per task and queue a single follow-up when a realtime task update
// arrives during the current request, so a stale response cannot hide the
// event that caused the update.
const inFlightTaskHistory = new Map<string, { generation: number; promise: Promise<void> }>();
const pendingTaskHistoryRefresh = new Set<string>();

function requestTaskHistoryRefreshIfObserved(taskId: string, get: () => TaskState): void {
  if ((get().taskHistoryConsumersByTaskId[taskId] ?? 0) === 0) return;
  if (inFlightTaskHistory.get(taskId)?.generation === get().taskHistoryGeneration) {
    pendingTaskHistoryRefresh.add(taskId);
    return;
  }
  void get().loadTaskHistory(taskId);
}

// While a load is in flight, the ids of tasks mutated live (socket
// task:created/updated/deleted, or local task mutations) are recorded here so
// the landing snapshot can be merged with those deltas instead of overwriting
// them — otherwise a GET that raced a live event would silently drop it.
let loadTouchedIds: Set<string> | null = null;

// Merge a /tasks/server snapshot with the live task mutations that landed while
// it was in flight. The snapshot is the authoritative base; for any id touched
// live during the fetch, the live store value wins (updated -> live value,
// removed -> dropped, created -> appended). With no live mutations the snapshot
// is returned unchanged. This makes committing the snapshot lossless w.r.t.
// concurrent socket events.
function mergeServerTasksSnapshot(snapshot: Task[], touched: Set<string>, liveNow: Task[]): Task[] {
  if (touched.size === 0) return snapshot;
  const liveById = new Map(liveNow.map((t) => [t.id, t]));
  const emitted = new Set<string>();
  const result: Task[] = [];
  for (const t of snapshot) {
    emitted.add(t.id);
    if (!touched.has(t.id)) {
      result.push(t);
      continue;
    }
    const live = liveById.get(t.id);
    if (live) result.push(live); // updated live; if absent -> removed live, drop
  }
  for (const id of touched) {
    if (!emitted.has(id)) {
      const live = liveById.get(id); // created live during the fetch, not in snapshot
      if (live) result.push(live);
    }
  }
  return result;
}

export const useTaskStore = create<TaskState>((set, get) => ({
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

  loadTasks: async (channelId) => {
    if (get().loadingByChannelId[channelId]) return;
    set((state) => ({
      loading: true,
      currentChannelId: channelId,
      loadingByChannelId: {
        ...state.loadingByChannelId,
        [channelId]: true,
      },
    }));
    try {
      const { data } = await api.get(`/tasks/channel/${channelId}`);
      const tasks = (data as { tasks: Task[] }).tasks;
      set((state) => reduceTaskWithTrace(
        state,
        "hydrate:channel",
        channelId,
        (current) => ({
          ...(current.currentChannelId === channelId ? { tasks, loading: false } : {}),
          tasksByChannelId: {
            ...current.tasksByChannelId,
            [channelId]: tasks,
          },
          loadingByChannelId: {
            ...current.loadingByChannelId,
            [channelId]: false,
          },
          loadedByChannelId: {
            ...current.loadedByChannelId,
            [channelId]: true,
          },
          ...hydrateTaskMetadataState(current, tasks),
        }),
      ));
    } catch (err) {
      console.error("Failed to load tasks:", err);
      set((state) => ({
        ...(state.currentChannelId === channelId ? { loading: false } : {}),
        loadingByChannelId: {
          ...state.loadingByChannelId,
          [channelId]: false,
        },
        loadedByChannelId: {
          ...state.loadedByChannelId,
          [channelId]: true,
        },
      }));
    }
  },

  loadServerTasks: async () => {
    // Re-entrancy guard (#210): TasksRoute is route-level, so every rail switch
    // back to Tasks remounts TasksPanel and re-fires this load. Re-fetching the
    // server-wide task list and re-hydrating the whole list on each remount is
    // redundant work that also forces a full re-render.
    //
    // Completeness is event-based, not time-based: once a full load commits, the
    // socket (task:created/updated/deleted) upserts serverTasks in place, so the
    // list stays complete until the socket drops. invalidateServerTasks() (wired
    // to socket "disconnect") flips serverTasksLoaded false and bumps the
    // connection generation — the only moment the list can silently go stale
    // (a reconnect resumes with no task-event replay).
    //  - loaded skip: if loaded (even if the list is legitimately empty) and not
    //    invalidated, trust the socket-maintained list — no timer/clock, and no
    //    "non-empty" proxy that would refetch an empty board every remount.
    //  - single-flight, generation-keyed: same-generation callers share one
    //    fetch; a newer-generation caller (post disconnect/switch) is NOT parked
    //    on the doomed old request and issues its own fetch.
    //  - generation gate: a load begun before a disconnect must not commit — its
    //    snapshot predates the gap.
    //  - lossless commit: the snapshot is merged with live task mutations that
    //    raced the fetch, so an interleaved task:created/deleted is never
    //    dropped by the full-table response.
    if (get().serverTasksLoaded) return;
    const startGeneration = get().serverTasksGeneration;
    if (inFlightServerLoad && inFlightServerLoad.generation === startGeneration) {
      return inFlightServerLoad.promise;
    }
    const touched = new Set<string>();
    const promise = (async () => {
      set({ serverLoading: true });
      loadTouchedIds = touched;
      try {
        const { data } = await api.get("/tasks/server");
        const snapshot = (data as { tasks: Task[] }).tasks;
        if (get().serverTasksGeneration !== startGeneration) {
          // The socket dropped (or the server switched) while this request was
          // in flight; the snapshot predates the gap. Don't commit — leave it
          // stale so the next mount refetches under the new generation.
          return;
        }
        const merged = mergeServerTasksSnapshot(snapshot, touched, get().serverTasks);
        set((state) => reduceTaskWithTrace(
          state,
          "hydrate:server",
          "server-tasks",
          (current) => ({
            serverTasks: merged,
            serverTasksLoaded: true,
            ...hydrateTaskMetadataState(current, merged),
          }),
        ));
      } catch (err) {
        console.error("Failed to load server tasks:", err);
      } finally {
        if (loadTouchedIds === touched) loadTouchedIds = null;
      }
    })();
    inFlightServerLoad = { generation: startGeneration, promise };
    try {
      await promise;
    } finally {
      // Only the current owner clears the shared slot + loading flag; a request
      // superseded by a newer generation leaves both to that newer load.
      if (inFlightServerLoad?.promise === promise) {
        inFlightServerLoad = null;
        set({ serverLoading: false });
      }
    }
  },

  invalidateServerTasks: () => {
    // Wired to socket "disconnect": a gap may have dropped task events, so
    // serverTasks is no longer provably complete. Always bump the generation
    // (so an in-flight load cannot commit as current) and mark un-loaded. Lazy:
    // the next TasksPanel mount re-fetches; no eager refetch of the big list.
    set((s) => ({ serverTasksLoaded: false, serverTasksGeneration: s.serverTasksGeneration + 1 }));
  },

  registerServerTasksConsumer: () => {
    set((s) => ({ serverTasksActiveConsumers: s.serverTasksActiveConsumers + 1 }));
  },

  unregisterServerTasksConsumer: () => {
    set((s) => ({ serverTasksActiveConsumers: Math.max(0, s.serverTasksActiveConsumers - 1) }));
  },

  catchUpServerTasksOnReconnect: () => {
    const s = get();
    // Only an open Tasks view catches up eagerly, and only after a real gap
    // (generation advanced by a disconnect) — never on the initial app connect,
    // and never when no Tasks view is mounted (that path stays lazy: next mount
    // re-fetches). loadServerTasks is generation-keyed + single-flight, so this
    // is a no-op if a load is already in flight or the list is already loaded.
    if (s.serverTasksActiveConsumers > 0 && !s.serverTasksLoaded && s.serverTasksGeneration > 0) {
      void get().loadServerTasks();
    }
  },

  createTasks: async (channelId, titles) => {
    const { data } = await api.post(`/tasks/channel/${channelId}`, {
      tasks: titles.map((title) => ({ title })),
    });
    const created = (data as { tasks: Task[] }).tasks;
    // Don't add to state here — the socket task:created event will upsert them.
    // Adding locally too causes duplicates when the socket event arrives first.
    return created;
  },

  claimTask: async (_channelId, taskId) => {
    const { data } = await api.patch(`/tasks/${taskId}/claim`);
    const updated = (data as { task: Task }).task;
    set((state) => reduceTaskWithTrace(
      state,
      "claim",
      taskId,
      (current) => patchTaskState(current, updated),
      "claimed",
    ));
    requestTaskHistoryRefreshIfObserved(taskId, get);
  },

  unclaimTask: async (_channelId, taskId) => {
    const { data } = await api.patch(`/tasks/${taskId}/unclaim`);
    const updated = (data as { task: Task }).task;
    set((state) => reduceTaskWithTrace(
      state,
      "unclaim",
      taskId,
      (current) => patchTaskState(current, updated),
      "unclaimed",
    ));
    requestTaskHistoryRefreshIfObserved(taskId, get);
  },

  updateTaskStatus: async (channelId, taskId, status) => {
    const state = get();
    const currentTask = state.tasks.find((task) => task.id === taskId)
      ?? state.serverTasks.find((task) => task.id === taskId);

    // `todo -> in_progress` is the durable work-start transition. The server
    // deliberately rejects an unassigned task moving to in_progress because
    // that would create ownerless active work. Treat the status choice as the
    // user's claim/start intent and use the authoritative claim CAS instead of
    // weakening the invariant through the admin force-status path.
    if (status === "in_progress"
      && currentTask?.status === "todo"
      && !currentTask.claimedById) {
      await get().claimTask(channelId, taskId);
      return;
    }

    const { data } = await api.patch(`/tasks/${taskId}/status`, { status });
    const updated = (data as { task: Task }).task;
    set((state) => reduceTaskWithTrace(
      state,
      "status",
      taskId,
      (current) => patchTaskState(current, updated),
      status,
    ));
    requestTaskHistoryRefreshIfObserved(taskId, get);
  },

  /**
   * Set or clear a task's assignee.
   *
   * Distinct from `claimTask`, which also advances `todo -> in_progress`.
   * Assignment moves ownership and must NOT assert on someone else's behalf
   * that they started the work, so this never touches status.
   *
   * `expectedRevision` is optimistic concurrency: when supplied the server
   * applies the write only if the task is still at that revision and answers
   * 409 with the current one otherwise, so a stale view loses instead of
   * silently clobbering a concurrent assignment.
   */
  updateTaskAssignee: async (_channelId, taskId, assignee, expectedRevision) => {
    const { data } = await api.patch(`/tasks/${taskId}/assignee`, {
      assignee,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    const updated = (data as { task: Task }).task;
    set((state) => reduceTaskWithTrace(
      state,
      "assignee",
      taskId,
      (current) => patchTaskState(current, updated),
      assignee ? `${assignee.type}:${assignee.id}` : "unassigned",
    ));
    requestTaskHistoryRefreshIfObserved(taskId, get);
  },

  loadTaskHistory: async (taskId) => {
    const startGeneration = get().taskHistoryGeneration;
    const existing = inFlightTaskHistory.get(taskId);
    if (existing?.generation === startGeneration) return existing.promise;
    let request!: Promise<void>;
    request = (async () => {
      set((state) => ({
        taskHistoryLoadingByTaskId: { ...state.taskHistoryLoadingByTaskId, [taskId]: true },
        taskHistoryErrorByTaskId: { ...state.taskHistoryErrorByTaskId, [taskId]: false },
      }));
      try {
        const { data } = await api.get(`/tasks/${taskId}/history`);
        if (get().taskHistoryGeneration === startGeneration) {
          const events = Array.isArray(data?.events) ? data.events as TaskHistoryEvent[] : [];
          set((state) => ({
            taskHistoryByTaskId: { ...state.taskHistoryByTaskId, [taskId]: events },
            taskHistoryErrorByTaskId: { ...state.taskHistoryErrorByTaskId, [taskId]: false },
          }));
        }
      } catch {
        if (get().taskHistoryGeneration === startGeneration) {
          set((state) => ({
            taskHistoryByTaskId: { ...state.taskHistoryByTaskId, [taskId]: [] },
            taskHistoryErrorByTaskId: { ...state.taskHistoryErrorByTaskId, [taskId]: true },
          }));
        }
      } finally {
        if (get().taskHistoryGeneration === startGeneration) {
          set((state) => ({
            taskHistoryLoadingByTaskId: { ...state.taskHistoryLoadingByTaskId, [taskId]: false },
          }));
        }
        if (inFlightTaskHistory.get(taskId)?.promise === request) {
          inFlightTaskHistory.delete(taskId);
          if (pendingTaskHistoryRefresh.delete(taskId) && get().taskHistoryConsumersByTaskId[taskId] > 0) {
            void get().loadTaskHistory(taskId);
          }
        }
      }
    })();
    inFlightTaskHistory.set(taskId, { generation: startGeneration, promise: request });
    return request;
  },

  registerTaskHistoryConsumer: (taskId) => {
    set((state) => ({
      taskHistoryConsumersByTaskId: {
        ...state.taskHistoryConsumersByTaskId,
        [taskId]: (state.taskHistoryConsumersByTaskId[taskId] ?? 0) + 1,
      },
    }));
    void get().loadTaskHistory(taskId);
    return () => {
      set((state) => {
        const count = Math.max(0, (state.taskHistoryConsumersByTaskId[taskId] ?? 0) - 1);
        const consumers = { ...state.taskHistoryConsumersByTaskId };
        if (count === 0) delete consumers[taskId];
        else consumers[taskId] = count;
        return { taskHistoryConsumersByTaskId: consumers };
      });
    };
  },

  deleteTask: async (_channelId, taskId) => {
    await api.delete(`/tasks/${taskId}`);
    set((state) => reduceTaskWithTrace(
      state,
      "delete",
      taskId,
      (current) => removeTaskState(current, taskId),
      "deleted",
    ));
  },

  convertMessage: async (messageId) => {
    const { data } = await api.post("/tasks/convert-message", { messageId });
    const task = (data as { task: Task }).task;
    // Socket task:created event will upsert, but also add locally for immediate feedback
    set((state) => reduceTaskWithTrace(
      state,
      "convert-message",
      task.id,
      (current) => patchTaskState(current, task),
      "converted",
    ));
    return task;
  },

  upsertTask: (task) => {
    // Record the live mutation so an in-flight loadServerTasks merges rather
    // than overwrites it (lossless snapshot commit).
    loadTouchedIds?.add(task.id);
    const existing = findKnownTask(get(), task.id);
    const changed = !existing || taskProjectionChanged(existing, task);
    set((state) => reduceTaskWithTrace(
      state,
      "upsert",
      task.id,
      (current) => patchTaskState(current, task),
      task.status,
    ));
    if (changed) requestTaskHistoryRefreshIfObserved(task.id, get);
  },

  removeTask: (taskId) => {
    loadTouchedIds?.add(taskId);
    set((state) => reduceTaskWithTrace(
      state,
      "remove",
      taskId,
      (current) => removeTaskState(current, taskId),
      "removed",
    ));
  },
}));

registerServerReset(() => {
  // Bump (not zero) the generation so a /tasks/server load that began under the
  // previous server cannot commit its snapshot into the newly-switched server.
  // History requests belong to the old server as well; clear their registries
  // before the mounted consumer re-registers against the new generation.
  inFlightTaskHistory.clear();
  pendingTaskHistoryRefresh.clear();
  useTaskStore.setState((s) => ({
    tasks: [],
    loading: false,
    currentChannelId: null,
    tasksByChannelId: {},
    loadingByChannelId: {},
    loadedByChannelId: {},
    serverTasks: [],
    serverLoading: false,
    serverTasksLoaded: false,
    serverTasksGeneration: s.serverTasksGeneration + 1,
    taskMetadataByMessageId: {},
    taskMessageIdByTaskId: {},
    taskHistoryByTaskId: {},
    taskHistoryLoadingByTaskId: {},
    taskHistoryErrorByTaskId: {},
    taskHistoryConsumersByTaskId: {},
    taskHistoryGeneration: s.taskHistoryGeneration + 1,
  }));
});

const EMPTY_TASKS: Task[] = [];

export function selectChannelTaskBucket(state: TaskState, channelId: string | null | undefined): Task[] {
  if (!channelId) return EMPTY_TASKS;
  return state.tasksByChannelId[channelId]
    ?? (state.currentChannelId === channelId ? state.tasks : EMPTY_TASKS);
}

export function useTaskMetadataForMessage(messageId: string | null | undefined): TaskMetadataUpdate | null {
  return useTaskStore((state) => (messageId ? state.taskMetadataByMessageId[messageId] ?? null : null));
}
