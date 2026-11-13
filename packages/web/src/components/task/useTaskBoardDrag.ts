import { TASK_STATUSES } from "@botiverse/raft-shared";
import type { TaskDropData, TaskMoveDetails } from "@botiverse/raft-ui";
import type { DragCancelEvent, DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskStatus } from "../../store/taskStore";
import { TASK_STATUS_UI, canEditTaskStatus, getTaskStatusOptions } from "./taskStatusUi";

/** Focuses a board card by task id; false while it isn't mounted. */
export function focusMovedTaskCard(taskId: string, root: ParentNode = document): boolean {
  const card = root.querySelector<HTMLElement>(
    `[data-testid="task-board-draggable-card"][data-task-id="${CSS.escape(taskId)}"]`,
  );
  if (!card) return false;
  card.focus({ preventScroll: false });
  return true;
}

/** The Backlog column's heading: where the reason popover of a dropped card hangs. */
export function backlogColumnHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="task-board-column-backlog"] [data-slot="task-board-column-trigger"]');
}

/** What a board drop target carries: the column's status, and the card's id
 *  when the target is a card. Only the status matters to slock: cards are
 *  ordered by number, not by hand. */
export type BoardDropData = { status: TaskStatus; taskId?: string };

function isBoardDropData(value: TaskDropData | undefined): value is BoardDropData {
  return value != null && (TASK_STATUSES as readonly unknown[]).includes(value.status);
}

/**
 * Board drag and drop (raft-ui TaskDnd). The dragged card is drawn in the
 * overlay; its column hides it until the drop lands. A drop on Backlog from
 * another column asks for a reason first (`backlogDrop`): the card is back in
 * its own column meanwhile, and stays there unless the person confirms.
 */
export function useTaskBoardDrag({ tasks, taskV2, currentUserId, canManageServer }: {
  tasks: Task[];
  taskV2: boolean;
  currentUserId: string | undefined;
  canManageServer: boolean;
}) {
  const { formatMessage } = useIntl();
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const activeTask = activeTaskId == null ? undefined : tasks.find((task) => task.id === activeTaskId);
  // Each status the dragged card may move to; its own column takes it back.
  const allowedDropStatuses = useCallback((task: Task): Set<TaskStatus> => {
    if (!canEditTaskStatus(task, currentUserId, canManageServer)) return new Set();
    return new Set([task.status, ...getTaskStatusOptions(task, currentUserId, canManageServer, taskV2).map((o) => o.id)]);
  }, [currentUserId, canManageServer, taskV2]);
  // A card that can't move somewhere can still be picked up, so each column
  // it won't take can say why: a historical joint task, or a status this task
  // doesn't have (Backlog on a pre-v2 task).
  const blockedReasons = useMemo<Partial<Record<TaskStatus, string>>>(() => {
    if (!activeTask) return {};
    const allowed = allowedDropStatuses(activeTask);
    const from = formatMessage({ id: TASK_STATUS_UI[activeTask.status].labelId });
    const reasons: Partial<Record<TaskStatus, string>> = {};
    for (const status of TASK_STATUSES) {
      if (allowed.has(status)) continue;
      reasons[status] = activeTask.readOnlyReason
        ? formatMessage({ id: "task.permissions.historicalJoint" })
        : formatMessage(
          { id: "task.status.cannotMoveFromTo" },
          { from, to: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
        );
    }
    return reasons;
  }, [activeTask, allowedDropStatuses, formatMessage]);

  const isDropAllowed = useCallback(
    (activeId: string | number, _overId: string | number, overData: TaskDropData | undefined) => {
      if (!isBoardDropData(overData)) return false;
      const task = tasks.find((t) => t.id === String(activeId));
      return task != null && allowedDropStatuses(task).has(overData.status);
    },
    [tasks, allowedDropStatuses],
  );

  // After a keyboard drop the card remounts (in its new column once the move
  // lands), so focus goes back to it; a pointer drop leaves focus alone.
  const keyboardDragRef = useRef(false);
  const [focusRequest, setFocusRequest] = useState<{ taskId: string; status: TaskStatus } | null>(null);
  const handleDragStart = useCallback(({ active, activatorEvent }: DragStartEvent) => {
    keyboardDragRef.current = activatorEvent instanceof KeyboardEvent;
    setActiveTaskId(String(active.id));
  }, []);
  const handleDragFinish = useCallback(({ active }: DragEndEvent | DragCancelEvent) => {
    setActiveTaskId(null);
    if (!keyboardDragRef.current) return;
    keyboardDragRef.current = false;
    const task = tasks.find((t) => t.id === String(active.id));
    // A move replaces this with the target column once the server accepts it.
    if (task) setFocusRequest({ taskId: task.id, status: task.status });
  }, [tasks]);
  useEffect(() => {
    if (!focusRequest) return;
    // Wait until the store shows the card in the column it lands in.
    const task = tasks.find((t) => t.id === focusRequest.taskId);
    if (task?.status !== focusRequest.status) return;
    const frame = requestAnimationFrame(() => {
      if (focusMovedTaskCard(focusRequest.taskId)) setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, tasks]);

  const announceMove = useCallback((task: Task, status: TaskStatus) => {
    setMoveAnnouncement(formatMessage(
      { id: "task.board.movedAnnouncement" },
      { taskNumber: task.taskNumber, status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
    ));
  }, [formatMessage]);

  const [backlogPrompt, setBacklogPrompt] = useState<{ taskId: string; fromKeyboard: boolean; open: boolean } | null>(null);

  /**
   * Turns an allowed drop into a status update. A drop in the card's own
   * column is a no-op. The move is announced once the server accepts it.
   */
  const handleMove = useCallback(
    async ({ activeId, overData }: TaskMoveDetails) => {
      if (!isBoardDropData(overData)) return;
      const targetStatus = overData.status;
      const task = tasks.find((t) => t.id === String(activeId));
      if (!task || task.status === targetStatus) return;
      const fromKeyboard = keyboardDragRef.current;
      if (targetStatus === "backlog") {
        // onDragEnd comes right after this: focus belongs to the popover now, not the card.
        keyboardDragRef.current = false;
        setBacklogPrompt({ taskId: task.id, fromKeyboard, open: true });
        return;
      }
      try {
        await updateTaskStatus(task.channelId, task.id, targetStatus);
        announceMove(task, targetStatus);
        if (fromKeyboard) setFocusRequest({ taskId: task.id, status: targetStatus });
      } catch (err) {
        console.error("Drag-drop status update failed:", err);
      }
    },
    [tasks, updateTaskStatus, announceMove],
  );

  const backlogPromptTask = backlogPrompt ? tasks.find((task) => task.id === backlogPrompt.taskId) : undefined;
  const closeBacklogPrompt = useCallback((moved: boolean) => {
    setBacklogPrompt((prev) => prev && { ...prev, open: false });
    if (!backlogPrompt || !backlogPromptTask) return;
    if (moved) announceMove(backlogPromptTask, "backlog");
    // A cancelled drop gives focus back to the card, in the column it never left.
    if (backlogPrompt.fromKeyboard) {
      setFocusRequest({ taskId: backlogPrompt.taskId, status: moved ? "backlog" : backlogPromptTask.status });
    }
  }, [backlogPrompt, backlogPromptTask, announceMove]);

  return {
    activeTaskId,
    activeTask,
    moveAnnouncement,
    blockedReasons,
    isDropAllowed,
    handleDragStart,
    handleDragFinish,
    handleMove,
    backlogPrompt: backlogPromptTask ? { task: backlogPromptTask, open: !!backlogPrompt?.open } : null,
    closeBacklogPrompt,
  };
}
