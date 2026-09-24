import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc, buildAgentKnowledgeNotFoundGuidance } from "./agentKnowledgeService.js";

test("inbox variant aliases resolve to the inbox doc", async () => {
  for (const alias of ["inbox notice", "agent-inbox"]) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "inbox");
  }
});

test("recipe stripped-prefix general fallback resolves whitelisted-class recipes", async () => {
  // Agents drop the `recipes/` prefix across multiple classes (decision/*, technique/*, ...).
  // The class-whitelist resolves the bare `<class>/<slug>` form for every real recipe whose
  // class is whitelisted — including decision/lane-design, which the earlier per-recipe
  // allowlist deliberately missed.
  const cases: Array<[string, string]> = [
    ["decision/when-to-ask-human", "recipes/decision/when-to-ask-human"],
    ["decision/one-or-many", "recipes/decision/one-or-many"],
    ["decision/lane-design", "recipes/decision/lane-design"],
    ["technique/task-claim-lock", "recipes/technique/task-claim-lock"],
    ["pattern/gate-chain", "recipes/pattern/gate-chain"],
    ["playbook/content-pipeline", "recipes/playbook/content-pipeline"],
  ];
  for (const [alias, docId] of cases) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, docId);
  }
});

test("stripped-prefix fallback is shadow-safe: only real recipes get the bare alias", async () => {
  // The bare `<class>/<slug>` alias exists ONLY for recipe files that actually exist, so a
  // whitelisted-class shape with no backing recipe still misses. This is a precomputed alias
  // bound to real files — NOT a runtime on-miss retry that could shadow arbitrary strings.
  for (const miss of [
    "decision/definitely-not-a-real-recipe",
    "technique/no-such-technique-xyz",
    "made-up-class/whatever", // non-whitelisted class shape
  ]) {
    assert.equal(await resolveAgentKnowledgeDoc(miss), null, `${miss} must not resolve (no shadow)`);
  }

  // Canonical direct recipe path is unchanged by the fallback.
  const direct = await resolveAgentKnowledgeDoc("recipes/decision/when-to-ask-human");
  assert.ok(direct, "canonical recipes/ path must still resolve");
  assert.equal(direct.docId, "recipes/decision/when-to-ask-human");

  // Non-recipe canonical topics (single-segment, not `<class>/<slug>`) are unaffected.
  const topic = await resolveAgentKnowledgeDoc("mention");
  assert.ok(topic, "non-recipe topic must still resolve, unshadowed");
  assert.equal(topic.docId, "mention");
});

// Completeness guard for the exact class of bug that apm-architecture-inventory was
// (that doc has since been deleted; this guard is doc-agnostic and outlives it): every topic advertised in the
// agent-knowledge index must resolve to served content. Reads the index via the resolver
// itself (no filesystem path assumptions).
test("every topic listed in the agent-knowledge index is served", async () => {
  const index = await resolveAgentKnowledgeDoc("index");
  assert.ok(index, "index must resolve");
  // Topic-list entries are `- \`slug\` — description`. Restrict to slug-shaped backticks
  // followed by the ` — ` separator so the "How to use" command examples and the
  // slock/knowledge-get compatibility note aren't mistaken for topics.
  const topics = [...index.content.matchAll(/^- `([a-z][\w./-]*)` — /gm)].map((m) => m[1]);
  assert.ok(topics.length > 10, "sanity: parsed a plausible number of index topics");
  const unserved: string[] = [];
  for (const topic of topics) {
    const doc = await resolveAgentKnowledgeDoc(topic);
    if (!doc) unserved.push(topic);
  }
  assert.deepEqual(unserved, [], `index topics missing from the served registry: ${unserved.join(", ")}`);
});

test("get not_found guidance offers an executable, cross-shell-safe search command", () => {
  // Cindy 7/20: a get miss should suggest `search` (discovery), not only browse-index.
  const capable = buildAgentKnowledgeNotFoundGuidance("technique/task-claim-lock", true);
  assert.match(capable.suggestedNextAction, /raft manual search "technique task claim lock"/);
  assert.match(capable.suggestedNextAction, /--intent "[^"]+" --reason "[^"]+"/);
  // cross-shell-safe: single valid argument in both POSIX and PowerShell (no ' $ ` ;).
  assert.doesNotMatch(capable.suggestedNextAction, /['$`;]/);

  // legacy form: bare search, no --intent/--reason (published old CLIs reject unknown flags).
  const legacy = buildAgentKnowledgeNotFoundGuidance("technique/task-claim-lock", false);
  assert.match(legacy.suggestedNextAction, /raft manual search "technique task claim lock"/);
  assert.doesNotMatch(legacy.suggestedNextAction, /--intent|--reason/);
});

test("human-invite observed miss shapes resolve to the membership doc", async () => {
  // The six exact observed `topic_or_path` shapes from meichen's reason-request digest
  // 2026-08-29 (task #126, one agent's guessing loop) — the alias set is exactly this
  // telemetry set, no expansion. Delete the `membership` entry in
  // EXTRA_AGENT_KNOWLEDGE_ALIASES_BY_DOC_ID and every case here goes red.
  for (const alias of [
    "invite",
    "invite link",
    "invite human",
    "add member",
    "member invite",
    "human invite",
  ]) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "membership", `${alias} must land on membership, not ${doc.docId}`);
  }
});

test("invite aliases do not shadow near-miss shapes outside the telemetry set", async () => {
  // Conservative contract: only the observed shapes resolve; nearby guesses that were NOT
  // observed still miss (they stay visible in future telemetry instead of being absorbed).
  for (const miss of ["invitations", "invite-flow", "server invite link email"]) {
    assert.equal(await resolveAgentKnowledgeDoc(miss), null, `${miss} must not resolve (no shadow)`);
  }
});

test("observed skill-name miss shapes resolve to the runtime doc", async () => {
  // The exact observed `topic_or_path` shapes from meichen's reason-request digest
  // 2026-08-31 — the alias set is exactly this telemetry set, no expansion. Delete the two
  // entries from the `runtime` alias list and every case here goes red.
  for (const alias of ["ponytail", "ponytail skill"]) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "runtime", `${alias} must land on runtime, not ${doc.docId}`);
  }
});

test("generic skill vocabulary stays off the EXACT alias layer", async () => {
  // SUPERSEDED CONTRACT NOTE (2026-09-01, #proj-docs thread 843fddc1): generic
  // skill vocabulary now RESOLVES at the discovery layer via the bounded token
  // router (see agentKnowledgeService.discovery.test.ts). This test pins the
  // remaining half of the old contract: none of these are EXACT aliases, so
  // the router — with its own telemetry marker — is the only path that serves
  // them, and exact-alias conservatism is preserved.
  for (const miss of ["skill", "skills", "skill discovery", "bobcut skill"]) {
    assert.equal(await resolveAgentKnowledgeDoc(miss), null, `${miss} must not be an exact alias`);
  }
});
