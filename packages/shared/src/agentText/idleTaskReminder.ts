// Idle task reminder (#wg-task-v2:#9): the notice an agent is given when it
// goes idle and tasks are waiting on it: assigned to it, or with no assignee
// when it created them. The Server decides what to list and builds the text
// (POST /internal/agent-api/tasks/idle-nudge,
// services/idleTaskReminderService.ts); a Computer delivers it as it is. The
// wording is an AX contract: each line says why the task is listed, and the
// rules say what to do with it.

import { foldAgentOneLineText } from "../agentMessageText";
import { formatHint, RAFT_HINTS } from "../agentOps/hint";

/**
 * Why a task is listed: `new_session` (the first reminder of a new session
 * lists every open task once), `newly_assigned` (someone else assigned it to
 * the agent after its last action on it), `others_acted` (someone else changed
 * its status, assignee or card, or wrote in its conversation, after the
 * agent's last action), `stale` (the agent has not acted on it for a while). A closed set:
 * Computers parse it, so a new kind of line is a new `why`, not a new reason
 * (a task with no assignee, chased with its creator, is `why.noAssignee` on
 * `stale`).
 */
export const IDLE_TASK_REMINDER_ITEM_REASONS = ["new_session", "newly_assigned", "others_acted", "stale"] as const;
export type IdleTaskReminderItemReason = (typeof IDLE_TASK_REMINDER_ITEM_REASONS)[number];

/**
 * Why nothing is sent: `disabled` (the server's `task_v2_conversations_v0` flag
 * is off), `no_open_tasks` (nothing open is assigned to the agent, and no task
 * it created with no assignee has waited past its threshold),
 * `no_change` (open tasks, none with news since the last reminder),
 * `hourly_cap` (the agent was already reminded the most times an hour allows;
 * nothing is recorded, so the next idle after the hour computes again).
 */
export const IDLE_TASK_REMINDER_SKIP_REASONS = ["disabled", "no_open_tasks", "no_change", "hourly_cap"] as const;
export type IdleTaskReminderSkipReason = (typeof IDLE_TASK_REMINDER_SKIP_REASONS)[number];

/** What someone else last did on a task: a status, assignee or card change, or a message in its conversation. */
export type IdleTaskReminderOthersActionKind = "status" | "assignee" | "amend" | "message";

/** The facts one line's "why" is written from. */
export interface IdleTaskReminderWhy {
  reason: IdleTaskReminderItemReason;
  /** The handle (without `@`) of whoever assigned it / acted last, when known. */
  actorHandle?: string | null;
  /** `others_acted`: what they did. */
  othersAction?: IdleTaskReminderOthersActionKind | null;
  /** `stale`: how long the agent has not acted on it. */
  untouchedMs?: number | null;
  /** `stale`: the task has no assignee and this agent created it. */
  noAssignee?: boolean | null;
}

/** `35m`, `2h`, `3d`: a coarse duration (floor), for "untouched for …". */
export function formatIdleTaskReminderDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The "why" of one listed task: `newly yours (assigned by @stdrc)`, `@tenny
 * replied`, `untouched for 2h`, `new session`, `no assignee, you created it
 * (untouched for 8h)`.
 */
export function formatIdleTaskReminderWhy(why: IdleTaskReminderWhy): string {
  if (why.noAssignee) return `no assignee, you created it (${formatIdleTaskReminderWhy({ ...why, noAssignee: false })})`;
  const actor = why.actorHandle ? `@${why.actorHandle}` : null;
  switch (why.reason) {
    case "new_session":
      return "new session";
    case "newly_assigned":
      return actor ? `newly yours (assigned by ${actor})` : "newly yours";
    case "others_acted": {
      const who = actor ?? "someone";
      switch (why.othersAction) {
        case "message": return `${who} replied`;
        case "status": return `${who} changed its status`;
        case "assignee": return `${who} changed its assignee`;
        case "amend": return `${who} edited it`;
        default: return `${who} acted on it`;
      }
    }
    case "stale":
      return typeof why.untouchedMs === "number" && why.untouchedMs > 0
        ? `untouched for ${formatIdleTaskReminderDuration(why.untouchedMs)}`
        : "untouched";
  }
}

export interface IdleTaskReminderNoticeItem {
  /** `#channel:#7` / `dm:@peer:#7`. */
  ref: string;
  status: string;
  title: string;
  /** {@link formatIdleTaskReminderWhy}. */
  why: string;
  /** It has no assignee and this agent created it: it gets the exits for such a task, not the rules for held ones. */
  noAssignee?: boolean;
}

export interface IdleTaskReminderNoticeBacklogItem {
  ref: string;
  title: string;
}

export interface IdleTaskReminderNoticeInput {
  items: readonly IdleTaskReminderNoticeItem[];
  /** Tasks with no assignee past the limit of one notice: how many, and their boards (`#channel` / `dm:@peer`). */
  moreNoAssignee?: { count: number; boards: readonly string[] };
  /** Parked tasks (status `backlog`), listed compactly at the end; never a reason to send. */
  backlog?: readonly IdleTaskReminderNoticeBacklogItem[];
  /** Background tasks the runtime reports running (Claude Code); 0 or absent: no line. */
  backgroundTasks?: number;
  /** The server has the `backlog` status: the rules say how to park a task. */
  backlogActive?: boolean;
  /**
   * The rules for held tasks ("For each task: …"); default true. False when
   * the agent's Computer says this model context already got them in an
   * earlier notice (agentApiTaskIdleNudgeBodySchema `rulesShown`, #wg-ax:#32).
   * The block for tasks with no assignee is kept either way: it is rarer and
   * a context may never have had it.
   */
  rules?: boolean;
}

/** The notice carries the rules for held tasks: a held task is listed and `rules` is not false. */
export function idleTaskReminderNoticeHasRules(input: IdleTaskReminderNoticeInput): boolean {
  return input.rules !== false && input.items.some((item) => !item.noAssignee);
}

/** One listed task: `#ch:#9 [in_progress] Title — untouched for 2h`. */
export function formatIdleTaskReminderLine(item: IdleTaskReminderNoticeItem): string {
  return `${item.ref} [${item.status}] ${foldAgentOneLineText(item.title)} — ${item.why}`;
}

/**
 * The notice a Computer delivers when the agent goes idle:
 *
 *   [Raft task notice: 2 tasks are waiting on you.
 *   #wg-task-v2:#9 [in_progress] Idle nudge — untouched for 2h
 *   #proj:#4 [todo] Rollout checklist — newly yours (assigned by @stdrc)
 *   You have 2 background tasks running; a task they are moving forward needs nothing now.
 *   For each task:
 *   - A todo you can work on now: start it.
 *   - …
 *   No change → no reply needed.]
 *
 * With a task that has no assignee (`#proj:#7 [todo] Split-off work — no
 * assignee, you created it (untouched for 8h)`), a block of its exits comes
 * first and the rules above apply to "each other task"; without a held task
 * they are left out, since they speak to whoever holds the task. With
 * `rules: false` the rules for held tasks are left out: the context has them.
 */
export function formatIdleTaskReminderNotice(input: IdleTaskReminderNoticeInput): string {
  const count = input.items.length;
  const lines: string[] = [
    `[Raft task notice: ${count} ${count === 1 ? "task is" : "tasks are"} waiting on you.`,
    ...input.items.map(formatIdleTaskReminderLine),
  ];
  if (input.moreNoAssignee) {
    const { count, boards } = input.moreNoAssignee;
    lines.push(`…and ${count} more with no assignee that you created, in later notices. To see them now: ${formatHint(RAFT_HINTS.taskListName())} (${boards.join(", ")}).`);
  }
  const backlog = input.backlog ?? [];
  if (backlog.length > 0) {
    lines.push("Parked (backlog): optional. Pick one up if it can be done now and is worth doing:");
    for (const item of backlog) lines.push(`${item.ref} ${foldAgentOneLineText(item.title)}`);
  }
  const background = input.backgroundTasks ?? 0;
  if (background > 0) {
    lines.push(`You have ${background} background ${background === 1 ? "task" : "tasks"} running; a task they are moving forward needs nothing now.`);
  }
  // Every reminder has an exit (tygg, #wg-task-v2:4804a9c2).
  const backlogRule = input.backlogActive
    ? ["- Not now: set it to backlog and say in its conversation what would bring it back."]
    : [];
  const hasNoAssignee = input.items.some((item) => item.noAssignee);
  if (hasNoAssignee) {
    lines.push(
      "For a task with no assignee that you created, nobody is on it until you do one of these:",
      `- Yours to do: claim it (${formatHint(RAFT_HINTS.taskClaimName())}).`,
      `- For someone else: assign it to them with why as the reason (${formatHint(RAFT_HINTS.taskHandoff())}); they see it in their notification, so no separate message.`,
      `- Won't be done: set it closed (${formatHint(RAFT_HINTS.taskUpdateName())}) and say why in its conversation.`,
      ...backlogRule,
    );
  }
  if (idleTaskReminderNoticeHasRules(input)) {
    lines.push(
      hasNoAssignee ? "For each other task:" : "For each task:",
      `- A todo you can work on now: start it (set it in_progress with ${formatHint(RAFT_HINTS.taskUpdateName())}).`,
      "- In progress and still yours to do: continue it.",
      `- Waiting on someone (a decision, their input, another task): assign it to them with what you need as the reason (${formatHint(RAFT_HINTS.taskHandoff())}); they see it in their notification and in the task, so no separate message.`,
      "- Better done by someone else: assign it to them with why as the reason.",
      "- Finished: set it done and send the result to whoever asked.",
      "- Won't be done: set it closed and say why in its conversation.",
      ...backlogRule,
    );
  }
  lines.push("No change → no reply needed.]");
  return lines.join("\n");
}
