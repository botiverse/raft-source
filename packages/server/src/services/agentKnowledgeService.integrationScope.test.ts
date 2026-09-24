import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Live staging regression (peng, #proj-aiax): Server-managed Notion MCP was
// correctly injected, but the agent ran `raft integration list`, read "Notion
// not listed" as "no Notion capability", and answered wrongly before
// recovering. The topic named that command twice as the discovery entry point,
// never mentioned MCP, and never stated where its coverage ends.
//
// The system prompt already carries this rule verbatim and it lost anyway, so
// these assertions pin PLACEMENT as well as presence: the boundary has to sit
// on the line an agent reads while deciding, not in a later section.

// ⚠️ WORDING-COUPLED (declared per the verification standard, 2026-07-28).
// The two placement assertions below anchor on STRUCTURE (offsets within the
// step / triage unit) and hold across rewrites. The presence assertions anchor
// on LITERAL PHRASES, because "the scope limit is present" has no executable
// property form today — placement has offsets, ordering has deepEqual, semantic
// presence has neither.
//
// Consequence for triage: if a legitimate rewrite of this copy turns these red,
// the correct reading is "THE TOOTH NEEDS RE-ANCHORING", not "the change is
// wrong". Re-anchor to the new wording and keep the property intact.
//
// This declaration exists because an honest wording anchor is safer than a
// plausible-looking fake property anchor.
//
// TWO retirement exits — either one ends this notice:
//   EARLY — this definition is reused across three surfaces (this topic, the
//     daemon prompt, the CLI receipt), which qualifies it to become a
//     STRUCTURED source: `covers` / `excludes` / `absence_means` as named
//     fields. Presence then = field non-empty, a genuine property anchor
//     needing no role judgement. Retires on that landing.
//   LATE — a three-role presence judge for arbitrary prose ({what it covers /
//     what it does not / what absence means}), tracked as an open problem in
//     the standard.
//
// The early exit answers PRESENCE only; whether the wording is correct stays
// with the human read gate.

const DOC = "integration";

test("[wording-coupled] the integration topic states the scope limit of `integration list`", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  assert.match(
    doc.content,
    /not an inventory of everything you can do/,
    "must deny that the list is a full capability inventory",
  );
  assert.match(
    doc.content,
    /It is not evidence that the provider, the data, or the capability is unavailable to you/,
    "must state that absence from the list is not absence of capability",
  );

  // Open-set teeth (behaviour-contract verdict, task #118). The defect these
  // guard against is a FALSE CLOSED SET: an exhaustive-sounding enumeration of
  // capability surfaces leaves a reader who meets an unlisted surface with
  // nowhere to put it except "does not exist" — re-enabling, one level up, the
  // very extrapolation the sentence above forbids. Completing the enumeration
  // is not a fix; the set has to stay explicitly open.
  assert.match(
    doc.content,
    /Others include, but are not limited to,/,
    "the surface set must be explicitly open, not a completed enumeration",
  );
  assert.match(
    doc.content,
    /neither enumerates the full set of surfaces nor ranks them against one another/,
    "must refuse both exhaustiveness and any ordering between surfaces",
  );
  assert.doesNotMatch(
    doc.content,
    /two independent channels/,
    "the closed two-channel framing must not return",
  );
  assert.doesNotMatch(
    doc.content,
    /a separate channel from Raft-managed integrations/,
    "the triage answer must not reintroduce the closed framing either",
  );
  assert.doesNotMatch(
    doc.content,
    /each with its own inventory/,
    "must not assert that every other surface has an enumerable inventory",
  );
  assert.match(
    doc.content,
    /Server-managed MCP/,
    "must name the runtime-side surface the list does not cover",
  );
});

test("the scope limit sits ON the list surface, not in a later section", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  // Locate the table row that introduces the command, and require the
  // boundary to live inside that same row — the unit an agent reads at the
  // moment it decides whether a capability exists.
  const stepStart = doc.content.indexOf("| `raft integration list` |");
  const nextStep = doc.content.indexOf("| `raft integration marketplace [query]` |");
  assert.ok(stepStart >= 0, "the list surface must exist");
  assert.ok(nextStep > stepStart, "the Marketplace discovery surface must follow it");

  const step = doc.content.slice(stepStart, nextStep);
  assert.match(
    step,
    /not an inventory of everything you can do/,
    "the scope limit must be inside the list row; a correct sentence in a later section is what already failed in the system prompt",
  );
  assert.match(step, /Server-managed MCP/, "the excluded surface must be named in that same step");
});

test("[wording-coupled] the triage answer carries the same boundary", async () => {
  const doc = await resolveAgentKnowledgeDoc(DOC);
  assert.ok(doc, "the topic must resolve");

  // The "when a user asks" block is the other place the decision gets made.
  const askStart = doc.content.indexOf("## When a user asks");
  const nextHeading = doc.content.indexOf("## What humans do");
  assert.ok(askStart >= 0 && nextHeading > askStart, "the triage block must exist");

  const block = doc.content.slice(askStart, nextHeading);
  assert.match(
    block,
    /absence there is not evidence the capability is unavailable/,
    "the triage block must not send an agent to `integration list` without its limit",
  );
});
