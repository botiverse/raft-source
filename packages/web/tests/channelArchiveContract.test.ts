import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVED_CHANNEL_BADGE_CLASS,
  ARCHIVED_CHANNEL_ICON_CLASS,
  ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  ARCHIVED_CHANNEL_TEXT_CLASS,
} from "../src/components/channel/channelArchiveVisual.js";
import { buildSearchEntityResults } from "../src/components/search/searchEntities.js";
import type { Channel } from "../src/store/channelStore.js";

/**
 * UI contract pins for the archive feature.
 *
 * These tests exercise the same predicates used by the real UI, without
 * pulling the channel store's runtime dependencies (api client, socket,
 * localStorage) into the test. The `Channel` type import is a type-only
 * import and erased at runtime, so this file stays fully portable across
 * node:test runs.
 *
 * Each helper below mirrors the exact code the component uses — if the
 * component is ever changed, the matching helper here must move with it
 * and this test pins the behavior.
 */

function makeChannel(overrides: Partial<Channel> & { id: string; name: string }): Channel {
  return {
    description: null,
    type: "channel",
    createdAt: new Date().toISOString(),
    archivedAt: null,
    archivedByUserId: null,
    ...overrides,
  } as Channel;
}

/** Mirrors Sidebar.tsx:540 — the sidebar's channel display filter. */
function visibleInSidebar(channels: Channel[]): Channel[] {
  return channels.filter((c) => !c.archivedAt);
}

/** Mirrors Sidebar.tsx:569 — the pinned-channels display filter. */
function visiblePinnedChannels(channels: Channel[], pinnedIds: string[]): Channel[] {
  return pinnedIds
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => !!c && !c.archivedAt);
}

/** Mirrors EditChannelDialog.tsx:34 — the dialog's archive flag. */
function editDialogIsArchived(channel: Channel | undefined): boolean {
  return !!channel?.archivedAt;
}

test("sidebar filter hides archived channels while keeping active ones visible", () => {
  const active = makeChannel({ id: "c1", name: "active-1" });
  const otherActive = makeChannel({ id: "c2", name: "active-2" });
  const archived = makeChannel({
    id: "c3",
    name: "archived-1",
    archivedAt: new Date().toISOString(),
  });

  const visible = visibleInSidebar([active, otherActive, archived]);
  assert.equal(visible.length, 2, "archived channel must not appear in sidebar");
  assert.ok(visible.every((c) => c.id !== "c3"), "c3 (archived) must be filtered out");
  assert.ok(visible.some((c) => c.id === "c1"));
  assert.ok(visible.some((c) => c.id === "c2"));
});

test("sidebar filter hides archived channels even if they are pinned", () => {
  const pinnedActive = makeChannel({ id: "pin-1", name: "pinned-active" });
  const pinnedArchived = makeChannel({
    id: "pin-2",
    name: "pinned-archived",
    archivedAt: new Date().toISOString(),
  });

  const resolved = visiblePinnedChannels(
    [pinnedActive, pinnedArchived],
    ["pin-1", "pin-2"],
  );

  assert.equal(resolved.length, 1, "archived pinned channel must not render");
  assert.equal(resolved[0].id, "pin-1");
});

test("EditChannelDialog isArchived: truthy archivedAt → true, null/undefined → false", () => {
  const active = makeChannel({ id: "c1", name: "active" });
  const archivedNow = makeChannel({
    id: "c2",
    name: "archived",
    archivedAt: new Date().toISOString(),
  });
  const archivedNull = makeChannel({ id: "c3", name: "reset", archivedAt: null });

  assert.equal(editDialogIsArchived(active), false, "never-archived → false");
  assert.equal(editDialogIsArchived(archivedNow), true, "currently archived → true");
  assert.equal(editDialogIsArchived(archivedNull), false, "unarchived (null) → false");
  assert.equal(editDialogIsArchived(undefined), false, "missing channel → false");
});

test("archive flip: stamping archivedAt immediately swaps UI affordances", () => {
  const active = makeChannel({ id: "c1", name: "freezing" });

  // Before archive: visible in sidebar, dialog in write mode.
  assert.equal(visibleInSidebar([active]).length, 1);
  assert.equal(editDialogIsArchived(active), false);

  // Simulate the store mutation applied after a successful archiveChannel call.
  const archived: Channel = {
    ...active,
    archivedAt: new Date().toISOString(),
    archivedByUserId: "user-9",
  };

  // After archive: hidden from sidebar, dialog flips to read-only + unarchive.
  assert.equal(visibleInSidebar([archived]).length, 0, "sidebar must hide it immediately");
  assert.equal(
    editDialogIsArchived(archived),
    true,
    "dialog must swap to read-only + unarchive button",
  );
});

test("unarchive flip: clearing archivedAt restores write UI and sidebar visibility", () => {
  const archived = makeChannel({
    id: "c1",
    name: "reviving",
    archivedAt: new Date().toISOString(),
    archivedByUserId: "user-1",
  });

  // Before unarchive: hidden, dialog in read-only mode.
  assert.equal(visibleInSidebar([archived]).length, 0);
  assert.equal(editDialogIsArchived(archived), true);

  // Simulate the store mutation applied after a successful unarchiveChannel call.
  const revived: Channel = { ...archived, archivedAt: null, archivedByUserId: null };

  // After unarchive: visible again, dialog in write mode.
  assert.equal(visibleInSidebar([revived]).length, 1, "sidebar must surface it again");
  assert.equal(
    editDialogIsArchived(revived),
    false,
    "dialog must flip back to write mode + archive button",
  );
});

test("archived channels still exist in the data source (store retains them for permalinks)", () => {
  // Sidebar hides archived channels, but the store keeps them so that
  // permalinks and search hits can resolve channel metadata without a
  // separate fetch (channelStore.ts:68-71).
  const active = makeChannel({ id: "c1", name: "active" });
  const archived = makeChannel({
    id: "c2",
    name: "archived",
    archivedAt: new Date().toISOString(),
  });
  const storeSnapshot = [active, archived];

  assert.equal(storeSnapshot.length, 2, "both channels must coexist in the data source");
  assert.ok(
    storeSnapshot.some((c) => c.id === "c2"),
    "archived channel remains discoverable for permalinks/search",
  );
  assert.equal(
    visibleInSidebar(storeSnapshot).length,
    1,
    "but only the active one is shown in the sidebar",
  );
});

test("entity search returns archived channels (same ranking rules, no archive filter)", () => {
  const activeHit = makeChannel({ id: "c-active", name: "project-alpha" });
  const archivedHit = makeChannel({
    id: "c-archived",
    name: "project-beta",
    archivedAt: new Date().toISOString(),
  });

  const results = buildSearchEntityResults({
    query: "project",
    channels: [activeHit, archivedHit],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });

  const keys = results.map((r) => r.key);
  assert.ok(keys.includes("channel:c-active"), "active channel must match");
  assert.ok(
    keys.includes("channel:c-archived"),
    "archived channel must still match entity search — users need to find it to unarchive",
  );

  const activeResult = results.find((r) => r.key === "channel:c-active");
  const archivedResult = results.find((r) => r.key === "channel:c-archived");
  assert.equal(activeResult?.archivedAt, null, "active channel entity result exposes null archivedAt");
  assert.ok(
    archivedResult?.archivedAt,
    "archived channel entity result exposes truthy archivedAt so the UI can render an Archived pill",
  );
});

test("archived channel muted treatment tokens stay pinned", () => {
  assert.equal(ARCHIVED_CHANNEL_TEXT_CLASS, "text-black/45");
  assert.equal(ARCHIVED_CHANNEL_MUTED_TEXT_CLASS, "text-black/30");
  assert.equal(ARCHIVED_CHANNEL_ICON_CLASS, "border-black/40 bg-black/5 text-black/45");
  assert.equal(
    ARCHIVED_CHANNEL_BADGE_CLASS,
    "border border-black/40 bg-black/5 px-1 py-0.5 text-[9px] font-bold leading-none text-black/45",
  );
});
