// The right-hand sections' layout (task #165; #189 rule 7, the Artifact and
// the profile among them): what a saved value may be, how missing sections are
// placed, what shows, and where a dragged section lands.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  channelSideColumnMinWidth,
  channelSideSectionWidth,
  completeChannelSideLayout,
  DEFAULT_CHANNEL_SIDE_LAYOUT,
  moveChannelSideSection,
  parseChannelSideLayout,
  resizeChannelSideColumn,
  visibleChannelSideColumns,
  type ChannelSideLayout,
  type ChannelSideSection,
} from "./channelSideLayout";

const layout = (...columns: Array<[ChannelSideSection[], number?]>): ChannelSideLayout => ({
  v: 1,
  columns: columns.map(([sections, width = 360]) => ({ sections, width })),
});
// The channel details (added after these cases were written) are left out of a shape: their own test checks where they go.
const shape = (l: ChannelSideLayout) => l.columns
  .map((c) => c.sections.filter((s) => s !== "details").join("+"))
  .filter(Boolean)
  .join(" | ");
const fullShape = (l: ChannelSideLayout) => l.columns.map((c) => c.sections.join("+")).join(" | ");

test("a saved layout is v 1, one to four side columns (and the thread's own) of known sections, none twice, widths 160 to 4000; anything else is not one", () => {
  assert.deepEqual(parseChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT), DEFAULT_CHANNEL_SIDE_LAYOUT);
  assert.deepEqual(parseChannelSideLayout({ v: 1, columns: [{ sections: ["tasks"], width: 160 }] }), layout([["tasks"], 160]), "as narrow as 160 (#189, rule 2)");
  assert.deepEqual(parseChannelSideLayout({ v: 1, columns: [{ sections: ["tasks"], width: 300, extra: true }], also: 1 }), layout([["tasks"], 300]), "other keys dropped");
  const five = layout([["thread"]], [["tasks"]], [["files"]], [["artifact"]], [["profile"]]);
  assert.deepEqual(parseChannelSideLayout(five), five, "four side columns and the thread's own");
  assert.equal(parseChannelSideLayout(layout([["thread", "tasks"]], [["files"]], [["artifact"]], [["profile"]], [["thread"]])), null, "a section twice");
  for (const bad of [
    null, [], "x", { v: 2, columns: [{ sections: ["tasks"], width: 300 }] },
    { v: 1, columns: [] },
    { v: 1, columns: Array.from({ length: 5 }, () => ({ sections: ["tasks"], width: 300 })) },
    { v: 1, columns: [["thread"], ["tasks"], ["files"], ["artifact"], ["profile"], ["thread"]].map((sections) => ({ sections, width: 300 })) },
    { v: 1, columns: [{ sections: [], width: 300 }] },
    { v: 1, columns: [{ sections: ["board"], width: 300 }] },
    { v: 1, columns: [{ sections: ["tasks"], width: 300 }, { sections: ["tasks"], width: 300 }] },
    { v: 1, columns: [{ sections: ["tasks"], width: 159 }] },
    { v: 1, columns: [{ sections: ["tasks"], width: 4001 }] },
    { v: 1, columns: [{ sections: ["tasks"], width: 300.5 }] },
    { v: 1, columns: [{ sections: "tasks", width: 300 }] },
  ]) {
    assert.equal(parseChannelSideLayout(bad), null, JSON.stringify(bad));
  }
});

test("a section this build doesn't know (a newer client's) is dropped, not the whole layout; a column of only those goes too", () => {
  assert.deepEqual(
    parseChannelSideLayout({ v: 1, columns: [{ sections: ["profile", "futureSection"], width: 400 }] }),
    layout([["profile"], 400]),
  );
  assert.deepEqual(
    parseChannelSideLayout({ v: 1, columns: [{ sections: ["tasks"], width: 300 }, { sections: ["futureSection"], width: 360 }, { sections: ["artifact", 7], width: 480 }] }),
    layout([["tasks"], 300], [["artifact"], 480]),
  );
  assert.equal(parseChannelSideLayout({ v: 1, columns: [{ sections: ["futureSection"], width: 360 }] }), null, "nothing known left");
});

test("a layout saved with the retired execution record (\"record\") reads without it", () => {
  assert.deepEqual(
    parseChannelSideLayout({ v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["profile", "record", "context"], width: 400 }, { sections: ["record"], width: 360 }] }),
    layout([["thread"], 400], [["profile", "context"], 400]),
  );
});

test("completing places each missing section where the default would: thread first, Tasks or Files under the other, the Artifact and the profile in columns of their own last", () => {
  assert.equal(shape(completeChannelSideLayout(layout([["tasks"]]))), "thread | tasks+files | artifact | profile+context");
  assert.equal(shape(completeChannelSideLayout(layout([["thread", "files"]]))), "thread+files+tasks | artifact | profile+context", "Tasks under Files, wherever that is");
  assert.equal(shape(completeChannelSideLayout(layout([["files"]], [["thread"]]))), "files+tasks | thread | artifact | profile+context");
  assert.equal(shape(completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT)), "thread | tasks+files | artifact | profile+context");
  assert.deepEqual(completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT), DEFAULT_CHANNEL_SIDE_LAYOUT, "the default is complete");
  // A layout saved with Tasks and Files apart (before the Artifact and the profile were sections): four side columns
  // and the thread's own; one already at four side columns takes the others at the bottom of its last.
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["tasks"]], [["files"]]))), "thread | tasks | files | artifact | profile+context");
  assert.equal(shape(completeChannelSideLayout(layout([["thread", "tasks"]], [["files"]]))), "thread+tasks | files | artifact | profile+context");
  assert.equal(shape(completeChannelSideLayout(layout([["thread", "tasks"]], [["files"]], [["artifact"]]))), "thread+tasks | files | artifact | profile+context");
  assert.equal(shape(completeChannelSideLayout(layout([["thread", "tasks"]], [["files"]], [["profile"]], [["artifact"]]))), "thread+tasks | files | profile+context | artifact");
  assert.equal(completeChannelSideLayout(layout([["tasks"]])).columns[2].width, 480, "the Artifact's own column: its 480");
  assert.equal(completeChannelSideLayout(layout([["tasks"]])).columns[3].width, 400, "the profile's: 400");
  // The context view, added after the others: under the profile wherever it is, else a column of its own.
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["profile"]], [["tasks", "files"]], [["artifact"]]))), "thread | profile+context | tasks+files | artifact");
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["tasks", "files", "profile"]], [["artifact"]]))), "thread | tasks+files+profile+context | artifact");
});

test("a column's minimum is its widest section's: the thread's 360, the Artifact's 480, the profile's 320, else 280", () => {
  assert.equal(channelSideColumnMinWidth(["tasks", "files"]), 280);
  assert.equal(channelSideColumnMinWidth(["tasks", "thread"]), 360);
  assert.equal(channelSideColumnMinWidth(["artifact", "tasks"]), 480);
  assert.equal(channelSideColumnMinWidth(["profile"]), 320);
});

test("only columns with an open section show, with only those sections", () => {
  const l = layout([["thread"], 400], [["tasks", "files"], 360]);
  assert.deepEqual(visibleChannelSideColumns(l, new Set(["tasks"])).map((c) => [c.column, c.sections, c.minWidth]), [[1, ["tasks"], 280]]);
  assert.deepEqual(visibleChannelSideColumns(l, new Set(["thread", "files"])).map((c) => [c.column, c.sections]), [[0, ["thread"]], [1, ["files"]]]);
  assert.deepEqual(visibleChannelSideColumns(l, new Set()), []);
});

test("into a column: before a section or at the bottom; a column left empty goes, one left with closed sections stays", () => {
  const l = completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  assert.equal(shape(moveChannelSideSection(l, "files", { kind: "into", column: 1, before: "tasks" })), "thread | files+tasks | artifact | profile+context");
  assert.equal(shape(moveChannelSideSection(l, "tasks", { kind: "into", column: 0, before: null })), "thread+tasks | files | artifact | profile+context");
  assert.equal(shape(moveChannelSideSection(l, "thread", { kind: "into", column: 1, before: "files" })), "tasks+thread+files | artifact | profile+context", "the thread's own column, now empty, goes");
  assert.equal(shape(moveChannelSideSection(l, "profile", { kind: "into", column: 2, before: null })), "thread | tasks+files | artifact+profile+context", "the profile stacks under the Artifact, its context view with it");
  assert.equal(moveChannelSideSection(l, "profile", { kind: "into", column: 2, before: null }).columns[2].width, 480, "the column it joins keeps its width");
  assert.ok(moveChannelSideSection(l, "tasks", { kind: "into", column: 1, before: "files" }) === l, "where it already is: unchanged");
  assert.ok(moveChannelSideSection(l, "tasks", { kind: "into", column: 1, before: "tasks" }) === l);
  assert.ok(moveChannelSideSection(l, "tasks", { kind: "into", column: 7, before: null }) === l, "no such column");
});

test("a new column: at the edges; alone it keeps its column's width, out of a stack its own default; at most four side columns", () => {
  const l = completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  const split = moveChannelSideSection(l, "files", { kind: "newColumn", at: 2 });
  assert.equal(shape(split), "thread | tasks | files | artifact | profile+context", "four side columns and the thread's own");
  assert.equal(split.columns[2].width, 360, "out of a stack: Files' own default");
  assert.equal(shape(moveChannelSideSection(l, "tasks", { kind: "newColumn", at: 0 })), "tasks | thread | files | artifact | profile+context");
  assert.ok(moveChannelSideSection(l, "thread", { kind: "newColumn", at: 0 }) === l, "alone at its own left edge");
  assert.ok(moveChannelSideSection(l, "thread", { kind: "newColumn", at: 1 }) === l, "alone at its own right edge");
  assert.equal(shape(moveChannelSideSection(l, "thread", { kind: "newColumn", at: 2 })), "tasks+files | thread | artifact | profile+context", "a lone section moving: same count");
  // The profile (the context view stacked under the Artifact), moved left of Tasks' column, keeps its saved width.
  const wide = resizeChannelSideColumn(moveChannelSideSection(l, "context", { kind: "into", column: 2, before: null }), 3, 520);
  const moved = moveChannelSideSection(wide, "profile", { kind: "newColumn", at: 1 });
  assert.equal(shape(moved), "thread | profile | tasks+files | artifact+context");
  assert.equal(moved.columns[1].width, 520);
  // Four sections besides the thread: the cap of four side columns holds whatever moves (the thread's own column
  // aside), and stacking is always a place.
  assert.ok(moveChannelSideSection(split, "artifact", { kind: "into", column: 4, before: null }) !== split);
  const full = layout([["thread", "tasks"]], [["files"]], [["artifact"]], [["profile"]]);
  assert.equal(shape(moveChannelSideSection(full, "tasks", { kind: "newColumn", at: 4 })), "thread | files | artifact | profile | tasks");
  // The thread out of a stack into a column of its own doesn't count among them.
  const stacked = layout([["thread", "tasks"]], [["files"]], [["artifact"]], [["profile"]]);
  assert.equal(shape(moveChannelSideSection(stacked, "thread", { kind: "newColumn", at: 0 })), "thread | tasks | files | artifact | profile");
});

test("resizing rounds and keeps the width within the saved range", () => {
  const l = completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  assert.equal(resizeChannelSideColumn(l, 1, 410.6).columns[1].width, 411);
  assert.equal(resizeChannelSideColumn(l, 1, 10).columns[1].width, 160, "a column goes to 160 (#189); its sections clip");
  assert.ok(resizeChannelSideColumn(l, 1, 360) === l, "unchanged");
  assert.ok(resizeChannelSideColumn(l, 5, 400) === l);
});

test("the context view (View Context) follows the profile, and never holds a column alone (a closed one would count among the four)", () => {
  const l = completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  assert.equal(shape(l), "thread | tasks+files | artifact | profile+context");
  assert.equal(channelSideColumnMinWidth(["context"]), 320);
  // The profile into the Artifact's column, Files split out; the Artifact may still move out.
  const profileIn = moveChannelSideSection(l, "profile", { kind: "into", column: 2, before: null });
  assert.equal(shape(profileIn), "thread | tasks+files | artifact+profile+context");
  const filesOut = moveChannelSideSection(profileIn, "files", { kind: "newColumn", at: 2 });
  assert.equal(shape(filesOut), "thread | tasks | files | artifact+profile+context");
  const artifactOut = moveChannelSideSection(filesOut, "artifact", { kind: "newColumn", at: 4 });
  assert.notEqual(artifactOut, filesOut, "the Artifact moves to a column of its own: no hidden context column takes the fourth place");
  assert.equal(shape(artifactOut), "thread | tasks | files | profile+context | artifact");

  // Moving the profile carries the context view, into a stack or into a column of its own.
  assert.equal(shape(moveChannelSideSection(l, "profile", { kind: "into", column: 1, before: "files" })), "thread | tasks+profile+context+files | artifact");
  const own = moveChannelSideSection(profileIn, "profile", { kind: "newColumn", at: 1 });
  assert.equal(shape(own), "thread | profile+context | tasks+files | artifact");
  assert.equal(own.columns[1].width, channelSideSectionWidth("profile"), "out of a stack: the profile's own width");

  // Out of a stack shared with others, the context view goes with the profile rather than staying in that stack.
  const stacked = layout([["thread"]], [["tasks", "files", "profile", "context"]], [["artifact"]]);
  assert.equal(shape(moveChannelSideSection(stacked, "profile", { kind: "newColumn", at: 2 })), "thread | tasks+files | profile+context | artifact");
  // Moved by itself it stays where it is put; the profile then moves alone.
  const contextMoved = moveChannelSideSection(l, "context", { kind: "into", column: 1, before: null });
  assert.equal(shape(contextMoved), "thread | tasks+files+context | artifact | profile");
  assert.equal(shape(moveChannelSideSection(contextMoved, "profile", { kind: "into", column: 2, before: null })), "thread | tasks+files+context | artifact+profile");
  // Dropped into a column of its own, it goes back under the profile: nothing changes.
  assert.equal(moveChannelSideSection(l, "context", { kind: "newColumn", at: 4 }), l);
});

test("a stored layout with a column holding only the context view normalises to it under the profile", () => {
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["tasks", "files"]], [["profile"]], [["context"]], [["artifact"]]))), "thread | tasks+files | profile+context | artifact");
  assert.equal(shape(completeChannelSideLayout(layout([["context"]], [["thread"]], [["tasks", "files"], 360], [["artifact", "profile"]]))), "thread | tasks+files | artifact+profile+context");
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["context"]], [["tasks", "files"]], [["profile"]]))), "thread | tasks+files | profile+context | artifact");
  // A layout saved before the context view existed gets it under the profile.
  assert.equal(shape(completeChannelSideLayout(layout([["thread"]], [["tasks", "files"]], [["artifact"]], [["profile"]]))), "thread | tasks+files | artifact | profile+context");
});

test("the channel details follow the profile: under it by default, carried with it, never a column alone", () => {
  assert.equal(fullShape(DEFAULT_CHANNEL_SIDE_LAYOUT), "thread | tasks+files | artifact | profile+context+details");
  // A layout saved before the details existed gets them under the profile, after the context view.
  assert.equal(fullShape(completeChannelSideLayout(layout([["thread"]], [["tasks", "files"]], [["profile", "context"]], [["artifact"]]))), "thread | tasks+files | profile+context+details | artifact");
  const l = completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  // The profile carries them.
  assert.equal(fullShape(moveChannelSideSection(l, "profile", { kind: "into", column: 2, before: null })), "thread | tasks+files | artifact+profile+context+details");
  // Moved by themselves into a stack they stay there; dropped into a column of their own they go back under the profile.
  assert.equal(fullShape(moveChannelSideSection(l, "details", { kind: "into", column: 1, before: null })), "thread | tasks+files+details | artifact | profile+context");
  assert.equal(moveChannelSideSection(l, "details", { kind: "newColumn", at: 4 }), l);
  assert.equal(fullShape(completeChannelSideLayout(layout([["thread"]], [["details"]], [["tasks", "files"]], [["profile"]]))), "thread | tasks+files | profile+context+details | artifact");
  assert.equal(channelSideColumnMinWidth(["details"]), 320);
  // A reader that knows them keeps them where they were saved.
  assert.deepEqual(parseChannelSideLayout({ v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["profile", "details"], width: 400 }] }), layout([["thread"], 400], [["profile", "details"], 400]));
  // A section a reader doesn't know (as "details" is to an older one) is dropped and the rest of the layout kept.
  assert.deepEqual(parseChannelSideLayout({ v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["profile", "not-yet-a-section"], width: 400 }] }), layout([["thread"], 400], [["profile"], 400]));
});
