import assert from "node:assert/strict";
import { test } from "vitest";
import { CREDENTIAL_INVALID_REASONS, parseCredentialRestoredMessage, RUNTIME_ERROR_REQUIRED_ACTIONS, type MachineToServerMessage } from "./index";

// #proj-raft-computer:#48 (reconciler step 4b): the daemon's
// `agent:credential:restored` frame, as the server reads it.

test("a restored frame is read with its reason, release cause and launch", () => {
  const frame: MachineToServerMessage = { type: "agent:credential:restored", agentId: "agent-1", reason: "user_reauth", releaseCause: "model_output", launchId: "launch-1" };
  assert.deepEqual(parseCredentialRestoredMessage(frame), { agentId: "agent-1", reason: "user_reauth", releaseCause: "model_output", launchId: "launch-1" });
  assert.deepEqual(
    parseCredentialRestoredMessage({ type: "agent:credential:restored", agentId: "agent-1", reason: "billing", releaseCause: "explicit_stop" }),
    { agentId: "agent-1", reason: "billing", releaseCause: "explicit_stop", launchId: null },
  );
});

test("a reason this build does not know is dropped (no block can match it); an unknown release cause still lifts, as other", () => {
  assert.equal(parseCredentialRestoredMessage({ type: "agent:credential:restored", agentId: "agent-1", reason: "quota", releaseCause: "model_output" }), null);
  assert.equal(parseCredentialRestoredMessage({ type: "agent:credential:restored", agentId: "", reason: "billing", releaseCause: "model_output" }), null);
  assert.equal(parseCredentialRestoredMessage({ type: "agent:runtime:ready", agentId: "agent-1", launchId: "launch-1" }), null);
  assert.equal(parseCredentialRestoredMessage(null), null);
  assert.deepEqual(
    parseCredentialRestoredMessage({ type: "agent:credential:restored", agentId: "agent-1", reason: "user_model_access", releaseCause: "rotated_by_admin" }),
    { agentId: "agent-1", reason: "user_model_access", releaseCause: "other", launchId: null },
  );
});

test("every runtime error's required action is a credential-invalid reason, so a block it sets can be lifted by a restored frame", () => {
  for (const action of RUNTIME_ERROR_REQUIRED_ACTIONS) assert.ok((CREDENTIAL_INVALID_REASONS as readonly string[]).includes(action), action);
});
