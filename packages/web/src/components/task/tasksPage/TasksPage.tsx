import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ListTodo, SearchX } from "lucide-react";
import {
  PanelHeaderContent,
  PanelSectionHeader,
  PanelTitle,
  ScrollArea,
  TasksPanelRoot,
} from "@botiverse/raft-ui";
import { SelectionToolbarDock } from "@botiverse/raft-ui/wip";

import { useMediaQuery } from "../../../hooks/effectPrimitives";
import { useFocusRestore } from "../../../hooks/useFocusRestore";
import { usePinnedHeadRailInset } from "../../../hooks/usePinnedHeadRailInset";
import { useTabRootScroll } from "../../../hooks/useTabRootScroll";
import { useAuthStore } from "../../../store/authStore";
import { useTaskStore } from "../../../store/taskStore";
import type { Task, TaskStatus } from "../../../store/taskStore";
import { useTasksPageStore } from "../../../store/tasksPageStore";
import { TabRootBar } from "../../layout/TabRootBar";
import EmptyState from "../../ui/EmptyState";
import { showToast } from "../../toastBridge";
import { CreateTaskDialog } from "../DeferredCreateTaskDialog";
import { TaskCardSkeleton } from "../TasksPanel";
import { TASK_STATUS_UI } from "../taskStatusUi";
import { PHONE_ROOT_TOOLBAR_CLASS, TASKS_PAGE_TOOLBAR_CLASS, PHONE_ROOT_VIEWPORT_CLASS, VIEWPORT_CLASS, VIEWPORT_CONTENT_CLASS } from "../tasksPanelViewport";
import { runTaskBatch } from "./tasksBatch";
import type { BatchAction, BatchOutcome } from "./tasksBatch";
import { isNarrowed, matchesLane, recentDoneSince, viewLanes } from "./tasksPageModel";
import { useKeepOpenedRowInPlace, useOpenTaskOnTasksPage, useTasksPageOpenTaskId } from "./tasksPageOpen";
import { CountsFailed } from "./TasksPageRowParts";
import { TasksPageToolbar } from "./TasksPageToolbar";
import { TasksBoardView } from "./TasksBoardView";
import { TasksListSkeleton, TasksListView } from "./TasksListView";
import { TasksSelectionBar } from "./TasksSelectionBar";
import { useBatchViewer } from "./useBatchViewer";
import { useTasksPageCounts } from "./useTasksPageCounts";
import { TasksPageShownContext } from "./tasksPageShown";
import { useTasksPageParams } from "./useTasksPageParams";
import { readAllLaneTaskIds, shownTaskIds, useTaskSelection } from "./useTaskSelection";

/** What takes focus in a row (its own box or button). */
const FOCUSABLE = "button, a[href], input, [tabindex]:not([tabindex='-1'])";

/** An Esc or ⌘A the page leaves alone: a field's, an input method's, or one a menu, popover or dialog takes. */
function isOthersKey(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.defaultPrevented || event.isComposing) return true;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return document.querySelector("[role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog']") !== null;
}

/**
 * The Tasks page with task v2 (the approved design, hifi v4):
 *
 * - Head: "Tasks", its number (`N / total` once a filter or the search
 *   narrows it).
 * - Toolbar (TasksPageToolbar): 我的 / 全部, the search, the filters, the
 *   sort, list or board, 新建任务. Both tabs take every filter.
 * - List (TasksListView): 我的 in two sections, 分配给你 and 你发起的; 全部
 *   one flat list. Board (TasksBoardView): a column per status.
 * - Selection: a row's box (on hover), ⌘/Ctrl-click, Shift-click for a run,
 *   ⌘A for everything under the filters, a long press by touch; Esc ends it.
 *   The bar at the bottom (TasksSelectionBar) acts on it.
 * - A task opens in the page's own detail slot (tasksPageOpen.ts): beside
 *   the list on desktop, a pushed page on a phone; this page stays mounted
 *   under it either way (TasksRoute).
 * Every number is the server's count; rows are read a page at a time.
 */
export function TasksPage() {
  const { formatMessage } = useIntl();
  // The shell's phone breakpoint (safe where matchMedia is missing; follows a resize).
  const isPhone = useMediaQuery("(max-width: 767px)");
  const params = useTasksPageParams();
  const { tab, sort, view, filters } = params;
  const openTask = useOpenTaskOnTasksPage();
  const currentTaskId = useTasksPageOpenTaskId();
  const [creating, setCreating] = useState(false);
  const shown = useContext(TasksPageShownContext);
  const scope = useMemo(() => JSON.stringify([tab, view, sort, filters]), [filters, sort, tab, view]);
  // 你发起的 keeps what was done in the last day: from when its lanes are read afresh (the tab, view, sort, filters or
  // search change), not from when the page came up. The reads made under the instant before are dropped. (Not when
  // the page shows again from under a task: its lists are kept as they were.)
  // Set while rendering the new scope (React's state from a prop change), so its lanes are keyed once.
  const [since, setSince] = useState(() => ({ scope, doneSince: recentDoneSince() }));
  let doneSince = since.doneSince;
  if (since.scope !== scope) {
    doneSince = recentDoneSince();
    setSince({ scope, doneSince });
  }
  const doneSinceBefore = useRef(doneSince);
  useEffect(() => {
    if (doneSinceBefore.current === doneSince) return;
    useTasksPageStore.getState().evictCompletedSince(doneSinceBefore.current);
    doneSinceBefore.current = doneSince;
  }, [doneSince]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    return () => {
      scrollContainerRef.current = null;
    };
  }, []);
  // On a phone it is the Tasks tab root: a re-tap scrolls it up, its scroll survives a tab switch.
  useTabRootScroll(isPhone ? "tasks" : null, scrollContainerRef);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarRailInset = usePinnedHeadRailInset(toolbarRef, isPhone);
  // Beside the list (not a phone's, which the task covers) the row opened stays where it was as the list re-lays out.
  const keepOpenedRow = useKeepOpenedRowInPlace(rootRef, scrollContainerRef, currentTaskId, !isPhone);
  const openRow = useCallback((task: Task) => {
    keepOpenedRow(task.id);
    openTask(task);
  }, [keepOpenedRow, openTask]);

  const counts = useTasksPageCounts(tab, view, filters, doneSince);
  const narrowed = isNarrowed(filters);

  // ---- Selection ----
  const selection = useTaskSelection(scope, rootRef);
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const known = useTaskStore((s) => s.serverTasks);
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  // The lanes the view shows (a folded board column's are not shown).
  const collapsed = useTasksPageStore((s) => s.collapsed);
  const lanes = useMemo(() => viewLanes(tab, view, filters, sort, doneSince, collapsed), [collapsed, doneSince, filters, sort, tab, view]);
  // What the bar counts and acts on: the selected tasks still in the lists (a task deleted, or changed out of the
  // filters, since it was picked has left them).
  const selectedTasks = useMemo(
    () => (selection.selected.size === 0
      ? []
      : known.filter((task) => selection.selected.has(task.id) && lanes.some((lane) => matchesLane(task, lane.filters, viewerId, true)))),
    [known, lanes, selection.selected, viewerId],
  );

  const selectAll = useCallback(async () => {
    const at = scope;
    // What is on screen at once; then everything under the filters, read to its end.
    selection.setAll(shownTaskIds(rootRef.current));
    const { ids, complete, capped } = await readAllLaneTaskIds(lanes);
    if (scopeRef.current !== at) return;
    selection.setAll(ids);
    if (capped) showToast({ title: formatMessage({ id: "task.page.select.capped" }, { count: ids.length }) });
    else if (!complete) showToast({ title: formatMessage({ id: "task.page.select.interrupted" }, { count: ids.length }), type: "error" });
  }, [formatMessage, lanes, scope, selection]);

  const { selecting, clear: clearSelection } = selection;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isOthersKey(event)) return;
      // Under a task on a phone the page is not on screen.
      const root = rootRef.current;
      if (!root || !shown) return;
      if (event.key === "Escape" && selecting) {
        // Before the page's own Esc (closing the open task), which sees it taken.
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
        const target = event.target;
        // The list's ⌘A, not the open task's: only from the list or from nowhere.
        if (target instanceof Node && target !== document.body && !root.contains(target)) return;
        event.preventDefault();
        void selectAll();
      }
    };
    // keydown-global-exempt: the Tasks page's Esc (ends the selection, before the open task's own Esc) and ⌘A (selects the list), in the capture phase
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [clearSelection, selectAll, selecting, shown]);

  // ---- Batch actions ----
  const viewer = useBatchViewer();
  // One batch at a time, however fast the clicks (two in one tick run it once): the bar's and a board drop's.
  const batchBusyRef = useRef(false);
  const { setAll: setSelection } = selection;
  const runBatch = useCallback(async (action: BatchAction): Promise<BatchOutcome | null> => {
    if (batchBusyRef.current || selectedTasks.length === 0) return null;
    batchBusyRef.current = true;
    try {
      const outcome = await runTaskBatch(action, selectedTasks, viewer);
      // What the server refused stays selected, to try again; what was done or skipped leaves the selection.
      if (outcome.failedIds.length > 0) setSelection(outcome.failedIds);
      else clearSelection();
      return outcome;
    } finally {
      batchBusyRef.current = false;
    }
  }, [clearSelection, selectedTasks, setSelection, viewer]);

  // A drop of a selected card while several are selected moves them all.
  const moveSelected = useCallback((status: TaskStatus) => {
    const statusLabel = formatMessage({ id: TASK_STATUS_UI[status].labelId });
    void runBatch({ kind: "status", status }).then((outcome) => {
      if (!outcome) return;
      showToast({ title: formatMessage({ id: "task.page.batch.statusDone" }, { count: outcome.done, status: statusLabel, skipped: outcome.skipped }), type: outcome.done === 0 ? "error" : undefined });
    });
  }, [formatMessage, runBatch]);

  // The bar gone (Esc, ×, an action done) with focus in it: focus goes back to the row picked last (scrolled into
  // view), or the list (not scrolled).
  const { lastPicked } = selection;
  const returnFocus = useFocusRestore(() => {
    const root = rootRef.current;
    if (!root) return null;
    const id = lastPicked();
    const row = id === null ? null : Array.from(root.querySelectorAll<HTMLElement>("[data-task-id]")).find((element) => element.dataset.taskId === id) ?? null;
    const target = row && (row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE));
    return target ?? scrollContainerRef.current ?? root;
  }, (target) => ({ preventScroll: !target.closest("[data-task-id]") }));

  // A search's hits as the list has read them: every lane of the view read to its end, else null (not known yet).
  const laneReads = useTasksPageStore((s) => s.lanes);
  const searchHits = useMemo(() => {
    if (!counts.searching || view !== "list") return null;
    const ids = new Set<string>();
    for (const lane of lanes) {
      const read = laneReads[lane.key];
      if (!read?.loaded || read.nextCursor !== null) return null;
      for (const id of read.ids) ids.add(id);
    }
    return ids.size;
  }, [counts.searching, laneReads, lanes, view]);

  const onCreated = useCallback((created: Task[]) => {
    if (created.length === 1) openTask(created[0]!);
  }, [openTask]);
  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);

  const toolbar = (
    <TasksPageToolbar
      toolbarRef={isPhone ? toolbarRef : undefined}
      className={isPhone ? `${TASKS_PAGE_TOOLBAR_CLASS} ${PHONE_ROOT_TOOLBAR_CLASS}` : TASKS_PAGE_TOOLBAR_CLASS}
      tab={tab}
      onTabChange={params.setTab}
      tabCounts={counts.tabs}
      query={params.rawQuery}
      onQueryChange={params.setQuery}
      filters={filters}
      setChannelIds={params.setChannelIds}
      setStatuses={params.setStatuses}
      setCreators={params.setCreators}
      setAssignees={params.setAssignees}
      onClearFilters={params.clearFilters}
      sort={sort}
      onSortChange={params.setSort}
      view={view}
      onViewChange={params.setView}
      onNewTask={openCreate}
    />
  );

  const tabTotal = counts.tabs[tab];
  // A search is not counted (the counts take no `q`): its N is the hits the list has read, once it has read them
  // all; until then, and on the board (whose folded columns read nothing), the tab's total alone.
  const number = counts.searching
    ? tabTotal === null ? null : searchHits !== null ? `${searchHits} / ${tabTotal}` : String(tabTotal)
    : counts.shown === null
      ? null
      : narrowed && tabTotal !== null ? `${counts.shown} / ${tabTotal}` : String(counts.shown);
  const headNumber = number === null ? null : <span className="font-mono" data-testid="tasks-page-total">{number}</span>;

  let body;
  if (counts.failed) {
    body = <CountsFailed onRetry={counts.retry} testId="tasks-page-failed" />;
  } else if (counts.shown === null && !counts.searching) {
    body = (
      <div aria-busy="true" data-testid="tasks-page-loading">
        {view === "board"
          ? <div className="flex flex-col gap-2">{Array.from({ length: 4 }, (_, index) => <TaskCardSkeleton key={index} />)}</div>
          : <TasksListSkeleton tab={tab} headingLevel={isPhone ? 2 : 3} />}
      </div>
    );
  } else if ((counts.searching ? searchHits === 0 : counts.shown === 0) && (narrowed || tab === "all")) {
    body = narrowed ? (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<SearchX size={36} />}
        titleHeading="h2"
        title={formatMessage({ id: "task.page.noMatch" })}
        // No button (Raft DS: an empty state carries none): the toolbar's Clear filters and the search's × clear it.
        data-testid="tasks-page-empty"
      />
    ) : (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<ListTodo size={36} />}
        titleHeading="h2"
        title={formatMessage({ id: "emptyState.noTasksTitle" })}
        data-testid="tasks-page-empty"
      />
    );
  } else if (view === "board") {
    // Searching, the columns are not counted: each shows what it has read.
    body = counts.columns || counts.searching ? (
      <TasksBoardView
        tab={tab}
        filters={filters}
        sort={sort}
        columns={counts.columns}
        countCurrent={counts.current}
        scrollElementRef={scrollContainerRef}
        openTask={openRow}
        currentTaskId={currentTaskId}
        selection={selection}
        onMoveSelected={moveSelected}
      />
    ) : null;
  } else {
    body = (
      <TasksListView
        tab={tab}
        filters={filters}
        sort={sort}
        sections={counts.sections}
        doneSince={doneSince}
        total={counts.shown}
        countCurrent={counts.current}
        headingLevel={isPhone ? 2 : 3}
        openTask={openRow}
        currentTaskId={currentTaskId}
        selection={selection}
      />
    );
  }

  const viewportContentClass = `${VIEWPORT_CONTENT_CLASS} mobile-nav-clearance ${isPhone ? PHONE_ROOT_VIEWPORT_CLASS : ""} ${selectedTasks.length > 0 ? "pb-24" : ""}`;
  return (
    <TasksPanelRoot ref={rootRef} className="relative flex min-h-0 flex-1 flex-col" data-tasks-page="" data-testid="tasks-page">
      {isPhone ? (
        // On a phone the head is the Tasks tab root's bar (its one h1).
        <TabRootBar name={formatMessage({ id: "task.panel.heading" })} headingLevel={1} subtitle={headNumber} />
      ) : (
        // Raft DS › Panel: the head names the page (no icon tile), its number beside it; the search is the toolbar's.
        <PanelSectionHeader data-tab-root-bar="">
          <PanelHeaderContent className="flex-row items-baseline gap-2">
            <PanelTitle render={<h2>{formatMessage({ id: "task.panel.heading" })}</h2>} />
            {headNumber ? <span className="text-mono-meta text-foreground-hint">{headNumber}</span> : null}
          </PanelHeaderContent>
        </PanelSectionHeader>
      )}
      {isPhone ? null : toolbar}
      <ScrollArea
        ref={viewportRef}
        // Only the board scrolls sideways; a list never outgrows its width (rows wrap).
        orientation={view === "board" ? "both" : "vertical"}
        data-task-virtual-scroll
        railInset={isPhone ? toolbarRailInset : undefined}
        className={VIEWPORT_CLASS}
        contentClassName={viewportContentClass}
      >
        {isPhone ? toolbar : null}
        {body}
      </ScrollArea>
      {selectedTasks.length > 0 ? (
        <SelectionToolbarDock>
          <TasksSelectionBar
            tasks={selectedTasks}
            runBatch={runBatch}
            onClear={clearSelection}
            onGone={returnFocus}
          />
        </SelectionToolbarDock>
      ) : null}
      {creating ? (
        <CreateTaskDialog
          defaultChannelId={filters.channelIds.length === 1 ? filters.channelIds[0] : null}
          onClose={closeCreate}
          onCreated={onCreated}
        />
      ) : null}
    </TasksPanelRoot>
  );
}
