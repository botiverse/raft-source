import assert from "node:assert/strict";
import test from "node:test";
import { extractRaftMentionHandles } from "../raftRefs.js";
import { TASK_92_ROWS, rowsViolatedBy } from "./criteria.js";
import {
  wrongExtractRaftMentionHandles,
  wrongReplaceOutsideMarkdownCode,
} from "./mergeOverlappingSpans.js";

// Gate for the task #92 acceptance criteria.
//
// These do not test product behaviour. They test that the criteria still
// REJECT a patch which does not fix the defect -- so that if a future revision
// weakens them enough to admit it, that shows up at the moment of revision
// rather than at the next incident.
//
// The gate reads the criteria table itself (./criteria.ts). An earlier version
// asserted the wrong patch's own behaviour and never referenced the criteria,
// which meant weakening a criterion left it silently green: it could not do the
// only job it existed for.

test("the criteria table is satisfied by the real implementation", () => {
  // If this fails, the table and the implementation have drifted apart and the
  // gate below is measuring against something stale.
  assert.deepEqual(rowsViolatedBy(extractRaftMentionHandles), []);
});

test("and the criteria still REJECT the merge-only patch", () => {
  // The wiring: the wrong patch is judged against the same rows. Weaken a row
  // enough to admit it and this list shrinks to empty -- red, at revision time.
  const violated = rowsViolatedBy(wrongExtractRaftMentionHandles);
  assert.notDeepEqual(
    violated,
    [],
    "the merge-only patch now satisfies every acceptance row -- either the criteria "
      + "were weakened, or this artifact drifted. Both need a human.",
  );
  // Named, so a change in WHICH rows catch it is also visible rather than
  // silently absorbed by a "not empty" check.
  assert.deepEqual(violated, [
    "fence -> inline",
    "prose -> fence -> inline",
    "fence -> prose -> inline",
    "inline -> fence -> inline",
  ]);
});

test("the merge-only patch passes the identity property anyway", () => {
  // Why a losslessness check cannot stand alone: it is satisfied by a patch
  // that still leaks. It may accompany an extraction assertion, never replace
  // one. Kept executable rather than as prose.
  const leaky = TASK_92_ROWS[0].source;
  assert.equal(wrongReplaceOutsideMarkdownCode(leaky, (chunk) => chunk), leaky);
});
