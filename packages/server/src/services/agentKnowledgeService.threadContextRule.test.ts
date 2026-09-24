import { test } from "vitest";
import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Mirrors the canonical rule ratified by Huaihuai in #proj-aiax:55ef322f and
// shipped to the daemon guide in PR #5638. The prompt surface (class ①, needs
// relaunch) and the Manual surface (class ③, next retrieval) must carry the
// SAME sentence — one semantic, two renderings. Divergence here is the exact
// defect this rule was written to stop.
//
// LEASE: when the delivery-side fix lands and passes both acceptance layers
// (server decision A/B + carrier/render + model-seen receipt), the prompt
// sentence, these Manual sentences, and the guide pin retire together after a
// re-test. Do not retire one surface alone.
const CANON_TRIGGER =
  /Unless you have already read this thread in this turn, run `raft message read --target "#channel:shortid"` before replying/;
const CANON_CAVEAT =
  /Any attached parent or recent replies may be truncated and do not represent the full thread/;

for (const doc of ["mention", "thread"]) {
  test(`[canonical-mirrored] ${doc} carries the thread-context rule verbatim`, async () => {
    const resolved = await resolveAgentKnowledgeDoc(doc);
    assert.ok(resolved, "the topic must resolve");

    assert.match(resolved.content, CANON_TRIGGER,
      "the trigger must stay the mechanically checkable one (read-this-turn), not a self-assessment");
    assert.match(resolved.content, CANON_CAVEAT,
      "the truncation caveat must travel with it — a partial attachment is not the thread");

    // Anti-regression, mirroring the guide pin: the rejected wording keyed the
    // rule on follow state, which excludes the high-frequency real gap
    // (already following via `replied`, never model-seen).
    assert.doesNotMatch(resolved.content, /not been following/i,
      "must not key the rule on follow state — follow is subscription, not knowledge");
    // And it must not promise a payload; delivery is conditional and may be
    // dropped before the runtime renders it.
    assert.doesNotMatch(resolved.content, /you will receive (the )?(thread )?(parent|context)/i,
      "must not promise attached context the agent may never receive");
  });

  test(`[placement] ${doc} carries the rule at the reply-action point`, async () => {
    const resolved = await resolveAgentKnowledgeDoc(doc);
    assert.ok(resolved, "the topic must resolve");

    const start = resolved.content.indexOf("## What agents do");
    const next = resolved.content.indexOf("\n## ", start + 1);
    assert.ok(start >= 0, "the agent-action section must exist");
    assert.ok(next > start, "a following section must bound it");
    const section = resolved.content.slice(start, next);

    // Placement outlives wording: a rule the agent cannot see at the moment it
    // decides to reply does not change behaviour, however correct it is
    // elsewhere on the page.
    assert.match(section, CANON_TRIGGER,
      "the rule must sit inside the agent-action section, not in conceptual background");
  });
}
