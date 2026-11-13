import assert from "node:assert/strict";
import { OFFICIAL_APPS_HINT, buildRaftCliGuideMarkdown, buildRaftCliOverviewMdx } from "./raftCliGuide";

test("official-apps hint carries no URL, points at raft integration list, and says the official mark is set by the platform", () => {
  assert.doesNotMatch(OFFICIAL_APPS_HINT, /https?:\/\/|www\./i);
  assert.match(OFFICIAL_APPS_HINT, /`raft integration list`/);
  assert.match(OFFICIAL_APPS_HINT, /set by the platform, never by the app/);
});

test("the hint appears exactly once in the system prompt guide and in the generated Manual overview", () => {
  for (const text of [buildRaftCliGuideMarkdown(), buildRaftCliOverviewMdx()]) {
    assert.equal(text.split(OFFICIAL_APPS_HINT).length - 1, 1);
  }
});
