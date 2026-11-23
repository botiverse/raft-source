// Enable, recorded (web_push_prompt_events): the composer banner's button and
// Settings › Notifications › This device go through this one path, told apart
// by `trigger`, so the two halves of the funnel count the same way. The
// banner's automatic re-subscribe is recorded here too.
import {
  enablePushNotifications,
  ensurePushSubscriptionIfAllowed,
  getPushPermissionState,
  isPushSubscribed,
  recordWebPushPromptEvent,
  rememberedPushEndpoint,
} from "./pushNotifications";
import type { EnablePushResult } from "./pushNotifications";
import {
  buildPushSubscribeFailure,
  pushSubscribeFailureDetail,
  rememberPushSubscribeFailure,
  shouldAutoRetryPushSubscribe,
  subscriptionFailedDetail,
} from "./pushSubscribeFailure";
import type { PushSubscribeFailure } from "./pushSubscribeFailure";

/** One automatic re-subscribe at a time across this browser's tabs. */
export const WEB_PUSH_AUTO_RESUBSCRIBE_LOCK = "raft.webPush.autoResubscribe";

type IfAvailableLockManager = {
  request: <T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>) => Promise<T>;
};

function lockManager(): IfAvailableLockManager | null {
  const nav = globalThis.navigator as (Navigator & { locks?: IfAvailableLockManager }) | undefined;
  return typeof nav?.locks?.request === "function" ? nav.locks : null;
}

/**
 * The banner's automatic re-subscribe (permission already granted), recorded:
 * subscribes when this browser has no subscription and the retry guard
 * allows it (shouldAutoRetryPushSubscribe), then records
 * `web_push_subscription_saved` or `_failed`. Several tabs focused together
 * would each fail and count the same failure into the streak: while another
 * tab holds the Web Lock this one skips, and the holder checks again inside
 * it. Without Web Locks, every tab tries as before. Never throws.
 */
export async function autoResubscribeAndRecord(trigger: string): Promise<void> {
  const locks = lockManager();
  if (!locks) {
    await autoResubscribeAttempt(trigger);
    return;
  }
  let ran = false;
  try {
    await locks.request(WEB_PUSH_AUTO_RESUBSCRIBE_LOCK, { ifAvailable: true }, async (lock) => {
      ran = true;
      if (lock) await autoResubscribeAttempt(trigger);
    });
  } catch {
    // The lock request itself was refused (e.g. an opaque origin): try as before.
    if (!ran) await autoResubscribeAttempt(trigger);
  }
}

async function autoResubscribeAttempt(trigger: string): Promise<void> {
  try {
    if (await isPushSubscribed()) return;
    // A re-subscribe that already failed here is not retried (or re-logged)
    // on every focus: only once permission, the endpoint or the signed-in
    // person changed, the (doubling) backoff passed, or the user pressed
    // Enable.
    if (!shouldAutoRetryPushSubscribe({ permission: "granted", endpoint: rememberedPushEndpoint() })) return;
    // Never re-subscribes a browser the user disabled push in (design §8);
    // only Enable clears that.
    let failure: PushSubscribeFailure | null = null;
    const result = await ensurePushSubscriptionIfAllowed({ onFailure: (stored) => { failure = stored; } });
    if (result === "opted_out") return;
    void recordWebPushPromptEvent({
      event: result === "granted" ? "web_push_subscription_saved" : "web_push_subscription_failed",
      trigger,
      result,
      permissionBefore: "granted",
      permissionAfter: getPushPermissionState(),
      ...(result === "granted" ? {} : { detail: subscriptionFailedDetail(failure, result) }),
    });
  } catch (err) {
    const failure = rememberPushSubscribeFailure(buildPushSubscribeFailure({
      kind: "unexpected",
      error: err,
      permission: "granted",
      endpoint: rememberedPushEndpoint(),
    }));
    void recordWebPushPromptEvent({
      event: "web_push_subscription_failed",
      trigger,
      result: "error",
      permissionBefore: "granted",
      permissionAfter: getPushPermissionState(),
      detail: pushSubscribeFailureDetail(failure),
    });
  }
}

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
  let failure: PushSubscribeFailure | null = null;
  let result: EnablePushResult;
  try {
    result = await enablePushNotifications({
      onPermissionAsked: () => { asked = true; },
      onFailure: (stored) => { failure = stored; },
    });
  } catch (err) {
    result = "error";
    failure = rememberPushSubscribeFailure(buildPushSubscribeFailure({
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
    void recordWebPushPromptEvent({
      event: "web_push_subscription_failed",
      trigger,
      result,
      permissionBefore,
      permissionAfter,
      detail: subscriptionFailedDetail(failure, result),
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
