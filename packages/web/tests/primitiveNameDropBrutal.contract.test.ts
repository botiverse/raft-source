import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

// Reverse-grep contract: after #proj-theme:ac79cf20 (stdrc msg=876c1102),
// shared primitives that have a theme-poc equivalent drop the "Brutal"
// prefix so theme swaps don't read as palette-specific identifiers. This
// test catches regressions where someone re-introduces the old name.

const repoRoot = resolve(import.meta.dirname, "..");

const BANNED = [
  "BrutalBadge",
  "BrutalBadgeButton",
  "BrutalButton",
  "BrutalCheckbox",
  "BrutalSelect",
  "BrutalTextarea",
] as const;

function sourceFilesUnder(path: string): string[] {
  const root = resolve(repoRoot, path);
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const visit = (entry: string) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) visit(resolve(entry, child));
      return;
    }
    if (/\.(tsx?|jsx?)$/.test(entry)) results.push(relative(repoRoot, entry));
  };
  visit(root);
  return results.sort();
}

test("no callsite uses Brutal-prefixed primitive identifiers", () => {
  const pattern = new RegExp(`\\b(${BANNED.join("|")})\\b`);
  const offenders: { file: string; match: string }[] = [];

  for (const sourcePath of [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/pages"),
    ...sourceFilesUnder("tests"),
  ]) {
    // The contract test itself names the banned symbols intentionally.
    if (sourcePath === "tests/primitiveNameDropBrutal.contract.test.ts") continue;
    const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
    const m = source.match(pattern);
    if (m) offenders.push({ file: sourcePath, match: m[0] });
  }

  assert.deepEqual(offenders, [], `Use the de-Brutal-ed name instead: ${offenders.map((o) => `${o.file} (${o.match})`).join(", ")}`);
});
