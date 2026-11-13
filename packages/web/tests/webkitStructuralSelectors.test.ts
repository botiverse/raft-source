import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compile } from "tailwindcss";

/**
 * No selector may end in a structural pseudo-class that nothing anchors:
 * a rightmost compound like `:not(:last-child)`, `> :last-child` or
 * `* :first-child`, with no class, attribute or tag of its own.
 *
 * Every iOS browser is WebKit. WebKit evaluates such a compound against every
 * element and marks every parent as depending on which child is first or
 * last; appending or removing a child at the end of any container then
 * restyles the previous last child's whole subtree. Measured in WebKit on a
 * 315-message channel: 180-430ms each time the chat's bottom controls mounted
 * after the timeline, and the same for anything portalled to the end of
 * <body> (menus, toasts, tooltips) after the app root. Chromium does not pay
 * this, so it only shows on iOS.
 *
 * Tailwind v4's `space-*` / `divide-*` compile to exactly that shape: use
 * raft-ui's owl-based `stack-y-*` / `stack-x-*` and `rule-y` / `rule-x` /
 * `rule-<colour>`. A structural variant belongs on the element it styles
 * (`last:mb-0` is `.last\:mb-0:last-child`, anchored by its own class).
 */

const WEB = resolve(import.meta.dirname, "..");
const ROOTS = [
  join(WEB, "src"),
  join(WEB, "visual-testing"),
  resolve(WEB, "../../apps/desktop/frontend/src"),
];

function files(dir: string, extensions: RegExp, includeTests = false): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.test(path) && (includeTests || !/\.test\./.test(path))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const LITERAL = /"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`/g;

function classTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(LITERAL)) {
    for (const token of match[0].slice(1, -1).split(/\s+/)) if (token) tokens.push(token);
  }
  return tokens;
}

const STRUCTURAL = /:(?:first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-(?:child|last-child|of-type|last-of-type)\b)/;

function rightmostCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) start = i + 1;
  }
  return selector.slice(start).trim();
}

export function unanchoredStructural(selector: string): boolean {
  let inner = selector.trim();
  while (/^:where\((.*)\)$/s.test(inner)) inner = inner.replace(/^:where\((.*)\)$/s, "$1").trim();
  return inner.split(",").some((part) => {
    const compound = rightmostCompound(part.trim());
    if (!STRUCTURAL.test(compound)) return false;
    const withoutPseudos = compound.replace(/:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "");
    return !/[.#[]|^[a-z]/i.test(withoutPseudos);
  });
}

// Tailwind v4 also scans the package on its own (tests, scripts, index.html),
// so a class-shaped string anywhere there generates CSS too.
const SCANNED = [...ROOTS, join(WEB, "tests"), join(WEB, "scripts")];
const scanned = SCANNED.flatMap((root) => files(root, /\.(ts|tsx|mjs|js|html)$/, true))
  .concat(join(WEB, "index.html"))
  .filter((file) => !file.endsWith("webkitStructuralSelectors.test.ts"))
  .map((file) => readFileSync(file, "utf8"));

const sources = ROOTS.flatMap((root) => files(root, /\.(ts|tsx)$/)).map((file) => ({
  rel: relative(resolve(WEB, "../.."), file),
  source: readFileSync(file, "utf8"),
}));

test("sources use stack-* and rule-*, never Tailwind's space-* or divide-*", () => {
  const offenders: string[] = [];
  for (const { rel, source } of sources) {
    for (const token of classTokens(source)) {
      const utility = token.split(":").at(-1) ?? "";
      if (/^-?(?:space-[xy]-|divide(?:-[xy])?(?:-|$))/.test(utility)) offenders.push(`${rel}: ${token}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("compiled utilities never end in an unanchored structural pseudo-class", async () => {
  const tokens = new Set<string>();
  for (const source of scanned) for (const token of source.split(/[\s"'`]+/)) if (token) tokens.add(token);
  // A theme with spacing and a colour, so space-*/divide-* would compile if anything used them.
  const compiler = await compile("@theme { --spacing: 0.25rem; --color-line-hairline: #ddd; }\n@tailwind utilities;");
  const css = compiler.build([...tokens]);
  const offenders: string[] = [];
  for (const segment of css.split("}")) {
    const brace = segment.indexOf("{");
    if (brace < 0) continue;
    const selector = segment.slice(0, brace).trim();
    if (!selector || selector.startsWith("@") || selector.startsWith("/*")) continue;
    if (unanchoredStructural(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, []);
});

test("hand-written CSS never ends a selector in an unanchored structural pseudo-class", () => {
  const offenders: string[] = [];
  for (const file of ROOTS.flatMap((root) => files(root, /\.css$/))) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const segment of css.split(/[{}]/).filter((_, i) => i % 2 === 0)) {
      const selector = segment.trim();
      if (!selector || selector.startsWith("@") || !/[a-z.#[:*]/i.test(selector[0] ?? "")) continue;
      if (unanchoredStructural(selector)) offenders.push(`${relative(WEB, file)}: ${selector}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the guard recognises the shapes it exists for", () => {
  assert.equal(unanchoredStructural(":where(.x > :not(:last-child))"), true);
  assert.equal(unanchoredStructural(".group\\/message[data-followed-by] .body > :last-child"), true);
  assert.equal(unanchoredStructural(".x > :last-child > :last-child:has(pre)"), true);
  assert.equal(unanchoredStructural(".last\\:mb-0:last-child"), false);
  assert.equal(unanchoredStructural(".x > :last-child > p:last-child"), false);
  assert.equal(unanchoredStructural(".x > :last-child > [data-code-block]:last-child"), false);
  assert.equal(unanchoredStructural(":where(.y > * + *)"), false);
});
