import assert from "node:assert/strict";
import {
  SIDEBAR_ROW_COUNT_MAX,
  readSidebarEntryShown,
  readSidebarSectionRowCounts,
  sidebarEntryShown,
  sidebarEntryStorageKey,
  sidebarHeldSkeletonRows,
  sidebarSectionRowCountStorageKey,
  sidebarSkeletonRows,
  writeSidebarEntryShown,
  writeSidebarSectionRowCounts,
} from "../src/components/layout/sidebarSectionRowCounts";
import { DEFAULT_SIDEBAR_ORDER, isSidebarOrderLoaded } from "../src/store/events/serverEvents";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

const UNKNOWN = { pinned: null, jointChannels: null, channels: null, dms: null };

test("sidebar row counts are remembered per user, per server and per section", () => {
  const storage = memoryStorage();
  writeSidebarSectionRowCounts("user:one", "server-a", { pinned: 2, jointChannels: 0, channels: 7, dms: 3 }, storage);
  writeSidebarSectionRowCounts("user:one", "server-b", { pinned: 0, jointChannels: 1, channels: 12, dms: 0 }, storage);

  assert.deepEqual(readSidebarSectionRowCounts("user:one", "server-a", storage), { pinned: 2, jointChannels: 0, channels: 7, dms: 3 });
  assert.deepEqual(readSidebarSectionRowCounts("user:one", "server-b", storage), { pinned: 0, jointChannels: 1, channels: 12, dms: 0 });
  assert.deepEqual(readSidebarSectionRowCounts("user:two", "server-a", storage), UNKNOWN, "another person's counts are not read");
  assert.match(sidebarSectionRowCountStorageKey("user:one", "server-a", "dms"), /^slock:sidebarRowCount:user%3Aone:server-a:direct-messages$/);
});

test("a later load overwrites the remembered count", () => {
  const storage = memoryStorage();
  writeSidebarSectionRowCounts("u", "s", { pinned: 1, jointChannels: 1, channels: 4, dms: 2 }, storage);
  writeSidebarSectionRowCounts("u", "s", { pinned: 0, jointChannels: 1, channels: 9, dms: 2 }, storage);
  assert.deepEqual(readSidebarSectionRowCounts("u", "s", storage), { pinned: 0, jointChannels: 1, channels: 9, dms: 2 });
});

test("row counts are capped, and invalid or missing values read as unknown", () => {
  const storage = memoryStorage();
  writeSidebarSectionRowCounts("u", "s", { pinned: 500, jointChannels: -3, channels: 2.7, dms: 0 }, storage);
  assert.deepEqual(readSidebarSectionRowCounts("u", "s", storage), {
    pinned: SIDEBAR_ROW_COUNT_MAX,
    jointChannels: 0,
    channels: 2,
    dms: 0,
  });

  storage.setItem(sidebarSectionRowCountStorageKey("u", "s", "channels"), "lots");
  assert.equal(readSidebarSectionRowCounts("u", "s", storage).channels, null);
  assert.deepEqual(readSidebarSectionRowCounts("u", "other", storage), UNKNOWN);
});

test("nothing is read or written without a user or a server, or when storage throws", () => {
  const storage = memoryStorage();
  writeSidebarSectionRowCounts(undefined, "s", { pinned: 1, jointChannels: 1, channels: 1, dms: 1 }, storage);
  writeSidebarSectionRowCounts("u", null, { pinned: 1, jointChannels: 1, channels: 1, dms: 1 }, storage);
  assert.equal(storage.length, 0);
  assert.deepEqual(readSidebarSectionRowCounts(undefined, "s", storage), UNKNOWN);

  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readSidebarSectionRowCounts("u", "s", throwing), UNKNOWN);
  assert.doesNotThrow(() => writeSidebarSectionRowCounts("u", "s", { pinned: 1, jointChannels: 1, channels: 1, dms: 1 }, throwing));
});

test("the skeleton draws the remembered rows, or the section's default when unknown", () => {
  assert.equal(sidebarSkeletonRows(6, 4), 6);
  assert.equal(sidebarSkeletonRows(0, 4), 0);
  assert.equal(sidebarSkeletonRows(null, 4), 4);
});

test("the sidebar order counts as read once it is anything but the reset value", () => {
  assert.equal(isSidebarOrderLoaded(DEFAULT_SIDEBAR_ORDER), false);
  assert.equal(isSidebarOrderLoaded({ ...DEFAULT_SIDEBAR_ORDER }), true);
});

test("a held section draws its remembered rows, else its default or the rows it has if more, capped", () => {
  assert.equal(sidebarHeldSkeletonRows(6, 4, 9), 6, "remembered wins");
  assert.equal(sidebarHeldSkeletonRows(0, 4, 2), 0);
  assert.equal(sidebarHeldSkeletonRows(null, 4, 2), 4);
  assert.equal(sidebarHeldSkeletonRows(null, 4, 7), 7, "never shorter than what it already has");
  assert.equal(sidebarHeldSkeletonRows(null, 4, 500), SIDEBAR_ROW_COUNT_MAX);
});

test("entry rows are remembered as shown or not, per user, per server and per entry", () => {
  const storage = memoryStorage();
  assert.equal(readSidebarEntryShown("u", "s", "drafts", storage), null, "never known: unknown");

  writeSidebarEntryShown("u", "s", "drafts", true, storage);
  writeSidebarEntryShown("u", "s", "assistant", false, storage);
  assert.equal(storage.getItem(sidebarEntryStorageKey("u", "s", "drafts")), "1");
  assert.equal(storage.getItem(sidebarEntryStorageKey("u", "s", "assistant")), "0");
  assert.equal(sidebarEntryStorageKey("u", "s", "assistant"), "slock:sidebarEntry:u:s:assistant");
  assert.equal(readSidebarEntryShown("u", "s", "drafts", storage), true);
  assert.equal(readSidebarEntryShown("u", "s", "assistant", storage), false);
  assert.equal(readSidebarEntryShown("u", "other", "drafts", storage), null);
  assert.equal(readSidebarEntryShown("other", "s", "drafts", storage), null);

  writeSidebarEntryShown("u", "s", "drafts", false, storage);
  assert.equal(readSidebarEntryShown("u", "s", "drafts", storage), false, "a later answer overwrites");

  storage.setItem(sidebarEntryStorageKey("u", "s", "drafts"), "yes");
  assert.equal(readSidebarEntryShown("u", "s", "drafts", storage), null, "an invalid value reads as unknown");
});

test("entry memory reads and writes nothing without a user or a server, or when storage throws", () => {
  const storage = memoryStorage();
  writeSidebarEntryShown(undefined, "s", "drafts", true, storage);
  writeSidebarEntryShown("u", null, "drafts", true, storage);
  assert.equal(storage.length, 0);
  assert.equal(readSidebarEntryShown(undefined, "s", "drafts", storage), null);

  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(readSidebarEntryShown("u", "s", "drafts", throwing), null);
  assert.doesNotThrow(() => writeSidebarEntryShown("u", "s", "assistant", true, throwing));
});

test("an entry row shows per the answer once known, else as last time, else not", () => {
  assert.equal(sidebarEntryShown(true, false), true);
  assert.equal(sidebarEntryShown(false, true), false);
  assert.equal(sidebarEntryShown(null, true), true);
  assert.equal(sidebarEntryShown(null, false), false);
  assert.equal(sidebarEntryShown(null, null), false);
});
