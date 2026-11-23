import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { readStoredFolds, TASKS_PAGE_FOLDS_STORAGE_PREFIX, useTasksPageStore } from "../src/store/tasksPageStore";

/**
 * The Tasks page's folds (its board columns) are kept per server in
 * this browser (#triage:c5cf6495): a column folded once stays folded after a
 * server switch or a reload.
 */

function server(id: string): Server {
  return {
    id,
    name: id,
    avatarUrl: null,
    slug: id,
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-11-19T00:00:00.000Z",
  };
}

/** What a server switch does: the new current server, then every store's reset. */
function switchTo(id: string) {
  useServerStore.setState({ current: server(id) });
  triggerServerReset();
}

afterEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTasksPageStore.setState({ collapsed: {} });
  localStorage.clear();
});

test("a fold is kept for its server and comes back after switching away and back", () => {
  switchTo("server-a");
  useTasksPageStore.getState().setCollapsed("board:done", true);
  assert.deepEqual(readStoredFolds("server-a"), { "board:done": true });

  switchTo("server-b");
  assert.deepEqual(useTasksPageStore.getState().collapsed, {}, "another server starts from its own folds");
  useTasksPageStore.getState().setCollapsed("board:closed", false);

  switchTo("server-a");
  assert.deepEqual(useTasksPageStore.getState().collapsed, { "board:done": true });
  assert.deepEqual(readStoredFolds("server-b"), { "board:closed": false });
});

test("unreadable stored folds read as none", () => {
  localStorage.setItem(`${TASKS_PAGE_FOLDS_STORAGE_PREFIX}server-a`, "not json");
  assert.deepEqual(readStoredFolds("server-a"), {});
  localStorage.setItem(`${TASKS_PAGE_FOLDS_STORAGE_PREFIX}server-a`, JSON.stringify({ "board:done": true, bogus: "yes" }));
  assert.deepEqual(readStoredFolds("server-a"), { "board:done": true });
  assert.deepEqual(readStoredFolds(null), {});
});
