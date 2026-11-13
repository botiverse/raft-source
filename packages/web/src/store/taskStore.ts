import { create } from "zustand";
import api from "../api/client";
import type { TaskCreateStatus, TaskStatus } from "@botiverse/raft-shared";
import {
  updateTaskMetadataCache,
  updateTaskMetadataCacheBatch,
} from "../utils/taskMetadata";
import type {
  TaskMetadataUpdate,
} from "../utils/taskMetadata";
import { registerServerReset } from "./serverResetRegistry";
import {
  beginSummaryPageLoad,
  endSummaryPageLoad,
  mergeServerTaskPage,
  mergeServerTasksSnapshot,
  mergeTaskFields,
  noteSummaryPageTouched,
} from "./serverTaskMerge";

export { mergeTaskFields };
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
  readOnlyReason?: "historical_joint_task" | null;
  id: string;
  /** Parent of the task's own conversation (its hidden anchor message; for
   *  tasks from before task v2, the visible host message). */
  messageId: string;
  /** The chat message the task hangs under, if any (task v2: many tasks per
   *  message, or none — a task may belong to the channel only). */
  sourceMessageId?: string | null;
  /** False: no real source (none, or a pre-v2 task's own echo), "Not recorded"; absent from older servers. */
  sourceRecorded?: boolean;
  /** Messages in the task's own conversation. */
  conversationReplyCount?: number;
  /** Task v2: the task's own conversation exists. False for a pre-v2 task
   *  until something is first written there (spec §4). */
  conversationAnchored?: boolean;
  /** Task v2: the task's own conversation (channels.type = 'task'), as its
   *  CANONICAL channel id; a joint channel's local conversation differs and is
   *  resolved through POST /tasks/:id/conversation. Null until it exists. */
  conversationChannelId?: string | null;
  /** Task v2: the real pre-v2 host message (`tasks.message_id`); null for a
   *  task v2 task, whose `messageId` is only a compatibility fallback. */
  hostMessageId?: string | null;
  /** Task v2 (flag on): whether the reader follows the task's conversation,
   *  through this surface's local conversation. Absent with the flag off. */
  conversationFollowed?: boolean;
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
  /** When the task last moved (created, status, assignee, wording, a message
   *  in its conversation), as stored: null before the server wrote one. */
  lastActivityAt?: string | null;
  /** lastActivityAt ?? updatedAt: what the Tasks page shows and sorts by
   *  (tasksPageApi.taskActivityAt); moved locally by a live conversation message. */
  activityAt?: string;
  /** Who sent the task v2 source message (summary rows): what the server's
   *  `from_my_message` relation reads. Null without one; absent when the row
   *  did not say. */
  sourceSenderType?: "user" | "agent" | "external_projection" | null;
  sourceSenderId?: string | null;
  /** True for tasks from the deprecated tasks table (not message-based) */
  isLegacy?: boolean;
  /** Storage source reported by server-list rows (full and summary shapes). */
  source?: "tasks" | "message";
  /** Present on detail=summary rows, which never project the description
   *  body: these two stand in for it until a full row is fetched. */
  hasDescription?: boolean;
  descriptionBytes?: number;
}

/** Pagination state for one status lane of the summary /tasks/server reads. */
export interface ServerTaskPageState {
  /** Opaque keyset cursor from the last fetched page; null = no more pages. */
  nextCursor: string | null;
  loading: boolean;
  /** True once at least one page for this status committed under the current
   *  connection generation. Reset by invalidateServerTasks (socket drop). */
  loaded: boolean;
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
  /** Per-status pagination for the summary panel reads (see
   *  loadActiveTaskSummaries / loadServerTaskStatusPage). The active statuses
   *  (todo/in_progress/in_review) are fetched on panel mount; backlog/done/closed
   *  lazily on section expand, with further pages via "Load more". */
  serverTaskPages: Record<TaskStatus, ServerTaskPageState>;
  taskMetadataByMessageId: Record<string, TaskMetadataUpdate>;
  taskMessageIdByTaskId: Record<string, string>;
  /** Canonical history read model for open task dialogs. */
  taskHistoryByTaskId: Record<string, TaskHistoryEvent[]>;
  taskHistoryLoadingByTaskId: Record<string, boolean>;
  taskHistoryErrorByTaskId: Record<string, boolean>;
  taskHistoryConsumersByTaskId: Record<string, number>;
  taskHistoryGeneration: number;
  /** Bumped by every live task change (socket upsert / removal): a view
   *  that shows server totals (the Tasks page's counts) refreshes on it. */
  liveRevision: number;
  loadTasks: (channelId: string) => Promise<void>;
  loadServerTasks: () => Promise<void>;
  /** Tasks-panel first screen: one small summary page per ACTIVE status
   *  (todo/in_progress/in_review — the server API takes exactly one status
   *  per call) instead of the legacy unbounded full-row load. */
  loadActiveTaskSummaries: () => Promise<void>;
  /** Fetch the next summary page for one status lane (the first page when
   *  the lane was never loaded). No-op while loading or once exhausted. */
  loadServerTaskStatusPage: (status: TaskStatus) => Promise<void>;
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
  /** Task v2: `sourceMessageId` is the source (none: the server posts yours; `sourceRandomId` reuses it on retry). */
  /** Each task a title, or a title and its description. */
  createTasks: (channelId: string, titles: Array<string | TaskCreateDraft>, sourceMessageId?: string, status?: TaskCreateStatus, sourceRandomId?: string) => Promise<Task[]>;
  claimTask: (channelId: string, taskId: string) => Promise<void>;
  unclaimTask: (channelId: string, taskId: string) => Promise<void>;
  /** `reason`: what would bring a task moved to backlog back. Blank is no reason. */
  /**
   * `claimUnassigned` (default true): an unassigned To-do moved to In progress is the viewer's claim (claimTask). The
   * Tasks page's batch passes false: one status for many tasks claims none of them for the viewer.
   */
  updateTaskStatus: (channelId: string, taskId: string, status: TaskStatus, reason?: string, options?: { claimUnassigned?: boolean }) => Promise<void>;
  updateTaskAssignee: (
    channelId: string,
    taskId: string,
    assignee: { type: "user" | "agent"; id: string } | null,
    expectedRevision?: number, reason?: string, // reason: a hand-off's "what it waits on them for" (blank: none)
  ) => Promise<void>;
  /**
   * Edit a task's title and/or description (PATCH /tasks/:taskId). The server
   * writes the `amended` event and the line in the task's discussion.
   */
  amendTask: (
    taskId: string,
    patch: TaskAmendInput,
    expectedRevision?: number,
  ) => Promise<void>;
  loadTaskHistory: (taskId: string) => Promise<void>;
  registerTaskHistoryConsumer: (taskId: string) => () => void;
  deleteTask: (channelId: string, taskId: string) => Promise<void>;
  convertMessage: (messageId: string) => Promise<Task>;
  // Called by socket events to update a single task in place
  upsertTask: (task: Task) => void;
  /** Task v2: a reply (person or agent, not a lifecycle line) landed in the
   *  task's own conversation; its row counts it live. `at` (the message's
   *  time) also moves the task's activityAt, as the server stamps it without
   *  a task event, so it rises under the Tasks page's activity sort. */
  bumpTaskConversationReplyCount: (taskId: string, at?: string) => void;
  removeTask: (taskId: string) => void;
}

/** A task to create: its title and, if any, its description. */
export interface TaskCreateDraft {
  title: string;
  description?: string;
}

/** What an edit of a task's wording sends; `clearDescription` removes the description. */
export interface TaskAmendInput {
  title?: string;
  description?: string;
  clearDescription?: boolean;
}

const ACTIVE_TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review"];

/** Page size for the summary /tasks/server reads (server cap is 500). */
const SERVER_TASKS_PAGE_LIMIT = 100;

function createEmptyServerTaskPages(): Record<TaskStatus, ServerTaskPageState> {
  const empty = (): ServerTaskPageState => ({ nextCursor: null, loading: false, loaded: false });
  return { backlog: empty(), todo: empty(), in_progress: empty(), in_review: empty(), done: empty(), closed: empty() };
}

function shouldIncludeInServerTasks(task: Task): boolean {
  return task.channelType === "channel" || task.channelType === "private" || task.channelType === "joint";
}

function upsertTaskInList(list: Task[], task: Task): Task[] {
  const index = list.findIndex((item) => item.id === task.id);
  if (index === -1) return [...list, task];
  const next = [...list];
  next[index] = mergeTaskFields(next[index], task);
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
  // The client's own write landing (claim, status, assignee, wording) is a live change too: placed at once (Tasks page).
  noteSummaryPageTouched(task.id);
  const taskExists = state.tasks.some((item) => item.id === task.id);
  const tasks = taskExists
    ? state.tasks.map((item) => (item.id === task.id ? mergeTaskFields(item, task) : item))
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

// In-flight /tasks/channel/:id loads. A caller that arrives while the channel's
// load is running awaits that same request instead of returning at once: a
// consumer that reads tasksByChannelId right after `await loadTasks(id)` (the
// task window resolving `?task=<ch>:task:<id>`) must see the landed list, not
// the pre-load empty bucket.
const inFlightChannelLoads = new Map<string, Promise<void>>();

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
  serverTaskPages: createEmptyServerTaskPages(),
  taskMetadataByMessageId: {},
  taskMessageIdByTaskId: {},
  taskHistoryByTaskId: {},
  taskHistoryLoadingByTaskId: {},
  taskHistoryErrorByTaskId: {},
  taskHistoryConsumersByTaskId: {},
  taskHistoryGeneration: 0,
  liveRevision: 0,

  loadTasks: (channelId) => {
    const inFlight = inFlightChannelLoads.get(channelId);
    if (inFlight) return inFlight;
    if (get().loadingByChannelId[channelId]) return Promise.resolve();
    const promise = (async () => {
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
    })();
    inFlightChannelLoads.set(channelId, promise);
    void promise.finally(() => {
      if (inFlightChannelLoads.get(channelId) === promise) inFlightChannelLoads.delete(channelId);
    });
    return promise;
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

  loadActiveTaskSummaries: async () => {
    // Tasks-panel first screen: one small summary page per ACTIVE status
    // (?detail=summary&status=<one>&limit=N — the API takes exactly one status
    // per call) instead of the legacy unbounded full-row load. backlog/done/closed
    // stay lazy: their first page is fetched when the user expands that
    // section, further pages via the section's "Load more" affordance.
    //
    // Loaded-skip mirrors loadServerTasks: once the first pages commit, the
    // socket keeps serverTasks live; invalidateServerTasks resets the lanes.
    const pages = get().serverTaskPages;
    const needed = ACTIVE_TASK_STATUSES.filter((status) => !pages[status].loaded && !pages[status].loading);
    if (needed.length === 0) return;
    set({ serverLoading: true });
    try {
      await Promise.all(needed.map((status) => get().loadServerTaskStatusPage(status)));
    } finally {
      set({ serverLoading: false });
    }
  },

  loadServerTaskStatusPage: async (status) => {
    const lane = get().serverTaskPages[status];
    if (lane.loading || (lane.loaded && lane.nextCursor === null)) return;
    const startGeneration = get().serverTasksGeneration;
    const touched = beginSummaryPageLoad();
    set((state) => ({
      serverTaskPages: {
        ...state.serverTaskPages,
        [status]: { ...state.serverTaskPages[status], loading: true },
      },
    }));
    try {
      const query = `detail=summary&status=${status}&limit=${SERVER_TASKS_PAGE_LIMIT}`
        + (lane.nextCursor ? `&cursor=${encodeURIComponent(lane.nextCursor)}` : "");
      const { data } = await api.get(`/tasks/server?${query}`);
      if (get().serverTasksGeneration !== startGeneration) {
        // Same generation gate as loadServerTasks: the socket dropped (or the
        // server switched) mid-flight, so this snapshot predates the gap.
        return;
      }
      const page = (data as { tasks: Task[] }).tasks;
      const nextCursor = (data as { next_cursor?: string | null }).next_cursor ?? null;
      set((state) => reduceTaskWithTrace(
        state,
        "hydrate:server-page",
        status,
        (current) => ({
          serverTasks: mergeServerTaskPage(current.serverTasks, page, touched),
          serverTaskPages: {
            ...current.serverTaskPages,
            [status]: { nextCursor, loading: false, loaded: true },
          },
          ...hydrateTaskMetadataState(current, page),
        }),
      ));
    } catch (err) {
      console.error("Failed to load server task page:", err);
      if (get().serverTasksGeneration !== startGeneration) return;
      // A 400 is the server refusing a stale cursor (its channel fell out of
      // the visible set); the documented remedy is to restart the walk from
      // the beginning, so reset the lane instead of retrying the dead cursor.
      const statusCode = (err as { response?: { status?: number } })?.response?.status;
      set((state) => ({
        serverTaskPages: {
          ...state.serverTaskPages,
          [status]: statusCode === 400
            ? { nextCursor: null, loading: false, loaded: false }
            : { ...state.serverTaskPages[status], loading: false },
        },
      }));
    } finally {
      endSummaryPageLoad();
    }
  },

  invalidateServerTasks: () => {
    // Wired to socket "disconnect": a gap may have dropped task events, so
    // serverTasks is no longer provably complete. Always bump the generation
    // (so an in-flight load cannot commit as current) and mark un-loaded. Lazy:
    // the next TasksPanel mount re-fetches; no eager refetch of the big list.
    // The summary lanes reset too — their pages are just as gap-suspect.
    set((s) => ({
      serverTasksLoaded: false,
      serverTasksGeneration: s.serverTasksGeneration + 1,
      serverTaskPages: createEmptyServerTaskPages(),
    }));
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
    // re-fetches). The catch-up refetches the small active summary pages, never
    // the legacy unbounded load. loadActiveTaskSummaries is generation-gated +
    // lane-deduped, so this is a no-op if the lanes are already loading/loaded.
    if (s.serverTasksActiveConsumers > 0 && s.serverTasksGeneration > 0
      && ACTIVE_TASK_STATUSES.some((status) => !s.serverTaskPages[status].loaded)) {
      void get().loadActiveTaskSummaries();
    }
  },

  createTasks: async (channelId, titles, sourceMessageId, status, sourceRandomId) => {
    const { data } = await api.post(`/tasks/channel/${channelId}`, {
      tasks: titles.map((item) => {
        const { title, description } = typeof item === "string" ? { title: item, description: undefined } : item;
        return { title, ...(description && { description }), ...(sourceMessageId && { sourceMessageId }) };
      }),
      ...(status && { status }), ...(!sourceMessageId && sourceRandomId && { sourceRandomId }),
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

  updateTaskStatus: async (channelId, taskId, status, reason, options) => {
    const state = get();
    const currentTask = state.tasks.find((task) => task.id === taskId)
      ?? state.serverTasks.find((task) => task.id === taskId);

    // `todo -> in_progress` is the durable work-start transition. The server
    // deliberately rejects an unassigned task moving to in_progress because
    // that would create ownerless active work. Treat the status choice as the
    // user's claim/start intent and use the authoritative claim CAS instead of
    // weakening the invariant through the admin force-status path.
    if (status === "in_progress"
      && options?.claimUnassigned !== false
      && currentTask?.status === "todo"
      && !currentTask.claimedById) {
      await get().claimTask(channelId, taskId);
      return;
    }

    const trimmedReason = reason?.trim();
    const { data } = await api.patch(`/tasks/${taskId}/status`, trimmedReason ? { status, reason: trimmedReason } : { status });
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
  updateTaskAssignee: async (_channelId, taskId, assignee, expectedRevision, reason) => {
    const { data } = await api.patch(`/tasks/${taskId}/assignee`, {
      assignee,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(reason?.trim() ? { reason } : {}),
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

  /**
   * Edit a task's title and/or description.
   *
   * `expectedRevision` is optimistic concurrency, as on `updateTaskAssignee`:
   * the server applies the edit only if the task is still at that revision and
   * otherwise answers 409 with `currentRevision`, which rejects this promise
   * (the store is left as it was) so the editor can re-read instead of
   * overwriting someone else's edit.
   */
  amendTask: async (taskId, patch, expectedRevision) => {
    const { data } = await api.patch(`/tasks/${taskId}`, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.clearDescription ? { clearDescription: true } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    const updated = (data as { task: Task }).task;
    set((state) => reduceTaskWithTrace(
      state,
      "amend",
      taskId,
      (current) => patchTaskState(current, updated),
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

  bumpTaskConversationReplyCount: (taskId, at) => set((state) => {
    noteSummaryPageTouched(taskId);
    const bump = (list: Task[]) => {
      let hit = false;
      const next = list.map((task) => {
        if (task.id !== taskId) return task;
        hit = true;
        const moved = at && Date.parse(at) > Date.parse(task.activityAt ?? task.lastActivityAt ?? task.updatedAt);
        return { ...task, conversationReplyCount: (task.conversationReplyCount ?? 0) + 1, ...(moved ? { activityAt: at } : {}) };
      });
      return hit ? next : list;
    };
    const tasks = bump(state.tasks);
    const serverTasks = bump(state.serverTasks);
    let byChannelChanged = false;
    const tasksByChannelId: Record<string, Task[]> = {};
    for (const [channelId, list] of Object.entries(state.tasksByChannelId)) {
      const next = bump(list);
      if (next !== list) byChannelChanged = true;
      tasksByChannelId[channelId] = next;
    }
    if (tasks === state.tasks && serverTasks === state.serverTasks && !byChannelChanged) return state;
    return {
      ...(tasks !== state.tasks ? { tasks } : {}),
      ...(serverTasks !== state.serverTasks ? { serverTasks } : {}),
      ...(byChannelChanged ? { tasksByChannelId } : {}),
    };
  }),

  upsertTask: (task) => {
    // Record the live mutation so an in-flight loadServerTasks merges rather
    // than overwrites it (lossless snapshot commit).
    loadTouchedIds?.add(task.id);
    noteSummaryPageTouched(task.id);
    const existing = findKnownTask(get(), task.id);
    const changed = !existing || taskProjectionChanged(existing, task);
    set((state) => ({
      ...reduceTaskWithTrace(
        state,
        "upsert",
        task.id,
        (current) => patchTaskState(current, task),
        task.status,
      ),
      liveRevision: state.liveRevision + 1,
    }));
    if (changed) requestTaskHistoryRefreshIfObserved(task.id, get);
  },

  removeTask: (taskId) => {
    loadTouchedIds?.add(taskId);
    noteSummaryPageTouched(taskId);
    set((state) => ({
      ...reduceTaskWithTrace(
        state,
        "remove",
        taskId,
        (current) => removeTaskState(current, taskId),
        "removed",
      ),
      liveRevision: state.liveRevision + 1,
    }));
  },
}));

/**
 * One page of a filtered, sorted /tasks/server read (the Tasks page's
 * groups and columns, tasksPageStore), merged into `serverTasks` by the same
 * rules as the status lanes' pages: upsert only, field-merged (a summary row
 * keeps a description a full row brought), and skipping tasks changed live
 * while it was in flight. Null when the connection or the server changed
 * meanwhile: the page predates the gap and is dropped.
 */
export async function ingestServerTaskQueryPage<T extends { tasks: Task[] }>(fetchPage: () => Promise<T>): Promise<T | null> {
  const startGeneration = useTaskStore.getState().serverTasksGeneration;
  const touched = beginSummaryPageLoad();
  try {
    const page = await fetchPage();
    if (useTaskStore.getState().serverTasksGeneration !== startGeneration) return null;
    useTaskStore.setState((state) => reduceTaskWithTrace(
      state,
      "hydrate:server-query",
      "server-tasks",
      (current) => ({
        serverTasks: mergeServerTaskPage(current.serverTasks, page.tasks, touched),
        ...hydrateTaskMetadataState(current, page.tasks),
      }),
    ));
    return page;
  } finally {
    endSummaryPageLoad();
  }
}

registerServerReset(() => {
  // Bump (not zero) the generation so a /tasks/server load that began under the
  // previous server cannot commit its snapshot into the newly-switched server.
  // History requests belong to the old server as well; clear their registries
  // before the mounted consumer re-registers against the new generation.
  inFlightTaskHistory.clear();
  pendingTaskHistoryRefresh.clear();
  inFlightChannelLoads.clear();
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
    serverTaskPages: createEmptyServerTaskPages(),
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
