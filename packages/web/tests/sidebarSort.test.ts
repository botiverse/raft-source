import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../src/store/channelStore.js";
import { sortSidebarChannels, sortSidebarDms, sortSidebarPinnedItems } from "../src/components/layout/sidebarSort.js";

function channel(overrides: Partial<Channel> & Pick<Channel, "id" | "name">): Channel {
  return {
    description: null,
    type: "channel",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("sortSidebarChannels keeps #all first while sorting the rest by latest message", () => {
  const all = channel({ id: "all-id", name: "all", createdAt: "2026-01-01T00:00:00.000Z" });
  const oldCreatedRecentMessage = channel({
    id: "older-created",
    name: "beta",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const newCreatedOldMessage = channel({
    id: "newer-created",
    name: "alpha",
    createdAt: "2026-01-04T00:00:00.000Z",
  });
  // lastMessageAt now lives in the activity slice (keyed by channel id).
  const activity = {
    "older-created": "2026-01-05T00:00:00.000Z",
    "newer-created": "2026-01-03T00:00:00.000Z",
  };

  assert.deepEqual(
    sortSidebarChannels([newCreatedOldMessage, all, oldCreatedRecentMessage], "recent", activity, all.id).map((item) => item.id),
    ["all-id", "older-created", "newer-created"],
  );
});

test("a channelActivity bump reorders the recency sort without touching the channel objects", () => {
  // 铁根's ① pin (#proj-frontend:24c90895): the live harness can't positively
  // observe reorder-on-bump (slockdev only propagates message:new for subscribed
  // channels, and #general already sits topmost under recency). Pin it
  // deterministically here: the SAME channel identity objects, only the
  // `channelActivity` slice changes, must flip the recency order. This is the
  // whole point of slice-separation — recency reads activity by id, the bump
  // never mutates/replaces the cold identity objects.
  const alpha = channel({ id: "alpha", name: "alpha", createdAt: "2026-01-01T00:00:00.000Z" });
  const beta = channel({ id: "beta", name: "beta", createdAt: "2026-01-01T00:00:00.000Z" });
  const items = [alpha, beta];

  // beta more recent → beta first.
  const before = { alpha: "2026-01-02T00:00:00.000Z", beta: "2026-01-03T00:00:00.000Z" };
  assert.deepEqual(sortSidebarChannels(items, "recent", before).map((c) => c.id), ["beta", "alpha"]);

  // Bump alpha's activity to newest (only the slice changes) → alpha bubbles up.
  const afterBump = { ...before, alpha: "2026-01-04T00:00:00.000Z" };
  const reordered = sortSidebarChannels(items, "recent", afterBump);
  assert.deepEqual(reordered.map((c) => c.id), ["alpha", "beta"]);

  // Teeth: the bump reordered by reading the slice, NOT by mutating identity —
  // the exact channel objects survive unchanged across the reorder.
  assert.strictEqual(reordered.find((c) => c.id === "alpha"), alpha);
  assert.strictEqual(reordered.find((c) => c.id === "beta"), beta);

  // DMs reorder the same way off the same slice.
  const dmA = channel({ id: "dmA", name: "dmA", type: "dm", peerName: "dmA", createdAt: "2026-01-01T00:00:00.000Z" });
  const dmB = channel({ id: "dmB", name: "dmB", type: "dm", peerName: "dmB", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(sortSidebarDms([dmA, dmB], "recent", { dmA: "2026-01-02T00:00:00.000Z", dmB: "2026-01-05T00:00:00.000Z" }).map((c) => c.id), ["dmB", "dmA"]);
  assert.deepEqual(sortSidebarDms([dmA, dmB], "recent", { dmA: "2026-01-09T00:00:00.000Z", dmB: "2026-01-05T00:00:00.000Z" }).map((c) => c.id), ["dmA", "dmB"]);
});

test("sortSidebarChannels sorts A-Z by channel name after #all", () => {
  const all = channel({ id: "all-id", name: "all" });
  const zebra = channel({ id: "zebra-id", name: "zebra" });
  const alpha = channel({ id: "alpha-id", name: "Alpha" });

  assert.deepEqual(
    sortSidebarChannels([zebra, all, alpha], "az", {}, all.id).map((item) => item.id),
    ["all-id", "alpha-id", "zebra-id"],
  );
});

test("sortSidebarDms sorts by peer display name for A-Z", () => {
  const zed = channel({ id: "zed-id", name: "dm-zed", type: "dm", peerName: "zed" });
  const amy = channel({ id: "amy-id", name: "dm-amy", type: "dm", peerDisplayName: "Amy" });
  const bob = channel({ id: "bob-id", name: "dm-bob", type: "dm", peerName: "bob" });

  assert.deepEqual(
    sortSidebarDms([zed, amy, bob], "az", {}).map((item) => item.id),
    ["amy-id", "bob-id", "zed-id"],
  );
});

test("manual sort preserves existing order", () => {
  const first = channel({ id: "first", name: "first" });
  const second = channel({ id: "second", name: "second" });

  assert.deepEqual(sortSidebarDms([first, second], "manual", {}).map((item) => item.id), ["first", "second"]);
});

test("sortSidebarPinnedItems sorts mixed pinned items by recent activity", () => {
  const oldChannel = {
    id: "channel",
    label: "channel",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-02T00:00:00.000Z",
  };
  const recentAgentDm = {
    id: "agent",
    label: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-05T00:00:00.000Z",
  };
  const noMessagesDm = {
    id: "dm",
    label: "dm",
    createdAt: "2026-01-04T00:00:00.000Z",
  };

  assert.deepEqual(
    sortSidebarPinnedItems([oldChannel, recentAgentDm, noMessagesDm], "recent").map((item) => item.id),
    ["agent", "dm", "channel"],
  );
});

test("sortSidebarPinnedItems sorts mixed pinned items A-Z by display label", () => {
  assert.deepEqual(
    sortSidebarPinnedItems([
      { id: "z", label: "Zebra", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a", label: "alpha", createdAt: "2026-01-01T00:00:00.000Z" },
    ], "az").map((item) => item.id),
    ["a", "z"],
  );
});
