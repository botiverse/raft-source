import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecoveryDiagnostics,
  recoveryErrorCode,
  recoveryFailureFromError,
  scrubRecoveryDetail,
} from "./recoveryDiagnostics.js";

test("recovery diagnostics redacts secret-shaped values", () => {
  const detail = scrubRecoveryDetail(
    "failed key=sk_computer_abc123 token=eyJaaaaaaaaaaaaaaaaaaaaaaaaaaaa hex=0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(
    detail,
    "failed key=***REDACTED*** token=***REDACTED*** hex=***REDACTED***",
  );
});

test("recovery diagnostics includes visible code, action id, and scrubbed message", () => {
  const text = buildRecoveryDiagnostics({
    failedStep: "connect",
    errorCode: "WORKSPACES_FAILED",
    actionId: "action-123",
    message: "workspace list failed with sk_agent_secret",
  });
  assert.match(text, /failed_step=connect/);
  assert.match(text, /error_code=WORKSPACES_FAILED/);
  assert.match(text, /action_id=action-123/);
  assert.match(text, /message=workspace list failed with \*\*\*REDACTED\*\*\*/);
});

test("recovery error extraction preserves structured code when present", () => {
  const err = Object.assign(new Error("boom"), { code: "LOGIN_FAILED" });
  const failure = recoveryFailureFromError(err, "action-456", "fallback");
  assert.equal(failure.message, "boom");
  assert.equal(failure.errorCode, "LOGIN_FAILED");
  assert.equal(failure.actionId, "action-456");
  assert.equal(recoveryErrorCode(undefined), "UNKNOWN");
});
