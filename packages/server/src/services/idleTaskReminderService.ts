// Idle task reminder (#wg-task-v2:#9; design: Raft artifact 6T5oh2XU2txXkE2Xx22FGQ).
//
// When an agent goes idle its Computer asks `POST /internal/agent-api/tasks/
// idle-nudge`: which open tasks assigned to the agent (todo / in_progress /
// in_review), or with no assignee when it created them, to remind it of now,
// and why. Change-based, never "every idle":
//
//  - newly yours: someone else assigned it to the agent after the agent's last
//    action on it;
//  - someone acted: someone else changed its status, assignee or card, or
//    wrote in its conversation, after the agent's last action;
//  - untouched: the agent has not acted on it for 30m (todo, in_review) / 2h
//    (in_progress), then 8h, then every day; paused while the agent has
//    background tasks running; a task the in_review retirement moved (a system status event) is not
//    reminded as untouched until its next real status change;
//  - new session: the first ask of a new session lists every open task once.
//
// A task v2 task in todo / in_progress with no assignee is chased with its
// creator, when that is an agent (tygg, #wg-task-v2:4804a9c2). Only "untouched"
// applies: first at 8h (todo: agents leave split work on the board to be
// claimed) or 2h (in_progress) of no action by the creator, from its last action
// or the task's release (whichever is later), then the same 8h and daily. It
// counts as open only once due, so a fresh one sends nothing. A new session does
// not list it: it comes only when it crosses a threshold it has not been reminded
// of, and the record of that is per agent and task, whatever the session. Others'
// actions on it are not news to a creator who does not hold it. It leaves this
// path as soon as anyone holds it, and only tasks the agent can still change are
// listed: the notice gives its exits (claim, assign, close). At most
// IDLE_TASK_REMINDER_MAX_UNASSIGNED_PER_NOTICE in a notice, longest untouched
// first; the rest stay unrecorded, so a later idle lists them.
//
// "The agent's action" is a status, assignee or card change by it, or its
// message in the task's conversation or in its source message's thread (where
// it often answers whoever asked). Each listed task is recorded
// (agent_task_nudges) in the transaction that decides it, so the same news is
// never listed twice and a lost response skips at most one reminder; at most
// IDLE_TASK_REMINDER_HOURLY_CAP reminders an hour (agent_task_nudge_sends).
// Everything is read from existing facts: task_events, the task rows, and the
// messages of the task's conversation (its own, or a pre-v2 task's host
// message thread) and of its source message's thread.

import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  currentDate,
  formatAgentTaskRef,
  formatIdleTaskReminderNotice,
  idleTaskReminderNoticeHasRules,
  formatIdleTaskReminderWhy,
  type AgentApiTaskIdleNudgeBacklogItem,
  type AgentApiTaskIdleNudgeItem,
  type AgentApiTaskIdleNudgeResponse,
  type IdleTaskReminderItemReason,
  type IdleTaskReminderOthersActionKind,
  type IdleTaskReminderSkipReason,
  type IdleTaskReminderWhy,
  type TaskStatus,
} from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, agentTaskNudges, agentTaskNudgeSends, channels, users } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { resolveAgentTaskSurfaces, type AgentTaskSurface } from "./agentAssignedTaskSurfaces";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import { getTaskReadOnlyReason } from "./taskChannelSurface";
import { isTaskV2ConversationsEnabled } from "./taskConversationsGate";
import { TASK_V2_RETIRED_IN_REVIEW_REASON } from "./taskV2Mode";
import * as taskService from "./taskService";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The statuses that wait on their assignee and are listed ("to do"). */
export const IDLE_TASK_REMINDER_OPEN_STATUSES = ["todo", "in_progress", "in_review"] as const satisfies readonly TaskStatus[];
export type IdleTaskReminderOpenStatus = (typeof IDLE_TASK_REMINDER_OPEN_STATUSES)[number];

/**
 * Parked tasks are listed compactly on a reminder that is sent anyway, never
 * a reason to send one: they are not in IDLE_TASK_REMINDER_OPEN_STATUSES, so
 * they are never decided, never "untouched" and never count as open. The
 * reminder only runs where task v2 is on (isIdleTaskReminderEnabled), which is
 * where the status exists, so its rules always say how to park a task.
 */
const BACKLOG_STATUS = "backlog" as const satisfies TaskStatus;
export const IDLE_TASK_REMINDER_BACKLOG_ACTIVE = true;

/** At most this many reminders per agent per rolling hour. */
export const IDLE_TASK_REMINDER_HOURLY_CAP = 3;
const IDLE_TASK_REMINDER_CAP_WINDOW_MS = HOUR_MS;
/** An agent's open tasks are few; past this many, the most recently updated are considered. */
export const IDLE_TASK_REMINDER_MAX_TASKS = 50;
const IDLE_TASK_REMINDER_MAX_BACKLOG = 20;
/** At most this many tasks with no assignee in one notice; the notice counts the rest. */
export const IDLE_TASK_REMINDER_MAX_UNASSIGNED_PER_NOTICE = 10;

/** The first "untouched" threshold per status; then 8h, then every day. */
export const IDLE_TASK_REMINDER_FIRST_STALE_MS: Readonly<Record<IdleTaskReminderOpenStatus, number>> = {
  todo: 30 * MINUTE_MS,
  // Someone is waiting on the agent's review or acceptance.
  in_review: 30 * MINUTE_MS,
  in_progress: 2 * HOUR_MS,
};
const SECOND_STALE_MS = 8 * HOUR_MS;

/**
 * The first "untouched" threshold of a todo with no assignee, for its creator:
 * agents legitimately split work and leave it on the board for others to claim.
 * An in_progress one keeps the usual first threshold.
 */
export const IDLE_TASK_REMINDER_UNASSIGNED_TODO_FIRST_STALE_MS = 8 * HOUR_MS;

/**
 * The statuses a task with no assignee is chased in. `in_review` is left out:
 * task v2 stores in_progress instead, so an unassigned in_review row is a pre-v2
 * task, which this path does not chase.
 */
const IDLE_TASK_REMINDER_UNASSIGNED_FIRST_STALE_MS = {
  todo: IDLE_TASK_REMINDER_UNASSIGNED_TODO_FIRST_STALE_MS,
  in_progress: IDLE_TASK_REMINDER_FIRST_STALE_MS.in_progress,
} as const satisfies Partial<Record<IdleTaskReminderOpenStatus, number>>;

function firstStaleMs(status: IdleTaskReminderOpenStatus, unassigned: boolean): number {
  return unassigned && status !== "in_review"
    ? IDLE_TASK_REMINDER_UNASSIGNED_FIRST_STALE_MS[status]
    : IDLE_TASK_REMINDER_FIRST_STALE_MS[status];
}

/**
 * How many "untouched" thresholds `elapsedMs` has crossed: 0 before the
 * first (30m / 2h; for a task with no assignee 8h todo / 2h in_progress), 1
 * until 8h, 2 until a day, then one more each day. The later thresholds count
 * from the same start whatever the first was, so a first threshold at or past
 * 8h skips step 1 and one reminder covers both: a todo with no assignee is
 * reminded at 8h, a day, two days.
 */
export function idleTaskStaleStep(status: IdleTaskReminderOpenStatus, elapsedMs: number, unassigned = false): number {
  if (elapsedMs < firstStaleMs(status, unassigned)) return 0;
  if (elapsedMs < SECOND_STALE_MS) return 1;
  if (elapsedMs < DAY_MS) return 2;
  return 3 + Math.floor((elapsedMs - DAY_MS) / DAY_MS);
}

/** One open task's facts, as the decision reads them. */
export interface IdleTaskReminderFacts {
  status: IdleTaskReminderOpenStatus;
  taskCreatedAt: Date;
  /** The agent's latest status / assignee / card change on it, or message in its conversation or source thread. */
  myLastActionAt: Date | null;
  /**
   * Its status was last moved by the migration that retired in_review for task
   * v2 (a system event): no "untouched" reminder until its next real status
   * change, so the retirement does not wake every holder at once.
   */
  retiredInReview?: boolean;
  /** The latest assignment of the task to the agent. */
  assignment: { at: Date; bySelf: boolean; actorHandle: string | null } | null;
  /** The latest action by someone else (status / assignee / card change, message in its conversation). */
  othersLastAction: { at: Date; kind: IdleTaskReminderOthersActionKind; actorHandle: string | null } | null;
  /**
   * The task has no assignee and this agent created it. `since`: its latest
   * assignee change or reopening by anyone, when it last landed back on the
   * board; null if it never left it.
   */
  unassigned?: { since: Date | null };
}

/** What was recorded the last time the task was listed for this agent (agent_task_nudges). */
export interface IdleTaskReminderRecord {
  seenOthersActionAt: Date | null;
  staleSinceAt: Date | null;
  staleStep: number;
}

export interface IdleTaskReminderDecision {
  reason: IdleTaskReminderItemReason;
  why: IdleTaskReminderWhy;
  record: IdleTaskReminderRecord;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function isAfter(a: Date, b: Date | null): boolean {
  return b === null || a.getTime() > b.getTime();
}

function staleClockStart(facts: IdleTaskReminderFacts): Date {
  // A task that has no assignee starts its clock at its release, as an assigned
  // one does at its assignment: taken off someone after days, it is not at once
  // "untouched for days".
  const landedAt = facts.unassigned ? facts.unassigned.since : facts.assignment?.at ?? null;
  return laterOf(facts.myLastActionAt, landedAt) ?? facts.taskCreatedAt;
}

/**
 * A task with no assignee counts as open for its creator only from its first
 * threshold on, and not while the in_review retirement is the last thing that
 * moved it. (A task assigned to the agent always counts.)
 */
export function isIdleTaskDue(facts: IdleTaskReminderFacts, now: Date): boolean {
  if (!facts.unassigned) return true;
  if (facts.retiredInReview) return false;
  return idleTaskStaleStep(facts.status, now.getTime() - staleClockStart(facts).getTime(), true) > 0;
}

/**
 * Whether one open task is listed now, why, and what to record if it is.
 * Null: nothing new since the agent's last action and the last reminder.
 */
export function decideIdleTaskReminder(
  facts: IdleTaskReminderFacts,
  record: IdleTaskReminderRecord | null,
  opts: { now: Date; freshSession: boolean; staleSuspended: boolean },
): IdleTaskReminderDecision | null {
  // The "untouched" clock: the agent's own last action, or the assignment or
  // release (whichever is later), or the task's creation.
  const staleSinceAt = staleClockStart(facts);
  const untouchedMs = Math.max(0, opts.now.getTime() - staleSinceAt.getTime());
  const unassigned = facts.unassigned != null;
  const step = idleTaskStaleStep(facts.status, untouchedMs, unassigned);
  const sameClock = record?.staleSinceAt != null && record.staleSinceAt.getTime() === staleSinceAt.getTime();
  const recordedStep = sameClock ? record!.staleStep : 0;
  // Not news to a creator who does not hold the task, so never recorded as seen:
  // if the task comes to the agent, the usual rules read it from there.
  const others = unassigned ? null : facts.othersLastAction;
  const seenOthersActionAt = laterOf(record?.seenOthersActionAt ?? null, others?.at ?? null);
  const decided = (reason: IdleTaskReminderItemReason, why: IdleTaskReminderWhy, staleStep: number): IdleTaskReminderDecision => ({
    reason,
    why,
    record: { seenOthersActionAt, staleSinceAt, staleStep },
  });

  // A new session does not list a task with no assignee: every new session
  // would list every due one. Its thresholds below still reach it.
  if (opts.freshSession && !unassigned) {
    return decided("new_session", { reason: "new_session" }, Math.max(step, recordedStep));
  }
  // While stale reminders are paused, a change reminder keeps the stale
  // progress as it was, so the threshold is still reminded of afterwards.
  const staleStepAfterChange = opts.staleSuspended ? recordedStep : Math.max(step, recordedStep);
  const assignment = unassigned ? null : facts.assignment;
  if (
    assignment
    && !assignment.bySelf
    && isAfter(assignment.at, facts.myLastActionAt)
    && isAfter(assignment.at, record?.seenOthersActionAt ?? null)
  ) {
    return decided("newly_assigned", { reason: "newly_assigned", actorHandle: assignment.actorHandle }, staleStepAfterChange);
  }
  if (
    others
    && isAfter(others.at, facts.myLastActionAt)
    && isAfter(others.at, record?.seenOthersActionAt ?? null)
  ) {
    return decided(
      "others_acted",
      { reason: "others_acted", actorHandle: others.actorHandle, othersAction: others.kind },
      staleStepAfterChange,
    );
  }
  if (!opts.staleSuspended && !facts.retiredInReview && step > recordedStep) {
    return decided("stale", unassigned ? { reason: "stale", untouchedMs, noAssignee: true } : { reason: "stale", untouchedMs }, step);
  }
  return null;
}

/** An open task assigned to the agent, or with no assignee when it created it, on the surface the agent sees it through. */
type ReminderTask = {
  id: string;
  taskNumber: number;
  title: string;
  status: string;
  conversationChannelId: string | null;
  hostMessageId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  channelRef: string;
  ref: string;
  unassigned: boolean;
};

type ReminderTaskRow = Omit<ReminderTask, "channelRef" | "ref" | "unassigned"> & { channelId: string };

function toReminderTasks(
  rows: readonly ReminderTaskRow[],
  surfaces: Map<string, AgentTaskSurface>,
  unassigned: boolean,
): ReminderTask[] {
  const out: ReminderTask[] = [];
  for (const row of rows) {
    const surface = surfaces.get(row.channelId);
    if (!surface) continue;
    const ref = formatAgentTaskRef(surface.channelRef, row.taskNumber);
    if (!ref) continue;
    out.push({
      id: row.id,
      taskNumber: row.taskNumber,
      title: row.title,
      status: row.status,
      conversationChannelId: row.conversationChannelId,
      hostMessageId: row.hostMessageId,
      sourceMessageId: row.sourceMessageId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      channelRef: surface.channelRef,
      ref,
      unassigned,
    });
  }
  return out;
}

async function listAssignedTasks(
  surfaces: Map<string, AgentTaskSurface>,
  agentId: string,
  status?: TaskStatus,
): Promise<ReminderTask[]> {
  if (surfaces.size === 0) return [];
  return toReminderTasks(await taskService.listTasksAssignedToAgent([...surfaces.keys()], agentId, status), surfaces, false);
}

/**
 * The tasks with no assignee this agent created that may be due, at most
 * `limit`, only where it can still change them: its reminder has to have an
 * exit, so not on an archived channel, one it has left, or a read-only
 * historical joint task. A stopped agent is chased for nothing (a deleted one
 * has no surfaces).
 */
async function listUnassignedTasks(
  surfaces: Map<string, AgentTaskSurface>,
  agentId: string,
  now: Date,
  limit: number,
): Promise<ReminderTask[]> {
  if (surfaces.size === 0 || limit <= 0) return [];
  const writable = await channelService.listAgentTaskWritableChannelIds(agentId, [...new Set([...surfaces.values()].map((surface) => surface.localChannel.id))]);
  const writableSurfaces = new Map([...surfaces].filter(([, surface]) => writable.has(surface.localChannel.id)));
  const rows = await taskService.listUnassignedTasksCreatedByAgent([...writableSurfaces.keys()], agentId, {
    createdByStatus: {
      todo: new Date(now.getTime() - IDLE_TASK_REMINDER_UNASSIGNED_FIRST_STALE_MS.todo),
      in_progress: new Date(now.getTime() - IDLE_TASK_REMINDER_UNASSIGNED_FIRST_STALE_MS.in_progress),
    },
    limit,
  });
  if (rows.length === 0) return [];
  const agent = await agentService.getAgent(agentId);
  if (!agent || agent.status === "stopped") return [];
  return toReminderTasks(
    rows.filter((row) => {
      const surface = writableSurfaces.get(row.channelId);
      return surface && !getTaskReadOnlyReason(surface.localChannel, row.createdAt);
    }),
    writableSurfaces,
    true,
  );
}

function isOpenStatus(status: string): status is IdleTaskReminderOpenStatus {
  return (IDLE_TASK_REMINDER_OPEN_STATUSES as readonly string[]).includes(status);
}

type ActorKey = `${"user" | "agent"}:${string}`;

function actorKey(type: string | null, id: string | null): ActorKey | null {
  return (type === "user" || type === "agent") && id ? `${type}:${id}` : null;
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const OTHERS_EVENT_KIND: Record<string, IdleTaskReminderOthersActionKind> = {
  status_changed: "status",
  reopened: "status",
  closed: "status",
  assignee_changed: "assignee",
  amended: "amend",
};

/**
 * Each task's facts from task_events and its conversation's messages, in a
 * fixed number of queries: per task, the latest matching row of each kind
 * through the (task_id, seq) / (channel_id, created_at) indexes.
 */
async function loadIdleTaskFacts(
  agentId: string,
  tasks: readonly ReminderTask[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, IdleTaskReminderFacts>> {
  const facts = new Map<string, IdleTaskReminderFacts>();
  if (tasks.length === 0) return facts;
  const taskIds = sql.join(tasks.map((task) => sql`${task.id}::uuid`), sql`, `);
  const eventRows = (await executor.execute(sql`
    SELECT
      t.id::text AS "taskId",
      mine.created_at AS "myEventAt",
      other.created_at AS "otherEventAt",
      other.event_type AS "otherEventType",
      other.actor_type AS "otherActorType",
      other.actor_id AS "otherActorId",
      asg.created_at AS "assignedAt",
      asg.actor_type AS "assignedByType",
      asg.actor_id AS "assignedById",
      landed.created_at AS "landedAt",
      st.actor_type AS "statusByType",
      st.payload->>'reason' AS "statusReason"
    FROM unnest(ARRAY[${taskIds}]) AS t(id)
    LEFT JOIN LATERAL (
      SELECT e.created_at FROM task_events e
      WHERE e.task_id = t.id
        AND e.actor_type = 'agent' AND e.actor_id = ${agentId}
        AND e.event_type IN ('created', 'status_changed', 'assignee_changed', 'reopened', 'closed', 'amended')
      ORDER BY e.seq DESC LIMIT 1
    ) mine ON true
    LEFT JOIN LATERAL (
      SELECT e.created_at, e.event_type, e.actor_type, e.actor_id FROM task_events e
      WHERE e.task_id = t.id
        AND e.actor_type IN ('user', 'agent')
        AND NOT (e.actor_type = 'agent' AND e.actor_id = ${agentId})
        AND e.event_type IN ('status_changed', 'assignee_changed', 'reopened', 'closed', 'amended')
      ORDER BY e.seq DESC LIMIT 1
    ) other ON true
    LEFT JOIN LATERAL (
      SELECT e.created_at, e.actor_type, e.actor_id FROM task_events e
      WHERE e.task_id = t.id
        AND e.event_type = 'assignee_changed'
        AND e.payload->>'assigneeType' = 'agent'
        AND e.payload->>'assigneeId' = ${agentId}
      ORDER BY e.seq DESC LIMIT 1
    ) asg ON true
    LEFT JOIN LATERAL (
      SELECT e.created_at FROM task_events e
      WHERE e.task_id = t.id
        AND e.event_type IN ('assignee_changed', 'reopened')
      ORDER BY e.seq DESC LIMIT 1
    ) landed ON true
    LEFT JOIN LATERAL (
      SELECT e.actor_type, e.payload FROM task_events e
      WHERE e.task_id = t.id
        AND e.event_type IN ('status_changed', 'reopened', 'closed')
      ORDER BY e.seq DESC LIMIT 1
    ) st ON true
  `)).rows as Array<{
    taskId: string;
    myEventAt: unknown;
    otherEventAt: unknown;
    otherEventType: string | null;
    otherActorType: string | null;
    otherActorId: string | null;
    assignedAt: unknown;
    assignedByType: string | null;
    assignedById: string | null;
    landedAt: unknown;
    statusByType: string | null;
    statusReason: string | null;
  }>;

  // The task's conversation: its own, else (a pre-v2 task) its host message's thread.
  const conversationByTask = new Map<string, string>();
  const hostMessageIds = tasks.filter((task) => !task.conversationChannelId && task.hostMessageId).map((task) => task.hostMessageId!);
  const hostThreads = hostMessageIds.length === 0 ? [] : await executor
    .select({ id: channels.id, parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(inArray(channels.parentMessageId, hostMessageIds), eq(channels.type, "thread"), sql`${channels.deletedAt} IS NULL`));
  const threadByHost = new Map(hostThreads.map((row) => [row.parentMessageId!, row.id]));
  for (const task of tasks) {
    const conversation = task.conversationChannelId ?? (task.hostMessageId ? threadByHost.get(task.hostMessageId) : undefined);
    if (conversation) conversationByTask.set(task.id, conversation);
  }
  // The source message's thread: only the agent's own messages there count (as
  // its action); the thread is the asker's conversation, not the task's.
  const sourceThreadByTask = new Map<string, string>();
  const sourceMessageIds = [...new Set(tasks.map((task) => task.sourceMessageId).filter((id): id is string => !!id))];
  const sourceThreads = sourceMessageIds.length === 0 ? [] : await executor
    .select({ id: channels.id, parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(inArray(channels.parentMessageId, sourceMessageIds), eq(channels.type, "thread"), sql`${channels.deletedAt} IS NULL`));
  const threadBySource = new Map(sourceThreads.map((row) => [row.parentMessageId!, row.id]));
  for (const task of tasks) {
    const thread = task.sourceMessageId ? threadBySource.get(task.sourceMessageId) : undefined;
    if (thread && thread !== conversationByTask.get(task.id)) sourceThreadByTask.set(task.id, thread);
  }
  const conversationIds = [...new Set(conversationByTask.values())];
  const sourceThreadIds = [...new Set(sourceThreadByTask.values())];
  const sourceRows = sourceThreadIds.length === 0 ? [] : (await executor.execute(sql`
    SELECT
      c.id::text AS "channelId",
      mine.created_at AS "myMessageAt"
    FROM unnest(ARRAY[${sql.join(sourceThreadIds.map((id) => sql`${id}::uuid`), sql`, `)}]) AS c(id)
    LEFT JOIN LATERAL (
      SELECT m.created_at FROM messages m
      WHERE m.channel_id = c.id
        AND m.message_type = 'chat'
        AND m.sender_type = 'agent' AND m.sender_id = ${agentId}
      ORDER BY m.created_at DESC LIMIT 1
    ) mine ON true
  `)).rows as Array<{ channelId: string; myMessageAt: unknown }>;
  const mySourceMessageAt = new Map(sourceRows.map((row) => [row.channelId, asDate(row.myMessageAt)]));
  const messageRows = conversationIds.length === 0 ? [] : (await executor.execute(sql`
    SELECT
      c.id::text AS "channelId",
      mine.created_at AS "myMessageAt",
      other.created_at AS "otherMessageAt",
      other.sender_type AS "otherSenderType",
      other.sender_id AS "otherSenderId"
    FROM unnest(ARRAY[${sql.join(conversationIds.map((id) => sql`${id}::uuid`), sql`, `)}]) AS c(id)
    LEFT JOIN LATERAL (
      SELECT m.created_at FROM messages m
      WHERE m.channel_id = c.id
        AND m.message_type = 'chat'
        AND m.sender_type = 'agent' AND m.sender_id = ${agentId}
      ORDER BY m.created_at DESC LIMIT 1
    ) mine ON true
    LEFT JOIN LATERAL (
      SELECT m.created_at, m.sender_type, m.sender_id FROM messages m
      WHERE m.channel_id = c.id
        AND m.message_type = 'chat'
        AND m.deleted_at IS NULL
        AND NOT (m.sender_type = 'agent' AND m.sender_id = ${agentId})
      ORDER BY m.created_at DESC LIMIT 1
    ) other ON true
  `)).rows as Array<{
    channelId: string;
    myMessageAt: unknown;
    otherMessageAt: unknown;
    otherSenderType: string | null;
    otherSenderId: string | null;
  }>;
  const messagesByChannel = new Map(messageRows.map((row) => [row.channelId, row]));

  // Handles of whoever acted, for the lines' "why".
  const actorKeys = new Set<ActorKey>();
  for (const row of eventRows) {
    const other = actorKey(row.otherActorType, row.otherActorId);
    if (other) actorKeys.add(other);
    const assigner = actorKey(row.assignedByType, row.assignedById);
    if (assigner) actorKeys.add(assigner);
  }
  for (const row of messageRows) {
    const sender = actorKey(row.otherSenderType, row.otherSenderId);
    if (sender) actorKeys.add(sender);
  }
  const handles = await loadActorHandles([...actorKeys], executor);

  const eventsByTask = new Map(eventRows.map((row) => [row.taskId, row]));
  for (const task of tasks) {
    if (!isOpenStatus(task.status)) continue;
    const events = eventsByTask.get(task.id);
    const conversation = conversationByTask.get(task.id);
    const messages = conversation ? messagesByChannel.get(conversation) : undefined;
    const sourceThread = sourceThreadByTask.get(task.id);
    const myLastActionAt = laterOf(
      laterOf(asDate(events?.myEventAt), asDate(messages?.myMessageAt)),
      sourceThread ? mySourceMessageAt.get(sourceThread) ?? null : null,
    );

    const assignedAt = asDate(events?.assignedAt);
    const assignerKey = actorKey(events?.assignedByType ?? null, events?.assignedById ?? null);
    // A task with no assignee is not the agent's by assignment, whatever it once was.
    const assignment = assignedAt && !task.unassigned
      ? {
          at: assignedAt,
          bySelf: events?.assignedByType === "agent" && events.assignedById === agentId,
          actorHandle: assignerKey ? handles.get(assignerKey) ?? null : null,
        }
      : null;

    const otherEventAt = asDate(events?.otherEventAt);
    const otherMessageAt = asDate(messages?.otherMessageAt);
    let othersLastAction: IdleTaskReminderFacts["othersLastAction"] = null;
    if (otherMessageAt && (!otherEventAt || otherMessageAt.getTime() > otherEventAt.getTime())) {
      const sender = actorKey(messages?.otherSenderType ?? null, messages?.otherSenderId ?? null);
      othersLastAction = { at: otherMessageAt, kind: "message", actorHandle: sender ? handles.get(sender) ?? null : null };
    } else if (otherEventAt) {
      const actor = actorKey(events?.otherActorType ?? null, events?.otherActorId ?? null);
      othersLastAction = {
        at: otherEventAt,
        kind: OTHERS_EVENT_KIND[events?.otherEventType ?? ""] ?? "status",
        actorHandle: actor ? handles.get(actor) ?? null : null,
      };
    }

    facts.set(task.id, {
      status: task.status,
      taskCreatedAt: new Date(task.createdAt),
      myLastActionAt,
      retiredInReview: events?.statusByType === "system" && events.statusReason === TASK_V2_RETIRED_IN_REVIEW_REASON,
      assignment,
      othersLastAction,
      ...(task.unassigned ? { unassigned: { since: asDate(events?.landedAt) } } : {}),
    });
  }
  return facts;
}

async function loadActorHandles(keys: readonly ActorKey[], executor: DatabaseExecutor): Promise<Map<ActorKey, string>> {
  const handles = new Map<ActorKey, string>();
  const userIds = keys.filter((key) => key.startsWith("user:")).map((key) => key.slice("user:".length));
  const agentIds = keys.filter((key) => key.startsWith("agent:")).map((key) => key.slice("agent:".length));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validUserIds = userIds.filter((id) => uuid.test(id));
  const validAgentIds = agentIds.filter((id) => uuid.test(id));
  if (validUserIds.length > 0) {
    for (const row of await executor.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, validUserIds))) {
      if (row.name) handles.set(`user:${row.id}`, row.name);
    }
  }
  if (validAgentIds.length > 0) {
    for (const row of await executor.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, validAgentIds))) {
      if (row.name) handles.set(`agent:${row.id}`, row.name);
    }
  }
  return handles;
}

/**
 * On wherever task v2 is: the reminder shares the `task_v2_conversations_v0`
 * flag of the agent's server (stdrc, #wg-task-v2:7415abae). Any evaluation
 * failure reads as off.
 */
export async function isIdleTaskReminderEnabled(serverId: string): Promise<boolean> {
  return isTaskV2ConversationsEnabled(serverId);
}

/**
 * What one notice lists: every assigned task, and of the tasks with no assignee
 * the longest untouched up to the limit. The rest are not recorded, so their
 * threshold is still ahead of their record and a later idle lists them.
 */
function limitUnassignedItems<T extends { task: ReminderTask; decision: IdleTaskReminderDecision }>(decisions: readonly T[]): { listed: T[]; deferred: ReminderTask[] } {
  const deferred = decisions
    .filter(({ task }) => task.unassigned)
    .sort((a, b) => (a.decision.record.staleSinceAt?.getTime() ?? 0) - (b.decision.record.staleSinceAt?.getTime() ?? 0) || a.task.id.localeCompare(b.task.id))
    .slice(IDLE_TASK_REMINDER_MAX_UNASSIGNED_PER_NOTICE)
    .map(({ task }) => task);
  const deferredIds = new Set(deferred.map((task) => task.id));
  return { listed: decisions.filter(({ task }) => !deferredIds.has(task.id)), deferred };
}

export type IdleTaskReminderResult = AgentApiTaskIdleNudgeResponse;

function skipped(reason: IdleTaskReminderSkipReason): IdleTaskReminderResult {
  return { send: false, reason, items: [], backlog: [], text: "" };
}

/**
 * Decide, record and word the idle task reminder for one agent (its
 * credential's server). See the module comment for the rules.
 */
export async function computeIdleTaskReminder(input: {
  serverId: string;
  agentId: string;
  freshSession?: boolean;
  backgroundTasks?: number;
  /** The Computer says this model context already got the notice's rule blocks. */
  rulesShown?: boolean;
  now?: Date;
}): Promise<IdleTaskReminderResult> {
  const freshSession = input.freshSession === true;
  const backgroundTasks = Math.max(0, Math.floor(input.backgroundTasks ?? 0));
  const staleSuspended = backgroundTasks > 0;
  const trace = (result: IdleTaskReminderResult, extra: { openTasks: number; taskIds?: readonly string[]; noAssigneeItems?: number; noAssigneeDeferred?: number }) => {
    const reasons: Record<string, number> = {};
    for (const item of result.items) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
    addTraceEvent("task.idle_nudge.decided", {
      server_id: input.serverId,
      agent_id: input.agentId,
      fresh_session: freshSession,
      background_tasks: backgroundTasks,
      rules_shown: input.rulesShown === true,
      stale_suspended: staleSuspended,
      send: result.send,
      skip_reason: result.reason ?? null,
      open_tasks: extra.openTasks,
      items: result.items.length,
      reasons: Object.keys(reasons).sort().join(","),
      reason_new_session: reasons.new_session ?? 0,
      reason_newly_assigned: reasons.newly_assigned ?? 0,
      reason_others_acted: reasons.others_acted ?? 0,
      reason_stale: reasons.stale ?? 0,
      items_no_assignee: extra.noAssigneeItems ?? 0,
      items_no_assignee_deferred: extra.noAssigneeDeferred ?? 0,
      backlog: result.backlog.length,
      // The listed tasks, to read what the agent did with them afterwards.
      task_ids: (extra.taskIds ?? []).join(","),
    });
    return result;
  };

  if (!(await isIdleTaskReminderEnabled(input.serverId))) return trace(skipped("disabled"), { openTasks: 0 });

  const now = input.now ?? currentDate();
  const surfaces = await resolveAgentTaskSurfaces(input.serverId, input.agentId);
  const assigned = (await listAssignedTasks(surfaces, input.agentId))
    .filter((task) => isOpenStatus(task.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, IDLE_TASK_REMINDER_MAX_TASKS);
  // The agent's own tasks first; those with no assignee take what the limit leaves.
  // (A task released between the two reads is still the assigned one here.)
  const assignedIds = new Set(assigned.map((task) => task.id));
  const candidates = [
    ...assigned,
    ...(await listUnassignedTasks(surfaces, input.agentId, now, IDLE_TASK_REMINDER_MAX_TASKS - assigned.length))
      .filter((task) => !assignedIds.has(task.id)),
  ];
  if (candidates.length === 0) return trace(skipped("no_open_tasks"), { openTasks: 0 });

  const facts = await loadIdleTaskFacts(input.agentId, candidates);
  const open = candidates.filter((task) => {
    const taskFacts = facts.get(task.id);
    return !task.unassigned || (taskFacts != null && isIdleTaskDue(taskFacts, now));
  });
  if (open.length === 0) return trace(skipped("no_open_tasks"), { openTasks: 0 });
  const taskIds = open.map((task) => task.id);

  type Decided =
    | { skip: "no_open_tasks" | "no_change" | "hourly_cap" }
    | { skip?: never; listed: Array<{ task: ReminderTask; decision: IdleTaskReminderDecision }>; deferred: readonly ReminderTask[] };
  const decided = await getDb().transaction(async (tx): Promise<Decided> => {
    // One decision per agent at a time: two idles racing record once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`idle-task-reminder:${input.agentId}`}, 0))`);
    const records = new Map((await tx
      .select()
      .from(agentTaskNudges)
      .where(and(eq(agentTaskNudges.agentId, input.agentId), inArray(agentTaskNudges.taskId, taskIds))))
      .map((row) => [row.taskId, row]));
    const decisions: Array<{ task: ReminderTask; decision: IdleTaskReminderDecision }> = [];
    for (const task of open) {
      const taskFacts = facts.get(task.id);
      if (!taskFacts) continue;
      const decision = decideIdleTaskReminder(taskFacts, records.get(task.id) ?? null, { now, freshSession, staleSuspended });
      if (decision) decisions.push({ task, decision });
    }
    // With only tasks with no assignee, a new session has nothing to list at all:
    // say so, or its Computer keeps asking as a new session (no_change does not
    // settle it) and a task assigned later reads "new session", not "newly yours".
    if (decisions.length === 0) return { skip: freshSession && assigned.length === 0 ? "no_open_tasks" : "no_change" };
    const { listed, deferred } = limitUnassignedItems(decisions);

    const windowStart = new Date(now.getTime() - IDLE_TASK_REMINDER_CAP_WINDOW_MS);
    await tx.delete(agentTaskNudgeSends).where(and(eq(agentTaskNudgeSends.agentId, input.agentId), lt(agentTaskNudgeSends.sentAt, windowStart)));
    const [sentInWindow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentTaskNudgeSends)
      .where(and(eq(agentTaskNudgeSends.agentId, input.agentId), gt(agentTaskNudgeSends.sentAt, windowStart)));
    if (Number(sentInWindow?.n ?? 0) >= IDLE_TASK_REMINDER_HOURLY_CAP) return { skip: "hourly_cap" };

    await tx.insert(agentTaskNudges).values(listed.map(({ task, decision }) => ({
      agentId: input.agentId,
      taskId: task.id,
      lastReason: decision.reason,
      lastNudgedAt: now,
      seenOthersActionAt: decision.record.seenOthersActionAt,
      staleSinceAt: decision.record.staleSinceAt,
      staleStep: decision.record.staleStep,
    }))).onConflictDoUpdate({
      target: [agentTaskNudges.agentId, agentTaskNudges.taskId],
      set: {
        lastReason: sql`excluded.last_reason`,
        lastNudgedAt: sql`excluded.last_nudged_at`,
        seenOthersActionAt: sql`excluded.seen_others_action_at`,
        staleSinceAt: sql`excluded.stale_since_at`,
        staleStep: sql`excluded.stale_step`,
      },
    });
    await tx.insert(agentTaskNudgeSends).values({ agentId: input.agentId, sentAt: now, itemCount: listed.length });
    return { listed, deferred };
  });
  if (decided.skip) return trace(skipped(decided.skip), { openTasks: open.length });

  const listed = [...decided.listed].sort((a, b) => a.task.channelRef.localeCompare(b.task.channelRef) || a.task.taskNumber - b.task.taskNumber);
  const items: AgentApiTaskIdleNudgeItem[] = listed.map(({ task, decision }) => ({
    ref: task.ref,
    taskNumber: task.taskNumber,
    channel: task.channelRef,
    title: task.title,
    status: task.status,
    reason: decision.reason,
    why: formatIdleTaskReminderWhy(decision.why),
  }));
  const backlog: AgentApiTaskIdleNudgeBacklogItem[] = (await listAssignedTasks(surfaces, input.agentId, BACKLOG_STATUS))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, IDLE_TASK_REMINDER_MAX_BACKLOG)
    .map((task) => ({ ref: task.ref, taskNumber: task.taskNumber, channel: task.channelRef, title: task.title }));
  const noticeInput = {
    items: items.map((item, index) => ({ ...item, noAssignee: listed[index]!.task.unassigned })),
    moreNoAssignee: decided.deferred.length > 0
      ? { count: decided.deferred.length, boards: [...new Set(decided.deferred.map((task) => task.channelRef))].sort() }
      : undefined,
    backlog,
    backgroundTasks,
    backlogActive: IDLE_TASK_REMINDER_BACKLOG_ACTIVE,
    rules: input.rulesShown !== true,
  };
  const text = formatIdleTaskReminderNotice(noticeInput);
  return trace({ send: true, items, backlog, text, rules: idleTaskReminderNoticeHasRules(noticeInput) }, {
    openTasks: open.length,
    taskIds: listed.map(({ task }) => task.id),
    noAssigneeItems: listed.filter(({ task }) => task.unassigned).length,
    noAssigneeDeferred: decided.deferred.length,
  });
}
