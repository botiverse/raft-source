import assert from "node:assert/strict";
import test from "node:test";
import {
  getLiveSessionRecoveryPlan,
  planStatusReconcile,
  shouldRecoverAuthOnBrowserSignal,
} from "../src/utils/browserRecoveryPolicy.js";

test("foreground + online retries auth restore when a stored session is still restorable", () => {
  assert.equal(
    shouldRecoverAuthOnBrowserSignal({
      visible: true,
      online: true,
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: true,
    }),
    true,
  );
});

test("offline foreground does not eagerly retry auth restore", () => {
  assert.equal(
    shouldRecoverAuthOnBrowserSignal({
      visible: true,
      online: false,
      initialized: true,
      restoreState: "restoring_auth",
      hasStoredSession: true,
    }),
    false,
  );
});

test("live session recovery reconnects socket and reloads data when returning visible online", () => {
  assert.deepEqual(
    getLiveSessionRecoveryPlan({
      visible: true,
      online: true,
      hasStoredSession: true,
      socketConnected: false,
    }),
    {
      reconnectSocket: true,
      reloadLiveData: true,
    },
  );
});

test("live session recovery avoids reconnect churn while still offline", () => {
  assert.deepEqual(
    getLiveSessionRecoveryPlan({
      visible: true,
      online: false,
      hasStoredSession: true,
      socketConnected: false,
    }),
    {
      reconnectSocket: false,
      reloadLiveData: false,
    },
  );
});

test("visible online session still reloads data even when the socket already looks connected", () => {
  assert.deepEqual(
    getLiveSessionRecoveryPlan({
      visible: true,
      online: true,
      hasStoredSession: true,
      socketConnected: true,
    }),
    {
      reconnectSocket: false,
      reloadLiveData: true,
    },
  );
});

// planStatusReconcile — CC-006 client-side defense-in-depth periodic status
// reconcile. Only the "active tab + live socket + latched status" gap (the case
// focus-refetch and the heartbeat breaker do not cover).

test("planStatusReconcile reconciles a visible, online, session-backed tab with a live socket", () => {
  assert.deepEqual(
    planStatusReconcile({ visible: true, online: true, hasStoredSession: true, socketConnected: true }),
    { reconcile: true },
  );
});

test("planStatusReconcile skips a hidden tab (visibility-regain already reconciles)", () => {
  assert.deepEqual(
    planStatusReconcile({ visible: false, online: true, hasStoredSession: true, socketConnected: true }),
    { reconcile: false },
  );
});

test("planStatusReconcile skips when offline", () => {
  assert.deepEqual(
    planStatusReconcile({ visible: true, online: false, hasStoredSession: true, socketConnected: true }),
    { reconcile: false },
  );
});

test("planStatusReconcile skips without a stored session", () => {
  assert.deepEqual(
    planStatusReconcile({ visible: true, online: true, hasStoredSession: false, socketConnected: true }),
    { reconcile: false },
  );
});

test("planStatusReconcile skips when the socket is down (reconnect path owns that case)", () => {
  assert.deepEqual(
    planStatusReconcile({ visible: true, online: true, hasStoredSession: true, socketConnected: false }),
    { reconcile: false },
  );
});
