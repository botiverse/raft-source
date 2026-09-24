import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  AGENT_MIGRATION_USER_ERROR_CODES,
} from "./agentMigrationErrors.js";

test("owner-facing migration error codes are a unique non-empty closed set", () => {
  assert.ok(AGENT_MIGRATION_USER_ERROR_CODES.length > 0);
  assert.equal(
    new Set(AGENT_MIGRATION_USER_ERROR_CODES).size,
    AGENT_MIGRATION_USER_ERROR_CODES.length,
  );
  for (const code of AGENT_MIGRATION_USER_ERROR_CODES) {
    assert.match(code, /^[A-Za-z][A-Za-z0-9_]+$/);
  }
});

test("all terminal migration failures are owner-facing errors", () => {
  for (const code of AGENT_MIGRATION_TERMINAL_FAILURE_CODES) {
    assert.ok(AGENT_MIGRATION_USER_ERROR_CODES.includes(code));
  }
});
