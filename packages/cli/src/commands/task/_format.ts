import { T, UUID_A, UUID_B, sampleTask } from "../_axExampleFixtures.js";
import { axSurface } from "../../core/renderer.js";
import { formatUtcTimestamp } from "@botiverse/raft-shared";

// Canonical task formatting for agent-facing output.
// The line format is an AX contract, not an implementation detail.

import { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "@botiverse/raft-shared";

interface TaskLike {
  taskNumber?: number;
  status?: string;
  title?: string;
  description?: string | null;
  revision?: number | null;
  claimedById?: string | null;
  claimedByName?: string | null;
  createdByName?: string | null;
  createdByMembershipStatus?: "active" | "left" | "removed" | null;
  messageId?: string | null;
  channelRef?: string;
  isLegacy?: boolean;
  requiresResourceReceipt?: boolean;
  resourceReceiptRecordedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

interface TaskListData {
  tasks?: TaskLike[];
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

/**
 * Created/updated stamps for a task row. Rendered through the shared
 * `formatUtcTimestamp` so agent-facing times stay UTC-with-Z everywhere rather
 * than growing a second formatter here (PR #6991).
 */
function taskTimestamps(t: TaskLike): string {
  const created = t.createdAt ? ` created=${formatUtcTimestamp(t.createdAt)}` : "";
  const updated = t.updatedAt ? ` updated=${formatUtcTimestamp(t.updatedAt)}` : "";
  return `${created}${updated}`;
}

export const formatTaskList = axSurface(
  "Channel task board listing.",
  (channel: string, data: TaskListData, statusFilter?: string): string => {
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
      const creator = t.createdByName
        ? ` (by @${t.createdByName}${departedCreator ? " [departed]" : ""})`
        : "";
      const msgId = t.messageId ? ` msg=${t.messageId.slice(0, 8)}` : "";
      const revision = Number.isInteger(t.revision) ? ` rev=${t.revision}` : "";
      const legacy = t.isLegacy ? " [LEGACY — read-only]" : "";
      const resourceReceipt = t.requiresResourceReceipt
        ? ` resource-receipt=${t.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      const details = t.description
        ? `\n  details: ${t.description.replace(/\n/g, "\n           ")}`
        : "";
      return `#${t.taskNumber} [${t.status}] ${t.title}${assignee}${creator}${msgId}${revision}${resourceReceipt}${taskTimestamps(t)}${legacy}${details}`;
    })
    .join("\n");

  return (`## Task Board for ${channel} (${data.tasks.length} tasks)\n\n${formatted}`);
},
  {
    examples: [{ title: "channel board", args: ["#general", { tasks: [sampleTask, { ...sampleTask, number: 43, title: "review the other thing", status: "todo", claimedById: null, claimedByName: null, createdByName: "bob" }] }] }],
  },
);

const TASK_STATUS_ORDER = ["todo", "in_progress", "in_review", "done", "closed"] as const;

function oneLineTaskTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Cross-channel self-assignment view. Coverage and output completeness are
 * rendered next to their facts rather than as a free-floating promise: the
 * current lifecycle cannot prove inaccessible assignments are impossible, but
 * the returned visible set is never silently paginated or truncated.
 */
export const formatMyTaskList = axSurface(
  "Cross-channel --mine task listing with coverage notes.",
  (data: TaskListData, statusFilter?: string): string => {
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

  const grouped = new Map<string, TaskLike[]>();
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
      const creator = task.createdByName
        ? ` by=@${task.createdByName}${departedCreator ? " creator=departed" : ""}`
        : "";
      const message = task.messageId ? ` msg=${task.messageId.slice(0, 8)}` : "";
      const legacy = task.isLegacy ? " legacy=read-only" : "";
      const resourceReceipt = task.requiresResourceReceipt
        ? ` resource-receipt=${task.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      return `- ${channelRef} task #${taskNumber} [${status}]${creator}${message}${resourceReceipt}${taskTimestamps(task)}${legacy} ${oneLineTaskTitle(task.title)}`.trimEnd();
    });
    return [`### ${status} (${rows.length})`, ...rendered].join("\n");
  });

  return ([title, "", coverage, output, "", ...sections].join("\n"));
},
  {
    examples: [{ title: "cross-channel, in_progress filter", args: [{ tasks: [{ ...sampleTask, channelRef: "#general" }, { ...sampleTask, number: 7, title: "review spec", channelRef: "#proj-x", claimedByName: null, claimedById: null }], coverage: { status: "complete", visibleChannelTypes: ["channel", "dm"] } }, "in_progress"] }],
  },
);

// --- create_tasks formatting ---

interface CreatedTask {
  taskNumber: number;
  messageId: string;
  title: string;
  status: string;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
  claimedByName?: string | null;
  claimedAt: string | null;
  requiresResourceReceipt?: boolean;
}

interface CreateTasksData {
  tasks: CreatedTask[];
  assignmentReceipt?: {
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
  };
}

export const formatTasksCreated = axSurface(
  "Receipt for task create.",
  (channel: string, data: CreateTasksData): string => {
  const created = data.tasks
    .map((t) => {
      const assignee = t.claimedById
        ? (t.claimedByName ? `@${t.claimedByName}` : "<unresolved>")
        : "unassigned";
      const resourceReceipt = t.requiresResourceReceipt ? " resource-receipt=pending" : "";
      return `#${t.taskNumber} [${t.status}] assignee=${assignee} claimedAt=${t.claimedAt ?? "null"} msg=${t.messageId.slice(0, 8)}${resourceReceipt} "${t.title}"`;
    })
    .join("\n");

  const threadHints = data.tasks
    .map((t) => `#${t.taskNumber} → raft message send --target "${channel}:${t.messageId.slice(0, 8)}"`)
    .join("\n");

  const receipt = data.assignmentReceipt
    ? `\n\nAssignment receipt (msg=${data.assignmentReceipt.messageId.slice(0, 8)}):\n${data.assignmentReceipt.content}`
    : "";

  return (`Created ${data.tasks.length} task(s) in ${channel}:\n${created}${receipt}\n\nTo follow up in each task's thread:\n${threadHints}`);
},
  {
    examples: [{ args: ["#general", { tasks: [{ taskNumber: 42, messageId: UUID_A, title: "do the thing", status: "todo", claimedByType: null, claimedById: null, claimedAt: null }] }] }],
  },
);

// --- claim_tasks formatting ---

interface ClaimConflict {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  blockedActions: string[];
  unblockedActionExamples: string[];
  currentAssignee: { type: "user" | "agent"; name: string | null } | null;
  taskStatus: string | null;
  claimedAt: string | null;
  observedAt: string;
}

interface ClaimResult {
  taskNumber?: number;
  messageId?: string;
  success: boolean;
  reason?: string;
  conflict?: ClaimConflict;
}

// Human copy for the closed blocked-effect set. Rendering maps the structured
// field values so field and copy cannot drift apart; an unknown action id
// falls back to its raw id rather than being silently dropped.
const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

/**
 * Effect-boundary receipt for an assignment-held claim conflict. All variable
 * content (assignee, timestamp, blocked set, examples) projects from the
 * structured conflict object — same source as the machine fields. The
 * restriction, the non-ruling declaration, and the remedy path are one block:
 * placement is contract, not styling.
 */
function formatClaimConflict(label: string, conflict: ClaimConflict): string {
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

interface ClaimTasksData {
  results: ClaimResult[];
}

function canonicalTaskTarget(target: string): string {
  return target.replace(/^dm:user:/i, "dm:@");
}

function taskThreadTarget(target: string, messageId: string): string {
  return `${canonicalTaskTarget(target)}:${messageId.slice(0, 8)}`;
}

export const formatClaimResults = axSurface(
  "Claim results incl. concurrency-lock guidance on failed claims.",
  (channel: string, data: ClaimTasksData): string => {
  const lines = data.results.map((r) => {
    const label = r.taskNumber ? `#${r.taskNumber}` : `msg:${r.messageId}`;
    if (r.success) {
      const msgShort = r.messageId ? r.messageId.slice(0, 8) : "";
      return `${label} (msg:${msgShort}): claimed`;
    }
    if (r.reason === TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU) {
      return `${label}: already claimed by you.`;
    }
    if (r.conflict?.kind === "claim_conflict") {
      return formatClaimConflict(label, r.conflict);
    }
    // No structured conflict (older server, or a non-conflict failure such as
    // closed/done/not found): conservatively block conflicting execution only.
    // A failed claim is never a ruling on lane ownership, so the old blanket
    // "do not work on this task" wording must not come back here.
    return `${label}: FAILED — ${r.reason || "already claimed"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
  });

  const succeeded = data.results.filter((r) => r.success).length;
  const failed = data.results.length - succeeded;
  let summary = `${succeeded} claimed`;
  if (failed > 0) summary += `, ${failed} failed`;

  const claimedMsgs = data.results
    .filter((r) => r.success && r.messageId)
    .map((r) => `#${r.taskNumber} → raft message send --target "${taskThreadTarget(channel, r.messageId!)}"`)
    .join("\n");
  const threadHint = claimedMsgs
    ? `\n\nFollow up in each task's thread:\n${claimedMsgs}`
    : "";

  return (`Claim results (${summary}):\n${lines.join("\n")}${threadHint}`);
},
  {
    examples: [{ title: "mixed claimed/failed", args: ["#general", { results: [{ taskNumber: 42, success: true, messageId: UUID_A }, { taskNumber: 43, success: false, reason: "already claimed", messageId: UUID_B }] }] }],
  },
);

// --- unclaim / update formatting ---

export const formatTaskUnclaimed = axSurface(
  "Unclaim confirmation.",
  (taskNumber: number): string => {
  return (`#${taskNumber} unclaimed — now open.`);
},
  {
    examples: [{ args: [42] }],
  },
);

export const formatTaskAssigned = axSurface(
  "Assign confirmation.",
  (taskNumber: number, assignee: string | null): string => {
  return (assignee
    ? `#${taskNumber} assigned to ${assignee}.`
    : `#${taskNumber} unassigned — now open.`);
},
  {
    examples: [{ title: "assigned", args: [42, "Alice"] }, { title: "unassigned", args: [42, null] }],
  },
);

export const formatTaskStatusUpdated = axSurface(
  "Status-change confirmation.",
  (taskNumber: number, status: string): string => {
  return (`#${taskNumber} moved to ${status}.`);
},
  {
    examples: [{ args: [42, "in_review"] }],
  },
);

export const formatTaskDeleted = axSurface(
  "Delete confirmation.",
  (taskNumber: number): string => {
  return (`#${taskNumber} deleted.`);
},
  {
    examples: [{ args: [42] }],
  },
);

/**
 * Converted-but-unclaimed is the whole point of this verb, so the receipt says
 * `unassigned` explicitly rather than leaving the assignee field off — a blank
 * would read as "claimed by someone I can't see".
 */
export const formatTaskConverted = axSurface(
  "Message→task conversion receipt.",
  (channel: string, task: CreatedTask): string => {
  const target = `${canonicalTaskTarget(channel)}:${task.messageId.slice(0, 8)}`;
  return ([
    `Converted msg=${task.messageId.slice(0, 8)} to task #${task.taskNumber} [${task.status}] assignee=unassigned "${task.title}"`,
    "",
    `To follow up in the task's thread:`,
    `raft message send --target "${target}"`,
  ].join("\n"));
},
  {
    examples: [{ args: ["#general", { taskNumber: 42, messageId: UUID_A, title: "do the thing", status: "todo", claimedByType: null, claimedById: null, claimedAt: null }] }],
  },
);

interface TaskAmendData {
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

export const formatTaskAmended = axSurface(
  "Amend receipt with revision.",
  (data: TaskAmendData): string => {
  const details = data.task.description === null
    ? "details: <none>"
    : `details:\n${data.task.description.split("\n").map((line) => `  ${line}`).join("\n")}`;
  return ([
    `#${data.task.taskNumber} amended — revision ${data.task.revision}, event seq ${data.event.seq}.`,
    `title: ${data.task.title}`,
    details,
  ].join("\n"));
},
  {
    examples: [{ args: [{ task: { taskNumber: 42, title: "do the thing (amended)", description: "narrowed scope", revision: 3 }, event: { seq: 7 } }] }],
  },
);

interface TaskHistoryData {
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

export const formatTaskHistory = axSurface(
  "Task audit history listing.",
  (data: TaskHistoryData): string => {
  const header = `## Task #${data.task.taskNumber} history — revision ${data.task.revision}\n\n${data.task.title}`;
  if (data.events.length === 0) return (`${header}\n\nNo recorded events.`);
  const events = data.events.map((event) => {
    const actor = event.actorType === "system"
      ? "@system"
      : event.actorName ? `@${event.actorName}` : "<unresolved>";
    return `seq=${event.seq} time=${event.createdAt} actor=${actor} type=${event.eventType}\n  ${JSON.stringify(event.payload)}`;
  }).join("\n");
  return (`${header}\n\n${events}`);
},
  {
    examples: [{ args: [{ task: { taskNumber: 42, title: "do the thing", description: null, revision: 3 }, events: [{ seq: 1, eventType: "created", actorType: "user", actorName: "richard", payload: {}, createdAt: T }, { seq: 2, eventType: "amended", actorType: "agent", actorName: "Alice", payload: { revision: 2 }, createdAt: T }] }] }],
  },
);
