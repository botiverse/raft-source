import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// Teeth for the message-send idempotency and reconciliation contract.
// Generic retry promises remain forbidden: only the CLI's persisted same-key
// replay is deduplicated, while a new ordinary send receives a new identity.

test("the message doc does not promise that arbitrary send retries are deduplicated", async () => {
  const doc = await resolveAgentKnowledgeDoc("message");
  assert.ok(doc, "message topic must resolve");

  // Each pattern is a way of restoring the old false guarantee.
  const forbidden: Array<[RegExp, string]> = [
    [/idempotent send retries/i, "the exact retired sentence"],
    [/retries (are|is) (safe|idempotent)/i, "a restated safety guarantee"],
    [/daemon 0\.48\.1/i, "the version pin that implied the guarantee"],
  ];
  for (const [pattern, why] of forbidden) {
    assert.doesNotMatch(doc.content, pattern, `message doc must not carry ${why}`);
  }
});

test("the message doc keeps the UNKNOWN / no-blind-resend guidance", async () => {
  const doc = await resolveAgentKnowledgeDoc("message");
  assert.ok(doc);
  assert.match(doc.content, /UNKNOWN/, "the unresolved state must be named");
  assert.match(
    doc.content,
    /does not prove the message was not committed/i,
    "the readback limitation is the load-bearing half — a readback is evidence, not proof",
  );
  assert.match(doc.content, /stable idempotency key/i, "the current send identity must be documented");
  assert.match(doc.content, /limited `committed` result/i, "reconciliation must not imply a full receipt");
  assert.match(doc.content, /new ordinary send.*new (logical operation|identity|key)/i, "blind resend must remain distinct");
  assert.match(
    doc.content,
    /same-key replay then loses its response.*--expected-draft-key/i,
    "a replay ambiguity must bind its retry command to the expected saved-draft identity",
  );
  assert.match(doc.content, /verifies that identity again before making any request/i);
  assert.match(doc.content, /plain target-only `--send-draft`.*does not carry that guarantee/i);
});
