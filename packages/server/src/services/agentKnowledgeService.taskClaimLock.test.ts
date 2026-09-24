import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// A runtime DRI read "already assigned to @X", applied this card's
// "stop unless redirected" literally, and abandoned a lane he owned. The card
// treated assignment state as an ownership verdict and offered no third option
// between taking the work and leaving. These assertions pin the correction.
test("the task-claim-lock card separates the lock from lane ownership", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/task-claim-lock");
  assert.ok(doc, "the card must resolve");

  assert.match(
    doc.content,
    /A failed claim is a lock, not a ruling on who owns the lane/,
    "the lock/ownership distinction must be stated explicitly",
  );
  assert.match(
    doc.content,
    /going silent is not the conservative choice/,
    "the card must deny that silence is the safe default",
  );

  // The exact regression: the old text told an agent to stop, full stop.
  assert.doesNotMatch(
    doc.content,
    /Counter: stop unless redirected/,
    "the bare stop-unless-redirected counter must not come back",
  );
});

// Placement is load-bearing, not cosmetic. The seeded practice that would have
// prevented the incident sat ~15 lines from the compressed "stop" line and lost
// to it, because the compressed line was adjacent to the decision. So the
// distinction has to live in "The rule", not in a later background section.
test("the lock/ownership distinction sits at the decision point", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/task-claim-lock");
  assert.ok(doc, "the card must resolve");

  const ruleStart = doc.content.indexOf("### The rule");
  const stepsStart = doc.content.indexOf("### Steps");
  const distinction = doc.content.indexOf("not a ruling on who owns the lane");
  assert.ok(ruleStart >= 0, "the rule section must exist");
  assert.ok(stepsStart > ruleStart, "steps must follow the rule section");
  assert.ok(
    distinction > ruleStart && distinction < stepsStart,
    "the distinction must sit inside The rule — burying it later reproduces the failure this card documents",
  );
});

test("the card gives the canonical owner a corrective action", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/task-claim-lock");
  assert.ok(doc, "the card must resolve");

  for (const [phrase, why] of [
    ["correct the routing in the original thread", "names the action, not just the principle"],
    ["Treating metadata as ownership truth", "the inverse failure mode must exist"],
    ["Silent retreat", "silence must be named as a failure, not a neutral outcome"],
    ["Do not repeat QA", "correcting routing must not duplicate the assignee's finished work"],
  ] as const) {
    assert.ok(doc.content.includes(phrase), `card must ${why}: "${phrase}"`);
  }
});
