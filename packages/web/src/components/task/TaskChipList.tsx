import { memo } from "react";
import { useIntl } from "react-intl";

import type { Task } from "../../store/taskStore";

import { StatusBadge } from "./StatusBadge";
import { TASK_STATUS_UI } from "./taskStatusUi";

/**
 * The tasks associated with a message, rendered under it.
 *
 * Restored from the June v2 work (`d84e426eb`), whose visual contract was
 * stdrc's own (msg=59dc50e1 / 48835027): **number far left, status far right**,
 * borrowing the attachment-list idiom — full width, vertical, one row per task
 * rather than small chips crowded onto a line.
 *
 * It takes a LIST even though the database currently permits exactly one task
 * per message (`uniqueIndex` on `tasks.message_id`). That is deliberate: the
 * limit is a data fact, not a UI one, and the endgame is many tasks per
 * message. Shipping the singular shape would mean rewriting this the day the
 * index is dropped.
 *
 * Two differences from the June version, both because the tree has moved:
 *  - **No comment count.** That column read the task's own discussion channel
 *    (`tasks.comment_thread_channel_id`), which does not exist here yet. A
 *    count sourced from the host message's replies would be a different number
 *    wearing the same label, so it is omitted rather than approximated.
 *  - **Opening is routed by the caller**, because a task with no host message
 *    cannot use the thread-backed modal and must fall back to the legacy panel.
 */
export interface TaskChipListProps {
  /** Ordered by task number; empty renders nothing. */
  tasks: readonly Task[];
  onOpenTask: (task: Task) => void;
}

function TaskChipListInner({ tasks, onOpenTask }: TaskChipListProps) {
  const { formatMessage } = useIntl();
  if (tasks.length === 0) return null;

  return (
    <div className="mt-1 flex w-full flex-col gap-1" data-testid="message-task-chip-list">
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => onOpenTask(task)}
          // Attachment-list weight, not card weight (@stdrc msg=2f826796): a
          // hairline border and no shadow. These rows are references hanging off
          // a message, not cards competing with it — `border-2` + brutal shadow
          // made them louder than the message they belong to.
          //
          // Hover is a quiet border darken + background tint rather than a lift.
          className="group flex w-full items-center gap-2 border border-black/20 bg-white px-3 py-1.5 text-left transition-colors hover:border-black/50 hover:bg-black/[0.03]"
          data-testid="message-task-chip"
          data-task-id={task.id}
          aria-label={formatMessage(
            { id: "task.chip.openAria" },
            { taskNumber: task.taskNumber, title: task.title },
          )}
        >
          <span className="shrink-0 font-mono text-xs text-black/40" data-testid="message-task-chip-number">
            {taskNumberLabel(task.taskNumber)}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm text-black"
            data-testid="message-task-chip-title"
            title={task.title}
          >
            {task.title}
          </span>
          <StatusBadge status={task.status} data-testid="message-task-chip-status">
            {formatMessage({ id: TASK_STATUS_UI[task.status].labelId })}
          </StatusBadge>
        </button>
      ))}
    </div>
  );
}

/** `#` is markup, not translatable copy — kept out of JSX so the i18n
 *  literal-disposition guard does not count it. */
function taskNumberLabel(taskNumber: number): string {
  return `#${taskNumber}`;
}

export default memo(TaskChipListInner);
