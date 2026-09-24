import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Manual telemetry surfaced recovery-seeking queries (`reply mention`,
// `mention pending resolve undelivered`) missing while canonical `mention`
// succeeded. Route these phrasings to the mention doc, which now documents the
// pending/undelivered-mention recovery commands.
test("mention recovery-seeking aliases resolve to the mention doc", async () => {
  const aliases = [
    "pending mention",
    "mention pending",
    "undelivered mention",
    "mention recovery",
    "resolve mention",
    "reply mention",
    // Prod telemetry (meichen 7/21) — these exact phrasings still missed
    // after #5044 shipped; added as explicit observed-phrasing aliases (no
    // broad token-set fuzzing, so word-order permutations are each explicit).
    "mention pending resolve undelivered",
    "undelivered mention pending resolve",
  ];
  for (const alias of aliases) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "mention");
  }
});

test("mention aliases do not shadow unrelated phrasings", async () => {
  // No broad fuzzy fallback: a same-shape phrase that is not an observed
  // mention query must stay not_found rather than collapsing to the doc.
  for (const miss of ["pending resolve inbox undelivered", "reply message resolve"]) {
    const doc = await resolveAgentKnowledgeDoc(miss);
    assert.equal(doc, null, `${miss} must not resolve to a doc`);
  }
});

test("mention doc serves the pending/undelivered recovery commands", async () => {
  const doc = await resolveAgentKnowledgeDoc("mention");
  assert.ok(doc, "mention must resolve");
  assert.match(doc.content, /raft mention pending/, "must document listing pending actions");
  assert.match(doc.content, /raft mention notify <resolution-id>/, "must document the delivery command");
});
