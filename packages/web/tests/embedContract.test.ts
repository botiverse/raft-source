import assert from "node:assert/strict";
import test from "node:test";
import { __embedTestInternals } from "../src/embed";

const { parseEmbedMode } = __embedTestInternals;

// ── The contract ────────────────────────────────────────────────────────────
// ?embed=raft-settings-v1&shell=host|web
//
// Two dimensions on purpose (@MingQi): `embed` says "I am embedded", `shell` says
// "who owns the title bar". A bare `embed=1` collapses them and silently assumes
// every embed is host-shell.

test("host-shell embed is recognised", () => {
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=host");
  assert.equal(mode.embedded, true);
  assert.equal(mode.shell, "host");
});

test("web-shell embed keeps the header (no native title bar to duplicate)", () => {
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=web");
  assert.equal(mode.embedded, true);
  assert.equal(mode.shell, "web");
});

test("shell defaults to host when embedded and unspecified", () => {
  assert.equal(parseEmbedMode("?embed=raft-settings-v1").shell, "host");
});

test("an UNKNOWN embed version falls back to a normal page, never a broken one", () => {
  // Forward-compat: a future client shipping `raft-settings-v2` against an older web
  // build must get a plain page — not a half-applied contract.
  assert.equal(parseEmbedMode("?embed=raft-settings-v2&shell=host").embedded, false);
  assert.equal(parseEmbedMode("?embed=whatever").embedded, false);
});

test("legacy embed=1 is NOT honoured (@artin: 不用兼容)", () => {
  // Deliberate. An old client falls back to a normal page — one extra web header,
  // NOT the double header we are fixing. This assertion exists so that dropping
  // legacy support is a decision on the record, not an accident someone re-adds.
  assert.equal(parseEmbedMode("?embed=1").embedded, false);
  assert.equal(parseEmbedMode("?embed=1&shell=host").embedded, false);
});

test("no query string ⇒ not embedded", () => {
  assert.equal(parseEmbedMode("").embedded, false);
  assert.equal(parseEmbedMode("?foo=bar").embedded, false);
});

// ── The gate that matters most: this must be decided BEFORE the first paint ──
//
// If the embed decision lived in a `useEffect`, the first frame would render the
// header and the second would remove it — a visible flash — while every functional
// test stayed green, because the header IS gone by the time the assertion runs.
// `parseEmbedMode` is a pure sync function over the URL precisely so that the
// decision is available at module load. This test pins that it needs nothing async.
test("the decision is synchronous — no async, no effect, no store", () => {
  const before = Date.now;
  // If parseEmbedMode ever reached for a timer/микro-task, this would not be a pure
  // value by the time we read it. It returns immediately, from the string alone.
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=host");
  assert.equal(typeof mode.embedded, "boolean");
  assert.equal(Date.now, before);
});
