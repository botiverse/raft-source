import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildAgentKnowledgeNotFoundGuidanceWithCandidates,
  findKnowledgeMissCandidates,
  resolveAgentKnowledgeDoc,
  resolveAgentKnowledgeDocWithDiscovery,
} from "./agentKnowledgeService.js";

// Discovery-layer contract (Cindy-approved design, #proj-docs thread 843fddc1,
// 2026-09-01; supersedes the generic-skill no-shadow contract from PR #7151):
// get stays exact-first; a bounded token router serves whole ask classes with
// a single-semantic token; every other exact miss gets labeled inline
// candidates while remaining a not_found in both response and telemetry.

test("any skill name reaches runtime via the token router", async () => {
  // Names deliberately NOT in any alias set — deleting the token route makes
  // every case here red.
  for (const topic of ["bobcut skill", "skill", "skills", "what skills do I have"]) {
    const resolved = await resolveAgentKnowledgeDocWithDiscovery(topic);
    assert.ok(resolved, `${topic} must resolve via discovery`);
    assert.equal(resolved.doc.docId, "runtime", `${topic} must land on runtime`);
    assert.equal(resolved.resolution, "token_route", `${topic} must be marked token_route`);
  }
});

test("the token router requires a complete token, never a substring", async () => {
  for (const miss of ["skillful", "reskilling", "skillet recipes"]) {
    assert.equal(
      await resolveAgentKnowledgeDocWithDiscovery(miss),
      null,
      `${miss} must not route (no substring absorption)`,
    );
  }
});

test("exact aliases win over the token router", async () => {
  // "ponytail skill" is an exact alias (PR #7151) that also contains the
  // routed token — it must resolve as alias, not token_route, so alias
  // precision is never silently downgraded to a route.
  const resolved = await resolveAgentKnowledgeDocWithDiscovery("ponytail skill");
  assert.ok(resolved, "ponytail skill must resolve");
  assert.equal(resolved.resolution, "alias", "exact alias must take priority over the router");
  assert.equal(resolved.doc.docId, "runtime");
});

test("non-routed queries still miss at the discovery layer", async () => {
  assert.equal(await resolveAgentKnowledgeDocWithDiscovery("bobcat"), null);
});

test("the discovery resolver is a superset of exact resolution", async () => {
  const exact = await resolveAgentKnowledgeDoc("membership");
  const discovered = await resolveAgentKnowledgeDocWithDiscovery("membership");
  assert.ok(exact && discovered);
  assert.equal(discovered.resolution, "exact_id");
  assert.equal(discovered.doc.docId, exact.docId);
});

test("miss candidates surface BELOW-FLOOR matches with matched terms", async () => {
  // "bobcut skill" is the exact class this feature serves: of its two query
  // terms only "skill" matches anything, and the ranked-search relevance
  // floor requires 2/2 matched terms for a two-term query — so
  // searchAgentKnowledgeDocs returns nothing for it (verified), and only
  // floor-free candidate discovery can point at runtime. Re-applying
  // passesSearchRelevanceFloor inside findKnowledgeMissCandidates turns this
  // red (verified by mutation).
  const candidates = await findKnowledgeMissCandidates("bobcut skill");
  assert.ok(
    candidates.some((candidate) => candidate.slug === "runtime"),
    "runtime must appear among candidates for a below-floor skill ask",
  );
  assert.ok(candidates.length >= 1, "a term present in doc content must yield candidates");
  assert.ok(candidates.length <= 3, "candidates are capped at 3");
  for (const candidate of candidates) {
    assert.ok(candidate.slug.length > 0);
    assert.ok(candidate.title.length > 0);
    assert.ok(candidate.matchedTerms.length >= 1, "every candidate names what matched");
  }
});

test("junk queries yield no candidates rather than noise", async () => {
  assert.deepEqual(await findKnowledgeMissCandidates("zzzqqqxxyy"), []);
});

test("not_found guidance inlines candidates and keeps the search command", async () => {
  const guidance = await buildAgentKnowledgeNotFoundGuidanceWithCandidates("retention policy", true);
  assert.ok(guidance.candidates.length >= 1, "guidance must carry candidates for matchable terms");
  assert.match(guidance.suggestedNextAction, /Closest matches by content:/);
  // The pre-existing recovery paths survive the candidate block.
  assert.match(guidance.suggestedNextAction, /raft manual search /);
  assert.match(guidance.error, /Manual topic not found\./);
});

test("guidance without matchable terms omits the candidate block unchanged", async () => {
  const guidance = await buildAgentKnowledgeNotFoundGuidanceWithCandidates("zzzqqqxxyy", true);
  assert.deepEqual(guidance.candidates, []);
  assert.doesNotMatch(guidance.suggestedNextAction, /Closest matches by content:/);
  assert.match(guidance.suggestedNextAction, /raft manual search /);
});

test("the observed plural `reminders` resolves to the reminder page as an exact alias", async () => {
  // meichen's reason-request digest 2026-09-09: two natural misses, two Agents,
  // two servers, `topic_or_path` byte-identical and verbatim `reminders`.
  // Deleting the alias makes this red.
  const resolved = await resolveAgentKnowledgeDocWithDiscovery("reminders");
  assert.ok(resolved, "reminders must resolve");
  assert.equal(resolved.doc.docId, "reminder", "reminders must land on the reminder page");
  assert.equal(resolved.resolution, "alias", "reminders must resolve as an exact alias");
});

test("unobserved neighbors of `reminders` still miss, so telemetry keeps seeing them", async () => {
  // The alias table's own rule: alias the OBSERVED shape only. If any of these
  // start resolving, a neighbor has been silently absorbed and its demand would
  // stop appearing as a miss — the exact failure the skill/skills comment guards.
  for (const neighbor of ["reminding", "schedules", "scheduling"]) {
    assert.equal(
      await resolveAgentKnowledgeDocWithDiscovery(neighbor),
      null,
      `${neighbor} must remain a miss (unobserved neighbor)`,
    );
  }
});
