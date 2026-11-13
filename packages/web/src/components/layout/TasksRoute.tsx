import { Suspense, useCallback, useContext, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";

import { deferredPanel } from "../../boot/deferredUi";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useColumnWidth } from "../../store/columnWidthStore";
import { useSearchContentStore } from "../../store/searchContentStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useUIStore } from "../../store/uiStore";
import { TaskFocusContext } from "../task/tasksPage/taskFocus";
import type { TaskFocus } from "../task/tasksPage/taskFocus";
import { focusTasksPageRowAfterClose } from "../task/tasksPage/tasksPageOpen";
import { TasksPageShownContext } from "../task/tasksPage/tasksPageShown";
import { ACTIVITY_MASTER_DETAIL_QUERY } from "../thread/activityLayout";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import { ContentSlotThreadPanel } from "./ContentSlotThreadPanel";
import { DetailSlotThreadContext, useThreadInDetailSlotOpener } from "./detailSlotThread";
import { PanelLoading } from "./PanelLoading";
import { TASKS_PAGE_TASK } from "./rowPlan";
import { RowColumnSlotContext } from "./rowColumnSlot";
import { toggleRowExpand, useRowExpand, useRowPlanStore } from "./rowPlanStore";
import { TaskContentSlot } from "./TaskContentSlot";

const TasksPanel = deferredPanel(() => import("../task/TasksPanel"));
const TasksPage = deferredPanel(() => import("../task/tasksPage/TasksPage").then((m) => ({ default: m.TasksPage })));

function TasksFallback() {
  const { formatMessage } = useIntl();
  return <PanelLoading label={formatMessage({ id: "layout.main.loading" })} />;
}

/**
 * The task beside the list (desktop) is a column of MainLayout's row, as the thread beside its channel (stdrc: the
 * Tasks page's main area is the chat's, the list its conversation, the task its thread). It is portaled into the row
 * right after the conversation's column (rowColumnSlot), so the list is that column's whole content and the row's
 * #189 rules hold for the two as for the chat's (rowPlan TASKS_PAGE_TASK, rowLayout): the task at the detail column's
 * width (lib/panelBounds `detail`, 400 by default, remembered, its content clipped under 320); its seam trades width
 * with the list down to 160 either side (rowSeams), the list's content kept at its 360 and clipped below it (rule 2);
 * a narrower window gives way across both (rule 4); its Expand (rule 5) fills the row, the list a 160 strip.
 */
const DETAIL_BESIDE_CLASS = "relative flex min-h-0 shrink-0 flex-col border-l border-line-seam";

/**
 * The open task's Focus Mode, the thread's beside its channel (uiStore `threadMaximized`): its head's Expand (#189
 * rule 5; TaskFocusContext) fills the row with it, every other column 160 and clipped, the list included; the same
 * Expand pressed, Escape (rowPlanStore's, before the task's own, which closes it), or a seam moved takes it out, the
 * row as it was. It belongs to the task open (`taskFocusId`, kept across a reload; taskFocus). The row applies it
 * (rowPlanStore `taskColumn`, published here while the task stands in the row); where the row isn't planned (a phone:
 * the task is a page in place of the list already) there is no Expand.
 */
function useTaskFocus(openTaskId: string | null, inRow: boolean): { focused: boolean; focus: TaskFocus | null } {
  const taskFocusId = useUIStore((s) => s.taskFocusId);
  const setTaskFocus = useUIStore((s) => s.setTaskFocus);
  const focused = inRow && openTaskId !== null && taskFocusId === openTaskId;
  // The column stands in the row with a task or a thread linked from it (the same place); only a task's has Focus Mode.
  useLayoutEffect(() => {
    if (!inRow) return undefined;
    useRowPlanStore.setState({ taskColumn: { focused, focus: (next) => setTaskFocus(next && openTaskId !== null ? openTaskId : null) } });
    return () => useRowPlanStore.setState({ taskColumn: null });
  }, [focused, inRow, openTaskId, setTaskFocus]);
  // The row's Expand for it (RowExpandAction's): shown where the planned row has it and another column beside it.
  const expand = useRowExpand(TASKS_PAGE_TASK);
  const shown = inRow && openTaskId !== null && expand.shown;
  const toggle = useCallback(() => toggleRowExpand(TASKS_PAGE_TASK), []);
  const focus = useMemo(() => (shown ? { focused: expand.pressed, toggle } : null), [expand.pressed, shown, toggle]);
  return { focused, focus };
}

/**
 * Route: /tasks. With task v2 (task_v2_conversations_v0) the Tasks page of
 * 方案 A (TasksPage), whose task opens in the page's own detail slot
 * (`?open=task:<id>` beside `?task=`, TaskContentSlot): beside the list on
 * desktop, a page in place of it on a phone (its Back returning to the list).
 * A thread link in that task (or its Earlier discussion) opens the thread in
 * the same place (`?open=thread:`, detailSlotThread.ts) instead of leaving
 * for the channel; View in Channel and Source still leave.
 *
 * The list stays mounted, in the same place, while a task is open: on a
 * desktop it is the row's conversation beside the task's column (resizable
 * on the task's left seam, a seam of the row), on a phone it is hidden
 * under the task, so its scroll position, folded groups and loaded rows are
 * as they were when the task closes. Flag off: the status board (TasksPanel),
 * as before; it also shows while the flags are still being read, as
 * everything task v2 gates.
 */
export function TasksRoute() {
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const slot = useSearchContentStore((s) => s.slot);
  const closeSlot = useSearchContentStore((s) => s.close);
  const masterDetail = useMediaQuery(ACTIVITY_MASTER_DETAIL_QUERY);
  const openThreadHere = useThreadInDetailSlotOpener();
  const detailWidth = useColumnWidth("detail");
  const rowSlot = useContext(RowColumnSlotContext);
  const slotOpen = slot?.kind === "task" || slot?.kind === "thread";
  // Beside the list on a desktop, in MainLayout's row: a column of it.
  const inRow = taskV2 && slotOpen && masterDetail && rowSlot !== undefined;
  const { focused, focus } = useTaskFocus(slot?.kind === "task" ? slot.id : null, inRow);
  if (!taskV2) return <Suspense fallback={<TasksFallback />}><TasksPanel /></Suspense>;
  const detail = slot?.kind === "task"
    ? <TaskContentSlot slot={slot} closeSlot={closeSlot} focusRowAfterClose={focusTasksPageRowAfterClose} />
    : slot?.kind === "thread"
      ? <ContentSlotThreadPanel closeSlot={closeSlot} />
      : null;
  const beside = Boolean(detail) && masterDetail;
  // Under a task on a phone the list is not on screen. Beside it, it stays, a 160 strip at the least (the task in Focus Mode).
  const listShown = !detail || masterDetail;
  const column = detail ? (
    <div
      className={beside ? DETAIL_BESIDE_CLASS : "flex min-h-0 min-w-0 flex-1 flex-col"}
      // Its saved width; in the planned row, the width the row gives it (rowLayout `--row-width`).
      style={beside ? { width: detailWidth } : undefined}
      data-row-column={inRow ? TASKS_PAGE_TASK : undefined}
      data-testid="tasks-route-detail"
    >
      {beside ? <ColumnResizeHandle column="detail" edge="left" ownBorder data-testid="tasks-route-detail-resize" /> : null}
      <TaskFocusContext.Provider value={focus}>
        <DetailSlotThreadContext.Provider value={openThreadHere}>{detail}</DetailSlotThreadContext.Provider>
      </TaskFocusContext.Provider>
    </div>
  ) : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="tasks-route" data-task-focused={focused ? "true" : undefined}>
      <div className={listShown ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} data-main-column="" data-testid="tasks-route-list">
        {/* Not on screen, the page's counts wait (useTaskCounts). */}
        <TasksPageShownContext.Provider value={listShown}>
          <Suspense fallback={<TasksFallback />}><TasksPage /></Suspense>
        </TasksPageShownContext.Provider>
      </div>
      {/* In the row, right after the conversation's column (until its slot has mounted, nothing yet); else here. */}
      {inRow ? (rowSlot ? createPortal(column, rowSlot) : null) : column}
    </div>
  );
}
