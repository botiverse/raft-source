import assert from "node:assert/strict";
import { test } from "vitest";
import { RAIL_TAB_IDS, normalizeRailTabOrder } from "./railTabOrder";

test("no saved order is the default order, Apps right after Computers", () => {
  assert.deepEqual(normalizeRailTabOrder(null), [...RAIL_TAB_IDS]);
  assert.equal(RAIL_TAB_IDS.indexOf("apps"), RAIL_TAB_IDS.indexOf("computers") + 1);
});

test("a saved order from before Apps gets it right after Computers, not at the end", () => {
  assert.deepEqual(
    normalizeRailTabOrder(["computers", "tasks", "chat", "search", "activity", "members", "assistant"]),
    ["computers", "apps", "tasks", "artifacts", "chat", "search", "activity", "members", "assistant"],
  );
});

test("other left-out tabs still follow at the end in default order; unknown ids drop", () => {
  assert.deepEqual(
    normalizeRailTabOrder(["tasks", "wiki", "chat", "tasks"]),
    ["tasks", "artifacts", "chat", "search", "activity", "members", "computers", "apps", "assistant"],
  );
  assert.deepEqual(
    normalizeRailTabOrder(["tasks", "computers", "chat"]),
    ["tasks", "artifacts", "computers", "apps", "chat", "search", "activity", "members", "assistant"],
  );
});

test("a saved order that places Apps keeps it there", () => {
  assert.deepEqual(
    normalizeRailTabOrder(["apps", "chat", "search", "activity", "tasks", "members", "computers", "assistant"]),
    ["apps", "chat", "search", "activity", "tasks", "artifacts", "members", "computers", "assistant"],
  );
});

test("a saved order from before Artifacts (#133) gets it right after Tasks, wherever Tasks is; one that places it keeps it", () => {
  assert.equal(RAIL_TAB_IDS.indexOf("artifacts"), RAIL_TAB_IDS.indexOf("tasks") + 1);
  assert.deepEqual(
    normalizeRailTabOrder(["chat", "search", "activity", "members", "computers", "apps", "assistant", "tasks"]),
    ["chat", "search", "activity", "members", "computers", "apps", "assistant", "tasks", "artifacts"],
  );
  assert.deepEqual(
    normalizeRailTabOrder(["artifacts", "chat", "search", "activity", "tasks", "members", "computers", "apps", "assistant"]),
    ["artifacts", "chat", "search", "activity", "tasks", "members", "computers", "apps", "assistant"],
  );
});
