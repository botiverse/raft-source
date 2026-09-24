import assert from "node:assert/strict";
import test from "node:test";
import { getAuthVerdict } from "../src/utils/authVerdict.js";

test("auth verdict treats refresh auth failures as terminal during restore", () => {
  const common = {
    initialized: true,
    restoreState: "restoring_auth" as const,
  };

  assert.equal(
    getAuthVerdict({
      ...common,
      signal: { type: "refresh_failed", status: 401, hasRefreshToken: true },
    }),
    "logout",
  );
  assert.equal(
    getAuthVerdict({
      ...common,
      signal: { type: "refresh_failed", status: undefined, hasRefreshToken: false },
    }),
    "logout",
  );
});

test("auth verdict defers post-refresh /auth/me auth failures during restore", () => {
  const common = {
    initialized: true,
    restoreState: "restoring_auth" as const,
  };

  assert.equal(
    getAuthVerdict({
      ...common,
      signal: { type: "post_refresh_me_failed", status: 401 },
    }),
    "defer-to-auth-restore",
  );
});

test("auth verdict allows hard logout after restore is settled", () => {
  const common = {
    initialized: true,
    restoreState: "authenticated" as const,
  };

  assert.equal(
    getAuthVerdict({
      ...common,
      signal: { type: "refresh_failed", status: 401, hasRefreshToken: true },
    }),
    "logout",
  );
  assert.equal(
    getAuthVerdict({
      ...common,
      signal: { type: "post_refresh_me_failed", status: 401 },
    }),
    "logout",
  );
});

test("auth verdict keeps session on transient failures", () => {
  assert.equal(
    getAuthVerdict({
      initialized: true,
      restoreState: "authenticated",
      signal: { type: "refresh_failed", status: 503, hasRefreshToken: true },
    }),
    "keep-session",
  );
});

// ── Weak-network ≠ logout regression matrix (#proj-frontend:78e0edb3, xxchan 6/17) ──
// xxchan: logout is likely tied to weak/dropped network. The invariant that must
// hold across ALL network conditions: a refresh (or post-refresh /auth/me) that
// fails WITHOUT a genuine auth rejection (401/403), while the user still holds a
// refresh token, is a transient/weak-network failure and MUST keep the session —
// a flaky downlink, timeout, aborted fetch, or 5xx must never sign the user out.
// `status: undefined` models a network error / aborted fetch / timeout with no
// HTTP response (the literal "断网/弱网" shape). Only 401/403, or no refresh
// token at all, is terminal.
test("weak-network refresh failures keep the session (only 401/403 or no-token are terminal)", () => {
  const base = { initialized: true, restoreState: "authenticated" as const };
  // No HTTP response (network error / aborted / timeout) + every non-auth status.
  const transientStatuses: (number | undefined)[] = [undefined, 0, 408, 425, 429, 500, 502, 503, 504];
  for (const status of transientStatuses) {
    assert.equal(
      getAuthVerdict({ ...base, signal: { type: "refresh_failed", status, hasRefreshToken: true } }),
      "keep-session",
      `refresh_failed status=${status} with a refresh token = transient/weak-network — must keep session, not logout`,
    );
  }
  for (const status of [401, 403]) {
    assert.equal(
      getAuthVerdict({ ...base, signal: { type: "refresh_failed", status, hasRefreshToken: true } }),
      "logout",
      `refresh_failed status=${status} is a genuine auth rejection — terminal`,
    );
  }
  // No refresh token = terminal regardless of status (nothing to retry with).
  assert.equal(
    getAuthVerdict({ ...base, signal: { type: "refresh_failed", status: undefined, hasRefreshToken: false } }),
    "logout",
    "no refresh token = terminal even on a network-shaped failure",
  );
});

// Same invariant on the post-refresh /auth/me leg: a weak-network failure after a
// successful token refresh must not log the user out either.
test("weak-network /auth/me failure after refresh keeps the session", () => {
  const base = { initialized: true, restoreState: "authenticated" as const };
  for (const status of [undefined, 0, 408, 429, 500, 503] as (number | undefined)[]) {
    assert.equal(
      getAuthVerdict({ ...base, signal: { type: "post_refresh_me_failed", status } }),
      "keep-session",
      `post_refresh_me_failed status=${status} is transient — must keep session, not logout`,
    );
  }
});
