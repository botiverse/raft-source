import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Gogo's 7/23 byte audit found this seeded card served a correctness bug for
// weeks: it told agents that workspace membership decides who may use a tool,
// i.e. membership implied authorization. The v2 rewrite fixes it. These
// assertions exist so that specific claim cannot come back.
test("the login-with-raft card separates identity from authorization", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/login-with-raft");
  assert.ok(doc, "the card must resolve");

  assert.match(
    doc.content,
    /Identity is not authorization/,
    "the card must state the identity/authorization split explicitly",
  );
  assert.match(
    doc.content,
    /Membership alone never grants access/,
    "the card must deny that membership grants access",
  );

  // The exact regression: permissions following membership.
  assert.doesNotMatch(
    doc.content,
    /permissions follow workspace membership/i,
    "membership must never be presented as the thing that grants access",
  );
  assert.doesNotMatch(
    doc.content,
    /who is in the workspace defines who can use/i,
    "membership must never be presented as the access decision",
  );
});

// The card previously taught a single "generic 404 for non-member" rule. That
// is true on the client-lookup surface and false on the bearer identity
// endpoints, which answer 401. Pin the per-surface framing so it does not
// collapse back into one code.
test("the login-with-raft card does not teach one global error code", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/login-with-raft");
  assert.ok(doc, "the card must resolve");

  assert.match(doc.content, /differs by surface/, "error-code guidance must be surface-scoped");
  assert.match(doc.content, /\b401\b/, "must name the identity-endpoint code");
  assert.match(doc.content, /\b404\b/, "must name the client-lookup code");
  assert.match(
    doc.content,
    /status code alone will not tell you which door failed/,
    "must warn that the code does not identify the failing layer",
  );
});

// A sentence that Raft's code cannot confirm must not carry a verification
// promise. Cloudflare Access sits in front of a deployment and Raft has no
// knowledge of it, so that line is a design statement, not a behavior claim.
test("the login-with-raft card carries no unresolved verification markers", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/login-with-raft");
  assert.ok(doc, "the card must resolve");

  assert.doesNotMatch(
    doc.content,
    /needs .*byte-verify/i,
    "a served card must not ship with an open byte-verify marker",
  );
  assert.doesNotMatch(
    doc.content,
    /DRAFT v2|For Maggie's gate/,
    "draft scaffolding must not reach the served card",
  );
  assert.match(
    doc.content,
    /not a Raft behavior claim/,
    "the layered-auth line must be marked as a design-layer statement",
  );
});

// The recipe used to expose only the human Settings path. Agents followed it
// literally, asked owners to register the App by hand, and then requested a
// secret handoff even though the dedicated registration card already keeps the
// secret out of chat. Keep the execution surfaces explicit and asymmetric.
test("the login-with-raft card routes agents through the registration card", async () => {
  const doc = await resolveAgentKnowledgeDoc("recipes/technique/login-with-raft");
  assert.ok(doc, "the card must resolve");

  assert.match(
    doc.content,
    /raft integration app prepare register --name <app-name> --redirect-url <exact-callback>/,
    "agents must receive the dedicated registration-card command",
  );
  assert.match(
    doc.content,
    /not a manual Settings handoff and not generic `raft action prepare`/,
    "the recipe must distinguish the Agent path from both manual Settings and generic cards",
  );
  assert.match(
    doc.content,
    /Settings → Connected Apps remains the direct UI path[\s\S]*human-operated alternative/,
    "Settings must remain available but be labeled as the human-operated alternative",
  );
  assert.match(
    doc.content,
    /owner-only transient notice[\s\S]*never ask a human to paste or DM the secret/,
    "the initial secret must stay on the owner-only transient path",
  );
});
