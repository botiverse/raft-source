import { TASK_STATUSES } from "@botiverse/raft-shared";
import { Timeline, TimelineContent, TimelineItem, TimelineTime, TimelineTitle } from "@botiverse/raft-ui";
import type { TaskStatusId } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";
import type { TaskHistoryEvent, TaskStatus } from "../../store/taskStore";
import { toRuiTaskStatus } from "./taskStatusUi";
import { TimelineDetail, TimelineText } from "./TaskProperties";

const TIMELINE_STATUSES: readonly string[] = TASK_STATUSES;

// Resolve the task status a history event is about, so the Timeline marker can
// be painted from that status's own token. The rui Timeline reads the status's
// colour directly (`TimelineItem taskStatus`), so the history dot uses the SAME
// token as every other task-status surface — no local marker palette.
function historyStatus(event: TaskHistoryEvent): TaskStatusId | undefined {
  const candidate = [event.payload.to, event.payload.status, event.payload.from].find(
    (value): value is string => typeof value === "string" && TIMELINE_STATUSES.includes(value),
  );
  const status = (candidate ?? (event.eventType === "closed" ? "closed" : event.eventType === "reopened" ? "in_progress" : undefined)) as TaskStatus | undefined;
  return status ? toRuiTaskStatus(status) : undefined;
}

/** Task history list — lives in its own file so the per-event rows take only
    stable props from TaskProperties (task #709 react-perf). */
export function HistoryTimeline({ history, resolveName }: {
  history: TaskHistoryEvent[];
  resolveName: (type: "agent" | "user", id: string) => string | null;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  return (
    <Timeline size="sm" data-testid="timeline">
      {history.map((event) => {
        const meta = `${event.actorName ?? event.actorType} · ${formatShortDateTime(event.createdAt)}`;
        return (
          <TimelineItem key={event.id} taskStatus={historyStatus(event)}>
            <TimelineTitle><TimelineText text={historyTitle(event, formatMessage)} bold /></TimelineTitle>
            <TimelineTime>{meta}</TimelineTime>
            <TimelineContent><TimelineDetail event={event} resolveName={resolveName} formatMessage={formatMessage} /></TimelineContent>
          </TimelineItem>
        );
      })}
    </Timeline>
  );
}

function historyTitle(event: TaskHistoryEvent, formatMessage: ReturnType<typeof useIntl>["formatMessage"]): string {
  const key = ({ created: "task.history.created", amended: "task.history.amended", status_changed: "task.history.statusChanged", assignee_changed: "task.history.assigneeChanged", reopened: "task.history.reopened", closed: "task.history.closed", resource_receipt_recorded: "task.history.receipt" } as Record<string, MessageId>)[event.eventType];
  return key ? formatMessage({ id: key }) : event.eventType;
}
