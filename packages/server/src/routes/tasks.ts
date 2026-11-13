import { refuse } from "../lib/refusal";
import { respondToTaskWriteError } from "../lib/taskWriteErrorResponse";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import * as taskService from "../services/taskService";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { getServerHistoryWindowForRead, humanHistoryLimitedError, isBehindHistoryWindow } from "../services/historyWindow";
import * as userService from "../services/userService";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { authorizeTaskAction, checkTaskAssignReason, TASK_ASSIGN_REASON_UNCHANGED, checkTaskCreateStatus, checkTaskStatusReason, isSubConversationType, isTaskCreateStatus, isTaskStatus, TASK_DESCRIPTION_MAX_LENGTH, TASK_STATUSES, TASK_TITLE_MAX_LENGTH, type ServerId, type TaskAction, type TaskAssignmentNoticeMetadata, type TaskStatus } from "@botiverse/raft-shared";
import { UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { emitTaskCreated, emitTaskDeleted, emitTaskMessageNew, emitTaskUpdated } from "../services/taskRealtimeEvents";
import { announceTaskClaim, announceTasksCreatedFromSourceMessages, buildLegacyTaskAssignmentLine, buildTaskAmendNotice, buildTaskAssignmentNotice, buildTaskStatusNotice, postTaskConversationNotice } from "../services/taskConversationNotice";
import { ensureTaskConversationAndBroadcast, withTaskConversationEnsured } from "../services/taskMutationBroadcast";
import { taskV2WebConvertRefusal } from "../services/taskV2UseCreate";
import { isTaskV2ConversationsEnabled } from "../services/taskConversationsGate";
import { checkHumanPostAdmission, HUMAN_POST_REFUSALS } from "../services/humanPostAdmission";
import { channelBillingReadOnlyBody } from "../services/planService";
import { MAX_MESSAGE_LENGTH } from "./messages";
import { notePaywallHit } from "./paywallHit";
import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import { getUserTaskConversationFollowStates, listTaskConversationsByParentChannel } from "../services/taskConversationService";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions";
import {
  getTaskRealtimeSurfaceTargets,
  isHistoricalJointTaskReadOnly,
  writeTaskSurfaceFields,
  resolveTaskChannelSurface,
  resolveTaskChannelSurfaceForStorage,
  type TaskSurfaceChannel,
} from "../services/taskChannelSurface";

export const taskRouter: RouterType = Router();

// Uniform 404 for non-UUID path params (task #12), before any handler runs.
// `taskNumber` is deliberately excluded (it is an integer, not a UUID).
guardUuidPathParams(taskRouter, { channelId: "Channel", taskId: "Task" });

/**
 * Task v2: `conversationFollowed` on the web task DTO — whether the requesting
 * person follows the task's conversation as seen through this surface (joint:
 * their server's local projection). On every task where the reader's server
 * has task v2 conversations on, and on v2 tasks whatever the flag (per-task
 * mode, ../services/taskV2Mode: `conversationAnchored`); a pre-v2 task on a
 * flag-off server keeps the DTO unchanged.
 */
async function withConversationFollowed<T extends { id: string; conversationAnchored?: boolean }>(
  req: Request,
  localChannelId: string,
  tasks: T[],
): Promise<Array<T & { conversationFollowed?: boolean }>> {
  if (tasks.length === 0) return tasks;
  const flagOn = await isTaskV2ConversationsEnabled(req.serverId!);
  const reported = flagOn ? tasks : tasks.filter((task) => task.conversationAnchored === true);
  if (reported.length === 0) return tasks;
  const followed = await getUserTaskConversationFollowStates(req.userId!, localChannelId, reported.map((task) => task.id));
  return tasks.map((task) => (followed.has(task.id) ? { ...task, conversationFollowed: followed.get(task.id) ?? false } : task));
}

async function rejectIfNoTaskReadAccess(channelId: string, userId: string, serverId: ServerId, res: Response): Promise<boolean> {
  const canAccess = await channelService.canUserAccessChannel(channelId, userId, serverId);
  if (!canAccess) {
    res.status(404).json({ error: "Channel not found" });
    return true;
  }
  return false;
}

// List tasks for a channel
taskRouter.get("/channel/:channelId", async (req, res) => {
  try {
    const surface = await resolveTaskChannelSurface(req.serverId!, req.params.channelId);
    if (!surface) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (await rejectIfNoTaskReadAccess(surface.localChannel.id, req.userId!, req.serverId!, res)) return;
    // Validate + narrow the optional ?status filter (was an `as TaskStatus` cast).
    // A present value must be a known TaskStatus string, else 400 (fail closed —
    // covers repeated/array params); absent = no filter.
    const statusParam = req.query.status;
    let statusFilter: TaskStatus | undefined;
    if (statusParam !== undefined) {
      if (typeof statusParam !== "string" || !isTaskStatus(statusParam)) {
        res.status(400).json({ error: "Invalid status value" });
        return;
      }
      statusFilter = statusParam;
    }
    const tasks = await taskService.listTasks(surface.storageChannelId, statusFilter);
    const projected = taskService.projectTasksToChannel(tasks, surface.localChannel);
    res.json({ tasks: await withConversationFollowed(req, surface.localChannel.id, projected) });
  } catch {
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

// Resolve a task reference by channel + task number (message-based or legacy)
taskRouter.get("/channel/:channelId/number/:taskNumber", async (req, res) => {
  try {
    const surface = await resolveTaskChannelSurface(req.serverId!, req.params.channelId);
    if (!surface) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (await rejectIfNoTaskReadAccess(surface.localChannel.id, req.userId!, req.serverId!, res)) return;

    const taskNumber = Number(req.params.taskNumber);
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      res.status(400).json({ error: "Invalid task number" });
      return;
    }

    const owner = await taskService.resolveTaskByNumber(surface.storageChannelId, taskNumber);
    if (!owner) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const enriched = await taskService.enrichSingleLegacyTask(owner.row);
    const [task] = await withConversationFollowed(req, surface.localChannel.id, [taskService.projectTaskToChannel(enriched, surface.localChannel)]);
    res.json({ task });
  } catch {
    res.status(500).json({ error: "Failed to resolve task" });
  }
});

/**
 * Response-size tripwire for `GET /api/tasks/server` (serialize-then-measure),
 * applied to the NEW shapes only (pagination/summary): a paginated or summary
 * page has no business approaching this, so crossing it means the new contract
 * itself is leaking size. The value is a CONTRACT threshold for the new shape,
 * not derived from any client ceiling — those move (the mobile curl ceiling
 * went 16 → 64 MiB in raft.36), and whoever reads a derivation will rescale
 * this number against the wrong ceiling. The legacy full shape is already past
 * this line in production and deliberately does not warn (see the call site).
 */
export const TASKS_SERVER_RESPONSE_WARN_BYTES = 8 * 1024 * 1024;

const SERVER_TASKS_MAX_LIMIT = 500;

/**
 * Opaque cursor codec, base64url(JSON):
 *   the (channel, number) walk: { c: channelId, n: taskNumber };
 *   a sorted walk (?sort=):     { s: sort, k: key, i: taskId, c: channelId }
 *   (taskService.ServerTasksSortedCursor).
 */
function encodeServerTasksCursor(cursor: taskService.ServerTasksPageCursor | taskService.ServerTasksSortedCursor): string {
  const payload = taskService.isServerTasksSortedCursor(cursor)
    ? { s: cursor.sort, k: cursor.key, i: cursor.taskId, c: cursor.channelId }
    : { c: cursor.channelId, n: cursor.taskNumber };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// A sorted cursor's instant: as the walk writes it, UTC with microseconds.
const SORTED_CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function decodeServerTasksCursor(raw: string): taskService.ServerTasksPageCursor | taskService.ServerTasksSortedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { c?: unknown; n?: unknown; s?: unknown; k?: unknown; i?: unknown };
    if (typeof parsed?.c !== "string" || !UUID_RE.test(parsed.c)) return null;
    if (parsed.s !== undefined) {
      const sort = parsed.s;
      if (typeof sort !== "string" || !(taskService.SERVER_TASK_SORTS as readonly string[]).includes(sort)) return null;
      if (typeof parsed.i !== "string" || !UUID_RE.test(parsed.i)) return null;
      const key = parsed.k;
      const validKey = sort === "number"
        ? typeof key === "number" && Number.isInteger(key) && key >= 1
        : typeof key === "string" && SORTED_CURSOR_INSTANT_RE.test(key) && Number.isFinite(Date.parse(key));
      if (!validKey) return null;
      return { sort: sort as taskService.ServerTaskSort, key: key as string | number, taskId: parsed.i.toLowerCase(), channelId: parsed.c.toLowerCase() };
    }
    if (typeof parsed?.n !== "number" || !Number.isInteger(parsed.n) || parsed.n < 1) return null;
    return { channelId: parsed.c, taskNumber: parsed.n };
  } catch {
    return null;
  }
}

// Period metrics use source aggregation, not the task-list pagination cap.
taskRouter.get("/server/snapshot-metrics", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (role !== "owner" && role !== "admin") { res.status(403).json({ error: "Server administrator required" }); return; }
    const { channelId } = req.query;
    if (channelId !== undefined && (typeof channelId !== "string" || !UUID_RE.test(channelId))) {
      res.status(400).json({ error: "A valid channel is required" }); return;
    }
    if (typeof channelId === "string" && await rejectIfNoTaskReadAccess(channelId, req.userId!, req.serverId!, res)) return;
    res.json(await taskService.getServerTaskSnapshot(req.serverId!, req.userId!, channelId as string | undefined));
  } catch { res.status(500).json({ error: "Failed to aggregate task snapshot" }); }
});

// Period metrics use source aggregation, not the task-list pagination cap.
taskRouter.get("/server/period-metrics", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (role !== "owner" && role !== "admin") { res.status(403).json({ error: "Server administrator required" }); return; }
    const { from, midpoint, to, channelId } = req.query;
    const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
    if (!validDate(from) || !validDate(midpoint) || !validDate(to) ||
      Date.parse(midpoint) - Date.parse(from) !== Date.parse(to) - Date.parse(midpoint) ||
      Date.parse(from) >= Date.parse(midpoint) || Date.parse(to) - Date.parse(from) > 180 * 86_400_000 ||
      (channelId !== undefined && (typeof channelId !== "string" || !UUID_RE.test(channelId)))) {
      res.status(400).json({ error: "Two equal positive periods and a valid channel are required" }); return;
    }
    if (typeof channelId === "string" && await rejectIfNoTaskReadAccess(channelId, req.userId!, req.serverId!, res)) return;
    const metrics = await taskService.getServerTaskPeriodMetrics(req.serverId!, req.userId!, new Date(from), new Date(midpoint), new Date(to), channelId as string | undefined);
    res.json({ ...metrics, from, midpoint, to, fetchedAt: new Date().toISOString() });
  } catch { res.status(500).json({ error: "Failed to aggregate task metrics" }); }
});

/** Cap on the values of one list filter: bounds the SQL a request can build. */
const SERVER_TASKS_MAX_FILTER_VALUES = 200;

/**
 * A list query param's values. Repeated keys and comma-separated values both
 * work and combine (`channel=a&channel=b` = `channel=a,b`), as
 * parseThreadSummaryParentMessageIds in ./channels does. undefined = absent;
 * null = malformed (a non-string value, an empty list, or over the cap).
 */
function readQueryList(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const values: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") return null;
    values.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
  }
  if (values.length === 0 || values.length > SERVER_TASKS_MAX_FILTER_VALUES) return null;
  return [...new Set(values)];
}

/** `user:<uuid>` / `agent:<uuid>`, the web board's identity encoding (TasksPanel IdentityFilterValue). */
function parseTaskActorRef(value: string): taskService.ServerTaskActorRef | null {
  const separator = value.indexOf(":");
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1).toLowerCase();
  if (separator === -1 || (type !== "user" && type !== "agent") || !UUID_RE.test(id)) return null;
  return { type, id };
}

// An ISO 8601 date, or date-time with an explicit offset (a bare local time
// would be read in the server's time zone).
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/** Query params that only the opt-in filtered board reads understand. */
const SERVER_TASK_FILTER_PARAMS = ["channel", "assignee", "creator", "relation", "completed_since", "created_since", "q"] as const;

/** The longest search the board takes (`q`). */
const SERVER_TASK_QUERY_MAX_LENGTH = 200;

/** An ISO instant query param in the completed_since style; undefined = absent, null = malformed. */
function readQueryInstant(raw: unknown): Date | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !ISO_INSTANT_RE.test(raw) || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw);
}

/**
 * Parse the board filters shared by `GET /server` and `GET /server/counts`.
 * Answers 400 and returns null on the first invalid param.
 *
 *   status=<s>[,<s>...]       board statuses; in_progress includes stored
 *                             in_review rows (retired by task v2, shown as
 *                             in progress); in_review alone matches only those
 *   channel=<uuid>[,...]      local channel ids; any outside the caller's
 *                             board match nothing (no error: visibility is
 *                             not revealed)
 *   assignee=<ref|unassigned>[,...]  claimer, `user:<uuid>` / `agent:<uuid>`
 *   creator=<ref>[,...]       creator, same encoding
 *   relation=assigned_to_me|created_by_me|from_my_message  (one value;
 *                             see taskService.SERVER_TASK_RELATIONS)
 *   completed_since=<ISO>     done tasks completed before it are left out;
 *                             other statuses are unaffected
 *   created_since=<ISO>       tasks created before it are left out (any status)
 *   q=<text>                  search: titles containing every word (case-
 *                             insensitive), or one task number (`12`, `#12`);
 *                             at most 200 characters, blank = no search
 *
 * List params take repeated keys and/or comma lists (readQueryList).
 */
function parseServerTaskFilters(req: Request, res: Response): taskService.ServerTaskFilters | null {
  const filters: taskService.ServerTaskFilters = {};
  const fail = (error: string) => {
    refuse(res, 400, { code: "INVALID_TASK_FILTER", error });
    return null;
  };

  if (req.query.status !== undefined) {
    const values = readQueryList(req.query.status);
    if (!values || !values.every(isTaskStatus)) return fail("Invalid status value");
    filters.statuses = values;
  }
  if (req.query.channel !== undefined) {
    const values = readQueryList(req.query.channel)?.map((value) => value.toLowerCase());
    if (!values || !values.every((value) => UUID_RE.test(value))) return fail("Invalid channel value");
    filters.channelIds = values;
  }
  if (req.query.assignee !== undefined) {
    const values = readQueryList(req.query.assignee);
    const assignees = values?.map((value) => (value === "unassigned" ? "unassigned" as const : parseTaskActorRef(value)));
    if (!assignees || assignees.some((assignee) => assignee === null)) return fail("Invalid assignee value");
    filters.assignees = assignees as Array<taskService.ServerTaskActorRef | "unassigned">;
  }
  if (req.query.creator !== undefined) {
    const creators = readQueryList(req.query.creator)?.map(parseTaskActorRef);
    if (!creators || creators.some((creator) => creator === null)) return fail("Invalid creator value");
    filters.creators = creators as taskService.ServerTaskActorRef[];
  }
  if (req.query.relation !== undefined) {
    const relation = req.query.relation;
    if (typeof relation !== "string" || !(taskService.SERVER_TASK_RELATIONS as readonly string[]).includes(relation)) {
      return fail("Invalid relation value");
    }
    filters.relation = relation as taskService.ServerTaskRelation;
  }
  if (req.query.completed_since !== undefined) {
    const since = readQueryInstant(req.query.completed_since);
    if (!since) return fail("Invalid completed_since value");
    filters.completedSince = since;
  }
  if (req.query.created_since !== undefined) {
    const since = readQueryInstant(req.query.created_since);
    if (!since) return fail("Invalid created_since value");
    filters.createdSince = since;
  }
  if (req.query.q !== undefined) {
    const query = req.query.q;
    if (typeof query !== "string" || query.length > SERVER_TASK_QUERY_MAX_LENGTH) return fail("Invalid q value");
    if (query.trim()) filters.query = query.trim();
  }
  return filters;
}

// Board counts: per column and per relation tab, over exactly the rows the
// filtered GET /server read pages through (taskService.countServerTasks).
// Same auth and visibility as GET /server; takes its filters, not
// limit/cursor/detail. Response:
//   { counts: { backlog, todo, in_progress, done, closed },
//     relations: { assigned_to_me, created_by_me, from_my_message } }
// counts.in_progress includes stored in_review rows; relations count open
// (todo / in progress) tasks within every filter but `relation`.
taskRouter.get("/server/counts", async (req, res) => {
  try {
    for (const param of ["limit", "cursor", "detail", "sort"]) {
      if (req.query[param] !== undefined) {
        refuse(res, 400, { code: "UNSUPPORTED_PARAMETER", error: `Unsupported ${param} parameter: counts are totals, so leave out ${param}.` });
        return;
      }
    }
    const filters = parseServerTaskFilters(req, res);
    if (!filters) return;
    res.json(await taskService.countServerTasks(req.serverId!, req.userId!, filters));
  } catch {
    res.status(500).json({ error: "Failed to count server tasks" });
  }
});

// List all channel tasks for the current server
taskRouter.get("/server", async (req, res) => {
  try {
    // The legacy single ?status: one known TaskStatus, matched exactly. Kept
    // for the legacy full shape below; every other shape reads the board
    // filters (parseServerTaskFilters), where status may be a list.
    const statusParam = req.query.status;
    let statusFilter: TaskStatus | undefined;
    const legacyStatus = statusParam === undefined || (typeof statusParam === "string" && !statusParam.includes(","));
    if (legacyStatus && statusParam !== undefined) {
      if (typeof statusParam !== "string" || !isTaskStatus(statusParam)) {
        res.status(400).json({ error: "Invalid status value" });
        return;
      }
      statusFilter = statusParam;
    }
    const filters = parseServerTaskFilters(req, res);
    if (!filters) return;
    // Additive read shapes (2026-09, >16 MiB task-panel response on artin's
    // device). With NO new params the response keeps the legacy shape — full
    // rows, unpaginated, no next_cursor key — so existing clients are
    // unaffected. All new params are opt-in and compose with ?status:
    //   ?limit=1..500&cursor=<opaque>  stable total-order keyset pagination
    //                                  (channel name ASC, then taskNumber ASC)
    //   ?detail=summary                small per-item projection (no
    //                                  description body or other large text)
    //   board filters (2026-11)        parseServerTaskFilters: a status
    //                                  list, channel, assignee, creator,
    //                                  relation, completed_since,
    //                                  created_since, q (search)
    //   ?sort=activity|created|number  newest first by activity time
    //                                  (lastActivityAt ?? updatedAt),
    //                                  createdAt or task number; ties by task
    //                                  id. Its cursor carries the sort and is
    //                                  refused (400) by any other walk.
    //   ?sort=activity_asc             activity time oldest first (the exact
    //                                  reverse of activity, ties by task id
    //                                  ascending): longest without an update.
    const detailParam = req.query.detail;
    let detail: "full" | "summary" = "full";
    if (detailParam !== undefined) {
      if (detailParam !== "summary") {
        res.status(400).json({ error: "Invalid detail value" });
        return;
      }
      detail = "summary";
    }

    const limitParam = req.query.limit;
    let limit: number | undefined;
    if (limitParam !== undefined) {
      if (typeof limitParam !== "string" || !/^\d+$/.test(limitParam)) {
        res.status(400).json({ error: "Invalid limit value" });
        return;
      }
      limit = Number(limitParam);
      if (limit < 1 || limit > SERVER_TASKS_MAX_LIMIT) {
        res.status(400).json({ error: "Invalid limit value" });
        return;
      }
    }

    const sortParam = req.query.sort;
    let sort: taskService.ServerTaskSort | undefined;
    if (sortParam !== undefined) {
      if (typeof sortParam !== "string" || !(taskService.SERVER_TASK_SORTS as readonly string[]).includes(sortParam)) {
        refuse(res, 400, { code: "INVALID_TASK_SORT", error: "Invalid sort value" });
        return;
      }
      sort = sortParam as taskService.ServerTaskSort;
    }

    const cursorParam = req.query.cursor;
    let cursor: taskService.ServerTasksPageCursor | taskService.ServerTasksSortedCursor | null = null;
    if (cursorParam !== undefined) {
      // A cursor without a page size cannot be walked.
      if (typeof cursorParam !== "string" || limit === undefined) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
      cursor = decodeServerTasksCursor(cursorParam);
      if (!cursor) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
    }

    const paginated = limit !== undefined;
    // Byte-identical legacy response for requests without any new param,
    // including its exact single-status match (no in_review folding).
    const legacyShape = limitParam === undefined && cursorParam === undefined && detailParam === undefined
      && sortParam === undefined && legacyStatus && SERVER_TASK_FILTER_PARAMS.every((param) => req.query[param] === undefined);
    let payload: { tasks: unknown[]; next_cursor?: string | null };
    if (legacyShape) {
      payload = { tasks: await taskService.listServerTasks(req.serverId!, statusFilter, req.userId!) };
    } else {
      // A request with no board filter (one status, at most limit/cursor/
      // detail) keeps its exact status match: shipped clients page
      // in_progress and in_review separately. Board-filtered reads go through
      // the filters, where in_progress includes in_review rows, as the board
      // shows and counts them.
      const boardFiltered = !legacyStatus || SERVER_TASK_FILTER_PARAMS.some((param) => req.query[param] !== undefined);
      const page = boardFiltered
        ? await taskService.listServerTasksPage(req.serverId!, undefined, req.userId!, { limit, cursor, detail, filters, sort })
        : await taskService.listServerTasksPage(req.serverId!, statusFilter, req.userId!, { limit, cursor, detail, sort });
      if (typeof page === "string") {
        // Only failure the service reports: the cursor's channel fell out of
        // the visible set, so its position in the total order is unknowable;
        // or the cursor belongs to another walk (another sort, or none).
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
      payload = paginated
        ? { tasks: page.tasks, next_cursor: page.nextCursor ? encodeServerTasksCursor(page.nextCursor) : null }
        : { tasks: page.tasks };
    }

    // Size observability on this endpoint only: measure the exact bytes sent
    // (this is the same string res.json would produce). The warn fires ONLY
    // for the new shapes (pagination/summary): the legacy full shape is
    // ALREADY past the tripwire in production (21.7 MiB measured 2026-09-01),
    // so warning on it would be a standing noise floor that teaches operators
    // to raise the threshold instead of migrating clients. A paginated or
    // summary response past the wire means the new contract itself is leaking
    // size — that is the actionable signal.
    const body = JSON.stringify(payload);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    res.setHeader("X-Response-Bytes", String(bodyBytes));
    if (!legacyShape && bodyBytes > TASKS_SERVER_RESPONSE_WARN_BYTES) {
      console.warn(`[tasks/server] oversized paginated/summary response: ${bodyBytes} bytes (${payload.tasks.length} items) for server ${req.serverId}`);
    }
    res.type("application/json").send(body);
  } catch {
    res.status(500).json({ error: "Failed to list server tasks" });
  }
});

// Read the canonical append-only task history for the task dialog. Access is
// scoped through the same server/channel checks as task mutations.
taskRouter.get("/:taskId/history", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    const history = await taskService.listTaskHistory(task.id);
    if (typeof history === "string") {
      res.status(409).json({ error: history });
      return;
    }
    res.json({ events: history });
  } catch {
    res.status(500).json({ error: "Failed to read task history" });
  }
});

// Create tasks (batch)
taskRouter.post("/channel/:channelId", async (req, res) => {
  try {
    const surface = await resolveTaskChannelSurface(req.serverId!, req.params.channelId);
    if (!surface) {
      // A task's own conversation has no task surface; refuse it as a thread is.
      const channel = await channelService.getChannel(req.params.channelId);
      if (channel?.serverId === req.serverId && channel.type === "task") {
        res.status(409).json({ error: "Thread messages cannot become tasks" });
        return;
      }
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // A sub-conversation (a thread, a task's own conversation) holds no tasks.
    if (isSubConversationType(surface.localChannel.type)) {
      res.status(409).json({ error: "Thread messages cannot become tasks" });
      return;
    }
    if (await rejectIfNoTaskWriteAccess(surface.localChannel.id, req.userId!, req.serverId!, "create", res)) return;
    if (await rejectIfArchived(surface.localChannel.id, res)) return;

    const { tasks: items, status: requestedStatus } = req.body;
    // The status every task starts in (TASK_CREATE_STATUSES); default todo.
    // These tasks are unassigned; an in_progress one simply has no claimant.
    const statusRefusal = checkTaskCreateStatus(requestedStatus);
    if (statusRefusal) {
      res.status(400).json({ error: statusRefusal.message, code: statusRefusal.code });
      return;
    }
    const initialStatus = isTaskCreateStatus(requestedStatus) ? requestedStatus : undefined;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "tasks array is required" });
      return;
    }
    if (items.length > 50) {
      res.status(400).json({ error: "Cannot create more than 50 tasks at once" });
      return;
    }

    for (const item of items) {
      if (!item.title || typeof item.title !== "string" || item.title.trim().length === 0) {
        res.status(400).json({ error: "Each task must have a non-empty title" });
        return;
      }
      if (item.description != null && typeof item.description !== "string") {
        res.status(400).json({ error: "Task description must be a string" });
        return;
      }
      if (item.sourceMessageId != null && typeof item.sourceMessageId !== "string") {
        res.status(400).json({ error: "sourceMessageId must be a message id", code: "invalid_source_message" });
        return;
      }
    }

    const sourceRandomId = req.body.sourceRandomId;
    if (sourceRandomId !== undefined && (typeof sourceRandomId !== "string" || !sourceRandomId.trim() || sourceRandomId.length > 128)) {
      refuse(res, 400, { code: "invalid_source_random_id", error: "The source message key must be a non-empty string of at most 128 characters: send a short random id, or none." });
      return;
    }

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const createItems: taskService.TaskCreateItem[] = items.map((i) => ({
      title: i.title.trim(),
      description: i.description?.trim(),
      sourceMessageId: i.sourceMessageId ?? null,
    }));

    // sourceMessageId on a server without task v2 conversations is refused by
    // createTasks (TaskV2NotEnabledError → 403 task_v2_not_enabled). The v2
    // flag is read for this request's server (the local surface), never the
    // joint storage server.
    if (await isTaskV2ConversationsEnabled(surface.localChannel.serverId)) {
      // Every given source first, so a create refused for one of them posts
      // nothing. A reply in one of the channel's threads stands for its
      // thread's root message.
      for (const item of createItems) {
        if (!item.sourceMessageId) continue;
        const resolved = await taskService.resolveTaskSourceMessage(surface.storageChannelId, item.sourceMessageId);
        if (!resolved) {
          refuse(res, 400, {
            code: "invalid_source_message",
            error: "There is no such message in this channel or its threads to make a task from: pick a message in the channel the task goes on.",
          });
          return;
        }
        item.sourceMessageId = resolved.id;
      }
      // A task always has a source (#wg-task-v2:#23): tasks created here
      // without one get the creator's own channel message, posted now.
      const sourceless = createItems.filter((item) => !item.sourceMessageId);
      if (sourceless.length > 0) {
        const source = await postCreatorSourceMessage(req, res, {
          surface,
          items: sourceless,
          initialStatus,
          randomId: typeof sourceRandomId === "string" ? sourceRandomId.trim() : undefined,
          io,
          agentOrchestrator,
        });
        if (!source) return;
        // A retry whose response was lost: the message was reused, and if it
        // already carries this person's tasks with these titles, those are
        // the answer; creating them again would make every task twice.
        if (source.reused && sourceless.length === createItems.length) {
          const existing = await taskService.listTasksFromSourceByCreator(surface.storageChannelId, source.id, { type: "user", id: req.userId! });
          const titles = (list: readonly { title: string }[]) => list.map((item) => item.title).sort();
          if (existing.length > 0 && JSON.stringify(titles(existing)) === JSON.stringify(titles(createItems))) {
            res.json({ tasks: taskService.projectTasksToChannel(existing, surface.localChannel) });
            return;
          }
        }
        for (const item of sourceless) item.sourceMessageId = source.id;
      }
    }

    // If this fails after a source message was posted above, the message
    // stays: Raft has no deleting a person's message, and it already reached
    // the channel (and its agents). It is an ordinary message that says what
    // the person asked for; a retry from the dialog sends the same
    // sourceRandomId, so it is reused, not posted again.
    const { tasks: created, hostMessages, hostMessagesVisible } = await taskService.createTasks(
      surface.storageChannelId,
      "user",
      req.userId!,
      createItems,
      {
        initiatingServerId: surface.localChannel.serverId,
        ...(initialStatus !== undefined && { initialStatus }),
      },
    );
    const creatorName = created[0]?.createdByName || "Unknown";

    // Task v2 (task_v2_conversations_v0 on): creating a task writes no message
    // (each task has its own conversation), so nothing is broadcast as
    // message:new nor delivered to agents. Flag off (pre-v2, v1.4 tasks-table-canonical): the
    // host message is a plain channel message and broadcasts on the ordinary
    // message:new / agent-delivery path. Either way the task fact broadcasts
    // separately on the task board (task:created).
    const targets = await getTaskRealtimeSurfaceTargets(surface);
    for (const target of targets) {
      const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
      const projectedMessages = hostMessagesVisible
        ? hostMessages.map((message) => ({ ...message, channelId: target.channelId }))
        : [];
      for (const message of projectedMessages) {
        // message-realtime-producer: task-route.new.user
        emitTaskMessageNew(io, target, message, creatorName);
      }
      emitTaskCreated(io, target, {
        channelId: target.channelId,
        tasks: projectedTasks,
      });
      if (projectedMessages.length > 0) {
        await messageService.deliverMessagesToAgents(agentOrchestrator, projectedMessages, creatorName);
      }
    }

    // Emit system message to chat (visible to humans + agents, counts as unread).
    // Task v2 (flag on): creating a task posts nothing in the
    // channel (spec §2, §4); the task board event above is the whole update.
    const taskList = created.map((t) => `#${t.taskNumber} "${messageService.summarizeForSystemMessage(t.title)}"`).join(", ");
    const sysContent = `📋 ${created.length} new task${created.length > 1 ? "s" : ""} created: ${taskList}`;
    if (hostMessagesVisible) messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, surface.localChannel.id, sysContent, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
        causalActor: { type: "user", id: req.userId! },
      },
    }).catch(() => {});
    // Task v2: a task made from a message says so in its thread (📌, always).
    if (!hostMessagesVisible) {
      await announceTasksCreatedFromSourceMessages(io, agentOrchestrator, {
        tasks: created,
        localChannel: surface.localChannel,
        actor: { type: "user", id: req.userId! },
      });
    }

    res.json({ tasks: taskService.projectTasksToChannel(created, surface.localChannel) });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

/**
 * The text of the message a person's sourceless create posts as the tasks'
 * source: one title (and its description) as written, or several as a list.
 */
export function creatorSourceMessageContent(items: readonly { title: string; description?: string | null }[]): string {
  if (items.length === 1) {
    const [item] = items;
    return item!.description ? `${item!.title}\n\n${item!.description}` : item!.title;
  }
  return items
    .map((item) => {
      const description = item.description ? `\n${item.description.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
      return `- ${item.title}${description}`;
    })
    .join("\n");
}

/**
 * Task v2, a person creating tasks without a source message (the New task
 * dialog of a channel's Tasks card or the Tasks page): post their own ordinary
 * channel message saying what the tasks are, the source every one of them
 * hangs under (#wg-task-v2:#23). Everything the task create would refuse is
 * checked first, so a refused create posts nothing. Its thread gets the
 * "created from this message" line, as every source does. Null when it
 * answered a refusal.
 */
async function postCreatorSourceMessage(
  req: Request,
  res: Response,
  input: {
    surface: NonNullable<Awaited<ReturnType<typeof resolveTaskChannelSurface>>>;
    items: readonly taskService.TaskCreateItem[];
    initialStatus: Parameters<typeof checkTaskCreateStatus>[0];
    randomId: string | undefined;
    io: SocketServer;
    agentOrchestrator: AgentOrchestrator;
  },
): Promise<{ id: string; reused: boolean } | null> {
  const userId = req.userId!;
  const statusRefusal = checkTaskCreateStatus(input.initialStatus, { taskV2: true });
  if (statusRefusal) {
    refuse(res, 400, { code: statusRefusal.code, error: statusRefusal.message });
    return null;
  }
  const content = creatorSourceMessageContent(input.items);
  if (content.length > MAX_MESSAGE_LENGTH) {
    refuse(res, 400, { code: "task_source_message_too_long", error: "These tasks are too long to post as one message: shorten the titles or create fewer at once." });
    return null;
  }
  const refuseKeyReused = () => refuse(res, 409, {
    code: "source_random_id_reused",
    error: "This source message key was already used for a different message: send a new key with changed tasks.",
  });
  // A retry with the same key: its message is reused, never posted again,
  // and only for the same text in this channel.
  if (input.randomId) {
    const earlier = await taskService.findCreatorSourceMessageByRandomId(userId, input.randomId);
    if (earlier) {
      if (earlier.content !== content || earlier.channelId !== input.surface.storageChannelId) {
        refuseKeyReused();
        return null;
      }
      return { id: earlier.id, reused: true };
    }
  }
  const localChannelId = input.surface.localChannel.id;
  const admission = await checkHumanPostAdmission(req.serverId!, userId, localChannelId);
  if (!admission.ok) {
    if (admission.refusal === "billing_read_only") {
      if (admission.billing.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
      // refusal-ok: the plan read-only body keeps its own shape (externalFreezeAt), as on the send path (routes/messages.ts)
      res.status(403).json(channelBillingReadOnlyBody(admission.billing));
      return null;
    }
    const refusal = HUMAN_POST_REFUSALS[admission.refusal];
    refuse(res, refusal.status, { code: admission.refusal, error: refusal.error });
    return null;
  }
  const user = await userService.getUser(userId);
  try {
    // An ordinary message of the person's (not a system line): broadcast,
    // delivered and replied to like any other, except that it mentions
    // nobody: the person typed task titles, not a chat message, so an
    // `@name` in a title pings no one. Sent through the local channel; on a
    // joint channel broadcastAndDeliver stores it in the canonical (storage)
    // channel, where createTasks requires the source.
    // slack-bridge-ordinary-message-producer: tasks.create_source
    const message = await messageService.broadcastAndDeliver(input.io, input.agentOrchestrator, {
      channelId: localChannelId,
      senderType: "user",
      senderId: userId,
      senderName: user?.displayName || user?.name || "User",
      content,
      contentMentions: false,
      // Agents get it before the tasks exist: say what it is, so an agent
      // doesn't take the titles as a new request to make into tasks itself.
      agentContentPrefix: `[Posted automatically as the source of the ${input.items.length === 1 ? "task" : "tasks"} this person is creating from it in Raft now; ${input.items.length === 1 ? "it is" : "they are"} not yours unless assigned to you.]`,
      ...(input.randomId ? { randomId: input.randomId } : {}),
    });
    // A concurrent request with the same key won the insert: same rule.
    if (message.content !== content) {
      refuseKeyReused();
      return null;
    }
    return { id: message.id, reused: false };
  } catch (err) {
    if (err instanceof messageService.UserRandomIdConflictError) {
      refuseKeyReused();
      return null;
    }
    if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
      refuse(res, err.status, { code: err.code, error: err.message });
      return null;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, { code: "channel_archived", error: "This channel is archived: unarchive it before creating tasks in it." });
      return null;
    }
    throw err;
  }
}

/** Normalized task fields shared between canonical and message-based tasks. */
interface ResolvedTask {
  id: string;
  /** Which table owns this task. Every mutation and broadcast routes on it. */
  source: "tasks";
  channelId: string;
  storageChannelId: string;
  localChannel: TaskSurfaceChannel;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  taskNumber: number;
  title: string;           // title (canonical) or content (message-task)
  creatorType: string;     // createdByType or senderType
  creatorId: string;       // createdById or senderId
  /** Pre-v2 host message (its thread = earlier discussion); null for task v2 tasks and pre-thread orphans. */
  messageId: string | null;
  /**
   * True only for tasks with neither a host message nor their own conversation
   * — the pre-message-task orphans that predate threads and stay read-only. This is deliberately NOT "came
   * from the tasks table": v1.4 puts every new task there, and keying it on
   * the table would mark all of them read-only.
   */
  isLegacy: boolean;
  /**
   * True when the task's parent channel has been soft-deleted. Mutations
   * on these tasks are restricted to terminal-only verbs (status →
   * done/closed) so users can clear orphans from their Tasks panel without
   * resurrecting work in a dead channel. See `rejectIfOrphanNonTerminal`.
   */
  isOrphan: boolean;
  raw: any;                // original row for service calls
  /**
   * The resolved ownership handle, carried so mutations can hand the whole
   * thing to a service-layer writer instead of re-deriving "which side owns
   * this" from the flattened fields. Re-deriving is how the delete path grew a
   * second, wrong implementation.
   */
  owner: taskService.TaskOwner;
  jointSurface: Awaited<ReturnType<typeof resolveTaskChannelSurfaceForStorage>>;
}

/** Reject mutations on archived channels. Returns true if blocked (response already sent). */
async function rejectIfArchived(channelId: string, res: Response): Promise<boolean> {
  if (await channelService.isChannelArchived(channelId)) {
    res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
    return true;
  }
  return false;
}

/** Public channels may be readable without membership, but task mutations require write authority. */
async function rejectIfNoTaskWriteAccess(
  channelId: string,
  userId: string,
  serverId: ServerId,
  action: TaskAction,
  res: Response,
  relationship: { isCreator?: boolean; isAssignee?: boolean } = {},
): Promise<boolean> {
  const [canReadChannel, canWriteChannel, hasAssignTasks, hasDeleteAnyTask] = await Promise.all([
    channelService.canUserAccessChannel(channelId, userId, serverId, { includeDeleted: true }),
    channelService.canUserPostToChannel(channelId, userId),
    actorHasServerCapabilityInServer(serverId, "user", userId, "assignTasks"),
    actorHasServerCapabilityInServer(serverId, "user", userId, "deleteAnyTask"),
  ]);
  if (!authorizeTaskAction({
    action,
    canReadChannel,
    canWriteChannel,
    hasAssignTasks,
    hasDeleteAnyTask,
    ...relationship,
  })) {
    res.status(403).json({ error: "You must join this channel to modify tasks" });
    return true;
  }
  return false;
}

/**
 * Reject mutations on orphaned tasks unless they target a terminal status.
 * Orphans live in soft-deleted channels — `requireTaskInServer` resolved them
 * with `includeDeleted: true` so they're visible to the user, but only
 * terminal verbs (`done`, `closed`) are permitted to drain them from the
 * panel without re-opening work in a dead channel.
 *
 * Returns `true` if the request is blocked (response already sent).
 */
function rejectIfOrphanNonTerminal(task: ResolvedTask, intent: "terminal" | "non_terminal", res: Response): boolean {
  if (!task.isOrphan) return false;
  if (intent === "terminal") return false;
  res.status(409).json({
    error: "This channel was deleted; only mark-done or mark-closed are allowed on the task",
    code: "channel_deleted_terminal_only",
  });
  return true;
}

/** Skip channel access / archive / write checks when the channel is soft-deleted (orphan path). */
async function rejectIfNoChannelWriteAccess(
  task: ResolvedTask,
  userId: string,
  serverId: ServerId,
  action: TaskAction,
  res: Response,
  relationship: { isCreator?: boolean; isAssignee?: boolean } = {},
): Promise<boolean> {
  if (task.isOrphan) {
    const serverRole = await getActorServerRoleInServer(serverId, "user", userId);
    if (serverRole === "guest") {
      res.status(403).json({ error: "Guests can't change tasks" });
      return true;
    }
    return false;
  }
  if (task.jointSurface && isHistoricalJointTaskReadOnly(task.jointSurface, task.raw.createdAt)) {
    res.status(403).json({ error: "Historical tasks are read-only from a participant workspace", code: "joint_task_read_only" });
    return true;
  }
  if (await rejectIfNoTaskWriteAccess(task.channelId, userId, serverId, action, res, relationship)) return true;
  if (await rejectIfArchived(task.channelId, res)) return true;
  return false;
}

/** Validate task exists and belongs to current server. Checks both message-based and legacy tasks.
 *
 * If the task's parent channel has been soft-deleted, we still resolve it
 * (with `includeDeleted: true`) and mark `isOrphan = true`. Routes can then
 * call `rejectIfOrphanNonTerminal` to allow only terminal-only mutations
 * (mark done/closed) so users can clear stale tasks from their panel without
 * resurrecting work in a dead channel.
 *
 * Channel-archived (different state from deleted) and access checks still
 * run normally — orphan handling only relaxes the deletedAt filter.
 */
async function requireTaskInServer(req: Request, res: Response): Promise<ResolvedTask | null> {
  const owner = await taskService.resolveTaskById(String(req.params.taskId));
  if (!owner) { res.status(404).json({ error: "Task not found" }); return null; }

  const storageChannelId = owner.row.channelId;
  const surface = await resolveTaskChannelSurfaceForStorage(req.serverId!, storageChannelId, { includeDeleted: true });
  if (!surface) { res.status(404).json({ error: "Task not found" }); return null; }
  if (!await channelService.canUserAccessChannel(surface.localChannel.id, req.userId!, req.serverId!, { includeDeleted: true })) {
    res.status(404).json({ error: "Task not found" });
    return null;
  }

  const isOrphan = surface.localChannel.deletedAt != null;
  // P3: canonical-only. The former `source: "message"` branch is deleted -- the
  // resolver can no longer return a message-owned task.
  const row = owner.row;
  return {
    id: row.id,
    source: "tasks",
    channelId: surface.localChannel.id,
    storageChannelId,
    localChannel: surface.localChannel,
    channelType: surface.localChannel.type,
    taskNumber: row.taskNumber,
    title: row.title,
    creatorType: row.createdByType,
    creatorId: row.createdById,
    messageId: row.messageId,
    isLegacy: row.messageId == null && row.conversationChannelId == null && !row.ownConversation,
    isOrphan,
    raw: row,
    owner,
    jointSurface: surface,
  };
}

/**
 * Enrich and emit socket events for a task mutation result.
 *
 * A canonical task's host message does not change on mutation, so emitting it
 * as a message row would be a lie — the task board event alone carries the
 * update. Pre-P3 a message-owned task also produced `message:updated`; that
 * ownership branch is gone with the shape.
 */
async function emitTaskUpdate(req: Request, task: ResolvedTask, result: taskService.TaskMutationResult) {
  if (typeof result === "string") throw new Error(`emitTaskUpdate called with failure: ${result}`);
  const enriched = await taskService.enrichSingleLegacyTask(result.row);
  const io: SocketServer = req.app.get("io");
  // P3: the `message:updated` arm is gone. It fired only for a message-owned
  // task, which can no longer be resolved, so the task-board event alone now
  // carries every mutation.
  const surface = {
    storageChannelId: task.storageChannelId,
    localChannel: task.localChannel,
    ...writeTaskSurfaceFields(task.jointSurface!),
  };
  for (const target of await getTaskRealtimeSurfaceTargets(surface)) {
    const projected = taskService.projectTaskToChannel(enriched, target.localChannel);
    emitTaskUpdated(io, target, { channelId: target.channelId, task: projected });
  }
  return taskService.projectTaskToChannel(enriched, task.localChannel);
}

/**
 * Post a task lifecycle system message ("📌 X claimed", "✅ Y moved to Done", …)
 * into the task's own thread channel — never the parent channel.
 *
 * stdrc 2026-05-07 #proj-task:5f016c34 e1c404b6:
 *   "task 的状态变化是要更新到 task thread 的，但是不应该更新到它所在的 channel 里"
 *
 * The contract:
 *   - parent channel: stays clean (PR #1242 removed all channel-side broadcasts)
 *   - task thread: gets the system message, fan-out reaches everyone who
 *     follows that thread (which by construction = people who care about
 *     this task's lifecycle)
 *
 * Legacy tasks are skipped — they have no real `messageId` to anchor a thread
 * on. They predate threads and we're letting them age out without retrofit.
 *
 * The thread is lazy-created if it doesn't exist yet (channelService.
 * getOrCreateThread). Errors are swallowed — a failed lifecycle notice must
 * never block the actual task mutation, which has already committed by the
 * time we get here.
 *
 * Task v2: the line goes to the task's own conversation (channels.type =
 * 'task'), created on demand for a pre-v2 task on a flag-on server. Without a
 * conversation (flag off) it keeps the pre-v2 host-thread behaviour above,
 * with `legacyContent` when the pre-v2 text differs.
 *
 * `attention` = the new assignee when someone else handed them the task: the
 * assignee follows the conversation and the line mentions them once (inbox
 * entry / agent wake, mute-piercing). See ../services/taskConversationNotice.
 */
// Task v2: routes that post a lifecycle line first pass the committed mutation
// through `withTaskConversationEnsured`, so a pre-v2 task on a flag-on server
// gets its conversation before the mutation is broadcast and answered — one
// task:updated / response carrying the new conversation, never a stale one
// racing the notice's own refresh.
async function postTaskLifecycleToThread(
  req: Request,
  task: ResolvedTask,
  actor: { type: "user" | "agent"; id: string },
  content: string,
  attention: messageService.ResolvedMentionFact | null = null,
  legacyContent?: string | null,
  follower: { type: "user" | "agent"; id: string } | null = null,
  actionMetadata?: TaskAssignmentNoticeMetadata,
): Promise<void> {
  try {
    await postTaskConversationNotice(
      req.app.get("io") as SocketServer,
      req.app.get("agentOrchestrator") as AgentOrchestrator,
      {
        taskId: task.id,
        localChannel: task.localChannel,
        actor,
        content,
        attention,
        legacyContent,
        follower,
        actionMetadata,
      },
    );
  } catch (err) {
    console.error("Failed to post task lifecycle system message to thread:", err);
  }
}

// Claim a task
taskRouter.patch("/:taskId/claim", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (task.channelType === "thread") {
      res.status(409).json({ error: "Thread messages cannot be claimed as tasks" });
      return;
    }
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "claim", res)) return;

    const result = await taskService.claimTask(task.id, "user", req.userId!, req.serverId!);
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, await withTaskConversationEnsured(result, { initiatingServerId: task.localChannel.serverId }));
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    // Task v2: the claimer follows the task conversation (reason `assigned`,
    // an explicit unfollow is reactivated), as an assignee would, and the
    // conversation gets one line per change, worded as every other path words
    // it (took / moved to In Progress). Flag off: the pre-v2 "claimed" line.
    void announceTaskClaim(
      req.app.get("io") as SocketServer,
      req.app.get("agentOrchestrator") as AgentOrchestrator,
      {
        taskId: task.id,
        taskNumber: task.taskNumber,
        title: task.title,
        localChannel: task.localChannel,
        actor: { type: "user", id: req.userId! },
        before: { status: task.raw.status, claimedByType: task.raw.claimedByType, claimedById: task.raw.claimedById },
        afterStatus: result.row.status,
        legacyContent: `📌 ${enriched.claimedByName || "Someone"} claimed #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`,
      },
    );

    res.json({ task: enriched });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to claim task" });
  }
});

// Convert a message into a task (unclaimed, status: todo)
taskRouter.post("/convert-message", async (req, res) => {
  try {
    const { messageId } = req.body;
    if (!messageId) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }

    // Resolve the persisted message through this server's local surface. Joint
    // messages live in canonical storage and must not be authorized by that raw
    // channel id.
    const msg = await messageService.getMessage(messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const surface = await resolveTaskChannelSurfaceForStorage(req.serverId!, msg.channelId);
    if (!surface) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (await rejectIfNoTaskReadAccess(surface.localChannel.id, req.userId!, req.serverId!, res)) return;
    // After access: a message behind the plan's history window can't become a
    // task (its text would be the title) (services/historyWindow.ts).
    const historyWindow = await getServerHistoryWindowForRead(req.serverId!);
    if (isBehindHistoryWindow(msg.createdAt, historyWindow)) {
      res.status(404).json(humanHistoryLimitedError(historyWindow));
      return;
    }
    if (surface.localChannel.type === "thread") {
      res.status(409).json({ error: "Thread messages cannot be claimed as tasks" });
      return;
    }
    if (isHistoricalJointTaskReadOnly(surface, msg.createdAt)) {
      res.status(403).json({
        error: "Historical tasks are read-only from a participant workspace",
        code: "joint_task_read_only",
      });
      return;
    }
    if (await rejectIfNoTaskWriteAccess(surface.localChannel.id, req.userId!, req.serverId!, "convert", res)) return;
    if (await rejectIfArchived(surface.localChannel.id, res)) return;

    // Task v2 server: a message is never converted. The web creates a task
    // from it instead (POST /channel/:id with sourceMessageId).
    const useCreate = await taskV2WebConvertRefusal(surface.storageChannelId, surface.localChannel.serverId);
    if (useCreate) {
      res.status(useCreate.status).json(useCreate.body);
      return;
    }

    const result = await taskService.convertMessageToTask(messageId, "user", req.userId!, surface.storageChannelId);
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const enriched = await taskService.enrichSingleLegacyTask(result);
    const io: SocketServer = req.app.get("io");
    // v1.4: converting does not rewrite the host message, so there is no
    // `message:updated` to emit and nothing new to deliver to agents — the
    // message itself was already delivered when it was sent. Only the task
    // board learns something new here.
    for (const target of await getTaskRealtimeSurfaceTargets(surface)) {
      const projected = taskService.projectTaskToChannel(enriched, target.localChannel);
      emitTaskCreated(io, target, { channelId: target.channelId, tasks: [projected] });
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    // Emit system message with both task number and message ID for agent reference
    const converterName = enriched.createdByName || "Someone";
    const sysContent = `📋 ${converterName} converted a message to task #${result.taskNumber} "${messageService.summarizeForSystemMessage(result.title)}"`;
    messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, surface.localChannel.id, sysContent, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.converted_summary",
        reason: "newly created task is shared channel activity",
        causalActor: { type: "user", id: req.userId! },
      },
    }).catch(() => {});

    res.json({ task: taskService.projectTaskToChannel(enriched, surface.localChannel) });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to convert message to task" });
  }
});

/**
 * Task v2: ensure the task's conversation and answer the one this surface sees.
 * A task created before task v2 has none yet on a flag-on server (its old
 * discussion stays the host message's own replies); this creates it
 * (idempotent; broadcasts `task:updated` when created) and answers
 * `{ conversationChannelId, canonicalConversationChannelId, created }`, where
 * `conversationChannelId` is this server's local conversation (the canonical
 * one for an ordinary channel, the local projection for a joint channel).
 * Flag off on this server and no conversation yet: 409
 * `task_v2_not_enabled` (the discussion is the host message's thread).
 */
taskRouter.post("/:taskId/conversation", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (task.isLegacy) {
      res.status(409).json({ error: "This task has no conversation", code: "task_without_conversation" });
      return;
    }
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (task.jointSurface && isHistoricalJointTaskReadOnly(task.jointSurface, task.raw.createdAt)) {
      res.status(403).json({ error: "Historical tasks are read-only from a participant workspace", code: "joint_task_read_only" });
      return;
    }
    if (!await channelService.canUserPostToChannel(task.channelId, req.userId!)) {
      res.status(403).json({ error: "You must join this channel to reply in this task" });
      return;
    }
    if (await rejectIfArchived(task.channelId, res)) return;

    const io: SocketServer = req.app.get("io");
    const hadConversation = task.raw.conversationChannelId != null;
    const conversation = await ensureTaskConversationAndBroadcast(io, task.id, {
      initiatingServerId: task.localChannel.serverId,
      createdByUserId: req.userId!,
    });
    if (!conversation) {
      res.status(409).json({
        error: "Task conversations are not enabled on this server; the task's discussion is its message thread",
        code: "task_v2_not_enabled",
      });
      return;
    }
    const local = [...conversation.localByServer.values()].find((entry) => entry.localParentChannelId === task.channelId);
    res.json({
      conversationChannelId: local?.localChannelId ?? conversation.canonicalChannelId,
      canonicalConversationChannelId: conversation.canonicalChannelId,
      created: !hadConversation,
    });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    console.error("Failed to open task conversation:", error);
    res.status(500).json({ error: "Failed to open task conversation" });
  }
});

// Unclaim a task
taskRouter.patch("/:taskId/unclaim", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "unclaim", res, {
      isAssignee: task.raw.claimedByType === "user" && task.raw.claimedById === req.userId!,
    })) return;

    const result = await taskService.unclaimTask(task.id, "user", req.userId!, req.serverId!);
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, await withTaskConversationEnsured(result, { initiatingServerId: task.localChannel.serverId }));
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    const user = await userService.getUser(req.userId!);
    const userName = user?.displayName || user?.name || "Someone";
    postTaskLifecycleToThread(
      req,
      task,
      { type: "user", id: req.userId! },
      `🔓 ${userName} released #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`,
    );

    res.json({ task: enriched });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to unclaim task" });
  }
});

/**
 * Set or clear a task's assignee.
 *
 * Distinct from `claim`/`unclaim`, which are retained for un-upgraded clients:
 *  - `claim` = "I am starting this" (assigns self, advances todo -> in_progress)
 *  - `unclaim` = "I am putting it down" (assignee only)
 *  - this = "who owns this" (anyone with `assignTasks`, including on someone
 *    else's task, including clearing it)
 *
 * Body: `{ assignee: { type: "user"|"agent", id } }` to assign,
 *       `{ assignee: null }` to unassign,
 *       optional `expectedRevision` for optimistic concurrency (409 on stale),
 *       optional `reason` when handing it to someone else: what it waits on
 *       them for (`checkTaskAssignReason`; optional for a person). It goes on
 *       the `assignee_changed` event, the conversation line and the
 *       assignee's notification.
 */
taskRouter.patch("/:taskId/assignee", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "assign", res)) return;

    // Member-level by design (@stdrc: 任何人都可以 assign 给别人). Gating this on
    // `manageServer` would make assignment an admin action, which is the
    // opposite of the ruling. A Guest holds no server capability, yet assigns
    // in its bound channel (matrix §1): rejectIfNoChannelWriteAccess above
    // already confined it to that channel, and assignTask refuses an assignee
    // who is not in the channel, for everyone.
    if (
      await getActorServerRoleInServer(req.serverId!, "user", req.userId!) !== "guest"
      && !await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "assignTasks")
    ) {
      res.status(403).json({ error: "You do not have permission to assign tasks" });
      return;
    }

    const body = req.body as {
      assignee?: { type?: unknown; id?: unknown } | null;
      expectedRevision?: unknown;
      reason?: unknown;
    };
    if (!("assignee" in body)) {
      res.status(400).json({ error: "assignee is required (use null to unassign)" });
      return;
    }

    let assignee: { type: "user" | "agent"; id: string } | null = null;
    if (body.assignee !== null) {
      const type = body.assignee?.type;
      const id = body.assignee?.id;
      if ((type !== "user" && type !== "agent") || typeof id !== "string" || !id) {
        res.status(400).json({ error: "assignee must be { type: 'user'|'agent', id } or null" });
        return;
      }
      assignee = { type, id };
    }

    let expectedRevision: number | undefined;
    if (body.expectedRevision !== undefined) {
      if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
        res.status(400).json({ error: "expectedRevision must be an integer" });
        return;
      }
      expectedRevision = body.expectedRevision;
    }

    const handoff = assignee !== null && !(assignee.type === "user" && assignee.id === req.userId);
    const reasonCheck = checkTaskAssignReason(body.reason, handoff);
    if (reasonCheck.refusal) {
      refuse(res, 400, { code: reasonCheck.refusal.code, error: reasonCheck.refusal.message });
      return;
    }
    const reason = reasonCheck.reason;
    // Re-assigning the current assignee changes nothing: a reason would go
    // nowhere, so it is refused, not dropped (a reply is how to tell them).
    const unchanged = assignee
      ? task.raw.claimedByType === assignee.type && task.raw.claimedById === assignee.id
      : task.raw.claimedById === null;
    if (unchanged && reason) {
      refuse(res, 409, { code: TASK_ASSIGN_REASON_UNCHANGED, error: taskService.TASK_ASSIGN_REASON_UNCHANGED_ERROR });
      return;
    }

    const result = await taskService.assignTask(task.id, assignee, "user", req.userId!, { expectedRevision, serverId: req.serverId!, reason });
    if (typeof result === "string") {
      // A lost OCC race is reported with the current token so the client can
      // re-read and retry without guessing.
      if (result === "task state changed concurrently") {
        const current = await taskService.resolveTaskById(task.id);
        res.status(409).json({ error: result, currentRevision: current?.row.revision ?? null });
        return;
      }
      res.status(409).json({ error: result });
      return;
    }

    const enriched = await emitTaskUpdate(
      req,
      task,
      result.row.revision !== task.raw.revision ? await withTaskConversationEnsured(result, { initiatingServerId: task.localChannel.serverId }) : result,
    );
    // A no-op (same assignee) is success without a revision bump: it changed
    // nothing, so it announces nothing — the assignee hears about it once.
    if (result.row.revision !== task.raw.revision) {
      const actor = { type: "user" as const, id: req.userId! };
      const notice = await buildTaskAssignmentNotice({
        actor,
        assignee,
        taskNumber: task.taskNumber,
        title: task.title,
        reason,
      });
      // Flag off (no conversation): the pre-v2 line, no mention, as before.
      const legacyLine = await buildLegacyTaskAssignmentLine({
        actor,
        assignee,
        taskNumber: task.taskNumber,
        title: task.title,
        reason,
      });
      void postTaskLifecycleToThread(req, task, actor, notice.content, notice.attention, legacyLine, notice.follower, notice.actionMetadata);
    }

    res.json({ task: enriched });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to assign task" });
  }
});

/**
 * Edit a task's title and/or description (Task v2 to-do list, #wg-task-v2:#10;
 * @stdrc 2026-10-31 msg 7bf6030a: people must be able to edit both on the web).
 *
 * Body: `{ title?, description?, clearDescription?, expectedRevision? }`. At
 * least one of title / description / clearDescription. The title is trimmed
 * and must not be empty; a description that is empty after trimming clears
 * it, as `clearDescription: true` does. Limits are the agent amend's
 * (TASK_TITLE_MAX_LENGTH / TASK_DESCRIPTION_MAX_LENGTH).
 *
 * Same authority as `raft task amend`: a current member of the channel who may
 * post there (taskService.amendTask re-checks it inside the write), never a
 * Guest, never on an archived channel, a deleted channel's task or a
 * historical joint task. `expectedRevision` is the OCC token: a stale one
 * loses with 409 and the current revision, and writes nothing.
 *
 * A saved edit records the `amended` event (History) and writes one line in
 * the task's discussion ("✏️ Ana changed the title of #7 …"). It notifies
 * nobody: followers see the line when they next read the task, and an agent's
 * freshness check shows it on its next write to the task. Saving the text
 * unchanged is success without a revision bump, an event or a line.
 */
taskRouter.patch("/:taskId", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "amend", res)) return;

    const body = (req.body ?? {}) as {
      title?: unknown;
      description?: unknown;
      clearDescription?: unknown;
      expectedRevision?: unknown;
    };
    const patch: taskService.TaskAmendPatch = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        res.status(400).json({ error: "title must be a non-empty string" });
        return;
      }
      const title = body.title.trim();
      if (title.length > TASK_TITLE_MAX_LENGTH) {
        res.status(400).json({ error: `title must be at most ${TASK_TITLE_MAX_LENGTH} characters` });
        return;
      }
      patch.title = title;
    }
    if (body.clearDescription !== undefined && typeof body.clearDescription !== "boolean") {
      res.status(400).json({ error: "clearDescription must be a boolean" });
      return;
    }
    if (body.clearDescription === true && body.description !== undefined) {
      res.status(400).json({ error: "Send either description or clearDescription, not both" });
      return;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        res.status(400).json({ error: "description must be a string (use clearDescription to remove it)" });
        return;
      }
      const description = body.description.trim();
      if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
        res.status(400).json({ error: `description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters` });
        return;
      }
      patch.description = description.length > 0 ? description : null;
    } else if (body.clearDescription === true) {
      patch.description = null;
    }
    if (patch.title === undefined && patch.description === undefined) {
      res.status(400).json({ error: "title, description or clearDescription is required" });
      return;
    }

    let expectedRevision: number | undefined;
    if (body.expectedRevision !== undefined) {
      if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
        res.status(400).json({ error: "expectedRevision must be an integer" });
        return;
      }
      expectedRevision = body.expectedRevision;
    }

    const result = await taskService.amendTask(task.id, patch, "user", req.userId!, {
      expectedRevision,
      serverId: req.serverId!,
    });
    if (typeof result === "string") {
      if (result === taskService.TASK_AMEND_NO_CHANGES_ERROR) {
        // Saving the text as it is changed nothing: success, nothing written.
        const enriched = await taskService.enrichSingleLegacyTask(task.raw);
        res.json({ task: taskService.projectTaskToChannel(enriched, task.localChannel) });
        return;
      }
      if (result === taskService.TASK_AMEND_STALE_REVISION_ERROR) {
        // A lost OCC race is reported with the current token so the client can
        // re-read and retry without guessing (as PATCH /:taskId/assignee).
        const current = await taskService.resolveTaskById(task.id);
        res.status(409).json({ error: result, currentRevision: current?.row.revision ?? null });
        return;
      }
      if (result === taskService.TASK_AMEND_MEMBERSHIP_ERROR) {
        res.status(403).json({ error: "You must join this channel to modify tasks" });
        return;
      }
      if (result === "task not found") {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      res.status(409).json({ error: result });
      return;
    }

    const enriched = await emitTaskUpdate(
      req,
      task,
      await withTaskConversationEnsured({ source: "tasks" as const, row: result.row }, { initiatingServerId: task.localChannel.serverId }),
    );
    const actor = { type: "user" as const, id: req.userId! };
    const notice = await buildTaskAmendNotice({
      actor,
      taskNumber: task.taskNumber,
      title: result.row.title,
      changed: {
        title: result.event.payload.changes.title !== undefined,
        description: result.event.payload.changes.description !== undefined,
      },
    });
    // Without a conversation (flag off) the same line goes to the host
    // message's thread, the discussion of a pre-v2 task, as status lines do.
    if (notice) void postTaskLifecycleToThread(req, task, actor, notice);

    res.json({ task: enriched });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to edit task" });
  }
});

// Update task status (assignee or admin/owner)
taskRouter.patch("/:taskId/status", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;

    const { status, reason } = req.body;
    if (typeof status !== "string" || !isTaskStatus(status)) {
      res.status(400).json({ error: `valid status is required (${TASK_STATUSES.join(", ")})` });
      return;
    }
    // A move into backlog may say what would bring the task back; no other status takes a reason.
    const reasonCheck = checkTaskStatusReason(status, reason);
    if (reasonCheck.refusal) {
      refuse(res, 400, { code: reasonCheck.refusal.code, error: reasonCheck.refusal.message });
      return;
    }
    const backlogReason = reasonCheck.reason;

    // Orphan tasks (channel deleted) only allow terminal verbs
    const isTerminal = status === "done" || status === "closed";
    if (rejectIfOrphanNonTerminal(task, isTerminal ? "terminal" : "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "change_status", res, {
      isAssignee: task.raw.claimedByType === "user" && task.raw.claimedById === req.userId!,
    })) return;

    // Orphan tasks (channel deleted) go through the admin force path: the
    // original assignee may be a deleted agent. Everyone else, admins
    // included, takes the member-level update. Since any status can move to
    // any other (#12227), its refusals are invariants or lost write races, so
    // an admin retry with force would only let admins win races.
    let result: taskService.TaskMutationResult;
    if (task.isOrphan) {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteAnyTask")) {
        res.status(403).json({ error: "Only server admins can close tasks in deleted channels" });
        return;
      }
      result = await taskService.forceUpdateTaskStatus(task.id, status, "user", req.userId!, req.serverId!, {
        initiatingServerId: task.localChannel.serverId,
        ...(backlogReason && { backlogReason }),
      });
    } else {
      result = await taskService.updateTaskStatus(task.id, status, req.userId!, "user", req.serverId!, {
        initiatingServerId: task.localChannel.serverId,
        ...(backlogReason && { backlogReason }),
      });
    }
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, await withTaskConversationEnsured(result, { initiatingServerId: task.localChannel.serverId }));
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    const actor = { type: "user" as const, id: req.userId! };
    // Nothing changed (in_review asked of a task v2 task already in_progress): no line.
    if (!result.unchanged) {
      postTaskLifecycleToThread(
        req,
        task,
        actor,
        // What was stored: a task v2 task asked for in_review stores in_progress.
        await buildTaskStatusNotice({ actor, taskNumber: task.taskNumber, title: task.title, status: result.row.status, backlogReason }),
      );
    }

    res.json({ task: enriched });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to update task status" });
  }
});

// Delete a task (creator or admin/owner).
// Orphan tasks (channel deleted) are also deletable here — DELETE is a
// terminal cleanup action. The creator can delete their own orphan task;
// non-creators need the deleteAnyTask capability. This is intentionally
// the user who created the task should be able to clean it up even after
// the channel is gone, without requiring admin escalation.
taskRouter.delete("/:taskId", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    // Orphan tasks can be deleted (terminal cleanup action)
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "delete", res, {
      isCreator: task.creatorType === "user" && task.creatorId === req.userId!,
    })) return;

    const isCreator = task.creatorType === "user" && task.creatorId === req.userId;
    if (!isCreator) {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteAnyTask")) {
        res.status(403).json({ error: "Only the task creator or server admins can delete" });
        return;
      }
    }

    // One deleter, chosen by ownership. Branching here on `source` and calling
    // `deleteLegacyTask` alone was wrong for a backfilled task: dropping the
    // canonical row also drops the anti-join that suppresses its message-side
    // shadow, so the "deleted" task reappears on the board from the other
    // table. `deleteTaskByOwner` removes both sides.
    // Task v2 (W6): deleting a task deletes its conversation with it: every
    // face is soft-deleted and detached in the delete transaction (bridged
    // messages stay referenced), its follows go and every listing hides it.
    const conversations = await listTaskConversationsByParentChannel(task.id);
    await taskService.deleteTaskByOwner(task.owner, { type: "user", id: req.userId!, serverId: req.serverId! });

    const io: SocketServer = req.app.get("io");
    const surface = {
      storageChannelId: task.storageChannelId,
      localChannel: task.localChannel,
      ...writeTaskSurfaceFields(task.jointSurface!),
    };
    for (const target of await getTaskRealtimeSurfaceTargets(surface)) {
      const conversationChannelId = conversations.get(target.channelId);
      emitTaskDeleted(io, target, { channelId: target.channelId, taskId: task.id, ...(conversationChannelId && { conversationChannelId }) });
    }

    // A task created the v2 way posted nothing in the channel, so its
    // deletion posts nothing there either. Pre-v2 tasks: the line, as before.
    if (!task.raw.ownConversation) {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      const user = await userService.getUser(req.userId!);
      const userName = user?.displayName || user?.name || "Someone";
      messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, task.channelId,
        `🗑 ${userName} deleted #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`, {
          inboxFactPolicy: {
            mode: "skip",
            producer: "task.deleted_summary",
            reason: "task lifecycle churn should not move Activity unread",
          },
        }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (error) {
    if (respondToTaskWriteError(error, res)) return;
    res.status(500).json({ error: "Failed to delete task" });
  }
});
