import { test } from "vitest";
import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

const DOC = "runtime";

// Why these assertions exist.
//
// Two Manual not-found records (R05 custom slash commands, R06 skill discovery)
// arrived with the proposed answer "Raft does not support this". Reading the
// source inverted both: Raft DOES discover Claude Code skills
// (shared SkillInfo -> GET /:id/skills -> AgentSkills panel) and a
// user-invocable skill renders as `/name`. What is actually missing is the
// AGENT-side entry point: there is no `raft skill` command family.
//
// So the risk this file guards is not omission, it is the page acquiring a
// confident false negative — telling an agent a capability does not exist
// because the agent cannot enumerate it. That is the same defect class fixed
// in integration.md: absence on one surface read as absence of the capability.
test("the runtime topic does not report skills as unsupported", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  assert.match(
    doc.content,
    /A missing query path is not a missing capability/,
    "must state the boundary in the non-inference direction",
  );
  assert.match(
    doc.content,
    /there is no `raft skill` command/,
    "must name the real gap: the agent-side entry point",
  );

  // Direction teeth: the false negatives this page must never acquire.
  assert.doesNotMatch(
    doc.content,
    /skills? (are|is) not supported/i,
    "must not claim skills are unsupported",
  );
  assert.doesNotMatch(
    doc.content,
    /(custom )?slash commands? (are|is) not supported/i,
    "must not claim custom slash commands are unsupported",
  );
  assert.doesNotMatch(
    doc.content,
    /Raft does not support skill discovery/i,
    "must not deny skill discovery — Raft performs it",
  );
});

test("the skills answer names the human surface that does have the list", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  const start = doc.content.indexOf("## Skills and slash commands");
  const next = doc.content.indexOf("\n## ", start + 1);
  assert.ok(start >= 0, "the skills section must exist");
  assert.ok(next > start, "a following section must bound it");
  const section = doc.content.slice(start, next);

  // Placement: an agent that cannot enumerate its own skills is only helped if
  // the redirect to the surface that CAN answer sits in the same section as
  // the refusal, not elsewhere on the page.
  assert.match(
    section,
    /agent detail panel/,
    "the redirect to the human surface must sit in the same section",
  );
  assert.match(
    section,
    /SKILL\.md/,
    "the section must name where skills come from",
  );

  // Direction tooth for the FALSE POSITIVE, added after Cindy caught it.
  // The /name badge in AgentSkills is a label carrying the runtime's own
  // naming convention; Raft's message input performs no slash dispatch, so
  // typing /name in a channel sends literal text. Reading the display surface
  // and inferring the invocation surface is the same cross-surface error this
  // page exists to prevent — inverted. A false negative costs an agent one
  // capability it had; a false positive makes it attempt something impossible
  // in front of the user, which is worse.
  assert.match(
    section,
    /That `\/name` is a label, not a trigger/,
    "must deny that the displayed /name is invocable from Raft",
  );
  assert.match(
    section,
    /Raft's message input does not dispatch slash commands/,
    "must state the input-box behaviour explicitly",
  );
  assert.doesNotMatch(
    section,
    /custom slash command written as a `SKILL\.md` does work/,
    "the retired false positive must not return",
  );
});
