import { useIntl } from "react-intl";
import { ListTodo } from "lucide-react";
import { Button } from "@botiverse/raft-ui";

import type { Task } from "../../../store/taskStore";
import { formatShortRelativeTime } from "../../../utils/relativeTime";
import { TaskAssignee } from "../TaskAssignee";
import { TaskReplyCount } from "../TaskChipList";
import { taskReplyCount } from "../taskReplyCount";
import { COMPACT_ROW_MONO } from "../compactRow";
import EmptyState from "../../ui/EmptyState";
import { taskActivityAt } from "./tasksPageApi";
import { isStaleTask, STALE_AFTER_MS } from "./tasksPageModel";

/** How long a stale task has gone without an update, in days (its words for a screen reader). */
const STALE_DAYS = Math.round(STALE_AFTER_MS / (24 * 60 * 60 * 1000));

/**
 * When the task was last updated: short and in Space Mono ("12m ago", "12
 * 分钟前"), the full date and time in its tooltip. An open task nobody has
 * updated for three days shows it in the warning ink, with no words on
 * screen; a screen reader hears "no update for 3 days" after the time
 * (raft-design patterns/tasks.md; tasksPageModel.isStaleTask).
 */
export function TaskActivityTime({ task }: { task: Task }) {
  const intl = useIntl();
  const at = taskActivityAt(task);
  const short = formatShortRelativeTime(at, intl.locale);
  if (!short) return null;
  const full = intl.formatDate(at, { dateStyle: "medium", timeStyle: "short" });
  const stale = isStaleTask(task);
  return (
    <time
      dateTime={at}
      title={full}
      className={stale ? `${COMPACT_ROW_MONO} whitespace-nowrap text-warning-strong` : `${COMPACT_ROW_MONO} whitespace-nowrap`}
      data-stale={stale ? "" : undefined}
      data-testid="tasks-page-activity-time"
    >
      {short}
      {stale ? <span className="sr-only"> {intl.formatMessage({ id: "task.page.staleTime" }, { days: STALE_DAYS })}</span> : null}
    </time>
  );
}

/** The number of messages in the task's discussion (and its unread pixel), after a card's title. */
export function TaskCardReplies({ task }: { task: Task }) {
  return <TaskReplyCount count={taskReplyCount(task)} task={task} />;
}

/** A card's read-only facts after its status: who has it (or Unassigned), and when it was last updated. */
export function TaskCardFacts({ task }: { task: Task }) {
  const { formatMessage } = useIntl();
  const assigned = Boolean(task.claimedById && task.claimedByType);
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="tasks-page-card-facts">
      {assigned ? (
        <TaskAssignee task={task} />
      ) : (
        <span className="truncate text-caption text-foreground-hint">{formatMessage({ id: "task.filter.unassigned" })}</span>
      )}
      <TaskActivityTime task={task} />
    </span>
  );
}

/**
 * The page's totals could not be read, after the store's retries: said so in
 * place of the groups or the board, with Try again (not an endless skeleton).
 */
export function CountsFailed({ onRetry, testId }: { onRetry: () => void; testId: string }) {
  const { formatMessage } = useIntl();
  return (
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center"
      icon={<ListTodo size={36} />}
      titleHeading="h2"
      title={formatMessage({ id: "task.page.loadFailed" })}
      action={(
        <Button type="button" size="md" variant="outline" onClick={onRetry} data-testid={`${testId}-retry`}>
          {formatMessage({ id: "task.page.retry" })}
        </Button>
      )}
      data-testid={testId}
    />
  );
}
