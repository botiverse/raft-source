import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fails when `src/index.css` declares an animation class that nothing in
 * production source uses.
 *
 * Why this gate exists: a motion seam that breaks degrades to *no animation*,
 * and a missing animation reads like "no motion was designed here" — no error,
 * no visual residue, nobody files a bug. `onboarding-runtime-ready-flash` was
 * transplanted onto staging from an unmerged branch (its consumer and its tests
 * stayed behind) and sat dead for roughly a month; it surfaced only because
 * someone happened to audit a 480ms value while calibrating motion tokens.
 *
 * Consumer scope is deliberately narrow, and each exclusion is load-bearing:
 *
 * - **`.css` never counts.** A class name inside the stylesheet is a *definition*
 *   site, not a use. `ready-flash` appeared three times in `index.css`
 *   (`@keyframes`, the class rule, the reduced-motion `animation: none` list) —
 *   counting CSS lets every orphan feed itself and the gate can never fire.
 * - **`tests/` never counts.** Two directions break it. A test may assert a class
 *   is *absent* (`assert.doesNotMatch(source, /onboarding-handle-pin/)`) — which
 *   is evidence the class is unused, so treating it as a consumer would let the
 *   very tooth proving disuse hide the class from this gate. A test may also
 *   assert a class is *present by reading the stylesheet*
 *   (`assert.match(cssSource, /@keyframes …/)`) — a test that reads CSS to prove
 *   CSS contains something, which is circular and proves nothing about usage.
 *   Excluding `tests/` closes both without maintaining a list of assertion
 *   spellings, and a spelling list would decay the moment someone wraps the
 *   assertion in a helper.
 * - **`apps/**` never counts.** Those carry their own stylesheets and do not
 *   consume this one.
 *
 * This is a direct zero-tolerance invariant: every declared animation class
 * must have a production consumer.
 */

const webRoot = resolve(import.meta.dirname, "..");
const cssPath = resolve(webRoot, "src/index.css");

/**
 * Class selectors whose own rule body declares a real animation.
 *
 * `animation: none` is skipped on purpose: the reduced-motion block re-lists
 * existing classes to switch them off, so treating those as declarations would
 * report every reduced-motion entry as its own class.
 */
export function declaredAnimationClasses(css) {
  const found = new Set();
  // Match the whole selector prelude, not one class: `.a, .b { animation: … }`
  // declares BOTH. Capturing only the last one under-reports — the safe
  // direction, but still a blind spot.
  //
  // The body is `[^{}]*`, NOT `[^}]*`: allowing `{` inside the body lets a match
  // start at an enclosing block's brace and swallow the first rule inside it.
  // `index.css` already nests (`@layer` x3, `@media (prefers-reduced-motion)`),
  // so `@layer components { .alpha {…} .beta {…} }` would silently yield only
  // `.beta`, and a lone rule inside `@media` would vanish entirely. That
  // under-reports, which is exactly how this gate goes blind.
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, prelude, body] = match;
    if (!/\banimation\s*:/.test(body)) continue;
    if (/\banimation\s*:\s*none\b/.test(body)) continue;
    if (/@(keyframes|media|supports)/.test(prelude)) continue;
    for (const cls of prelude.matchAll(/\.([a-zA-Z0-9_-]+)/g)) found.add(cls[1]);
  }
  return [...found].sort();
}

/**
 * Whether a file may count as a consumer.
 *
 * This predicate is the whole search-domain rule, in one place and unit-tested,
 * because every way this gate can be silently blinded is a wrong answer here —
 * not a wrong answer in the matching. Counting `.css` lets an orphan cite its
 * own definition; counting `tests/` lets a test that asserts the class is
 * *absent* stand in for a use.
 */
export function isConsumerFile(path) {
  if (!/\.(ts|tsx|html)$/.test(path)) return false;
  if (path.includes("/tests/") || path.includes("/__tests__/")) return false;
  // Colocated tests are excluded by filename as well as by directory. A
  // `foo.test.tsx` sitting in `src/` would otherwise count as a consumer, and a
  // colocated test asserting a class is *absent* would blind this gate to
  // exactly that class.
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  return true;
}

/**
 * The actual files this gate reads.
 *
 * Exported so tests exercise the *traversal*, not only `isConsumerFile`. The
 * first version accepted `.html` in the predicate and unit-tested that, while
 * only ever walking `src/` — and every `.html` in this package lives at the
 * package root, so no HTML was read at all. The predicate was green and the
 * gate was blind: a class used solely from `index.html` would have been reported
 * as an orphan, and this gate's own message says "Delete the rule, or wire it
 * up." A tested predicate plus an untested traversal reads like coverage.
 */
export function collectConsumerFiles(root) {
  const files = productionSources(resolve(root, "src"));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = resolve(root, entry.name);
    if (isConsumerFile(full)) files.push(full);
  }
  return files;
}

function productionSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      productionSources(full, out);
    } else if (isConsumerFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Classes with no consumer in production source.
 *
 * `sources` is a list of `{ path, text }` rather than raw strings so the search
 * domain cannot be widened by accident at a call site: anything that is not a
 * consumer file is dropped here, not merely at the one call site that happens
 * to filter. A gate whose scope depends on its caller getting the scope right
 * is one refactor away from matching nothing.
 */
export function findOrphans(css, sources) {
  const declared = declaredAnimationClasses(css);
  const haystack = sources
    .filter((source) => isConsumerFile(source.path))
    .map((source) => source.text)
    .join("\n");
  return declared.filter((name) => !haystack.includes(name));
}

function main() {
  const css = readFileSync(cssPath, "utf8");
  const sources = collectConsumerFiles(webRoot)
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const orphans = findOrphans(css, sources);

  if (orphans.length === 0) {
    console.log("✓ orphan animation check: no orphaned animation classes");
    return;
  }

  for (const name of orphans) {
    console.error(
      `✗ .${name} declares an animation in src/index.css but no production source uses it.\n` +
      `  A broken motion seam is invisible — it looks like no animation was ever designed.\n` +
      `  Delete the rule, or wire it up.`,
    );
  }
  process.exit(1);
}

if (import.meta.filename === process.argv[1]) main();
