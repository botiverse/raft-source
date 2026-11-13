import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@botiverse/raft-ui";

import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import type { Task } from "../../store/taskStore";
import { useTaskStore } from "../../store/taskStore";
import { TaskDeleteConfirmDialog } from "./TaskDeleteConfirmDialog";

/**
 * Who may delete a task, as the server's DELETE /tasks/:id decides it: the
 * person who created it, or someone holding deleteAnyTask (admins, owners).
 * A historical joint task is read-only from a participant workspace.
 */
export function useCanDeleteTask(task: Task): boolean {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  if (task.readOnlyReason) return false;
  const isCreator = task.createdByType === "user" && currentUserId !== null && task.createdById === currentUserId;
  return isCreator || capabilities.deleteAnyTask;
}

/**
 * The task dialog's Delete task (#wg-task-v2:#21): the last item of its ⋯ menu,
 * asking before it deletes (TaskDeleteConfirmDialog, as the Tasks page's batch
 * Delete does). Once the task is gone the dialog closes (`onDeleted`). Nothing
 * for someone who may not delete it; the server is still the authority: a
 * refusal (403) is said in the confirmation, in the server's words.
 */
export function useTaskDeleteMenu(task: Task, onDeleted: () => void) {
  const { formatMessage } = useIntl();
  const canDelete = useCanDeleteTask(task);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const [confirming, setConfirming] = useState(false);

  const ask = useCallback(() => setConfirming(true), []);
  const remove = useCallback(async (): Promise<string | null> => {
    try {
      await deleteTask(task.channelId, task.id);
    } catch (err: unknown) {
      return getApiErrorResponse(err)?.error || formatMessage({ id: "task.modal.deleteFailed" });
    }
    setConfirming(false);
    onDeleted();
    return null;
  }, [deleteTask, formatMessage, onDeleted, task.channelId, task.id]);

  const menuItems = canDelete ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={ask} data-testid="task-overflow-delete">
        <Trash2 aria-hidden />
        {formatMessage({ id: "task.action.deleteTask" })}
      </DropdownMenuItem>
    </>
  ) : null;

  const dialog = canDelete ? (
    <TaskDeleteConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      title={formatMessage({ id: "task.delete.confirmTitle" }, { taskNumber: task.taskNumber })}
      count={1}
      confirmLabel={formatMessage({ id: "task.action.deleteTask" })}
      onConfirm={remove}
      testId="task-delete-confirm"
    />
  ) : null;

  return { menuItems, dialog };
}
