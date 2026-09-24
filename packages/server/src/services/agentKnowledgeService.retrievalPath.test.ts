import assert from "node:assert/strict";
import { test } from "vitest";

import {
  resolveAgentKnowledgeDocWithDiscovery,
  searchAgentKnowledgeDocsWithResolution,
} from "./agentKnowledgeService.js";

test("get retrieval paths distinguish canonical ids, aliases, and token routes", async () => {
  const exact = await resolveAgentKnowledgeDocWithDiscovery("membership");
  assert.ok(exact);
  assert.equal(exact.doc.docId, "membership");
  assert.equal(exact.resolution, "exact_id");

  const alias = await resolveAgentKnowledgeDocWithDiscovery("invite human");
  assert.ok(alias);
  assert.equal(alias.doc.docId, "membership");
  assert.equal(alias.resolution, "alias");

  const routed = await resolveAgentKnowledgeDocWithDiscovery("bobcut skill");
  assert.ok(routed);
  assert.equal(routed.doc.docId, "runtime");
  assert.equal(routed.resolution, "token_route");
});

test("search retrieval paths distinguish lexical, expansion, typo, and mixed matches", async () => {
  const lexical = await searchAgentKnowledgeDocsWithResolution("reminder");
  assert.ok(lexical.results.length > 0);
  assert.equal(lexical.resolution, "lexical");

  const expansion = await searchAgentKnowledgeDocsWithResolution("tomorrow");
  assert.ok(expansion.results.length > 0);
  assert.equal(expansion.resolution, "concept_expansion");

  const typo = await searchAgentKnowledgeDocsWithResolution("chanel");
  assert.ok(typo.results.length > 0);
  assert.equal(typo.resolution, "typo_correction");

  const mixed = await searchAgentKnowledgeDocsWithResolution("channel remindr");
  assert.ok(mixed.results.length > 0);
  assert.equal(mixed.resolution, "mixed");
});

test("search misses keep retrieval path null", async () => {
  const miss = await searchAgentKnowledgeDocsWithResolution("zzzqqq xyzzyx");
  assert.deepEqual(miss.results, []);
  assert.equal(miss.resolution, null);
});
