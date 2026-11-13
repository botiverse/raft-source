import type { TaskCreateStatus } from "@botiverse/raft-shared";
import {
  Field,
  FieldError,
  FieldLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemLeading,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  TaskStatusIcon,
} from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { CreateTaskChannelOption } from "./createTaskForm";
import { toRuiTaskStatus } from "./taskStatusUi";

/** The channel a create goes in, picked (the Tasks page's New task). `error` goes under the select. */
export function CreateTaskChannelField({
  label,
  options,
  value,
  onValueChange,
  error,
}: {
  label: string;
  options: readonly CreateTaskChannelOption[];
  value: string | null;
  onValueChange: (next: string | null) => void;
  error?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <Field invalid={Boolean(error)}>
      <FieldLabel>{label}</FieldLabel>
      <Select<string> chrome="field" items={options} value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full" data-testid="create-task-channel">
          <SelectValue placeholder={formatMessage({ id: "task.create.channelPlaceholder" })} />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} data-testid={`create-task-channel-${option.value}`}>
                <SelectItemText>{option.label}</SelectItemText>
                <SelectItemIndicator />
              </SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
      {error ? <FieldError match role="alert" data-testid="create-task-channel-error">{error}</FieldError> : null}
    </Field>
  );
}

/** Task v2: the status a new task starts in. `description` goes under the select. */
export function CreateTaskStatusField({
  status,
  items,
  onValueChange,
  description,
}: {
  status: TaskCreateStatus;
  items: readonly { value: TaskCreateStatus; label: string }[];
  onValueChange: (next: TaskCreateStatus | null) => void;
  description?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return (
    <Field>
      <FieldLabel>{formatMessage({ id: "task.properties.status" })}</FieldLabel>
      <Select<TaskCreateStatus> chrome="field" items={items} value={status} onValueChange={onValueChange}>
        <SelectTrigger className="w-full" data-testid="create-task-status">
          <span className="flex min-w-0 items-center gap-2">
            <TaskStatusIcon status={toRuiTaskStatus(status)} className="shrink-0" />
            <SelectValue />
          </span>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} data-testid={`create-task-status-${item.value}`}>
                <SelectItemLeading>
                  <TaskStatusIcon status={toRuiTaskStatus(item.value)} />
                </SelectItemLeading>
                <SelectItemText>{item.label}</SelectItemText>
                <SelectItemIndicator />
              </SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
      {description}
    </Field>
  );
}
