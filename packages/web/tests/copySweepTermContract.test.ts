import assert from "node:assert/strict";
import test from "node:test";

import { displayText } from "../scripts/build-glossary-manifest.mjs";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// COPY SWEEP TERM CONTRACT — transcript→记录 / credential key→密钥.
//
// @AngLee ruled both on 2026-08-03 (routed by @Wug): `transcript`→记录 and
// credential-context `key`→密钥. The glossary-pass manifest guards
// server/daemon/agent/runtime, but these two routed rulings had no persistent
// tooth (@Wug CHANGES on #5946: reverting one value left the focused suites
// green). This pins the CLASS on the LIVE catalog — a frozen touched-id list
// would go stale exactly like every other hand-maintained table; scanning the
// catalog cannot.
//
// Scope notes:
//   * Placeholder argument NAMES are identifiers, never display text — the
//     shared displayText() (AST-based) drops them, so `{clientKey}` / `{apiKey}`
//     are ignored. A raw string scan would falsely flag them.
//   * `key` is scanned as a standalone word. Today every "key" in the zh
//     catalog is credential context; a future NON-credential sense (e.g. a
//     keyboard key) would trip this and the author must decide — that is the
//     contract doing its job, not a false positive.
//   * `transcript` is scanned verbatim; the three runtime-report occurrences
//     were converted to 记录.

const zh = zhMessages as Record<string, string>;

const TRANSCRIPT = /transcript/;
const KEY = /(?<![A-Za-z])[Kk]ey(?![A-Za-z])/;

test("no zh display text holds standalone 'transcript'", () => {
  const offenders = Object.entries(zh)
    .filter(([, v]) => TRANSCRIPT.test(displayText(v)))
    .map(([id]) => id);
  assert.deepEqual(offenders, []);
});

test("no zh display text holds standalone credential 'key' / 'API key'", () => {
  const offenders = Object.entries(zh)
    .filter(([, v]) => KEY.test(displayText(v)))
    .map(([id]) => id);
  assert.deepEqual(offenders, []);
});
