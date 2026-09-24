import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Auth trace failure-isolation contract (Auth Session Contract, #2494
 * §"Trace failure isolation").
 *
 * The producer side (`utils/webAuthTrace.ts`) is already failure-isolated:
 * every public entry wraps its body in try/catch and never throws. The
 * `webAuthTrace.test.ts` unit tests cover that. This file enforces the
 * CALLER side — that no future refactor lets a trace emit taint auth
 * state. Specifically: a trace failure must never become a new logout
 * cause.
 *
 * Companion to:
 *   - `webAuthTraceWiringContract.test.ts` (verifies emits ARE present at
 *     each contract-required callsite, never awaited, never returned,
 *     session_cleared uses immediate-flush variant).
 *   - `authClearSessionContract.test.ts` (verifies WHO may clear session).
 *
 * The gap this file closes: even with the wiring-contract guarantees,
 * someone could later add a `.then(...)` / `.catch(...)` chain on an
 * emit, or wrap an emit in a `try { ... } catch { logout(); }` block —
 * either pattern would let a trace-side failure cause an auth-side
 * mutation. That is exactly the regression class the contract forbids.
 *
 * Pattern modeled on `restoreTimeoutWiringContract.test.ts` and
 * `authClearSessionContract.test.ts`: strip comments, scan a fixed file
 * list of auth-adjacent producers, fail loud with file:line.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

// The set of files allowed to call emitAuthTrace / emitAuthTraceAndFlush.
// This list is intentionally a superset of the wiring-contract caller set
// so any new auth-adjacent caller picked up by future wiring work is
// still subject to isolation. If a NEW file starts calling emitAuthTrace,
// add it here AND add the corresponding wiring-contract entry.
const AUTH_EMIT_CALLER_FILES = [
  "store/authStore.ts",
  "api/client.ts",
  "App.tsx",
  "utils/authSessionPolicy.ts",
  "utils/refreshCoordinator.ts",
  "utils/protectedRequestAuthPolicy.ts",
  "utils/socketSessionPolicy.ts",
] as const;

// Surface names the producer exports. Used to spot any callsite that
// shows up outside the approved files (anti-rot for the producer's
// caller set).
const EMIT_FUNCTIONS = ["emitAuthTrace", "emitAuthTraceAndFlush"] as const;

// Strip block + line comments before scanning so doc text mentioning
// `.then(emitAuthTrace...)` or `try { emitAuthTrace } catch { logout() }`
// in an explanation comment doesn't false-fire. Mirrors the strip-comments
// idiom in restoreTimeoutWiringContract / authClearSessionContract.
function stripComments(source: string): string {
  let s = source.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/\/\/[^\n]*/g, "");
  return s;
}

function readSrc(rel: string): string {
  return readFileSync(resolve(srcRoot, rel), "utf8");
}

interface LineHit {
  file: string;
  line: number;
  text: string;
}

function lineHits(file: string, source: string, re: RegExp): LineHit[] {
  const lines = source.split("\n");
  const out: LineHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push({ file, line: i + 1, text: lines[i].trim() });
  }
  return out;
}

/**
 * Given source and an offset pointing at an opening bracket (`(`, `{`,
 * `[`), return the offset just past the matching closing bracket, or -1
 * if not balanced. Used so a regex match locating the START of an
 * expression can extract a syntactically-balanced extent without being
 * fooled by nested brackets inside string literals etc. (Strings are
 * approximated — for this codebase's auth files that's sufficient.)
 */
function matchBracket(source: string, openIdx: number): number {
  const open = source[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function lineText(rawSource: string, lineNum1Based: number): string {
  return (rawSource.split("\n")[lineNum1Based - 1] ?? "").trim();
}

test("emit calls must not chain .then() or .catch() (would defeat fire-and-forget)", () => {
  // The producer's emit functions are declared `void` but they perform
  // side effects via `void sendUrgentAuthTraceBatch(...)` etc. Even a
  // `.then(...)` on the return value would let trace timing affect
  // surrounding control flow; a `.catch(...)` would put trace-side
  // error handling in the auth path. Both are contract violations
  // regardless of what the chained callback does — the wiring contract
  // already forbids `await emit` and `return emit`; this closes the
  // remaining `.then` / `.catch` shapes.
  //
  // Detection: regex finds `emitAuthTrace[AndFlush](` start; balanced-
  // paren walk locates the matching `)`; then check whether the next
  // non-whitespace token is `.then` / `.catch` / `.finally`. This avoids
  // the [^)]*-stops-at-first-) false-negative pointed out by @铁根
  // (real callsites have nested function-call args, e.g.
  // `emitAuthTrace("verdict", { statusBucket: authStatusBucket(status) })`).
  const emitStartRe = /\b(?:emitAuthTrace(?:AndFlush)?)\s*\(/g;
  const chainContinuationRe = /^\s*\.\s*(?:then|catch|finally)\s*\(/;
  const violations: LineHit[] = [];
  for (const file of AUTH_EMIT_CALLER_FILES) {
    const src = stripComments(readSrc(file));
    const raw = readSrc(file);
    let m: RegExpExecArray | null;
    while ((m = emitStartRe.exec(src)) !== null) {
      const openParenIdx = src.indexOf("(", m.index);
      if (openParenIdx < 0) continue;
      const closeIdx = matchBracket(src, openParenIdx);
      if (closeIdx < 0) continue;
      const tail = src.slice(closeIdx);
      if (chainContinuationRe.test(tail)) {
        const line = lineOf(src, m.index);
        violations.push({ file, line, text: lineText(raw, line) });
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `emitAuthTrace / emitAuthTraceAndFlush must not have .then()/.catch()/.finally() chained. ` +
      `The producer is fire-and-forget by design; chaining lets trace timing or trace errors ` +
      `taint the auth path, violating §"Trace failure isolation" of the Auth Session Contract.\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("emit calls must not be inside a try whose catch touches auth state", () => {
  // Wrapping an emit in try/catch would normally be benign (the producer
  // never throws anyway), but if the catch block also mutates auth state
  // — calls a clear-session sink, logout(), setRestoreState, or pokes
  // authStore.set — then a trace-side failure becomes an auth-side
  // logout. The contract forbids "trace failure becoming a new logout
  // cause", so this pattern must red.
  //
  // Detection: locate each `try { ... } catch ...`. Use BALANCED-BRACE
  // extraction for the try body (per @铁根 review: the prior non-greedy
  // [\s\S]*? regex would mis-align on nested try/catch and let an outer
  // violation slip through). Check whether the try body actually
  // contains an emit call; if so, balanced-brace-extract the catch body
  // and look for forbidden auth-state mutations.
  const FORBIDDEN_IN_CATCH = [
    /\bclearAuthAndRedirect\s*\(/,
    /\blogout\s*\(/,
    /\bsetRestoreState\s*\(/,
    /\bauthStore\s*\.\s*setState\s*\(/,
    /\.\s*set\s*\(\s*\{[^}]*\buser\s*:\s*null\b/,
    /localStorage\.removeItem\s*\(\s*["']slock_(?:access|refresh)_token["']/,
  ];
  const tryStartRe = /\btry\s*\{/g;
  const emitInBodyRe = new RegExp(`\\b(?:${EMIT_FUNCTIONS.join("|")})\\s*\\(`);
  const violations: LineHit[] = [];
  for (const file of AUTH_EMIT_CALLER_FILES) {
    const raw = readSrc(file);
    const src = stripComments(raw);
    let m: RegExpExecArray | null;
    while ((m = tryStartRe.exec(src)) !== null) {
      // Locate the `{` that opens the try body.
      const tryBodyOpen = src.indexOf("{", m.index);
      if (tryBodyOpen < 0) continue;
      const tryBodyEnd = matchBracket(src, tryBodyOpen);
      if (tryBodyEnd < 0) continue;
      const tryBody = src.slice(tryBodyOpen + 1, tryBodyEnd - 1);
      if (!emitInBodyRe.test(tryBody)) continue;
      // Find the matching `catch` clause that follows the try body. The
      // tokens are `} catch (...) { ... }`. Skip whitespace; bail out if
      // the next non-whitespace token isn't `catch`.
      let afterTry = tryBodyEnd;
      while (afterTry < src.length && /\s/.test(src[afterTry])) afterTry += 1;
      if (src.slice(afterTry, afterTry + 5) !== "catch") continue;
      // Optional `(err)` etc. — skip a parenthesized expression if present.
      let i = afterTry + 5;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src[i] === "(") {
        const closeP = matchBracket(src, i);
        if (closeP < 0) continue;
        i = closeP;
        while (i < src.length && /\s/.test(src[i])) i += 1;
      }
      if (src[i] !== "{") continue;
      const catchBodyEnd = matchBracket(src, i);
      if (catchBodyEnd < 0) continue;
      const catchBody = src.slice(i, catchBodyEnd);
      if (FORBIDDEN_IN_CATCH.some((p) => p.test(catchBody))) {
        const line = lineOf(src, m.index);
        violations.push({ file, line, text: lineText(raw, line) });
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `A try { ...emit(...)... } catch { ... } block in an auth-adjacent file has a catch that ` +
      `mutates auth state (clearAuthAndRedirect / logout / setRestoreState / authStore set with ` +
      `user: null / direct token removeItem). Per Auth Session Contract §"Trace failure isolation": ` +
      `a trace failure must never become a new logout cause. Move auth-state mutations out of any ` +
      `block that wraps an emit, or remove the wrapping try/catch entirely (the producer never throws).\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("emit return value must not be assigned, conditioned, spread, or awaited", () => {
  // The producer returns `void`. This test is a syntactic-shape
  // belt-and-suspenders that catches the most common bypasses an `any`
  // cast or untyped helper might let slip:
  //
  //   const/let/var x = emit(...)        // declaration with initializer
  //   x = emit(...)                       // plain reassignment
  //   if/while/switch (emit(...))         // condition
  //   ?? emit(...)                         // result-as-fallback
  //   await emit(...)                     // awaited (also in wiring contract)
  //   ...emit(...)                         // spread
  //
  // What this test does NOT catch (knowingly out of scope — a syntactic
  // scan can't reliably distinguish use-of-result from a discarded
  // function-call statement nested as an argument):
  //
  //   bar(emit(...))                      // emit-as-argument
  //   [emit(...)]                          // emit-as-array-element
  //   { key: emit(...) }                  // emit-as-object-value
  //
  // Coverage by `tsc --noEmit` is partial and not the same set:
  //   - `bar(emit(...))` where bar's param type is not `void`/`unknown`/
  //     `any`: tsc errors ("void not assignable to T").
  //   - `if/while/switch/?: (emit(...))` / `?? emit(...)`: tsc errors
  //     ("expression of type 'void' cannot be tested for truthiness").
  //   - `...emit(...)`: tsc errors (void is not a spreadable type).
  //   - `[emit(...)]` and `{ k: emit(...) }`: tsc DOES NOT error —
  //     `void[]` and `{ k: void }` are valid TypeScript types. These
  //     shapes are knowingly uncovered. Producer is fire-and-forget so
  //     storing a void into an array/object is dead noise that can't
  //     couple back into auth control flow; leaving them uncovered is
  //     acceptable rather than overstated.
  //
  // Allowed shapes (no usage of the return value):
  //   emitAuthTrace(...);
  //   void emitAuthTrace(...);
  //   if (cond) emitAuthTrace(...);   // gating IS fine; the emit's own
  //                                   // result is not the conditional.
  const emitNames = EMIT_FUNCTIONS.join("|");
  const forbiddenShapes: RegExp[] = [
    // declaration with initializer
    new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*(?:${emitNames})\\s*\\(`),
    // plain reassignment (e.g. `result = emit(...)`). Must NOT match
    // `==` or `===`; use a negative lookahead.
    new RegExp(`\\b\\w+\\s*=(?!=)\\s*(?:${emitNames})\\s*\\(`),
    // conditional / loop / switch on the emit result
    new RegExp(`\\bif\\s*\\(\\s*(?:${emitNames})\\s*\\(`),
    new RegExp(`\\bwhile\\s*\\(\\s*(?:${emitNames})\\s*\\(`),
    new RegExp(`\\bswitch\\s*\\(\\s*(?:${emitNames})\\s*\\(`),
    // result-as-fallback / optional chaining tail
    new RegExp(`\\?\\?\\s*(?:${emitNames})\\s*\\(`),
    // awaited
    new RegExp(`\\bawait\\s+(?:${emitNames})\\s*\\(`),
    // spread of return value
    new RegExp(`\\.\\.\\.\\s*(?:${emitNames})\\s*\\(`),
  ];
  const violations: LineHit[] = [];
  for (const file of AUTH_EMIT_CALLER_FILES) {
    const src = stripComments(readSrc(file));
    for (const re of forbiddenShapes) {
      violations.push(...lineHits(file, src, re));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Auth trace emit calls must not have their return value (\`void\`) assigned, reassigned, ` +
      `conditioned on, spread, or awaited. The producer is intentionally fire-and-forget — any ` +
      `use of its return value couples auth control flow to trace runtime. Some out-of-scope ` +
      `shapes (e.g. \`bar(emit(...))\` into a non-void param, truthiness-test on emit, spread) ` +
      `are blocked by \`tsc --noEmit\`; emit-as-array-element / emit-as-object-value are not ` +
      `caught by tsc either but are dead-noise (void stored into a structure cannot couple to ` +
      `auth control flow), and intentionally left uncovered.\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("emit functions are only called from the approved caller set (anti-rot)", () => {
  // If a future PR adds an emitAuthTrace caller in a brand-new file
  // without updating the wiring contract's caller list, this test
  // catches the drift. The list-membership check protects the per-file
  // scope assumptions in the tests above.
  //
  // We scan the WHOLE src tree for emitAuthTrace[AndFlush]( and report
  // any callsite whose containing file is not in AUTH_EMIT_CALLER_FILES.
  //
  // We skip the producer module itself (it defines the functions).
  const emitCallRe = new RegExp(`\\b(?:${EMIT_FUNCTIONS.join("|")})\\s*\\(`);
  const PRODUCER_FILE = "utils/webAuthTrace.ts";
  const violations: LineHit[] = [];
  // Walk the src tree without re-globbing.
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (/\.(?:ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }
  for (const full of walk(srcRoot)) {
    const rel = full.slice(srcRoot.length + 1).replaceAll("\\", "/");
    if (rel === PRODUCER_FILE) continue;
    const src = stripComments(readFileSync(full, "utf8"));
    if (!emitCallRe.test(src)) continue;
    if ((AUTH_EMIT_CALLER_FILES as readonly string[]).includes(rel)) continue;
    // Find the line for a clean error message.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (emitCallRe.test(lines[i])) violations.push({ file: rel, line: i + 1, text: lines[i].trim() });
    }
  }
  assert.deepEqual(
    violations,
    [],
    `New auth-trace emit callsite outside the approved caller list. Update AUTH_EMIT_CALLER_FILES ` +
      `here AND add the corresponding wiring-contract entry in webAuthTraceWiringContract.test.ts ` +
      `so the new callsite is subject to both wiring and failure-isolation contracts.\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
  );
});
