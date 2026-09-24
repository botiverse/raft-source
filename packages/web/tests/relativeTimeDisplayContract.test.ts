import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// RELATIVE-TIME DISPLAY CONTRACT — ONE visible formatter (task #61).
//
// 盘古之白 (2026-08-03): react-intl's `formatRelativeTime` renders zh with the
// digit pressed against the unit ("3小时前"). The shared formatter in
// src/utils/relativeTime.ts applies the spacing pass to BOTH entry points
// (the isoString helper `formatRelativeTime` and the react-intl-signature
// `formatRelativeTimeParts`).
//
// These four components previously called react-intl's formatRelativeTime
// DIRECTLY, silently skipping the spacing (@Wug CHANGES on #5928). This test
// pins each consumer to its shared entry point AND to the exact callsite shape
// it renders with — a file that goes back to `intl.formatRelativeTime(...)`,
// destructures formatRelativeTime from `useIntl()`, or changes how it feeds the
// shared formatter goes RED. A direct call is indistinguishable-by-render from
// the shared path until you look at the rendered zh digits, so the pin is
// source-level, at the seam where the split can re-form.

const CONSUMERS: {
  rel: string;
  entry: string; // the shared entry point the file must use
  shape: RegExp; // the exact callsite shape(s) it must render with
  min: number;
}[] = [
  {
    rel: "src/components/thread/ThreadsInbox.tsx",
    entry: "formatRelativeTime",
    shape: /formatRelativeTime\(item\.(?:lastActivityAt|createdAt|lastMessageAt), locale\)/g,
    min: 3,
  },
  {
    rel: "src/components/agent/AgentDMConversationList.tsx",
    entry: "formatRelativeTimeParts",
    shape: /formatRelativeTimeParts\(parts\.value, parts\.unit, locale\)/g,
    min: 1,
  },
  {
    rel: "src/components/agent/AgentRemindersSection.tsx",
    entry: "formatRelativeTimeParts",
    shape: /formatRelativeTimeParts\(parts\.value, parts\.unit, locale\)/g,
    min: 1,
  },
  {
    rel: "src/components/search/MessageSearchPage.tsx",
    entry: "formatRelativeTimeParts",
    shape: /formatRelativeTimeParts\(parts\.value, parts\.unit, intl\.locale\)/g,
    min: 2,
  },
];

/** Comments stripped — a negative guard must not match prose describing the rule. */
function codeOf(relPath: string): string {
  const src = readFileSync(resolve(import.meta.dirname, "../", relPath), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

for (const { rel, entry, shape, min } of CONSUMERS) {
  test(`${rel} renders relative time only through the shared ${entry} formatter`, () => {
    const code = codeOf(rel);
    assert.match(code, new RegExp(entry), `must use the shared entry point ${entry}`);
    assert.equal(
      (code.match(shape) ?? []).length >= min ? true : false,
      true,
      `expected ${min} callsite(s) matching ${shape} — the render glue must not drift`,
    );
    assert.doesNotMatch(
      code,
      /intl\.formatRelativeTime/,
      "direct react-intl call would skip the 盘古之白 spacing",
    );
    assert.doesNotMatch(
      code,
      /\{[^}]*formatRelativeTime[^}]*\} = useIntl\(\)/,
      "destructuring react-intl's formatRelativeTime bypasses the spacing",
    );
  });
}

test("the shared formatter itself is where the zh spacing pass lives", () => {
  const code = codeOf("src/utils/relativeTime.ts");
  assert.match(code, /zhMixedScriptSpacing/);
  assert.match(code, /formatRelativeTimeParts/);
});
