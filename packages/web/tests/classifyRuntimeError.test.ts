import assert from "node:assert/strict";
import test from "node:test";

import { classifyRuntimeError } from "../src/utils/classifyRuntimeError";

// Runtime-error sentinel teeth (@Wug 2026-08-04): only enumerable stable
// patterns classify; unknown text stays null so the caller falls back without
// mistranslating or swallowing.

test("known runtime error patterns classify to their kinds", () => {
  assert.equal(classifyRuntimeError("Claude Code is not logged in on this machine. Please log in locally."), "notLoggedIn");
  assert.equal(classifyRuntimeError("Codex CLI is not installed on this computer."), "notInstalled");
  assert.equal(classifyRuntimeError("Authentication failed. Check your credentials."), "authFailed");
  assert.equal(classifyRuntimeError("invalid API key"), "authFailed");
});

test("unknown runtime error text stays null (never mistranslated)", () => {
  assert.equal(classifyRuntimeError("The daemon lost its connection to the workspace broker."), null);
  assert.equal(classifyRuntimeError(""), null);
  // A near-miss must not over-match: "installed" alone is not "not installed".
  assert.equal(classifyRuntimeError("The runtime was installed but is not responding."), null);
});
