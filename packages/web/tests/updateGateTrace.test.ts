import assert from "node:assert/strict";
import test from "node:test";
import {
  __setUpdateGateTraceEmittersForTest,
  reportUpdateGateDecision,
  reportUpdateGateDecisionBeforeUnload,
  updateGateDecisionAttrs,
} from "../src/utils/updateGateTrace";

test("update-gate decisions are closed and contain no raw failure material", () => {
  const attrs = updateGateDecisionAttrs({
    action: "recovery_finished",
    reason: "cleanup_partial_failure",
    triggerSource: "error_boundary",
    cleanupFailureCount: 2,
    serviceWorkerCount: 1,
    assetCacheCount: 3,
  });
  assert.deepEqual(attrs, {
    eventKind: "decision",
    outcome: "decided",
    action: "recovery_finished",
    reason: "cleanup_partial_failure",
    triggerSource: "error_boundary",
    cleanupFailureCount: 2,
    serviceWorkerCount: 1,
    assetCacheCount: 3,
  });
  const serialized = JSON.stringify(attrs);
  assert.doesNotMatch(serialized, /message|stack|https?:|\/Users|chunk name|token/i);
});

test("update-gate reporter uses ordinary and before-unload trace transports", async () => {
  const records: Array<{ mode: string; name: string; attrs: Record<string, unknown> }> = [];
  __setUpdateGateTraceEmittersForTest({
    emit: ((name, attrs) => { records.push({ mode: "normal", name, attrs }); }) as never,
    emitBeforeUnload: (async (name, attrs) => { records.push({ mode: "urgent", name, attrs }); }) as never,
  });
  reportUpdateGateDecision({
    action: "detected",
    reason: "dynamic_import_failure",
    triggerSource: "vite_preload_error",
  });
  await reportUpdateGateDecisionBeforeUnload({
    action: "recovery_finished",
    reason: "cleanup_completed",
    triggerSource: "vite_preload_error",
    cleanupFailureCount: 0,
  });
  __setUpdateGateTraceEmittersForTest(null);

  assert.deepEqual(records.map(({ mode, name, attrs }) => ({ mode, name, action: attrs.action })), [
    { mode: "normal", name: "slock.update_gate.decision", action: "detected" },
    { mode: "urgent", name: "slock.update_gate.decision", action: "recovery_finished" },
  ]);
});

test("update-gate decisions reject invalid enum pairs and hostile values without emitting", () => {
  assert.throws(() => updateGateDecisionAttrs({
    action: "detected",
    reason: "user_recover",
    triggerSource: "vite_preload_error",
  }));
  assert.throws(() => updateGateDecisionAttrs({
    action: "recovery_finished",
    reason: "cleanup_completed",
    triggerSource: "private-user-value",
  } as never));

  const records: unknown[] = [];
  __setUpdateGateTraceEmittersForTest({
    emit: ((...args: unknown[]) => { records.push(args); }) as never,
  });
  assert.doesNotThrow(() => reportUpdateGateDecision({
    action: "detected",
    reason: "user_recover",
    triggerSource: "vite_preload_error",
  }));
  __setUpdateGateTraceEmittersForTest(null);
  assert.equal(records.length, 0);
});
