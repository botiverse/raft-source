import assert from "node:assert/strict";

import {
  readServerTaskCounts,
  serverTaskFilterParams,
  serverTaskPageParams,
  taskActivityAt,
} from "../src/components/task/tasksPage/tasksPageApi";
import {
  NO_PAGE_FILTERS,
  STALE_AFTER_MS,
  allListLane,
  assignedSectionFilters,
  boardColumnFilters,
  boardColumns,
  boardCountsFilters,
  compareTasks,
  hasToolbarFilter,
  isNarrowed,
  isStaleTask,
  laneTasks,
  laneUnknownIds,
  makeLane,
  matchesLane,
  matchesQuery,
  matchesRelation,
  mergedLaneTasks,
  mineSectionLanes,
  parseServerTaskSort,
  recentDoneSince,
  serverFiltersOf,
  sortKeyOf,
  startedSectionFilters,
  viewLanes,
} from "../src/components/task/tasksPage/tasksPageModel";
import type { PageFilters } from "../src/components/task/tasksPage/tasksPageModel";
import { mergeTaskFields } from "../src/store/serverTaskMerge";
import type { Task } from "../src/store/taskStore";
import type { LaneReadState } from "../src/components/task/tasksPage/tasksPageModel";

// The Tasks page (task v2, hifi v4) in data: what each section, list and
// board column asks the server for, and how live rows are placed in it
// between reads.
// Run: `pnpm --filter @botiverse/raft-web test tests/tasksPageModel.test.ts`.

const ME = "user-me";

function task(overrides: Partial<Task> & Pick<Task, "id" | "taskNumber">): Task {
  return {
    messageId: `anchor-${overrides.id}`,
    channelId: "ch-a",
    channelName: "proj-a",
    channelType: "channel",
    title: `Task ${overrides.taskNumber}`,
    status: "todo",
    claimedByType: null,
    claimedById: null,
    createdById: "user-other",
    createdByType: "user",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function byId(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

const noLiveChange = () => 0;

/** A read of `rows` as the server sent them (keys as read, frontier the last row). */
function readOf(sort: "activity" | "activity_asc" | "created", rows: readonly Task[], nextCursor: string | null): LaneReadState {
  return {
    ids: rows.map((t) => t.id),
    keys: Object.fromEntries(rows.map((t) => [t.id, sortKeyOf(sort, t)])),
    frontier: rows[rows.length - 1] ?? null,
    nextCursor,
    loaded: true,
    readSequence: 0,
  };
}

test("filters and sort go on the wire in a stable order, list params only on the list read", () => {
  const filters = { statuses: ["todo", "in_progress"] as const, channelIds: ["c2", "c1"], relation: "assigned_to_me" as const, createdSince: "2026-11-09T00:00:00.000Z", query: "ship it" };
  assert.equal(
    serverTaskFilterParams(filters).toString(),
    "status=in_progress%2Cin_review%2Ctodo&channel=c1%2Cc2&relation=assigned_to_me&created_since=2026-11-09T00%3A00%3A00.000Z&q=ship+it",
  );
  assert.equal(serverTaskFilterParams({ query: "" }).has("q"), false, "no search, no q");
  // In progress alone is still a list (with the stored In review rows): never the legacy exact match.
  assert.equal(serverTaskFilterParams({ statuses: ["in_progress"] }).get("status"), "in_progress,in_review");
  assert.equal(serverTaskFilterParams({ statuses: ["backlog"] }).get("status"), "backlog");
  const page = serverTaskPageParams({ filters, sort: "created", limit: 20, cursor: "abc", detail: "summary" });
  assert.equal(page.get("sort"), "created");
  assert.equal(serverTaskPageParams({ filters: {}, sort: "activity_asc", limit: 20, detail: "summary" }).get("sort"), "activity_asc");
  assert.equal(page.get("limit"), "20");
  assert.equal(page.get("detail"), "summary");
  assert.equal(page.get("cursor"), "abc");
  const full = serverTaskPageParams({ filters: {}, sort: "activity", limit: 20, detail: "full" });
  assert.equal(full.has("detail"), false, "full rows: no detail param");
  assert.equal(full.has("cursor"), false, "first page: no cursor");
});

test("counts are read field by field; anything missing is 0", () => {
  assert.deepEqual(readServerTaskCounts({
    counts: { backlog: 22, todo: 31, in_progress: 14, done: 1204, closed: 87 },
    relations: { assigned_to_me: 4, created_by_me: 6, from_my_message: 3 },
  }), {
    statuses: { backlog: 22, todo: 31, in_progress: 14, done: 1204, closed: 87 },
    relations: { assigned_to_me: 4, created_by_me: 6, from_my_message: 3 },
  });
  assert.deepEqual(readServerTaskCounts({ counts: { todo: 2 } }).statuses, { backlog: 0, todo: 2, in_progress: 0, done: 0, closed: 0 });
  assert.deepEqual(readServerTaskCounts(null).relations, { assigned_to_me: 0, created_by_me: 0, from_my_message: 0 });
});

test("activity is the server's activityAt, else lastActivityAt, else the last update", () => {
  assert.equal(taskActivityAt({ activityAt: "2026-11-09T11:00:00.000Z", lastActivityAt: "2026-11-09T10:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }), "2026-11-09T11:00:00.000Z");
  assert.equal(taskActivityAt({ lastActivityAt: "2026-11-09T10:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }), "2026-11-09T10:00:00.000Z");
  assert.equal(taskActivityAt({ lastActivityAt: null, updatedAt: "2026-11-01T00:00:00.000Z" }), "2026-11-01T00:00:00.000Z");
});

test("relations are exclusive, as the server's", () => {
  const mineAssigned = task({ id: "a", taskNumber: 1, claimedByType: "user", claimedById: ME, createdById: ME });
  const createdForOther = task({ id: "b", taskNumber: 2, createdById: ME, claimedByType: "agent", claimedById: "agent-1" });
  const fromMessage = task({ id: "c", taskNumber: 3, sourceSenderType: "user", sourceSenderId: ME });
  const unknownSource = task({ id: "d", taskNumber: 4 });
  assert.equal(matchesRelation(mineAssigned, "assigned_to_me", ME), true);
  assert.equal(matchesRelation(mineAssigned, "created_by_me", ME), false, "assigned to me wins over created by me");
  assert.equal(matchesRelation(createdForOther, "created_by_me", ME), true);
  assert.equal(matchesRelation(createdForOther, "from_my_message", ME), false, "created by me is not from my message");
  assert.equal(matchesRelation(fromMessage, "from_my_message", ME), true);
  assert.equal(matchesRelation(unknownSource, "from_my_message", ME), undefined, "a row without its source sender is unknown");
  // From my message but assigned to me: only Waiting on me (the server's order of exclusion).
  const fromMessageMine = task({ id: "g", taskNumber: 7, sourceMessageId: "msg-1", sourceSenderType: "user", sourceSenderId: ME, claimedByType: "user", claimedById: ME });
  assert.equal(matchesRelation(fromMessageMine, "assigned_to_me", ME), true);
  assert.equal(matchesRelation(fromMessageMine, "created_by_me", ME), false);
  assert.equal(matchesRelation(fromMessageMine, "from_my_message", ME), false, "assigned to me wins over from my message");
  // No source message at all: never from my message, whatever the row lacks (no re-read for it).
  assert.equal(matchesRelation(task({ id: "h", taskNumber: 8, sourceMessageId: null }), "from_my_message", ME), false);
  // An agent with the viewer's id is not the viewer.
  assert.equal(matchesRelation(task({ id: "e", taskNumber: 5, claimedByType: "agent", claimedById: ME }), "assigned_to_me", ME), false);
});

test("a lane matches status (In review as In progress), channel, people, the since bounds and the search", () => {
  const review = task({ id: "r", taskNumber: 1, status: "in_review" });
  assert.equal(matchesLane(review, { statuses: ["in_progress"] }, ME, false), true);
  assert.equal(matchesLane(review, { statuses: ["todo"] }, ME, false), false);
  assert.equal(matchesLane(task({ id: "x", taskNumber: 2 }), { channelIds: ["ch-b"] }, ME, false), false);
  const unassigned = task({ id: "u", taskNumber: 3 });
  assert.equal(matchesLane(unassigned, { assignees: ["unassigned"] }, ME, false), true);
  assert.equal(matchesLane(unassigned, { assignees: [`user:${ME}`] }, ME, false), false);
  assert.equal(matchesLane(unassigned, { creators: ["user:user-other"] }, ME, false), true);
  const since = "2026-11-09T00:00:00.000Z";
  assert.equal(matchesLane(task({ id: "n", taskNumber: 4, createdAt: "2026-11-09T08:00:00.000Z" }), { createdSince: since }, ME, false), true);
  assert.equal(matchesLane(task({ id: "o", taskNumber: 5 }), { createdSince: since }, ME, false), false);
  assert.equal(matchesLane(task({ id: "d1", taskNumber: 6, status: "done", completedAt: "2026-11-08T23:00:00.000Z" }), { completedSince: since }, ME, false), false);
  assert.equal(matchesLane(task({ id: "d2", taskNumber: 7, status: "todo" }), { completedSince: since }, ME, false), true, "completed_since bounds Done only");
  const titled = task({ id: "s", taskNumber: 42, title: "Ship the Tasks page" });
  assert.equal(matchesLane(titled, { query: "tasks SHIP" }, ME, false), true, "every word, any order, any case");
  assert.equal(matchesLane(titled, { query: "ship board" }, ME, false), false);
  assert.equal(matchesLane(titled, { query: "#42" }, ME, false), true, "its number");
  // Unknown source sender: the server's listing stands, nothing else joins.
  const unknown = task({ id: "q", taskNumber: 8 });
  assert.equal(matchesLane(unknown, { relation: "from_my_message" }, ME, true), true);
  assert.equal(matchesLane(unknown, { relation: "from_my_message" }, ME, false), false);
});

test("lanes sort as the server: newest first by activityAt or creation, ties by task id, then channel, descending; activity_asc the exact reverse", () => {
  const old = task({ id: "a", taskNumber: 9, createdAt: "2026-11-01T00:00:00.000Z", activityAt: "2026-11-09T09:00:00.000Z" });
  const fresh = task({ id: "b", taskNumber: 3, createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z" });
  assert.ok(compareTasks("activity", old, fresh) < 0, "the most recent activity first");
  assert.ok(compareTasks("activity_asc", fresh, old) < 0, "least recently updated first");
  assert.ok(compareTasks("created", fresh, old) < 0, "the newest task first");
  assert.equal(sortKeyOf("activity_asc", old), sortKeyOf("activity", old), "the same key, the other way");
  const tieLow = task({ id: "a1", taskNumber: 5, createdAt: "2026-11-02T00:00:00.000Z" });
  const tieHigh = task({ id: "b1", taskNumber: 5, createdAt: "2026-11-02T00:00:00.000Z" });
  for (const sort of ["activity", "created"] as const) {
    assert.ok(compareTasks(sort, tieHigh, tieLow) < 0, `${sort}: the higher task id first`);
  }
  assert.ok(compareTasks("activity_asc", tieLow, tieHigh) < 0, "activity_asc: the lower task id first");
  const otherChannel = { ...tieHigh, channelId: "ch-z" };
  assert.ok(compareTasks("created", otherChannel, tieHigh) < 0, "then the higher channel id");
  assert.ok(compareTasks("activity_asc", tieHigh, otherChannel) < 0, "activity_asc: then the lower channel id");
  const rows = [old, fresh, tieLow, tieHigh, otherChannel];
  const desc = [...rows].sort((x, y) => compareTasks("activity", x, y)).map((t) => `${t.id}:${t.channelId}`);
  const asc = [...rows].sort((x, y) => compareTasks("activity_asc", x, y)).map((t) => `${t.id}:${t.channelId}`);
  assert.deepEqual(asc, [...desc].reverse());
  assert.equal(parseServerTaskSort("activity_asc"), "activity_asc");
  assert.equal(parseServerTaskSort("number"), null, "the page has no number sort");
});

test("你发起的 merges its two walks, cut at the earlier frontier of those with more", () => {
  const since = "2026-11-08T12:00:00.000Z";
  const [created, fromMessage] = mineSectionLanes("started", NO_PAGE_FILTERS, "activity", since);
  const started = (id: string, at: string, overrides: Partial<Task> = {}) => task({ id, taskNumber: 1, activityAt: at, ...overrides });
  const c1 = started("c1", "2026-11-09T10:00:00.000Z", { createdById: ME });
  const c2 = started("c2", "2026-11-09T06:00:00.000Z", { createdById: ME });
  const m1 = started("m1", "2026-11-09T08:00:00.000Z", { sourceMessageId: "msg", sourceSenderType: "user", sourceSenderId: ME });
  const m2 = started("m2", "2026-11-09T04:00:00.000Z", { sourceMessageId: "msg", sourceSenderType: "user", sourceSenderId: ME });
  const known = byId([c1, c2, m1, m2]);
  const reads = [readOf("activity", [c1], "more"), readOf("activity", [m1, m2], null)];
  assert.deepEqual(mergedLaneTasks([created!, fromMessage!], reads, known, ME, noLiveChange).map((t) => t.id), ["c1"], "nothing below an unread page");
  reads[0] = readOf("activity", [c1, c2], null);
  assert.deepEqual(mergedLaneTasks([created!, fromMessage!], reads, known, ME, noLiveChange).map((t) => t.id), ["c1", "m1", "c2", "m2"]);
  assert.deepEqual(mergedLaneTasks([created!, fromMessage!], [reads[0], undefined], known, ME, noLiveChange), [], "not until both have read");
});

test("a lane keeps the server's order for its rows and places only rows that changed live since the read", () => {
  const lane = makeLane({ statuses: ["todo"] }, "activity", "summary");
  // Same millisecond: only the server (µs) knows t1 is newer than t2; its order stands.
  const t1 = task({ id: "t1", taskNumber: 1, activityAt: "2026-11-09T10:00:00.000Z" });
  const t2 = task({ id: "t2", taskNumber: 2, activityAt: "2026-11-09T10:00:00.000Z" });
  const t3 = task({ id: "t3", taskNumber: 3, activityAt: "2026-11-09T08:00:00.000Z" });
  const live = task({ id: "live", taskNumber: 4, activityAt: "2026-11-09T11:00:00.000Z" });
  const moved = task({ id: "moved", taskNumber: 5, status: "done", activityAt: "2026-11-09T12:00:00.000Z" });
  const stale = task({ id: "stale", taskNumber: 6, activityAt: "2026-11-09T13:00:00.000Z" });
  const known = byId([t3, t1, t2, live, moved, stale]);
  const changes = new Map([["live", 5], ["moved", 5]]);
  const liveChange = (id: string) => changes.get(id) ?? 0;
  assert.deepEqual(laneTasks(lane, undefined, known, ME, liveChange), [], "nothing before the first page");
  const read = { ...readOf("activity", [t1, t2], "next"), ids: ["t1", "t2", "moved"], readSequence: 1 };
  // t3 is past the frontier (the next page brings it); `live` joined above; `moved` left for Done;
  // `stale` matches but did not change since the read (held from elsewhere, e.g. before a gap): not placed.
  assert.deepEqual(laneTasks(lane, read, known, ME, liveChange).map((t) => t.id), ["live", "t1", "t2"]);
  assert.deepEqual(laneTasks(lane, { ...read, nextCursor: null }, known, ME, liveChange).map((t) => t.id), ["live", "t1", "t2"], "complete: still only what the server listed");
  // A listed row whose activity moved (a live message) is placed again, by the sort.
  const bumped = new Map(known);
  bumped.set("t2", { ...t2, activityAt: "2026-11-09T10:30:00.000Z" });
  assert.deepEqual(laneTasks(lane, read, bumped, ME, liveChange).map((t) => t.id), ["live", "t2", "t1"]);
});

test("a live row whose relation the client can't tell makes the lane read again, instead of hiding it for good", () => {
  const lane = makeLane({ relation: "from_my_message", statuses: ["backlog", "todo", "in_progress"] }, "activity", "summary");
  // A socket row: no source-message sender.
  const fresh = task({ id: "n", taskNumber: 9, activityAt: "2026-11-09T12:00:00.000Z" });
  const read = { ...readOf("activity", [], null), readSequence: 1 };
  const changed = (id: string) => (id === "n" ? 2 : 0);
  assert.deepEqual(laneTasks(lane, read, byId([fresh]), ME, changed), [], "not shown on a guess");
  assert.deepEqual(laneUnknownIds([lane], [read], byId([fresh]), ME, changed), ["n"]);
  assert.deepEqual(laneUnknownIds([lane], [read], byId([{ ...fresh, sourceSenderType: "user", sourceSenderId: ME }]), ME, changed), [], "known: placed, no re-read");
});

test("a server row never moves a task's activity back (the local bump is newer than the server's 1/min stamp)", () => {
  const local = task({ id: "x", taskNumber: 1, activityAt: "2026-11-09T10:05:00.000Z" });
  const server = task({ id: "x", taskNumber: 1, activityAt: "2026-11-09T10:00:00.000Z", title: "renamed" });
  const merged = mergeTaskFields(local, server);
  assert.equal(merged.activityAt, "2026-11-09T10:05:00.000Z");
  assert.equal(merged.title, "renamed");
  assert.equal(mergeTaskFields(server, local).activityAt, "2026-11-09T10:05:00.000Z");
});

const filtersOf = (overrides: Partial<PageFilters>): PageFilters => ({ ...NO_PAGE_FILTERS, ...overrides });

test("分配给你: assigned to me, unfinished unless a status filter is set; every filter applies", () => {
  assert.deepEqual(assignedSectionFilters(NO_PAGE_FILTERS), { relation: "assigned_to_me", statuses: ["backlog", "todo", "in_progress"] });
  assert.deepEqual(
    assignedSectionFilters(filtersOf({ channelIds: ["c1"], statuses: ["done"], creators: ["user:u2"], assignees: ["agent:a1"], query: "ship" })),
    { channelIds: ["c1"], statuses: ["done"], creators: ["user:u2"], assignees: ["agent:a1"], query: "ship", relation: "assigned_to_me" },
  );
  const [lane] = mineSectionLanes("assigned", NO_PAGE_FILTERS, "activity_asc", "2026-11-09T00:00:00.000Z");
  assert.equal(lane!.sort, "activity_asc");
  assert.equal(lane!.detail, "summary");
});

test("你发起的: created by me or from my message, unfinished plus done in the last day, unless a status filter is set", () => {
  const since = recentDoneSince(Date.parse("2026-11-10T12:00:00.000Z"));
  assert.equal(since, "2026-11-09T12:00:00.000Z", "24 hours back");
  assert.deepEqual(startedSectionFilters(filtersOf({ channelIds: ["c1"] }), since), [
    { channelIds: ["c1"], relation: "created_by_me", statuses: ["backlog", "todo", "in_progress", "done"], completedSince: since },
    { channelIds: ["c1"], relation: "from_my_message", statuses: ["backlog", "todo", "in_progress", "done"], completedSince: since },
  ]);
  // A status filter decides alone: Done of any age, Closed too.
  assert.deepEqual(startedSectionFilters(filtersOf({ statuses: ["done", "closed"] }), since), [
    { statuses: ["done", "closed"], relation: "created_by_me" },
    { statuses: ["done", "closed"], relation: "from_my_message" },
  ]);
  // A task done two days ago is not in it; one done an hour ago is.
  const [created] = startedSectionFilters(NO_PAGE_FILTERS, since);
  const mine = { createdById: ME, status: "done" as const };
  assert.equal(matchesLane(task({ id: "old", taskNumber: 1, ...mine, completedAt: "2026-11-08T12:00:00.000Z" }), created!, ME, false), false);
  assert.equal(matchesLane(task({ id: "new", taskNumber: 2, ...mine, completedAt: "2026-11-10T11:00:00.000Z" }), created!, ME, false), true);
  assert.equal(matchesLane(task({ id: "closed", taskNumber: 3, createdById: ME, status: "closed" }), created!, ME, false), false);
  // Assigned to me: never 你发起的, whoever created it.
  assert.equal(matchesLane(task({ id: "mine", taskNumber: 4, createdById: ME, claimedByType: "user", claimedById: ME }), created!, ME, false), false);
});

test("全部 is one lane of every filter; the board a column per status (the filtered ones), 我的 a lane per relation", () => {
  const filters = filtersOf({ channelIds: ["c1"], statuses: ["done", "todo"], query: "x" });
  assert.deepEqual(allListLane(filters, "created").filters, serverFiltersOf(filters));
  assert.deepEqual(serverFiltersOf(NO_PAGE_FILTERS), {});
  assert.deepEqual(boardColumns(filters), ["todo", "done"], "the board's order, not the filter's");
  assert.deepEqual(boardColumns(NO_PAGE_FILTERS), ["backlog", "todo", "in_progress", "done", "closed"]);
  assert.deepEqual(boardColumnFilters("all", filters, "todo"), [{ channelIds: ["c1"], statuses: ["todo"], query: "x" }]);
  assert.deepEqual(boardColumnFilters("mine", filters, "todo").map((f) => f.relation), ["assigned_to_me", "created_by_me", "from_my_message"]);
  assert.deepEqual(boardCountsFilters("all", filters), [{ channelIds: ["c1"], query: "x" }], "column counts read every status");
  assert.equal(boardCountsFilters("mine", filters).length, 3);
  // Select all reads what the view shows.
  const since = "2026-11-09T00:00:00.000Z";
  assert.equal(viewLanes("all", "list", filters, "activity", since).length, 1);
  assert.equal(viewLanes("mine", "list", filters, "activity", since).length, 3);
  assert.equal(viewLanes("all", "board", filters, "activity", since).length, 2);
  assert.equal(viewLanes("mine", "board", filters, "activity", since).length, 6);
  // …and not a folded board column's: Closed folds by default, a column folded by hand too, one the filter asks for opens.
  assert.equal(viewLanes("all", "board", NO_PAGE_FILTERS, "activity", since).length, 4, "Closed folded by default");
  assert.equal(viewLanes("all", "board", NO_PAGE_FILTERS, "activity", since, { "board:closed": false, "board:todo": true }).length, 4);
  assert.equal(viewLanes("all", "board", filtersOf({ statuses: ["closed"] }), "activity", since).length, 1, "asked for, it opens");
  assert.equal(viewLanes("all", "board", filters, "activity", since, { "board:todo": true }).length, 1);
  assert.notEqual(allListLane(filters, "activity").key, allListLane(filters, "activity_asc").key, "another sort is another read");
});

test("narrowed: a toolbar filter or the search; Clear filters shows for the toolbar's only", () => {
  assert.equal(isNarrowed(NO_PAGE_FILTERS), false);
  assert.equal(isNarrowed(filtersOf({ query: "x" })), true);
  assert.equal(hasToolbarFilter(filtersOf({ query: "x" })), false);
  assert.equal(hasToolbarFilter(filtersOf({ statuses: ["todo"] })), true);
});

test("the search matches every title word, or one task number", () => {
  const t = { title: "Ship the Tasks page", taskNumber: 12 };
  assert.equal(matchesQuery(t, ""), true);
  assert.equal(matchesQuery(t, "page  ship"), true);
  assert.equal(matchesQuery(t, "pages"), false);
  assert.equal(matchesQuery(t, "12"), true);
  assert.equal(matchesQuery(t, "#12"), true);
  assert.equal(matchesQuery(t, "#12 ship"), false, "a number with other words is words");
});

test("an open task three days without an update is stale; a finished one never", () => {
  const now = Date.parse("2026-11-10T00:00:00.000Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(isStaleTask({ status: "todo", activityAt: at(STALE_AFTER_MS + 1), updatedAt: at(0) }, now), true);
  assert.equal(isStaleTask({ status: "in_progress", activityAt: at(STALE_AFTER_MS - 1000), updatedAt: at(0) }, now), false);
  assert.equal(isStaleTask({ status: "backlog", activityAt: at(STALE_AFTER_MS * 2), updatedAt: at(0) }, now), false);
  assert.equal(isStaleTask({ status: "done", activityAt: at(STALE_AFTER_MS * 2), updatedAt: at(0) }, now), false);
});

test("a live message in a task's conversation moves its activity up (the server sends no task event for it)", async () => {
  const { useTaskStore } = await import("../src/store/taskStore");
  const before = task({ id: "t", taskNumber: 1, activityAt: "2026-11-09T08:00:00.000Z", conversationReplyCount: 2 });
  useTaskStore.setState({ serverTasks: [before] });
  try {
    useTaskStore.getState().bumpTaskConversationReplyCount("t", "2026-11-09T09:30:00.000Z");
    const after = useTaskStore.getState().serverTasks[0]!;
    assert.equal(after.activityAt, "2026-11-09T09:30:00.000Z");
    assert.equal(after.conversationReplyCount, 3);
    // An older frame (a late delivery) never moves it back.
    useTaskStore.getState().bumpTaskConversationReplyCount("t", "2026-11-09T07:00:00.000Z");
    assert.equal(useTaskStore.getState().serverTasks[0]!.activityAt, "2026-11-09T09:30:00.000Z");
  } finally {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
  }
});

test("live changes are forgotten once every held read covers them, and all of them on a reset", async () => {
  const merge = await import("../src/store/serverTaskMerge");
  merge.noteSummaryPageTouched("p1");
  const afterP1 = merge.currentLiveSequence();
  merge.noteSummaryPageTouched("p2");
  merge.pruneLiveChanges(afterP1);
  assert.equal(merge.liveChangeOf("p1"), 0, "covered by the earliest read: gone");
  assert.ok(merge.liveChangeOf("p2") > afterP1, "newer than a read: kept");
  merge.pruneLiveChanges(null);
  assert.equal(merge.liveChangeOf("p2"), 0);
});
