import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Raft Design System guard. The web runs on one visual family (RUI `raft`,
 * light and dark); the legacy Brutal and Elegant families are gone. These
 * checks keep the old vocabulary from creeping back in, where it would
 * silently render nothing (a dead `theme-brutal:` class) or the wrong look (a
 * hard shadow, a 2px black border, a white box in dark mode).
 */

const webRoot = resolve(import.meta.dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

const files = [...sourceFiles(resolve(webRoot, "src")), ...sourceFiles(resolve(webRoot, "visual-testing"))];

/** Strip comments so prose about the old themes does not count. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function offenders(pattern: RegExp, allow: (rel: string, match: string) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const file of files) {
    const rel = relative(webRoot, file);
    for (const match of code(file).matchAll(pattern)) {
      if (!allow(rel, match[0])) found.push(`${rel}: ${match[0]}`);
    }
  }
  return found;
}

// Crash and stale-build screens must render without the design system, so
// their literal styling is reviewed separately (scripts/check-color-tokens.ts).
const STANDALONE_FALLBACKS = new Set([
  "src/components/errors/AppUpdateGate.tsx",
  "src/components/errors/RootErrorFallback.tsx",
]);

test("no class is scoped to a theme family that no longer exists", () => {
  assert.deepEqual(offenders(/(?:^|[\s"'`{])(?:theme-brutal|theme-elegant):[^\s"'`}]+/g), []);
  assert.deepEqual(offenders(/in-data-\[theme=(?:brutal|elegant)\]/g), []);
});

test("components do not branch on a theme family", () => {
  assert.deepEqual(offenders(/\b(?:BrutalOnly|ElegantOnly|useThemeFamily)\b/g), []);
});

test("legacy brutal palette and geometry classes are gone", () => {
  // bg-palette-lavender stays: it is the DS human-avatar fallback colour.
  const brutalPalette = /(?<![\w-])!?(?:[a-z-]+:)*(?:bg|text|border|ring|outline|divide|fill|stroke|decoration)-(?:palette|brutal)-(?!lavender\b)[a-z]+(?:\/\d+)?(?![\w-])/g;
  const fixedInk = /(?<![\w-])!?(?:[a-z-]+:)*(?:bg-white|text-black|border-black|text-white)(?:\/\d+)?(?![\w-])/g;
  const hardShadows = /(?<![\w-])!?(?:[a-z-]+:)*shadow-brutal(?:-[a-z]+)?(?![\w-])/g;
  const allowFallbacks = (rel: string) => STANDALONE_FALLBACKS.has(rel);
  assert.deepEqual(offenders(brutalPalette, allowFallbacks), []);
  assert.deepEqual(offenders(fixedInk, allowFallbacks), []);
  assert.deepEqual(offenders(hardShadows, allowFallbacks), []);
});

test("legacy composition classes are gone; controls come from raft-ui", () => {
  const legacyClasses = /(?<![\w-])(?:btn-brutal(?:-sm)?|btn-flat-sm|card-brutal|input-brutal)(?![\w-])/g;
  assert.deepEqual(offenders(legacyClasses), []);
});

test("the shell names no theme family; only the mode varies", () => {
  // raft-ui has no family axis, so the app keeps no family constant to pass.
  assert.deepEqual(offenders(/\b(?:APP_THEME_FAMILY|FEEDBACK_THEME_FAMILY)\b/g), []);
  // The feedback SDK (hands-feedback-react >= 0.5) takes no style prop at all.
  assert.deepEqual(offenders(/\bFEEDBACK_SDK_THEME\b/g), []);
});
