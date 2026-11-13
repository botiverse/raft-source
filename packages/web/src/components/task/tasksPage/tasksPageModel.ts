import type { Task } from "../../../store/taskStore";
import { BOARD_STATUSES, serverTaskFilterParams, taskActivityAt } from "./tasksPageApi";
import type { BoardStatus, ServerTaskBoardFilters, ServerTaskRelation, ServerTaskSort } from "./tasksPageApi";

/**
 * The Tasks page (task v2) in data: which groups and columns it shows, what
 * each asks the server for, and how the rows the client already holds are
 * placed in them between reads.
 *
 * A section, a list or a board column is made of "lanes": a filtered, sorted read of
 * /tasks/server, paged on demand. What a lane shows is every task the client
 * holds (taskStore.serverTasks, kept live by the socket) that matches the
 * lane, in the lane's order, down to the last row the server has sent for it
 * (its frontier) while more pages remain. So a task that changes status or
 * assignee leaves one lane and joins another at once, and a page loaded later
 * continues exactly where the shown rows end. Totals never come from here:
 * they are the server's counts.
 */

export type TasksPageTab = "mine" | "all";

/** First page of a lane, and each page after it. */
export const LANE_PAGE_SIZE = 20;

/** The relations that make a task the person's (exclusive on the server, in this order). */
export const MINE_RELATIONS: readonly ServerTaskRelation[] = ["assigned_to_me", "created_by_me", "from_my_message"];

/**
 * 我的's two sections in the list: 分配给你 (assigned to me) and 你发起的
 * (created by me or from my message, someone else's or nobody's).
 */
export type MineSection = "assigned" | "started";
export const MINE_SECTIONS: readonly MineSection[] = ["assigned", "started"];

/** The relations 你发起的 is made of: exclusive, so its total is their sum and its rows their merge. */
export const STARTED_RELATIONS: readonly ServerTaskRelation[] = ["created_by_me", "from_my_message"];

/** What 我的 lists without a status filter: everything not finished (done / closed). */
export const UNFINISHED_STATUSES: readonly BoardStatus[] = ["backlog", "todo", "in_progress"];

/** 你发起的 also keeps a task done this recently, so the person sees it land. */
export const RECENT_DONE_MS = 24 * 60 * 60 * 1000;

/** No update for this long and an open task's time shows in the warning ink. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** The first instant 你发起的 keeps a done task from. */
/** The server takes a search this long at most (`q`): longer, from the address too, it is cut there. */
export const TASK_SEARCH_MAX_LENGTH = 200;

export function recentDoneSince(now: number = Date.now()): string {
  return new Date(now - RECENT_DONE_MS).toISOString();
}

/** The toolbar's filters and the search, as the page holds them (useTasksPageParams). */
export interface PageFilters {
  channelIds: readonly string[];
  statuses: readonly BoardStatus[];
  creators: readonly string[];
  assignees: readonly string[];
  /** The search field, trimmed. */
  query: string;
}

export const NO_PAGE_FILTERS: PageFilters = { channelIds: [], statuses: [], creators: [], assignees: [], query: "" };

/** A toolbar filter is set (Clear filters shows). The search is not one: it has its own clear. */
export function hasToolbarFilter(filters: PageFilters): boolean {
  return filters.channelIds.length + filters.statuses.length + filters.creators.length + filters.assignees.length > 0;
}

/** The page shows less than the tab holds: a filter or a search. */
export function isNarrowed(filters: PageFilters): boolean {
  return hasToolbarFilter(filters) || filters.query !== "";
}

/** The board filters of the page's filters, statuses included. */
export function serverFiltersOf(filters: PageFilters): ServerTaskBoardFilters {
  return {
    ...(filters.channelIds.length > 0 ? { channelIds: filters.channelIds } : {}),
    ...(filters.statuses.length > 0 ? { statuses: filters.statuses } : {}),
    ...(filters.creators.length > 0 ? { creators: filters.creators } : {}),
    ...(filters.assignees.length > 0 ? { assignees: filters.assignees } : {}),
    ...(filters.query ? { query: filters.query } : {}),
  };
}

/**
 * 分配给你: assigned to me; without a status filter, not finished. No
 * assignee shows on its rows (it is always the reader).
 */
export function assignedSectionFilters(filters: PageFilters): ServerTaskBoardFilters {
  return {
    ...serverFiltersOf(filters),
    relation: "assigned_to_me",
    statuses: filters.statuses.length > 0 ? filters.statuses : UNFINISHED_STATUSES,
  };
}

/**
 * 你发起的, one filter set per relation it is made of: created by me, or
 * from my message, and not assigned to me; without a status filter, not
 * finished, plus what was done since `doneSince` (`completed_since` only
 * bounds Done).
 */
export function startedSectionFilters(filters: PageFilters, doneSince: string): ServerTaskBoardFilters[] {
  const base = serverFiltersOf(filters);
  const chosen = filters.statuses.length > 0;
  return STARTED_RELATIONS.map((relation) => ({
    ...base,
    relation,
    statuses: chosen ? filters.statuses : [...UNFINISHED_STATUSES, "done"],
    ...(chosen ? {} : { completedSince: doneSince }),
  }));
}

/** The lanes of one 我的 section (rows: summaries). */
export function mineSectionLanes(section: MineSection, filters: PageFilters, sort: ServerTaskSort, doneSince: string): LaneSpec[] {
  return section === "assigned"
    ? [makeLane(assignedSectionFilters(filters), sort, "summary")]
    : startedSectionFilters(filters, doneSince).map((sectionFilters) => makeLane(sectionFilters, sort, "summary"));
}

/** 全部 as a list: every task the person can see, filtered, one lane. */
export function allListLane(filters: PageFilters, sort: ServerTaskSort): LaneSpec {
  return makeLane(serverFiltersOf(filters), sort, "summary");
}

/** The board's columns: the statuses filtered to, in the board's order, else all five. */
export function boardColumns(filters: PageFilters): readonly BoardStatus[] {
  return filters.statuses.length > 0 ? BOARD_STATUSES.filter((status) => filters.statuses.includes(status)) : BOARD_STATUSES;
}

/**
 * The filter sets one board column reads (cards: full rows): 全部 one, 我的
 * one per relation (a task is the person's by exactly one), merged.
 */
export function boardColumnFilters(tab: TasksPageTab, filters: PageFilters, status: BoardStatus): ServerTaskBoardFilters[] {
  const base: ServerTaskBoardFilters = { ...serverFiltersOf(filters), statuses: [status] };
  return tab === "all" ? [base] : MINE_RELATIONS.map((relation) => ({ ...base, relation }));
}

export function boardColumnLanes(tab: TasksPageTab, filters: PageFilters, status: BoardStatus, sort: ServerTaskSort): LaneSpec[] {
  return boardColumnFilters(tab, filters, status).map((columnFilters) => makeLane(columnFilters, sort, "full"));
}

/**
 * The counts behind the board's columns: 全部 one set, 我的 one per relation
 * (each column's number is their sum). Statuses are left to the columns.
 */
export function boardCountsFilters(tab: TasksPageTab, filters: PageFilters): ServerTaskBoardFilters[] {
  const base = serverFiltersOf({ ...filters, statuses: [] });
  return tab === "all" ? [base] : MINE_RELATIONS.map((relation) => ({ ...base, relation }));
}

/** Board columns that start folded (the approved design): what is still moving is what people come for. */
export const BOARD_FOLDED_BY_DEFAULT: ReadonlySet<BoardStatus> = new Set(["closed"]);

/** The name a board column's fold is kept under (tasksPageStore `collapsed`). */
export const boardFoldKey = (status: BoardStatus) => `board:${status}`;

/** Whether a board column is folded: as folded by hand, else by default, unless the status filter asks for it. */
export function boardColumnFolded(status: BoardStatus, filters: PageFilters, collapsed: Readonly<Record<string, boolean>>): boolean {
  return collapsed[boardFoldKey(status)] ?? (BOARD_FOLDED_BY_DEFAULT.has(status) && !filters.statuses.includes(status));
}

/**
 * Every lane the current view shows, in its order: what Select all (⌘A)
 * reads to its end. A folded board column shows none of its tasks: its lanes are not among them.
 */
export function viewLanes(
  tab: TasksPageTab,
  view: "list" | "board",
  filters: PageFilters,
  sort: ServerTaskSort,
  doneSince: string,
  collapsed: Readonly<Record<string, boolean>> = {},
): LaneSpec[] {
  if (view === "board") {
    return boardColumns(filters)
      .filter((status) => !boardColumnFolded(status, filters, collapsed))
      .flatMap((status) => boardColumnLanes(tab, filters, status, sort));
  }
  if (tab === "all") return [allListLane(filters, sort)];
  return MINE_SECTIONS.flatMap((section) => mineSectionLanes(section, filters, sort, doneSince));
}

/** An open task (Todo, In progress) nobody has updated for STALE_AFTER_MS: its time shows in the warning ink. */
export function isStaleTask(task: Pick<Task, "status" | "activityAt" | "lastActivityAt" | "updatedAt">, now: number = Date.now()): boolean {
  if (task.status !== "todo" && task.status !== "in_progress" && task.status !== "in_review") return false;
  const at = Date.parse(taskActivityAt(task));
  return Number.isFinite(at) && now - at > STALE_AFTER_MS;
}

/**
 * Whether a task matches the search as the server reads it (filters.query):
 * every word in its title, case-insensitively, or one word that is its
 * number (`12`, `#12`).
 */
export function matchesQuery(task: Pick<Task, "title" | "taskNumber">, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const title = task.title.toLowerCase();
  if (words.every((word) => title.includes(word))) return true;
  const number = words.length === 1 ? /^#?(\d{1,9})$/.exec(words[0]!) : null;
  return number !== null && task.taskNumber === Number(number[1]);
}

/** One lane: what it reads and how a row the client holds is checked against it. */
export interface LaneSpec {
  /** Stable for the same read (filters + sort + detail): the lane's cache key. */
  key: string;
  filters: ServerTaskBoardFilters;
  sort: ServerTaskSort;
  detail: "summary" | "full";
}

export function laneKey(filters: ServerTaskBoardFilters, sort: ServerTaskSort, detail: "summary" | "full"): string {
  return `${detail}|${sort}|${serverTaskFilterParams(filters).toString()}`;
}

export function makeLane(filters: ServerTaskBoardFilters, sort: ServerTaskSort, detail: "summary" | "full"): LaneSpec {
  return { key: laneKey(filters, sort, detail), filters, sort, detail };
}

/** The status a task shows under on the page: a pre-v2 In review task is In progress. */
export function boardStatusOf(task: Pick<Task, "status">): BoardStatus {
  return task.status === "in_review" ? "in_progress" : task.status;
}

function actorKey(type: string | null | undefined, id: string | null | undefined): string | null {
  return type && id ? `${type}:${id}` : null;
}

function isClaimedBy(task: Task, viewerId: string): boolean {
  return task.claimedByType === "user" && task.claimedById === viewerId;
}

function isCreatedBy(task: Task, viewerId: string): boolean {
  return task.createdByType === "user" && task.createdById === viewerId;
}

/**
 * Whether the task belongs to the relation, as the server decides it
 * (taskService.serverTaskRelationPredicate; exclusive, in this order:
 * assigned to me, created by me, from my message). `from_my_message` reads
 * the source message's sender, which only summary rows carry: unknown
 * (undefined) when the row did not say, unless the task has no source
 * message at all (`sourceMessageId` null), which can't be from my message.
 */
export function matchesRelation(task: Task, relation: ServerTaskRelation, viewerId: string): boolean | undefined {
  switch (relation) {
    case "assigned_to_me":
      return isClaimedBy(task, viewerId);
    case "created_by_me":
      return isCreatedBy(task, viewerId) && !isClaimedBy(task, viewerId);
    case "from_my_message":
      if (isClaimedBy(task, viewerId) || isCreatedBy(task, viewerId)) return false;
      if (task.sourceMessageId === null) return false;
      if (task.sourceSenderType === undefined || task.sourceSenderId === undefined) return undefined;
      return task.sourceSenderType === "user" && task.sourceSenderId === viewerId;
  }
}

function since(value: string | null | undefined, bound: string): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  const from = Date.parse(bound);
  return Number.isFinite(at) && Number.isFinite(from) && at >= from;
}

/**
 * Whether a task belongs in a lane as far as the client can tell: true, false,
 * or undefined when it hinges on a fact the row did not carry (the source
 * message's sender, which only summary rows bring: a live socket row lacks
 * it).
 */
export function matchLane(task: Task, filters: ServerTaskBoardFilters, viewerId: string | null): boolean | undefined {
  if (filters.statuses && filters.statuses.length > 0 && !filters.statuses.includes(boardStatusOf(task))) return false;
  if (filters.channelIds && filters.channelIds.length > 0 && !filters.channelIds.includes(task.channelId)) return false;
  if (filters.creators && filters.creators.length > 0) {
    const creator = actorKey(task.createdByType, task.createdById);
    if (!creator || !filters.creators.includes(creator)) return false;
  }
  if (filters.assignees && filters.assignees.length > 0) {
    const assignee = actorKey(task.claimedByType, task.claimedById);
    if (assignee ? !filters.assignees.includes(assignee) : !filters.assignees.includes("unassigned")) return false;
  }
  if (filters.createdSince && !since(task.createdAt, filters.createdSince)) return false;
  if (filters.completedSince && task.status === "done" && !since(task.completedAt, filters.completedSince)) return false;
  if (filters.query && !matchesQuery(task, filters.query)) return false;
  if (filters.relation) {
    if (!viewerId) return false;
    return matchesRelation(task, filters.relation, viewerId);
  }
  return true;
}

/**
 * Whether a task the client holds belongs in a lane. An unknown fact reads as
 * a match for a row the server put in the lane (`listed`) and as no match for
 * any other: the server's word stands until the client knows better (a live
 * row of unknown relation makes the lane read again: laneUnknownIds).
 */
export function matchesLane(task: Task, filters: ServerTaskBoardFilters, viewerId: string | null, listed: boolean): boolean {
  return matchLane(task, filters, viewerId) ?? listed;
}

function timeOf(value: string | null | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

function descending(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** The value a sort orders by (ms for the instants: coarser than the server's µs). */
export function sortKeyOf(sort: ServerTaskSort, task: Task): number {
  if (sort === "created") return timeOf(task.createdAt);
  return timeOf(taskActivityAt(task));
}

/**
 * The lane's order, as the server's (GET /tasks/server?sort=): newest first by
 * activityAt or by creation, ties by task id, then channel id, all
 * descending; activity_asc exactly the reverse of activity. So the order is
 * total. It only places rows the server did not order (laneTasks): the
 * server's own rows keep its order, whose instants are finer than a Date's.
 */
export function compareTasks(sort: ServerTaskSort, a: Task, b: Task): number {
  const newestFirst = sortKeyOf(sort, b) - sortKeyOf(sort, a) || descending(a.id, b.id) || descending(a.channelId, b.channelId);
  return sort === "activity_asc" ? -newestFirst : newestFirst;
}

/** What a lane has read so far. */
export interface LaneReadState {
  /** Task ids in the order the server sent them. */
  ids: readonly string[];
  /** Each listed row's sort key as read (sortKeyOf): a row whose key moved since is placed again. */
  keys: Readonly<Record<string, number>>;
  /** The last row of the last page as it was read: where the shown rows end while more pages remain. */
  frontier: Task | null;
  nextCursor: string | null;
  loaded: boolean;
  /** The live-change counter when the first page was asked for (serverTaskMerge): changes after it are the lane's to place. */
  readSequence: number;
}

/**
 * The rows a lane shows: the rows the server listed for it that still match,
 * in the server's order; then, placed by the sort among them, the rows that
 * changed live since the read and match now (a task that joined, or a listed
 * one whose sort key moved), cut at its frontier while the server has more.
 * A row the client holds from elsewhere (another group, a read before a
 * connection gap) is not placed: what it shows is what the server listed.
 */
export function laneTasks(
  lane: LaneSpec,
  read: LaneReadState | undefined,
  knownById: ReadonlyMap<string, Task>,
  viewerId: string | null,
  liveChangeOf: (taskId: string) => number,
): Task[] {
  return mergedLaneTasks([lane], [read], knownById, viewerId, liveChangeOf);
}

/**
 * The rows of a group made of several lanes of one sort (你发起的, or a 我的 board column: one
 * walk per relation, which are exclusive): each lane's rows as laneTasks
 * reads them, the lanes merged by the sort, cut at the earliest frontier of
 * those with more to read, so no row of a page still to come could belong
 * above a row shown. Nothing shows until every lane has read its first page.
 */
export function mergedLaneTasks(
  lanes: readonly LaneSpec[],
  reads: readonly (LaneReadState | undefined)[],
  knownById: ReadonlyMap<string, Task>,
  viewerId: string | null,
  liveChangeOf: (taskId: string) => number,
): Task[] {
  if (lanes.length === 0 || reads.some((read) => !read?.loaded)) return [];
  const sort = lanes[0]!.sort;
  const compare = (a: Task, b: Task) => compareTasks(sort, a, b);
  // The earliest frontier among the lanes with more to read: nothing that
  // sorts after it shows, except that lane's own rows (the server put them
  // there, at a precision finer than the client's).
  let frontier: Task | null = null;
  let frontierLane = -1;
  reads.forEach((read, index) => {
    if (read!.nextCursor === null || !read!.frontier) return;
    if (!frontier || compare(read!.frontier, frontier) < 0) {
      frontier = read!.frontier;
      frontierLane = index;
    }
  });
  const cut: Task | null = frontier;
  const withinCut = (task: Task) => !cut || compare(task, cut) <= 0;
  const placed = new Set<string>();
  // The server's rows, in its order, merged across lanes.
  let ordered: Task[] = [];
  lanes.forEach((lane, index) => {
    const read = reads[index]!;
    const rows: Task[] = [];
    for (const id of read.ids) {
      const task = knownById.get(id);
      if (!task || placed.has(id) || read.keys[id] !== sortKeyOf(sort, task)) continue;
      if (!matchesLane(task, lane.filters, viewerId, true)) continue;
      if (index !== frontierLane && !withinCut(task)) continue;
      placed.add(id);
      rows.push(task);
    }
    ordered = index === 0 ? rows : mergeOrdered(ordered, rows, compare);
  });
  // Rows to place: those listed whose key moved, and those that changed live since the read.
  const listedSets = reads.map((read) => new Set(read!.ids));
  const extras: Task[] = [];
  for (const task of knownById.values()) {
    if (placed.has(task.id) || !withinCut(task)) continue;
    const joins = lanes.some((lane, index) => {
      const read = reads[index]!;
      const listed = listedSets[index]!.has(task.id);
      if (!listed && liveChangeOf(task.id) <= read.readSequence) return false;
      return matchesLane(task, lane.filters, viewerId, listed);
    });
    if (joins) extras.push(task);
  }
  return mergeOrdered(ordered, extras.sort(compare), compare);
}

/** Two lists each in order, merged; ties keep the first list's row first. */
function mergeOrdered(a: readonly Task[], b: readonly Task[], compare: (x: Task, y: Task) => number): Task[] {
  const out: Task[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(compare(b[j]!, a[i]!) < 0 ? b[j++]! : a[i++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * Tasks that changed live since a lane's read and may belong in it, but hinge
 * on a fact the client lacks (a socket row has no source-message sender):
 * the lane reads its first page again to learn, once per task.
 */
export function laneUnknownIds(
  lanes: readonly LaneSpec[],
  reads: readonly (LaneReadState | undefined)[],
  knownById: ReadonlyMap<string, Task>,
  viewerId: string | null,
  liveChangeOf: (taskId: string) => number,
): string[] {
  const unknown: string[] = [];
  lanes.forEach((lane, index) => {
    const read = reads[index];
    if (!read?.loaded) return;
    const listed = new Set(read.ids);
    for (const task of knownById.values()) {
      if (listed.has(task.id) || liveChangeOf(task.id) <= read.readSequence) continue;
      if (matchLane(task, lane.filters, viewerId) === undefined) unknown.push(task.id);
    }
  });
  return unknown;
}

export function parseTasksPageTab(value: string | null | undefined): TasksPageTab | null {
  return value === "mine" || value === "all" ? value : null;
}

export function parseServerTaskSort(value: string | null | undefined): ServerTaskSort | null {
  return value === "activity" || value === "activity_asc" || value === "created" ? value : null;
}

/** A `?status=` value the page knows (a board status). */
export function parseBoardStatus(value: string): BoardStatus | null {
  return (BOARD_STATUSES as readonly string[]).includes(value) ? value as BoardStatus : null;
}

/** Where the last tab picked is kept: per server and person (§6 decision 4). */
export function tasksPageTabStorageKey(serverId: string, userId: string): string {
  return `raft.tasks.tab.${serverId}.${userId}`;
}

export function readStoredTasksPageTab(serverId: string | null, userId: string | null): TasksPageTab | null {
  if (!serverId || !userId) return null;
  try {
    return parseTasksPageTab(window.localStorage.getItem(tasksPageTabStorageKey(serverId, userId)));
  } catch {
    return null;
  }
}

export function writeStoredTasksPageTab(serverId: string | null, userId: string | null, tab: TasksPageTab): void {
  if (!serverId || !userId) return;
  try {
    window.localStorage.setItem(tasksPageTabStorageKey(serverId, userId), tab);
  } catch {
    // Storage refused: the address still says which tab is open.
  }
}
