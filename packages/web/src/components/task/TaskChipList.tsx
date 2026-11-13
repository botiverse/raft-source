import { memo, useCallback, useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { MessageMultiSelectCheckbox } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";

import type { Task } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";

import { StatusBadge } from "./StatusBadge";
import { TaskAssignee } from "./TaskAssignee";
import { TASK_STATUS_UI } from "./taskStatusUi";
import { formatTaskConversationRef } from "../../utils/taskConversation";
import { hasOwnConversation } from "./taskReplyCount";
import {
  COMPACT_LIST_BLEED,
  COMPACT_LIST_BOXED,
  COMPACT_LIST_PAGE,
  COMPACT_ROW_BUTTON,
  COMPACT_ROW_MONO,
  COMPACT_ROW_SELECT_GUTTER,
  COMPACT_ROW_SELECTABLE,
  COMPACT_ROW_SELECTABLE_BUTTON,
  COMPACT_ROW_TITLE,
  COMPACT_ROW_TITLE_GROUP_WRAP,
  COMPACT_ROW_TITLE_WRAP,
  COMPACT_ROW_TITLE_GROUP,
  COMPACT_ROW_TRAILING,
} from "./compactRow";

/**
 * The tasks created from a message, rendered under it (task v2): one row per
 * task — the number, the title on one line with its reply count right after
 * it, and the assignee and status grouped at the right (raft-design
 * patterns/tasks.md). A message may be the source of many
 * tasks (`tasks.source_message_id`), so this takes a list.
 *
 * The discussion count is the task's own conversation (channels.type =
 * 'task'). A pre-v2 task without one still has its discussion in its host
 * message's replies, already shown under the message, so it gets no count
 * here. The same rows, in the `plain` variant, make up the channel's Tasks card.
 */
export interface TaskChipListProps {
  /** Ordered by task number; empty renders nothing. */
  tasks: readonly Task[];
  onOpenTask: (task: Task) => void;
  /** The channel Tasks panel groups rows by status, so it hides the badge. */
  showStatus?: boolean;
  /** Replaces the `@handle` text, e.g. with an avatar and a display name. */
  renderAssignee?: (task: Task) => ReactNode;
  /** `boxed` under a message (capped like an attachment); `plain` in the
   *  Tasks card: full width, no outer box, a chevron at the end of each row;
   *  `page` on the Tasks page: a box as wide as the page, no chevron (the
   *  row opens the task beside the list). */
  variant?: "boxed" | "plain" | "page";
  /** Across channels (the Tasks page): the number names its channel,
   *  `#design:#25`; where the list is narrow (under 28rem of the page's own
   *  `@container/tasks`, not the window: a task open beside it narrows it
   *  too) the channel moves into the trailing group and the status keeps
   *  only its pixel (its name stays the accessible name). */
  showChannel?: boolean;
  /** False where every row's assignee is the reader (Assigned to me). */
  showAssignee?: boolean;
  /** Say Unassigned where nobody has the task, instead of leaving the slot out. */
  showUnassigned?: boolean;
  /** The row's last activity, after the status. */
  renderTime?: (task: Task) => ReactNode;
  /** The task open beside the list: its row is marked current. */
  currentTaskId?: string | null;
  /** Rows can be selected (the Tasks page). */
  selection?: TaskRowSelection;
  /** The Tasks page: the title takes the row's remaining width and wraps
   *  (breaking anywhere), so a row never outgrows the list (Raft DS › Table,
   *  stdrc 11-10: no sideways scroll). Elsewhere it stays one line, cut. */
  wrapTitle?: boolean;
  testId?: string;
}

/**
 * Selecting rows (the Tasks page): a check box at each row's start, shown on
 * hover with a mouse and on every row while something is selected. While
 * selecting, a click (a tap) on a row selects instead of opening it; so does
 * ⌘/Ctrl-click (toggle) and Shift-click (a run from the last one picked). By
 * touch, pressing and holding a row starts selecting with it.
 */
export interface TaskRowSelection {
  /** Something is selected: every row shows its box and a click selects. */
  selecting: boolean;
  isSelected: (taskId: string) => boolean;
  /** The row was picked: `range` with Shift (a run from the last pick), else a toggle. */
  onSelect: (task: Task, gesture: { range: boolean }) => void;
}

/** Press and hold (touch): DS States › Long press, as a message's. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

function TaskChipListInner({
  tasks,
  onOpenTask,
  showStatus = true,
  renderAssignee,
  variant = "boxed",
  showChannel = false,
  showAssignee = true,
  showUnassigned = false,
  renderTime,
  currentTaskId = null,
  selection,
  testId = "message-task-chip-list",
  wrapTitle = false,
}: TaskChipListProps) {
  const { formatMessage } = useIntl();
  if (tasks.length === 0) return null;

  const boxed = variant === "boxed";
  const renderContent = (task: Task) => {
    const count = hasOwnConversation(task) ? task.conversationReplyCount ?? 0 : 0;
    // Unassigned: no assignee slot at all. An empty one is still a flex
    // item, and its synthesized baseline pulled the chevron off the row's
    // centre.
    const assigned = Boolean(task.claimedById && task.claimedByType);
    const assignee = !showAssignee || !assigned ? null : renderAssignee ? renderAssignee(task) : <TaskAssignee task={task} />;
    const unassigned = showAssignee && showUnassigned && !assigned;
    const statusLabel = formatMessage({ id: TASK_STATUS_UI[task.status].labelId });
    return (
      <>
        {showChannel ? (
          <span className={COMPACT_ROW_MONO} data-testid="message-task-chip-number">
            <span className="@max-md/tasks:hidden">{formatTaskConversationRef(task)}</span>
            <span className="@min-md/tasks:hidden">{taskNumberLabel(task.taskNumber)}</span>
          </span>
        ) : (
          <span className={COMPACT_ROW_MONO} data-testid="message-task-chip-number">
            {taskNumberLabel(task.taskNumber)}
          </span>
        )}
        {/* The title on one line, cut with an ellipsis; the reply count
            follows it directly — after the visible text, or after the
            ellipsis. The group keeps room for a readable title before the
            right group has to wrap. A pre-v2 task without its own
            conversation still talks in its host message's thread (shown
            under that message), so it gets no count here. */}
        <span className={wrapTitle ? COMPACT_ROW_TITLE_GROUP_WRAP : COMPACT_ROW_TITLE_GROUP} data-testid="message-task-chip-title-group">
          <span className={wrapTitle ? COMPACT_ROW_TITLE_WRAP : COMPACT_ROW_TITLE} data-testid="message-task-chip-title">
            {task.title}
          </span>
          <ReplyCount count={count} task={task} />
        </span>
        {/* With no assignee and no status the group holds only the
            chevron, a mark with no text: no baseline of its own, so it
            is centred like any other mark (`data-row-mark`), not set on
            a baseline it doesn't have. */}
        <span
          className={COMPACT_ROW_TRAILING}
          data-testid="message-task-chip-meta"
          data-row-mark={!assignee && !unassigned && !showStatus && !showChannel && !renderTime ? "" : undefined}
        >
          {showChannel && task.channelName ? (
            <span className={`${COMPACT_ROW_MONO} @min-md/tasks:hidden`} data-testid="message-task-chip-channel">
              {channelLabel(task.channelName)}
            </span>
          ) : null}
          {unassigned ? (
            <span className="truncate text-caption leading-(--text-callout--line-height) text-foreground-hint" data-testid="message-task-chip-unassigned">
              {formatMessage({ id: "task.filter.unassigned" })}
            </span>
          ) : null}
          {assignee ? (
            <span className="flex min-w-0 max-w-48 items-baseline [&_span]:leading-(--text-callout--line-height)" data-testid="message-task-chip-assignee">
              {assignee}
            </span>
          ) : null}
          {showStatus ? (
            <StatusBadge status={task.status} data-testid="message-task-chip-status">
              {showChannel ? <span className="@max-md/tasks:sr-only">{statusLabel}</span> : statusLabel}
            </StatusBadge>
          ) : null}
          {renderTime ? renderTime(task) : null}
          {variant === "plain" ? <ChevronRight aria-hidden className="size-3.5 shrink-0 text-foreground-hint" /> : null}
        </span>
      </>
    );
  };
  const openAria = (task: Task) => formatMessage({ id: "task.chip.openAria" }, { taskNumber: task.taskNumber, title: task.title });

  return (
    <div
      // The compact list of patterns/tasks.md, one row anatomy with the Files
      // card. Under a message: a box as wide as the longest row needs, at
      // least 320px, at most the message column, its lines meeting its
      // border. In the Tasks card: rows edge to edge, lines inset like the
      // content (the list is one section of the card). On the Tasks page: a
      // box as wide as the page, rows that can be selected.
      className={boxed ? `mt-1.5 ${COMPACT_LIST_BOXED}` : variant === "page" ? COMPACT_LIST_PAGE : COMPACT_LIST_BLEED}
      data-testid={testId}
    >
      {tasks.map((task) => {
        const current = currentTaskId === task.id;
        if (selection) {
          return (
            <SelectableTaskRow
              key={task.id}
              task={task}
              current={current}
              selection={selection}
              onOpenTask={onOpenTask}
              ariaLabel={openAria(task)}
            >
              {renderContent(task)}
            </SelectableTaskRow>
          );
        }
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpenTask(task)}
            aria-current={current ? "true" : undefined}
            data-current={current ? "" : undefined}
            // One row: the number, then the title and its reply count, then the
            // assignee and the status as one group at the right. No columns
            // shared across rows. Where the row is too narrow for both, the
            // right group wraps, together, onto a second line (still at the
            // right) instead of squeezing the title.
            className={current ? `${COMPACT_ROW_BUTTON} bg-fill-cell-selected` : COMPACT_ROW_BUTTON}
            data-testid="message-task-chip"
            data-task-id={task.id}
            aria-label={openAria(task)}
          >
            {renderContent(task)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One selectable row (TaskRowSelection): a list cell holding the check box in
 * its gutter and the row button. A click anywhere but the box opens the task,
 * except while selecting, with ⌘/Ctrl or Shift, or at the end of a long
 * press, when it selects.
 */
function SelectableTaskRow({ task, current, selection, onOpenTask, ariaLabel, children }: {
  task: Task;
  current: boolean;
  selection: TaskRowSelection;
  onOpenTask: (task: Task) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const selected = selection.isSelected(task.id);
  const hold = useRef<{ x: number; y: number; timer: number } | null>(null);
  const held = useRef(false);
  const cancelHold = useCallback(() => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  }, []);
  useEffect(() => cancelHold, [cancelHold]);
  const { onSelect, selecting } = selection;

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    held.current = false;
    cancelHold();
    const timer = window.setTimeout(() => {
      hold.current = null;
      held.current = true;
      navigator.vibrate?.(10);
      onSelect(task, { range: false });
    }, LONG_PRESS_MS);
    hold.current = { x: event.clientX, y: event.clientY, timer };
  }, [cancelHold, onSelect, task]);
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = hold.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelHold();
  }, [cancelHold]);
  const onContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    // The long press is the row's: no callout or context menu over it.
    if (held.current || hold.current) event.preventDefault();
  }, []);
  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (held.current) {
      // The click that ends a long press: it already selected.
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if ((event.target as HTMLElement).closest("[data-select-slot]")) return;
    if (selecting || event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(task, { range: event.shiftKey });
    }
  }, [onSelect, selecting, task]);
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    // The gutter around the box opens the task, as the rest of the row does.
    if ((event.target as HTMLElement).closest("[data-select-slot]")) return;
    if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.selectGutter !== undefined) onOpenTask(task);
  }, [onOpenTask, task]);
  const onBoxClick = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    onSelect(task, { range: event.shiftKey });
  }, [onSelect, task]);

  return (
    <div
      className={COMPACT_ROW_SELECTABLE}
      data-selected={selected ? "" : undefined}
      data-current={current && !selected ? "" : undefined}
      data-testid="tasks-page-row"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={onContextMenu}
      onClickCapture={onClickCapture}
      onClick={onClick}
    >
      <span className={COMPACT_ROW_SELECT_GUTTER} data-select-gutter="">
        {/* The box's slot: the box and the hidden checkbox input Base UI puts beside it. A click there is the
            box's alone; the input's own re-dispatched click used to reach the row's capture handler too, which
            toggled the task a second time while selecting, so the box seemed dead (stdrc 11-10). */}
        <span className="flex size-5 items-center justify-center" data-select-slot="">
          <MessageMultiSelectCheckbox
            checked={selected}
            aria-label={formatMessage({ id: "task.page.select.rowAria" }, { taskNumber: task.taskNumber, title: task.title })}
            onClick={onBoxClick}
            data-select-box=""
            data-testid="tasks-page-row-select"
            className={selecting || selected
              ? "mt-0 self-center"
              : "mt-0 self-center opacity-0 transition-opacity pointer-coarse:hidden group-hover/select:opacity-100 focus-visible:opacity-100"}
          />
        </span>
      </span>
      <button
        type="button"
        onClick={() => onOpenTask(task)}
        aria-current={current ? "true" : undefined}
        className={COMPACT_ROW_SELECTABLE_BUTTON}
        data-testid="message-task-chip"
        data-task-id={task.id}
        aria-label={ariaLabel}
      >
        {children}
      </button>
    </div>
  );
}

/** The size of the task's own conversation, in Space Mono, right after the
 *  title. */
function ReplyCount({ count, task }: { count: number; task: Task }) {
  const { formatMessage } = useIntl();
  // Unread only reaches people who follow the task (like a thread): the pink
  // pixel means "new in a task you follow", never "new somewhere you don't".
  // The followed entry is the task's conversation: by its channel id, or (a
  // joint channel's local conversation id differs from the task's canonical
  // one) by the task it belongs to.
  const conversationChannelId = task.conversationChannelId ?? null;
  const taskId = task.id;
  const unread = useThreadStore((s) => s.followedThreads.some((t) => t.unreadCount > 0 && (
    (conversationChannelId !== null && t.threadChannelId === conversationChannelId)
    || (t.conversationKind === "task" && t.taskId === taskId)
  )));
  // No count to show but something unread (the count lags, or only what it
  // leaves out is new): the pixel alone, so the task is still findable.
  if (count <= 0 && !unread) return null;
  const label = count <= 0
    ? formatMessage({ id: "task.chip.unreadOnly" })
    : formatMessage({ id: unread ? "task.chip.replyCountUnread" : "task.chip.replyCount" }, { count });
  // One run of text: the number sits on the title's baseline (the title
  // group aligns its items on the baseline), and the pixel and the icon, marks
  // inside that run, are centred on its x-height (vertical-align: middle).
  return (
    <span
      className="shrink-0 whitespace-nowrap font-mono text-mono-meta text-foreground-hint"
      data-testid="message-task-chip-replies"
      data-unread={unread || undefined}
      aria-label={label}
      title={label}
    >
      {unread ? <span aria-hidden className="mr-1 inline-block size-1.5 bg-attention align-middle" data-testid="message-task-chip-unread" /> : null}
      {count > 0 ? (
        <>
          <ThreadIcon aria-hidden className="mr-1 inline-block size-3 align-middle" />
          {count}
        </>
      ) : null}
    </span>
  );
}

/** `#` is markup, not translatable copy — kept out of JSX so the i18n
 *  literal-disposition guard does not count it. */
function taskNumberLabel(taskNumber: number): string {
  return `#${taskNumber}`;
}

function channelLabel(channelName: string): string {
  return `#${channelName.replace(/^#/, "")}`;
}

export { ReplyCount as TaskReplyCount };

export default memo(TaskChipListInner);
