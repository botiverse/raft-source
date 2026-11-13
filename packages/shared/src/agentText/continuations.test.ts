import assert from "node:assert/strict";
import { formatContinuationRefusal, type ContinuationRefusalView } from "./continuations";

const CHECK = 'raft message read --target "#ops"';
const RERUN = 'raft message send --target "#ops"';
const PART_RAN = "Part of this command already ran and may have taken effect, so check before running anything again:";

test("once part of the command may have taken effect, every refusal that could send the agent to run it again gives the check line instead", () => {
  const id = "k7q2m3x9ab";
  const flagged = { id, mayHaveTakenEffect: true, rerun: RERUN, check: CHECK };
  const views: ContinuationRefusalView[] = [
    { code: "EXPIRED", createdAt: 0, expiresAt: 600_000, ...flagged },
    { code: "PROGRAM_CHANGED", ...flagged },
    { code: "FORMAT_CHANGED", ...flagged },
    { code: "UNKNOWN_COMMAND", ...flagged },
    { code: "REPLAY_DIVERGED", ...flagged },
  ];
  for (const view of views) {
    const text = formatContinuationRefusal(view);
    assert.ok(text.endsWith(` ${PART_RAN}\n  ${CHECK}`), `${view.code}: ${text}`);
    assert.ok(!text.includes(RERUN), `${view.code} offers no rerun: ${text}`);
  }
  // Nothing ran: the rerun line, and none of the wording above.
  const text = formatContinuationRefusal({ code: "PROGRAM_CHANGED", ...flagged, mayHaveTakenEffect: false });
  assert.ok(text.endsWith(`Run the original command again:\n  ${RERUN}`) && !text.includes("Part of this command"), text);
});
