import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
  readSidebarAgentMachineGroupCollapsed,
  readSidebarCustomSectionCollapsed,
  readSidebarCollapsedSections,
  sidebarAgentMachineGroupCollapsedStorageKey,
  sidebarCustomSectionCollapsedStorageKey,
  sidebarCollapsedSectionStorageKey,
  writeSidebarAgentMachineGroupCollapsed,
  writeSidebarCustomSectionCollapsed,
  writeSidebarCollapsedSection,
} from "../src/components/layout/sidebarCollapsedSections";

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

test("sidebar disclosure preferences are stored per user and per stable section id", () => {
  const storage = memoryStorage();

  writeSidebarCollapsedSection("human:one", "channels", true, storage);
  writeSidebarCollapsedSection("human:one", "agents", true, storage);
  writeSidebarCollapsedSection("human:two", "pinned", true, storage);

  assert.deepEqual(readSidebarCollapsedSections("human:one", storage), {
    ...DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
    channels: true,
    agents: true,
  });
  assert.deepEqual(readSidebarCollapsedSections("human:two", storage), {
    ...DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
    pinned: true,
  });
  assert.equal(
    storage.getItem(sidebarCollapsedSectionStorageKey("human:one", "agents")),
    "true",
  );
  assert.match(
    sidebarCollapsedSectionStorageKey("human:one", "agents"),
    /human%3Aone:direct-messages$/,
  );
});

test("sidebar disclosure preferences keep defaults for absent users and invalid values", () => {
  const storage = memoryStorage();
  storage.setItem(sidebarCollapsedSectionStorageKey("human-one", "channels"), "collapsed");

  assert.deepEqual(
    readSidebarCollapsedSections(undefined, storage),
    DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
  );
  assert.deepEqual(
    readSidebarCollapsedSections("human-one", storage),
    DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
  );

  writeSidebarCollapsedSection(undefined, "channels", true, storage);
  assert.equal(storage.length, 1, "an unauthenticated render must not create a shared preference");
});

test("an explicit expand overwrites only that section's prior collapsed value", () => {
  const storage = memoryStorage();
  writeSidebarCollapsedSection("human-one", "channels", true, storage);
  writeSidebarCollapsedSection("human-one", "pinned", true, storage);
  writeSidebarCollapsedSection("human-one", "channels", false, storage);

  assert.deepEqual(readSidebarCollapsedSections("human-one", storage), {
    ...DEFAULT_SIDEBAR_COLLAPSED_SECTIONS,
    pinned: true,
    channels: false,
  });
  assert.equal(storage.length, 2);
});

test("custom sidebar section disclosure is persisted per user and section id", () => {
  const storage = memoryStorage();

  writeSidebarCustomSectionCollapsed("human-one", "section-a", true, storage);
  writeSidebarCustomSectionCollapsed("human-one", "section-b", false, storage);
  writeSidebarCustomSectionCollapsed("human-two", "section-a", false, storage);

  assert.equal(readSidebarCustomSectionCollapsed("human-one", "section-a", storage), true);
  assert.equal(readSidebarCustomSectionCollapsed("human-one", "section-b", storage), false);
  assert.equal(readSidebarCustomSectionCollapsed("human-two", "section-a", storage), false);
  assert.equal(readSidebarCustomSectionCollapsed("human-two", "section-b", storage), false);
  assert.match(
    sidebarCustomSectionCollapsedStorageKey("human-one", "section-a"),
    /human-one:custom:section-a$/,
  );
});

test("custom sidebar section disclosure defaults closed=false when storage is unavailable or invalid", () => {
  const storage = memoryStorage();
  storage.setItem(sidebarCustomSectionCollapsedStorageKey("human-one", "section-a"), "collapsed");

  assert.equal(readSidebarCustomSectionCollapsed(undefined, "section-a", storage), false);
  assert.equal(readSidebarCustomSectionCollapsed("human-one", "section-a", storage), false);

  writeSidebarCustomSectionCollapsed(undefined, "section-a", true, storage);
  assert.equal(storage.length, 1);
});

test("agent machine group disclosure is persisted per user and stable machine id", () => {
  const storage = memoryStorage();

  writeSidebarAgentMachineGroupCollapsed("human-one", "machine-a", true, storage);
  writeSidebarAgentMachineGroupCollapsed("human-one", "__no_machine__", true, storage);
  writeSidebarAgentMachineGroupCollapsed("human-two", "machine-a", false, storage);

  assert.equal(readSidebarAgentMachineGroupCollapsed("human-one", "machine-a", storage), true);
  assert.equal(readSidebarAgentMachineGroupCollapsed("human-one", "machine-b", storage), false);
  assert.equal(readSidebarAgentMachineGroupCollapsed("human-one", "__no_machine__", storage), true);
  assert.equal(readSidebarAgentMachineGroupCollapsed("human-two", "machine-a", storage), false);
  assert.match(
    sidebarAgentMachineGroupCollapsedStorageKey("human-one", "machine-a"),
    /human-one:agent-machine-group:machine-a$/,
  );
});

test("agent machine group disclosure defaults closed=false when storage is unavailable or invalid", () => {
  const storage = memoryStorage();
  storage.setItem(sidebarAgentMachineGroupCollapsedStorageKey("human-one", "machine-a"), "collapsed");

  assert.equal(readSidebarAgentMachineGroupCollapsed(undefined, "machine-a", storage), false);
  assert.equal(readSidebarAgentMachineGroupCollapsed("human-one", "machine-a", storage), false);

  writeSidebarAgentMachineGroupCollapsed(undefined, "machine-a", true, storage);
  assert.equal(storage.length, 1);
});
