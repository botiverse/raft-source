import assert from "node:assert/strict";
import { test } from "vitest";

import type { InboxItem } from "../../../store/inboxStore";
import { groupInboxRowsByDay, inboxItemTime, sortInboxRowsByTime } from "../activityDayGroups";
import type { DayGroupOptions } from "../activityDayGroups";

// A row by its kind's time field, all that grouping reads.
const channel = (id: string, at: string) => ({ kind: "channel", channelId: id, lastMessageAt: at }) as unknown as InboxItem;
const thread = (id: string, at: string) => ({ kind: "thread", threadChannelId: id, lastActivityAt: at }) as unknown as InboxItem;
const object = (id: string, at: string) => ({ kind: "object", objectKind: "artifact", objectId: id, lastActivityAt: at }) as unknown as InboxItem;
const mention = (id: string, at: string) => ({ kind: "mention_action", id, createdAt: at }) as unknown as InboxItem;

const OPTIONS: DayGroupOptions = {
  today: "2026-11-05",
  timeZone: "UTC",
  locale: "en-US",
  todayLabel: "Today",
  yesterdayLabel: "Yesterday",
};

const ids = (items: readonly InboxItem[]) => items.map((item) => (
  item.kind === "thread" ? item.threadChannelId : item.kind === "object" ? item.objectId : item.kind === "mention_action" ? item.id : item.channelId
));
const shape = (items: readonly InboxItem[], options: Partial<DayGroupOptions> = {}) =>
  groupInboxRowsByDay(items, { ...OPTIONS, ...options }).map((group) => [group.label, ids(group.rows)]);

test("a row's time is its kind's: the time it shows is the time it is grouped by", () => {
  assert.equal(inboxItemTime(channel("a", "2026-11-05T01:00:00.000Z")), "2026-11-05T01:00:00.000Z");
  assert.equal(inboxItemTime(thread("a", "2026-11-05T02:00:00.000Z")), "2026-11-05T02:00:00.000Z");
  assert.equal(inboxItemTime(object("a", "2026-11-05T03:00:00.000Z")), "2026-11-05T03:00:00.000Z");
  assert.equal(inboxItemTime(mention("a", "2026-11-05T04:00:00.000Z")), "2026-11-05T04:00:00.000Z");
});

test("today, yesterday, an older day and an earlier year, newest first, rows keeping their order", () => {
  assert.deepEqual(shape([
    channel("a", "2026-11-05T11:00:00.000Z"),
    thread("b", "2026-11-05T09:00:00.000Z"),
    object("c", "2026-11-04T23:00:00.000Z"),
    channel("d", "2026-10-20T12:00:00.000Z"),
    channel("e", "2025-10-21T12:00:00.000Z"),
  ]), [
    ["Today", ["a", "b"]],
    ["Yesterday", ["c"]],
    ["Tuesday, October 20", ["d"]],
    ["Tuesday, October 21, 2025", ["e"]],
  ]);
});

test("a day with no rows has no heading", () => {
  assert.deepEqual(shape([
    channel("a", "2026-11-05T11:00:00.000Z"),
    channel("b", "2026-11-03T12:00:00.000Z"),
  ]).map(([label]) => label), ["Today", "Tuesday, November 3"]);
  assert.deepEqual(shape([]), []);
});

test("a filter or a Done that empties a day takes its heading with it", () => {
  const all = [
    channel("today", "2026-11-05T11:00:00.000Z"),
    channel("yesterday", "2026-11-04T11:00:00.000Z"),
    channel("older", "2026-11-02T11:00:00.000Z"),
  ];
  assert.equal(shape(all).length, 3);
  const filtered = all.filter((item) => item.kind === "channel" && item.channelId !== "yesterday");
  assert.deepEqual(shape(filtered).map(([label]) => label), ["Today", "Monday, November 2"]);
});

test("one day is one group, even when the list isn't in time order", () => {
  // The Unread snapshot puts a read row back where it was, and a page's rows
  // append to the day the last page ended on.
  assert.deepEqual(shape([
    channel("a", "2026-11-04T10:00:00.000Z"),
    channel("b", "2026-11-05T11:00:00.000Z"),
    channel("c", "2026-11-04T09:00:00.000Z"),
    channel("d", "2026-11-05T08:00:00.000Z"),
  ]), [
    ["Today", ["b", "d"]],
    ["Yesterday", ["a", "c"]],
  ]);
});

test("inside a day the rows follow the times they show, not the list's order (Jasper)", () => {
  assert.deepEqual(shape([
    channel("earlier", "2026-11-05T08:00:00.000Z"),
    thread("latest", "2026-11-05T11:00:00.000Z"),
    object("middle", "2026-11-05T09:30:00.000Z"),
  ]), [["Today", ["latest", "middle", "earlier"]]]);
  assert.deepEqual(shape([
    channel("earlier", "2026-11-05T08:00:00.000Z"),
    thread("latest", "2026-11-05T11:00:00.000Z"),
  ], { sortDirection: "asc" }), [["Today", ["earlier", "latest"]]]);
});

test("the sorted rows are the grouped rows, in the same order: what picks the first row picks the first on screen", () => {
  const items = [
    channel("bad", "not a time"),
    channel("a", "2026-11-04T09:00:00.000Z"),
    channel("b", "2026-11-05T08:00:00.000Z"),
    channel("c", "2026-11-04T10:00:00.000Z"),
    channel("d", "2026-11-05T11:00:00.000Z"),
  ];
  for (const sortDirection of ["desc", "asc"] as const) {
    assert.deepEqual(
      ids(sortInboxRowsByTime(items, sortDirection)),
      ids(groupInboxRowsByDay(items, { ...OPTIONS, sortDirection }).flatMap((group) => group.rows)),
    );
  }
});

test("rows with the same time keep the list's order, whichever way it is sorted", () => {
  const same = "2026-11-05T08:00:00.000Z";
  const items = [channel("first", same), channel("second", same), channel("third", same)];
  assert.deepEqual(shape(items), [["Today", ["first", "second", "third"]]]);
  assert.deepEqual(shape(items, { sortDirection: "asc" }), [["Today", ["first", "second", "third"]]]);
});

test("the sort the list asks for orders the days", () => {
  assert.deepEqual(shape([
    channel("old", "2026-11-04T10:00:00.000Z"),
    channel("new", "2026-11-05T11:00:00.000Z"),
  ], { sortDirection: "asc" }).map(([label]) => label), ["Yesterday", "Today"]);
});

test("days are counted in the person's own time zone", () => {
  const items = [channel("a", "2026-11-05T02:00:00.000Z")];
  assert.deepEqual(shape(items, { timeZone: "UTC" }), [["Today", ["a"]]]);
  assert.deepEqual(shape(items, { timeZone: "America/New_York", today: "2026-11-05" }), [["Yesterday", ["a"]]]);
  assert.deepEqual(shape(items, { timeZone: "Asia/Shanghai", today: "2026-11-05" }), [["Today", ["a"]]]);
});

test("at midnight the same group's heading turns, under the same key, so its rows stay mounted", () => {
  const items = [channel("a", "2026-11-05T23:50:00.000Z")];
  const before = groupInboxRowsByDay(items, { ...OPTIONS, today: "2026-11-05" });
  const after = groupInboxRowsByDay(items, { ...OPTIONS, today: "2026-11-06" });
  assert.equal(before[0]?.label, "Today");
  assert.equal(after[0]?.label, "Yesterday");
  assert.equal(before[0]?.day, after[0]?.day);
});

test("a row a little ahead of this device's clock counts as today, not as a day to come", () => {
  assert.deepEqual(shape([
    channel("skew", "2026-11-06T00:00:05.000Z"),
    channel("a", "2026-11-05T23:00:00.000Z"),
  ]), [["Today", ["skew", "a"]]]);
});

test("rows with no readable time come last, under no heading, whichever way the list is sorted", () => {
  const items = [
    channel("bad", "not a time"),
    channel("a", "2026-11-04T10:00:00.000Z"),
    channel("worse", ""),
    channel("none", null as unknown as string),
    channel("b", "2026-11-05T10:00:00.000Z"),
  ];
  assert.deepEqual(shape(items), [
    ["Today", ["b"]],
    ["Yesterday", ["a"]],
    ["", ["bad", "worse", "none"]],
  ]);
  assert.deepEqual(shape(items, { sortDirection: "asc" }), [
    ["Yesterday", ["a"]],
    ["Today", ["b"]],
    ["", ["bad", "worse", "none"]],
  ]);
});
