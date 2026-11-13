import { TASK_BACKLOG_REASON_MAX_LENGTH } from "@botiverse/raft-shared";
import { Button, Field, FieldError, Input, Popover, PopoverContent } from "@botiverse/raft-ui";
import type { PopoverContentProps } from "@botiverse/raft-ui";
import { PopoverActions, PopoverBody } from "@botiverse/raft-ui/wip";
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, SyntheticEvent } from "react";
import { useIntl } from "react-intl";

import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import { dismissLayerProps } from "../ui/dismissLayer";

// The panel is portaled, but React events still bubble to where it is rendered:
// a press or a key in the field must not reach a board card around the chip
// (dragging across the text would lift the card). Escape goes on, for the
// popover's own document listener.
function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}
function stopPropagationUnlessEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation();
}

/**
 * Asked when a task is moved into Backlog from another status, by any route:
 * what would bring it back (raft-design patterns/tasks.md, Moving a task to
 * Backlog). The reason is optional. Cancel, Esc or a press outside leave the task
 * where it was; only Move to Backlog writes.
 */
export function TaskBacklogReasonPopover({ open, task, anchor, finalFocus, onClose }: {
  open: boolean;
  task: Pick<Task, "id" | "channelId" | "taskNumber" | "status">;
  /** What the person used: the status chip, the Status property or the column heading. */
  anchor: PopoverContentProps["anchor"];
  finalFocus: PopoverContentProps["finalFocus"];
  onClose: (moved: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const inputRef = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const close = useCallback((moved: boolean) => {
    setReason("");
    setFailed(false);
    onClose(moved);
  }, [onClose]);
  const handleOpenChange = useCallback((next: boolean) => {
    // The write is on its way: closing now would say the task stayed.
    if (!next && !busy) close(false);
  }, [busy, close]);
  const handleCancel = useCallback(() => {
    // The write is on its way, as in handleOpenChange. Not disabled: a keyboard
    // user's focus stays in the popover, and a refused move shows its error here.
    if (!busy) close(false);
  }, [busy, close]);
  const handleReasonChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value), []);
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await updateTaskStatus(task.channelId, task.id, "backlog", reason);
      close(true);
    } catch (err) {
      console.error("Failed to move task to Backlog:", err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Someone else may park the task meanwhile: then there is nothing left to ask.
    <Popover open={open && (busy || task.status !== "backlog")} onOpenChange={handleOpenChange}>
      <PopoverContent
        anchor={anchor}
        finalFocus={finalFocus}
        initialFocus={inputRef}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        // A column heading can be scrolled out of view at the drop.
        sticky
        className="w-[300px] max-w-(--available-width)"
        aria-label={formatMessage({ id: "task.backlogReason.label" }, { taskNumber: task.taskNumber })}
        data-testid="task-backlog-reason"
        onPointerDown={stopPropagation}
        onMouseDown={stopPropagation}
        onTouchStart={stopPropagation}
        onClick={stopPropagation}
        onKeyDown={stopPropagationUnlessEscape}
        {...dismissLayerProps}
      >
        <form onSubmit={handleSubmit}>
          <PopoverBody>
            <Field invalid={failed}>
              <Input
                ref={inputRef}
                type="text"
                value={reason}
                onChange={handleReasonChange}
                maxLength={TASK_BACKLOG_REASON_MAX_LENGTH}
                aria-label={formatMessage({ id: "task.backlogReason.inputLabel" })}
                placeholder={formatMessage({ id: "task.backlogReason.placeholder" })}
                data-testid="task-backlog-reason-input"
              />
              {failed ? <FieldError match>{formatMessage({ id: "task.backlogReason.failed" })}</FieldError> : null}
            </Field>
          </PopoverBody>
          {/* A popover is a small step: ghost and outline, not the pink button. */}
          <PopoverActions>
            <Button type="button" size="md" variant="ghost" onClick={handleCancel} data-testid="task-backlog-reason-cancel">
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <Button type="submit" size="md" variant="outline" loading={busy} data-testid="task-backlog-reason-confirm">
              {formatMessage({ id: "task.backlogReason.confirm" })}
            </Button>
          </PopoverActions>
        </form>
      </PopoverContent>
    </Popover>
  );
}
