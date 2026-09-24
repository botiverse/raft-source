import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTimeRangeParams,
  getSearchRelativeTimeParts,
  getEffectiveMessageSearchSort,
  groupMessageSearchResults,
  hasMeaningfulMessageSearchFilter,
  normalizeSearchScopes,
  normalizeSearchSort,
  normalizeSearchTimeRange,
} from "../src/components/search/searchGrouping.js";

test("groups thread hits while keeping standalone messages flat", () => {
  const groups = groupMessageSearchResults([
    {
      id: "m1",
      threadId: "t1",
      parentMessageId: "p1",
      parentMessageContent: "Discuss search V0 scope",
      createdAt: "2026-04-07T10:00:00.000Z",
    },
    {
      id: "m2",
      threadId: "t1",
      parentMessageId: "p1",
      parentMessageContent: "Discuss search V0 scope",
      createdAt: "2026-04-07T11:00:00.000Z",
    },
    {
      id: "m3",
      threadId: null,
      parentMessageId: null,
      parentMessageContent: null,
      createdAt: "2026-04-07T12:00:00.000Z",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.kind, "thread");
  assert.equal(groups[1]?.kind, "message");

  if (groups[0]?.kind !== "thread") {
    throw new Error("expected first group to be a thread group");
  }

  assert.equal(groups[0].hitCount, 2);
  assert.equal(groups[0].latestCreatedAt, "2026-04-07T11:00:00.000Z");
  assert.deepEqual(groups[0].results.map((entry) => entry.id), ["m1", "m2"]);
});

test("groups backend-projected thread reply hits by their thread channel id", () => {
  const groups = groupMessageSearchResults([
    {
      id: "reply-1",
      threadId: "thread-channel-1",
      parentMessageId: "parent-1",
      parentMessageContent: "Minimax routing discussion",
      createdAt: "2026-07-01T01:00:00.000Z",
    },
    {
      id: "reply-2",
      threadId: "thread-channel-1",
      parentMessageId: "parent-1",
      parentMessageContent: "Minimax routing discussion",
      createdAt: "2026-07-01T01:01:00.000Z",
    },
    {
      id: "reply-3",
      threadId: "thread-channel-1",
      parentMessageId: "parent-1",
      parentMessageContent: "Minimax routing discussion",
      createdAt: "2026-07-01T01:02:00.000Z",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "thread");
  if (groups[0]?.kind !== "thread") {
    throw new Error("expected thread replies to collapse into a thread group");
  }

  assert.equal(groups[0].threadId, "thread-channel-1");
  assert.equal(groups[0].parentMessageId, "parent-1");
  assert.equal(groups[0].hitCount, 3);
  assert.equal(groups[0].latestCreatedAt, "2026-07-01T01:02:00.000Z");
  assert.deepEqual(groups[0].results.map((entry) => entry.id), ["reply-1", "reply-2", "reply-3"]);
});

test("buildTimeRangeParams returns start-of-day for today", () => {
  const now = new Date("2026-04-07T15:30:00.000Z");
  const expectedAfter = new Date(now);
  expectedAfter.setHours(0, 0, 0, 0);
  const params = buildTimeRangeParams("today", now);
  assert.deepEqual(params, {
    after: expectedAfter.toISOString(),
    before: now.toISOString(),
  });
});

test("normalizes unknown search time ranges to any", () => {
  assert.equal(normalizeSearchTimeRange("7d"), "7d");
  assert.equal(normalizeSearchTimeRange("weird"), "any");
  assert.equal(normalizeSearchTimeRange(null), "any");
});

test("normalizes search sort to the two supported modes", () => {
  assert.equal(normalizeSearchSort("recent"), "recent");
  assert.equal(normalizeSearchSort("relevance"), "relevance");
  assert.equal(normalizeSearchSort("weird"), "relevance");
  assert.equal(normalizeSearchSort(null), "relevance");
});

test("normalizes multi-select search scopes with stable order and dedupe", () => {
  assert.deepEqual(normalizeSearchScopes(["agents", "mentioned", "agents", "humans", "weird"]), ["mentioned", "humans", "agents"]);
  assert.deepEqual(normalizeSearchScopes("humans"), ["humans"]);
  assert.deepEqual(normalizeSearchScopes(null), []);
});

test("filter-only message search has intent and forces recent sort", () => {
  assert.equal(hasMeaningfulMessageSearchFilter({ senderId: "", channelId: "", timeRange: "any" }), false);
  assert.equal(hasMeaningfulMessageSearchFilter({ senderId: "user-1", channelId: "", timeRange: "any" }), true);
  assert.equal(hasMeaningfulMessageSearchFilter({ senderId: "", channelId: "channel-1", timeRange: "any" }), true);
  assert.equal(hasMeaningfulMessageSearchFilter({ senderId: "", channelId: "", timeRange: "7d" }), true);
  assert.equal(hasMeaningfulMessageSearchFilter({ senderId: "", channelId: "", timeRange: "any", scopes: ["mentioned"] }), true);

  assert.equal(getEffectiveMessageSearchSort("", "relevance"), "recent");
  assert.equal(getEffectiveMessageSearchSort("   ", "relevance"), "recent");
  assert.equal(getEffectiveMessageSearchSort("needle", "relevance"), "relevance");
  assert.equal(getEffectiveMessageSearchSort("needle", "recent"), "recent");
});

test("keeps search grouping stable when a hit has an invalid timestamp", () => {
  const groups = groupMessageSearchResults([
    {
      id: "m1",
      threadId: "t1",
      parentMessageId: "p1",
      parentMessageContent: "Discuss search V0 scope",
      createdAt: "not-a-date",
    },
    {
      id: "m2",
      threadId: "t1",
      parentMessageId: "p1",
      parentMessageContent: "Discuss search V0 scope",
      createdAt: "2026-04-07T11:00:00.000Z",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "thread");
  if (groups[0]?.kind !== "thread") {
    throw new Error("expected a thread group");
  }

  assert.equal(groups[0].latestCreatedAt, "2026-04-07T11:00:00.000Z");
});

test("returns null for invalid search timestamps (caller shows localized unknown-time copy)", () => {
  assert.equal(getSearchRelativeTimeParts("not-a-date"), null);
});

test("returns a locale-agnostic value+unit descriptor for valid timestamps", () => {
  const now = Date.parse("2026-04-07T12:00:00.000Z");
  assert.deepEqual(getSearchRelativeTimeParts("2026-04-07T11:30:00.000Z", now), { value: -30, unit: "minute" });
  assert.deepEqual(getSearchRelativeTimeParts("2026-04-07T09:00:00.000Z", now), { value: -3, unit: "hour" });
  assert.deepEqual(getSearchRelativeTimeParts("2026-04-05T12:00:00.000Z", now), { value: -2, unit: "day" });
});
