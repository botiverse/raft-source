import assert from "node:assert/strict";
import { buildRaftCliOverviewMdx } from "./raftCliGuide";

for (const [name, read] of [
  ["raft-cli-overview builder", () => buildRaftCliOverviewMdx()],
] as const) {
  test(`[pagination-inline] ${name} names --channels and --offset`, () => {
    const text = read();
    assert.match(text, /`raft server info --channels`/,
      "the command that actually lists channels must be named");
    assert.match(text, /--offset/,
      "the way to get the remaining pages must be named, not left to --help");
  });
}
