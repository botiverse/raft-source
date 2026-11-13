import { useCallback, useMemo } from "react";
import type { MouseEvent, RefObject } from "react";
import { TaskBoardRoot, TaskDndProvider, TaskDragOverlay } from "@botiverse/raft-ui";
import type { TaskMoveDetails } from "@botiverse/raft-ui";

import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useAuthStore } from "../../../store/authStore";
import { useTaskStore } from "../../../store/taskStore";
import type { Task, TaskStatus } from "../../../store/taskStore";
import { useTasksPageStore } from "../../../store/tasksPageStore";
import { touchDragRegion } from "../../../utils/touchDragRegion";
import TaskCard from "../TaskCard";
import { BoardColumn } from "../TasksPanel";
import { TaskBacklogReasonPopover } from "../TaskBacklogReasonPopover";
import { backlogColumnHeading, useTaskBoardDrag } from "../useTaskBoardDrag";
import { TaskVirtualLayout } from "../VirtualizedTaskStack";
import type { TaskSelection } from "./useTaskSelection";
import { BOARD_STATUSES } from "./tasksPageApi";
import type { BoardStatus, ServerTaskSort } from "./tasksPageApi";
import { boardColumnFolded, boardColumnLanes, boardColumns, boardFoldKey } from "./tasksPageModel";
import type { PageFilters, TasksPageTab } from "./tasksPageModel";
import { TaskCardFacts, TaskCardReplies } from "./TasksPageRowParts";
import { useMergedTasksLanes } from "./useTasksPageData";

const renderTitleEnd = (task: Task) => <TaskCardReplies task={task} />;
const renderFooterEnd = (task: Task) => <TaskCardFacts task={task} />;

function isBoardStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (BOARD_STATUSES as readonly string[]).includes(value);
}

/**
 * The board (the channel Tasks panel's: TasksPanel BoardColumn + TaskCard):
 * a column per status (the status filter's, else all five), each its
 * server total, its cards read a page at a time as its end scrolls into
 * view; a card dragged to another column changes its status (Backlog asks
 * why first), its status chip changes it in place. 我的's columns are the
 * person's tasks (assigned to them, created by them or from their message).
 *
 * Selection: ⌘/Ctrl- or Shift-click on a card, or any click while
 * something is selected, picks it; dragging a selected card moves every
 * selected task (`onMoveSelected`).
 */
export function TasksBoardView({ tab, filters, sort, columns, countCurrent, scrollElementRef, openTask, currentTaskId, selection, onMoveSelected }: {
  tab: TasksPageTab;
  filters: PageFilters;
  sort: ServerTaskSort;
  /** Each column's server total; null while searching (a search is not counted: a column shows what it has read). */
  columns: Record<BoardStatus, number> | null;
  countCurrent: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  openTask: (task: Task) => void;
  currentTaskId: string | null;
  selection: TaskSelection;
  /** A selected card was dropped on `status` while several are selected: move them all. */
  onMoveSelected: (status: TaskStatus) => void;
}) {
  const known = useTaskStore((s) => s.serverTasks);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const boardDrag = useTaskBoardDrag({ tasks: known, taskV2: true, currentUserId, canManageServer: capabilities.deleteAnyTask });
  const { activeTaskId, activeTask, blockedReasons, handleMove } = boardDrag;
  const { selected, onSelect, selecting } = selection;

  const onMove = useCallback((details: TaskMoveDetails) => {
    const id = String(details.activeId);
    const status = details.overData?.status;
    if (selected.size > 1 && selected.has(id) && isBoardStatus(status)) {
      onMoveSelected(status);
      return;
    }
    return handleMove(details);
  }, [handleMove, onMoveSelected, selected]);

  const onCardClick = useCallback((task: Task, event?: MouseEvent) => {
    const modified = Boolean(event && (event.metaKey || event.ctrlKey || event.shiftKey));
    if (selecting || modified) {
      onSelect(task, { range: Boolean(event?.shiftKey) });
      return;
    }
    openTask(task);
  }, [onSelect, openTask, selecting]);

  return (
    <>
      <TaskDndProvider
        isDropAllowed={boardDrag.isDropAllowed}
        onDragStart={boardDrag.handleDragStart}
        onDragCancel={boardDrag.handleDragFinish}
        onDragEnd={boardDrag.handleDragFinish}
        onMove={onMove}
      >
        {/* The drag surface: touches that start on the board stay cancelable for the touch sensor (utils/touchDragRegion). */}
        <div ref={touchDragRegion}>
          <TaskVirtualLayout scrollElementRef={scrollElementRef} data-testid="tasks-page-board">
            <TaskBoardRoot>
              {boardColumns(filters).map((status) => (
                <StatusColumn
                  key={status}
                  tab={tab}
                  filters={filters}
                  status={status}
                  sort={sort}
                  count={columns ? columns[status] : null}
                  countCurrent={countCurrent}
                  scrollElementRef={scrollElementRef}
                  openTask={onCardClick}
                  currentTaskId={currentTaskId}
                  activeTaskId={activeTaskId}
                  blockedReason={blockedReasons[status]}
                  selectedTaskIds={selected}
                />
              ))}
            </TaskBoardRoot>
          </TaskVirtualLayout>
        </div>
        {/* On the body, as the channel's board does: the board is its own stacking context. */}
        <TaskDragOverlay container={document.body}>
          {activeTask == null ? null : (
            <TaskCard task={activeTask} onOpen={openTask} titleEnd={renderTitleEnd(activeTask)} footerEnd={renderFooterEnd(activeTask)} selected={selected.has(activeTask.id)} />
          )}
        </TaskDragOverlay>
      </TaskDndProvider>
      {/* Board moves, in words (dnd-kit's own announcements name cards by id). */}
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="task-board-announcement">
        {boardDrag.moveAnnouncement}
      </span>
      {boardDrag.backlogPrompt && (
        <TaskBacklogReasonPopover
          open={boardDrag.backlogPrompt.open}
          task={boardDrag.backlogPrompt.task}
          anchor={backlogColumnHeading}
          finalFocus={backlogColumnHeading}
          onClose={boardDrag.closeBacklogPrompt}
        />
      )}
    </>
  );
}

function useColumnCollapsed(status: BoardStatus, filters: PageFilters) {
  const key = boardFoldKey(status);
  const stored = useTasksPageStore((s) => s.collapsed[key]);
  const setCollapsed = useTasksPageStore((s) => s.setCollapsed);
  // Closed starts folded; a column the status filter asks for opens, whatever its default (Select all reads the same).
  const collapsed = boardColumnFolded(status, filters, stored === undefined ? {} : { [key]: stored });
  const toggle = useCallback(() => setCollapsed(key, !collapsed), [collapsed, key, setCollapsed]);
  return { collapsed, toggle };
}

function StatusColumn({ tab, filters, status, sort, count, countCurrent, scrollElementRef, openTask, currentTaskId, activeTaskId, blockedReason, selectedTaskIds }: {
  tab: TasksPageTab;
  filters: PageFilters;
  status: BoardStatus;
  sort: ServerTaskSort;
  count: number | null;
  countCurrent: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  openTask: (task: Task, event?: MouseEvent) => void;
  currentTaskId: string | null;
  activeTaskId: string | null;
  blockedReason: string | undefined;
  selectedTaskIds: ReadonlySet<string>;
}) {
  const { collapsed, toggle } = useColumnCollapsed(status, filters);
  // Cards show the description: full rows (a page is 20). 我的: one lane per relation, merged.
  const lanes = useMemo(() => boardColumnLanes(tab, filters, status, sort), [filters, sort, status, tab]);
  // Read as the column's end comes into view (none while folded or empty).
  const view = useMergedTasksLanes(lanes, countCurrent ? count : null, collapsed);
  // Unfolded by hand, a column never read reads its first page at once, as the channel board's folded sections do: a
  // folded column is no lane of the view (⌘A skips it), so nothing has read it, and its count over an empty column
  // read as "nothing here". (Its end coming into view, the sentinel's way, can't be all it waits for.)
  const { loaded, loading, failed, loadMore } = view;
  const toggleColumn = useCallback(() => {
    if (collapsed && !loaded && !loading && !failed) loadMore();
    toggle();
  }, [collapsed, failed, loadMore, loaded, loading, toggle]);
  return (
    <BoardColumn
      status={status}
      collapsed={collapsed}
      onToggleCollapsed={toggleColumn}
      statusTasks={view.tasks}
      activeTaskId={activeTaskId}
      blockedReason={blockedReason}
      openTask={openTask}
      isChannelMode={false}
      scrollElementRef={scrollElementRef}
      count={count}
      renderTitleEnd={renderTitleEnd}
      renderFooterEnd={renderFooterEnd}
      currentTaskId={currentTaskId}
      selectedTaskIds={selectedTaskIds}
      hasMore={(count === null || count > 0) && view.hasMore}
      loadingPage={view.loading}
      pendingFirstPage={(count === null || count > 0) && !view.loaded && !view.failed}
      onLoadMore={view.loadMore}
      loadMoreOnScroll
      loadMoreFailed={view.failed}
    />
  );
}
