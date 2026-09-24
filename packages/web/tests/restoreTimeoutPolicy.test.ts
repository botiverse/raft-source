import { test } from "node:test";
import assert from "node:assert/strict";

import { getRestoreTimeoutAction } from "../src/utils/restoreTimeoutPolicy";
import { MAX_AUTH_RESTORE_MS } from "../src/utils/authRestoreMachine";
import type { AuthRestoreState } from "../src/utils/authRestoreMachine";

// Auth Session Contract (#2494) — "First Required Red Test" for the 30s
// restore-timeout root-cause candidate.
//
// Contract invariant: a restore timeout is transient evidence, NOT terminal.
// When a stored session exists and restore times out, the policy MUST NOT
// resolve to `logout` — the credential was not rejected, the restore was just
// slow. This locks the timeout policy as a pure oracle so App.tsx can route
// through it instead of calling authStore.logout() directly on a timer.

const OVER = MAX_AUTH_RESTORE_MS + 1;
const UNDER = MAX_AUTH_RESTORE_MS - 1;
const RESTORE_STATES: ReadonlyArray<AuthRestoreState> = ["booting", "signed_out", "restoring_auth", "authenticated"];

// ── The load-bearing contract assertion ──
test("restore timeout with a stored session must NOT logout (30s timeout is transient, not terminal)", () => {
  const action = getRestoreTimeoutAction({
    initialized: true,
    restoreState: "restoring_auth",
    hasStoredSession: true,
    elapsedMs: OVER,
  });
  assert.notEqual(action, "logout", "a timed-out restore with a valid stored session must never sign the user out");
  assert.equal(action, "degraded_retry", "it should degrade + stay retryable, preserving the session");
});

test("respects an explicit maxElapsedMs override and still refuses to logout a stored session", () => {
  const action = getRestoreTimeoutAction({
    initialized: true,
    restoreState: "restoring_auth",
    hasStoredSession: true,
    elapsedMs: 5_001,
    maxElapsedMs: 5_000,
  });
  assert.equal(action, "degraded_retry");
});

// ── Before timeout: keep restoring ──
test("before the timeout elapses, the action is continue_restore", () => {
  const action = getRestoreTimeoutAction({
    initialized: true,
    restoreState: "restoring_auth",
    hasStoredSession: true,
    elapsedMs: UNDER,
  });
  assert.equal(action, "continue_restore");
});

// ── Timed out but nothing to preserve: signed-out is correct ──
test("timeout with no stored session resolves to logout (no valid credential to preserve)", () => {
  const action = getRestoreTimeoutAction({
    initialized: true,
    restoreState: "restoring_auth",
    hasStoredSession: false,
    elapsedMs: OVER,
  });
  assert.equal(action, "logout");
});

// ── Only the restoring_auth + stored-session state is timeout-eligible ──
test("non-restoring states never time out into a clear, regardless of elapsed time", () => {
  for (const restoreState of RESTORE_STATES) {
    if (restoreState === "restoring_auth") continue;
    for (const hasStoredSession of [true, false]) {
      const action = getRestoreTimeoutAction({
        initialized: true,
        restoreState,
        hasStoredSession,
        elapsedMs: OVER,
      });
      assert.equal(
        action,
        "continue_restore",
        `restoreState=${restoreState} hasStoredSession=${hasStoredSession} is not timeout-eligible`,
      );
    }
  }
});

// ── Sweep: a stored session never resolves to logout on timeout ──
test("no timed-out restore with a stored session ever resolves to logout (contract sweep)", () => {
  for (const elapsedMs of [OVER, MAX_AUTH_RESTORE_MS, MAX_AUTH_RESTORE_MS * 10]) {
    const action = getRestoreTimeoutAction({
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: true,
      elapsedMs,
    });
    assert.notEqual(action, "logout", `elapsedMs=${elapsedMs} with a stored session must not logout`);
  }
});
