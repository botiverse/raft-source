import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Auth clear-session contract (Auth Session Contract, #2494 §"Clear-Session
 * Invariant").
 *
 * Persisted auth credentials may be cleared only when both conditions hold:
 *
 *   clear_session_allowed = terminal_evidence AND authorized_sink
 *
 * This file enforces the static half — the AUTHORIZED SINK side — as a
 * source-scan regression guard. The TRIGGER side (terminal evidence vs
 * timer/transient) is enforced by `restoreTimeoutPolicy.ts` + its tests,
 * and at PR-review time via the contract's evidence taxonomy.
 *
 * Authorized production sinks (the only places allowed to remove the
 * persisted session tokens or reduce `authStore` to a signed-out user):
 *   1. `packages/web/src/api/client.ts::clearAuthAndRedirect`
 *   2. `packages/web/src/store/authStore.ts::logout`
 *
 * Dev-only exemption (per contract §"Dev-only exemption"):
 *   - `packages/web/src/App.tsx::SlockdevDebugPanel.clearLocalState` may
 *     clear local state ONLY under the existing `isSlockdev` gate. This
 *     code path must remain inside that gate; production builds short-
 *     circuit before reaching it.
 *
 * Pattern modeled on `restoreTimeoutWiringContract.test.ts` /
 * `keydownFocusContract.test.ts` — mechanical, narrow, no runtime.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

// Authorized callsites: (file path relative to srcRoot, function name) tuples.
// Matched as "file is exactly this file AND the violation appears inside the
// named function". App.tsx::clearLocalState is dev-only and listed here only
// so the scan accepts the existing slockdev panel without false-positive.
const AUTHORIZED_CLEAR_TOKEN_SITES = [
  { file: "api/client.ts", fn: "clearAuthAndRedirect" },
  { file: "store/authStore.ts", fn: "logout" },
  // dev-only — slockdev preview panel, gated by isSlockdev at module load
  { file: "App.tsx", fn: "clearLocalState" },
] as const;

// Tokens whose direct localStorage removal counts as a clear-session action.
const PERSISTED_AUTH_KEYS = ["slock_access_token", "slock_refresh_token"] as const;

const TS_FILE_RE = /\.(ts|tsx)$/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (TS_FILE_RE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Strip line-and-block comments so commented-out code or doc text never
// becomes a violation signal. Mirrors the strip-comments idiom used in
// restoreTimeoutWiringContract.test.ts.
function stripComments(source: string): string {
  // Block comments first (non-greedy across newlines).
  let s = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then line comments to end-of-line.
  s = s.replace(/\/\/[^\n]*/g, "");
  return s;
}

interface FunctionRange {
  start: number; // inclusive byte offset of the opening `{`
  end: number; // exclusive byte offset just past the matching `}`
}

/**
 * Locate the byte range of a function body within `source`. Supports the
 * forms used by the authorized sites:
 *   - `function fn(...) { ... }`
 *   - `const fn = (...) => { ... }`
 *   - object/method `fn: (...) => { ... }` or `fn(...) { ... }` (for the
 *     authStore zustand object methods)
 *
 * Returns null if the function cannot be located. Returning a byte range
 * (rather than the substring) lets callers ask "is this hit at offset X
 * inside the authorized function body?" without false positives from
 * other functions in the same file that happen to share the same source
 * line text.
 */
function extractFunctionRange(source: string, fn: string): FunctionRange | null {
  const escFn = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Each pattern must anchor to "the body actually starts here", not a
  // type alias like `logout: () => void;`. Require `=> {` for arrow forms,
  // `{` for `function` and method shorthand.
  const patterns = [
    new RegExp(`\\bfunction\\s+${escFn}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`),
    new RegExp(`\\bconst\\s+${escFn}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*=>\\s*\\{`),
    new RegExp(`\\b${escFn}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*=>\\s*\\{`),
    new RegExp(`\\b${escFn}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`),
  ];
  let startIdx = -1;
  for (const re of patterns) {
    const m = source.match(re);
    if (m && m.index !== undefined) {
      startIdx = m.index;
      break;
    }
  }
  if (startIdx < 0) return null;

  // Walk forward to the first `{` after the declaration, then balance braces.
  let i = source.indexOf("{", startIdx);
  if (i < 0) return null;
  let depth = 0;
  const bodyStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start: bodyStart, end: i + 1 };
    }
  }
  return null;
}

interface Hit {
  filePath: string; // relative to srcRoot, forward-slash
  line: number; // 1-based
  text: string;
  offset: number; // byte offset of the match in the stripped source
}

function findHits(file: string, source: string, regex: RegExp): Hit[] {
  const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
  // Use global flag to walk all matches with stable byte offsets. Each line's
  // first match suffices; we still report by line for the failure message,
  // but the byte offset comes from the actual regex match position so a
  // later position-based check is unambiguous about which physical occurrence
  // produced the hit.
  const globalRe = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  const hits: Hit[] = [];
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(source)) !== null) {
    const offset = match.index;
    // Compute 1-based line number for the offset by counting newlines.
    const upToOffset = source.slice(0, offset);
    const line = upToOffset.split("\n").length;
    // The visible line text for the failure message.
    const lineStart = upToOffset.lastIndexOf("\n") + 1;
    const lineEndRel = source.indexOf("\n", offset);
    const lineEnd = lineEndRel < 0 ? source.length : lineEndRel;
    const text = source.slice(lineStart, lineEnd).trim();
    hits.push({ filePath: rel, line, text, offset });
    // Guard against zero-width regex pathology.
    if (match[0].length === 0) globalRe.lastIndex += 1;
  }
  return hits;
}

function isHitInsideAuthorizedSite(hit: Hit, fileSourceStripped: string): boolean {
  for (const site of AUTHORIZED_CLEAR_TOKEN_SITES) {
    if (hit.filePath !== site.file) continue;
    const range = extractFunctionRange(fileSourceStripped, site.fn);
    if (!range) continue;
    // Position-based containment: the hit's byte offset must fall inside
    // the authorized function's [start, end) range. Substring containment
    // would false-allow a duplicated bypass elsewhere in the same file
    // whose source line text happens to match the authorized callsite.
    if (hit.offset >= range.start && hit.offset < range.end) return true;
  }
  return false;
}

test("only authorized sinks may remove slock auth tokens from localStorage", () => {
  const removeAuthTokenRe = new RegExp(
    `localStorage\\.removeItem\\(\\s*["'](?:${PERSISTED_AUTH_KEYS.join("|")})["']\\s*\\)`,
  );
  const violations: Hit[] = [];
  for (const file of listTsFiles(srcRoot)) {
    const raw = readFileSync(file, "utf8");
    const stripped = stripComments(raw);
    const hits = findHits(file, stripped, removeAuthTokenRe);
    for (const h of hits) {
      if (!isHitInsideAuthorizedSite(h, stripped)) violations.push(h);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Unauthorized clear-session callsite(s). Persisted auth tokens may be removed only inside ` +
      `api/client.ts::clearAuthAndRedirect, store/authStore.ts::logout, or the dev-only ` +
      `App.tsx::clearLocalState (slockdev panel). Each violation below adds a new path that ` +
      `bypasses the Auth Session Contract clear-session invariant (rfcs/016-auth-session-contract.md):\n` +
      violations.map((v) => `  ${v.filePath}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("only authorized sinks may reduce authStore.user to null", () => {
  // `user: null` inside a `set({...})` call is the way authStore drops the
  // signed-in user. Only authStore.ts's own `logout` reducer is allowed to
  // perform this transition; everywhere else must dispatch through the
  // store API (which goes through `logout` or the restore state machine).
  //
  // We allow `setUser(null)` outside (it's the public API) but ban a
  // direct `set({ user: null ... })` literal in any file other than
  // authStore.ts. We also allow it inside the loadUser bootstrap inside
  // authStore.ts, which is part of the same module's owner.
  const userNullSetRe = /\bset\s*\(\s*\{[^}]*\buser\s*:\s*null\b/;
  const violations: Hit[] = [];
  for (const file of listTsFiles(srcRoot)) {
    const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
    if (rel === "store/authStore.ts") continue; // owner module
    const raw = readFileSync(file, "utf8");
    const stripped = stripComments(raw);
    const hits = findHits(file, stripped, userNullSetRe);
    violations.push(...hits);
  }
  assert.deepEqual(
    violations,
    [],
    `Unauthorized direct authStore user-null transition. Only store/authStore.ts may write ` +
      `\`set({ user: null, ... })\`. Callers must go through \`authStore.logout()\` or a ` +
      `restore-state-machine event.\n` +
      violations.map((v) => `  ${v.filePath}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("redirect-plus-clear-token combos must live inside an authorized sink", () => {
  // The forbidden pattern (per contract §"Redirect policy"): a code scope
  // that BOTH (a) navigates to `/` AND (b) removes a persisted auth token,
  // and is NOT one of the authorized sinks. The redirect by itself is
  // fine (post-login bounce, error pages, slockdev "Server Picker" reset
  // that only clears non-auth keys, etc.) and an auth-token clear inside
  // an authorized sink is fine on its own; only the co-occurrence in the
  // same code scope is the contract violation.
  //
  // Detection: pair each auth-token-removal hit with the nearest enclosing
  // redirect hit using BYTE OFFSETS. If a redirect and an auth-token clear
  // are within ~600 bytes (typical short function body) of each other
  // AND that pair is outside any authorized sink range, that's a violation.
  // A function-range check still wins where the authorized sites are
  // declared; the byte-window fallback handles ad-hoc inline scopes
  // (anonymous handlers, IIFEs) that aren't in our whitelist.
  const redirectHomeRe = /\bwindow\.location\.(?:href\s*=\s*["']\/["']|assign\(\s*["']\/["']\s*\)|replace\(\s*["']\/["']\s*\))/;
  const removeAuthTokenRe = new RegExp(
    `localStorage\\.removeItem\\(\\s*["'](?:${PERSISTED_AUTH_KEYS.join("|")})["']\\s*\\)`,
  );
  const COOCCURRENCE_WINDOW_BYTES = 600;
  const violations: Hit[] = [];
  for (const file of listTsFiles(srcRoot)) {
    const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
    const raw = readFileSync(file, "utf8");
    const stripped = stripComments(raw);
    const authClearHits = findHits(file, stripped, removeAuthTokenRe);
    if (authClearHits.length === 0) continue;
    const redirectHits = findHits(file, stripped, redirectHomeRe);
    if (redirectHits.length === 0) continue;
    const fnSitesForFile = AUTHORIZED_CLEAR_TOKEN_SITES.filter((s) => s.file === rel);
    const authorizedRanges = fnSitesForFile
      .map((s) => extractFunctionRange(stripped, s.fn))
      .filter((r): r is FunctionRange => r !== null);
    for (const redirect of redirectHits) {
      // Allowed if the redirect itself falls inside an authorized sink.
      if (authorizedRanges.some((r) => redirect.offset >= r.start && redirect.offset < r.end)) continue;
      // Otherwise, check whether any auth-token clear sits close enough to
      // this redirect to count as the same code scope. If so, it's the
      // forbidden co-occurrence pattern.
      const nearbyClear = authClearHits.find(
        (c) => Math.abs(c.offset - redirect.offset) <= COOCCURRENCE_WINDOW_BYTES,
      );
      if (nearbyClear) violations.push(redirect);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Redirect to "/" co-occurs with auth-token clearing outside an authorized sink. ` +
      `Per contract §"Redirect policy": redirect + token storage clear in the same scope ` +
      `is only allowed inside an authorized sink with terminal evidence.\n` +
      violations.map((v) => `  ${v.filePath}:${v.line}  ${v.text}`).join("\n"),
  );
});

test("dev-only clearLocalState is gated by an isSlockdev early-return", () => {
  // The contract §"Dev-only exemption" reads:
  //
  //   `App.tsx::SlockdevDebugPanel.clearLocalState` may clear local state
  //   only under the existing slockdev/debug gate. Dev-only clear paths
  //   must not be reachable in production builds or production deployment
  //   envs.
  //
  // Without this test, deleting the early-return `if (!isSlockdev) return null;`
  // would silently turn the dev panel into a production-reachable sink while
  // still satisfying the file/function exemption above. Anchor the assertion
  // on a position-based check: inside the SlockdevDebugPanel function body,
  // an `if (!isSlockdev) return null;` (or strictly equivalent) MUST appear
  // BEFORE any reference to `clearLocalState`.
  const appSrc = stripComments(readFileSync(resolve(srcRoot, "App.tsx"), "utf8"));
  const panelRange = extractFunctionRange(appSrc, "SlockdevDebugPanel");
  assert.ok(
    panelRange,
    "SlockdevDebugPanel function declaration not found in App.tsx. If the dev panel was renamed, update this test AND the AUTHORIZED_CLEAR_TOKEN_SITES `App.tsx::clearLocalState` entry to match.",
  );
  const panelBody = appSrc.slice(panelRange.start, panelRange.end);
  const gateRe = /\bif\s*\(\s*!\s*isSlockdev\s*\)\s*return\s+null\s*;/;
  const gateMatch = gateRe.exec(panelBody);
  assert.ok(
    gateMatch,
    "SlockdevDebugPanel no longer contains the `if (!isSlockdev) return null;` early-return gate. The dev-only clearLocalState exemption depends on this guard; without it, the dev panel becomes reachable in production builds.",
  );
  const clearLocalStateIdx = panelBody.indexOf("clearLocalState");
  assert.ok(
    clearLocalStateIdx >= 0,
    "SlockdevDebugPanel no longer references `clearLocalState`. If it was renamed, update AUTHORIZED_CLEAR_TOKEN_SITES.",
  );
  assert.ok(
    gateMatch.index < clearLocalStateIdx,
    `The \`if (!isSlockdev) return null;\` gate must appear BEFORE clearLocalState is referenced inside SlockdevDebugPanel (gate at offset ${gateMatch.index}, first clearLocalState reference at offset ${clearLocalStateIdx}). Moving the guard after the clear path makes the dev sink reachable in production.`,
  );
});

test("authorized sinks are still present (anti-rot)", () => {
  // If someone deletes or renames clearAuthAndRedirect / logout, this test
  // catches the drift before the scans above silently pass against a
  // non-existent authorized site.
  const clientSrc = readFileSync(resolve(srcRoot, "api/client.ts"), "utf8");
  const authStoreSrc = readFileSync(resolve(srcRoot, "store/authStore.ts"), "utf8");
  assert.match(
    stripComments(clientSrc),
    /\bfunction\s+clearAuthAndRedirect\s*\(/,
    "api/client.ts no longer declares `clearAuthAndRedirect`. If renamed, update this contract's AUTHORIZED_CLEAR_TOKEN_SITES.",
  );
  assert.match(
    stripComments(authStoreSrc),
    /\blogout\s*:\s*\(/,
    "store/authStore.ts no longer declares a `logout:` zustand reducer. If renamed, update this contract's AUTHORIZED_CLEAR_TOKEN_SITES.",
  );
});
