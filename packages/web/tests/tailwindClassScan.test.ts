import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Tailwind generates CSS only for the class names it finds by scanning the
 * source as text. A class glued to a template expression, as in
 * `` `rounded bg-foreground-hint${extra}` ``, does not end at a boundary the
 * scanner accepts, so it is not a candidate: unless the same class appears
 * whole somewhere else, its CSS is never generated and the element silently
 * loses the style. That is how the marked-unread dot and the sidebar's quiet
 * dot went transparent on staging (#triage:#101). Put a space before the
 * `${` (`` `bg-foreground-hint ${extra}` ``) or keep the class list in a
 * plain string.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const ROOTS = [join(REPO, "packages/web/src"), join(REPO, "apps/desktop/frontend/src")];

// Glued today, each still generated only because the same class also appears
// whole elsewhere. Removed as they are fixed; nothing may be added.
const KNOWN = new Set([
  "packages/web/src/App.tsx: font-display",
  "packages/web/src/components/InlineBadgeEditor.tsx: disabled:cursor-not-allowed",
  "packages/web/src/components/message/attachmentPreviewSurfaces.tsx: bg-sticker-paper",
  "packages/web/src/components/task/sideSectionDrag.tsx: focus-visible:keyboard:before:bg-foreground",
  "packages/web/src/components/ui/SectionHeader.tsx: gap-2",
  "packages/web/src/components/ui/SelectionPopover.tsx: focus-visible:bg-brand-soft",
  "packages/web/src/components/ui/ShowMoreToggle.tsx: text-footnote",
]);

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.[jt]sx?$/.test(path) && !/\.test\./.test(path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const TEMPLATE = /`[^`\\]*(?:\\.[^`\\]*)*`/g;
// A utility-shaped token (optional variants, at least one dash) that starts
// a word and runs straight into `${`. Not covered: a dashless utility
// (`flex${`) and a template holding a single class with no space.
const GLUED = /(?<=[\s`])((?:[\w@[\]()=&>*/.-]+:)*!?-?[a-z][a-z0-9]*(?:-[\w.[\]()/%#,-]+)+!?)(?<![-(])\$\{/g;

export function gluedClasses(source: string): string[] {
  const found: string[] = [];
  for (const literal of source.matchAll(TEMPLATE)) {
    // A class list has spaces; `fake-user-${n}` or an id is not one.
    if (!/\s/.test(literal[0].slice(1, -1))) continue;
    for (const match of literal[0].matchAll(GLUED)) found.push(match[1]);
  }
  return found;
}

test("the guard sees a class glued to a template expression, and only that", () => {
  assert.deepEqual(gluedClasses("className={`size-1.5 bg-foreground-hint${extra}`}"), ["bg-foreground-hint"]);
  assert.deepEqual(gluedClasses("className={`size-1.5 bg-foreground-hint ${extra}`}"), []);
  assert.deepEqual(gluedClasses("className={`p-2 hover:bg-brand-soft${on ? \" a\" : \"\"}`}"), ["hover:bg-brand-soft"]);
  assert.deepEqual(gluedClasses("`p-2 group-hover/item:font-bold!${on}`"), ["group-hover/item:font-bold!"]);
  assert.deepEqual(gluedClasses("`p-2 bg-(--accent)${on}`"), ["bg-(--accent)"]);
  assert.deepEqual(gluedClasses("`p-2 w-[calc(100%-2px)]${on}`"), ["w-[calc(100%-2px)]"]);
  assert.deepEqual(gluedClasses("`linear-gradient(${a}, ${b})`"), []);
  assert.deepEqual(gluedClasses("id: `fake-user-crew${n}`"), []);
});

test("no utility-shaped class is glued to a template expression, where Tailwind's scanner cannot see it", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const path of files(root)) {
      for (const cls of gluedClasses(readFileSync(path, "utf8"))) found.push(`${relative(REPO, path)}: ${cls}`);
    }
  }
  assert.deepEqual(found.filter((entry) => !KNOWN.has(entry)), [], "put a space before the `${`, or keep the classes in a plain string");
  assert.deepEqual([...KNOWN].filter((entry) => !found.includes(entry)), [], "fixed: remove it from KNOWN");
});
