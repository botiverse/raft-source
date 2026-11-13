// Task v2 side sections (task #165): where each column stands (placeSections), how tall a floating column is, and
// which section shows where only one fits. On a desktop every column stands in the row and the row's plan gives
// each its width (#proj-raft-ui:#189: rowPlan, tests/rowPlan.test.ts); nothing floats there, and the thread folds
// into the conversation's column where the plan says so (`fold`). On a phone the sections cover or float.
import assert from "node:assert/strict";
import { DEFAULT_CHANNEL_SIDE_LAYOUT } from "@botiverse/raft-shared";
import type { ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

import { placeSections } from "../src/components/task/ChannelSideArea";
import type { SideRoom } from "../src/components/task/ChannelSideArea";
import { activeSideCard, sideCardsColumnHeight, sideCardsOneAtATime } from "../src/components/task/sideCardsLayout";

const room = (over: Partial<SideRoom>): SideRoom => ({ room: 1200, viewportWidth: 1440, panelWidth: 800, panelHeight: 800, composerHeight: 90, threadInRow: false, threadWidth: 0, threadMaximized: false, threadCoversRow: false, rowWidth: 1200, threadOpen: false, profileOpen: false, legacyTask: false, touchPortrait: false, ...over });
const open = (...sections: ChannelSideSection[]) => new Set(sections);
const both = open("tasks", "files");
const summary = (p: ReturnType<typeof placeSections>) => ({ row: p.row.map((c) => `${c.column}:${c.sections.join("+")}`), floating: p.floating.join("+"), floatMode: p.floatMode, threadColumn: p.threadColumn });

test("a desktop: every column stands in the row, however narrow (the plan shares the room out, #189); nothing floats", () => {
  for (const width of [2000, 640, 300, 0]) {
    assert.deepEqual(summary(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, both, room({ room: width }))), { row: ["1:tasks+files"], floating: "", floatMode: "float", threadColumn: null }, `room ${width}`);
  }
  const layout: ChannelSideLayout = { v: 1, columns: [{ sections: ["tasks"], width: 300 }, { sections: ["thread"], width: 400 }, { sections: ["files"], width: 300 }] };
  assert.deepEqual(summary(placeSections(layout, open("thread", "tasks", "files"), room({ room: 200, threadOpen: true }))), { row: ["0:tasks", "2:files"], floating: "", floatMode: "float", threadColumn: 1 });
});

test("a phone: everything covers the panel; outside a layout row, the panel's width decides between covering and floating", () => {
  assert.deepEqual(summary(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, both, room({ viewportWidth: 390, room: 390 }))), { row: [], floating: "tasks+files", floatMode: "overlay", threadColumn: null });
  assert.equal(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, both, room({ room: null, panelWidth: 600 })).floatMode, "float");
  assert.equal(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, both, room({ room: null, panelWidth: 500 })).floatMode, "overlay");
  assert.deepEqual(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, open("thread", "tasks", "files"), room({ viewportWidth: 390, room: 390, threadOpen: true, threadCoversRow: true })).companions, { before: [], after: [] }, "a phone's thread is a page of its own: it takes nothing along");
});

test("rule 3: folded, the thread takes no place among the columns; the sections stacked with it stand in its column without it", () => {
  const layout: ChannelSideLayout = { v: 1, columns: [{ sections: ["files", "thread", "tasks"], width: 400 }] };
  const all = open("thread", "tasks", "files");
  const standing = placeSections(layout, all, room({ threadOpen: true }));
  assert.equal(standing.covers, false);
  assert.deepEqual(standing.companions, { before: ["files"], after: ["tasks"] });
  assert.deepEqual(standing.row, []);
  const folded = placeSections(layout, all, room({ threadOpen: true }), null, true);
  assert.equal(folded.covers, true);
  assert.equal(folded.threadColumn, null);
  assert.deepEqual(folded.companions, { before: [], after: [] });
  assert.deepEqual(summary(folded).row, ["0:files+tasks"]);
  // No thread open: nothing to fold.
  assert.equal(placeSections(layout, open("tasks", "files"), room({}), null, true).covers, false);
});

test("the open Artifact doesn't keep the thread from folding (#189: no exception for it)", () => {
  const folded = placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, open("thread", "tasks", "files", "artifact"), room({ threadOpen: true }), false, true);
  assert.equal(folded.covers, true);
  assert.deepEqual(summary(folded).row, ["1:tasks+files", "2:artifact"]);
});

test("floating, the column is the panel above the composer and its 12px gap, and that is what must fit two sections", () => {
  assert.equal(sideCardsColumnHeight("beside", 400, 90), 400);
  assert.equal(sideCardsColumnHeight("float", 400, 90), 298);
  assert.equal(sideCardsOneAtATime("float", 298), true);
  assert.equal(sideCardsOneAtATime("float", 698), false);
  assert.equal(sideCardsOneAtATime("beside", 321), false);
  assert.equal(sideCardsOneAtATime("beside", 320), true);
  assert.equal(sideCardsOneAtATime("overlay", 800), true);
});

test("the section opened or picked last shows; ties go to Tasks", () => {
  assert.equal(activeSideCard([], { tasks: 1, files: 2 }), null);
  assert.equal(activeSideCard(["tasks", "files"], { tasks: 0, files: 0 }), "tasks");
  assert.equal(activeSideCard(["tasks", "files"], { tasks: 3, files: 5 }), "files");
  assert.equal(activeSideCard(["tasks"], { tasks: 0, files: 9 }), "tasks", "a closed section's focus does not count");
});

test("sections stacked with the thread stand in its column, above and below it, while it is open; otherwise in a column of their own", () => {
  const layout: ChannelSideLayout = { v: 1, columns: [{ sections: ["files", "thread", "tasks"], width: 400 }] };
  const inRow = placeSections(layout, open("thread", "tasks", "files"), room({ threadOpen: true }));
  assert.deepEqual(inRow.companions, { before: ["files"], after: ["tasks"] });
  assert.deepEqual(inRow.row, []);
  const noThread = placeSections(layout, open("tasks", "files"), room({}));
  assert.deepEqual(noThread.companions, { before: [], after: [] });
  assert.deepEqual(summary(noThread).row, ["0:files+tasks"]);
});

// ---- The workspace Artifact (F41) and the profile: sections of the layout like the others (#189 rule 7)

const minWidths = (p: ReturnType<typeof placeSections>) => p.row.map((c) => c.minWidth);

test("the Artifact and the profile stand in the layout's columns for them: their own by default, last; stacked where the person put them", () => {
  assert.deepEqual(summary(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, open("thread", "tasks", "artifact", "profile"), room({ threadOpen: true }))).row, ["1:tasks", "2:artifact", "3:profile"]);
  const stacked: ChannelSideLayout = { v: 1, columns: [{ sections: ["thread", "profile"], width: 400 }, { sections: ["artifact", "tasks", "files"], width: 360 }] };
  const placed = placeSections(stacked, open("thread", "tasks", "artifact", "profile"), room({ threadOpen: true }));
  assert.deepEqual(placed.companions, { before: [], after: ["profile"] });
  assert.deepEqual(summary(placed).row, ["1:artifact+tasks"]);
});

test("a column counts its sections' content minimums: the Artifact's 480, the profile's 320 (#189 rule 4)", () => {
  assert.deepEqual(minWidths(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, open("tasks", "artifact", "profile"), room({}))), [280, 480, 320]);
  const stacked: ChannelSideLayout = { v: 1, columns: [{ sections: ["artifact", "tasks"], width: 360 }] };
  assert.deepEqual(minWidths(placeSections(stacked, open("tasks", "artifact"), room({}))), [480]);
});

test("on a desktop the Artifact's Expand is the row's (rule 5): it is never expanded over the panel; on a phone it may be, where it floats", () => {
  const withArtifact = open("tasks", "artifact");
  assert.equal(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, withArtifact, room({}), true).artifactExpanded, false);
  assert.deepEqual(summary(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, withArtifact, room({}), true)).row, ["1:tasks", "2:artifact"]);
  const floating = placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, withArtifact, room({ room: null, panelWidth: 600 }), true);
  assert.equal(floating.artifactExpanded, true);
  assert.equal(floating.floating.join("+"), "tasks", "expanded, it isn't among the floating sections");
  assert.equal(placeSections(DEFAULT_CHANNEL_SIDE_LAYOUT, withArtifact, room({ viewportWidth: 390, room: 390, panelWidth: 390 }), true).artifactExpanded, false, "covering the panel already");
});

test("three sections stacked need 482px (160 each and the seams); shorter, one at a time", () => {
  assert.equal(sideCardsOneAtATime("beside", 482, 3), false);
  assert.equal(sideCardsOneAtATime("beside", 481, 3), true);
});
