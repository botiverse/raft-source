import { useCallback, useId, useMemo } from "react";
import { useIntl } from "react-intl";
import { Skeleton, TaskBoardColumnEmpty } from "@botiverse/raft-ui";

import type { MessageId } from "../../../i18n/messages";
import type { Task } from "../../../store/taskStore";
import { SkeletonTextBar } from "../../ui/Skeleton";
import { COMPACT_LIST_PAGE, COMPACT_ROW_BODY, COMPACT_ROW_DIVIDER, COMPACT_ROW_SELECT_GUTTER, COMPACT_ROW_TRAILING } from "../compactRow";
import { StatusBadge, TASK_STATUS_UI } from "../StatusBadge";
import TaskChipList from "../TaskChipList";
import type { TaskRowSelection } from "../TaskChipList";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import type { ServerTaskSort } from "./tasksPageApi";
import { allListLane, mineSectionLanes } from "./tasksPageModel";
import type { LaneSpec, MineSection, PageFilters, TasksPageTab } from "./tasksPageModel";
import { TaskActivityTime } from "./TasksPageRowParts";
import { useMergedTasksLanes } from "./useTasksPageData";

const SECTION_TITLE_IDS: Record<MineSection, MessageId> = {
  assigned: "task.page.section.assigned",
  started: "task.page.section.started",
};

/**
 * A loading list: the page's box of rows, each row built from the loaded row's
 * own classes (its check box's gutter, its body's padding, line height and
 * wrapping), so a row placeholder is the loaded row's size and changes with it.
 * The title takes the title group's room; the trailing group (channel,
 * assignee, status, time) sits at the right, and where the Tasks column is
 * narrow (a phone) it wraps to a second line, as a loaded row's does.
 */
function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className={COMPACT_LIST_PAGE} aria-hidden="true" data-testid="tasks-page-rows-loading">
      {Array.from({ length: rows }, (_, index) => <RowSkeleton key={index} />)}
    </div>
  );
}

function RowSkeleton() {
  const { formatMessage } = useIntl();
  return (
    <div className={`relative flex w-full min-w-0 items-stretch ${COMPACT_ROW_DIVIDER}`} data-testid="tasks-page-row-loading">
      <span className={COMPACT_ROW_SELECT_GUTTER}><span className="size-5" /></span>
      <div className={`${COMPACT_ROW_BODY} min-w-0 flex-1 pl-2`}>
        <span className="min-w-0 flex-[1_1_10rem] text-callout"><SkeletonTextBar className="w-2/3" /></span>
        {/* The loaded row's trailing group: a text bar, then the status
            chip's own box (an invisible StatusBadge under a block), which
            sits on the text's baseline and so makes the line as tall as a
            loaded row's. */}
        <span className={`${COMPACT_ROW_TRAILING} justify-end text-callout @max-md/tasks:basis-full`}>
          <span><SkeletonTextBar className="w-20" /></span>
          {/* The page's rows show the channel, so on a phone the chip is its
              icon only (TaskChipList), and so is this one. */}
          <span className="relative flex">
            <StatusBadge status="todo" className="invisible"><span className="@max-md/tasks:sr-only">{formatMessage({ id: TASK_STATUS_UI.todo.labelId })}</span></StatusBadge>
            <Skeleton variant="block" className="absolute inset-0" />
          </span>
        </span>
      </div>
    </div>
  );
}

/** A 我的 section's heading: its title, then its total once known. */
function SectionHeading({ section, id, total, headingLevel }: {
  section: MineSection;
  id?: string;
  total: number | null;
  headingLevel: 2 | 3;
}) {
  const { formatMessage } = useIntl();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <Heading id={id} className="m-0 mb-3 flex items-baseline gap-2 text-subhead font-bold text-foreground">
      {formatMessage({ id: SECTION_TITLE_IDS[section] })}
      {total !== null ? (
        <span className="font-mono text-mono-meta font-normal text-foreground-hint" data-testid={`tasks-page-section-count-${section}`}>{total}</span>
      ) : null}
    </Heading>
  );
}

/**
 * The list while the page's counts load: what the loaded list will be. 我的,
 * its two sections, each its heading (no total yet) over a few rows; 全部, one
 * box of rows.
 */
export function TasksListSkeleton({ tab, headingLevel }: { tab: TasksPageTab; headingLevel: 2 | 3 }) {
  if (tab === "all") return <RowsSkeleton rows={6} />;
  return (
    <div className="flex flex-col gap-9" aria-hidden="true" data-testid="tasks-page-mine-loading">
      {(["assigned", "started"] as const).map((section) => (
        <div key={section}>
          <SectionHeading section={section} total={null} headingLevel={headingLevel} />
          <RowsSkeleton rows={3} />
        </div>
      ))}
    </div>
  );
}

const renderTime = (task: Task) => <TaskActivityTime task={task} />;

interface ListProps {
  filters: PageFilters;
  sort: ServerTaskSort;
  openTask: (task: Task) => void;
  currentTaskId: string | null;
  selection: TaskRowSelection;
  /** The numbers are the server's for the live changes so far. */
  countCurrent: boolean;
}

/**
 * The page as a list. 我的: two sections, 分配给你 (assigned to me; no
 * assignee column, it is always the reader) and 你发起的 (created by me or
 * from my message, someone else's or nobody's), each its title and its
 * total, no words under it. 全部: one flat list of every task the person can
 * see. Rows are the one-line compact row, read a page at a time as the end
 * of a list scrolls into view; a row can be selected (TaskRowSelection).
 */
export function TasksListView({ tab, sections, doneSince, total, headingLevel, ...props }: ListProps & {
  tab: TasksPageTab;
  /** 我的: each section's server total. */
  sections: Record<MineSection, number> | null;
  /** 你发起的 keeps tasks done since this instant. */
  doneSince: string;
  /** 全部: the list's server total. */
  total: number | null;
  /** The sections' headings, one under the page's own (h1 on a phone, h2 on desktop). */
  headingLevel: 2 | 3;
}) {
  const { formatMessage } = useIntl();
  if (tab === "all") {
    return (
      <section aria-label={formatMessage({ id: "task.page.allAria" })} data-testid="tasks-page-all-list">
        <AllList {...props} total={total} />
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-9" data-testid="tasks-page-mine">
      {(["assigned", "started"] as const).map((section) => (
        <MineSectionBlock
          key={section}
          {...props}
          section={section}
          total={sections?.[section] ?? null}
          doneSince={doneSince}
          headingLevel={headingLevel}
        />
      ))}
    </div>
  );
}

function AllList({ filters, sort, total, ...props }: ListProps & { total: number | null }) {
  const lanes = useMemo(() => [allListLane(filters, sort)], [filters, sort]);
  return <LaneRows {...props} lanes={lanes} total={total} showAssignee testId="tasks-page-list-all" />;
}

function MineSectionBlock({ section, filters, sort, total, doneSince, headingLevel, ...props }: ListProps & {
  section: MineSection;
  total: number | null;
  doneSince: string;
  headingLevel: 2 | 3;
}) {
  const headingId = useId();
  const lanes = useMemo(() => mineSectionLanes(section, filters, sort, doneSince), [doneSince, filters, section, sort]);
  return (
    <section aria-labelledby={headingId} data-testid={`tasks-page-section-${section}`}>
      <SectionHeading section={section} id={headingId} total={total} headingLevel={headingLevel} />
      <LaneRows
        {...props}
        lanes={lanes}
        total={total}
        showAssignee={section !== "assigned"}
        testId={`tasks-page-list-${section}`}
      />
    </section>
  );
}

/**
 * The rows of one list (one lane, or several merged), read a page at a time:
 * the first when its end comes into view, the next as it scrolls on. Empty, it
 * says so in one word.
 */
function LaneRows({ lanes, total, showAssignee, testId, openTask, currentTaskId, selection, countCurrent }: Omit<ListProps, "filters" | "sort"> & {
  /** Memoized. */
  lanes: readonly LaneSpec[];
  total: number | null;
  showAssignee: boolean;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const view = useMergedTasksLanes(lanes, countCurrent ? total : null, false);
  const open = useCallback((task: Task) => openTask(task), [openTask]);
  if (view.tasks.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <TaskChipList
          tasks={view.tasks}
          onOpenTask={open}
          variant="page"
          wrapTitle
          showChannel
          showAssignee={showAssignee}
          showUnassigned
          renderTime={renderTime}
          currentTaskId={currentTaskId}
          selection={selection}
          testId={testId}
        />
        {view.hasMore ? (
          <LoadMoreSentinel onLoadMore={view.loadMore} loading={view.loading} failed={view.failed} testId={`${testId}-more`} />
        ) : null}
        {view.loading ? <RowsSkeleton rows={2} /> : null}
      </div>
    );
  }
  if ((total === null || total > 0) && !view.loaded) {
    return (
      <>
        {view.failed ? null : <RowsSkeleton rows={Math.min(total ?? 3, 3)} />}
        <LoadMoreSentinel onLoadMore={view.loadMore} loading={view.loading} failed={view.failed} testId={`${testId}-more`} />
      </>
    );
  }
  return (
    <TaskBoardColumnEmpty data-testid={`${testId}-empty`}>
      {formatMessage({ id: "task.page.sectionEmpty" })}
    </TaskBoardColumnEmpty>
  );
}
