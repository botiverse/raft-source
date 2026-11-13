import { Button, Field, FieldDescription, Textarea } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import { CreateTaskChannelField, CreateTaskStatusField } from "./CreateTaskFields";
import { createFailureMessage, taskFromMessage, useChannelLabel, useCreateTaskChannel, useCreateTaskStatus } from "./createTaskForm";

/**
 * Task v2's New task without a source message: creating a task is sending a
 * message (design "新建任务 = 发一条消息"). The person writes one message in
 * the channel picked under Post in; its first line is the task's title and
 * the rest its description. The server posts it as their own message and
 * creates the task from it (routes/tasks.ts, postCreatorSourceMessage).
 */
export function CreateTaskMessageDialog({
  channelId: fixedChannelId,
  defaultChannelId,
  onClose,
  onCreated,
}: {
  /** The channel the message goes in. Absent (the Tasks page), the dialog asks for one. */
  channelId?: string;
  defaultChannelId: string | null;
  onClose: () => void;
  onCreated?: (tasks: Task[]) => void;
}) {
  const { formatMessage } = useIntl();
  const { channelId, channelOptions, pickedChannelId, handleChannelChange } = useCreateTaskChannel(fixedChannelId, defaultChannelId);
  // A fixed channel shows no picker, so the dialog says under its title where the message goes.
  const fixedChannelLabel = useChannelLabel(fixedChannelId);
  const { status, statusItems, handleStatusChange } = useCreateTaskStatus();
  const createTasks = useTaskStore((s) => s.createTasks);
  const [text, setText] = useState("");
  const draft = useMemo(() => taskFromMessage(text), [text]);
  const [error, setError] = useState("");
  // No channel picked: said under the Channel field, not in the banner.
  const [channelError, setChannelError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // One key per message, so a retry after a failure reuses the message the
  // server already posted instead of posting it again. A key belongs to one
  // text in one channel: changing either takes a new one (the server refuses
  // a reused key with other text, source_random_id_reused).
  const [sourceKey, setSourceKey] = useState(() => ({ text: "", id: globalThis.crypto.randomUUID() }));
  const formRef = useRef<HTMLFormElement>(null);

  const handlePickChannel = useCallback((next: string | null) => {
    handleChannelChange(next);
    if (next) setChannelError("");
  }, [handleChannelChange]);
  const handleTextChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value), []);
  // Enter is a new line (the rest is the description); ⌘/Ctrl+Enter sends.
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    formRef.current?.requestSubmit();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // A second send must not post the message twice.
    if (submitting || !draft) return;
    setError("");
    if (!channelId) {
      setChannelError(formatMessage({ id: "task.create.channelRequired" }));
      return;
    }
    setSubmitting(true);
    const keyText = JSON.stringify([channelId, draft]);
    const key = sourceKey.text === keyText || sourceKey.text === "" ? sourceKey.id : globalThis.crypto.randomUUID();
    setSourceKey({ text: keyText, id: key });
    try {
      let created: Task[];
      try {
        created = await createTasks(channelId, [draft], undefined, status, key);
      } catch (err: unknown) {
        // That key went with other text (a race with an earlier send): once more with a new one.
        if ((err as { response?: { data?: { code?: string } } }).response?.data?.code !== "source_random_id_reused") throw err;
        const fresh = globalThis.crypto.randomUUID();
        setSourceKey({ text: keyText, id: fresh });
        created = await createTasks(channelId, [draft], undefined, status, fresh);
      }
      onCreated?.(created);
      onClose();
    } catch (err: unknown) {
      setError(createFailureMessage(err, formatMessage, true));
    } finally {
      setSubmitting(false);
    }
  };

  const placeholder = formatMessage({ id: "task.create.messagePlaceholder" });
  return (
    <DialogCard
      title={formatMessage({ id: "task.create.heading" }, { count: 1 })}
      description={fixedChannelLabel ? formatMessage({ id: "task.create.postsIn" }, { channel: fixedChannelLabel }) : undefined}
      onClose={onClose}
      narrow="sheet"
    >
      <form ref={formRef} onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3">
        {error ? <Banner intent="warning">{error}</Banner> : null}
        {fixedChannelId ? null : (
          <CreateTaskChannelField
            label={formatMessage({ id: "task.create.postIn" })}
            options={channelOptions}
            value={pickedChannelId}
            onValueChange={handlePickChannel}
            error={channelError}
          />
        )}
        <Field>
          <Textarea
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            rows={4}
            autoFocus
            placeholder={placeholder}
            aria-label={placeholder}
            data-testid="create-task-message"
          />
          <FieldDescription data-testid="create-task-message-hint">
            {formatMessage({ id: "task.create.messageHint" })}
          </FieldDescription>
        </Field>
        <CreateTaskStatusField status={status} items={statusItems} onValueChange={handleStatusChange} />
        <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={onClose}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant="primary" type="submit" disabled={submitting || !draft}>
                {submitting
                  ? formatMessage({ id: "message.composer.sending" })
                  : formatMessage({ id: "task.create.sendAndCreateTask" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}
