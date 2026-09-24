import { and, desc, eq, inArray } from "drizzle-orm";
import { failpoints, type AgentMessage } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { agents, taskEvents, tasks, users } from "../db/schema.js";
import { UUID_RE } from "../lib/messageId.js";

export const TASK_CURRENT_PROJECTION_SOURCE = "tasks_current_projection" as const;

/**
 * The mutable task text that currently supersedes an immutable host message.
 *
 * `superseded` keys off an append-only `amended` event, not task revision:
 * claim/status/assignee mutations also increment revision and must not pretend
 * that the host text diverged. The original message content is never replaced.
 */
export interface ProjectedTaskCurrentText {
  title: string;
  description: string | null;
  revision: number;
  superseded: boolean;
  amendedAt: Date | null;
  amendedByType: "user" | "agent" | "system" | null;
  amendedByName: string | null;
  source: typeof TASK_CURRENT_PROJECTION_SOURCE;
}

/**
 * The `messages.task_*` shape, reconstructed for a message whose task fact
 * lives in the canonical `tasks` table.
 *
 * v1.4 moved task storage off the message row, but the message-shaped task
 * fields are a *published interface*: the agent CLI renders
 * `[task #N status=... @assignee]` from them, socket message payloads carry
 * them, and delivery mute-piercing keys on `taskAssigneeType/Id`. Dropping them
 * from the host message would have silently deleted that suffix for every new
 * task. So the columns stop being storage and become a projection — computed
 * from `tasks` on read instead of duplicated on write.
 */
export interface ProjectedMessageTaskFields {
  taskStatus: "todo" | "in_progress" | "in_review" | "done" | "closed";
  taskNumber: number;
  taskAssigneeType: "user" | "agent" | null;
  taskAssigneeId: string | null;
  taskClaimedAt: Date | null;
  taskCompletedAt: Date | null;
  taskCurrentProjection: ProjectedTaskCurrentText;
}

/** Minimal row shape the projection reads and writes. */
export type TaskProjectableRow = {
  id: string;
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskAssigneeType?: "user" | "agent" | null;
  taskAssigneeId?: string | null;
  taskClaimedAt?: Date | null;
  taskCompletedAt?: Date | null;
  taskCurrentProjection?: ProjectedTaskCurrentText;
};

type ProjectedTaskRow<T> = T & { taskCurrentProjection?: ProjectedTaskCurrentText };

type TaskCurrentProjectionRow = {
  id: string;
  title: string;
  description: string | null;
  revision: number;
};

type TaskProjectionLoadOptions = {
  failClosed?: boolean;
};

/**
 * Build the current-text projection for already-authorized canonical task rows.
 *
 * Task-list callers already hold these rows, so this helper deliberately does
 * not re-read `tasks`. Ordinary history callers treat amendment provenance as
 * optional enrichment: failure keeps canonical current text while withholding
 * the unverified superseded marker. Strict drain callers pass `failClosed` so
 * the same failure propagates before response/ack.
 */
export async function loadTaskCurrentProjectionsByTaskId(
  rows: TaskCurrentProjectionRow[],
  executor: DatabaseExecutor = getDb(),
  options: TaskProjectionLoadOptions = {},
): Promise<Map<string, ProjectedTaskCurrentText>> {
  const projections = new Map<string, ProjectedTaskCurrentText>();
  for (const row of rows) {
    projections.set(row.id, {
      title: row.title,
      description: row.description ?? null,
      revision: row.revision,
      superseded: false,
      amendedAt: null,
      amendedByType: null,
      amendedByName: null,
      source: TASK_CURRENT_PROJECTION_SOURCE,
    });
  }
  if (rows.length === 0) return projections;

  const latestAmendmentByTaskId = new Map<string, {
    actorType: "user" | "agent" | "system";
    actorId: string | null;
    createdAt: Date;
  }>();
  try {
    const amendmentRows = await executor
      .select({
        taskId: taskEvents.taskId,
        actorType: taskEvents.actorType,
        actorId: taskEvents.actorId,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(and(
        inArray(taskEvents.taskId, rows.map((row) => row.id)),
        eq(taskEvents.eventType, "amended"),
      ))
      .orderBy(desc(taskEvents.seq));
    for (const amendment of amendmentRows) {
      if (!latestAmendmentByTaskId.has(amendment.taskId)) {
        latestAmendmentByTaskId.set(amendment.taskId, amendment);
      }
    }
  } catch (err) {
    if (options.failClosed) throw err;
    console.error("[messageTaskProjection] amendment provenance load failed:", err);
    return projections;
  }

  for (const [taskId, amendment] of latestAmendmentByTaskId) {
    const projection = projections.get(taskId);
    if (!projection) continue;
    projections.set(taskId, {
      ...projection,
      superseded: true,
      amendedAt: amendment.createdAt,
      amendedByType: amendment.actorType,
    });
  }

  const userActorIds = [...new Set([...latestAmendmentByTaskId.values()]
    .filter((event) => event.actorType === "user" && event.actorId)
    .map((event) => event.actorId!))];
  const agentActorIds = [...new Set([...latestAmendmentByTaskId.values()]
    .filter((event) => event.actorType === "agent" && event.actorId)
    .map((event) => event.actorId!))];
  const actorNames = new Map<string, string>();
  try {
    if (userActorIds.length > 0) {
      const actorRows = await executor
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userActorIds));
      for (const actor of actorRows) actorNames.set(`user:${actor.id}`, actor.name);
    }
    if (agentActorIds.length > 0) {
      const actorRows = await executor
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentActorIds));
      for (const actor of actorRows) actorNames.set(`agent:${actor.id}`, actor.name);
    }
  } catch (err) {
    if (options.failClosed) throw err;
    console.error("[messageTaskProjection] amendment actor load failed:", err);
    return projections;
  }

  for (const [taskId, amendment] of latestAmendmentByTaskId) {
    if (!amendment.actorId) continue;
    const projection = projections.get(taskId);
    if (!projection) continue;
    projections.set(taskId, {
      ...projection,
      amendedByName: actorNames.get(`${amendment.actorType}:${amendment.actorId}`) ?? null,
    });
  }
  return projections;
}

/**
 * Load canonical task facts for the given host message ids.
 *
 * One indexed task lookup per batch, followed only for matching tasks by an
 * indexed amendment-history lookup and optional actor-name resolution. Default
 * history reads log and degrade; strict drain reads propagate every query or
 * projection failure and publish no partial Map.
 */
export async function loadCanonicalTaskFactsByMessageId(
  messageIds: string[],
  executor: DatabaseExecutor = getDb(),
  options: TaskProjectionLoadOptions = {},
): Promise<Map<string, ProjectedMessageTaskFields>> {
  if (messageIds.length === 0) return new Map();

  try {
    const loadRows = () => executor
      .select({
        taskId: tasks.id,
        messageId: tasks.messageId,
        status: tasks.status,
        taskNumber: tasks.taskNumber,
        claimedByType: tasks.claimedByType,
        claimedById: tasks.claimedById,
        claimedAt: tasks.claimedAt,
        completedAt: tasks.completedAt,
        title: tasks.title,
        description: tasks.description,
        revision: tasks.revision,
      })
      .from(tasks)
      .where(inArray(tasks.messageId, messageIds));
    const rows = failpoints.enabled
      ? await failpoints.hit<Awaited<ReturnType<typeof loadRows>>>(
        "server.message.taskProjection.canonicalTaskFactsQuery",
        { messageIds },
        loadRows,
      )
      : await loadRows();
    if (!rows) throw new Error("Canonical task fact query completed without rows");

    const currentProjections = await loadTaskCurrentProjectionsByTaskId(
      rows.map((row) => ({
        id: row.taskId,
        title: row.title,
        description: row.description,
        revision: row.revision,
      })),
      executor,
      options,
    );

    // Build privately and publish only after every matching row has a complete
    // projection. This prevents a mid-loop failure from masquerading as a
    // successful partial lookup at strict drain boundaries.
    const facts = new Map<string, ProjectedMessageTaskFields>();
    for (const row of rows) {
      if (!row.messageId) continue;
      const taskCurrentProjection = currentProjections.get(row.taskId);
      if (!taskCurrentProjection) {
        throw new Error(`Missing current projection for canonical task ${row.taskId}`);
      }
      facts.set(row.messageId, {
        taskStatus: row.status,
        taskNumber: row.taskNumber,
        taskAssigneeType: row.claimedByType ?? null,
        taskAssigneeId: row.claimedById ?? null,
        taskClaimedAt: row.claimedAt ?? null,
        taskCompletedAt: row.completedAt ?? null,
        taskCurrentProjection,
      });
    }
    return facts;
  } catch (err) {
    if (options.failClosed) throw err;
    console.error("[messageTaskProjection] canonical task fact load failed:", err);
    return new Map();
  }
}

export function toAgentTaskCurrentProjection(
  projection: ProjectedTaskCurrentText,
): AgentMessage["task_current_projection"] {
  return {
    title: projection.title,
    description: projection.description,
    revision: projection.revision,
    superseded: projection.superseded,
    amended_at: projection.amendedAt?.toISOString() ?? null,
    amended_by_type: projection.amendedByType,
    amended_by_name: projection.amendedByName,
    source: projection.source,
  };
}

function withoutQueuedTaskFields(message: AgentMessage): AgentMessage {
  const {
    task_status: _taskStatus,
    task_number: _taskNumber,
    task_assignee_type: _taskAssigneeType,
    task_assignee_id: _taskAssigneeId,
    task_assignee_name: _taskAssigneeName,
    task_current_projection: _taskCurrentProjection,
    ...plainMessage
  } = message;
  return plainMessage;
}

/**
 * Refresh task facts at the queue drain boundary.
 *
 * A message can be delivered before its task is amended (or even converted
 * into a task) and drained afterwards. Enqueue-time task fields are therefore
 * only a snapshot. Every persisted message id in the returned batch is
 * checked against the canonical task tables immediately before response/ack.
 *
 * This path is intentionally fail-closed: unlike history reads, a drain cannot
 * degrade to queued task fields because the caller would then acknowledge a
 * stale snapshot as current. Any canonical/provenance failure rejects the
 * whole drain so the orchestrator keeps the batch for a later retry.
 */
export async function refreshQueuedAgentTaskProjections(
  queuedMessages: readonly AgentMessage[],
  executor: DatabaseExecutor = getDb(),
): Promise<AgentMessage[]> {
  const persistedMessageIds = [...new Set(queuedMessages
    .map((message) => message.message_id)
    .filter((messageId): messageId is string => typeof messageId === "string" && UUID_RE.test(messageId)))];
  if (persistedMessageIds.length === 0) return [...queuedMessages];

  const facts = await loadCanonicalTaskFactsByMessageId(
    persistedMessageIds,
    executor,
    { failClosed: true },
  );

  return queuedMessages.map((queuedMessage) => {
    const message = withoutQueuedTaskFields(queuedMessage);
    const fact = queuedMessage.message_id ? facts.get(queuedMessage.message_id) : undefined;
    if (!fact) return message;

    const projectedAssigneeType = fact.taskAssigneeType === "user"
      ? "human"
      : fact.taskAssigneeType;
    const sameAssignee = queuedMessage.task_assignee_type === projectedAssigneeType
      && queuedMessage.task_assignee_id === fact.taskAssigneeId;
    return {
      ...message,
      task_status: fact.taskStatus,
      task_number: fact.taskNumber,
      task_assignee_type: projectedAssigneeType,
      task_assignee_id: fact.taskAssigneeId,
      task_assignee_name: sameAssignee ? queuedMessage.task_assignee_name ?? null : null,
      task_current_projection: toAgentTaskCurrentProjection(fact.taskCurrentProjection),
    };
  });
}

/**
 * Overlay canonical task facts onto message rows.
 *
 * The canonical row wins whenever it exists. That is the same tie-break the
 * read/mutation paths use (`resolveTaskById`, `listTasks`' anti-join): once a
 * task exists in `tasks`, any surviving `messages.task_*` columns for the same
 * message are a stale shadow from before the backfill, never a second truth.
 *
 * Returns new objects; callers may hold the inputs elsewhere.
 */
export function projectTaskFactsOntoRows<T extends TaskProjectableRow>(
  rows: T[],
  facts: Map<string, ProjectedMessageTaskFields>,
): Array<ProjectedTaskRow<T>> {
  if (facts.size === 0) return rows as Array<ProjectedTaskRow<T>>;
  return rows.map((row) => {
    const fact = facts.get(row.id);
    return (fact ? { ...row, ...fact } : row) as ProjectedTaskRow<T>;
  });
}

/** Load + overlay in one step, for read paths that just want projected rows. */
export async function withProjectedTaskFacts<T extends TaskProjectableRow>(
  rows: T[],
  executor?: DatabaseExecutor,
): Promise<Array<ProjectedTaskRow<T>>> {
  if (rows.length === 0) return rows as Array<ProjectedTaskRow<T>>;
  const facts = await loadCanonicalTaskFactsByMessageId(rows.map((row) => row.id), executor);
  return projectTaskFactsOntoRows(rows, facts);
}
