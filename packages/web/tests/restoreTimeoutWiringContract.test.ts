import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Restore-timeout wiring contract (Auth Session Contract, #2494; oracle in
 * #2497 `restoreTimeoutPolicy.ts`).
 *
 * The App.tsx restore effect's timer-only branches MUST NOT call `logout()`
 * directly. A timer alone is TRANSIENT evidence (slow restore, weak network,
 * slow but valid `/auth/me`) and never authoritative grounds to clear a
 * stored session. All timer-only branches must route through
 * `getRestoreTimeoutAction(...)`; only the `"logout"` return value (no
 * stored session) calls `logout()`. Terminal logout is the loadUser /
 * getAuthVerdict path's authority alone.
 *
 * This is a source-scan regression guard mirroring `keydownFocusContract`
 * shape — narrow, mechanical, and pins the wiring against future refactor
 * drift. The behavioral invariant (stored-session timeout → degraded_retry,
 * no logout) is covered by the policy oracle's own unit test
 * (`tests/restoreTimeoutPolicy.test.ts`); this file only asserts the
 * App.tsx side actually consumes the oracle.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const appSource = readFileSync(resolve(repoRoot, "src/App.tsx"), "utf8");

test("App.tsx imports getRestoreTimeoutAction from restoreTimeoutPolicy", () => {
  // The oracle must be imported. If this fails, the restore effect almost
  // certainly is using the old `hasAuthRestoreTimedOut` + bare `logout()`
  // path instead of routing through the policy.
  assert.match(
    appSource,
    /import\s*\{\s*getRestoreTimeoutAction\s*\}\s*from\s*["']\.\/utils\/restoreTimeoutPolicy["']/,
  );
});

test("App.tsx restore effect routes all timer-only logout() calls through getRestoreTimeoutAction", () => {
  // Isolate the restore-retry effect body. Anchor on the unique comment
  // header at the start of the effect ("Mobile browsers can transiently
  // fail /auth/me during foreground restore.") — this string appears only
  // there, so the slice starts inside the effect rather than at the
  // import-section mention of `shouldRetryAuthRestore`. End at the next
  // useEffect closing `}, [`.
  const startIdx = appSource.indexOf("Mobile browsers can transiently fail");
  assert.ok(
    startIdx >= 0,
    "Restore effect not found — comment-header anchor missing. If renamed, update this test's anchor string.",
  );
  // The effect body ends at the dependency array of the useEffect call.
  // Look for the next `}, [` after the start.
  const endIdx = appSource.indexOf("}, [", startIdx);
  assert.ok(endIdx > startIdx, "Restore effect closing `}, [` not found");
  // Strip `//` line comments so doc-text mentions of `logout()` /
  // `getRestoreTimeoutAction` (in the policy explainer comment) don't
  // confuse the regex counters. Block `/* ... */` comments aren't used
  // mid-effect, so a line-level strip is sufficient.
  const effectBody = appSource
    .slice(startIdx, endIdx)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  // 1. Three timer branches each call getRestoreTimeoutAction(...).
  const oracleCalls = effectBody.match(/getRestoreTimeoutAction\(/g) ?? [];
  assert.ok(
    oracleCalls.length >= 3,
    `Restore effect must call getRestoreTimeoutAction at least 3 times (initial, retry, setTimeout); found ${oracleCalls.length}`,
  );

  // 2. Every `logout(...)` in the effect must be gated by an `action === "logout"`
  // check on the line above OR on the same conditional. Mechanical check:
  // every `logout(...)` occurrence must have `"logout"` appearing in the ~120
  // characters preceding it (the gate string). The call may carry a logoutTrigger
  // arg (L4 wiring: `logout("restore_timeout")`) — it must never fire
  // unconditionally outside the action gate.
  const logoutCalls = [...effectBody.matchAll(/\blogout\([^)]*\)/g)];
  assert.ok(
    logoutCalls.length >= 1,
    "Restore effect should still call logout(...) in the action==='logout' branch",
  );
  for (const m of logoutCalls) {
    const before = effectBody.slice(Math.max(0, m.index - 120), m.index);
    assert.match(
      before,
      /=== "logout"/,
      `logout() at index ${m.index} is not gated by an \`=== "logout"\` action check. Restore-timeout wiring must route through getRestoreTimeoutAction.`,
    );
  }

  // 3. Negative: the deprecated direct `hasAuthRestoreTimedOut(...)` check
  // immediately followed by `logout()` must NOT reappear in this effect.
  assert.doesNotMatch(
    effectBody,
    /hasAuthRestoreTimedOut\([\s\S]{0,200}?logout\(\)/,
    "Restore effect must not use the legacy `hasAuthRestoreTimedOut → logout()` pattern. Route through getRestoreTimeoutAction.",
  );
});

test("App.tsx no longer imports hasAuthRestoreTimedOut (oracle is the sole timeout authority)", () => {
  // After wiring, hasAuthRestoreTimedOut is the policy oracle's internal
  // comparison only — App.tsx must not import or call it. This makes the
  // policy oracle the sole timeout-decision authority for the restore
  // effect and prevents accidental dual-path drift.
  assert.doesNotMatch(
    appSource,
    /hasAuthRestoreTimedOut/,
    "App.tsx must not import or use hasAuthRestoreTimedOut — the timeout decision belongs to getRestoreTimeoutAction.",
  );
});
