import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

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

test("global stylesheet gives enabled app controls the link-hand cursor", () => {
  // The cursor contract is enforced by two checks:
  //   1. Global CSS gives enabled button / role=button / pseudo-link app chrome
  //      the same link-hand affordance as the Website.
  //   2. The source-scan below catches redundant callsite cursor-pointer
  //      overrides; semantic default/wait/grab exceptions remain explicit.
  const css = readSource("src/index.css");
  assert.match(
    css,
    /button:not\(:disabled\),\s*\[role="button"\]:not\(\[aria-disabled="true"\]\),\s*a\[href="#"\]\s*\{\s*cursor:\s*pointer;\s*\}/,
  );
});

test("app chrome inherits the link-hand cursor without callsite overrides", () => {
  const offenders: string[] = [];
  const files = [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/pages"),
    ...sourceFilesUnder("src/utils"),
  ];

  for (const sourcePath of files) {
    const source = readSource(sourcePath);
    if (!source.includes("cursor-pointer")) continue;
    const matchingLines = source
      .split("\n")
      .filter((line) => line.includes("cursor-pointer"));
    if (matchingLines.length === 0) continue;
    offenders.push(`${sourcePath}: ${matchingLines.join(" | ")}`);
  }

  assert.deepEqual(offenders, []);
});
