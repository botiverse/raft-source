import assert from "node:assert/strict";
import { test } from "vitest";
import {
  adaptDaemonActivityLifecycleEvent,
  normalizeRuntimeErrorActivityDiagnostic,
} from "./legacyAgentLifecycleAdapter.js";

const fingerprint = "a".repeat(16);

test("daemon runtime-error carrier becomes a canonical classified lifecycle event", () => {
  const { event } = adaptDaemonActivityLifecycleEvent({
    serverId: "server-1",
    agentId: "agent-1",
    machineId: "machine-1",
    launchId: "launch-1",
    clientSeq: 7,
    currentStatus: "active",
    resetMode: null,
    activity: "error",
    hasEntries: true,
    runtimeError: {
      errorClass: "RuntimeError",
      errorReason: "unclassified_runtime_error",
      fingerprint,
      reasonProvenance: "daemon_fallback",
      nativeReasonPresent: false,
    },
    now: () => new Date("2026-07-20T16:40:04.828Z"),
  });

  assert.equal(event.eventType, "runtime_crashed");
  assert.equal(event.reason, "runtime_crash");
  assert.deepEqual(event.attrs, {
    activity_status: "error",
    client_seq_present: true,
    current_status: "active",
    entries_present: true,
    reset_mode: null,
    source_protocol: "daemon_runtime_error_carrier_v1",
    native_reason_present: false,
    runtime_error_class: "RuntimeError",
    runtime_error_fingerprint: fingerprint,
    runtime_error_reason: "unclassified_runtime_error",
    runtime_error_reason_provenance: "daemon_fallback",
  });
});

test("runtime-error carrier is an explicit allowlist and rejects malformed required fields", () => {
  assert.deepEqual(normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "LauncherError",
    errorReason: "launcher_error",
    fingerprint,
    reasonProvenance: "runtime_error_event",
  }), {
    errorClass: "LauncherError",
    errorReason: "launcher_error",
    fingerprint,
    reasonProvenance: "runtime_error_event",
  });
  const normalized = normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "ProviderServerError",
    errorReason: "provider_server_error",
    fingerprint,
    reasonProvenance: "codex_native_reason",
    nativeReasonPresent: true,
    rawPayload: "Bearer secret-should-never-project",
    path: "/Users/alice/private",
    futureScalar: "must-not-pass-through",
  });
  assert.deepEqual(normalized, {
    errorClass: "ProviderServerError",
    errorReason: "provider_server_error",
    fingerprint,
    reasonProvenance: "codex_native_reason",
    nativeReasonPresent: true,
  });
  assert.equal(normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "ArbitraryCustomerException",
    errorReason: "unclassified_runtime_error",
    fingerprint,
    reasonProvenance: "runtime_error_event",
  }), null);
  assert.equal(normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "RuntimeError",
    errorReason: "unclassified_runtime_error",
    fingerprint: "not-a-fingerprint",
    reasonProvenance: "runtime_error_event",
  }), null);
  assert.equal(normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "AuthError",
    errorReason: "provider_timeout",
    fingerprint,
    reasonProvenance: "codex_native_reason",
    nativeReasonPresent: true,
  }), null);
  assert.equal(normalizeRuntimeErrorActivityDiagnostic({
    errorClass: "RuntimeError",
    errorReason: "unclassified_runtime_error",
    fingerprint,
    reasonProvenance: "daemon_fallback",
    nativeReasonPresent: true,
  }), null);
});
