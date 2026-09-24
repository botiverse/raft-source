import assert from "node:assert/strict";
import { test } from "vitest";

import { normalizeRuntimeProfileReportSource } from "./agentOrchestrator.js";

// The daemon->server `agent:runtime_profile.source` is an untrusted wire value (no runtime schema
// on the WS parse). The ingest span must only ever record an allowlisted source or "unknown",
// never an arbitrary attacker/garbage string. See task #317 + Leiysky o11y review.

test("normalizeRuntimeProfileReportSource keeps the four known emit sources verbatim", () => {
  for (const s of ["connect", "session_init", "turn_end", "stop"]) {
    assert.equal(normalizeRuntimeProfileReportSource(s), s);
  }
});

test("normalizeRuntimeProfileReportSource collapses unknown / malformed / absent values to 'unknown'", () => {
  assert.equal(normalizeRuntimeProfileReportSource("bogus"), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource(""), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource(undefined), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource(null), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource(42), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource({ source: "connect" }), "unknown");
  // case-sensitive: only the exact lowercase tokens pass
  assert.equal(normalizeRuntimeProfileReportSource("CONNECT"), "unknown");
  assert.equal(normalizeRuntimeProfileReportSource("turn_end "), "unknown");
});
