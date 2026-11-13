import { TASK_ASSIGN_REASON_MAX_LENGTH } from "@botiverse/raft-shared";
import { Button, Field, FieldError, FieldLabel, Textarea, toast } from "@botiverse/raft-ui";
import { PopoverActions, PopoverBody } from "@botiverse/raft-ui/wip";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";

/**
 * The step after choosing someone other than yourself in a task's assignee
 * picker: what the task waits on them for (optional), then Hand to {name}.
 * The reason goes with the assignment (PATCH /tasks/:id/assignee `reason`):
 * it ends the line in the task's conversation, shows as the hand-off card and
 * reaches them in their notification, so no separate message is needed.
 * Enter hands it over; Esc or Cancel goes back to the list without writing.
 */
export function TaskHandoffReasonPanel({ name, onSubmit, onCancel }: {
  /** The chosen assignee as the list names them. */
  name: string;
  /** Makes the write; rejects when it fails (the panel stays, with an error). */
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The picker's search box had focus: the reason is what to type next.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // The picker can close while the write is on its way (a press outside):
  // a failure then has no panel to show in, so it is a toast.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit(reason);
    } catch (err) {
      console.error("Failed to hand the task over:", err);
      if (!mounted.current) {
        toast.error(formatMessage({ id: "task.handoffReason.failed" }));
        return;
      }
      setFailed(true);
      setBusy(false);
    }
  }, [busy, formatMessage, onSubmit, reason]);

  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void submit();
  }, [submit]);

  const handleCancel = useCallback(() => {
    // The write is on its way: going back now would say nothing changed.
    if (!busy) onCancel();
  }, [busy, onCancel]);

  // Esc goes back to the list from the field or either button.
  const handleEscape = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return false;
    event.preventDefault();
    event.stopPropagation();
    handleCancel();
    return true;
  }, [handleCancel]);
  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleEscape(event)) return;
    // One line: Enter hands it over (an IME composing a word keeps its Enter).
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }, [handleEscape, submit]);
  const handleButtonKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    handleEscape(event);
  }, [handleEscape]);

  const handleReasonChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value), []);

  return (
    <form onSubmit={handleSubmit} data-testid="task-handoff-reason-panel">
      <PopoverBody>
        <Field invalid={failed}>
          <FieldLabel htmlFor={inputId}>
            {formatMessage({ id: "task.handoffReason.inputLabel" }, { name })}
          </FieldLabel>
          <Textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            value={reason}
            onChange={handleReasonChange}
            onKeyDown={handleInputKeyDown}
            maxLength={TASK_ASSIGN_REASON_MAX_LENGTH}
            data-testid="task-handoff-reason-input"
          />
          {failed ? <FieldError match>{formatMessage({ id: "task.handoffReason.failed" })}</FieldError> : null}
        </Field>
      </PopoverBody>
      {/* A popover is a small step: ghost and outline, as the backlog reason. */}
      <PopoverActions>
        <Button type="button" size="md" variant="ghost" onClick={handleCancel} onKeyDown={handleButtonKeyDown} data-testid="task-handoff-reason-cancel">
          {formatMessage({ id: "common.confirm.cancel" })}
        </Button>
        <Button type="submit" size="md" variant="outline" loading={busy} onKeyDown={handleButtonKeyDown} data-testid="task-handoff-reason-confirm">
          {formatMessage({ id: "task.handoffReason.confirm" }, { name })}
        </Button>
      </PopoverActions>
    </form>
  );
}
