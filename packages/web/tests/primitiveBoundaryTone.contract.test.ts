import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

/**
 * Reverse-grep contract: Button / Badge must take colors
 * through the `tone` prop, not via `className="bg-brutal-*"` or
 * `className="...uppercase tracking-*"`. The whole point of tightening
 * the primitive boundary (PR #1905 / #proj-theme:ac79cf20 stdrc
 * msg=6ce4d8bf) is that theme swaps shouldn't need to re-audit callsite
 * className soup.
 *
 * Allow-list any callsite that is a documented exception (the
 * thread-replies Badge button-render soft-fill hover pattern is not yet in
 * the tone API and is tracked as a followup).
 */

const repoRoot = resolve(import.meta.dirname, "..");

const ALLOWED = new Set<string>([
  // Soft-fill Badge render-button with hover state — currently not expressible
  // through `tone` alone (needs a `fill="soft"` axis). Tracked separately.
  "src/components/message/MessageItem.tsx",
]);

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

test("Button / Badge callsites use semantic props instead of bg-* className", () => {
  // Matches `<Button ... className="...bg-brutal-..."` and same for Badge.
  // Multi-line attribute lists are flattened by the source-scanner: we look
  // at the substring between the opening `<Tag` and the next `>` of that
  // element. To stay simple we rely on a regex with a permissive but
  // bounded body length.
  const offenders: { file: string; match: string }[] = [];
  const pattern = /<(Button|Badge)\b[^>]{0,400}className="[^"]*bg-brutal-/s;

  for (const sourcePath of [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/pages"),
  ]) {
    if (ALLOWED.has(sourcePath)) continue;
    const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
    const m = source.match(pattern);
    if (m) offenders.push({ file: sourcePath, match: m[0].slice(0, 100) });
  }

  assert.deepEqual(
    offenders,
    [],
    `Move color into the primitive's tone prop:\n${offenders.map((o) => `  - ${o.file}: ${o.match}`).join("\n")}`,
  );
});

test("Badge callsites do not redeclare uppercase/tracking via className", () => {
  // Brutal Badge owns uppercase + tracking-wide itself (stdrc msg=6db77368):
  // content is Title Case at the source, brutal theme's primitive does the
  // visual transform. Callsites that re-add `uppercase` / `tracking-*` are
  // either leaking theme intent or duplicating the contract.
  const offenders: { file: string; match: string }[] = [];
  const pattern = /<Badge\b[^>]{0,400}className="[^"]*(?:uppercase|tracking-)/s;

  for (const sourcePath of [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/pages"),
  ]) {
    if (ALLOWED.has(sourcePath)) continue;
    const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
    const m = source.match(pattern);
    if (m) offenders.push({ file: sourcePath, match: m[0].slice(0, 100) });
  }

  assert.deepEqual(
    offenders,
    [],
    `Brutal Badge owns uppercase + tracking-wide. Drop these from className:\n${offenders.map((o) => `  - ${o.file}: ${o.match}`).join("\n")}`,
  );
});
