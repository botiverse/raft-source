import api from "../../../api/client";
import type { Task } from "../../../store/taskStore";

/**
 * The Tasks page's reads of the server's task board, in one place
 * (GET /api/tasks/server and GET /api/tasks/server/counts), so the field and
 * param names the page depends on can follow the server as it lands:
 *
 *   status=<s>,...            board statuses (in_progress includes stored in_review)
 *   channel=<id>,...          local channel ids
 *   assignee=<ref|unassigned>,...  `user:<id>` / `agent:<id>`
 *   creator=<ref>,...
 *   relation=assigned_to_me|created_by_me|from_my_message
 *   completed_since=<ISO>     done tasks completed before it are left out
 *   created_since=<ISO>       tasks created before it are left out
 *   q=<text>                  search: titles containing every word, or one
 *                             task number (`12` / `#12`)
 *   sort=activity|created     (list only) newest first by activityAt or
 *                             createdAt; ties by task id, then local channel
 *                             id, all descending.
 *   sort=activity_asc         activityAt oldest first, ties ascending (the
 *                             exact reverse of activity). The cursor is
 *                             opaque and resumes only the sort that made it
 *                             (another sort answers 400); an unknown sort is 400.
 *                             (The server also has sort=number; the page does
 *                             not offer it.)
 *   limit=1..500&cursor=<opaque>&detail=summary   (list only)
 *
 * Counts answer `{ counts: { backlog, todo, in_progress, done, closed },
 * relations: { assigned_to_me, created_by_me, from_my_message } }`, over the
 * same filters (no limit / cursor / detail / sort: each is a 400). `relation`
 * narrows the column counts; the relation counts are open work (Todo, In
 * progress) under every filter but `relation`.
 *
 * Rows (full and summary) carry `lastActivityAt` (stored, or null) and
 * `activityAt` (lastActivityAt ?? updatedAt: what sort=activity orders by).
 */

/**
 * How the page orders a list (the sort menu, in its order): most recently
 * updated first (activity: COALESCE(lastActivityAt, updatedAt) DESC), least
 * recently updated first (activity_asc), most recently created first.
 */
export type ServerTaskSort = "activity" | "activity_asc" | "created";
export const SERVER_TASK_SORTS: readonly ServerTaskSort[] = ["activity", "activity_asc", "created"];
export const DEFAULT_SERVER_TASK_SORT: ServerTaskSort = "activity";

/** The person's relation to a task (server taskService.SERVER_TASK_RELATIONS). */
export type ServerTaskRelation = "assigned_to_me" | "created_by_me" | "from_my_message";

/** The board statuses the page shows (task v2: no In review column; its rows count as In progress). */
export type BoardStatus = "backlog" | "todo" | "in_progress" | "done" | "closed";
export const BOARD_STATUSES: readonly BoardStatus[] = ["backlog", "todo", "in_progress", "done", "closed"];

export interface ServerTaskBoardFilters {
  statuses?: readonly BoardStatus[];
  channelIds?: readonly string[];
  /** `user:<id>` / `agent:<id>` / `unassigned`. */
  assignees?: readonly string[];
  /** `user:<id>` / `agent:<id>`. */
  creators?: readonly string[];
  relation?: ServerTaskRelation;
  /** An instant (ISO with offset). */
  completedSince?: string;
  /** An instant (ISO with offset). */
  createdSince?: string;
  /** The search field's words (trimmed; empty is no search). */
  query?: string;
}

export interface ServerTaskPageRequest {
  filters: ServerTaskBoardFilters;
  sort: ServerTaskSort;
  limit: number;
  cursor?: string | null;
  /** `summary` leaves the description out (rows); `full` keeps it (cards). */
  detail: "summary" | "full";
}

export interface ServerTaskPage {
  tasks: Task[];
  nextCursor: string | null;
}

export interface ServerTaskCounts {
  statuses: Record<BoardStatus, number>;
  relations: Record<ServerTaskRelation, number>;
}

/** The query string of the filters, in a stable order (it doubles as a cache key). */
export function serverTaskFilterParams(filters: ServerTaskBoardFilters): URLSearchParams {
  const params = new URLSearchParams();
  const list = (key: string, values: readonly string[] | undefined) => {
    if (values && values.length > 0) params.set(key, [...values].sort().join(","));
  };
  // In progress names the stored In review rows too. Said outright, it is
  // also a list: a lone `status=` with no other filter is the legacy exact
  // match, which would leave those rows out of the column the counts include.
  list("status", filters.statuses?.includes("in_progress") ? [...filters.statuses, "in_review"] : filters.statuses);
  list("channel", filters.channelIds);
  list("assignee", filters.assignees);
  list("creator", filters.creators);
  if (filters.relation) params.set("relation", filters.relation);
  if (filters.completedSince) params.set("completed_since", filters.completedSince);
  if (filters.createdSince) params.set("created_since", filters.createdSince);
  if (filters.query) params.set("q", filters.query);
  return params;
}

export function serverTaskPageParams(request: ServerTaskPageRequest): URLSearchParams {
  const params = serverTaskFilterParams(request.filters);
  params.set("sort", request.sort);
  params.set("limit", String(request.limit));
  if (request.detail === "summary") params.set("detail", "summary");
  if (request.cursor) params.set("cursor", request.cursor);
  return params;
}

export async function fetchServerTaskPage(request: ServerTaskPageRequest): Promise<ServerTaskPage> {
  const { data } = await api.get(`/tasks/server?${serverTaskPageParams(request).toString()}`);
  const body = data as { tasks?: Task[]; next_cursor?: string | null };
  return { tasks: Array.isArray(body.tasks) ? body.tasks : [], nextCursor: body.next_cursor ?? null };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The counts response, read field by field (a missing number is 0). */
export function readServerTaskCounts(data: unknown): ServerTaskCounts {
  const body = (data ?? {}) as { counts?: Record<string, unknown>; relations?: Record<string, unknown> };
  const statuses = body.counts ?? {};
  const relations = body.relations ?? {};
  return {
    statuses: {
      backlog: count(statuses.backlog),
      todo: count(statuses.todo),
      in_progress: count(statuses.in_progress),
      done: count(statuses.done),
      closed: count(statuses.closed),
    },
    relations: {
      assigned_to_me: count(relations.assigned_to_me),
      created_by_me: count(relations.created_by_me),
      from_my_message: count(relations.from_my_message),
    },
  };
}

export async function fetchServerTaskCounts(filters: ServerTaskBoardFilters): Promise<ServerTaskCounts> {
  const query = serverTaskFilterParams(filters).toString();
  const { data } = await api.get(`/tasks/server/counts${query ? `?${query}` : ""}`);
  return readServerTaskCounts(data);
}

/**
 * When a task last moved, as the page shows and sorts it: the server's
 * `activityAt` (lastActivityAt ?? updatedAt), else the same fallback for a
 * row from before it carried one.
 */
export function taskActivityAt(task: Pick<Task, "activityAt" | "lastActivityAt" | "updatedAt">): string {
  return task.activityAt ?? task.lastActivityAt ?? task.updatedAt;
}
