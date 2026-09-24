import { SegmentedControl, SegmentedControlCount, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import { useIntl } from "react-intl";

import type { MessageId } from "../../i18n/messages";
import type { TaskStatus } from "../../store/taskStore";
import { TASK_STATUS_UI } from "./taskStatusUi";

export type TaskFilterTab = "all" | TaskStatus;

// The five status tabs read their label id from TASK_STATUS_UI rather than
// holding their own copy. This file was a FOURTH duplicate of the status
// vocabulary (@Wug caught it): the group headers and badges localized while the
// filter tabs above them stayed English, and a fourth copy undercuts the point
// of making TASK_STATUS_UI canonical. Only `all` — which is not a TaskStatus —
// carries an id of its own.
const FILTER_TABS: { key: TaskFilterTab; labelId: MessageId }[] = [
  { key: "all", labelId: "task.filter.tabAll" },
  { key: "todo", labelId: TASK_STATUS_UI.todo.labelId },
  { key: "in_progress", labelId: TASK_STATUS_UI.in_progress.labelId },
  { key: "in_review", labelId: TASK_STATUS_UI.in_review.labelId },
  { key: "done", labelId: TASK_STATUS_UI.done.labelId },
  { key: "closed", labelId: TASK_STATUS_UI.closed.labelId },
];

export function getTaskFilterTabs() {
  return FILTER_TABS;
}

export function TaskFilterSegmentedControl({
  value,
  counts,
  onValueChange,
}: {
  value: TaskFilterTab;
  counts: Record<TaskFilterTab, number>;
  onValueChange: (value: TaskFilterTab) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <SegmentedControl
      value={value}
      onValueChange={onValueChange}
      aria-label={formatMessage({ id: "task.filterAria" })}
    >
      {FILTER_TABS.map((tab) => (
        <SegmentedControlItem
          key={tab.key}
          value={tab.key}
          data-testid={`channel-task-filter-${tab.key}`}
        >
          <SegmentedControlLabel>{formatMessage({ id: tab.labelId })}</SegmentedControlLabel>
          {counts[tab.key] > 0 ? (
            <SegmentedControlCount>{counts[tab.key]}</SegmentedControlCount>
          ) : null}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
