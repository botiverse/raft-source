import { Ban, CheckCircle, Circle, Eye, Play } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import type { BadgeProps } from "raft-ui";
import type { MessageId } from "../../i18n/messages";
import type { ServerRole } from "@botiverse/raft-shared";
import type { Task, TaskStatus } from "../../store/taskStore";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
type BadgeAppearance = NonNullable<BadgeProps["appearance"]>;

// Source content stays Title Case — status pills sit next to case-sensitive
// identifiers (e.g. `task #N @assignee`) and uppercasing breaks identity.
// stdrc msg=ce25da45 + msg=65681d15 (option B): drop forced uppercase from
// status indicators specifically; label-only Badge instances elsewhere
// keep the brutal contract. Future non-brutal themes render this content
// natural-cased without a transform.
export interface TaskStatusUi {
  /**
   * The status vocabulary is the app's canonical one — it is rendered by every
   * task surface AND by the message-side badge. It holds a MessageId, never a
   * sentence: this module used to return finished English ("Todo", "In
   * Progress", …), so every consuming .tsx scanned clean while the screen
   * showed English, and the hardcoded-English scanner reports 0 findings here
   * because it only walks .tsx (task #54). Holding ids is what makes that
   * class impossible rather than merely absent.
   */
  labelId: MessageId;
  /**
   * Canonical status background. StatusBadge applies this after the raft-ui
   * semantic variant so every task surface keeps the same product color;
   * direct-style callsites such as InlineBadgeEditor consume it as well.
   */
  bg: string;
  variant: BadgeVariant;
  appearance: BadgeAppearance;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const TASK_STATUS_UI: Record<TaskStatus, TaskStatusUi> = {
  todo: {
    labelId: "task.status.todo",
    bg: "bg-brutal-orange",
    variant: "warning",
    appearance: "solid",
    icon: Circle,
  },
  in_progress: {
    labelId: "task.status.inProgress",
    bg: "bg-brutal-cyan",
    variant: "information",
    appearance: "solid",
    icon: Play,
  },
  in_review: {
    labelId: "task.status.inReview",
    bg: "bg-brutal-lavender",
    variant: "accent",
    appearance: "solid",
    icon: Eye,
  },
  done: {
    labelId: "task.status.done",
    bg: "bg-brutal-lime",
    variant: "success",
    appearance: "solid",
    icon: CheckCircle,
  },
  // Closed = won't-do (cancelled / abandoned). Uses `brutal-stone`, the
  // warm neutral terminal-state token — semantically "exited / no longer
  // active", not "destructive". The earlier `brutal-red` was a category
  // collision: red is reserved for destructive irreversible actions
  // (Delete buttons, ConfirmDialog destructive confirm), but `closed`
  // is reversible (`closed → todo` is a valid transition below) and
  // operating it on a task isn't dangerous. Joy designed `brutal-stone`
  // for this semantic slot — see `--color-brutal-stone` in index.css.
  // #proj-uiux task #145 (daily UI audit Finding 1, stdrc-approved
  // 2026-05-08, Joy spec'd, Bugen implemented).
  closed: {
    labelId: "task.status.closed",
    bg: "bg-brutal-stone",
    variant: "muted",
    appearance: "solid",
    icon: Ban,
  },
};

/**
 * Back-compat alias for task list/card callsites that still apply the bg
 * utility directly. Keep it as a typed view over TASK_STATUS_UI, not a second
 * source of truth.
 */
export const STATUS_STYLES: Record<TaskStatus, { bg: string; labelId: MessageId }> = TASK_STATUS_UI;

/**
 * Shared per-status badge config for the message-side task badge in MessageItem.
 * Both the header (inline) and below-content (thread-root) variants render off
 * TASK_STATUS_UI so adding a new status — or recoloring an existing one — only
 * requires one edit.
 *
 * eric 2026-05-08 #proj-uiux:c697be7a (task #141) — before this map was
 * extracted, the below-content variant had its own inline 4-entry config
 * (todo / in_progress / in_review / done) that silently fell back to
 * `statusConfig.todo` for `closed`. That fallback made a closed task in the
 * thread panel header render with the orange/Circle TODO styling even
 * though `data-task-status="closed"` updated correctly — the perceived
 * "thread badge didn't update" repro from the original task #141 report.
 *
 * `closed` uses `bg-brutal-stone` (NOT `bg-brutal-red`) per #proj-uiux task
 * #145 / PR #1464. See TASK_STATUS_UI.closed for the full rationale.
 */
export type StatusBadgeConfig = Pick<TaskStatusUi, "appearance" | "bg" | "icon" | "variant">;
export const STATUS_BADGE_CONFIG: Record<TaskStatus, StatusBadgeConfig> = TASK_STATUS_UI;

/**
 * Resolve the canonical status background to an inline color.
 *
 * raft-ui Badge variants also contribute a semantic background utility
 * (`warning` → `bg-warning-base`, for example). Depending on the compiled CSS
 * order, that utility can win over `cfg.bg` even though both Activity and Chat
 * read TASK_STATUS_UI. Applying the same canonical token as an inline style
 * makes TASK_STATUS_UI the final pixel authority as well as the TypeScript
 * authority.
 */
export function getTaskStatusBackgroundStyle(status: TaskStatus): CSSProperties {
  const cfg = TASK_STATUS_UI[status] ?? TASK_STATUS_UI.todo;
  const token = cfg.bg.startsWith("bg-") ? cfg.bg.slice(3) : "";
  return token ? { backgroundColor: `var(--color-${token})` } : {};
}

// Mirror of taskService.VALID_TRANSITIONS — kept in sync so the menu only
// surfaces server-allowed transitions.
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo", "in_progress"],
};

/**
 * Status is a member-level action: any member who can see the task may move it.
 *
 * This mirrors the server, where the `only the assignee can update status` rule
 * (and its `in_review -> done` carve-out, which existed only to punch a hole in
 * that rule) was removed. Leaving the old check here would have been worse than
 * a dead branch -- the server would accept the write while the browser refused
 * to offer it, so the rule would look intact to every human and only agents on
 * the CLI would get the new behavior.
 *
 * `canManageServer` is kept: admins additionally bypass transition validity.
 */
export function canEditTaskStatus(
  _task: Task,
  _currentUserId: string | undefined,
  _canManageServer: boolean,
  serverRole?: ServerRole | null,
): boolean {
  return serverRole !== "guest";
}

export function getTaskStatusOptions(task: Task, _currentUserId: string | undefined, canManageServer: boolean) {
  const current = task.status;

  // Members get the legal transitions from where the task is now; admins keep
  // their existing ability to force any status regardless of transition rules.
  const allowed: TaskStatus[] = canManageServer
    ? ["todo", "in_progress", "in_review", "done", "closed"]
    : [current, ...VALID_TRANSITIONS[current]];

  return allowed.map((status) => ({
    id: status,
    labelId: current === "closed" && status === "todo"
      ? ("task.status.reopenToTodo" satisfies MessageId)
      : TASK_STATUS_UI[status].labelId,
  }));
}
