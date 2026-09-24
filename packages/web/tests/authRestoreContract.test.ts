import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveInitialAuthRestoreState,
  getAuthBootstrapView,
  hasAuthRestoreTimedOut,
  nextAuthRestoreState,
  nextAuthRestoreStateAfterExternalTokenSync,
  shouldRetryAuthRestore,
} from "../src/utils/authRestoreMachine.js";
import type {
  AuthRestoreState,
} from "../src/utils/authRestoreMachine.js";

test("boot without a stored session resolves to signed_out after initialization", () => {
  const state = nextAuthRestoreState(
    deriveInitialAuthRestoreState(false),
    { type: "BOOT", hasStoredSession: false },
  );

  assert.equal(state, "signed_out");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "signed_out",
  );
});

test("boot with a stored session enters restoring instead of signed_out", () => {
  const state = nextAuthRestoreState(
    deriveInitialAuthRestoreState(true),
    { type: "BOOT", hasStoredSession: true },
  );

  assert.equal(state, "restoring_auth");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "restoring",
  );
});

test("transient auth restore failure keeps the app in restoring and eligible for retry", () => {
  const state = nextAuthRestoreState("restoring_auth", {
    type: "RESTORE_TRANSIENT_FAILURE",
    hasStoredSession: true,
  });

  assert.equal(state, "restoring_auth");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "restoring",
  );
  assert.equal(
    shouldRetryAuthRestore({
      initialized: true,
      restoreState: state,
      hasStoredSession: true,
    }),
    true,
  );
});

test("successful auth restore transitions to ready", () => {
  const state = nextAuthRestoreState("restoring_auth", {
    type: "RESTORE_SUCCEEDED",
  });

  assert.equal(state, "authenticated");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "ready",
  );
});

test("hard auth failure transitions to signed_out and disables retry", () => {
  const state = nextAuthRestoreState("restoring_auth", {
    type: "LOGOUT",
  });

  assert.equal(state, "signed_out");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "signed_out",
  );
  assert.equal(
    shouldRetryAuthRestore({
      initialized: true,
      restoreState: state,
      hasStoredSession: true,
    }),
    false,
  );
});

test("login success and logout use explicit state transitions", () => {
  const authenticated = nextAuthRestoreState("signed_out", {
    type: "LOGIN_SUCCEEDED",
  });
  assert.equal(authenticated, "authenticated");

  const signedOut = nextAuthRestoreState(authenticated, { type: "LOGOUT" });
  assert.equal(signedOut, "signed_out");
});

test("external token sync does not regress an authenticated tab into restore", () => {
  const state = nextAuthRestoreStateAfterExternalTokenSync("authenticated");

  assert.equal(state, "authenticated");
  assert.equal(
    getAuthBootstrapView({ initialized: true, restoreState: state }),
    "ready",
  );
  assert.equal(
    shouldRetryAuthRestore({
      initialized: true,
      restoreState: state,
      hasStoredSession: true,
    }),
    false,
  );
});

test("external token sync starts restore only for tabs without authenticated user state", () => {
  assert.equal(nextAuthRestoreStateAfterExternalTokenSync("booting"), "restoring_auth");
  assert.equal(nextAuthRestoreStateAfterExternalTokenSync("signed_out"), "restoring_auth");
  assert.equal(nextAuthRestoreStateAfterExternalTokenSync("restoring_auth"), "restoring_auth");
});

test("booting always renders loading until initialization completes", () => {
  const state: AuthRestoreState = "booting";
  assert.equal(
    getAuthBootstrapView({ initialized: false, restoreState: state }),
    "loading",
  );
});

test("auth restore has a bounded retry window", () => {
  assert.equal(
    hasAuthRestoreTimedOut({
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: true,
      elapsedMs: 29_999,
    }),
    false,
  );
  assert.equal(
    hasAuthRestoreTimedOut({
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: true,
      elapsedMs: 30_000,
    }),
    true,
  );
});

test("auth restore timeout only applies to restorable sessions", () => {
  assert.equal(
    hasAuthRestoreTimedOut({
      initialized: true,
      restoreState: "authenticated",
      hasStoredSession: true,
      elapsedMs: 60_000,
    }),
    false,
  );
  assert.equal(
    hasAuthRestoreTimedOut({
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: false,
      elapsedMs: 60_000,
    }),
    false,
  );
});
