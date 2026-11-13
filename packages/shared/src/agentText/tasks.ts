// Canonical task text for agent-facing output (moved verbatim from the CLI's
// commands/task/_format.ts; the CLI wraps these in its axSurface registrations
// and pins the bytes with its snapshot tests). The line format is an AX
// contract, not an implementation detail.

import { formatHint, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";
import { formatUtcTimestamp } from "../utcTimestamp";
import { formatAgentTaskRef } from "./taskRef";
import { AGENT_BODY_CONTINUATION_PREFIX, foldAgentOneLineText, indentAgentBodyContinuationLines } from "../agentMessageText";

/** Mirrors `TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU` on the shared root index (kept local so this module stays bundle-light). */
export const AGENT_TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU = "already claimed by you";

export interface AgentTaskLike {
  taskNumber?: number;
  status?: string;
  title?: string;
  description?: string | null;
  revision?: number | null;
  claimedById?: string | null;
  /** The assignee's handle. */
  claimedByName?: string | null;
  /** The creator's display name — not a handle. */
  createdByName?: string | null;
  /** The creator's handle (servers before 2026-10 omit it). */
  createdByHandle?: string | null;
  createdByMembershipStatus?: "active" | "left" | "removed" | null;
  messageId?: string | null;
  /** Task v2: the chat message the task hangs under. */
  sourceMessageId?: string | null;
  /** Task v2: the conversation is a hidden anchor's thread, not a chat message's. */
  conversationAnchored?: boolean;
  /**
   * Task v2 (flag-on servers only): a task created before task v2 whose own
   * conversation does not exist yet. `messageId` is still the old host message,
   * whose thread is that message's replies — not the task's conversation.
   */
  conversationPending?: boolean;
  channelRef?: string;
  /** Task v2 (flag-on servers): the task's address, `#channel:#7`, when the server sends it. */
  taskRef?: string;
  isLegacy?: boolean;
  requiresResourceReceipt?: boolean;
  resourceReceiptRecordedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface AgentTaskListData {
  tasks?: AgentTaskLike[];
  coverage?: {
    status?: string;
    visibleChannelTypes?: string[];
    includesArchived?: boolean;
    inaccessibleScope?: string;
    reason?: string;
  };
  pagination?: {
    mode?: string;
    truncated?: boolean;
  };
}

function taskTimestamps(t: AgentTaskLike): string {
  const created = t.createdAt ? ` created=${formatUtcTimestamp(t.createdAt)}` : "";
  const updated = t.updatedAt ? ` updated=${formatUtcTimestamp(t.updatedAt)}` : "";
  return `${created}${updated}`;
}

// Active work first, then what waits, then what is over.
const TASK_STATUS_ORDER = ["todo", "in_progress", "in_review", "backlog", "done", "closed"] as const;

function oneLineTaskTitle(title: string | undefined): string {
  return foldAgentOneLineText(title ?? "");
}

/**
 * Task v2: the task's address (`#channel:#7`, `dm:@peer:#7`) when it is
 * addressed by ref — it has its own conversation, or it is a pre-v2 task on a
 * flag-on server whose conversation is created on its first write. Null for
 * every task on a flag-off server (pre-v2 output, unchanged).
 */
export function agentTaskV2Ref(
  task: { taskNumber?: number; taskRef?: string | null; conversationAnchored?: boolean; conversationPending?: boolean },
  channelRef: string | undefined,
): string | null {
  if (typeof task.taskRef === "string" && task.taskRef) return task.taskRef;
  if (!task.conversationAnchored && !task.conversationPending) return null;
  if (!channelRef || !Number.isInteger(task.taskNumber)) return null;
  return formatAgentTaskRef(channelRef, task.taskNumber!);
}

/**
 * Task v2 row suffix: ` source=<short>` (the chat message the task was
 * created from) and, for a pre-v2 task, ` earlier=<thread target>` (its old
 * host message's thread, where its discussion before task v2 lives). The
 * task's own conversation is its ref, so no `conversation=` field.
 */
function taskV2MessageRefs(
  task: { messageId?: string | null; hostMessageId?: unknown; sourceMessageId?: string | null; conversationAnchored?: boolean; conversationPending?: boolean },
  channelRef: string | undefined,
): string {
  const source = task.sourceMessageId ? ` source=${task.sourceMessageId.slice(0, 8)}` : "";
  const hostMessageId = typeof task.hostMessageId === "string"
    ? task.hostMessageId
    : task.conversationPending ? task.messageId ?? null : null;
  const earlier = hostMessageId && channelRef && hostMessageId !== task.sourceMessageId
    ? ` earlier=${agentTaskThreadTarget(channelRef, hostMessageId)}`
    : "";
  return `${source}${earlier}`;
}

/**
 * ` msg=<short>`: a pre-v2 task's host message, whose thread is its
 * discussion (flag-off servers; byte-identical to staging). Task v2 rows
 * print their ref instead ({@link agentTaskV2Ref}, {@link taskV2MessageRefs}).
 */
function taskMessageRef(task: { messageId?: string | null }, _channelRef: string | undefined): string {
  return task.messageId ? ` msg=${task.messageId.slice(0, 8)}` : "";
}

/**
 * The creator as agent-facing text: `@handle`, as every other actor in CLI
 * output. `createdByName` is a display name, so a server that sends no handle
 * gets it as plain text, never @-prefixed (it would not resolve as a mention).
 */
function taskCreatorLabel(task: AgentTaskLike): string | null {
  if (task.createdByHandle) return `@${task.createdByHandle}`;
  return task.createdByName ? foldAgentOneLineText(task.createdByName) : null;
}

/** Channel task board listing. */
export function formatAgentTaskList(channel: string, data: AgentTaskListData, statusFilter?: string): string {
  if (!data.tasks || data.tasks.length === 0) {
    return (`No${statusFilter && statusFilter !== "all" ? ` ${statusFilter}` : ""} tasks in ${channel}.`);
  }

  const formatted = data.tasks
    .map((t) => {
      const assignee = t.claimedById
        ? ` → ${t.claimedByName ? `@${t.claimedByName}` : "<unresolved>"}`
        : "";
      const departedCreator = t.createdByMembershipStatus === "left"
        || t.createdByMembershipStatus === "removed";
      const creatorLabel = taskCreatorLabel(t);
      const creator = creatorLabel
        ? ` (by ${creatorLabel}${departedCreator ? " [departed]" : ""})`
        : "";
      const v2Ref = agentTaskV2Ref(t, channel);
      const msgId = v2Ref ? taskV2MessageRefs(t, channel) : taskMessageRef(t, channel);
      const revision = Number.isInteger(t.revision) ? ` rev=${t.revision}` : "";
      const legacy = t.isLegacy ? " [LEGACY — read-only]" : "";
      const resourceReceipt = t.requiresResourceReceipt
        ? ` resource-receipt=${t.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      const descriptionPrefix = "  Current description: ";
      const details = t.description
        ? `\n${descriptionPrefix}${indentAgentBodyContinuationLines(t.description)}`
        : "";
      return `${v2Ref ?? `#${t.taskNumber}`} [${t.status}]${assignee}${creator}${msgId}${revision}${resourceReceipt}${taskTimestamps(t)}${legacy} Current title: ${oneLineTaskTitle(t.title)}${details}`;
    })
    .join("\n");

  return (`## Task Board for ${channel} (${data.tasks.length} tasks)\n\n${formatted}`);
}

/** Cross-channel --mine task listing with coverage notes. */
export function formatAgentMyTaskList(data: AgentTaskListData, statusFilter?: string): string {
  const tasks = data.tasks ?? [];
  const visibleTypes = data.coverage?.visibleChannelTypes?.join("|") ?? "unknown";
  const archived = data.coverage?.includesArchived ? "included" : "not included";
  const coverage = [
    `Coverage: ${data.coverage?.status ?? "unknown"}`,
    `visible types=${visibleTypes}`,
    `archived=${archived}`,
    `inaccessible scope=${data.coverage?.inaccessibleScope ?? "unknown"}`,
  ].join(" · ");
  const output = `Output: showing ${tasks.length} of ${tasks.length} visible matches · mode=${data.pagination?.mode ?? "unknown"} · truncated=${String(data.pagination?.truncated ?? "unknown")}`;
  const title = `## My assigned tasks on this server${statusFilter ? ` (status=${statusFilter})` : " (unfinished)"}`;

  if (tasks.length === 0) {
    return ([title, "", coverage, output, "", "No tasks matched in the covered visible scope."].join("\n"));
  }

  const grouped = new Map<string, AgentTaskLike[]>();
  for (const task of tasks) {
    const status = task.status ?? "unknown";
    const bucket = grouped.get(status) ?? [];
    bucket.push(task);
    grouped.set(status, bucket);
  }
  const statuses = [
    ...TASK_STATUS_ORDER.filter((status) => grouped.has(status)),
    ...[...grouped.keys()].filter((status) => !(TASK_STATUS_ORDER as readonly string[]).includes(status)).sort(),
  ];
  const sections = statuses.map((status) => {
    const rows = grouped.get(status)!;
    const rendered = rows.map((task) => {
      const channelRef = task.channelRef ?? "<unresolved-visible-target>";
      const taskNumber = task.taskNumber ?? "?";
      const departedCreator = task.createdByMembershipStatus === "left"
        || task.createdByMembershipStatus === "removed";
      const creatorLabel = taskCreatorLabel(task);
      const creator = creatorLabel
        ? ` by=${creatorLabel.startsWith("@") ? creatorLabel : JSON.stringify(creatorLabel)}${departedCreator ? " creator=departed" : ""}`
        : "";
      const v2Ref = agentTaskV2Ref(task, task.channelRef);
      const message = v2Ref ? taskV2MessageRefs(task, task.channelRef) : taskMessageRef(task, task.channelRef);
      const legacy = task.isLegacy ? " legacy=read-only" : "";
      const resourceReceipt = task.requiresResourceReceipt
        ? ` resource-receipt=${task.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      return `- ${v2Ref ?? `${channelRef} task #${taskNumber}`} [${status}]${creator}${message}${resourceReceipt}${taskTimestamps(task)}${legacy} Current title: ${oneLineTaskTitle(task.title)}`.trimEnd();
    });
    return [`### ${status} (${rows.length})`, ...rendered].join("\n");
  });

  return ([title, "", coverage, output, "", ...sections].join("\n"));
}

export interface AgentCreatedTask {
  taskNumber: number;
  messageId: string;
  title: string;
  status: string;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
  claimedByName?: string | null;
  claimedAt: string | null;
  requiresResourceReceipt?: boolean;
  /** Task v2 only: the task has its own conversation (addressed as `#channel:#7`). */
  conversationAnchored?: boolean;
  sourceMessageId?: string | null;
  /** Task v2: the thread reply given as the source; `sourceMessageId` is its thread's root. */
  sourceThreadReplyId?: string;
  /** Task v2: the task's address, when the server sends it. */
  taskRef?: string;
}

export interface AgentCreateTasksData {
  tasks: AgentCreatedTask[];
  assignmentReceipt?: {
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
  };
}

/** Receipt for task create. */
export function formatAgentTasksCreated(channel: string, data: AgentCreateTasksData, style: RaftHintStyle = "cli"): string {
  const created = data.tasks
    .map((t) => {
      const assignee = t.claimedById
        ? (t.claimedByName ? `@${t.claimedByName}` : "<unresolved>")
        : "unassigned";
      const resourceReceipt = t.requiresResourceReceipt ? " resource-receipt=pending" : "";
      const v2Ref = agentTaskV2Ref(t, channel);
      const label = v2Ref ?? `#${t.taskNumber}`;
      const messageRef = v2Ref ? taskV2MessageRefs(t, channel) : taskMessageRef(t, channel);
      return `${label} [${t.status}] assignee=${assignee} claimedAt=${t.claimedAt ?? "null"}${messageRef}${resourceReceipt} "${foldAgentOneLineText(t.title)}"`;
    })
    .join("\n");

  // Task v2: each task's conversation is its own, addressed by its ref.
  const v2 = data.tasks.some((t) => agentTaskV2Ref(t, channel));
  const threadHints = data.tasks
    .map((t) => {
      const v2Ref = agentTaskV2Ref(t, channel);
      return v2Ref
        ? `${v2Ref} → ${formatHint(RAFT_HINTS.taskReply(v2Ref), style)}`
        : `#${t.taskNumber} → ${formatHint(RAFT_HINTS.messageSend({ target: `${channel}:${t.messageId.slice(0, 8)}` }), style)}`;
    })
    .join("\n");
  const hintHeader = v2
    ? "To discuss each task in its own conversation (the reply body is read from stdin):"
    : "To follow up in each task's thread:";

  const receipt = data.assignmentReceipt
    ? `\n\nAssignment receipt (msg=${data.assignmentReceipt.messageId.slice(0, 8)}):\n${data.assignmentReceipt.content}`
    : "";

  // Task v2: work taken from a message is announced where its sender spoke,
  // the message's thread (what you understood and will do): they read that
  // thread, not the task's conversation (#wg-task-v2:98488173).
  // One reply per source message, whatever number of tasks came from it.
  const sourceTargets = new Map<string, string[]>();
  for (const t of data.tasks) {
    const v2Ref = agentTaskV2Ref(t, channel);
    if (!v2Ref || !t.sourceMessageId || !t.claimedById || t.status !== "in_progress") continue;
    const target = agentTaskThreadTarget(channel, t.sourceMessageId);
    sourceTargets.set(target, [...(sourceTargets.get(target) ?? []), v2Ref]);
  }
  const sourceHints = [...sourceTargets]
    .map(([target, refs]) => `${refs.join(", ")} → ${formatHint(RAFT_HINTS.messageSend({ target }), style)}`)
    .join("\n");
  const sourceHint = sourceHints
    ? `\n\nThe source message's thread now names this task. If you have not confirmed it there yet (what you understood and will do), do it now:\n${sourceHints}`
    : "";

  // A thread reply given as the source: the task hangs under the thread's
  // root message instead (one line per root, whatever number of tasks).
  const rootNotes = new Map<string, string>();
  for (const t of data.tasks) {
    if (!t.sourceThreadReplyId || !t.sourceMessageId) continue;
    rootNotes.set(t.sourceMessageId, `Source: the thread's root message msg=${t.sourceMessageId.slice(0, 8)} (you gave a reply in its thread, msg=${t.sourceThreadReplyId.slice(0, 8)}).`);
  }
  const rootNote = rootNotes.size > 0 ? `\n${[...rootNotes.values()].join("\n")}` : "";

  return (`Created ${data.tasks.length} task(s) in ${channel}:\n${created}${rootNote}${receipt}\n\n${hintHeader}\n${threadHints}${sourceHint}`);
}

export interface AgentClaimConflict {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  blockedActions: string[];
  unblockedActionExamples: string[];
  currentAssignee: { type: "user" | "agent"; name: string | null } | null;
  taskStatus: string | null;
  claimedAt: string | null;
  observedAt: string;
}

export interface AgentClaimResult {
  taskNumber?: number;
  messageId?: string;
  /** Task v2: the claimed task's conversation parent when it differs from `messageId` (claimed via its source message). */
  conversationMessageId?: string;
  /** Task v2 (flag-on servers): the task's address, `#channel:#7`. */
  taskRef?: string;
  success: boolean;
  reason?: string;
  conflict?: AgentClaimConflict;
}

const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

function formatClaimConflict(label: string, conflict: AgentClaimConflict): string {
  const holder = conflict.currentAssignee?.name
    ? `@${conflict.currentAssignee.name}`
    : "another actor";
  const blocked = conflict.blockedActions
    .map((action) => BLOCKED_ACTION_COPY[action] ?? action)
    .join("; ");
  const examples = conflict.unblockedActionExamples.join(" · ");
  return [
    `${label}: Claim failed — ${holder} currently holds the implementation lock (assignment state as of ${conflict.observedAt}).`,
    `  Blocked: ${blocked}.`,
    `  Not blocked by this claim conflict (each still subject to its own authority/policy): ${examples}.`,
    `  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted: correct the routing in the original thread, or file request_reassign (a request — it does not itself reassign).`,
  ].join("\n");
}

export interface AgentClaimTasksData {
  results: AgentClaimResult[];
}

export function canonicalAgentTaskTarget(target: string): string {
  return target.replace(/^dm:user:/i, "dm:@");
}

export function agentTaskThreadTarget(target: string, messageId: string): string {
  return `${canonicalAgentTaskTarget(target)}:${messageId.slice(0, 8)}`;
}

/** Claim results incl. concurrency-lock guidance on failed claims. */
export function formatAgentClaimResults(channel: string, data: AgentClaimTasksData, style: RaftHintStyle = "cli"): string {
  const lines = data.results.map((r) => {
    const label = r.taskRef ?? (r.taskNumber ? `#${r.taskNumber}` : `msg:${r.messageId}`);
    if (r.success) {
      if (r.taskRef) return `${label}: claimed`;
      const msgShort = r.messageId ? r.messageId.slice(0, 8) : "";
      return `${label} (msg:${msgShort}): claimed`;
    }
    if (r.reason === AGENT_TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU) {
      return `${label}: already claimed by you.`;
    }
    if (r.conflict?.kind === "claim_conflict") {
      return formatClaimConflict(label, r.conflict);
    }
    return `${label}: FAILED — ${r.reason || "already claimed"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
  });

  const succeeded = data.results.filter((r) => r.success).length;
  const failed = data.results.length - succeeded;
  let summary = `${succeeded} claimed`;
  if (failed > 0) summary += `, ${failed} failed`;

  // Task v2: a claimed task is discussed in its own conversation (its ref).
  const claimedV2 = data.results
    .filter((r) => r.success && r.taskRef)
    .map((r) => `${r.taskRef} → ${formatHint(RAFT_HINTS.taskReply(r.taskRef!), style)}`)
    .join("\n");
  const claimedMsgs = data.results
    .filter((r) => r.success && !r.taskRef && r.messageId)
    .map((r) => `#${r.taskNumber} → ${formatHint(RAFT_HINTS.messageSend({ target: agentTaskThreadTarget(channel, r.conversationMessageId ?? r.messageId!) }), style)}`)
    .join("\n");
  // Answer the person who asked where they spoke: `task view` names who
  // created the task and the message it came from.
  const claimedV2Refs = data.results.filter((r) => r.success && r.taskRef).map((r) => r.taskRef!);
  const threadHint = claimedV2
    ? `\n\nFollow up in each task's conversation (the reply body is read from stdin):\n${claimedV2}\n\n${answerWhereTheySpoke(claimedV2Refs, style)}`
    : claimedMsgs
      ? `\n\nFollow up in each task's thread:\n${claimedMsgs}`
      : "";

  return (`Claim results (${summary}):\n${lines.join("\n")}${threadHint}`);
}

/** `#channel:#7` on a task v2 server (the server sends `taskRef`), `#7` otherwise. */
function taskLabel(taskNumber: number, taskRef?: string | null): string {
  return taskRef || `#${taskNumber}`;
}

export function formatAgentTaskUnclaimed(taskNumber: number, taskRef?: string | null): string {
  return (`${taskLabel(taskNumber, taskRef)} unclaimed — now open.`);
}

export function formatAgentTaskAssigned(taskNumber: number, assignee: string | null, taskRef?: string | null): string {
  return (assignee
    ? `${taskLabel(taskNumber, taskRef)} assigned to ${assignee}.`
    : `${taskLabel(taskNumber, taskRef)} unassigned — now open.`);
}

/**
 * `status` is what the server stored. `requestedStatus` is what the caller
 * asked for: a task v2 task asked for in_review stores in_progress
 * (#wg-task-v2:f7043517), and the receipt says so instead of the request.
 */
export function formatAgentTaskStatusUpdated(
  taskNumber: number,
  status: string,
  taskRef?: string | null,
  style: RaftHintStyle = "cli",
  requestedStatus?: string,
): string {
  const moved = `${taskLabel(taskNumber, taskRef)} moved to ${status}.`;
  if (requestedStatus === "in_review" && status !== "in_review") {
    return `${moved}\nin_review is not used for task v2 tasks; it is ${status} instead, assignee unchanged.`;
  }
  if (!taskRef) return moved;
  // Task v2: finished work goes to done and its result to the person who
  // asked, where they spoke (#wg-task-v2:98488173). in_review is no
  // longer used (#wg-task-v2:f7043517): it is still accepted; steer away from it.
  if (status === "done") return `${moved}\n\nNot sent the result yet? ${answerWhereTheySpoke([taskRef], style)}`;
  if (status !== "in_review") return moved;
  return `${moved}\n\nDon't leave it in in_review: it is no longer used. Finished: set it done. Waiting on someone's decision or input: set it in_progress, assign it to them, and say in its conversation exactly what you need. ${answerWhereTheySpoke([taskRef], style)}`;
}

/**
 * Where to answer the person who asked (task v2): the source message's
 * thread, or the task if they created it or wrote in it. `task view` names the
 * creator and the source; a tool-mode caller has no command for it, so the
 * line names it in prose there.
 */
function answerWhereTheySpoke(refs: readonly string[], style: RaftHintStyle): string {
  const lead = "Answer the person who asked where they spoke (the source message's thread, or the task if they created it or wrote in it)";
  if (style !== "cli") return `${lead}; viewing the task shows who created it and its source.`;
  return `${lead}; this shows who created the task and its source:\n${refs.map((ref) => formatHint(RAFT_HINTS.taskView(ref), style)).join("\n")}`;
}

export function formatAgentTaskDeleted(taskNumber: number, taskRef?: string | null): string {
  return (`${taskLabel(taskNumber, taskRef)} deleted.`);
}

/** Message→task conversion receipt. */
export function formatAgentTaskConverted(channel: string, task: AgentCreatedTask, style: RaftHintStyle = "cli"): string {
  const target = `${canonicalAgentTaskTarget(channel)}:${task.messageId.slice(0, 8)}`;
  return ([
    `Converted msg=${task.messageId.slice(0, 8)} to task #${task.taskNumber} [${task.status}] assignee=unassigned "${foldAgentOneLineText(task.title)}"`,
    "",
    `To follow up in the task's thread:`,
    formatHint(RAFT_HINTS.messageSend({ target }), style),
  ].join("\n"));
}

export interface AgentTaskAmendData {
  task: {
    taskNumber: number;
    title: string;
    description: string | null;
    revision: number;
  };
  event: {
    seq: number;
  };
}

export function formatAgentTaskAmended(data: AgentTaskAmendData): string {
  const details = data.task.description === null
    ? "details: <none>"
    : `details:\n${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(data.task.description)}`;
  return ([
    `#${data.task.taskNumber} amended — revision ${data.task.revision}, event seq ${data.event.seq}.`,
    `title: ${foldAgentOneLineText(data.task.title)}`,
    details,
  ].join("\n"));
}

export interface AgentTaskHistoryData {
  task: {
    taskNumber: number;
    title: string;
    description: string | null;
    revision: number;
  };
  events: Array<{
    seq: number;
    eventType: string;
    actorType: "user" | "agent" | "system";
    actorName: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

export function formatAgentTaskHistory(data: AgentTaskHistoryData): string {
  const description = data.task.description === null
    ? "(none set)"
    : indentAgentBodyContinuationLines(data.task.description);
  const header = [
    `## Task #${data.task.taskNumber} history — revision ${data.task.revision}`,
    "",
    `Current title: ${foldAgentOneLineText(data.task.title)}`,
    `Current description: ${description}`,
  ].join("\n");
  if (data.events.length === 0) return (`${header}\n\nNo recorded events.`);
  const events = data.events.map((event) => {
    const actor = event.actorType === "system"
      ? "@system"
      : event.actorName ? `@${event.actorName}` : "<unresolved>";
    return `seq=${event.seq} time=${event.createdAt} actor=${actor} type=${event.eventType}\n  ${JSON.stringify(event.payload)}`;
  }).join("\n");
  return (`${header}\n\n${events}`);
}

/**
 * `raft task show`: one task's current title and description (moved verbatim
 * from the CLI's commands/task/show.ts). Labels match the agent delivery
 * surface (`Current title:` / `Current description:`). `description` has three
 * states that must not collapse: a string, an explicit null, and a field the
 * envelope omitted.
 */
export function formatAgentTaskShow(
  target: string,
  task: {
    taskNumber?: number;
    status?: string | null;
    title?: string | null;
    description?: string | null;
    taskRef?: string | null;
    conversationAnchored?: boolean;
    conversationPending?: boolean;
  },
): string {
  const descriptionLine =
    typeof task.description === "string"
      ? `Current description: ${indentAgentBodyContinuationLines(task.description)}`
      : task.description === null
        ? "Current description: (none set)"
        : "Current description: (not returned by this surface)";
  const v2Ref = agentTaskV2Ref(task, target);
  return [
    v2Ref ? `${v2Ref} [${task.status ?? "unknown"}]` : `#${task.taskNumber} [${task.status ?? "unknown"}] in ${target}`,
    `Current title: ${task.title ? foldAgentOneLineText(task.title) : "(none set)"}`,
    descriptionLine,
    "",
  ].join("\n");
}

/** Error code of `task convert` / `task claim --message-id` on a task v2 server. */
export const TASK_V2_USE_CREATE_ERROR_CODE = "task_v2_use_create";

/** Escape a value for the inside of a double-quoted shell word. */
function taskV2ShellEscape(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

/** A one-line `--title` suggestion from a message body (≤ 80 chars). */
function taskV2TitleHint(text: string | null | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "<title>";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function taskV2CreateCommand(channel: string, messageShortId: string, titleHint: string | null | undefined, assignee?: string | null): string {
  return formatHint(RAFT_HINTS.taskCreateFromMessage({
    target: canonicalAgentTaskTarget(channel),
    messageId: messageShortId,
    title: taskV2ShellEscape(taskV2TitleHint(titleHint)),
    ...(assignee ? { assignee } : {}),
  }));
}

/**
 * The refusal text of `raft task convert` on a task v2 server (spec §5). The
 * whole text travels in the API `error` field so CLIs that predate it print
 * the new way verbatim.
 */
export function formatTaskV2ConvertRefusal(input: {
  channel: string;
  messageShortId: string;
  /** The message body, for a prefilled `--title`. */
  messageText?: string | null;
  /** The caller's own `@handle`, for the `--assignee` variant. */
  selfHandle?: string | null;
}): string {
  const self = input.selfHandle ? `@${input.selfHandle.replace(/^@/, "")}` : "@<you>";
  return [
    "`task convert` is not available on this server: tasks here have their own conversations, and a message is never turned into a task. Nothing was converted.",
    "Create a task from the message instead (the task stays linked to it; edit the title as needed):",
    `  ${taskV2CreateCommand(input.channel, input.messageShortId, input.messageText)}`,
    `To take it yourself in the same step, add --assignee ${self}.`,
  ].join("\n");
}

export interface TaskV2ClaimByMessageRefusalItem {
  /** The id as given (shown when the message was not found). */
  requested: string;
  /** 8-char short id of the resolved message; null when not found in the channel. */
  messageShortId: string | null;
  /** Numbers of the tasks this message names (its own task, or the tasks hanging under it). */
  taskNumbers: number[];
  messageText?: string | null;
}

/**
 * The refusal text of `raft task claim --message-id` on a task v2 server (spec
 * §5): per message, the `--number` claim commands of its tasks, or the create
 * command when it has none.
 */
export function formatTaskV2ClaimByMessageRefusal(input: {
  channel: string;
  items: readonly TaskV2ClaimByMessageRefusalItem[];
  selfHandle?: string | null;
  /** The same call also named --number tasks (not claimed either). */
  alsoHadTaskNumbers?: boolean;
}): string {
  const target = canonicalAgentTaskTarget(input.channel);
  const self = input.selfHandle ? `@${input.selfHandle.replace(/^@/, "")}` : "@<you>";
  const lines = [
    "`task claim --message-id` is not available on this server: tasks here have their own conversations and are claimed by number. Nothing was claimed"
      + (input.alsoHadTaskNumbers ? " (the --number tasks in this call included; claim them without --message-id)." : "."),
  ];
  for (const item of input.items) {
    if (!item.messageShortId) {
      lines.push(`Message ${item.requested}: not found in ${target}.`);
      continue;
    }
    if (item.taskNumbers.length > 0) {
      const refs = item.taskNumbers.map((n) => formatAgentTaskRef(target, n) ?? `#${n}`).join(", ");
      lines.push(`Message ${item.messageShortId} has ${item.taskNumbers.length === 1 ? "task" : `${item.taskNumbers.length} tasks:`} ${refs} — claim by number:`);
      for (const n of item.taskNumbers) lines.push(`  ${formatHint(RAFT_HINTS.taskClaim({ target, taskNumber: n }))}`);
      continue;
    }
    lines.push(`Message ${item.messageShortId} has no task — create one from it and take it:`);
    lines.push(`  ${taskV2CreateCommand(input.channel, item.messageShortId, item.messageText, self)}`);
  }
  return lines.join("\n");
}

export interface AgentTaskViewMessageLike {
  seq?: number | null;
  id?: string | null;
  message_id?: string | null;
  createdAt?: string | null;
  timestamp?: string | null;
  senderType?: string | null;
  sender_type?: string | null;
  senderName?: string | null;
  sender_name?: string | null;
  content?: string | null;
  attachments?: Array<{ id: string; filename: string }>;
  [key: string]: unknown;
}

export interface AgentTaskViewData {
  taskRef: string;
  task: AgentTaskLike;
  following: boolean;
  followReason?: string | null;
  conversation: { exists: boolean; replyCount: number };
  sourceMessage?: { id: string; target: string; senderName: string | null; content: string; createdAt: string | null; historyLimitMessage?: string } | null;
  earlierDiscussion?: { target: string; replyCount: number } | null;
  recentMessages: AgentTaskViewMessageLike[];
  hasOlder: boolean;
  historyLimited?: boolean;
  historyLimitMessage?: string;
}

const TASK_VIEW_PREVIEW_CHARS = 160;

function oneLinePreview(text: string): string {
  const line = foldAgentOneLineText(text);
  return line.length > TASK_VIEW_PREVIEW_CHARS ? `${line.slice(0, TASK_VIEW_PREVIEW_CHARS - 1)}…` : line;
}

function taskViewMessageLine(m: AgentTaskViewMessageLike): string {
  const id = m.message_id ?? m.id ?? null;
  const time = m.timestamp ?? m.createdAt ?? null;
  const type = m.sender_type ?? m.senderType ?? null;
  const seq = typeof m.seq === "number" ? ` seq=${m.seq}` : "";
  const attachments = m.attachments?.length
    ? ` [${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}: ${m.attachments.map((a) => `${indentAgentBodyContinuationLines(a.filename)} (id:${a.id})`).join(", ")}]`
    : "";
  const body = indentAgentBodyContinuationLines(m.content ?? "");
  return `- [msg=${id ? id.slice(0, 8) : "-"}${seq} time=${time ? formatUtcTimestamp(time) : "-"}${type ? ` type=${type}` : ""}] @${foldAgentOneLineText(m.sender_name ?? m.senderName ?? "unknown")}: ${body}${attachments}`;
}

/**
 * `raft task view <ref>` (task v2): one task's properties, whether the agent
 * follows it, the latest messages of its own conversation, and the commands
 * to go on. The task is named by its ref throughout.
 */
export function formatAgentTaskView(data: AgentTaskViewData, style: RaftHintStyle = "cli"): string {
  const { task, taskRef } = data;
  const assignee = task.claimedById || task.claimedByName
    ? task.claimedByName ? `@${task.claimedByName}` : "<unresolved>"
    : "unassigned";
  const departedCreator = task.createdByMembershipStatus === "left" || task.createdByMembershipStatus === "removed";
  const creatorLabel = taskCreatorLabel(task);
  const createdBy = creatorLabel ? `${creatorLabel}${departedCreator ? " [departed]" : ""}` : "<unknown>";
  const createdAt = task.createdAt ? ` at ${formatUtcTimestamp(task.createdAt)}` : "";
  const following = data.following
    ? `yes${data.followReason ? ` (${data.followReason})` : ""} — its replies wake you`
    : "no — replies do not wake you unless you are @mentioned";
  const lines = [
    `## Task ${taskRef} [${task.status ?? "unknown"}]`,
    "",
    `Current title: ${oneLineTaskTitle(task.title)}`,
    `Assignee: ${assignee}`,
    `Created by: ${createdBy}${createdAt}`,
  ];
  if (data.sourceMessage) {
    const sender = data.sourceMessage.senderName ? `@${data.sourceMessage.senderName}` : "<unknown>";
    // Behind the plan's history window: who sent it and when, and why not what it said.
    lines.push(data.sourceMessage.historyLimitMessage
      ? `Source: msg=${data.sourceMessage.id.slice(0, 8)} in ${data.sourceMessage.target} — a message from ${sender}${data.sourceMessage.createdAt ? ` at ${formatUtcTimestamp(data.sourceMessage.createdAt)}` : ""}. ${data.sourceMessage.historyLimitMessage}`
      : `Source: msg=${data.sourceMessage.id.slice(0, 8)} in ${data.sourceMessage.target} — ${sender}: ${oneLinePreview(data.sourceMessage.content)}`);
  } else {
    // A task always has a source now; an older one created without one says
    // so, as the web's Source property does.
    lines.push("Source: (not recorded)");
  }
  if (data.earlierDiscussion) {
    const n = data.earlierDiscussion.replyCount;
    lines.push(`Earlier discussion (before task conversations): ${data.earlierDiscussion.target} — ${n} ${n === 1 ? "reply" : "replies"}; read it with ${formatHint(RAFT_HINTS.messageRead({ target: data.earlierDiscussion.target }), style)}`);
  }
  lines.push(`Following: ${following}`);
  lines.push(typeof task.description === "string" && task.description
    ? `Current description: ${indentAgentBodyContinuationLines(task.description)}`
    : "Current description: (none set)");
  if (task.isLegacy) lines.push("This task is read-only (legacy).");
  lines.push("");

  const replies = data.conversation.replyCount;
  if (!data.conversation.exists) {
    lines.push("Discussion: none yet — the first reply starts the task's conversation.");
  } else if (data.recentMessages.length === 0) {
    lines.push(data.historyLimited && data.historyLimitMessage
      ? `Discussion: nothing in the history window. ${data.historyLimitMessage}`
      : `Discussion: no messages yet.`);
  } else {
    const shown = data.recentMessages.length;
    lines.push(`Discussion (latest ${shown}${data.hasOlder ? ` of ${Math.max(replies, shown)}` : ""}, oldest first):`);
    if (data.historyLimited && data.historyLimitMessage) lines.push(data.historyLimitMessage);
    for (const message of data.recentMessages) lines.push(taskViewMessageLine(message));
  }
  lines.push("");

  const oldestSeq = data.recentMessages.find((m) => typeof m.seq === "number")?.seq;
  lines.push("Next:");
  lines.push(`  reply (body on stdin): ${formatHint(RAFT_HINTS.taskReply(taskRef), style)}`);
  lines.push(`  read the discussion: ${formatHint(RAFT_HINTS.taskRead(
    data.hasOlder && typeof oldestSeq === "number" ? { ref: taskRef, before: oldestSeq } : { ref: taskRef },
  ), style)}`);
  lines.push(data.following
    ? `  stop following: ${formatHint(RAFT_HINTS.taskUnfollow(taskRef), style)}`
    : `  follow: ${formatHint(RAFT_HINTS.taskFollow(taskRef), style)}`);
  return lines.join("\n");
}

/** `raft task follow|unfollow <ref>` receipt (task v2). */
export function formatAgentTaskFollowResult(data: { taskRef: string; following: boolean; changed: boolean }, style: RaftHintStyle = "cli"): string {
  if (data.following) {
    return [
      data.changed ? `Following ${data.taskRef}: its replies now wake you.` : `Already following ${data.taskRef}.`,
      `To stop: ${formatHint(RAFT_HINTS.taskUnfollow(data.taskRef), style)}`,
    ].join("\n");
  }
  return [
    data.changed ? `Unfollowed ${data.taskRef}: its ordinary replies no longer wake you.` : `Not following ${data.taskRef}.`,
    "A later @mention, being assigned the task or claiming it follows it again; replying in it does too.",
    `To follow again: ${formatHint(RAFT_HINTS.taskFollow(data.taskRef), style)}`,
  ].join("\n");
}

/** `raft task reply <ref>` receipt (task v2). */
export function formatAgentTaskReplySent(taskRef: string, messageId: string, queued = false): string {
  return `${queued ? "Reply queued to" : "Reply sent to"} ${taskRef}. Message ID: ${messageId}`;
}

export interface AgentFollowedTaskLike {
  taskRef: string;
  taskNumber: number;
  title: string;
  status: string;
  unread: number;
  followedAt: string;
  reason?: string | null;
}

/**
 * `raft task list --following` (task v2): the task conversations you follow —
 * their replies wake you — newest follow first, with what is unread and the
 * command that reads it.
 */
export function formatAgentFollowedTasks(tasks: readonly AgentFollowedTaskLike[], style: RaftHintStyle = "cli"): string {
  if (tasks.length === 0) return "You follow no task conversations on this server.";
  const rows = tasks.map((task) => {
    const unread = task.unread > 0
      ? ` · ${task.unread} unread · ${formatHint(RAFT_HINTS.taskRead({ ref: task.taskRef, unread: true }), style)}`
      : " · 0 unread";
    const reason = task.reason ? ` (${task.reason})` : "";
    return `- ${task.taskRef} ${JSON.stringify(oneLineTaskTitle(task.title))} [${task.status}]${unread} · followed ${formatUtcTimestamp(task.followedAt)}${reason}`;
  });
  return [
    `## Task conversations you follow on this server (${tasks.length})`,
    "",
    ...rows,
    "",
    `Stop following one: ${formatHint(RAFT_HINTS.taskUnfollow("<ref>"), style)}`,
  ].join("\n");
}
