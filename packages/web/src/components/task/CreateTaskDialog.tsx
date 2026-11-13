import {
  Button,
  FieldDescription,
} from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Plus } from "lucide-react";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import { TaskTitleRow } from "./TaskTitleRow";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import { CreateTaskChannelField, CreateTaskStatusField } from "./CreateTaskFields";
import { CreateTaskMessageDialog } from "./CreateTaskMessageDialog";
import { createFailureMessage, useCreateTaskChannel, useCreateTaskStatus } from "./createTaskForm";

/** Task v2: "Create Task from Message" — the tasks hang under this message;
 *  the first title starts as its text, which the person can change. */
export interface CreateTaskSourceMessage {
  id: string;
  senderName: string;
  text: string;
}

const SOURCE_TITLE_MAX = 200;

function titleFromMessage(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= SOURCE_TITLE_MAX ? single : `${single.slice(0, SOURCE_TITLE_MAX - 1).trimEnd()}…`;
}

interface CreateTaskDialogProps {
  /** The channel the tasks go in. Absent (the Tasks page), the dialog asks for one. */
  channelId?: string;
  /** Without `channelId`: the channel picked at first (the page's one channel filter). */
  defaultChannelId?: string | null;
  onClose: () => void;
  /** After the tasks were created, before the dialog closes. */
  onCreated?: (tasks: Task[]) => void;
  sourceMessage?: CreateTaskSourceMessage;
}

/**
 * New task. Task v2 without a source message, a task is a message the person
 * sends (CreateTaskMessageDialog); otherwise titles, one task each, from a
 * message (task v2) or on their own (before task v2).
 */
export default function CreateTaskDialog({ channelId, defaultChannelId = null, onClose, onCreated, sourceMessage }: CreateTaskDialogProps) {
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  if (taskV2 && !sourceMessage) {
    return <CreateTaskMessageDialog channelId={channelId} defaultChannelId={defaultChannelId} onClose={onClose} onCreated={onCreated} />;
  }
  return (
    <CreateTaskTitlesDialog
      channelId={channelId}
      defaultChannelId={defaultChannelId}
      onClose={onClose}
      onCreated={onCreated}
      sourceMessage={sourceMessage}
      taskV2={taskV2}
    />
  );
}

function CreateTaskTitlesDialog({
  channelId: fixedChannelId,
  defaultChannelId = null,
  onClose,
  onCreated,
  sourceMessage,
  taskV2,
}: CreateTaskDialogProps & { taskV2: boolean }) {
  const { formatMessage } = useIntl();
  const { channelId, channelOptions, pickedChannelId, handleChannelChange } = useCreateTaskChannel(fixedChannelId, defaultChannelId);
  const [titles, setTitles] = useState<string[]>(() => [sourceMessage ? titleFromMessage(sourceMessage.text) : ""]);
  const [error, setError] = useState("");
  // No channel picked: said under the Channel field, not in the banner.
  const [channelError, setChannelError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const createTasks = useTaskStore((s) => s.createTasks);
  // Task v2 (from a message): a task can start in Backlog, Todo or In
  // progress, and creating in Backlog asks nothing. Off, the dialog stays
  // titles only.
  const { status, statusItems, handleStatusChange } = useCreateTaskStatus();

  const isBatch = titles.length > 1;
  const titleCount = titles.filter((t) => t.trim()).length;

  const updateTitle = useCallback((index: number, value: string) => {
    setTitles((prev) => prev.map((t, i) => (i === index ? value : t)));
  }, []);

  const addRow = useCallback(() => {
    setTitles((prev) => [...prev, ""]);
  }, []);

  const handlePickChannel = useCallback((next: string | null) => {
    handleChannelChange(next);
    if (next) setChannelError("");
  }, [handleChannelChange]);

  const removeRow = useCallback((index: number) => {
    setTitles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Enter in a title field submits too; a second one must not create the batch twice.
    if (submitting) return;
    setError("");

    const nonEmpty = titles.map((t) => t.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      setError(formatMessage({ id: "task.create.titleRequired" }));
      return;
    }
    if (!channelId) {
      setChannelError(formatMessage({ id: "task.create.channelRequired" }));
      return;
    }

    setSubmitting(true);
    try {
      const created = await createTasks(channelId, nonEmpty, sourceMessage?.id, taskV2 ? status : undefined, undefined);
      onCreated?.(created);
      onClose();
    } catch (err: unknown) {
      setError(createFailureMessage(err, formatMessage));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogCard
      title={sourceMessage
        ? formatMessage({ id: "task.create.fromMessageHeading" }, { count: isBatch ? 2 : 1 })
        : formatMessage({ id: "task.create.heading" }, { count: isBatch ? 2 : 1 })}
      onClose={onClose}
      narrow="sheet"
    >
        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3">
          {sourceMessage && (
            <blockquote className="rounded-control border border-line-hairline bg-layer-card px-3 py-2 text-footnote text-foreground-muted" data-testid="create-task-source-message">
              <span className="font-semibold text-foreground">{sourceMessage.senderName}</span>
              <span className="line-clamp-3">{sourceMessage.text}</span>
            </blockquote>
          )}
          {error && (
            <Banner intent="warning">
              {error}
            </Banner>
          )}

          {fixedChannelId ? null : (
            <CreateTaskChannelField
              label={formatMessage({ id: "task.panel.channelColumn" })}
              options={channelOptions}
              value={pickedChannelId}
              onValueChange={handlePickChannel}
              error={channelError}
            />
          )}

          <div>
            {titles.map((title, i) => (
              <TaskTitleRow
                key={i}
                index={i}
                title={title}
                placeholder={formatMessage({ id: "task.create.titlePlaceholder" }, { n: i + 1 })}
                removable={titles.length > 1}
                onChange={updateTitle}
                onRemove={removeRow}
              />
            ))}
            <Button size="md"
              variant="outline"
              type="button"
              onClick={addRow}
              className="mt-1"
            >
              <Plus size={16} />
              {formatMessage({ id: "task.create.addAnother" })}
            </Button>
          </div>

          {taskV2 && (
            <CreateTaskStatusField
              status={status}
              items={statusItems}
              onValueChange={handleStatusChange}
              description={titleCount > 1 ? (
                <FieldDescription data-testid="create-task-status-applies">
                  {formatMessage({ id: "task.create.statusAppliesToAll" }, { count: titleCount })}
                </FieldDescription>
              ) : null}
            />
          )}

          <DialogCardFooter>
            <Button size="lg"
              variant="ghost"
              type="button"
              onClick={onClose}
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <DialogCommit>
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"}
                  variant="primary"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting
                    ? formatMessage({ id: "task.create.submitting" })
                    : formatMessage(
                      { id: "task.create.submit" },
                      { count: isBatch ? titles.filter((t) => t.trim()).length : 1 },
                    )}
                </Button>
              )}
            </DialogCommit>
          </DialogCardFooter>
        </form>
    </DialogCard>
  );
}
