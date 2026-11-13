/**
 * The sidebar's and the Activity list's collapsed states are read back from
 * storage when the app loads, and every change is written back. A reload is a
 * fresh uiStore, so these cases reset the module registry; they live apart from
 * sidebarCollapse.behavior.test.tsx (removed in the 2026-11 web DOM test prune) because a reset there made the lazily
 * loaded legacy task panel read a store of its own (#triage:#222).
 */
import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ACTIVITY_LIST_HIDDEN_STORAGE_KEY, SIDEBAR_HIDDEN_STORAGE_KEY } from "../src/store/uiStore";

afterEach(() => {
  window.localStorage.clear();
});

test("the store starts from the remembered state and writes every change back", async () => {
  window.localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, "true");
  vi.resetModules();
  const fresh = await import("../src/store/uiStore");
  assert.equal(fresh.useUIStore.getState().sidebarHidden, true, "a reload restores the collapsed sidebar");

  fresh.useUIStore.getState().setSidebarHidden(false);
  assert.equal(window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY), null);
  fresh.useUIStore.getState().setSidebarHidden(true);
  assert.equal(window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY), "true");

  window.localStorage.clear();
  vi.resetModules();
  const cleared = await import("../src/store/uiStore");
  assert.equal(cleared.useUIStore.getState().sidebarHidden, false, "the sidebar is open by default");
});

test("the Activity list's collapsed state is read back from storage", async () => {
  window.localStorage.setItem(ACTIVITY_LIST_HIDDEN_STORAGE_KEY, "true");
  vi.resetModules();
  const fresh = await import("../src/store/uiStore");
  assert.equal(fresh.useUIStore.getState().activityListHidden, true);
  assert.equal(fresh.useUIStore.getState().sidebarHidden, false);
});
