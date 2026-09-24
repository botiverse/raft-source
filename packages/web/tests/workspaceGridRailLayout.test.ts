import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH,
  DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT,
  MAX_WORKSPACE_GRID_SIDEBAR_WIDTH,
  MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,
  moveWorkspaceGridRailItem,
  normalizeWorkspaceGridRailLayout,
  normalizeWorkspaceGridSidebarWidth,
  useWorkspaceGridNavigationStore,
} from "../src/components/workspace/workspaceGridNavigationStore";
import {
  isWorkspaceRailRightEdge,
  shouldActivateWorkspaceRailDrag,
} from "../src/components/workspace/workspaceRailDrag";

test("workspace rail layout rejects unknown and duplicate items while recovering missing defaults", () => {
  assert.deepEqual(normalizeWorkspaceGridRailLayout({
    left: ["chat", "unknown", "chat"],
    right: ["tasks", "wiki", "settings"],
  }), {
    left: ["chat", "search", "activity", "wiki", "saved", "members", "computers"],
    right: ["tasks"],
  });
  assert.deepEqual(normalizeWorkspaceGridRailLayout(null), DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT);
  assert.deepEqual(normalizeWorkspaceGridRailLayout({
    left: ["search", "chat", "activity", "tasks", "saved", "members", "computers"],
    right: [],
  }).left, ["search", "chat", "activity", "tasks", "wiki", "saved", "members", "computers"]);
});

test("workspace rail items move across sides without duplication and carry the active view", () => {
  useWorkspaceGridNavigationStore.setState({
    railLayout: {
      left: [...DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT.left],
      right: [],
    },
    railMode: "chat",
    activeRailSide: "left",
    sidebarCollapsed: false,
    sidebars: {
      left: { activeItem: "chat", collapsed: false },
      right: { activeItem: null, collapsed: true },
    },
  });

  useWorkspaceGridNavigationStore.getState().moveRailItem("chat", "right", 0, null);
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().railLayout, {
    left: ["search", "activity", "tasks", "wiki", "saved", "members", "computers"],
    right: ["chat"],
  });
  assert.equal(useWorkspaceGridNavigationStore.getState().activeRailSide, "right");
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().sidebars, {
    left: { activeItem: "search", collapsed: false },
    right: { activeItem: "chat", collapsed: false },
  });

  useWorkspaceGridNavigationStore.setState({ active: false, railMode: null, activeRailSide: "left" });
  useWorkspaceGridNavigationStore.getState().setActive(true);
  assert.equal(useWorkspaceGridNavigationStore.getState().railMode, "search");
  assert.equal(useWorkspaceGridNavigationStore.getState().activeRailSide, "left");

  useWorkspaceGridNavigationStore.getState().moveRailItem("tasks", "right", 0, null);
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().railLayout.right, ["tasks", "chat"]);
  assert.equal(useWorkspaceGridNavigationStore.getState().railLayout.left.includes("tasks"), false);

  useWorkspaceGridNavigationStore.getState().moveRailItem("tasks", "right", 2, null);
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().railLayout.right, ["chat", "tasks"]);
});

test("workspace Wiki remains a fixed left-rail item", () => {
  const layout = normalizeWorkspaceGridRailLayout(null);
  assert.equal(moveWorkspaceGridRailItem(layout, "wiki", "right", 0), layout);
});

test("workspace sidebar widths clamp independently and rail drag uses deliberate activation/right-edge preview", () => {
  assert.equal(normalizeWorkspaceGridSidebarWidth(undefined, 1440), DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH);
  assert.equal(normalizeWorkspaceGridSidebarWidth(100, 1440), MIN_WORKSPACE_GRID_SIDEBAR_WIDTH);
  assert.equal(normalizeWorkspaceGridSidebarWidth(900, 1440), MAX_WORKSPACE_GRID_SIDEBAR_WIDTH);
  assert.equal(normalizeWorkspaceGridSidebarWidth(420, 1024), 409);

  assert.equal(shouldActivateWorkspaceRailDrag(10, 10, 13, 12), false);
  assert.equal(shouldActivateWorkspaceRailDrag(10, 10, 14, 10), true);
  assert.equal(isWorkspaceRailRightEdge(975, 1000), false);
  assert.equal(isWorkspaceRailRightEdge(976, 1000), true);
});
