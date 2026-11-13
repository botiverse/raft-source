import assert from "node:assert/strict";
import { test } from "vitest";
import { effectiveRaftTheme, isRaftThemeId, raftThemeDecorShown, raftThemeHasDecor } from "./raftThemes";

test("a member's theme: their choice, the default when none, and a Pro theme shows as Raft Yellow on Free", () => {
  assert.equal(effectiveRaftTheme(null, false), "raft");
  assert.equal(effectiveRaftTheme("space", true), "space");
  assert.equal(effectiveRaftTheme("boring", true), "raft");
  assert.equal(effectiveRaftTheme("boring", false), "boring");
  assert.equal(isRaftThemeId("spooky"), true);
  assert.equal(isRaftThemeId("neon"), false);
  assert.equal(isRaftThemeId(null), false);
});

test("decor shows only on a theme that has some, unless the member turned it off", () => {
  assert.equal(raftThemeHasDecor("raft"), false);
  assert.equal(raftThemeHasDecor("boring"), false);
  assert.equal(raftThemeHasDecor("space"), true);
  assert.equal(raftThemeDecorShown("space", true), true);
  assert.equal(raftThemeDecorShown("space", false), false);
  assert.equal(raftThemeDecorShown("raft", true), false);
});
