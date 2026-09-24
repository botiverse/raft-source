import { test } from "vitest";
import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

const DOC = "task";

// Two Manual gaps (R26 unavailable assignee, R33 done vs closed). Before this
// change the page contradicted itself: the flow narrative named four statuses
// while the values list named five, and `closed` was never explained. An agent
// reading it could not tell what `closed` meant or how to leave it.
//
// The teeth below guard the two claims most likely to be quietly re-broken.
test("the task topic distinguishes done from closed and denies auto-transition", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  assert.match(doc.content, /`closed` is a terminal "won't do" state/,
    "must define closed as abandonment, not completion");
  assert.match(doc.content, /Nothing moves a task automatically/,
    "must deny automatic transitions — the R33 question was who or what triggers it");
  assert.match(doc.content, /reopen it before claiming/,
    "must carry the real rejection text for a closed task");
});

test("the reassignment boundary is stated as a request path, not a grant", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  const start = doc.content.indexOf("## When the assignee is unavailable");
  const next = doc.content.indexOf("\n## ", start + 1);
  assert.ok(start >= 0, "the section must exist");
  assert.ok(next > start, "a following section must bound it");
  const section = doc.content.slice(start, next);

  // DELIBERATE CHANGE (2026-08-03), not a weakened guard. This used to pin the
  // literal phrase "request path, not a grant to reassign". That phrasing
  // asserted a PERMISSION fact -- that moving a task yourself was not available
  // to you -- and @stdrc's ruling made it false: reassigning is member-level
  // now ("只有 delete 这种行为，是只能创建者和 admin 做").
  //
  // What the guard exists to protect is the CONDUCT boundary: a failed claim
  // does not mean take the task. That survives the ruling intact, so it is
  // still pinned here -- restated in terms that are true. Leaving the old
  // phrase would have made the page teach agents a restriction the server no
  // longer enforces.
  assert.match(section, /being able to reassign is not a reason to reassign/,
    "the conduct boundary must sit in this section, without asserting a false permission");
  assert.match(section, /does not tell you they have abandoned it/,
    "a claim conflict must not be read as the assignee giving up");
  assert.match(section, /blocks exactly one thing/,
    "must scope what a claim conflict actually blocks");

  // The source that defines these actions carries an explicit instruction to
  // rendering surfaces: present them as examples, NEVER as an exhaustive
  // permission table. This asserts the page obeys that instruction — the same
  // false-closed-set failure fixed in integration.md, pre-empted here by a
  // warning the source itself supplies.
  assert.match(section, /illustrative, not a permission table/,
    "must not present the unblocked actions as an exhaustive permission table");

  // And it must not re-teach the silence it exists to retire.
  assert.doesNotMatch(section, /move on to (a different|another) task/i,
    "must not tell a blocked agent to go quiet and move on");
});

// Cat's conditional-gate finding: the new section is worthless if the rest of
// the page still teaches the rule it retires. Two older lines (the claim-output
// bullet and the FAILED gotcha) said "do not work or reply — pick another",
// which is the silence rule stated twice more. A section that contradicts its
// own page does not change behaviour; the reader obeys whichever line they hit
// first. So this assertion is DOC-WIDE, not section-scoped.
test("no line anywhere on the page still teaches go-quiet-and-pick-another", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  assert.doesNotMatch(doc.content, /do not work or reply/i,
    "the retired instruction must not survive anywhere on the page");
  assert.doesNotMatch(doc.content, /pick another( task)?\./i,
    "nor its shorter restatement in the gotchas");

  // Both former sites must now route to the section that explains the real
  // boundary, so the reader lands on 'what a failed claim actually blocks'
  // rather than on a bare prohibition.
  const routes = doc.content.match(/#when-the-assignee-is-unavailable/g) ?? [];
  assert.ok(routes.length >= 2,
    `both former sites must link to the boundary section (found ${routes.length})`);
});
