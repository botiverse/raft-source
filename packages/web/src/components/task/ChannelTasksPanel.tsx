import { useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight, ListTodo, Plus } from "lucide-react";
import {
  TaskStatusIcon,
  TasksPanelToolbar,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
  ScrollArea,
} from "@botiverse/raft-ui";
import { FitToolbar } from "@botiverse/raft-ui/wip";

import { useChannelMembers } from "../../hooks/useChannelMembers";
import { useAuthStore } from "../../store/authStore";
import { selectChannelTaskBucket, useTaskStore } from "../../store/taskStore";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useChannelSideCardStore } from "../../store/channelSideCardStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { requestComposerTaskMode } from "../../features/composer/composerTaskMode";
import type { ChannelTasksFilter } from "../../store/channelSideCardStore";
import ChannelSideCard from "./ChannelSideCard";
import EmptyState from "../ui/EmptyState";
import { TaskAssigneeLabel } from "./TaskAssignee";
import { CreateTaskDialog } from "./DeferredCreateTaskDialog";
import TaskChipList from "./TaskChipList";
import { TASK_STATUS_UI, toRuiTaskStatus } from "./taskStatusUi";
import { useOpenTask } from "./useOpenTask";
import { SideCardContext } from "./sideCardsLayout";

/** Work that is moving first (In Progress, In Review), then what waits (Todo,
 *  Backlog), then what is over; Backlog, Done and Closed start folded and are not
 *  counted. A deliberate exception to the DS board order (Backlog first) for a
 *  narrow card — recorded in raft-design patterns/tasks.md. */
const STATUS_ORDER: TaskStatus[] = ["in_progress", "in_review", "todo", "backlog", "done", "closed"];
const ACTIVE_STATUSES = new Set<TaskStatus>(["todo", "in_progress", "in_review"]);
const INITIALLY_COLLAPSED: Record<TaskStatus, boolean> = {
  backlog: true,
  todo: false,
  in_progress: false,
  in_review: false,
  done: true,
  closed: true,
};

export function isTaskOnViewer(task: Task, viewerId: string | null | undefined): boolean {
  return !!viewerId && task.claimedByType === "user" && task.claimedById === viewerId;
}

/**
 * The channel's tasks, read beside the conversation (task v2, #wg-task-v2).
 *
 * People mostly don't need to know what each task is; they need to see the
 * work moving and what is waiting on them. So the panel answers two questions:
 * "what are the agents working on here" (All) and "what is on me" (For Me),
 * with the assignee on every card. Details still open in the centered task
 * dialog — the DS keeps task details out of side panels.
 */
export default function ChannelTasksPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  const tasks = useTaskStore((s) => selectChannelTaskBucket(s, channelId));
  const loaded = useTaskStore((s) => s.loadedByChannelId[channelId] ?? false);
  const filter = useChannelSideCardStore((s) => s.taskFilter);
  const setFilter = useChannelSideCardStore((s) => s.setTaskFilter);
  const { channelAgents, channelHumans } = useChannelMembers(channelId);
  const openTask = useOpenTask();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(INITIALLY_COLLAPSED);
  // No fetch here: the panel only sits beside its own channel, and ChatPanel
  // already loads that channel's tasks (and realtime keeps the bucket live).

  const mine = useMemo(() => tasks.filter((t) => isTaskOnViewer(t, viewerId)), [tasks, viewerId]);
  const mineActive = useMemo(() => mine.filter((t) => ACTIVE_STATUSES.has(t.status)).length, [mine]);
  const active = useMemo(() => tasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length, [tasks]);
  const visible = filter === "mine" ? mine : tasks;
  const byStatus = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = { backlog: [], todo: [], in_progress: [], in_review: [], done: [], closed: [] };
    for (const task of visible) groups[task.status].push(task);
    for (const status of STATUS_ORDER) groups[status].sort((a, b) => b.taskNumber - a.taskNumber);
    return groups;
  }, [visible]);

  const toggleCollapsed = useCallback((status: TaskStatus) => {
    setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }));
  }, []);
  const handleFilterChange = useCallback((value: ChannelTasksFilter) => setFilter(value), [setFilter]);
  // Task v2: a task is a message sent As task (design "新建任务 = 发一条消息"), so "+" turns As task on in the
  // channel's composer beside the card. Covering the conversation (a phone), or with no composer for the
  // channel mounted, it opens the New task dialog.
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const covering = useContext(SideCardContext)?.mode === "overlay";
  const openCreate = useCallback(() => {
    if (taskV2 && !covering && requestComposerTaskMode(channelId)) return;
    setCreating(true);
  }, [channelId, covering, taskV2]);
  const closeCreate = useCallback(() => setCreating(false), []);

  // The channel roster names the assignee here (it is already loaded for the
  // card); the label is the one every task row uses.
  const renderAssignee = useCallback((task: Task) => {
    const identity = task.claimedByType === "agent"
      ? channelAgents.find((a) => a.id === task.claimedById)
      : channelHumans.find((h) => h.id === task.claimedById);
    return <TaskAssigneeLabel task={task} identity={identity} viewerId={viewerId} />;
  }, [channelAgents, channelHumans, viewerId]);

  const newTaskLabel = formatMessage({ id: "task.board.newTask" });
  const newTaskAction = useMemo(() => [{ id: "new-task", label: newTaskLabel, icon: <Plus />, onSelect: openCreate, testId: "channel-tasks-panel-new" }], [newTaskLabel, openCreate]);

  return (
    <ChannelSideCard
      title={formatMessage({ id: "task.panel.heading" })}
      closeLabelId="task.sidePanel.close"
      onClose={onClose}
      testId="channel-tasks-panel"
      // Its own action: a button where the head has room, else in its ⋯ (#189 rule 6).
      ownActions={newTaskAction}
    >
      {/* The Tasks page's toolbar spacing (20px in, 12px above and below the
          control), without its seam: a lone segmented control is no bar of its
          own, the tasks start right under it (stdrc, 2026-11-04). With a mouse
          it is part of the content: 12px under the head (page-top), the tasks 8px under
          it (stdrc, 2026-11-05). A FitToolbar, as every list's toolbar (Raft DS › The
          toolbar over a list): one Tab stop, the arrow keys between All and For me. Its
          scope stays segmented, with no Select to give way to: two short words fit any
          column. New task stays in the section's head (raft-design tasks.md › A
          channel's Tasks section). */}
      <TasksPanelToolbar className="shrink-0 border-b-0 max-md:px-4 md:pointer-fine:min-h-0 md:pointer-fine:pt-(--page-top) md:pointer-fine:pb-0" data-testid="channel-tasks-toolbar">
        <FitToolbar aria-label={formatMessage({ id: "task.panel.heading" })} className="w-full gap-2">
          <SegmentedControl<ChannelTasksFilter> value={filter} onValueChange={handleFilterChange} aria-label={formatMessage({ id: "task.sidePanel.filterAria" })}>
            <SegmentedControlItem value="all" data-testid="channel-tasks-filter-all">
              <SegmentedControlLabel>{formatMessage({ id: "task.filter.tabAll" })}</SegmentedControlLabel>
              {active > 0 ? <SegmentedControlCount>{active}</SegmentedControlCount> : null}
            </SegmentedControlItem>
            <SegmentedControlItem value="mine" data-testid="channel-tasks-filter-mine">
              <SegmentedControlLabel>{formatMessage({ id: "task.sidePanel.forMe" })}</SegmentedControlLabel>
              {mineActive > 0 ? <SegmentedControlCount>{mineActive}</SegmentedControlCount> : null}
            </SegmentedControlItem>
          </SegmentedControl>
        </FitToolbar>
      </TasksPanelToolbar>
      {/* Each task row and group heading takes focus, so the list's raft-ui
          ScrollArea is no tab stop. */}
      <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="pb-4">
        {visible.length === 0 && loaded ? (
          <EmptyState
            icon={<ListTodo />}
            title={formatMessage({ id: filter === "mine" ? "task.sidePanel.emptyMineTitle" : "task.board.emptyAll" })}
            description={formatMessage({ id: filter === "mine" ? "task.sidePanel.emptyMineBody" : "task.sidePanel.emptyAllBody" })}
          />
        ) : (
          // No gap between groups: each heading carries the space above it,
          // as the DS sidebar section header does (see CompactStatusGroup).
          <div className="flex flex-col">
            {STATUS_ORDER.filter((status) => byStatus[status].length > 0).map((status, index) => (
              <CompactStatusGroup
                key={status}
                first={index === 0}
                status={status}
                tasks={byStatus[status]}
                collapsed={collapsed[status]}
                onToggle={toggleCollapsed}
                onOpenTask={openTask}
                renderAssignee={renderAssignee}
              />
            ))}
          </div>
        )}
      </ScrollArea>
      {creating ? <CreateTaskDialog channelId={channelId} onClose={closeCreate} /> : null}
    </ChannelSideCard>
  );
}

/**
 * One status lane in the compact form: the DS section header (badge, count,
 * chevron) over the same one-line rows a message shows for its tasks. The
 * lane already names the status, so the rows leave the badge out.
 */
function CompactStatusGroup({
  status,
  tasks,
  collapsed,
  onToggle,
  onOpenTask,
  renderAssignee,
  first = false,
}: {
  /** The first group sits right under the filter: with a mouse its heading
   *  starts 8px under it, not with a group's room above. */
  first?: boolean;
  status: TaskStatus;
  tasks: Task[];
  collapsed: boolean;
  onToggle: (status: TaskStatus) => void;
  onOpenTask: (task: Task) => void;
  renderAssignee: (task: Task) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const handleOpenChange = useCallback(() => onToggle(status), [onToggle, status]);
  const label = formatMessage({ id: TASK_STATUS_UI[status].labelId });
  return (
    <section data-testid={`channel-tasks-group-${status}`}>
      <button
        type="button"
        onClick={handleOpenChange}
        aria-expanded={!collapsed}
        aria-label={formatMessage({ id: collapsed ? "task.status.showGroup" : "task.status.hideGroup" }, { status: label })}
        // On the rows' line (the section head's 20px, 16px on a phone). A heading is a label
        // over its rows, not a row: hover darkens its words and chevron and
        // lays no fill, as the DS collapsible section headers do (Sidebar
        // section, TaskListSection). A fill would read as one more row, and
        // its box (words at the bottom, room above for the target) would
        // frame the words unevenly. Spacing is the DS sidebar section
        // header's (its grouped list in a side column): 16px above the words,
        // 6px below, a 40px box and no gap between groups, so a heading is
        // about twice as far from the rows above as from its own (raft-design
        // foundations/comfort.md, Spacing rhythm). By touch its target reaches
        // 4px up, to 44px.
        className={`group relative flex h-10 w-full items-end px-4 pb-1.5 md:px-(--surface-inset) text-left text-footnote text-foreground-muted outline-none after:absolute after:inset-x-0 after:-top-1 after:bottom-0 after:content-[''] md:pointer-fine:after:top-0 hover:text-foreground focus-visible:inset-ring-2 focus-visible:inset-ring-ink ${first ? "md:pointer-fine:h-auto md:pointer-fine:pt-[7px]" : ""}`}
      >
        {/* One line, its pixel, words and chevron on one center line. */}
        <span className="flex items-center gap-1.5" data-testid="channel-tasks-heading-line">
          <TaskStatusIcon status={toRuiTaskStatus(status)} className="size-2.5 shrink-0" />
          <span>{label}</span>
          <span className="font-mono text-mono-meta text-foreground-hint">{tasks.length}</span>
          {collapsed ? <ChevronRight className="size-3.5 text-foreground-hint group-hover:text-foreground" /> : <ChevronDown className="size-3.5 text-foreground-hint group-hover:text-foreground" />}
        </span>
      </button>
      {collapsed ? null : (
        <TaskChipList
          tasks={tasks}
          onOpenTask={onOpenTask}
          showStatus={false}
          renderAssignee={renderAssignee}
          variant="plain"
          testId="channel-tasks-list"
        />
      )}
    </section>
  );
}
