import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Loading→loaded render hygiene (闪回 fix, task #37): guard against the
// URL-param self-trigger loop class.
//
// #2787 (MessageSearchPage search flicker): an effect read `searchParams`,
// built a new URLSearchParams, and called `setSearchParams(next)` — while ALSO
// listing `searchParams` in its dependency array. Writing the URL re-changed
// `searchParams`, which re-fired the effect (it's a dep) → self-trigger loop →
// visible flicker. The safe form is the functional updater
// `setSearchParams((prev) => …)` WITHOUT `searchParams` in the deps, so the
// effect never depends on its own write.
//
// This is a source-level guard (the loop is a runtime behaviour jsdom can't
// faithfully reproduce). A positive-control test below proves the detector
// actually fires on the bad pattern, so a clean repo can't be falsely green.

const repoRoot = resolve(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

/**
 * Every source file that can contain a `useEffect` — `.tsx` AND `.ts`.
 *
 * This used to walk `.tsx` only, which left a hole exactly the size of a custom hook:
 * hooks live in `src/hooks/*.ts` and have no JSX, so the #2787 loop could be written
 * there and this gate would never see it. Found while wiring the embed keeper (PR
 * #4799) — moving the keeper out of `MainLayout.tsx` into `hooks/useEmbedParamsKeeper.ts`
 * silently walked it out of scope of this very gate, and the counterfactual that had
 * been red went green. Extract-a-hook is the most ordinary refactor there is; a gate
 * that a refactor can step out of is not a gate.
 */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (ent.name.endsWith(".tsx") || (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts"))) {
        out.push(rel);
      }
    }
  };
  walk("src");
  return out;
}

/**
 * Yield the inner argument text of each `useEffect(…)` call — i.e. everything
 * between the outer parens (the callback + the dependency array). Paren/brace/
 * string-aware so nested `()` / `{}` / strings in the callback don't close the
 * call early.
 */
function* effectCalls(source: string): Generator<string> {
  const NEEDLE = "useEffect(";
  let from = 0;
  let at = source.indexOf(NEEDLE, from);
  while (at !== -1) {
    const open = at + NEEDLE.length - 1; // index of '('
    let depth = 0;
    let str: string | null = null;
    let j = open;
    for (; j < source.length; j++) {
      const c = source[j];
      if (str) {
        if (c === str && source[j - 1] !== "\\") str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    yield source.slice(open + 1, j);
    from = j + 1;
    at = source.indexOf(NEEDLE, from);
  }
}

/** The dependency array = the last top-level `[ … ]` in a useEffect call's args. */
function dependencyArray(effectInner: string): string {
  let end = -1;
  let depth = 0;
  let str: string | null = null;
  // find the last top-level ']'
  for (let j = 0; j < effectInner.length; j++) {
    const c = effectInner[j];
    if (str) {
      if (c === str && effectInner[j - 1] !== "\\") str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}") depth--;
    else if (c === "]") {
      depth--;
      if (depth === 0) end = j;
    }
  }
  if (end === -1) return "";
  // walk back to the matching '['
  let d = 0;
  for (let j = end; j >= 0; j--) {
    const c = effectInner[j];
    if (c === "]") d++;
    else if (c === "[") {
      d--;
      if (d === 0) return effectInner.slice(j, end + 1);
    }
  }
  return "";
}

const URL_PARAM_SETTER = /\bset(?:SearchParams|Params)\s*\(/;
const SEARCH_PARAMS_DEP = /\bsearchParams\b/;

function selfTriggerEffects(source: string): string[] {
  const hits: string[] = [];
  for (const inner of effectCalls(source)) {
    const deps = dependencyArray(inner);
    if (URL_PARAM_SETTER.test(inner) && SEARCH_PARAMS_DEP.test(deps)) {
      hits.push(inner.replace(/\s+/g, " ").slice(0, 160));
    }
  }
  return hits;
}

// Positive control: the detector MUST fire on the #2787 bad pattern, else a
// clean repo would be vacuously green (source-pattern false-green guard).
test("detector fires on the #2787 self-trigger pattern (positive control)", () => {
  const bad = `
    useEffect(() => {
      const next = new URLSearchParams(searchParams);
      next.set("q", query);
      setSearchParams(next, { replace: true });
    }, [query, searchParams, setSearchParams]);
  `;
  assert.equal(selfTriggerEffects(bad).length, 1, "detector must flag setSearchParams write + searchParams dep");

  const safe = `
    useEffect(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("q", query);
        return next;
      }, { replace: true });
    }, [query, setSearchParams]);
  `;
  assert.equal(selfTriggerEffects(safe).length, 0, "functional updater without searchParams dep must NOT be flagged");
});

test("No useEffect creates a URL-param self-trigger loop (#2787 class)", () => {
  const violations: string[] = [];
  for (const rel of allSourceFiles()) {
    for (const snippet of selfTriggerEffects(read(rel))) {
      violations.push(`${rel}: ${snippet}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "An effect writes `setSearchParams(...)` while listing `searchParams` in its deps — it re-fires on its own URL write (self-trigger loop / flicker, #2787). " +
      "Use the functional updater `setSearchParams((prev) => …)` and drop `searchParams` from the dependency array.\n" +
      violations.join("\n"),
  );
});
