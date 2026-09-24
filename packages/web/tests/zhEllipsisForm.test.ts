import assert from "node:assert/strict";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Chinese ellipsis form. @AngLee ruled 2026-08-01 (#proj-i18n:ea47a2f4):
// standardise on a SINGLE `…` (U+2026).
//
// Their reasoning: `…` was already the overwhelming majority (98 vs 20 vs 7),
// modern Chinese UI micro-copy uses it (Apple/Google Chinese interfaces), and it
// corresponds naturally to English `...`. They also corrected the record —
// 赵梓淇's earlier "3× -> 2×" ruling was fixing a TRIPLE-ellipsis error, not
// establishing `……` as the house style.
//
// #5808 converged the 20 `……` and 6 ASCII `...`. This is the other half of task
// #36: without a guard, every future migration re-introduces whichever form the
// author happens to type, which is exactly how three forms accumulated. The
// normalisation alone would have decayed.

const zh = zhMessages as Record<string, string>;
const en = enMessages as Record<string, string>;

/**
 * The one deliberate exception.
 *
 * `Bearer ...` is a sample Authorization header value shown in a placeholder —
 * it illustrates a token format, not UI prose. Converting it to `Bearer …` would
 * misrepresent what the user is meant to type. Exempt by ID, never by pattern:
 * a pattern would silently re-admit real prose.
 */
const ASCII_DOTS_ALLOWED = new Set(["agent.mcp.bearerPlaceholder"]);

test("no Chinese string uses a double ellipsis", () => {
  const offenders = Object.entries(zh)
    .filter(([, v]) => v.includes("……"))
    .map(([k, v]) => `${k}: ${v}`);
  assert.deepEqual(
    offenders, [],
    "Chinese UI copy standardises on a single … (U+2026):\n" + offenders.join("\n"),
  );
});

test("no Chinese string uses ASCII dots as an ellipsis", () => {
  const offenders = Object.entries(zh)
    .filter(([k, v]) => v.includes("...") && !ASCII_DOTS_ALLOWED.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  assert.deepEqual(
    offenders, [],
    "Use … (U+2026), not three ASCII dots:\n" + offenders.join("\n")
      + "\n\nIf the dots are a sample VALUE rather than copy, add the id to "
      + "ASCII_DOTS_ALLOWED with a note saying why.",
  );
});

test("the exemption list has no stale entries", () => {
  // An exemption that no longer applies reads as "someone thought about this"
  // while protecting nothing. Same reasoning as the catalog ratchet's
  // stale-row rule.
  for (const id of ASCII_DOTS_ALLOWED) {
    assert.notEqual(zh[id], undefined, `${id} is exempt but no longer exists`);
    assert.ok(
      zh[id].includes("..."),
      `${id} no longer contains ASCII dots — remove it from ASCII_DOTS_ALLOWED`,
    );
  }
});

test("the guard is looking at a real corpus", () => {
  // A catalog that failed to load would make every filter above vacuous.
  assert.ok(Object.keys(zh).length > 2000, "zh catalog looks empty");
  const withEllipsis = Object.values(zh).filter((v) => v.includes("…"));
  assert.ok(
    withEllipsis.length > 50,
    `expected many … strings, found ${withEllipsis.length} — is the catalog loaded?`,
  );
});

test("English keeps its own convention", () => {
  // The ruling is about Chinese. English micro-copy uses ASCII "..." in this
  // codebase and is deliberately NOT swept — pinned so a future tidy-up does not
  // quietly extend a zh ruling across the en catalog.
  const enDots = Object.values(en).filter((v) => v.includes("..."));
  assert.ok(enDots.length > 0, "English still uses ASCII dots; the zh rule is zh-only");
});
