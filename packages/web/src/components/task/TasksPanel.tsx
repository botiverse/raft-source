import { TASK_STATUSES } from "@botiverse/raft-shared";
import {
  Button,
  Popover,
  PopoverTrigger,
  TaskBoardColumn,
  TaskBoardColumnBadge,
  TaskBoardColumnChevron,
  TaskBoardColumnCount,
  TaskBoardColumnEmpty,
  TaskBoardColumnEmptyAllowed,
  TaskBoardColumnEmptyBlocked,
  TaskBoardColumnEmptyIdle,
  TaskBoardColumnHeading,
  TaskBoardColumnItems,
  TaskBoardColumnPanel,
  TaskBoardColumnTrigger,
  TaskBoardRoot,
  TaskDndProvider,
  TaskDragOverlay,
  TaskDraggable,
  TaskDropZone,
  TaskSection as RuiTaskSection,
  TaskSectionBadge,
  TaskSectionChevron,
  TaskSectionCount,
  TaskSectionEmpty,
  TaskSectionHeading,
  TaskSectionItems,
  TaskSectionPanel,
  TaskSectionTrigger,
  TasksPanelRoot,
  ScrollArea,
  TasksPanelToolbar,
} from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker } from "@botiverse/raft-ui/wip";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { touchDragRegion } from "../../utils/touchDragRegion";
import { useIntl } from "react-intl";
import { ChevronDown, Columns3, Hash, LayoutList, ListTodo, Plus, User as UserIcon, UserCircle2, X } from "lucide-react";
import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { openTaskConversationDialog } from "./useOpenTask";
import { opensAsTaskConversation } from "../../utils/taskConversation";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useProfileStore } from "../../store/profileStore";
import { useChannelStore } from "../../store/channelStore";
import { useAuthStore } from "../../store/authStore";
import TaskCard, { TaskCardSkeleton } from "./TaskCard";
import { taskLanePlaceholders, useRememberedTaskLaneCounts } from "./taskLaneCounts";
import { CreateTaskDialog } from "./DeferredCreateTaskDialog";
import { TaskBacklogReasonPopover } from "./TaskBacklogReasonPopover";
import { TASK_STATUS_UI, toRuiTaskStatus } from "./taskStatusUi";
import { backlogColumnHeading, useTaskBoardDrag } from "./useTaskBoardDrag";
import type { BoardDropData } from "./useTaskBoardDrag";
import EmptyState from "../ui/EmptyState";
import AvatarSlot from "../ui/AvatarSlot";
import SelectionPopover from "../ui/SelectionPopover";
import VirtualizedTaskStack, { TaskVirtualLayout } from "./VirtualizedTaskStack";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { LIST_TOOLBAR_MORE_GROUP_CLASS, LIST_TOOLBAR_STEP } from "../ui/listToolbar";
import { ListToolbarMore, ListViewSwitch, MoreMenuChoices } from "../ui/ListToolbarParts";
import { useTabRootScroll } from "../../hooks/useTabRootScroll";
import { TabRootBar } from "../layout/TabRootBar";
import { usePinnedHeadRailInset } from "../../hooks/usePinnedHeadRailInset";
import { PHONE_ROOT_TOOLBAR_CLASS, PHONE_ROOT_VIEWPORT_CLASS, TOOLBAR_CLASS, VIEWPORT_CLASS, VIEWPORT_CONTENT_CLASS } from "./tasksPanelViewport";
import { LoadMoreSentinel } from "./tasksPage/LoadMoreSentinel";
import { parseTaskViewMode, readStoredTaskViewMode, writeStoredTaskViewMode } from "./tasksViewMode";
import type { ViewMode } from "./tasksViewMode";
import { useTaskIdentityOptions } from "./useTaskIdentityOptions";
import type { IdentityOption } from "./useTaskIdentityOptions";

/**
 * Identity reference shape used by Creator + Assignee filters. Encoded in
 * URL as `<type>:<id>` (`user:abc-123` / `agent:def-456`). The Assignee
 * filter additionally accepts the literal `unassigned` to match tasks with
 * no claimer.
 *
 * Why a single reusable encoding: Creator and Assignee filters each carry
 * a multi-select list of humans + agents drawn from the same server-scoped
 * pool. Encoding the participant kind in the value keeps a `user:abc` and
 * `agent:abc` from colliding (theoretically possible since UUID namespaces
 * are independent across the two tables).
 */
type IdentityFilterValue = string;


/** The way work flows, left to right (raft-design patterns/tasks.md): Backlog to Closed. */
const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return b.taskNumber - a.taskNumber;
  });
}

export { TaskCardSkeleton };

/**
 * A lane's cards while it loads (`count` TaskCardSkeletons, `gap` apart as
 * the loaded cards are), or, for a lane that had none last time, its empty
 * box held invisible: whether it is empty is not known yet.
 */
function LanePlaceholders({ count, gapClassName, empty, render = (cards) => cards }: {
  count: number;
  gapClassName: string;
  empty: React.ReactNode;
  /** Where the cards go in the lane (the list's TaskSectionItems). */
  render?: (cards: React.ReactNode) => React.ReactNode;
}) {
  if (count === 0) return empty;
  return render(
    <div className={`flex flex-col ${gapClassName}`} aria-hidden="true" data-testid="task-lane-placeholders">
      {Array.from({ length: count }, (_, index) => <TaskCardSkeleton key={index} />)}
    </div>,
  );
}

const inListItems = (cards: React.ReactNode) => <TaskSectionItems>{cards}</TaskSectionItems>;

/** List cards sit 10px apart (the list's VirtualizedTaskStack gap); placeholders too. */
const LIST_CARD_GAP = 10;
const LIST_CARD_GAP_CLASS = "gap-2.5";

function getTaskKey(task: Task): string {
  return task.id;
}

export function TaskSection({
  status,
  tasks,
  onOpenTask,
  collapsed = false,
  onToggleCollapsed,
  showChannelName = true,
  scrollElementRef,
  hasMore = false,
  loadingPage = false,
  onLoadMore,
  renderFooterEnd,
  placeholders,
}: {
  status: TaskStatus;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  collapsed?: boolean;
  onToggleCollapsed?: (status: TaskStatus) => void;
  showChannelName?: boolean;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  /** Server-mode lazy paging: more pages exist for this status lane. */
  hasMore?: boolean;
  loadingPage?: boolean;
  onLoadMore?: () => void;
  /** Extra read-only facts per card (the channel Tasks panel shows the assignee). */
  renderFooterEnd?: (task: Task) => React.ReactNode;
  /** The list is still loading: this many card placeholders (0: the empty
   *  box, held invisible), and no count until it is known. */
  placeholders?: number;
}) {
  const { formatMessage } = useIntl();
  const ruiStatus = toRuiTaskStatus(status);
  const handleOpenChange = useCallback(() => onToggleCollapsed?.(status), [onToggleCollapsed, status]);
  const emptyLabel = formatMessage(
    { id: "task.status.emptyGroup" },
    { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
  );
  const renderTask = useCallback((task: Task) => (
    <TaskCard
      task={task}
      onOpen={onOpenTask}
      showChannelName={showChannelName}
      footerEnd={renderFooterEnd?.(task)}
    />
  ), [onOpenTask, showChannelName, renderFooterEnd]);
  return (
    <RuiTaskSection
      open={!collapsed}
      onOpenChange={handleOpenChange}
      className="stack-y-2.5"
    >
      <TaskSectionTrigger
        disabled={!onToggleCollapsed}
        aria-label={formatMessage(
          { id: collapsed ? "task.status.showGroup" : "task.status.hideGroup" },
          { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
        )}
        className={onToggleCollapsed ? undefined : "cursor-default"}
      >
        <TaskSectionHeading>
          <TaskSectionBadge status={ruiStatus}>
            {formatMessage({ id: TASK_STATUS_UI[status].labelId })}
          </TaskSectionBadge>
          {placeholders === undefined ? <TaskSectionCount>{tasks.length}</TaskSectionCount> : null}
        </TaskSectionHeading>
        {onToggleCollapsed ? (
          <TaskSectionChevron />
        ) : (
          <span />
        )}
      </TaskSectionTrigger>
      <TaskSectionPanel>
        {placeholders !== undefined ? (
          <LanePlaceholders
            count={placeholders}
            gapClassName={LIST_CARD_GAP_CLASS}
            empty={<TaskSectionEmpty className="invisible" aria-hidden="true">{emptyLabel}</TaskSectionEmpty>}
            render={inListItems}
          />
        ) : tasks.length === 0 ? (
          loadingPage ? (
            <TaskCardSkeleton />
          ) : (
            <TaskSectionEmpty>{emptyLabel}</TaskSectionEmpty>
          )
        ) : (
          <TaskSectionItems>
            <VirtualizedTaskStack
              items={tasks}
              scrollElementRef={scrollElementRef}
              estimateSize={116}
              gap={LIST_CARD_GAP}
              getItemKey={getTaskKey}
              renderItem={renderTask}
            />
          </TaskSectionItems>
        )}
        {hasMore && (
          <Button
            type="button"
            size="md"
            variant="outline"
            disabled={loadingPage}
            onClick={onLoadMore}
            className="w-full"
            data-testid={`task-load-more-${status}`}
          >
            {loadingPage ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "task.panel.loadMore" })}
          </Button>
        )}
      </TaskSectionPanel>
    </RuiTaskSection>
  );
}

/** Board cards sit `gap-2` apart (TaskBoardColumnItems); the virtualizer must match. */
const BOARD_CARD_GAP = 8;

/**
 * One draggable board card (raft-ui TaskDnd). It is not a drop target: a
 * column's order is the sort's, not the person's, so a card lands on a column
 * and never "between two cards", where it would only jump back to its sorted
 * place (stdrc 11-10; Raft DS › Drag and drop: where the order isn't the
 * person's, the target is the column). Pointer (6px), touch (hold 500ms, then
 * move) and keyboard activation come from TaskDndProvider, so a click or tap
 * still opens the card.
 */
function BoardTaskItem({
  task,
  children,
}: {
  task: Task;
  status: TaskStatus;
  children: React.ReactNode;
}) {
  return (
    <TaskDraggable
      id={task.id}
      data-testid="task-board-draggable-card"
      data-task-id={task.id}
    >
      {children}
    </TaskDraggable>
  );
}

/**
 * One status column in the board view: a TaskDropZone rendered as the
 * TaskBoardColumn, so the column's `data-drop-state` (idle / allowed /
 * blocked) drives the recipe's empty text and collapsed outline. The column
 * itself never changes fill. The dragged card leaves its column while the
 * overlay carries it.
 */
export function BoardColumn({
  status,
  collapsed,
  onToggleCollapsed,
  statusTasks,
  activeTaskId,
  blockedReason,
  openTask,
  isChannelMode,
  scrollElementRef,
  hasMore = false,
  loadingPage = false,
  onLoadMore,
  renderFooterEnd,
  count,
  renderTitleEnd,
  loadMoreOnScroll = false,
  loadMoreFailed = false,
  pendingFirstPage = false,
  currentTaskId = null,
  selectedTaskIds,
  placeholders,
}: {
  status: TaskStatus;
  collapsed: boolean;
  onToggleCollapsed: (status: TaskStatus) => void;
  statusTasks: Task[];
  /** The card being dragged, if any; it is drawn in the drag overlay instead. */
  activeTaskId: string | null;
  /** Why the dragged card can't be dropped here, when the board knows. */
  blockedReason: string | undefined;
  openTask: (task: Task, event?: React.MouseEvent) => void;
  isChannelMode: boolean;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  /** Server-mode lazy paging: more pages exist for this status lane. */
  hasMore?: boolean;
  loadingPage?: boolean;
  onLoadMore?: () => void;
  /** Extra read-only facts per card (the channel Tasks panel shows the assignee). */
  renderFooterEnd?: (task: Task) => React.ReactNode;
  /** The column's total from the server (the Tasks page); else the cards shown. */
  count?: number | null;
  /** Inline after each card's title (the Tasks page: its number of messages). */
  renderTitleEnd?: (task: Task) => React.ReactNode;
  /** The next page is read when the end of the column scrolls into view, not on a button. */
  loadMoreOnScroll?: boolean;
  loadMoreFailed?: boolean;
  /** Its first page is still to be read: a placeholder, not "No … tasks". */
  pendingFirstPage?: boolean;
  /** The task open beside the board. */
  currentTaskId?: string | null;
  /** Cards selected on the Tasks page. */
  selectedTaskIds?: ReadonlySet<string>;
  /** The board is still loading: this many card placeholders (0: the empty
   *  box, held invisible), and no count until it is known. */
  placeholders?: number;
}) {
  const { formatMessage } = useIntl();
  const ruiStatus = toRuiTaskStatus(status);
  const statusLabel = formatMessage({ id: TASK_STATUS_UI[status].labelId });
  const columnDropId = `task-status:${status}`;
  const columnDropData = useMemo<BoardDropData>(() => ({ status }), [status]);
  const visibleTasks = useMemo(
    () => (activeTaskId == null ? statusTasks : statusTasks.filter((task) => task.id !== activeTaskId)),
    [activeTaskId, statusTasks],
  );
  const handleOpenChange = useCallback(() => onToggleCollapsed(status), [onToggleCollapsed, status]);
  const renderTask = useCallback((task: Task) => (
    <BoardTaskItem task={task} status={status}>
      <TaskCard
        task={task}
        onOpen={openTask}
        showChannelName={!isChannelMode}
        footerEnd={renderFooterEnd?.(task)}
        titleEnd={renderTitleEnd?.(task)}
        current={currentTaskId === task.id}
        selected={selectedTaskIds?.has(task.id) ?? false}
      />
    </BoardTaskItem>
  ), [currentTaskId, isChannelMode, openTask, renderFooterEnd, renderTitleEnd, selectedTaskIds, status]);
  return (
    <TaskBoardColumn
      render={
        <TaskDropZone
          id={columnDropId}
          data={columnDropData}
          data-drop-collapsed={collapsed ? "true" : undefined}
        />
      }
      open={!collapsed}
      onOpenChange={handleOpenChange}
      data-testid={`task-board-column-${status}`}
    >
      <TaskBoardColumnTrigger
        aria-label={formatMessage(
          { id: collapsed ? "task.status.showGroup" : "task.status.hideGroup" },
          { status: statusLabel },
        )}
      >
        <TaskBoardColumnHeading>
          <TaskBoardColumnBadge status={ruiStatus}>
            {statusLabel}
          </TaskBoardColumnBadge>
          {placeholders === undefined ? <TaskBoardColumnCount>{count ?? statusTasks.length}</TaskBoardColumnCount> : null}
        </TaskBoardColumnHeading>
        <TaskBoardColumnChevron><ChevronDown aria-hidden /></TaskBoardColumnChevron>
      </TaskBoardColumnTrigger>
      <TaskBoardColumnPanel>
        <TaskBoardColumnItems>
          {placeholders !== undefined ? (
            <LanePlaceholders
              count={placeholders}
              gapClassName="gap-2"
              empty={(
                <TaskBoardColumnEmpty className="invisible" aria-hidden="true">
                  <TaskBoardColumnEmptyIdle>
                    {formatMessage({ id: "task.status.emptyGroup" }, { status: statusLabel })}
                  </TaskBoardColumnEmptyIdle>
                </TaskBoardColumnEmpty>
              )}
            />
          ) : visibleTasks.length === 0 ? (
            loadingPage || pendingFirstPage ? (
              <TaskCardSkeleton />
            ) : (
              <>
                <TaskBoardColumnEmpty>
                  <TaskBoardColumnEmptyIdle>
                    {formatMessage({ id: "task.status.emptyGroup" }, { status: statusLabel })}
                  </TaskBoardColumnEmptyIdle>
                  <TaskBoardColumnEmptyAllowed>
                    {formatMessage({ id: "task.status.dropToSet" }, { status: statusLabel })}
                  </TaskBoardColumnEmptyAllowed>
                  <TaskBoardColumnEmptyBlocked>
                    {blockedReason ?? formatMessage({ id: "task.status.cannotMoveTo" }, { status: statusLabel })}
                  </TaskBoardColumnEmptyBlocked>
                </TaskBoardColumnEmpty>
              </>
            )
          ) : (
            <VirtualizedTaskStack
              items={visibleTasks}
              scrollElementRef={scrollElementRef}
              estimateSize={116}
              gap={BOARD_CARD_GAP}
              getItemKey={getTaskKey}
              renderItem={renderTask}
            />
          )}
          {hasMore && loadMoreOnScroll && onLoadMore ? (
            <>
              {loadingPage && visibleTasks.length > 0 ? <TaskCardSkeleton /> : null}
              <LoadMoreSentinel onLoadMore={onLoadMore} loading={loadingPage} failed={loadMoreFailed} testId={`task-load-more-${status}`} />
            </>
          ) : hasMore && (
            <Button
              type="button"
              size="md"
              variant="outline"
              disabled={loadingPage}
              onClick={onLoadMore}
              className="w-full"
              data-testid={`task-load-more-${status}`}
            >
              {loadingPage ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "task.panel.loadMore" })}
            </Button>
          )}
        </TaskBoardColumnItems>
      </TaskBoardColumnPanel>
    </TaskBoardColumn>
  );
}

/**
 * Reusable Creator/Assignee filter chip + popover.
 *
 * Mirrors the existing Channel filter chip pattern:
 *   - Pill-style button with active color + selected count
 *   - Click opens a searchable list of options
 *   - Multi-select with checkmark; "Clear" empties this chip's selection
 *
 * The Assignee variant also accepts an `unassigned` sentinel — it's
 * injected as an extra (synthetic) row into the same searchable+sorted
 * list as real members so users can "show me tasks no one's claimed"
 * without it being pinned above the list. Per stdrc 2026-05-17 review
 * (#proj-task:572c5ba6 msg=00807fe5): "unassigned 不应该 sticky".
 *
 * Single-popover-at-a-time is enforced by the parent: each chip is given
 * an `isOpen` prop and the parent tracks which chip key (if any) is open.
 */
export function IdentityFilterChip({
  icon,
  label,
  options,
  selected,
  onChange,
  includeUnassigned = false,
  selfOption = null,
  isOpen,
  onOpenChange,
  labelOrder,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  options: IdentityOption[];
  selected: readonly IdentityFilterValue[];
  onChange: (next: IdentityFilterValue[]) => void;
  includeUnassigned?: boolean;
  /**
   * Optional "me" special row (Created by me / Assigned to me). Surfaced as a
   * sentinel like Unassigned — its key is the current user's real identity
   * value, so toggling it is the same selection a user would make by checking
   * their own row. The duplicate normal avatar row for that identity is
   * dropped so "me" appears exactly once. stdrc 2026-05-19 msg=58495043.
   */
  selfOption?: { key: IdentityFilterValue; label: string } | null;
  isOpen: boolean;
  /** The popover's trigger, outside presses and Escape all report here. */
  onOpenChange: (open: boolean) => void;
  /** When its label gives way in its FitToolbar (FitToolbarPicker). */
  labelOrder: number;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const [search, setSearch] = useState("");
  // Each opening starts from an empty search.
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) setSearch("");
    onOpenChange(open);
  }, [onOpenChange]);

  // Inject the synthetic "Unassigned" row at the top of the option list. It
  // scrolls with the list (not sticky) but always sorts first so it stays
  // discoverable without alphabetical pinning. stdrc 2026-05-18
  // #proj-task:572c5ba6 msg=806c19c0: "unsigned 应该排第一个并且没有头像，但
  // 不应该 sticky". The sentinel keeps `type: "user"` because IdentityOption
  // is a members-or-agents union; downstream code branches on `isSentinel`,
  // not on `type`.
  const selfKey = selfOption?.key ?? null;
  const selfLabel = selfOption?.label ?? null;
  const optionsWithSentinel = useMemo<IdentityOption[]>(() => {
    // The "me" special row carries the user's real identity value, so its
    // normal avatar row would be a duplicate — drop it from the pool.
    const base = selfKey ? options.filter((o) => o.key !== selfKey) : options;
    if (!includeUnassigned && !selfKey) return base;
    const sortedMembers = [...base].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    // Special sentinel rows sort first (not sticky — they scroll with the
    // list), label-only + italic via SelectionPopover row. Order: "me" then
    // "Unassigned" then alphabetical members.
    const sentinels: IdentityOption[] = [];
    if (selfKey && selfLabel) {
      sentinels.push({
        key: selfKey,
        type: "user",
        id: String(selfKey),
        label: selfLabel,
        handle: "me",
        isSentinel: true,
      });
    }
    if (includeUnassigned) {
      sentinels.push({
        key: "unassigned",
        type: "user",
        id: "unassigned",
        label: formatMessage({ id: "task.filter.unassigned" }),
        handle: "unassigned",
        isSentinel: true,
      });
    }
    return [...sentinels, ...sortedMembers];
  }, [options, includeUnassigned, selfKey, selfLabel, formatMessage]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return optionsWithSentinel;
    const needle = search.trim().toLowerCase();
    return optionsWithSentinel.filter(
      (opt) =>
        opt.label.toLowerCase().includes(needle) ||
        opt.handle.toLowerCase().includes(needle),
    );
  }, [optionsWithSentinel, search]);

  const toggleValue = useCallback((value: IdentityFilterValue) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }, [onChange, selected]);

  const clearSelection = useCallback(() => onChange([]), [onChange]);

  const popoverOptions = useMemo(() => filteredOptions.map((opt) => ({
    key: opt.key,
    checked: selected.includes(opt.key),
    onClick: () => toggleValue(opt.key),
    label: opt.label,
    italic: opt.isSentinel,
    reserveLeadingSlot: true,
    // Sentinel ("Unassigned") renders label-only — no avatar,
    // per stdrc 2026-05-18 msg=806c19c0. The shared popover row still
    // reserves the size-5 slot for identity filters so its height and label
    // baseline stay identical to real compact-list AvatarSlot rows (size-5,
    // 1px border, 18px pixel/photo).
    avatar: opt.isSentinel ? null : (
      <AvatarSlot
        context="compact-list"
        type={opt.type === "agent" ? "agent" : "human"}
        agentAvatarUrl={opt.type === "agent" ? opt.avatarUrl ?? null : null}
        humanAvatarUrl={opt.type === "user" ? opt.avatarUrl ?? null : null}
      />
    ),
  })), [filteredOptions, selected, toggleValue]);

  // raft-ui Popover: the list is placed in a portal against the chip and kept
  // on screen; the popover owns the toggle, outside presses and Escape.
  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <FitToolbarPicker
        trigger={<PopoverTrigger />}
        icon={icon}
        value={selected.length > 0 ? selected.length : undefined}
        labelOrder={labelOrder}
        data-active={selected.length > 0 ? "" : undefined}
        data-testid={testId}
      >
        {label}
      </FitToolbarPicker>
      <SelectionPopover
        title={label}
        searchable
        search={search}
        onSearchChange={setSearch}
        options={popoverOptions}
        showClear={selected.length > 0}
        onClear={clearSelection}
      />
    </Popover>
  );
}

/**
 * The Channel filter chip + popover (server-wide Tasks views): a searchable
 * multi-select of the server's channels, as the Creator/Assignee chips.
 * Single-popover-at-a-time is the parent's, as for those.
 */
export function ChannelFilterChip({
  selected,
  onChange,
  isOpen,
  onOpenChange,
  labelOrder,
  testId,
}: {
  selected: readonly string[];
  onChange: (next: string[]) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** When its label gives way in its FitToolbar (FitToolbarPicker). */
  labelOrder: number;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  // Search box state for the channel filter popover, reset on (re)open so the
  // popover doesn't reopen with stale text. stdrc 2026-05-18
  // #proj-task:572c5ba6 msg=d6a82cc9: "channel filter 也应该加上搜索".
  const [search, setSearch] = useState("");
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) setSearch("");
    onOpenChange(open);
  }, [onOpenChange]);
  const options = useMemo(() => {
    return [...channels]
      .filter((channel) => channel.type === "channel" || channel.type === "private")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels]);
  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const needle = search.trim().toLowerCase();
    return options.filter((channel) => channel.name.toLowerCase().includes(needle));
  }, [options, search]);
  const popoverOptions = useMemo(() => filtered.map((channel) => ({
    key: channel.id,
    checked: selected.includes(channel.id),
    onClick: () => onChange(selected.includes(channel.id)
      ? selected.filter((id) => id !== channel.id)
      : [...selected, channel.id]),
    label: `#${channel.name}`,
  })), [filtered, onChange, selected]);
  const clear = useCallback(() => onChange([]), [onChange]);
  const channelLabel = formatMessage({ id: "task.panel.channelColumn" });
  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <FitToolbarPicker
        trigger={<PopoverTrigger />}
        icon={<Hash />}
        value={selected.length > 0 ? selected.length : undefined}
        labelOrder={labelOrder}
        data-active={selected.length > 0 ? "" : undefined}
        data-testid={testId}
      >
        {channelLabel}
      </FitToolbarPicker>
      <SelectionPopover
        title={formatMessage({ id: "task.filter.channels" })}
        searchable
        search={search}
        onSearchChange={setSearch}
        options={popoverOptions}
        showClear={selected.length > 0}
        onClear={clear}
      />
    </Popover>
  );
}

/**
 * Server-wide Tasks page (no `channelId`) and channel-scoped Task tab
 * (`channelId` provided) share the same panel implementation so the user sees
 * one Board/List view, one card style, one drag-drop affordance regardless of
 * surface. Channel mode hides the cross-channel filter, swaps the data source
 * to the per-channel `tasks` slice (already loaded with `loadTasks`), and
 * exposes a "New Task" button. The page-level "Tasks" header is also dropped
 * in channel mode because ChatPanel already shows the channel header above.
 *
 * stdrc 2026-05-07 #proj-task task #3:
 *   "channel 里的 Task Tab 直接和 Tasks 页面统一，实现整个页面和 Layout 的复用…
 *    就把它做成一个 proper 的 To-do 面板看板视图就行，然后卡片的状态能支持拖拽"
 *
 * Mobile default: list view (board requires horizontal scroll, awkward on
 * narrow viewports). User can switch to board via the segmented control.
 */
export interface TasksPanelProps {
  /** When set, render in channel mode (no channel filter, scoped task list,
   *  no top page header, and a New Task button). */
  channelId?: string;
}

export default function TasksPanel({ channelId }: TasksPanelProps = {}) {
  const { formatMessage } = useIntl();
  const isChannelMode = !!channelId;

  // One-time snapshot: if the device is a narrow viewport on first render,
  // default to list view so mobile users don't land on a wide horizontal board.
  const [isMobile] = useState(() => !window.matchMedia("(min-width: 768px)").matches);
  const [storedViewMode, setStoredViewMode] = useState<ViewMode | null>(() => readStoredTaskViewMode());

  const [searchParams, setSearchParams] = useLiveSearchParams();
  const serverTasks = useTaskStore((s) => s.serverTasks);
  const channelTasks = useTaskStore((s) => s.tasks);
  const serverLoading = useTaskStore((s) => s.serverLoading);
  const channelLoading = useTaskStore((s) => s.loading);
  const loadActiveTaskSummaries = useTaskStore((s) => s.loadActiveTaskSummaries);
  const loadServerTaskStatusPage = useTaskStore((s) => s.loadServerTaskStatusPage);
  const serverTaskPages = useTaskStore((s) => s.serverTaskPages);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const registerServerTasksConsumer = useTaskStore((s) => s.registerServerTasksConsumer);
  const unregisterServerTasksConsumer = useTaskStore((s) => s.unregisterServerTasksConsumer);
  const tasks = isChannelMode ? channelTasks : serverTasks;
  const loading = isChannelMode ? channelLoading : serverLoading;
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const canManageServer = capabilities.deleteAnyTask;
  const openThread = useThreadStore((s) => s.openThread);
  const closeThread = useThreadStore((s) => s.closeThread);
  const threadPanelOpen = useThreadStore((s) => !!s.openParentMessageId);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const legacyTaskPanelOpen = useLegacyTaskPanelStore((s) => !!s.task);
  // Single-popover-at-a-time: tracks which chip's popover is currently open,
  // null when none. Click on the open chip closes it; click on a different
  // chip swaps. The previous channel-only state was a boolean — now that we
  // have three chips we need a discriminator.
  const [openFilter, setOpenFilter] = useState<"channel" | "creator" | "assignee" | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  // Backlog (work not planned now) and both terminal states (done, closed) start
  // collapsed to keep visual focus on active work. Users can expand explicitly.
  const [collapsedStatuses, setCollapsedStatuses] = useState<Record<TaskStatus, boolean>>({
    backlog: true,
    todo: false,
    in_progress: false,
    in_review: false,
    done: true,
    closed: true,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previousContainerWidthRef = useRef<number | null>(null);
  const rightPanelOpenRef = useRef(false);

  // URL param wins when present. Otherwise preserve the user's last explicit
  // Tasks view choice across channel route changes before falling back to the
  // platform default (list on mobile, board on desktop).
  const viewMode: ViewMode = useMemo(() => {
    const param = parseTaskViewMode(searchParams.get("view"));
    if (param) return param;
    if (storedViewMode) return storedViewMode;
    return isMobile ? "list" : "board";
  }, [searchParams, storedViewMode, isMobile]);

  // The board is the touch-drag surface (see utils/touchDragRegion): only it,
  // and only in board mode, keeps touches cancelable for TaskDndProvider's
  // touch sensor (hold 500ms, then move; a swipe still scrolls the board).
  const isBoardView = viewMode === "board";
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    const releaseDragRegion = isBoardView ? touchDragRegion(node) : undefined;
    return () => {
      releaseDragRegion?.();
      scrollContainerRef.current = null;
    };
  }, [isBoardView]);

  // On the phone the server-wide Tasks page is a tab root like Home, Activity
  // and More: the 56px frame bar names it (the page's one h1) with its count,
  // no large title (design lead + artin 2026-10-21). Its filter row moves into
  // the scroller as the first child and pins under the bar, like Activity's.
  const isPhone = useMediaQuery("(max-width: 767px)");
  const isPhoneTabRoot = !isChannelMode && isPhone;
  // The Tasks tab root: a re-tap scrolls it to the top, and its scroll
  // position survives a switch to another tab (its filters are in the URL,
  // which the tab bar brings back).
  useTabRootScroll(isPhoneTabRoot ? "tasks" : null, scrollContainerRef);
  // The pinned filter row's height, kept clear above the vertical scrollbar.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarRailInset = usePinnedHeadRailInset(toolbarRef, isPhoneTabRoot);

  useEffect(() => {
    if (isChannelMode) {
      loadTasks(channelId!);
    } else {
      // Server mode first screen loads the small active-status summary pages;
      // done/closed lanes stay lazy (expand / "Load more"), so the panel never
      // issues the unparameterized full-row /tasks/server load.
      loadActiveTaskSummaries();
    }
  }, [isChannelMode, channelId, loadTasks, loadActiveTaskSummaries]);

  // Register this server-Tasks view as an active consumer so a socket reconnect
  // can catch it up (see catchUpServerTasksOnReconnect). Channel mode does not
  // use the server-tasks list, so it does not register (#210).
  useEffect(() => {
    if (isChannelMode) return;
    registerServerTasksConsumer();
    return () => unregisterServerTasksConsumer();
  }, [isChannelMode, registerServerTasksConsumer, unregisterServerTasksConsumer]);


  useEffect(() => {
    rightPanelOpenRef.current = threadPanelOpen || legacyTaskPanelOpen;
  }, [threadPanelOpen, legacyTaskPanelOpen]);

  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;

    if (previousContainerWidthRef.current == null) {
      previousContainerWidthRef.current = node.clientWidth;
    }

    const observer = new ResizeObserver(() => {
      const previousWidth = previousContainerWidthRef.current;
      const nextWidth = node.clientWidth;
      previousContainerWidthRef.current = nextWidth;

      if (!previousWidth) return;
      const widthDelta = previousWidth - nextWidth;
      if (widthDelta <= 0) return;
      if (!rightPanelOpenRef.current) return;

      node.scrollLeft += widthDelta;
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const identityOptions = useTaskIdentityOptions();

  const selectedChannelIds = useMemo(
    () => searchParams.getAll("channel").filter(Boolean),
    [searchParams],
  );
  const selectedCreators = useMemo(
    () => searchParams.getAll("creator").filter(Boolean),
    [searchParams],
  );
  const selectedAssignees = useMemo(
    () => searchParams.getAll("assignee").filter(Boolean),
    [searchParams],
  );

  // Current user's identity value, surfaced as the "Created by me" /
  // "Assigned to me" special sentinel rows inside the Creator / Assignee
  // popovers (see IdentityFilterChip selfOption).
  const myUserKey = currentUserId ? `user:${currentUserId}` : null;

  const filteredTasks = useMemo(() => {
    // Channel mode: store already gives us only this channel's tasks; ignore
    // any leftover ?channel= URL params (those belong to server mode).
    let result = tasks;
    if (!isChannelMode && selectedChannelIds.length > 0) {
      const selected = new Set(selectedChannelIds);
      result = result.filter((task) => selected.has(task.channelId));
    }
    // AND composition between chips: a task must satisfy every active filter.
    // Within a chip, multi-select is OR (any of the selected creators).
    if (selectedCreators.length > 0) {
      const creatorSet = new Set(selectedCreators);
      result = result.filter((task) =>
        creatorSet.has(`${task.createdByType}:${task.createdById}`),
      );
    }
    if (selectedAssignees.length > 0) {
      // `unassigned` is a sentinel value: matches tasks with no claimer.
      // Mixing `unassigned` with explicit IDs means "either no claimer OR
      // these specific people" — same OR semantics as other multi-selects.
      const matchUnassigned = selectedAssignees.includes("unassigned");
      const assigneeIdSet = new Set(
        selectedAssignees.filter((v) => v !== "unassigned"),
      );
      result = result.filter((task) => {
        if (!task.claimedById || !task.claimedByType) return matchUnassigned;
        return assigneeIdSet.has(`${task.claimedByType}:${task.claimedById}`);
      });
    }
    return result;
  }, [
    isChannelMode,
    tasks,
    selectedChannelIds,
    selectedCreators,
    selectedAssignees,
  ]);

  const hasIdentityFilter = selectedCreators.length > 0 || selectedAssignees.length > 0;
  const hasAnyFilter = selectedChannelIds.length > 0 || hasIdentityFilter;

  // Task v2: a task opens on its own conversation, keyed by the task.
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;

  const sortedTasks = useMemo(() => sortTasks(filteredTasks), [filteredTasks]);
  // in_review is retired for task v2 (#wg-task-v2:f7043517): no empty lane for
  // it; a pre-v2 task still in it keeps its lane so it stays reachable. Backlog
  // is task v2 only, the other way round: no empty lane for it with the flag off.
  const groupedTasks = useMemo(() => {
    return STATUS_ORDER.map((status) => ({
      status,
      tasks: sortedTasks.filter((task) => task.status === status),
    })).filter(({ status, tasks }) => tasks.length > 0 || status !== (taskV2 ? "in_review" : "backlog"));
  }, [sortedTasks, taskV2]);

  // While the tasks load, the board or list is drawn with its lanes (the
  // lanes groupedTasks shows, plus a hidden one that had cards last time),
  // each open lane with as many card placeholders as it had the last time it
  // loaded here, for this person on this server (taskLaneCounts), so the
  // cards land where their placeholders were (#proj-raft-ui:#231). A filter
  // changes what a lane holds, so filtered views neither read nor write it.
  const laneCountServerId = useServerStore((s) => s.current?.id);
  const laneCounts = useMemo(() => {
    if (loading || hasAnyFilter) return null;
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const { status, tasks: laneTasks } of groupedTasks) {
      // A server lane that has not been read (a folded one) says nothing.
      if (isChannelMode || serverTaskPages[status].loaded) counts[status] = laneTasks.length;
    }
    return counts;
  }, [loading, hasAnyFilter, groupedTasks, isChannelMode, serverTaskPages]);
  const rememberedLaneCounts = useRememberedTaskLaneCounts({
    userId: currentUserId,
    serverId: laneCountServerId,
    scope: isChannelMode ? `channel:${channelId}` : "server",
    enabled: !hasAnyFilter,
    loading,
    loaded: laneCounts,
  });
  const loadingLanes = useMemo(() => STATUS_ORDER
    .filter((status) => status !== (taskV2 ? "in_review" : "backlog") || (rememberedLaneCounts[status] ?? 0) > 0)
    .map((status) => ({ status, tasks: [] as Task[], placeholders: taskLanePlaceholders(rememberedLaneCounts[status]) })),
  [rememberedLaneCounts, taskV2]);
  const lanes: { status: TaskStatus; tasks: Task[]; placeholders?: number }[] = loading ? loadingLanes : groupedTasks;

  // A server with zero ACTIVE tasks still has its backlog/done/closed lanes
  // unfetched on first screen; only show the blanket empty state once every
  // shown lane has loaded, otherwise the collapsed sections must stay reachable.
  const allServerLanesLoaded = groupedTasks.every(({ status }) => serverTaskPages[status].loaded);

  // Per-lane lazy paging props (server mode only): a "Load more" affordance
  // while the lane's walk has a next cursor.
  const lanePagingProps = (status: TaskStatus) => {
    if (isChannelMode) return {};
    const lane = serverTaskPages[status];
    return {
      hasMore: lane.loaded && lane.nextCursor !== null,
      loadingPage: lane.loading,
      onLoadMore: () => void loadServerTaskStatusPage(status),
    };
  };

  const setSelectedChannels = useCallback((channelIds: string[]) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("channel");
      for (const channelId of channelIds) {
        next.append("channel", channelId);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedCreators = useCallback((values: IdentityFilterValue[]) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("creator");
      for (const v of values) next.append("creator", v);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedAssignees = useCallback((values: IdentityFilterValue[]) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("assignee");
      for (const v of values) next.append("assignee", v);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const clearAllFilters = useCallback(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("channel");
      next.delete("creator");
      next.delete("assignee");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setView = useCallback((nextView: ViewMode) => {
    setStoredViewMode(nextView);
    writeStoredTaskViewMode(nextView);
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      // Only write a URL param when the view differs from the platform default;
      // otherwise remove it so the URL stays clean.
      const platformDefault: ViewMode = isMobile ? "list" : "board";
      if (nextView === platformDefault) {
        next.delete("view");
      } else {
        next.set("view", nextView);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams, isMobile]);

  // One filter popover at a time: opening one replaces the other; a close
  // only clears the one that closed.
  const handleChannelPopoverOpenChange = useCallback((open: boolean) => {
    setOpenFilter((prev) => (open ? "channel" : prev === "channel" ? null : prev));
  }, []);
  const handleCreatorPopoverOpenChange = useCallback((open: boolean) => {
    setOpenFilter((prev) => (open ? "creator" : prev === "creator" ? null : prev));
  }, []);
  const handleAssigneePopoverOpenChange = useCallback((open: boolean) => {
    setOpenFilter((prev) => (open ? "assignee" : prev === "assignee" ? null : prev));
  }, []);

  const creatorSelfOption = useMemo(
    () => (myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.createdByMe" }) } : null),
    [myUserKey, formatMessage],
  );
  const assigneeSelfOption = useMemo(
    () => (myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.assignedToMe" }) } : null),
    [myUserKey, formatMessage],
  );

  const openCreateDialog = useCallback(() => setShowCreateDialog(true), []);
  const closeCreateDialog = useCallback(() => setShowCreateDialog(false), []);

  const toggleStatusCollapsed = useCallback((status: TaskStatus) => {
    // Expanding a never-loaded lane (backlog/done/closed start collapsed + unloaded in
    // server mode) lazily pulls its first summary page.
    if (!isChannelMode && collapsedStatuses[status]) {
      const lane = useTaskStore.getState().serverTaskPages[status];
      if (!lane.loaded && !lane.loading) void loadServerTaskStatusPage(status);
    }
    setCollapsedStatuses((prev) => ({ ...prev, [status]: !prev[status] }));
  }, [isChannelMode, collapsedStatuses, loadServerTaskStatusPage]);

  // Stable across renders so the memoized TaskCard rows don't all re-render
  // when an unrelated task updates. Deps are all zustand action refs (stable).
  const openTask = useCallback((task: Task) => {
    closeProfile();
    if (task.isLegacy) {
      closeThread();
      openLegacyTask(task);
      return;
    }
    closeLegacyTask();
    // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
    // `intent: "task"` is required, not decorative. The host decides modal-vs-side-panel
    // from the declared intent; a task opened from the board without it falls through to a
    // plain side thread with no title, status or assignee — the task disappears into its
    // own discussion. It used to be carried implicitly by the `/tasks` route test, which
    // never matched the in-channel Tasks tab.
    if (opensAsTaskConversation(task, taskV2)) {
      // Task v2: the task dialog on the task's own conversation — for a task
      // made the v2 way whatever the flag says (its messageId is no message).
      openTaskConversationDialog(task);
      return;
    }
    void openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
    // Stryker restore all
  }, [closeProfile, closeThread, closeLegacyTask, openLegacyTask, openThread, taskV2]);

  const boardDrag = useTaskBoardDrag({ tasks, taskV2, currentUserId, canManageServer });
  const { activeTaskId, activeTask, blockedReasons } = boardDrag;

  const clearAllLabel = formatMessage({ id: "task.panel.clearAll" });
  const newTaskLabel = formatMessage({ id: "task.board.newTask" });
  const viewSwitchOptions = useMemo(() => [
    { value: "board" as const, label: formatMessage({ id: "task.view.board" }), icon: <Columns3 size={16} aria-hidden="true" />, testId: "channel-task-view-board" },
    { value: "list" as const, label: formatMessage({ id: "task.view.list" }), icon: <LayoutList size={16} aria-hidden="true" />, testId: "channel-task-view-list" },
  ], [formatMessage]);
  const viewMenuOptions = useMemo(() => viewSwitchOptions.map(({ value, label }) => ({ value, label })), [viewSwitchOptions]);
  // The toolbar over the list (Raft DS › The toolbar over a list), on raft-ui's FitToolbar: no search, so
  // the filters fill the one line and scroll in it (Clear all pinned at their end), then Board / List and,
  // in channel mode, New task, the primary action, last. As it narrows: Board / List shows its icons, the
  // filters theirs, New task becomes +, and Board / List folds into ⋯.
  const toolbar = (
    <TasksPanelToolbar ref={isPhoneTabRoot ? toolbarRef : undefined} className={isPhoneTabRoot ? `${TOOLBAR_CLASS} ${PHONE_ROOT_TOOLBAR_CLASS}` : TOOLBAR_CLASS}>
      <FitToolbar aria-label={formatMessage({ id: "task.panel.heading" })} className="w-full gap-2">
        <FitToolbarGroup
          overflow="scroll"
          className="gap-2"
          data-testid="tasks-toolbar-filters"
          end={hasAnyFilter ? (
            <FitToolbarButton variant="ghost" collapsedIcon={<X />} labelOrder={LIST_TOOLBAR_STEP.filterLabels} onClick={clearAllFilters}>
              {clearAllLabel}
            </FitToolbarButton>
          ) : null}
        >
          {/* Channel filter only makes sense in server mode — channel mode
              is already scoped to one channel. */}
          {!isChannelMode && (
            <ChannelFilterChip
              selected={selectedChannelIds}
              onChange={setSelectedChannels}
              isOpen={openFilter === "channel"}
              onOpenChange={handleChannelPopoverOpenChange}
              labelOrder={LIST_TOOLBAR_STEP.filterLabels}
            />
          )}
          {/* Creator + Assignee: the same identity pool (humans + agents of
              the server) feeds both popovers. "Created by me" / "Assigned to
              me" are rows inside them (stdrc 2026-05-19 #proj-task:572c5ba6). */}
          <IdentityFilterChip
            icon={<UserCircle2 />}
            label={formatMessage({ id: "task.filter.creator" })}
            options={identityOptions}
            selected={selectedCreators}
            onChange={setSelectedCreators}
            selfOption={creatorSelfOption}
            isOpen={openFilter === "creator"}
            onOpenChange={handleCreatorPopoverOpenChange}
            labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          />
          <IdentityFilterChip
            icon={<UserIcon />}
            label={formatMessage({ id: "task.filter.assignee" })}
            options={identityOptions}
            selected={selectedAssignees}
            onChange={setSelectedAssignees}
            includeUnassigned
            selfOption={assigneeSelfOption}
            isOpen={openFilter === "assignee"}
            onOpenChange={handleAssigneePopoverOpenChange}
            labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          />
        </FitToolbarGroup>
        <FitToolbarGroup
          firstLine
          className="gap-2"
          moreOrder={LIST_TOOLBAR_STEP.displayMore}
          moreItem={<MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.view" })} value={viewMode} options={viewMenuOptions} onValueChange={setView} testId="tasks-toolbar-more-view" />}
        >
          <ListViewSwitch value={viewMode} options={viewSwitchOptions} onValueChange={setView} label={formatMessage({ id: "task.viewAria" })} />
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className={isChannelMode ? "gap-2" : LIST_TOOLBAR_MORE_GROUP_CLASS}>
          <ListToolbarMore testId="tasks-toolbar-more" />
          {/* New task: channel mode only. The server-wide board has no channel
              to post a task in, so it offers none. */}
          {isChannelMode && (
            <FitToolbarButton variant="primary" icon={<Plus />} plusOrder={LIST_TOOLBAR_STEP.primaryPlus} onClick={openCreateDialog}>
              {newTaskLabel}
            </FitToolbarButton>
          )}
        </FitToolbarGroup>
      </FitToolbar>
    </TasksPanelToolbar>
  );

  return (
    <TasksPanelRoot
      className="flex min-h-0 flex-1 flex-col"
      data-testid={isChannelMode ? "channel-task-panel" : undefined}
    >
      {/* Server-mode page header. Channel mode is mounted inside ChatPanel
          which already shows the channel header, so a second "Tasks" title
          would be redundant — drop straight into the toolbar.
          Raft DS › Panel / NavBar: the head names the page and carries no icon
          tile (the yellow location block belongs to a channel). On the phone
          this is the Tasks tab root, so it sits in the frame like the other
          tab roots (TabRootBar): raft-ui's section head, white on desktop and
          the frame on a phone, the page name its one h1 there. The Board/List
          toggle lives in the filter row, not here. */}
      {!isChannelMode && (
        <TabRootBar
          name={formatMessage({ id: "task.panel.heading" })}
          headingLevel={isPhoneTabRoot ? 1 : 2}
          // No count before the tasks are read ("0 channel tasks" while they
          // load): the line's box stays, empty.
          subtitle={loading ? "\u00a0" : (
            <span>
              <span className="font-mono">{sortedTasks.length}</span>
              {hasAnyFilter ? formatMessage({ id: "task.panel.ofTotal" }, { total: tasks.length }) : ""}
              {" "}{formatMessage({ id: "task.panel.channelTasks" })}
            </span>
          )}
        />
      )}

      {isPhoneTabRoot ? null : toolbar}

      {/* raft-ui ScrollArea, both ways (the board scrolls sideways); the
          scrollbars show while it is pointed at or scrolls, as on every page
          scroller. On the phone the pinned filter row is inside it, so the
          vertical scrollbar starts below it (railInset). */}
      <ScrollArea
        ref={viewportRef}
        orientation="both"
        data-task-virtual-scroll
        railInset={isPhoneTabRoot ? toolbarRailInset : undefined}
        className={VIEWPORT_CLASS}
        // The floating-tab-bar clearance belongs to the Tasks tab root only —
        // channel-detail panes have no capsule above them (task #678).
        contentClassName={`${VIEWPORT_CONTENT_CLASS}${isChannelMode ? "" : " mobile-nav-clearance"}${isPhoneTabRoot ? PHONE_ROOT_VIEWPORT_CLASS : ""}`}
      >
        {isPhoneTabRoot && toolbar}
        {/* Loading, the board or list itself with placeholders in its lanes. */}
        {!loading && sortedTasks.length === 0 && (isChannelMode || allServerLanesLoaded) ? (
          <EmptyState
            className="flex flex-1 flex-col items-center justify-center"
            icon={<ListTodo size={36} />}
            title={hasAnyFilter ? formatMessage({ id: "emptyState.noTasksFiltered" }) : formatMessage({ id: "emptyState.noTasksTitle" })}
            description={hasAnyFilter
              ? formatMessage({ id: "task.filter.noMatchHint" })
              : isChannelMode
                ? formatMessage({ id: "task.panel.createWithNewTask" })
                : formatMessage({ id: "task.panel.serverWideExcluded" })}
          />
        ) : viewMode === "board" ? (
          <TaskDndProvider
            isDropAllowed={boardDrag.isDropAllowed}
            onDragStart={boardDrag.handleDragStart}
            onDragCancel={boardDrag.handleDragFinish}
            onDragEnd={boardDrag.handleDragFinish}
            onMove={boardDrag.handleMove}
          >
            <TaskVirtualLayout
              scrollElementRef={scrollContainerRef}
              data-testid="channel-task-board-view"
              aria-busy={loading || undefined}
            >
              <TaskBoardRoot>
                {lanes.map(({ status, tasks: statusTasks, placeholders }) => (
                  <BoardColumn
                    key={status}
                    status={status}
                    collapsed={collapsedStatuses[status]}
                    onToggleCollapsed={toggleStatusCollapsed}
                    statusTasks={statusTasks}
                    activeTaskId={activeTaskId}
                    blockedReason={blockedReasons[status]}
                    openTask={openTask}
                    isChannelMode={isChannelMode}
                    scrollElementRef={scrollContainerRef}
                    placeholders={placeholders}
                    {...(loading ? {} : lanePagingProps(status))}
                  />
                ))}
              </TaskBoardRoot>
            </TaskVirtualLayout>
            {/* The board is a raft-ui ScrollArea, its own stacking context (and its scrollbar the top layer in it):
                a copy left in place would be covered by the rail and the top bar. On the body, as sideSectionDrag does. */}
            <TaskDragOverlay container={document.body}>
              {activeTask == null ? null : (
                <TaskCard
                  task={activeTask}
                  onOpen={openTask}
                  showChannelName={!isChannelMode}
                />
              )}
            </TaskDragOverlay>
          </TaskDndProvider>
        ) : (
          <TaskVirtualLayout
            scrollElementRef={scrollContainerRef}
            className="stack-y-6"
            aria-busy={loading || undefined}
          >
            {lanes.map(({ status, tasks: statusTasks, placeholders }) => (
              <TaskSection
                key={status}
                status={status}
                tasks={statusTasks}
                onOpenTask={openTask}
                collapsed={collapsedStatuses[status]}
                onToggleCollapsed={toggleStatusCollapsed}
                showChannelName={!isChannelMode}
                scrollElementRef={scrollContainerRef}
                placeholders={placeholders}
                {...(loading ? {} : lanePagingProps(status))}
              />
            ))}
          </TaskVirtualLayout>
        )}
      </ScrollArea>

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

      {showCreateDialog && channelId && (
        <CreateTaskDialog
          channelId={channelId}
          onClose={closeCreateDialog}
        />
      )}
    </TasksPanelRoot>
  );
}
