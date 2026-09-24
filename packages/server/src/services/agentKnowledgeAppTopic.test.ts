import assert from "node:assert/strict";
import { test } from "vitest";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// The `app` topic was reachable only under its bare id: it was missing from
// AGENT_KNOWLEDGE_SOURCE_PATHS, and it had no entry in the legacy group map. The
// two omissions are independent, and each one alone is enough to send an agent
// back to guessing paths, so they are asserted separately here — a single
// combined test would let one layer's regression hide behind the other's fix.
//
// Layer 1 (SOURCE_PATHS registration) carries the two documented forms.
// Layer 2 (LEGACY_AGENT_KNOWLEDGE_GROUP_BY_DOC_ID) carries only the
// section-qualified back-compat form.

test("layer 1: app resolves under both documented forms (SOURCE_PATHS registration)", async () => {
  for (const path of ["app", "agent-knowledge/app"]) {
    const doc = await resolveAgentKnowledgeDoc(path);
    assert.ok(doc, `expected ${path} to resolve`);
    assert.equal(doc.docId, "app", `expected ${path} to resolve to doc_id app`);
  }
});

test("layer 2: app resolves under the section-qualified form (legacy group alias)", async () => {
  // `app` was the only one of the seven coordination topics that did not accept
  // this shape. An agent that learned the pattern from any sibling topic hit a
  // wall on `app` alone, which is the discoverability trap this closes.
  const doc = await resolveAgentKnowledgeDoc("agent-knowledge/coordination/app");
  assert.ok(doc, "expected agent-knowledge/coordination/app to resolve");
  assert.equal(doc.docId, "app");
});

test("the app aliases are exact, not fuzzy matching", async () => {
  // Guards the fix against over-correcting: these must stay unresolved, or the
  // two entries above would be indistinguishable from a resolver that simply
  // started guessing.
  for (const path of ["agent-knowledge/nonsense/app", "definitely-not-a-topic", "agent-knowledge/app-nonexistent"]) {
    assert.equal(await resolveAgentKnowledgeDoc(path), null, `expected ${path} to stay unresolved`);
  }
});
