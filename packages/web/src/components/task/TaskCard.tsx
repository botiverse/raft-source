import { memo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useTaskStore } from "../../store/taskStore";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import InlineBadgeEditor from "../InlineBadgeEditor";
import { useIntl } from "react-intl";
import { StatusBadge } from "./StatusBadge";

import { STATUS_STYLES, canEditTaskStatus, getTaskStatusOptions } from "./taskStatusUi";

// Memoized so a single task update (status change, drag-reorder, socket
// task:* broadcast) re-renders only the changed card, not the whole board.
// `onOpen` takes the task so callsites can pass a *stable* handler instead of
// an inline `() => open(task)` closure that would break this memo for every row
// (#proj-frontend render-perf, same churn class as the channelActivity slice).
function TaskCard({ task, onOpen, onOpenInNewTab, onDragStart, showChannelName = true }: {
  task: Task;
  onOpen: (task: Task) => void;
  onOpenInNewTab?: (task: Task) => void;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
  showChannelName?: boolean;
}) {
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const currentUser = useAuthStore((s) => s.user);
  const { capabilities, role } = useServerPermissions();
  const [editingStatus, setEditingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const canManageServer = capabilities.deleteAnyTask;
  const canEditStatus = canEditTaskStatus(task, currentUser?.id, canManageServer, role);
  const { formatMessage } = useIntl();
  const statusOptions = getTaskStatusOptions(task, currentUser?.id, canManageServer)
    .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) }));
  const style = STATUS_STYLES[task.status];

  const handleStatusSelect = async (id: string) => {
    const nextStatus = id as TaskStatus;
    if (nextStatus === task.status) {
      setEditingStatus(false);
      return;
    }
    setBusy(true);
    try {
      await updateTaskStatus(task.channelId, task.id, nextStatus);
      setEditingStatus(false);
    } catch (err) {
      console.error("Failed to update task status:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      draggable={!!onDragStart}
      onDragStart={(event) => onDragStart?.(event, task)}
      className="w-full border-2 border-black bg-white px-3 py-2.5 text-left shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-brutal active:translate-x-[1px] active:translate-y-[1px] active:shadow-brutal-active"
    >
      <button type="button" onClick={() => onOpen(task)} className="w-full text-left">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              {showChannelName && (
                <span className="text-xs font-bold text-black/60">
                  #{task.channelName || formatMessage({ id: "task.legacyPanel.unknownChannel" })}
                </span>
              )}
              <span className="text-[11px] font-mono text-black/35">#{task.taskNumber}</span>
              {task.isLegacy && (
                <span className="border border-black/30 px-1.5 py-0.5 text-[10px] font-bold text-black/50">
                  {formatMessage({ id: "task.badge.legacy" })}
                </span>
              )}
            </div>
            <p className="line-clamp-3 break-words text-sm font-bold leading-5">{task.title}</p>
            {task.description && (
              <p className="mt-1 line-clamp-2 break-words text-xs text-black/70">
                {task.description}
              </p>
            )}

          </div>
        </div>
      </button>
      {onOpenInNewTab && (
        <button
          type="button"
          onClick={() => onOpenInNewTab(task)}
          className="mt-1 inline-flex size-7 items-center justify-center border border-black/30 bg-white hover:bg-soft-signal/30"
          aria-label={formatMessage({ id: "message.messageItem.openTaskInNewTab" })}
          title={formatMessage({ id: "message.messageItem.openTaskInNewTab" })}
          data-testid={`task-card-open-new-tab-${task.id}`}
        >
          <ExternalLink size={13} />
        </button>
      )}
      <div className="mt-2 flex justify-end">
        {canEditStatus ? (
          <div className={`relative shrink-0 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            <InlineBadgeEditor
              displayValue={formatMessage({ id: style.labelId })}
              selectedId={task.status}
              options={statusOptions}
              onSelect={handleStatusSelect}
              open={editingStatus}
              onToggle={() => setEditingStatus((prev) => !prev)}
              onRequestClose={() => setEditingStatus(false)}
              badgeClassName={style.bg}
              uppercase={false}
              dropdownMinWidth="min-w-[140px]"
              dropdownAlign="right"
              dropdownTestId="task-status-menu"
              optionTestIdPrefix="task-status-option"
            />
          </div>
        ) : (
          <StatusBadge status={task.status} data-testid="task-status-readonly">
            {formatMessage({ id: style.labelId })}
          </StatusBadge>
        )}
      </div>
    </div>
  );
}

export default memo(TaskCard);
