import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

// react-intl renders rich-text chunks as an ARRAY, so a chunk function that
// returns an element without a `key` triggers React's
//   "Each child in a list should have a unique key prop".
//
// It is only a WARNING. Nothing fails, no assertion notices, and the UI looks
// correct — which is why this class landed three times before anyone caught it:
// twice in my own migrations (#5762, #5763, both found by @Wug in review) and
// once across six files of already-merged code (task #22).
//
// Per-component render tests cannot close this: each only covers the chunks in
// the states it happens to mount, and the console-error guard in
// inviteAcceptPage.i18n.behavior.test.tsx only covers that one file. A source
// scan covers every call site in the repo at once, including ones written
// tomorrow, so that is what this is — and it is named as a source guard rather
// than dressed up as a rendering test.

const SRC = resolve(import.meta.dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") || p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * A rich-text chunk function: `tagName: (chunks) => <element …>`.
 *
 * The optional type annotation matters — `(chunks: React.ReactNode)` is a real
 * variant in this codebase, and my first sweep for this class missed it, leaving
 * one site unkeyed. Anything that can appear between the parens has to be
 * allowed here or the guard silently under-reports.
 */
const CHUNK_FN = /([A-Za-z][A-Za-z0-9]*)\s*:\s*\([A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^)]*)?\)\s*=>\s*(<[A-Za-z][^>]*>)/g;

/**
 * react-markdown component maps look identical to chunk maps but are NOT
 * rendered as an array by react-intl — react-markdown keys its own children.
 * Excluded by PATH, narrowly, rather than by guessing from the tag name.
 */
const NOT_INTL_CHUNKS = [join("components", "markdown")];

test("every react-intl rich-text chunk returns a keyed element", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (NOT_INTL_CHUNKS.some((p) => rel.startsWith(p))) continue;

    const src = readFileSync(file, "utf8");
    // Only files that actually format messages can have intl chunks.
    if (!src.includes("formatMessage") && !src.includes("FormattedMessage")) continue;

    for (const m of src.matchAll(CHUNK_FN)) {
      if (m[2].includes("key=")) continue;
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${rel}:${line}  ${m[1]}: ${m[2].slice(0, 48)}`);
    }
  }

  assert.deepEqual(
    offenders, [],
    "rich-text chunks must return a keyed element, or React warns at render:\n" +
      offenders.join("\n"),
  );
});

test("the guard actually matches the shapes it claims to", () => {
  // A source-scanning guard that matches nothing passes forever. These fixtures
  // pin that the pattern still recognises each real shape — including the
  // ANNOTATED parameter, which is the variant my first sweep missed.
  const shouldMatch = [
    'b: (chunks) => <span className="font-bold">{chunks}</span>',
    "strong: (chunks) => <strong>{chunks}</strong>",
    'mono: (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>',
    "name: () => <strong>{x}</strong>".replace("()", "(c)"),
  ];
  for (const sample of shouldMatch) {
    assert.equal([...sample.matchAll(CHUNK_FN)].length, 1, `pattern missed: ${sample}`);
  }

  const keyed = 'b: (chunks) => <span key="b" className="font-bold">{chunks}</span>';
  const m = [...keyed.matchAll(CHUNK_FN)];
  assert.equal(m.length, 1, "keyed chunks should still be recognised as chunks");
  assert.ok(m[0][2].includes("key="), "…and be excluded by the key check, not by non-matching");
});
