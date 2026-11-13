import assert from "node:assert/strict";
import {
  conversationChannelIdFromPath,
  normalizeRecentConversationIds,
  pushRecentConversation,
  selectRecentConversationEntities,
} from "../recentConversations";
import type { SearchEntityResult } from "../searchEntities";

// Task #113 — desktop ⌘K empty state lists the user's recently VISITED
// conversations (Slack), filled from message activity only when the visit
// history is short.

function entity(key: string, channelId: string | null, overrides: Partial<SearchEntityResult> = {}): SearchEntityResult {
  return {
    key,
    type: key.startsWith("channel:") ? "channel" : key.startsWith("agent:") ? "agentDm" : "humanDm",
    title: key,
    subtitle: { kind: "channel" },
    channelId,
    channelType: key.startsWith("channel:") ? "channel" : null,
    machineId: null,
    agentId: null,
    userId: null,
    archivedAt: null,
    ...overrides,
  };
}

test("pushRecentConversation keeps most-recent-first, dedupes and caps", () => {
  assert.deepEqual(pushRecentConversation([], "a"), ["a"]);
  assert.deepEqual(pushRecentConversation(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(pushRecentConversation(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
  assert.deepEqual(pushRecentConversation(["a"], ""), ["a"]);
});

test("normalizeRecentConversationIds drops garbage, duplicates and overflow", () => {
  assert.deepEqual(normalizeRecentConversationIds(null), []);
  assert.deepEqual(normalizeRecentConversationIds(["a", 1, "", "a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeRecentConversationIds(["a", "b", "c"], 2), ["a", "b"]);
});

test("conversationChannelIdFromPath reads channel and DM routes only", () => {
  assert.equal(conversationChannelIdFromPath("/s/acme/channel/ch-1"), "ch-1");
  assert.equal(conversationChannelIdFromPath("/s/acme/dm/dm-9?x=1"), "dm-9");
  assert.equal(conversationChannelIdFromPath("/s/acme/dm/a%20b"), "a b");
  assert.equal(conversationChannelIdFromPath("/s/acme/agents/agent-1"), null);
  assert.equal(conversationChannelIdFromPath("/s/acme/search"), null);
  assert.equal(conversationChannelIdFromPath(undefined), null);
});

test("selectRecentConversationEntities: visits first (in order), then activity fill, current + archived + ineligible excluded", () => {
  const entities = [
    entity("channel:c1", "c1"),
    entity("channel:c2", "c2"),
    entity("channel:c3", "c3", { archivedAt: "2026-01-01T00:00:00.000Z" }),
    entity("channel:c4", "c4"),
    entity("agent:a1", "dm-a1"),
    entity("human:h1", "dm-h1"),
    entity("human:h2", null), // no DM yet → cannot be "recent"
  ];
  const eligible = new Set(entities.map((e) => e.key).filter((k) => k !== "human:h1"));
  const picked = selectRecentConversationEntities({
    recentChannelIds: ["dm-a1", "c3", "c2", "missing", "dm-h1", "c1"],
    entities,
    activity: { c4: "2026-09-01T00:00:00.000Z", c1: "2026-09-02T00:00:00.000Z" },
    eligibleEntityKeys: eligible,
    excludeChannelId: "c2",
  });
  assert.deepEqual(picked.map((e) => e.key), [
    "agent:a1", // visited first
    "channel:c1", // visited (later), archived c3 / current c2 / hidden dm-h1 / unknown skipped
    "channel:c4", // activity fill (c1 already picked)
  ]);
});

test("selectRecentConversationEntities respects the row limit across both phases", () => {
  const entities = Array.from({ length: 6 }, (_, i) => entity(`channel:c${i}`, `c${i}`));
  const eligible = new Set(entities.map((e) => e.key));
  const picked = selectRecentConversationEntities({
    recentChannelIds: ["c5", "c4"],
    entities,
    activity: Object.fromEntries(entities.map((e, i) => [e.channelId!, `2026-09-0${i + 1}T00:00:00.000Z`])),
    eligibleEntityKeys: eligible,
    limit: 3,
  });
  assert.deepEqual(picked.map((e) => e.channelId), ["c5", "c4", "c3"]);
});

test("selectRecentConversationEntities fillFromActivity=false lists visited conversations only (History menu)", () => {
  const entities = [entity("channel:a", "a"), entity("channel:b", "b"), entity("channel:c", "c")];
  const eligible = new Set(entities.map((e) => e.key));
  const activity = { c: "2026-09-20T00:00:00.000Z", b: "2026-09-21T00:00:00.000Z" };
  assert.deepEqual(
    selectRecentConversationEntities({ recentChannelIds: ["a"], entities, activity, eligibleEntityKeys: eligible, fillFromActivity: false }).map((e) => e.channelId),
    ["a"],
  );
  // Default keeps the palette's activity fill.
  assert.deepEqual(
    selectRecentConversationEntities({ recentChannelIds: ["a"], entities, activity, eligibleEntityKeys: eligible }).map((e) => e.channelId),
    ["a", "b", "c"],
  );
  // Visits only, nothing visited → empty (the menu shows its empty state, never a guess).
  assert.deepEqual(
    selectRecentConversationEntities({ recentChannelIds: [], entities, activity, eligibleEntityKeys: eligible, fillFromActivity: false }),
    [],
  );
});
