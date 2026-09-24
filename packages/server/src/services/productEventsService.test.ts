// Contract test for productEventsService.classifyExecuteError.
//
// Why this test exists:
//   `classifyExecuteError` is the only branching logic in the funnel
//   write-side helper, and `error_class` is the dimension @meichen will
//   group `action_card.execute_fail` by in the offline funnel SQL. A
//   regression that miscategorises errors will silently skew the failure
//   buckets meichen ships to the dashboard. This test pins the mapping
//   from {status, code} pairs to error_class buckets so the contract
//   doesn't drift.
//
// Per Leiysky/Dozy/meichen 2026-05-13 review: NO `error_message` in
// metadata. We replaced it with low-cardinality `error_code` (the
// ActionCardError `code`) and `http_status` (integer). These tests pin
// that contract too.
//
// Owners: schema/contract co-owned by @Dozy + @meichen — please update
// the test alongside any change to the bucket set.

import { test } from "vitest";
import assert from "node:assert/strict";
import { classifyExecuteError } from "./productEventsService.js";
import { ActionCardError } from "./actionCardsService.js";

test("classifyExecuteError: 400 / INVALID_PAYLOAD → validation + code/status, no message", () => {
  const meta = classifyExecuteError(new ActionCardError(400, "INVALID_PAYLOAD", "bad shape"));
  assert.equal(meta.error_class, "validation");
  assert.equal(meta.error_code, "INVALID_PAYLOAD");
  assert.equal(meta.http_status, 400);
  assert.equal((meta as { error_message?: string }).error_message, undefined);
});

test("classifyExecuteError: 400 / MALFORMED_ACTION → validation", () => {
  const meta = classifyExecuteError(new ActionCardError(400, "MALFORMED_ACTION", "no action"));
  assert.equal(meta.error_class, "validation");
  assert.equal(meta.error_code, "MALFORMED_ACTION");
  assert.equal(meta.http_status, 400);
});

test("classifyExecuteError: 403 / WRONG_SERVER → permission", () => {
  const meta = classifyExecuteError(new ActionCardError(403, "WRONG_SERVER", "wrong server"));
  assert.equal(meta.error_class, "permission");
  assert.equal(meta.error_code, "WRONG_SERVER");
  assert.equal(meta.http_status, 403);
});

test("classifyExecuteError: 403 / NOT_A_MEMBER → permission", () => {
  const meta = classifyExecuteError(new ActionCardError(403, "NOT_A_MEMBER", "not a member"));
  assert.equal(meta.error_class, "permission");
  assert.equal(meta.error_code, "NOT_A_MEMBER");
});

test("classifyExecuteError: 404 → not_found", () => {
  const meta = classifyExecuteError(new ActionCardError(404, "NOT_FOUND", "missing"));
  assert.equal(meta.error_class, "not_found");
  assert.equal(meta.error_code, "NOT_FOUND");
  assert.equal(meta.http_status, 404);
});

test("classifyExecuteError: 409 / STATE_MISMATCH → conflict", () => {
  const meta = classifyExecuteError(new ActionCardError(409, "STATE_MISMATCH", "stale state"));
  assert.equal(meta.error_class, "conflict");
  assert.equal(meta.error_code, "STATE_MISMATCH");
});

test("classifyExecuteError: 409 / DIALOG_REQUIRED → conflict", () => {
  // DIALOG_REQUIRED is a 409 from the inline-execute path for action types
  // that require a dialog. Funnel-wise it groups under conflict so it's
  // visible as "user clicked execute on a path that should've opened a
  // dialog" — useful signal if the FE ever wires the wrong path.
  const meta = classifyExecuteError(new ActionCardError(409, "DIALOG_REQUIRED", "dialog needed"));
  assert.equal(meta.error_class, "conflict");
  assert.equal(meta.error_code, "DIALOG_REQUIRED");
});

test("classifyExecuteError: arbitrary thrown Error → unknown, no code/status", () => {
  const meta = classifyExecuteError(new Error("DB exploded"));
  assert.equal(meta.error_class, "unknown");
  assert.equal(meta.error_code, undefined);
  assert.equal(meta.http_status, undefined);
  assert.equal((meta as { error_message?: string }).error_message, undefined);
});

test("classifyExecuteError: null/undefined → unknown without crashing", () => {
  // Defensive: the helper is on the catch path, must never re-throw.
  const a = classifyExecuteError(null);
  const b = classifyExecuteError(undefined);
  assert.equal(a.error_class, "unknown");
  assert.equal(b.error_class, "unknown");
});

test("classifyExecuteError: never includes raw error_message field", () => {
  // Boundary contract: product_events.metadata must never carry raw caught
  // text (Leiysky/Dozy/meichen 2026-05-13). This guards against a
  // regression that adds `error_message` back.
  const cases: unknown[] = [
    new ActionCardError(400, "INVALID_PAYLOAD", "user@example.com payload was bad"),
    new ActionCardError(500, "DB_DEAD", "ECONNREFUSED 127.0.0.1:5432"),
    new Error("stack trace leak"),
    null,
    undefined,
    { status: 418, code: "WEIRD" },
  ];
  for (const c of cases) {
    const meta = classifyExecuteError(c) as Record<string, unknown>;
    assert.equal(
      meta.error_message,
      undefined,
      "error_message must never be set in classifyExecuteError output",
    );
  }
});
