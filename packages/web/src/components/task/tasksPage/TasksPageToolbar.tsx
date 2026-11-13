import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp, CircleDot, Columns3, LayoutList, Plus, User as UserIcon, UserCircle2, X } from "lucide-react";
import {
  DropdownMenuSeparator,
  Popover,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  TaskStatusIcon,
} from "@botiverse/raft-ui";
import {
  FitToolbar,
  FitToolbarButton,
  FitToolbarGroup,
  FitToolbarPicker,
  FitToolbarSearch,
} from "@botiverse/raft-ui/wip";

import type { MessageId } from "../../../i18n/messages";
import { useAuthStore } from "../../../store/authStore";
import { LIST_TOOLBAR_STEP } from "../../ui/listToolbar";
import { ListScope, ListToolbarMore, ListViewSwitch, MoreMenuChoices } from "../../ui/ListToolbarParts";
import SelectionPopover from "../../ui/SelectionPopover";
import { ChannelFilterChip, IdentityFilterChip } from "../TasksPanel";
import { TASK_STATUS_UI, toRuiTaskStatus } from "../taskStatusUi";
import type { ViewMode } from "../tasksViewMode";
import { useTaskIdentityOptions } from "../useTaskIdentityOptions";
import { BOARD_STATUSES, DEFAULT_SERVER_TASK_SORT, SERVER_TASK_SORTS } from "./tasksPageApi";
import type { BoardStatus, ServerTaskSort } from "./tasksPageApi";
import { hasToolbarFilter, TASK_SEARCH_MAX_LENGTH } from "./tasksPageModel";
import type { PageFilters, TasksPageTab } from "./tasksPageModel";

const SORT_LABEL_IDS: Record<ServerTaskSort, MessageId> = {
  activity: "task.page.sort.activity",
  activity_asc: "task.page.sort.activityAsc",
  created: "task.page.sort.created",
};

const VIEWS: readonly ViewMode[] = ["list", "board"];

/** The search waits this long after the last key before it reads. */
const SEARCH_DEBOUNCE_MS = 250;

type OpenFilter = "channel" | "status" | "creator" | "assignee" | null;

/**
 * The Tasks page's toolbar, the toolbar over a list (Raft DS › Patterns ›
 * Responsive), on raft-ui's FitToolbar: 我的 / 全部 with their numbers, the
 * search filling the line, the filters 频道, 状态, 创建人, 负责人 (the
 * applied first, 清除筛选 pinned at their end), then the sort, 列表 / 看板
 * and 新建任务. As the page narrows they give way in the rule's steps
 * (LIST_TOOLBAR_STEP): the sort and the view to icons, the filters to icons,
 * the filters to a scrolling second line with their words back, 新建任务 to
 * +, the scope to a Select, the sort and the view into ⋯, and last an empty
 * search to its button. Both tabs take every filter.
 */
export function TasksPageToolbar({ tab, onTabChange, tabCounts, query, onQueryChange, filters, setChannelIds, setStatuses, setCreators, setAssignees, onClearFilters, sort, onSortChange, view, onViewChange, onNewTask, className, toolbarRef }: {
  tab: TasksPageTab;
  onTabChange: (tab: TasksPageTab) => void;
  tabCounts: Record<TasksPageTab, number | null>;
  /** The search as the address has it (`?q=`). */
  query: string;
  onQueryChange: (query: string) => void;
  filters: PageFilters;
  setChannelIds: (values: string[]) => void;
  setStatuses: (values: string[]) => void;
  setCreators: (values: string[]) => void;
  setAssignees: (values: string[]) => void;
  onClearFilters: () => void;
  sort: ServerTaskSort;
  onSortChange: (sort: ServerTaskSort) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onNewTask: () => void;
  className: string;
  toolbarRef?: React.Ref<HTMLDivElement>;
}) {
  const { formatMessage } = useIntl();
  const identityOptions = useTaskIdentityOptions();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const [openFilter, setOpenFilter] = useState<OpenFilter>(null);
  const handleFilterOpen = (key: Exclude<OpenFilter, null>) => (open: boolean) => {
    setOpenFilter((previous) => (open ? key : previous === key ? null : previous));
  };
  const changeTab = useCallback((next: TasksPageTab) => {
    setOpenFilter(null);
    onTabChange(next);
  }, [onTabChange]);
  const myUserKey = currentUserId ? `user:${currentUserId}` : null;
  const creatorSelfOption = useMemo(
    () => (myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.createdByMe" }) } : null),
    [myUserKey, formatMessage],
  );
  const assigneeSelfOption = useMemo(
    () => (myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.assignedToMe" }) } : null),
    [myUserKey, formatMessage],
  );
  const search = useDebouncedSearch(query, onQueryChange);
  const clearLabel = formatMessage({ id: "task.panel.clearAll" });
  const newTaskLabel = formatMessage({ id: "task.page.newTask" });
  const scopeLabel = formatMessage({ id: "task.page.tabsAria" });
  const scopeOptions = useMemo(() => [
    { value: "mine" as const, label: formatMessage({ id: "task.page.tab.mine" }), count: tabCounts.mine, testId: "tasks-page-tab-mine" },
    { value: "all" as const, label: formatMessage({ id: "task.filter.tabAll" }), count: tabCounts.all, testId: "tasks-page-tab-all" },
  ], [formatMessage, tabCounts.all, tabCounts.mine]);
  const sortOptions = useMemo(
    () => SERVER_TASK_SORTS.map((option) => ({ value: option, label: formatMessage({ id: SORT_LABEL_IDS[option] }) })),
    [formatMessage],
  );
  const viewSwitchOptions = useMemo(() => [
    { value: "list" as const, label: formatMessage({ id: "task.view.list" }), icon: <LayoutList size={16} aria-hidden="true" />, testId: "tasks-page-view-list" },
    { value: "board" as const, label: formatMessage({ id: "task.view.board" }), icon: <Columns3 size={16} aria-hidden="true" />, testId: "tasks-page-view-board" },
  ], [formatMessage]);
  const viewOptions = useMemo(
    () => VIEWS.map((option) => ({ value: option, label: formatMessage({ id: option === "list" ? "task.view.list" : "task.view.board" }) })),
    [formatMessage],
  );

  // The filters, the applied first, so they are in view before any scrolling (Raft DS › FitToolbar).
  const filterItems: { key: Exclude<OpenFilter, null>; applied: boolean; node: ReactNode }[] = [
    {
      key: "channel",
      applied: filters.channelIds.length > 0,
      node: (
        <ChannelFilterChip
          key="channel"
          selected={filters.channelIds}
          onChange={setChannelIds}
          isOpen={openFilter === "channel"}
          onOpenChange={handleFilterOpen("channel")}
          labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          testId="tasks-page-filter-channel"
        />
      ),
    },
    {
      key: "status",
      applied: filters.statuses.length > 0,
      node: (
        <StatusFilterChip
          key="status"
          selected={filters.statuses}
          onChange={setStatuses}
          isOpen={openFilter === "status"}
          onOpenChange={handleFilterOpen("status")}
        />
      ),
    },
    {
      key: "creator",
      applied: filters.creators.length > 0,
      node: (
        <IdentityFilterChip
          key="creator"
          icon={<UserCircle2 />}
          label={formatMessage({ id: "task.filter.creator" })}
          options={identityOptions}
          selected={filters.creators}
          onChange={setCreators}
          selfOption={creatorSelfOption}
          isOpen={openFilter === "creator"}
          onOpenChange={handleFilterOpen("creator")}
          labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          testId="tasks-page-filter-creator"
        />
      ),
    },
    {
      key: "assignee",
      applied: filters.assignees.length > 0,
      node: (
        <IdentityFilterChip
          key="assignee"
          icon={<UserIcon />}
          label={formatMessage({ id: "task.filter.assignee" })}
          options={identityOptions}
          selected={filters.assignees}
          onChange={setAssignees}
          includeUnassigned
          selfOption={assigneeSelfOption}
          isOpen={openFilter === "assignee"}
          onOpenChange={handleFilterOpen("assignee")}
          labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          testId="tasks-page-filter-assignee"
        />
      ),
    },
  ];
  const orderedFilters = [...filterItems.filter((item) => item.applied), ...filterItems.filter((item) => !item.applied)];

  return (
    <div ref={toolbarRef} className={className} data-testid="tasks-page-toolbar">
      <FitToolbar aria-label={formatMessage({ id: "task.panel.heading" })} wrap className="gap-2">
        <ListScope value={tab} options={scopeOptions} onValueChange={changeTab} label={scopeLabel} selectTestId="tasks-page-scope-select" />
        <FitToolbarSearch
          aria-label={formatMessage({ id: "task.page.search" })}
          placeholder={formatMessage({ id: "task.page.search" })}
          clearLabel={formatMessage({ id: "task.page.searchClear" })}
          collapseOrder={LIST_TOOLBAR_STEP.searchButton}
          value={search.draft}
          onValueChange={search.change}
          maxLength={TASK_SEARCH_MAX_LENGTH}
          suppressPasswordManager
          data-testid="tasks-page-search"
        />
        <FitToolbarGroup
          overflow="scroll"
          wrapOrder={LIST_TOOLBAR_STEP.filtersWrap}
          className="gap-2"
          data-testid="tasks-page-filters"
          end={hasToolbarFilter(filters) ? (
            <FitToolbarButton
              variant="ghost"
              collapsedIcon={<X />}
              labelOrder={LIST_TOOLBAR_STEP.filterLabels}
              onClick={onClearFilters}
              data-testid="tasks-page-clear-filters"
            >
              {clearLabel}
            </FitToolbarButton>
          ) : null}
        >
          {orderedFilters.map((item) => item.node)}
        </FitToolbarGroup>
        <FitToolbarGroup
          firstLine
          className="gap-2"
          moreOrder={LIST_TOOLBAR_STEP.displayMore}
          moreItem={(
            <>
              <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.sort" })} value={sort} options={sortOptions} onValueChange={onSortChange} testId="tasks-page-more-sort" />
              <DropdownMenuSeparator />
              <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.view" })} value={view} options={viewOptions} onValueChange={onViewChange} testId="tasks-page-more-view" />
            </>
          )}
        >
          <SortPicker sort={sort} onChange={onSortChange} />
          <ListViewSwitch value={view} options={viewSwitchOptions} onValueChange={onViewChange} label={formatMessage({ id: "task.viewAria" })} />
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className="gap-2">
          <ListToolbarMore testId="tasks-page-more" />
          <FitToolbarButton variant="primary" icon={<Plus />} plusOrder={LIST_TOOLBAR_STEP.primaryPlus} onClick={onNewTask} data-testid="tasks-page-new-task">
            {newTaskLabel}
          </FitToolbarButton>
        </FitToolbarGroup>
      </FitToolbar>
    </div>
  );
}

/**
 * The search as typed: shown at once, read (put in the address, `?q=`) once
 * typing pauses; emptied (the ×, Esc) it reads at once. Null pending once it
 * is read, so the field then shows the address and Clear filters or Back
 * empties it too.
 */
function useDebouncedSearch(value: string, onChange: (value: string) => void) {
  const [pending, setPending] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const change = useCallback((next: string) => {
    setPending(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onChange(next);
      setPending(null);
    }, next === "" ? 0 : SEARCH_DEBOUNCE_MS);
  }, [onChange]);
  return { draft: pending ?? value, change };
}

/**
 * 状态: a multi-select of the task statuses, in the same picker as the other
 * filters (SelectionPopover), each with its status pixel; no search (five
 * options).
 */
function StatusFilterChip({ selected, onChange, isOpen, onOpenChange }: {
  selected: readonly BoardStatus[];
  onChange: (next: string[]) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "task.properties.status" });
  const options = useMemo(() => BOARD_STATUSES.map((status) => ({
    key: status,
    checked: selected.includes(status),
    label: formatMessage({ id: TASK_STATUS_UI[status].labelId }),
    reserveLeadingSlot: true,
    leading: <TaskStatusIcon status={toRuiTaskStatus(status)} aria-hidden />,
    onClick: () => onChange(selected.includes(status) ? selected.filter((value) => value !== status) : [...selected, status]),
  })), [formatMessage, onChange, selected]);
  const clear = useCallback(() => onChange([]), [onChange]);
  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <FitToolbarPicker
        trigger={<PopoverTrigger />}
        icon={<CircleDot />}
        value={selected.length > 0 ? selected.length : undefined}
        labelOrder={LIST_TOOLBAR_STEP.filterLabels}
        data-active={selected.length > 0 ? "" : undefined}
        data-testid="tasks-page-filter-status"
      >
        {label}
      </FitToolbarPicker>
      <SelectionPopover
        title={label}
        options={options}
        showClear={selected.length > 0}
        onClear={clear}
      />
    </Popover>
  );
}

/**
 * The order of every list and column: 最近更新 (the default), 最久没更新,
 * 最近创建. A picker that shows its value (Raft DS › Select), filled once it
 * differs from the default; its icon alone from the first step.
 */
function SortPicker({ sort, onChange }: { sort: ServerTaskSort; onChange: (sort: ServerTaskSort) => void }) {
  const { formatMessage } = useIntl();
  const change = useCallback((next: ServerTaskSort | null) => {
    if (next !== null) onChange(next);
  }, [onChange]);
  const label = formatMessage({ id: SORT_LABEL_IDS[sort] });
  const name = formatMessage({ id: "task.page.sort.label" }, { sort: label });
  return (
    <Select<ServerTaskSort> value={sort} onValueChange={change}>
      <FitToolbarPicker
        trigger={<SelectTrigger />}
        icon={<ArrowDownUp />}
        labelOrder={LIST_TOOLBAR_STEP.displayLabels}
        aria-label={name}
        data-has-value={sort === DEFAULT_SERVER_TASK_SORT ? undefined : ""}
        data-testid="tasks-page-sort"
      >
        {label}
      </FitToolbarPicker>
      <SelectContent align="end">
        <SelectList>
          {SERVER_TASK_SORTS.map((option) => (
            <SelectItem key={option} value={option} data-testid={`tasks-page-sort-${option}`}>
              <SelectItemText>{formatMessage({ id: SORT_LABEL_IDS[option] })}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}
