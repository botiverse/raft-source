import assert from "node:assert/strict";

import { shownOwnActions } from "../src/components/layout/headFit";

// #189 rule 6 (#proj-raft-ui:#189, the prototype's headModel): a column's head always fits it. The title keeps 56px
// (it ellipsizes past that); the column's own actions fold into ⋯ where the rest doesn't fit, the last first; ⋯,
// Expand and Close never fold, and ⋯ is counted only where it has something in it.

const head = (width: number, own: number[], over: Partial<Parameters<typeof shownOwnActions>[0]> = {}) =>
  shownOwnActions({ width, lead: 0, own, controls: 2, menuItems: 0, ...over });

test("with room every own action is a button; a head not measured yet shows them all", () => {
  assert.equal(head(400, [32]), 1);
  assert.equal(head(0, [32, 32, 32]), 3);
});

test("Tasks at 160: New Task goes into ⋯; Expand and Close stay", () => {
  // 160 - 20 - 13 - 56 = 71 of room: New Task, Expand and Close need 32 * 3 + 8 = 104.
  assert.equal(head(160, [32]), 0);
  // At 205 (136 of room): New Task (32) and ⋯ is not needed: 32 * 3 + 8 = 104 fits.
  assert.equal(head(205, [32]), 1);
});

test("the last folds first, and ⋯ counts once something is in it", () => {
  // Three own actions, Expand and Close: 5 * 32 + 16 = 176. Folding one adds ⋯, still 5 buttons: a px short of 176
  // two fold, and the third at 140.
  assert.equal(head(265, [32, 32, 32]), 3);
  assert.equal(head(264, [32, 32, 32]), 1);
  assert.equal(head(229, [32, 32, 32]), 1);
  assert.equal(head(228, [32, 32, 32]), 0);
  // A menu with commands of its own (Move Left) is there anyway.
  assert.equal(head(265, [32, 32, 32], { menuItems: 1 }), 2);
});

test("Back or a fold chevron before the title, and tabs in its place, take their room", () => {
  assert.equal(head(205, [32], { lead: 1 }), 0);
  assert.equal(head(270, [32], { tabs: true }), 1);
  assert.equal(head(250, [32], { tabs: true }), 0);
});

test("#286: what the content needs beside the title (an Artifact's readers) takes its room too", () => {
  assert.equal(head(205, [32]), 1);
  assert.equal(head(205, [32], { content: 40 }), 0);
  assert.equal(head(245, [32], { content: 40 }), 1);
});
