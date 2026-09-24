import { Router, type Request, type Response, type Router as RouterType } from "express";
import * as taskService from "../services/taskService.js";
import * as channelService from "../services/channelService.js";
import * as messageService from "../services/messageService.js";
import * as userService from "../services/userService.js";
import * as agentService from "../services/agentService.js";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { authorizeTaskAction, isTaskStatus, type ServerId, type TaskAction, type TaskStatus } from "@botiverse/raft-shared";
import { UUID_RE } from "../lib/messageId.js";
import { emitTaskCreated, emitTaskDeleted, emitTaskMessageNew, emitTaskUpdated } from "../services/taskRealtimeEvents.js";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions.js";
import {
  getTaskRealtimeSurfaceTargets,
  resolveTaskChannelSurface,
  resolveTaskChannelSurfaceForStorage,
  type TaskSurfaceChannel,
} from "../services/taskChannelSurface.js";

export const taskRouter: RouterType = Router();

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
    res.json({ tasks: taskService.projectTasksToChannel(tasks, surface.localChannel) });
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
    res.json({ task: taskService.projectTaskToChannel(enriched, surface.localChannel) });
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

/** Opaque cursor codec: base64url(JSON { c: channelId, n: taskNumber }). */
function encodeServerTasksCursor(cursor: { channelId: string; taskNumber: number }): string {
  return Buffer.from(JSON.stringify({ c: cursor.channelId, n: cursor.taskNumber }), "utf8").toString("base64url");
}

function decodeServerTasksCursor(raw: string): { channelId: string; taskNumber: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { c?: unknown; n?: unknown };
    if (typeof parsed?.c !== "string" || !UUID_RE.test(parsed.c)) return null;
    if (typeof parsed?.n !== "number" || !Number.isInteger(parsed.n) || parsed.n < 1) return null;
    return { channelId: parsed.c, taskNumber: parsed.n };
  } catch {
    return null;
  }
}

// List all channel tasks for the current server
taskRouter.get("/server", async (req, res) => {
  try {
    // Validate + narrow the optional ?status filter (was an `as TaskStatus` cast).
    const statusParam = req.query.status;
    let statusFilter: TaskStatus | undefined;
    if (statusParam !== undefined) {
      if (typeof statusParam !== "string" || !isTaskStatus(statusParam)) {
        res.status(400).json({ error: "Invalid status value" });
        return;
      }
      statusFilter = statusParam;
    }
    // Additive read shapes (2026-09, >16 MiB task-panel response on artin's
    // device). With NO new params the response keeps the legacy shape — full
    // rows, unpaginated, no next_cursor key — so existing clients are
    // unaffected. All new params are opt-in and compose with ?status:
    //   ?limit=1..500&cursor=<opaque>  stable total-order keyset pagination
    //                                  (channel name ASC, then taskNumber ASC)
    //   ?detail=summary                small per-item projection (no
    //                                  description body or other large text)
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

    const cursorParam = req.query.cursor;
    let cursor: { channelId: string; taskNumber: number } | null = null;
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
    const legacyShape = limitParam === undefined && cursorParam === undefined && detailParam === undefined;
    let payload: { tasks: unknown[]; next_cursor?: string | null };
    if (legacyShape) {
      payload = { tasks: await taskService.listServerTasks(req.serverId!, statusFilter, req.userId!) };
    } else {
      const page = await taskService.listServerTasksPage(req.serverId!, statusFilter, req.userId!, { limit, cursor, detail });
      if (typeof page === "string") {
        // Only failure the service reports: the cursor's channel fell out of
        // the visible set, so its position in the total order is unknowable.
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
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (surface.localChannel.type === "thread") {
      res.status(409).json({ error: "Thread messages cannot become tasks" });
      return;
    }
    if (await rejectIfNoTaskWriteAccess(surface.localChannel.id, req.userId!, req.serverId!, "create", res)) return;
    if (await rejectIfArchived(surface.localChannel.id, res)) return;

    const { tasks: items } = req.body;
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
    }

    const { tasks: created, hostMessages } = await taskService.createTasks(
      surface.storageChannelId,
      "user",
      req.userId!,
      items.map((i) => ({ title: i.title.trim(), description: i.description?.trim() })),
    );

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const creatorName = created[0]?.createdByName || "Unknown";

    // v1.4 (tasks-table-canonical): the host message is a plain channel message
    // and broadcasts on the ordinary message:new / agent-delivery path; the task
    // fact broadcasts separately on the task board (task:created). They share the
    // messageId association but are never broadcast as the same row.
    const targets = await getTaskRealtimeSurfaceTargets(surface);
    for (const target of targets) {
      const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
      const projectedMessages = hostMessages.map((message) => ({ ...message, channelId: target.channelId }));
      for (const message of projectedMessages) {
        // message-realtime-producer: task-route.new.user
        emitTaskMessageNew(io, target, message, creatorName);
      }
      emitTaskCreated(io, target, {
        channelId: target.channelId,
        tasks: projectedTasks,
      });
      await messageService.deliverMessagesToAgents(agentOrchestrator, projectedMessages, creatorName);
    }

    // Emit system message to chat (visible to humans + agents, counts as unread)
    const taskList = created.map((t) => `#${t.taskNumber} "${messageService.summarizeForSystemMessage(t.title)}"`).join(", ");
    const sysContent = `📋 ${created.length} new task${created.length > 1 ? "s" : ""} created: ${taskList}`;
    messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, surface.localChannel.id, sysContent, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
      },
      causalActor: { type: "user", id: req.userId! },
    }).catch(() => {});

    res.json({ tasks: taskService.projectTasksToChannel(created, surface.localChannel) });
  } catch {
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

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
  /** Host message anchoring this task's thread; null only for pre-thread orphans. */
  messageId: string | null;
  /**
   * True only for tasks with no host message — the pre-message-task orphans
   * that predate threads and stay read-only. This is deliberately NOT "came
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
  const [canReadChannel, canWriteChannel, serverRole, hasAssignTasks, hasDeleteAnyTask] = await Promise.all([
    channelService.canUserAccessChannel(channelId, userId, serverId, { includeDeleted: true }),
    channelService.canUserPostToChannel(channelId, userId),
    getActorServerRoleInServer(serverId, "user", userId),
    actorHasServerCapabilityInServer(serverId, "user", userId, "assignTasks"),
    actorHasServerCapabilityInServer(serverId, "user", userId, "deleteAnyTask"),
  ]);
  if (!authorizeTaskAction({
    action,
    serverRole,
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
      res.status(403).json({ error: "Guests cannot modify tasks" });
      return true;
    }
    return false;
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
    isLegacy: row.messageId == null,
    isOrphan,
    raw: row,
    owner,
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
    isJoint: task.channelId !== task.storageChannelId,
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
 */
async function postTaskLifecycleToThread(
  req: Request,
  task: ResolvedTask,
  actorUserId: string,
  content: string,
): Promise<void> {
  // Anchor on the host message, not the task id: under v1.4 those differ for
  // canonical tasks, and threads are keyed by message.
  if (!task.messageId) return;
  try {
    // Soft-deleted ordinary channels cannot act as a live projection surface;
    // preserve the pre-joint orphan path for those historical tasks.
    const thread = task.localChannel.deletedAt
      ? await channelService.getOrCreateThread(task.messageId, actorUserId, "user")
      : await channelService.getOrCreateThreadForChannel(task.localChannel.id, task.messageId, actorUserId, "user");
    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, thread.id, content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.lifecycle_thread",
        reason: "task status transitions are a collaboration signal for the thread audience",
      },
      // The user who moved the task should not see their own status change as unread.
      causalActor: { type: "user", id: actorUserId },
    });
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

    const result = await taskService.claimTask(task.id, "user", req.userId!);
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, result);
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    postTaskLifecycleToThread(
      req,
      task,
      req.userId!,
      `📌 ${enriched.claimedByName || "Someone"} claimed #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`,
    ).catch(() => {});

    res.json({ task: enriched });
  } catch {
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
    if (surface.localChannel.type === "thread") {
      res.status(409).json({ error: "Thread messages cannot be claimed as tasks" });
      return;
    }
    if (await rejectIfNoTaskWriteAccess(surface.localChannel.id, req.userId!, req.serverId!, "convert", res)) return;
    if (await rejectIfArchived(surface.localChannel.id, res)) return;

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
      },
      causalActor: { type: "user", id: req.userId! },
    }).catch(() => {});

    res.json({ task: taskService.projectTaskToChannel(enriched, surface.localChannel) });
  } catch {
    res.status(500).json({ error: "Failed to convert message to task" });
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

    const result = await taskService.unclaimTask(task.id, "user", req.userId!);
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, result);
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    const user = await userService.getUser(req.userId!);
    const userName = user?.displayName || user?.name || "Someone";
    postTaskLifecycleToThread(
      req,
      task,
      req.userId!,
      `🔓 ${userName} released #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`,
    ).catch(() => {});

    res.json({ task: enriched });
  } catch {
    res.status(500).json({ error: "Failed to unclaim task" });
  }
});

/** Human-readable name for an assignee, for the lifecycle notice only. */
async function describeAssignee(assignee: { type: "user" | "agent"; id: string }): Promise<string> {
  if (assignee.type === "agent") {
    const agent = await agentService.getAgent(assignee.id);
    return agent?.displayName || agent?.name || "an agent";
  }
  const user = await userService.getUser(assignee.id);
  return user?.displayName || user?.name || "someone";
}

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
 *       optional `expectedRevision` for optimistic concurrency (409 on stale).
 */
taskRouter.patch("/:taskId/assignee", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;
    if (rejectIfOrphanNonTerminal(task, "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "assign", res)) return;

    // Member-level by design (@stdrc: 任何人都可以 assign 给别人). Gating this on
    // `manageServer` would make assignment an admin action, which is the
    // opposite of the ruling.
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "assignTasks")) {
      res.status(403).json({ error: "You do not have permission to assign tasks" });
      return;
    }

    const body = req.body as {
      assignee?: { type?: unknown; id?: unknown } | null;
      expectedRevision?: unknown;
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

    const result = await taskService.assignTask(task.id, assignee, "user", req.userId!, { expectedRevision });
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

    const enriched = await emitTaskUpdate(req, task, result);
    const actor = await userService.getUser(req.userId!);
    const actorName = actor?.displayName || actor?.name || "Someone";
    const summary = messageService.summarizeForSystemMessage(task.title);
    const notice = assignee
      ? `📌 ${actorName} assigned #${task.taskNumber} "${summary}" to ${await describeAssignee(assignee)}`
      : `🔓 ${actorName} unassigned #${task.taskNumber} "${summary}"`;
    postTaskLifecycleToThread(req, task, req.userId!, notice).catch(() => {});

    res.json({ task: enriched });
  } catch {
    res.status(500).json({ error: "Failed to assign task" });
  }
});

// Update task status (assignee or admin/owner)
taskRouter.patch("/:taskId/status", async (req, res) => {
  try {
    const task = await requireTaskInServer(req, res);
    if (!task) return;

    const { status } = req.body;
    if (!status || !["todo", "in_progress", "in_review", "done", "closed"].includes(status)) {
      res.status(400).json({ error: "valid status is required (todo, in_progress, in_review, done, closed)" });
      return;
    }

    // Orphan tasks (channel deleted) only allow terminal verbs
    const isTerminal = status === "done" || status === "closed";
    if (rejectIfOrphanNonTerminal(task, isTerminal ? "terminal" : "non_terminal", res)) return;
    if (await rejectIfNoChannelWriteAccess(task, req.userId!, req.serverId!, "change_status", res, {
      isAssignee: task.raw.claimedByType === "user" && task.raw.claimedById === req.userId!,
    })) return;

    // Try normal update, then admin force-override if denied.
    // Orphan tasks always go through force-override (the original assignee
    // may be a deleted agent, and membership checks don't apply).
    let result: taskService.TaskMutationResult;
    if (task.isOrphan) {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteAnyTask")) {
        res.status(403).json({ error: "Only server admins can close tasks in deleted channels" });
        return;
      }
      result = await taskService.forceUpdateTaskStatus(task.id, status, "user", req.userId!);
    } else {
      result = await taskService.updateTaskStatus(task.id, status, req.userId!, "user");

      if (typeof result === "string" && result !== "task not found") {
        if (await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteAnyTask")) {
          result = await taskService.forceUpdateTaskStatus(task.id, status, "user", req.userId!);
        }
      }
    }
    if (typeof result === "string") { res.status(409).json({ error: result }); return; }

    const enriched = await emitTaskUpdate(req, task, result);
    // Lifecycle notice goes to the task's own thread, not the parent channel.
    // (stdrc 2026-05-07 #proj-task:5f016c34 msg=e1c404b6)
    const STATUS_EMOJI: Record<string, string> = { todo: "📝", in_progress: "🔄", in_review: "👀", done: "✅", closed: "🚫" };
    const STATUS_LABEL: Record<string, string> = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", closed: "Closed" };
    const user = await userService.getUser(req.userId!);
    const userName = user?.displayName || user?.name || "Someone";
    postTaskLifecycleToThread(
      req,
      task,
      req.userId!,
      `${STATUS_EMOJI[status] || "📝"} ${userName} moved #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}" to ${STATUS_LABEL[status] || status}`,
    ).catch(() => {});

    res.json({ task: enriched });
  } catch {
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
    await taskService.deleteTaskByOwner(task.owner);

    const io: SocketServer = req.app.get("io");
    const surface = {
      storageChannelId: task.storageChannelId,
      localChannel: task.localChannel,
      isJoint: task.channelId !== task.storageChannelId,
    };
    for (const target of await getTaskRealtimeSurfaceTargets(surface)) {
      emitTaskDeleted(io, target, { channelId: target.channelId, taskId: task.id });
    }

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

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete task" });
  }
});
