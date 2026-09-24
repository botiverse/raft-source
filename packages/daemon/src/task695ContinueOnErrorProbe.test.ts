// task #695 persistent positive control for the full unit-daemon gate. It stays
// skipped in ordinary PR/push/scheduled runs and fails only when the manual
// workflow input is explicitly enabled. One-command SOP (replace <ref>):
//   gh workflow run test.yml --ref <ref> -f unit_daemon_failure_probe=true
// Expected: unit-daemon reports raw outcome=failure and unit-daemon-gate is RED.
import { test } from "vitest";
import assert from "node:assert/strict";

test(
  "task695 probe: deliberately failing daemon test (see task #695)",
  { skip: process.env.TASK695_FAILURE_PROBE !== "1" },
  () => {
    assert.equal("observer-can-go-red", "PROBE_INTENTIONAL_FAILURE");
  },
);
