import assert from "node:assert/strict";
import {
  moveSidebarItemToCustomSection,
  moveSidebarItemToCustomSectionAtPosition,
  normalizeSidebarSectionOrder,
  removeSidebarItemPlacement,
  reorderSidebarSectionOrder,
  sidebarItemSectionKey,
  sidebarMoveToHomeUpdate,
} from "../src/store/sidebarSections";

test("sidebar sections preserve user ordering and append missing sections once", () => {
  const sections = [
    { id: "project", name: "Project", emoji: null, sortMode: "manual" as const },
    { id: "customers", name: "Customers", emoji: "C", sortMode: "az" as const },
  ];
  assert.deepEqual(
    normalizeSidebarSectionOrder(["project", "system:pinned", "project", "missing"], sections),
    ["project", "system:pinned", "system:joint", "system:channels", "system:dms", "customers"],
  );
});

test("section reorder moves system and custom sections through one ordered list", () => {
  const order = ["system:pinned", "project", "system:joint", "system:channels", "system:dms"];
  assert.deepEqual(
    reorderSidebarSectionOrder(order, "system:dms", "project"),
    ["system:pinned", "system:dms", "project", "system:joint", "system:channels"],
  );
  assert.equal(reorderSidebarSectionOrder(order, "missing", "project"), order);
});

test("moving a sidebar item gives it one exclusive custom placement", () => {
  const seeded = [
    { kind: "channel" as const, id: "channel-a", sectionId: "alpha", position: 0 },
    { kind: "channel" as const, id: "channel-b", sectionId: "beta", position: 0 },
  ];
  assert.deepEqual(
    moveSidebarItemToCustomSection(seeded, { kind: "channel", id: "channel-a" }, "beta"),
    [
      { kind: "channel", id: "channel-b", sectionId: "beta", position: 0 },
      { kind: "channel", id: "channel-a", sectionId: "beta", position: 1 },
    ],
  );
});

test("moving between sections inserts at the requested position and reindexes the destination", () => {
  const seeded = [
    { kind: "channel" as const, id: "channel-a", sectionId: "alpha", position: 0 },
    { kind: "channel" as const, id: "channel-b", sectionId: "beta", position: 4 },
    { kind: "agent" as const, id: "agent-c", sectionId: "beta", position: 9 },
  ];
  assert.deepEqual(
    moveSidebarItemToCustomSectionAtPosition(
      seeded,
      { kind: "channel", id: "channel-a" },
      "beta",
      1,
    ),
    [
      { kind: "channel", id: "channel-b", sectionId: "beta", position: 0 },
      { kind: "channel", id: "channel-a", sectionId: "beta", position: 1 },
      { kind: "agent", id: "agent-c", sectionId: "beta", position: 2 },
    ],
  );
});

test("custom section insertion clamps before the first and after the last item", () => {
  const seeded = [
    { kind: "channel" as const, id: "channel-a", sectionId: "alpha", position: 0 },
    { kind: "channel" as const, id: "channel-b", sectionId: "beta", position: 0 },
  ];
  assert.deepEqual(
    moveSidebarItemToCustomSectionAtPosition(
      seeded,
      { kind: "channel", id: "channel-a" },
      "beta",
      -5,
    ).map((placement) => placement.id),
    ["channel-a", "channel-b"],
  );
  assert.deepEqual(
    moveSidebarItemToCustomSectionAtPosition(
      seeded,
      { kind: "channel", id: "channel-a" },
      "beta",
      Number.POSITIVE_INFINITY,
    ).map((placement) => placement.id),
    ["channel-b", "channel-a"],
  );
});

test("removing a custom placement leaves fallback projection to the caller", () => {
  const placements = [{ kind: "agent" as const, id: "agent-a", sectionId: "project", position: 0 }];
  assert.deepEqual(removeSidebarItemPlacement(placements, { kind: "agent", id: "agent-a" }), []);
});

test("removing an item without a custom placement preserves the placement snapshot", () => {
  const placements = [{ kind: "channel" as const, id: "channel-a", sectionId: "project", position: 0 }];

  assert.equal(
    removeSidebarItemPlacement(placements, { kind: "agent", id: "agent-without-placement" }),
    placements,
  );
});

test("the section a row is shown in: Pinned wins over a placement; a placement in a deleted section is home", () => {
  const customSections = [{ id: "project", name: "Project", emoji: null, sortMode: "manual" as const }];
  const key = (pinned: boolean, placementSectionId: string | null) => sidebarItemSectionKey({ pinned, placementSectionId, customSections, homeKey: "system:channels" });
  assert.equal(key(true, "project"), "system:pinned");
  assert.equal(key(false, "project"), "project");
  assert.equal(key(false, "deleted"), "system:channels");
  assert.equal(key(false, null), "system:channels");
});

test("moving a row home unpins it and drops its placement; already home writes nothing", () => {
  const item = { kind: "channel" as const, id: "c1" };
  const other = { kind: "channel" as const, id: "c2" };
  const state = {
    pinned: [item, other],
    sectionPlacements: [{ ...item, sectionId: "project", position: 0 }, { ...other, sectionId: "project", position: 1 }],
  };
  const update = sidebarMoveToHomeUpdate(state, item, item);
  assert.deepEqual(update.pinned, [other]);
  assert.deepEqual(update.sectionPlacements?.map((placement) => placement.id), ["c2"]);
  assert.deepEqual(sidebarMoveToHomeUpdate({ pinned: [], sectionPlacements: [] }, item, item), {});
});
