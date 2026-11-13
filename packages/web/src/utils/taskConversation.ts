import { formatRaftChannelTaskRef, formatRaftDmTaskRef } from "@botiverse/raft-shared";

/**
 * Task v2: a task's discussion is its own sub-conversation (`channels.type =
 * 'task'`), not a message's thread. It behaves like a thread (follow, unread,
 * Activity) but has no parent message: its parent is the task.
 *
 * The server surfaces task conversations through the same read models that
 * carry threads (followed threads, the Activity inbox, search, live
 * `message:new` frames). This module is the one place the web client
 * recognizes them and folds them into the thread-shaped client models, so a
 * task conversation row never reaches a code path that needs a parent message
 * (open a thread by parent, jump to a parent in the channel, ...).
 */

/** Which sub-conversation a followed / inbox thread-shaped row stands for. */
export type SubConversationKind = "thread" | "task";

/**
 * `#channel:#7` for a task in a channel, `dm:@peer:#7` for a task in a DM —
 * the one task address (shared formatter), used for titles in Activity, search
 * and the task dialog. Without a channel name (not loaded yet) the bare `#7`.
 */
export function formatTaskConversationRef(input: {
  taskNumber: number;
  channelName?: string | null;
  channelType?: string | null;
  dmPeerName?: string | null;
}): string {
  if (input.channelType === "dm") {
    if (input.dmPeerName) return formatRaftDmTaskRef(input.dmPeerName, input.taskNumber);
    return `#${input.taskNumber}`;
  }
  const name = input.channelName?.replace(/^#/, "");
  return name ? formatRaftChannelTaskRef(name, input.taskNumber) : `#${input.taskNumber}`;
}

/** `#channel:#7 title` (the task conversation's title in Activity and search). */
export function formatTaskConversationTitle(ref: string, title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `${ref} ${trimmed}` : ref;
}

/** The fields a live message frame carries about its conversation. */
interface ConversationContextLike {
  channelType?: unknown;
  taskId?: unknown;
}

/** A message written in a task conversation (live frames carry its context). */
export function isTaskConversationMessage(message: { conversationContext?: ConversationContextLike | null }): boolean {
  return message.conversationContext?.channelType === "task";
}

/** The task a task-conversation message belongs to, when its frame says so. */
export function taskIdOfConversationMessage(message: { conversationContext?: ConversationContextLike | null }): string | null {
  const taskId = message.conversationContext?.taskId;
  return isTaskConversationMessage(message) && typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/**
 * Is this served thread-shaped row (followed threads, Activity) a task
 * conversation? The server marks it `kind: "task"`; a row already folded here
 * carries `conversationKind: "task"`. An ordinary thread whose parent message
 * is a pre-v2 task also names `taskId`, but is `kind: "thread"`.
 */
export function isTaskConversationRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as { kind?: unknown; conversationKind?: unknown };
  return r.kind === "task" || r.conversationKind === "task";
}

/**
 * Task-conversation fields on a thread-shaped client row. `parentMessageId` is
 * empty for a task conversation (it has no parent message): it never matches a
 * real message id, so parent-message lookups miss instead of misfiring, and
 * callers that act on a parent check `conversationKind` first.
 */
export interface TaskConversationRowFields {
  conversationKind?: SubConversationKind;
  /** The task this conversation belongs to (task conversations only). */
  taskId?: string | null;
  /** The task's title (task conversations only). */
  taskTitle?: string | null;
}

/**
 * Fold a served task-conversation row (`kind: "task"`: `threadChannelId` is the
 * reader's local conversation, `parentChannel*` the task's channel,
 * `parentMessageId` null, plus `taskId` / `taskNumber` / `taskTitle`) into the
 * thread-shaped row the client keeps (followed threads, Activity), so every
 * thread-keyed path (keys, read, Done) applies unchanged.
 */
export function normalizeTaskConversationRow<T>(row: T): T & TaskConversationRowFields {
  if (!isTaskConversationRow(row)) return row as T & TaskConversationRowFields;
  const r = row as unknown as { kind?: unknown; taskId?: unknown; taskTitle?: unknown; taskNumber?: unknown };
  return {
    ...(row as object),
    kind: r.kind === "task" ? "thread" : r.kind,
    conversationKind: "task",
    parentMessageId: "",
    taskId: typeof r.taskId === "string" ? r.taskId : null,
    taskTitle: typeof r.taskTitle === "string" ? r.taskTitle : null,
    taskNumber: typeof r.taskNumber === "number" ? r.taskNumber : null,
  } as unknown as T & TaskConversationRowFields;
}

/** A thread-shaped client row that stands for a task conversation. */
export function isTaskConversationItem(row: TaskConversationRowFields | null | undefined): boolean {
  return row?.conversationKind === "task";
}

/**
 * The task conversation id this server can use directly, from a task DTO. The
 * DTO carries the CANONICAL conversation; outside a joint channel that is also
 * the local one. A joint channel's local conversation is resolved by the task
 * dialog (POST /tasks/:id/conversation answers it), so this returns null there.
 */
export function directTaskConversationChannelId(task: {
  conversationChannelId?: string | null;
  channelType?: string | null;
}): string | null {
  if (!task.conversationChannelId) return null;
  return task.channelType === "joint" ? null : task.conversationChannelId;
}

/** `task=<channelId>:task:<taskId>`: the task dialog's deep link (keyed by
 *  the task, not a message), in the main window and in a `_blank` window. */
const TASK_CONVERSATION_PARAM_PREFIX = "task:";

export function formatTaskConversationParam(channelId: string, taskId: string): string {
  return `${channelId}:${TASK_CONVERSATION_PARAM_PREFIX}${taskId}`;
}

/** The task-keyed form of a `task=` value, or null (message-keyed `<ch>:<msg>`, legacy `1`). */
export function parseTaskConversationParam(value: string | null | undefined): { channelId: string; taskId: string } | null {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const rest = value.slice(idx + 1);
  if (!rest.startsWith(TASK_CONVERSATION_PARAM_PREFIX)) return null;
  const taskId = rest.slice(TASK_CONVERSATION_PARAM_PREFIX.length);
  return taskId ? { channelId: value.slice(0, idx), taskId } : null;
}

/** The task DTO fields that say which way a task works (task v2 per-task mode). */
export interface TaskModeFields {
  isLegacy?: boolean;
  conversationAnchored?: boolean;
  conversationChannelId?: string | null;
  hostMessageId?: string | null;
}

/**
 * Task v2, per task: was this task made the v2 way — its discussion is its own
 * conversation (it exists, or the task was created to have one), not a host
 * message's thread? Such a task keeps working the v2 way whatever the
 * `task_v2_conversations_v0` flag says now (rollback, the flag-off side of a
 * joint channel, a client that has not refreshed the flag): its `messageId` is
 * only the task id as a compatibility fallback, never a message to open.
 *
 * `conversationAnchored` is the server's reading (conversation exists, or
 * `own_conversation`); `hostMessageId: null` on a non-legacy task says the same
 * for a DTO without it. A DTO with neither field (older server) is pre-v2.
 */
export function isTaskV2Task(task: TaskModeFields): boolean {
  if (task.isLegacy) return false;
  if (task.conversationAnchored === true) return true;
  if (task.conversationChannelId) return true;
  return task.hostMessageId === null;
}

/**
 * Does opening this task open the task dialog (its own conversation, keyed by
 * the task) rather than its host message's thread? With the flag on every
 * non-legacy task does; with it off only a task made the v2 way does, and a
 * pre-v2 task opens its host message's thread as before task v2.
 */
export function opensAsTaskConversation(task: TaskModeFields, taskV2Enabled: boolean): boolean {
  if (task.isLegacy) return false;
  return taskV2Enabled || isTaskV2Task(task);
}

/** What a task's Source property shows (#wg-task-v2:#23: a task always has a source). */
export type TaskSourceDisplay = { kind: "message"; id: string } | { kind: "notRecorded" } | null;

/**
 * The message a task was created from, "not recorded" when it has none (a task
 * created before sources were required, or a pre-v2 task whose "source" is the
 * message it was posted as: the server's `sourceRecorded`), or nothing to show
 * (null) for a server that predates `sourceRecorded`, where a pre-v2 task's host
 * stands for its source and the Earlier discussion row already leads there.
 */
export function taskSourceDisplay(task: {
  sourceMessageId?: string | null;
  sourceRecorded?: boolean;
  hostMessageId?: string | null;
  messageId: string;
}): TaskSourceDisplay {
  const sourceId = task.sourceMessageId ?? null;
  if (task.sourceRecorded !== undefined) {
    return task.sourceRecorded && sourceId ? { kind: "message", id: sourceId } : { kind: "notRecorded" };
  }
  // A task v2 task's `messageId` is only its id; its real host is none.
  const hostId = task.hostMessageId !== undefined ? task.hostMessageId : task.messageId;
  if (!sourceId || sourceId === hostId) return null;
  return { kind: "message", id: sourceId };
}
