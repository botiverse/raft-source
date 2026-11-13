import assert from "node:assert/strict";
import { DEFAULT_CHANNEL_SIDE_LAYOUT, moveChannelSideSection } from "@botiverse/raft-shared";
import type { ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

import { columnMoves } from "../src/components/task/columnMovePlaces";

// #189 rule 7's keyboard path (the prototype's keyMoves): ⋯ > Move Left / Move Right. Out of a column it shares, a
// section goes into a new column of its own beside it; alone, its column swaps with its neighbour; only where that
// changes what shows.

const open = (...sections: ChannelSideSection[]) => new Set(sections);
const shape = (l: ChannelSideLayout, sections: ReadonlySet<ChannelSideSection>) => l.columns.map((c) => c.sections.filter((s) => sections.has(s)).join("+")).filter(Boolean).join(" | ");
const after = (l: ChannelSideLayout, section: ChannelSideSection, sections: ReadonlySet<ChannelSideSection>, side: "left" | "right") => {
  const drop = columnMoves(l, sections, section)[side];
  return drop ? shape(moveChannelSideSection(l, section, drop), sections) : null;
};

test("out of a column it shares: Move Left and Move Right each make it a column of its own on that side", () => {
  const shown = open("thread", "tasks", "files");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "files", shown, "left"), "thread | files | tasks");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "files", shown, "right"), "thread | tasks | files");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "tasks", shown, "left"), "thread | tasks | files");
});

test("alone in its column: it swaps with the column beside it; at the row's end there is no Move that way", () => {
  const shown = open("thread", "tasks", "files", "artifact", "profile");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "artifact", shown, "left"), "thread | artifact | tasks+files | profile");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "artifact", shown, "right"), "thread | tasks+files | profile | artifact");
  assert.equal(columnMoves(DEFAULT_CHANNEL_SIDE_LAYOUT, shown, "profile").right, null, "the last column");
  assert.equal(columnMoves(DEFAULT_CHANNEL_SIDE_LAYOUT, shown, "thread").left, null, "the first column");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "thread", shown, "right"), "tasks+files | thread | artifact | profile");
});

test("closed sections don't count: neighbours are the columns that show; a section not shown has no Move", () => {
  // The Artifact closed: the profile's left neighbour is Tasks and Files' column.
  const shown = open("thread", "tasks", "profile");
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "profile", shown, "left"), "thread | profile | tasks");
  assert.deepEqual(columnMoves(DEFAULT_CHANNEL_SIDE_LAYOUT, shown, "files"), { left: null, right: null });
  // Tasks alone on screen in a column it shares with closed Files: alone as far as what shows goes.
  assert.equal(after(DEFAULT_CHANNEL_SIDE_LAYOUT, "tasks", shown, "left"), "tasks | thread | profile");
});
