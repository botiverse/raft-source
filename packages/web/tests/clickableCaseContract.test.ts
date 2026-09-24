import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// #proj-uiux:8c0c5558 task #313/#315 doctrine reversal (stdrc msg=1ac4c2d6 +
// msg=18c70a63 + msg=08de25d5, 2026-05-26): clickable labels MUST be Title Case
// and MUST NOT carry an `uppercase` className. UPPERCASE is reserved for
// static section dividers (12px) and dialog titles only.
//
// Exception (#proj-frontend:aae2c7e8, xxchan 2026-06-10): a disclosure toggle —
// a collapsible section header marked with `aria-expanded` — reads as a section
// divider, not an action label, so it MAY keep `uppercase`. The repo-wide gate
// below skips clickable elements carrying `aria-expanded`.
//
// This repository-wide source lint prevents a refactor or future code-gen
// agent from silently reintroducing `uppercase` on a clickable element (which
// was the source of the "tab next to button in mismatched casing" visual).

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");
const strykerBackupSrc = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
};

function read(rel: string): string {
  const backupSrc = strykerBackupSrc();
  const srcPath = rel.replace(/^src\//, "");
  const backupPath = backupSrc ? resolve(backupSrc, srcPath) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, srcPath), "utf8");
}

// ── Repo-wide gate (replaces the old 2-file spot-check, which both hardcoded
// the file list AND used a `<button[^>]*>` regex that the `>` inside an
// `onClick={() => …}` arrow truncated — so a className placed after the arrow
// handler escaped detection; that gap let AttachmentCommentsPanel (#2740),
// MainLayout, and SelectionPopover regress). This version globs all .tsx and
// parses each opening tag with brace/string awareness so arrows can't truncate.

// Every .tsx file under src/, recursively.
function allTsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (ent.name.endsWith(".tsx")) out.push(rel);
    }
  };
  walk("src");
  return out;
}

/**
 * Yield each `<button …>` opening tag in `source`, parsed with brace + string
 * awareness so a `>` inside `{…}` (e.g. an arrow `() => …`) or a string never
 * closes the tag early. Returns the opening-tag substring (from `<` through its
 * real `>`). Scoped to `<button` (the clickable-label surface the doctrine
 * governs) so a component whose JSX-expression props nest other elements
 * (e.g. `<PanelHeader titleSlot={<button …>} />`) isn't misread as one tag —
 * the nested `<button>` is evaluated on its own pass.
 */
function* openingTags(source: string): Generator<string> {
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<button", i) && !/[A-Za-z0-9]/.test(source[i + 7] ?? "")) {
      let j = i + 1;
      let depth = 0;
      let str: string | null = null;
      for (; j < source.length; j++) {
        const c = source[j];
        if (str) {
          if (c === str && source[j - 1] !== "\\") str = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") str = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      yield source.slice(i, j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }
}

/**
 * Extract the `className=` value (string literal or brace expression) from an
 * opening tag, brace/string-aware. Returns "" if none. Used so that a `uppercase`
 * *prop* (e.g. `<Badge uppercase={false}>`, the OPPOSITE of a violation)
 * isn't mistaken for the Tailwind `uppercase` *class*.
 */
function classNameValue(tag: string): string {
  const m = tag.match(/\bclassName\s*=\s*/);
  if (!m || m.index == null) return "";
  let k = m.index + m[0].length;
  const open = tag[k];
  if (open === '"' || open === "'" || open === "`") {
    const end = tag.indexOf(open, k + 1);
    return tag.slice(k + 1, end < 0 ? tag.length : end);
  }
  if (open === "{") {
    let depth = 0;
    let str: string | null = null;
    let j = k;
    for (; j < tag.length; j++) {
      const c = tag[j];
      if (str) {
        if (c === str && tag[j - 1] !== "\\") str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    return tag.slice(k, j);
  }
  return "";
}

test("No clickable element across src/**/*.tsx may carry an `uppercase` className", () => {
  const violations: string[] = [];
  for (const rel of allTsxFiles()) {
    const source = read(rel);
    for (const tag of openingTags(source)) {
      // `uppercase` must be in the className value, not a same-named prop.
      const hasUppercaseClass = /\buppercase\b/.test(classNameValue(tag));
      // clickable = has an onClick handler, or is an explicit button by type/role
      const isClickable = /\bonClick\b|type=["']button["']|role=["']button["']/.test(tag);
      // Disclosure toggle (a collapsible section header carrying `aria-expanded`)
      // is a section-divider pattern, not an action label — uppercase is allowed
      // there. This is by-pattern, not by-file (#proj-frontend:aae2c7e8, xxchan
      // 2026-06-10 chose ①: disclosure headers may keep UPPERCASE).
      const isDisclosureToggle = /\baria-expanded\b/.test(tag);
      if (hasUppercaseClass && isClickable && !isDisclosureToggle) {
        violations.push(`${rel}: ${tag.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Clickable elements must use Title-Case labels, not an `uppercase` className " +
      "(#proj-uiux:8c0c5558). UPPERCASE is reserved for static section dividers / dialog titles.\n" +
      violations.join("\n"),
  );
});
