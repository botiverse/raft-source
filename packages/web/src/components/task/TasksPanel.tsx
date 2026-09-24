import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { CheckSquare, ChevronDown, Columns3, Hash, LayoutList, Plus, User as UserIcon, UserCircle2 } from "lucide-react";
import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useProfileStore } from "../../store/profileStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import TaskCard from "./TaskCard";
import CreateTaskDialog from "./CreateTaskDialog";
import { TASK_STATUS_UI } from "./taskStatusUi";
import EmptyState from "../ui/EmptyState";
import { SkeletonRow } from "../ui/Skeleton";
import AvatarSlot from "../ui/AvatarSlot";
import SelectionPopover from "../ui/SelectionPopover";
import VirtualizedTaskStack, { TaskVirtualLayout } from "./VirtualizedTaskStack";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { buildLegacyTaskWindowUrl, buildThreadWindowUrl, openPanelInNewTab } from "../../utils/openPanelInNewTab";

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

interface IdentityOption {
  key: IdentityFilterValue;
  type: "user" | "agent";
  id: string;
  label: string;
  /** Stable @handle / mention name for searchability + tie-break */
  handle: string;
  /** Avatar identity — passed to AvatarSlot. Agents use `avatarUrl`; humans
   *  use `avatarUrl` / `gravatarHash` / `email`. Absent on the synthetic
   *  "Unassigned" sentinel, which renders as `humanPlaceholder`. */
  avatarUrl?: string | null;
  gravatarHash?: string | null;
  email?: string | null;
  /** True for the synthetic "Unassigned" row. Suppresses avatar lookup and
   *  italicizes the label so the sentinel stays visually distinct from a
   *  real member while still flowing through the same sorted+searchable
   *  list (no longer pinned). */
  isSentinel?: boolean;
}

type ViewMode = "board" | "list";

const TASK_VIEW_MODE_STORAGE_KEY = "slock.tasks.viewMode";

const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return b.taskNumber - a.taskNumber;
  });
}

function parseTaskViewMode(value: string | null): ViewMode | null {
  return value === "board" || value === "list" ? value : null;
}

function readStoredTaskViewMode(): ViewMode | null {
  try {
    return parseTaskViewMode(window.localStorage.getItem(TASK_VIEW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredTaskViewMode(nextView: ViewMode): void {
  try {
    window.localStorage.setItem(TASK_VIEW_MODE_STORAGE_KEY, nextView);
  } catch {
    // Ignore storage failures; the URL param and platform default still work.
  }
}

function TaskSection({
  status,
  tasks,
  onOpenTask,
  onOpenTaskInNewTab,
  onDragTask,
  collapsed = false,
  onToggleCollapsed,
  showChannelName = true,
  scrollElementRef,
}: {
  status: TaskStatus;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onOpenTaskInNewTab?: (task: Task) => void;
  onDragTask?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  showChannelName?: boolean;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className="space-y-2.5">
      <button
        type="button"
        onClick={onToggleCollapsed}
        disabled={!onToggleCollapsed}
        aria-label={formatMessage(
          { id: collapsed ? "task.status.showGroup" : "task.status.hideGroup" },
          { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
        )}
        className={`flex w-full items-center justify-between gap-3 text-left ${onToggleCollapsed ? "" : "cursor-default"}`}
      >
        <div className="flex items-center gap-2">
          <span className={`border border-black px-2 py-0.5 text-[10px] font-bold uppercase ${TASK_STATUS_UI[status].bg}`}>
            {formatMessage({ id: TASK_STATUS_UI[status].labelId })}
          </span>
          <span className="text-xs font-mono text-black/50">{tasks.length}</span>
        </div>
        {onToggleCollapsed ? (
          <span className="inline-flex items-center text-black/50 hover:text-black">
            <ChevronDown size={14} className={`transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </span>
        ) : (
          <span />
        )}
      </button>
      {!collapsed && tasks.length === 0 ? (
        <div className="border-2 border-dashed border-black/20 px-3 py-5 text-sm text-black/40">
          {formatMessage(
            { id: "task.status.emptyGroup" },
            { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
          )}
        </div>
      ) : !collapsed ? (
        <VirtualizedTaskStack
          items={tasks}
          scrollElementRef={scrollElementRef}
          estimateSize={116}
          gap={10}
          getItemKey={(task) => task.id}
          renderItem={(task) => (
            <TaskCard
              task={task}
              onOpen={onOpenTask}
              onOpenInNewTab={onOpenTaskInNewTab}
              onDragStart={onDragTask}
              showChannelName={showChannelName}
            />
          )}
        />
      ) : null}
    </section>
  );
}

/**
 * Drag-handle wrapper around TaskCard for board-view drag-drop.
 *
 * Uses @dnd-kit/core `useDraggable` instead of the HTML5 Drag API so that
 * pointer events (mouse, stylus) and touch events work identically. The
 * PointerSensor + TouchSensor combination in DndContext handles both surfaces;
 * the TouchSensor's delay constraint distinguishes a hold-to-drag from a
 * horizontal scroll gesture.
 *
 * Click / tap → TaskCard.onOpen still fires normally when the drag activation
 * constraint is not met (PointerSensor: distance 5px, TouchSensor: 200ms hold).
 */
function DraggableTaskWrapper({
  task,
  children,
  disabled = false,
}: {
  task: Task;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled });
  const dragStyle = {
    transform: CSS.Translate.toString(transform),
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-testid="task-board-draggable-card"
      style={dragStyle}
      className={`relative ${disabled ? "" : "cursor-grab touch-none will-change-transform active:cursor-grabbing"} ${isDragging ? "opacity-90" : ""}`}
    >
      {children}
    </div>
  );
}

/**
 * One status column in the board view. Uses `useDroppable` so that tasks can
 * be dragged into it from any other column; `isOver` drives the highlight state.
 */
function DroppableColumn({
  status,
  collapsed,
  onToggleCollapsed,
  statusTasks,
  openTask,
  openTaskInNewTab,
  onDragTask,
  isChannelMode,
  scrollElementRef,
  canModifyTasks,
}: {
  status: TaskStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  statusTasks: Task[];
  openTask: (task: Task) => void;
  openTaskInNewTab?: (task: Task) => void;
  onDragTask?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
  isChannelMode: boolean;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  canModifyTasks: boolean;
}) {
  const { formatMessage } = useIntl();
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !canModifyTasks });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-[320px] shrink-0 self-start flex-col border-2 ${
        isOver ? "border-black bg-soft-signal/20 shadow-brutal-sm" : "border-black/20 bg-white/30"
      } p-3 transition-colors`}
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={formatMessage(
          { id: collapsed ? "task.status.showGroup" : "task.status.hideGroup" },
          { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
        )}
        className={`flex w-full items-center justify-between gap-3 text-left ${collapsed ? "" : "mb-3"}`}
      >
        <div className="flex items-center gap-2">
          <span className={`border border-black px-2 py-0.5 text-[10px] font-bold uppercase ${TASK_STATUS_UI[status].bg}`}>
            {formatMessage({ id: TASK_STATUS_UI[status].labelId })}
          </span>
          <span className="text-xs font-mono text-black/50">{statusTasks.length}</span>
        </div>
        <span className="inline-flex items-center text-black/50 hover:text-black">
          <ChevronDown size={14} className={`transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-2.5">
          {statusTasks.length === 0 ? (
            <div className={`border-2 border-dashed px-3 py-5 text-sm ${
              isOver ? "border-black text-black/60" : "border-black/20 text-black/40"
            }`}>
              {formatMessage(
                { id: isOver ? "task.status.dropToSet" : "task.status.emptyGroup" },
                { status: formatMessage({ id: TASK_STATUS_UI[status].labelId }) },
              )}
            </div>
          ) : (
            <VirtualizedTaskStack
              items={statusTasks}
              scrollElementRef={scrollElementRef}
              estimateSize={116}
              gap={10}
              getItemKey={(task) => task.id}
              renderItem={(task) => (
                <DraggableTaskWrapper task={task} disabled={!canModifyTasks}>
                  <TaskCard
                    task={task}
                    onOpen={openTask}
                    onOpenInNewTab={openTaskInNewTab}
                    onDragStart={onDragTask}
                    showChannelName={!isChannelMode}
                  />
                </DraggableTaskWrapper>
              )}
            />
          )}
        </div>
      )}
    </div>
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
function IdentityFilterChip({
  icon,
  label,
  options,
  selected,
  onChange,
  includeUnassigned = false,
  selfOption = null,
  isOpen,
  onToggleOpen,
}: {
  icon: React.ReactNode;
  label: string;
  options: IdentityOption[];
  selected: IdentityFilterValue[];
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
  onToggleOpen: () => void;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    // Reset search input when dropdown opens. Intentional reset-on-open, not
    // prop-derived state.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSearch("");
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onToggleOpen();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onToggleOpen]);

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

  const toggleValue = (value: IdentityFilterValue) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  const popoverOptions = filteredOptions.map((opt) => ({
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
    // 1px border, 18px pixel/gravatar).
    avatar: opt.isSentinel ? null : (
      <AvatarSlot
        context="compact-list"
        type={opt.type === "agent" ? "agent" : "human"}
        agentAvatarUrl={opt.type === "agent" ? opt.avatarUrl ?? null : null}
        humanAvatarUrl={opt.type === "user" ? opt.avatarUrl ?? null : null}
        gravatarHash={opt.type === "user" ? opt.gravatarHash ?? null : null}
        email={opt.type === "user" ? opt.email ?? null : null}
      />
    ),
  }));

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        className={`inline-flex items-center gap-2 border-2 px-3 py-1.5 text-xs font-bold transition-colors ${
          selected.length > 0
            ? "border-black bg-soft-signal text-black shadow-brutal-sm"
            : "border-black/30 bg-white text-black/70 hover:border-black"
        }`}
      >
        {icon}
        {label}
        {selected.length > 0 && (
          <span className="border border-black px-1 py-0.5 font-mono text-[10px] leading-none">
            {selected.length}
          </span>
        )}
        <ChevronDown size={12} />
      </button>

      {isOpen && (
        <SelectionPopover
          title={label}
          searchable
          search={search}
          onSearchChange={setSearch}
          options={popoverOptions}
          showClear={selected.length > 0}
          onClear={() => onChange([])}
        />
      )}
    </div>
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
  /** Optional host override for surfaces like workspace-grid that need task
   *  activation to open inside their own tab model instead of the global
   *  right-panel thread store. */
  onOpenTask?: (task: Task) => void;
  onOpenTaskInNewTab?: (task: Task) => void;
  onDragTask?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
}

export default function TasksPanel({ channelId, onOpenTask, onOpenTaskInNewTab, onDragTask }: TasksPanelProps = {}) {
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
  const loadServerTasks = useTaskStore((s) => s.loadServerTasks);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const registerServerTasksConsumer = useTaskStore((s) => s.registerServerTasksConsumer);
  const unregisterServerTasksConsumer = useTaskStore((s) => s.unregisterServerTasksConsumer);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const tasks = isChannelMode ? channelTasks : serverTasks;
  const loading = isChannelMode ? channelLoading : serverLoading;
  const channels = useChannelStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { role } = useServerPermissions();
  const canModifyTasks = role !== "guest";
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
  // Search box state for the channel filter popover. Mirrors how
  // IdentityFilterChip handles its own `search` — reset on (re)open so the
  // popover doesn't reopen with stale text. stdrc 2026-05-18
  // #proj-task:572c5ba6 msg=d6a82cc9: "channel filter 也应该加上搜索".
  const [channelSearch, setChannelSearch] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  // Both terminal states (done, closed) start collapsed to keep visual focus
  // on active work. Users can expand explicitly.
  const [collapsedStatuses, setCollapsedStatuses] = useState<Record<TaskStatus, boolean>>({
    todo: false,
    in_progress: false,
    in_review: false,
    done: true,
    closed: true,
  });
  const channelFilterRef = useRef<HTMLDivElement>(null);
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

  // dnd-kit sensors — PointerSensor for mouse/stylus, TouchSensor for touch.
  // TouchSensor delay:200 / tolerance:5 distinguishes hold-to-drag from
  // quick tap (opens card) and from horizontal scroll swipe (moves viewport).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  useEffect(() => {
    if (isChannelMode) {
      loadTasks(channelId!);
    } else {
      loadServerTasks();
    }
  }, [isChannelMode, channelId, loadTasks, loadServerTasks]);

  // Register this server-Tasks view as an active consumer so a socket reconnect
  // can catch it up (see catchUpServerTasksOnReconnect). Channel mode does not
  // use the server-tasks list, so it does not register (#210).
  useEffect(() => {
    if (isChannelMode) return;
    registerServerTasksConsumer();
    return () => unregisterServerTasksConsumer();
  }, [isChannelMode, registerServerTasksConsumer, unregisterServerTasksConsumer]);

  useEffect(() => {
    if (openFilter !== "channel") return;
    setChannelSearch("");
    const handleClickOutside = (event: MouseEvent) => {
      if (channelFilterRef.current && !channelFilterRef.current.contains(event.target as Node)) {
        setOpenFilter((prev) => (prev === "channel" ? null : prev));
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openFilter]);

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

  const channelOptions = useMemo(() => {
    return [...channels]
      .filter((channel) => channel.type === "channel" || channel.type === "private")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels]);

  const filteredChannelOptions = useMemo(() => {
    if (!channelSearch.trim()) return channelOptions;
    const needle = channelSearch.trim().toLowerCase();
    return channelOptions.filter((channel) =>
      channel.name.toLowerCase().includes(needle),
    );
  }, [channelOptions, channelSearch]);

  /**
   * Combined identity options for Creator + Assignee popovers.
   * Humans and agents share the same shape because both can author or claim
   * a task. We flag the kind so the popover renders a distinguishing badge
   * (H / A) and so the selection encoding stays unambiguous.
   *
   * Stable sort by display label keeps the list's visual order independent
   * from the order events arrive in the underlying Zustand stores.
   */
  const identityOptions = useMemo<IdentityOption[]>(() => {
    const humans = members.map<IdentityOption>((m) => ({
      key: `user:${m.userId}`,
      type: "user",
      id: m.userId,
      label: m.displayName || m.name,
      handle: m.name,
      avatarUrl: m.avatarUrl,
      gravatarHash: m.gravatarHash,
      email: m.email,
    }));
    const agentOpts = agents
      .filter((a) => !a.deletedAt)
      .map<IdentityOption>((a) => ({
        key: `agent:${a.id}`,
        type: "agent",
        id: a.id,
        label: a.displayName || a.name,
        handle: a.name,
        avatarUrl: a.avatarUrl,
      }));
    return [...humans, ...agentOpts].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [members, agents]);

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

  const sortedTasks = useMemo(() => sortTasks(filteredTasks), [filteredTasks]);
  const groupedTasks = useMemo(() => {
    return STATUS_ORDER.map((status) => ({
      status,
      tasks: sortedTasks.filter((task) => task.status === status),
    }));
  }, [sortedTasks]);

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

  const toggleChannelFilter = useCallback((channelId: string) => {
    const nextIds = selectedChannelIds.includes(channelId)
      ? selectedChannelIds.filter((id) => id !== channelId)
      : [...selectedChannelIds, channelId];
    setSelectedChannels(nextIds);
  }, [selectedChannelIds, setSelectedChannels]);

  const clearChannelFilters = useCallback(() => {
    setSelectedChannels([]);
  }, [setSelectedChannels]);

  const toggleStatusCollapsed = useCallback((status: TaskStatus) => {
    setCollapsedStatuses((prev) => ({ ...prev, [status]: !prev[status] }));
  }, []);

  // Stable across renders so the memoized TaskCard rows don't all re-render
  // when an unrelated task updates. Deps are all zustand action refs (stable).
  const openTask = useCallback((task: Task) => {
    // Stryker disable all: this host override is contract-pinned; the fallback
    // task-opening behavior below retains its existing behavioral coverage.
    if (onOpenTask) {
      onOpenTask(task);
      return;
    }
    // Stryker restore all
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
    void openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
    // Stryker restore all
  }, [closeProfile, closeThread, closeLegacyTask, onOpenTask, openLegacyTask, openThread]);

  const openTaskInNewTab = useCallback((task: Task) => {
    const current = useServerStore.getState().current;
    if (!current?.slug) return;
    const channel = useChannelStore.getState().channels.find((candidate) => candidate.id === task.channelId);
    const location = { pathname: window.location.pathname, search: window.location.search, origin: window.location.origin };
    const url = task.isLegacy
      ? buildLegacyTaskWindowUrl(location, { serverSlug: current.slug, channelId: task.channelId, taskId: task.id, channelType: channel?.type === "dm" ? "dm" : "channel" })
      : buildThreadWindowUrl(location, { serverSlug: current.slug, parentChannelId: task.channelId, parentMessageId: task.messageId, parentChannelType: channel?.type === "dm" ? "dm" : "channel" }, "task");
    openPanelInNewTab(url);
  }, []);
  const taskNewTabHandler = onOpenTaskInNewTab ?? openTaskInNewTab;

  /**
   * Resolves a dnd-kit drag-end event into a task status update.
   *
   * `over.id` is the TaskStatus string we set as the droppable id in
   * DroppableColumn. `active.id` is the task UUID from DraggableTaskWrapper.
   * Bail-out cases: dropped outside any column, same-status drop.
   */
  const handleDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      if (!canModifyTasks) return;
      if (!over) return;
      const targetStatus = over.id as TaskStatus;
      const task = tasks.find((t) => t.id === active.id);
      if (!task || task.status === targetStatus) return;
      try {
        await updateTaskStatus(task.channelId, task.id, targetStatus);
      } catch (err) {
        console.error("Drag-drop status update failed:", err);
      }
    },
    [canModifyTasks, tasks, updateTaskStatus],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={isChannelMode ? "channel-task-panel" : undefined}
    >
      {/* Server-mode page header. Channel mode is mounted inside ChatPanel
          which already shows the channel header, so a second "Tasks" title
          would be redundant — drop straight into the toolbar. */}
      {!isChannelMode && (
        <div className="flex h-panel-header items-center gap-3 border-b-2 border-black bg-soft-signal px-5 md:bg-white">
          <div className="hidden md:flex size-icon-header items-center justify-center border-2 border-black bg-soft-signal">
            <CheckSquare size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-base leading-tight">{formatMessage({ id: "task.panel.heading" })}</h2>
            <p className="text-xs text-black/50 font-mono">
              {sortedTasks.length}
              {hasAnyFilter ? formatMessage({ id: "task.panel.ofTotal" }, { total: tasks.length }) : ""}
              {" "}{formatMessage({ id: "task.panel.channelTasks" })}
            </p>
          </div>
          {/* Board/List toggle lives in the filter row below on both
              desktop and mobile, per @stdrc msg efec44d1 2026-05-01
              `#proj-uiux:c8711d2a`: "Board 和 List 的选择，无论在桌面端
              还是在移动端，都可以都放到 Filter 那一栏，然后放到右边。" */}
        </div>
      )}

      <div className="shrink-0 border-b-2 border-black bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Channel filter only makes sense in server mode — channel mode
              is already scoped to one channel. */}
          {!isChannelMode && (
            <div ref={channelFilterRef} className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenFilter((prev) => (prev === "channel" ? null : "channel"))
                }
                className={`inline-flex items-center gap-2 border-2 px-3 py-1.5 text-xs font-bold transition-colors ${
                  selectedChannelIds.length > 0
                    ? "border-black bg-soft-signal text-black shadow-brutal-sm"
                    : "border-black/30 bg-white text-black/70 hover:border-black"
                }`}
              >
                <Hash size={14} />
                {formatMessage({ id: "task.panel.channelColumn" })}
                {selectedChannelIds.length > 0 && (
                  <span className="border border-black px-1 py-0.5 font-mono text-[10px] leading-none">
                    {selectedChannelIds.length}
                  </span>
                )}
                <ChevronDown size={12} />
              </button>

              {openFilter === "channel" && (
                <SelectionPopover
                  title={formatMessage({ id: "task.filter.channels" })}
                  searchable
                  search={channelSearch}
                  onSearchChange={setChannelSearch}
                  options={filteredChannelOptions.map((channel) => ({
                    key: channel.id,
                    checked: selectedChannelIds.includes(channel.id),
                    onClick: () => toggleChannelFilter(channel.id),
                    label: `#${channel.name}`,
                  }))}
                  showClear={selectedChannelIds.length > 0}
                  onClear={clearChannelFilters}
                />
              )}
            </div>
          )}

          {/* Creator + Assignee chips: available in both server- and
              channel-mode. The same identity pool (humans + agents from the
              current server) feeds both popovers. */}
          <IdentityFilterChip
            icon={<UserCircle2 size={14} />}
            label={formatMessage({ id: "task.filter.creator" })}
            options={identityOptions}
            selected={selectedCreators}
            onChange={setSelectedCreators}
            selfOption={myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.createdByMe" }) } : null}
            isOpen={openFilter === "creator"}
            onToggleOpen={() =>
              setOpenFilter((prev) => (prev === "creator" ? null : "creator"))
            }
          />
          <IdentityFilterChip
            icon={<UserIcon size={14} />}
            label={formatMessage({ id: "task.filter.assignee" })}
            options={identityOptions}
            selected={selectedAssignees}
            onChange={setSelectedAssignees}
            includeUnassigned
            selfOption={myUserKey ? { key: myUserKey, label: formatMessage({ id: "task.filter.assignedToMe" }) } : null}
            isOpen={openFilter === "assignee"}
            onToggleOpen={() =>
              setOpenFilter((prev) => (prev === "assignee" ? null : "assignee"))
            }
          />

          {/* "Created by me" / "Assigned to me" are no longer standalone
              buttons — they live inside the Creator / Assignee popovers as
              special sentinel rows (like Unassigned). stdrc 2026-05-19
              #proj-task:572c5ba6 msg=58495043. */}

          {hasAnyFilter && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-2 border border-black bg-white px-2.5 py-1 text-[11px] font-bold text-black/60 hover:text-black"
            >
              {formatMessage({ id: "task.panel.clearAll" })}
            </button>
          )}

          {/* New Task button: channel mode only. Server-wide page has no
              implicit channel context to anchor task creation, so we don't
              expose a +New CTA there — users still create from the channel
              they want the task in. */}
          {isChannelMode && canModifyTasks && (
            <button
              type="button"
              onClick={() => setShowCreateDialog(true)}
              className="btn-brutal-sm inline-flex items-center gap-1 bg-brutal-pink px-2 py-1 text-xs font-bold"
            >
              <Plus size={12} />
              {formatMessage({ id: "task.board.newTask" })}
            </button>
          )}

          <SegmentedControl
            value={viewMode}
            onValueChange={setView}
            aria-label={formatMessage({ id: "task.viewAria" })}
            className="ml-auto"
          >
            <SegmentedControlItem value="board" data-testid="channel-task-view-board">
              <Columns3 size={12} />
              <SegmentedControlLabel>{formatMessage({ id: "task.view.board" })}</SegmentedControlLabel>
            </SegmentedControlItem>
            <SegmentedControlItem value="list" data-testid="channel-task-view-list">
              <LayoutList size={12} />
              <SegmentedControlLabel>{formatMessage({ id: "task.view.list" })}</SegmentedControlLabel>
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        data-task-virtual-scroll
        className="flex-1 overflow-auto bg-white p-4 safe-bottom"
      >
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonRow
                key={i}
                className="gap-2 rounded border-2 border-black/30 p-3"
                lineWidths={["w-1/2", "w-3/4"]}
              />
            ))}
          </div>
        ) : sortedTasks.length === 0 ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center"
            icon={<CheckSquare size={36} />}
            title={hasAnyFilter ? formatMessage({ id: "emptyState.noTasksFiltered" }) : formatMessage({ id: "emptyState.noTasksTitle" })}
            description={hasAnyFilter
              ? formatMessage({ id: "task.filter.noMatchHint" })
              : isChannelMode
                ? formatMessage({ id: "task.panel.createWithNewTask" })
                : formatMessage({ id: "task.panel.serverWideExcluded" })}
          />
        ) : viewMode === "board" ? (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <TaskVirtualLayout
              scrollElementRef={scrollContainerRef}
              data-testid="channel-task-board-view"
              className="flex min-w-max items-start gap-4 pr-4"
            >
              {groupedTasks.map(({ status, tasks: statusTasks }) => (
                <DroppableColumn
                  key={status}
                  status={status}
                  collapsed={collapsedStatuses[status]}
                  onToggleCollapsed={() => toggleStatusCollapsed(status)}
                  statusTasks={statusTasks}
                  openTask={openTask}
                  openTaskInNewTab={taskNewTabHandler}
                  onDragTask={canModifyTasks ? onDragTask : undefined}
                  isChannelMode={isChannelMode}
                  scrollElementRef={scrollContainerRef}
                  canModifyTasks={canModifyTasks}
                />
              ))}
            </TaskVirtualLayout>
          </DndContext>
        ) : (
          <TaskVirtualLayout scrollElementRef={scrollContainerRef} className="space-y-6">
            {groupedTasks.map(({ status, tasks: statusTasks }) => (
              <TaskSection
                key={status}
                status={status}
                tasks={statusTasks}
                onOpenTask={openTask}
                onOpenTaskInNewTab={taskNewTabHandler}
                onDragTask={canModifyTasks ? onDragTask : undefined}
                collapsed={collapsedStatuses[status]}
                onToggleCollapsed={() => toggleStatusCollapsed(status)}
                showChannelName={!isChannelMode}
                scrollElementRef={scrollContainerRef}
              />
            ))}
          </TaskVirtualLayout>
        )}
      </div>

      {showCreateDialog && channelId && (
        <CreateTaskDialog
          channelId={channelId}
          onClose={() => setShowCreateDialog(false)}
        />
      )}
    </div>
  );
}
