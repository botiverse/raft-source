import assert from "node:assert/strict";
import { normalizeSpawnFailureActivityDiagnostic } from "./spawnFailureActivityDiagnostic";

describe("normalizeSpawnFailureActivityDiagnostic (task #1123)", () => {
  test("accepts every closed-enum reason and keeps model only for model_not_found", () => {
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "model_not_found", model: "claude-opus-5" }), { reason: "model_not_found", model: "claude-opus-5" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", model: "ignored" }), { reason: "runtime_not_found" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_spawn_failed" }), { reason: "runtime_spawn_failed" });
    // Reconciler step 12: an unsupported model names the model; a repeated failure names none.
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "model_unsupported", model: "gpt-x" }), { reason: "model_unsupported", model: "gpt-x" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_repeated_failure", model: "gpt-x" }), { reason: "runtime_repeated_failure" });
  });
  test("autoRestartPaused is the server's verdict: dropped from a daemon frame, kept on a server read-back", () => {
    const paused = { reason: "model_not_found", model: "deepseek/deepseek-v4-flash", autoRestartPaused: true };
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic(paused), { reason: "model_not_found", model: "deepseek/deepseek-v4-flash" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic(paused, { source: "server" }), paused);
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_spawn_failed", autoRestartPaused: "yes" }, { source: "server" }), { reason: "runtime_spawn_failed" });
  });
  test("pauseRetryAtMs is the server's too: dropped from a daemon frame, kept on a server read-back of a self-retrying pause only", () => {
    const retryAt = 1_800_000_000_000;
    // A daemon frame cannot name a retry time, with or without a pause verdict.
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_repeated_failure", pauseRetryAtMs: retryAt }), { reason: "runtime_repeated_failure" });
    assert.deepEqual(
      normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_repeated_failure", autoRestartPaused: true, pauseRetryAtMs: retryAt }),
      { reason: "runtime_repeated_failure" },
    );
    // The server's own paused-for-retry verdict keeps it.
    for (const reason of ["runtime_repeated_failure", "runtime_start_timeout"]) {
      assert.deepEqual(
        normalizeSpawnFailureActivityDiagnostic({ reason, autoRestartPaused: true, pauseRetryAtMs: retryAt }, { source: "server" }),
        { reason, autoRestartPaused: true, pauseRetryAtMs: retryAt },
        reason,
      );
    }
    // Absent otherwise: no pause verdict, a pause only a person lifts, or not an epoch-ms integer.
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_repeated_failure", pauseRetryAtMs: retryAt }, { source: "server" }), { reason: "runtime_repeated_failure" });
    assert.deepEqual(
      normalizeSpawnFailureActivityDiagnostic({ reason: "model_unsupported", autoRestartPaused: true, pauseRetryAtMs: retryAt }, { source: "server" }),
      { reason: "model_unsupported", autoRestartPaused: true },
    );
    for (const bad of ["soon", 1.5, -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(
        normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_repeated_failure", autoRestartPaused: true, pauseRetryAtMs: bad }, { source: "server" }),
        { reason: "runtime_repeated_failure", autoRestartPaused: true },
        String(bad),
      );
    }
  });
  test("task #1242: lookupReason passes only with runtime_not_found and only as a known verdict", () => {
    for (const lookupReason of ["not_on_path", "lookup_timed_out", "lookup_permission_denied", "lookup_failed"]) {
      assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", lookupReason }), { reason: "runtime_not_found", lookupReason });
    }
    // Unknown verdicts and wrong types are dropped, never echoed; the frame itself stays valid.
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", lookupReason: "disk_full" }), { reason: "runtime_not_found" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", lookupReason: 7 }), { reason: "runtime_not_found" });
    // Other reasons never carry it.
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_spawn_failed", lookupReason: "not_on_path" }), { reason: "runtime_spawn_failed" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "model_not_found", model: "m", lookupReason: "not_on_path" }), { reason: "model_not_found", model: "m" });
    // A server read-back keeps it beside the server's own verdict.
    assert.deepEqual(
      normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", lookupReason: "lookup_timed_out", autoRestartPaused: true }, { source: "server" }),
      { reason: "runtime_not_found", lookupReason: "lookup_timed_out", autoRestartPaused: true },
    );
  });
  test("rejects unknown reasons, non-objects, and unbounded or non-string models", () => {
    for (const bad of [null, undefined, "model_not_found", 42, [], {}, { reason: "disk_full" }, { reason: "model_not_found", model: 7 }, { reason: "model_not_found", model: "" }, { reason: "model_not_found", model: "x".repeat(129) }]) {
      assert.equal(normalizeSpawnFailureActivityDiagnostic(bad as never), null, JSON.stringify(bad));
    }
  });
});

test("task #1307: provider_api_key_invalid passes through as a bare reason; a model or other field is dropped, not echoed", () => {
  assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "provider_api_key_invalid" }), { reason: "provider_api_key_invalid" });
  assert.deepEqual(
    normalizeSpawnFailureActivityDiagnostic({ reason: "provider_api_key_invalid", model: "m", keyName: "ANTHROPIC_API_KEY" } as Record<string, unknown>),
    { reason: "provider_api_key_invalid" },
  );
});
