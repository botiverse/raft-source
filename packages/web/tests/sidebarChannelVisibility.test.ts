import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../src/store/channelStore";
import {
  filterSidebarChannelsByMembership,
  readSidebarJoinedChannelsOnly,
  sidebarJoinedChannelsOnlyStorageKey,
  shouldShowSidebarChannelEmptyState,
  writeSidebarJoinedChannelsOnly,
} from "../src/components/layout/sidebarChannelVisibility";

function channel(id: string, joined?: boolean): Channel {
  return {
    id,
    name: id,
    serverId: "server-1",
    type: "public",
    createdAt: "2026-07-12T00:00:00.000Z",
    archivedAt: null,
    joined,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test("joined-only sidebar visibility defaults to the all-channel overview", () => {
  const storage = memoryStorage();

  assert.equal(readSidebarJoinedChannelsOnly("server-1", storage), false);
  assert.deepEqual(
    filterSidebarChannelsByMembership(
      [channel("joined", true), channel("not-joined", false), channel("legacy")],
      false,
    ).map((item) => item.id),
    ["joined", "not-joined", "legacy"],
  );
});

test("joined-only sidebar visibility is strict and persisted per server", () => {
  const storage = memoryStorage();
  writeSidebarJoinedChannelsOnly("server-1", true, storage);

  assert.equal(storage.getItem(sidebarJoinedChannelsOnlyStorageKey("server-1")), "true");
  assert.equal(readSidebarJoinedChannelsOnly("server-1", storage), true);
  assert.equal(readSidebarJoinedChannelsOnly("server-2", storage), false);
  assert.deepEqual(
    filterSidebarChannelsByMembership(
      [channel("joined", true), channel("not-joined", false), channel("legacy")],
      true,
    ).map((item) => item.id),
    ["joined"],
  );
});

test("sidebar visibility persistence tolerates unavailable storage and server identity", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("unavailable");
    },
    setItem: () => {
      throw new Error("unavailable");
    },
  };

  assert.equal(readSidebarJoinedChannelsOnly("server-1", throwingStorage), false);
  assert.doesNotThrow(() => writeSidebarJoinedChannelsOnly("server-1", true, throwingStorage));
  assert.equal(readSidebarJoinedChannelsOnly(undefined, throwingStorage), false);
});

test("sidebar empty state appears only after the active view has no channels", () => {
  assert.equal(shouldShowSidebarChannelEmptyState([]), true);
  assert.equal(shouldShowSidebarChannelEmptyState([channel("joined", true)]), false);
});
