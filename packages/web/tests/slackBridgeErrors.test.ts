import assert from "node:assert/strict";
import { slackBridgeErrorMessageId } from "../src/components/settings/slackBridgeErrors";

function httpError(data: unknown) { return { isAxiosError: true, response: { data } }; }

test("known setup reasons retain precise recovery copy, including legacy servers without reasons", () => {
  for (const [reason, key] of [
    ["privacy_mismatch", "privacyMismatch"], ["not_member", "notMember"],
    ["channel_unavailable", "channelUnavailable"], ["provider_unavailable", "providerUnavailable"],
  ]) {
    assert.equal(slackBridgeErrorMessageId(httpError({ code: "external_app_invalid_state", reason })), `settings.slackBridge.failure.${key}`);
  }
  for (const [code, key] of [
    ["external_app_invalid_state", "invalidState"], ["external_app_not_authorized", "notAuthorized"],
    ["external_app_workspace_mismatch", "workspaceMismatch"],
    ["external_app_install_conflict", "installConflict"], ["external_app_scope_mismatch", "scopeMismatch"],
  ]) assert.equal(slackBridgeErrorMessageId(httpError({ code })), `settings.slackBridge.failure.${key}`);
});

test("malformed or unexpected HTTP details and transport errors never become UI text", () => {
  for (const data of [null, "secret provider response", { code: "<script>secret</script>" }, { reason: "not_member" }]) {
    assert.equal(slackBridgeErrorMessageId(httpError(data)), "settings.slackBridge.operationFailed");
  }
  assert.equal(slackBridgeErrorMessageId(new Error("secret transport detail")), "settings.slackBridge.operationFailed");
  assert.equal(slackBridgeErrorMessageId(httpError({ code: "external_app_invalid_state", reason: "secret reason" })), "settings.slackBridge.failure.invalidState");
});
