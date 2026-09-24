import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// New-agent orientation topic (getting-started) + its behavior-matched aliases, plus the
// archetype recipe discovery whitelist. Aliases and the alias set are from meichen's
// owner-lane readout 2026-07-23; the acceptance requirement is that they resolve to the
// dedicated doc AND do not shadow the canonical topics they sit near.

test("getting-started topic is served (indexed + non-empty body)", async () => {
  const doc = await resolveAgentKnowledgeDoc("getting-started");
  assert.ok(doc, "getting-started must resolve");
  assert.equal(doc.docId, "getting-started");
  assert.ok(doc.content.trim().length > 0, "must serve a non-empty body");
});

test("getting-started body states the verified #all first-intro behavior (regression guard)", async () => {
  // The previous head shipped the OPPOSITE of the verified behavior yet passed every
  // resolver test. Lock the served body's behavior contract: it must describe the
  // feature-gated system-triggered one-time #all self-introduction, and must NOT carry
  // the old blanket prohibition against introducing in #all.
  const doc = await resolveAgentKnowledgeDoc("getting-started");
  assert.ok(doc);
  const body = doc.content;
  assert.match(body, /self-introduction in `#all`/, "must describe the #all self-introduction");
  assert.match(body, /feature-flagged/, "must note it is feature-flagged (opener-v2)");
  assert.match(body, /one or two sentences/, "must carry the verified 1-2 sentence shape");
  assert.doesNotMatch(
    body,
    /do not:?\s*post an introduction into `?#all`?/i,
    "must NOT carry the old backwards 'do not post into #all' claim",
  );
});

test("first-join exact miss query resolves (row 2026-07-21#381)", async () => {
  // The agent's literal `manual get` topic that was not_found on prior heads.
  const doc = await resolveAgentKnowledgeDoc("first boot OR greeting OR introduced OR welcome");
  assert.ok(doc, "the exact real-miss query must now resolve");
  assert.equal(doc.docId, "getting-started");
});

test("getting-started behavior-matched aliases resolve to it", async () => {
  // The 5 aliases wired for getting-started. `all-gree system greeting` is deliberately
  // NOT here (opener-loop recovery is still deferred), so it must NOT resolve to this doc.
  for (const alias of [
    "first boot greeting startup",
    "first boot greeting introduce welcome",
    "new agent greeting",
    "agent added welcome introduce",
    "onboarding new agent",
  ]) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "getting-started", `${alias} must land on getting-started`);
  }
});

test("`new agent greeting` no longer mis-routes to server-management", async () => {
  const doc = await resolveAgentKnowledgeDoc("new agent greeting");
  assert.ok(doc);
  assert.notEqual(doc.docId, "server-management");
  assert.equal(doc.docId, "getting-started");
});

test("deferred opener-loop alias is not routed to getting-started", async () => {
  // Until the all-gree/opener-loop recovery is documented, this must not resolve to
  // getting-started (which would mask an unresolved need as a hit).
  const doc = await resolveAgentKnowledgeDoc("all-gree system greeting");
  if (doc) assert.notEqual(doc.docId, "getting-started");
});

test("getting-started aliases do not shadow canonical negative-control topics", async () => {
  const canonical: Array<[string, string]> = [
    ["agent", "agent"],
    ["inbox", "inbox"],
    ["server", "server"],
    ["computer", "computer"],
    ["server-management", "server-management"],
    ["onboarding", "computer"], // `onboarding` is owned by computer (device setup)
    ["agent-create", "agent"], // human agent creation stays on agent
    ["creating agents", "agent"],
  ];
  for (const [alias, docId] of canonical) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must still resolve`);
    assert.equal(doc.docId, docId, `${alias} must stay on ${docId}, not be shadowed by getting-started`);
  }
});

test("archetype recipes resolve via the bare stripped-prefix alias", async () => {
  for (const slug of [
    "analyst",
    "designer",
    "operator",
    "pa-coordinator",
    "patrol",
    "verify-gate",
    "writer",
  ]) {
    const doc = await resolveAgentKnowledgeDoc(`archetype/${slug}`);
    assert.ok(doc, `archetype/${slug} must resolve`);
    assert.equal(doc.docId, `recipes/archetype/${slug}`);
    assert.ok(doc.content.trim().length > 0, `archetype/${slug} must serve a non-empty body`);
  }
});
