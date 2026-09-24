import assert from "node:assert/strict";
import test from "node:test";

import { routeFamilyForPath } from "./transportTrace.js";

// Locks the attachment-comments classifier ordering (PR3 review finding):
// the comments-specific family must win over the generic attachment families
// in BOTH path shapes (pre-rewrite /api and post-rewrite /internal/agent-api).
test("routeFamilyForPath classifies attachment comments ahead of generic attachment families", () => {
  assert.equal(
    routeFamilyForPath("/internal/agent-api/attachments/00000000-0000-4000-8000-000000000001/comments"),
    "agent-api/attachments/comments",
  );
  assert.equal(
    routeFamilyForPath("/api/attachments/00000000-0000-4000-8000-000000000001/comments?limit=50"),
    "agent-api/attachments/comments",
  );
  // Generic families remain intact for non-comment paths.
  assert.equal(
    routeFamilyForPath("/internal/agent-api/attachments/00000000-0000-4000-8000-000000000001"),
    "agent-api/attachments",
  );
  assert.equal(
    routeFamilyForPath("/api/attachments/00000000-0000-4000-8000-000000000001"),
    "attachments/download",
  );
});

test("routeFamilyForPath classifies agent-api activity ingest", () => {
  assert.equal(routeFamilyForPath("/internal/agent-api/activity"), "agent-api/activity");
  assert.equal(routeFamilyForPath("/internal/agent-api/activity?batch=1"), "agent-api/activity");
});

test("routeFamilyForPath classifies direct attachment upload control-plane calls", () => {
  assert.equal(routeFamilyForPath("/internal/agent-api/attachment-upload-capabilities"), "attachments/upload");
  assert.equal(routeFamilyForPath("/internal/agent-api/attachment-upload-sessions"), "attachments/upload");
  assert.equal(
    routeFamilyForPath("/internal/agent-api/attachment-upload-sessions/00000000-0000-4000-8000-000000000001/complete"),
    "attachments/upload",
  );
});
