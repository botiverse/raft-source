// Enable, recorded (web_push_prompt_events): the composer banner's button and
// Settings › Notifications › This device go through this one path, told apart
// by `trigger`, so the two halves of the funnel count the same way.
import {
  enablePushNotifications,
  getPushPermissionState,
  recordWebPushPromptEvent,
  rememberedPushEndpoint,
} from "./pushNotifications";
import type { EnablePushResult } from "./pushNotifications";
import {
  buildPushSubscribeFailure,
  pushSubscribeFailureDetail,
  readPushSubscribeFailure,
  rememberPushSubscribeFailure,
} from "./pushSubscribeFailure";

/**
 * Turns Web Push on and records it: `web_push_native_result` only when
 * permission started as `default` and the browser's permission request ran and
 * resolved (not when the server key was missing first, nor when permission was
 * already decided: a `denied` request resolves at once; it doesn't prove a
 * visible prompt), then
 * `web_push_subscription_saved` or `_failed` (with the failure's `detail`). A
 * throw counts as an `unexpected` failure, never an unhandled rejection.
 */
export async function enablePushAndRecord(trigger: string): Promise<EnablePushResult> {
  const permissionBefore = getPushPermissionState();
  let asked = false;
  let result: EnablePushResult;
  try {
    result = await enablePushNotifications({ onPermissionAsked: () => { asked = true; } });
  } catch (err) {
    result = "error";
    rememberPushSubscribeFailure(buildPushSubscribeFailure({
      kind: "unexpected",
      error: err,
      permission: getPushPermissionState(),
      endpoint: rememberedPushEndpoint(),
    }));
  }
  const permissionAfter = getPushPermissionState();
  if (asked && permissionBefore === "default") {
    void recordWebPushPromptEvent({ event: "web_push_native_result", trigger, result, permissionBefore, permissionAfter });
  }
  if (result === "granted") {
    void recordWebPushPromptEvent({ event: "web_push_subscription_saved", trigger, result, permissionBefore, permissionAfter });
  } else if (result === "unavailable" || result === "error") {
    const failure = readPushSubscribeFailure();
    void recordWebPushPromptEvent({
      event: "web_push_subscription_failed",
      trigger,
      result,
      permissionBefore,
      permissionAfter,
      ...(failure ? { detail: pushSubscribeFailureDetail(failure) } : {}),
    });
  }
  return result;
}

/**
 * Test notification failures as the fixed codes the log keeps (the client also
 * falls back to a server error string). The server keeps only these in
 * `detail` (PUSH_TEST_RESULT_DETAIL, routes/push.ts): change both together.
 */
const TEST_FAILURE_REASONS = new Set(["no_device", "provider_error", "provider_not_configured", "not_subscribed"]);

export function testFailureReasonCode(reason: string): string {
  return TEST_FAILURE_REASONS.has(reason) ? reason : "error";
}
