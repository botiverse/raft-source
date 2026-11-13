import type { ReactNode } from "react";
import {
  TaskChip,
  TaskStatusIcon,
} from "@botiverse/raft-ui";

import { toRuiTaskStatus } from "../task/taskStatusUi";

import type { Task } from "../../store/taskStore";
import { useTaskRefTask } from "../task/useTaskRefTask";
import { taskNumberSigil } from "./messageMarkdownRefs";

/**
 * A task named in running text: the task chip in the task's status colours
 * (its status pixel and soft tint), the same chip the message footer and the
 * Tasks card use, so a ref reads "which task, and where it stands".
 */
export type OpenTaskRef = (taskNumber: number, channelId?: string) => void;

export function TaskRefBadge({ task, label, channelId, onOpenTaskRef }: {
  task: Task;
  label?: string;
  /** The channel the ref resolved in (a joint projection's local id). */
  channelId: string;
  onOpenTaskRef?: OpenTaskRef;
}) {
  return (
    <TaskChip
      variant="inline"
      status={toRuiTaskStatus(task.status)}
      data-status={task.status}
      data-testid="message-task-ref-badge"
      render={
        <a
          href="#"
          data-message-affordance="open-linked-task"
          onClick={(e) => {
            e.preventDefault();
            onOpenTaskRef?.(task.taskNumber, channelId);
          }}
        >
          <TaskStatusIcon status={toRuiTaskStatus(task.status)} />
          <span className="shrink-0">{label ?? taskNumberSigil(task.taskNumber)}</span>
        </a>
      }
    />
  );
}

/**
 * A ref to a task this page has not loaded (another channel's task). Its
 * status is fetched once (`useTaskRefTask`); until it lands the ref is an
 * outlined chip with no tint and no status pixel, so it never reads as a
 * status — a grey fill would read as Closed. A task the reader cannot reach
 * (deleted, or a channel they cannot read) stays plain text.
 */
export function ResolvingTaskRef({ channelId, taskNumber, label, onOpenTaskRef, children }: {
  channelId: string;
  taskNumber: number;
  label?: string;
  onOpenTaskRef: OpenTaskRef;
  children: ReactNode;
}) {
  const lookup = useTaskRefTask(channelId, taskNumber);
  if (lookup.state === "ready") {
    return <TaskRefBadge task={lookup.task} label={label} channelId={channelId} onOpenTaskRef={onOpenTaskRef} />;
  }
  if (lookup.state === "missing") return <span>{children}</span>;
  return (
    <a
      href="#"
      data-message-affordance="open-linked-task"
      data-testid="message-task-ref-resolving"
      aria-busy="true"
      className="inline-flex items-baseline rounded-sticker border border-line-hairline px-1.5 align-baseline font-semibold whitespace-nowrap text-foreground-muted no-underline [font-size:inherit] leading-[1.2em] hover:overlay-medium active:overlay-medium"
      onClick={(e) => {
        e.preventDefault();
        onOpenTaskRef(taskNumber, channelId);
      }}>
      {children}
    </a>
  );
}
