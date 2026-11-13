import api from "../api/client";
import { runTestNotification } from "../notifications/notificationApi";
import type { TestNotificationOutcome } from "../notifications/notificationApi";
import { resolveNotificationChannel } from "./notificationChannel";
import { mayUseServiceWorker } from "./offlineBundleHost";
import {
  buildPushSubscribeFailure,
  clearPushSubscribeFailure,
  rememberPushSubscribeFailure,
} from "./pushSubscribeFailure";
import type { PushSubscribeFailureKind } from "./pushSubscribeFailure";

const SERVICE_WORKER_PATH = "/sw.js";
// Set by an explicit Disable; only an explicit Enable clears it. While set,
// nothing subscribes this browser on its own (design §8: a disabled browser
// came back subscribed on the next focus).
export const WEB_PUSH_OPT_OUT_KEY = "raft.webPush.optOut";
// The endpoint this browser last reported to the server (POST /push/subscribe):
// a different one at start means the push service rotated it.
export const WEB_PUSH_ENDPOINT_KEY = "raft.webPush.endpoint";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (hardened/private browsing); the next start re-checks.
  }
}

export function isWebPushOptedOut(): boolean {
  return readStorage(WEB_PUSH_OPT_OUT_KEY) === "1";
}

export function rememberedPushEndpoint(): string | null {
  return readStorage(WEB_PUSH_ENDPOINT_KEY) || null;
}

export function rememberPushEndpoint(endpoint: string | null): void {
  writeStorage(WEB_PUSH_ENDPOINT_KEY, endpoint);
}
export type WebPushPromptEvent =
  | "web_push_prompt_shown"
  | "web_push_native_result"
  | "web_push_subscription_saved"
  | "web_push_subscription_failed"
  // The composer banner closed with Dismiss, and its confirmation's link to
  // Settings › Notifications (cindyz, #proj-analytics:fbb8f05c).
  | "web_push_prompt_dismissed"
  | "web_push_prompt_settings_opened"
  // Settings › Notifications › This device: push turned off (`result` ok /
  // error) and Send test notification's answer (`result` the outcome state).
  | "web_push_disabled"
  | "web_push_test_result";

export async function recordWebPushPromptEvent(input: {
  event: WebPushPromptEvent;
  trigger: string;
  result?: string;
  permissionBefore?: string;
  permissionAfter?: string;
  detail?: string;
}) {
  try {
    await api.post("/push/prompt-events", input);
  } catch {
    // Instrumentation must never block the permission flow.
  }
}

// True only where Web Push can actually work (see notificationChannel.ts). In
// the Raft Desktop shell this is false even though serviceWorker/PushManager/
// Notification exist: its app:// origin cannot register a service worker and the
// desktop delivers OS notifications natively instead (task #93).
export function supportsPushNotifications(): boolean {
  return resolveNotificationChannel().kind === "web-push";
}

export function getPushPermissionState(): NotificationPermission | "unsupported" {
  if (!supportsPushNotifications()) return "unsupported";
  return Notification.permission;
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  // A page loaded from an offline bundle has no worker: the host serves its files.
  if (!mayUseServiceWorker()) return null;
  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
    void registration.update().catch(() => {});
    return registration;
  } catch (err) {
    console.error("[Push] Failed to register service worker:", err);
    return null;
  }
}

// Throws when the lookup itself fails (SecurityError on origins/schemes that
// can't host a service worker, blocked site storage). Callers decide what a
// failed lookup means: a read-only probe degrades to "not subscribed"; a
// mutation (disable) must report failure, not "nothing to do" (task #93 review).
export async function getExistingRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = (await navigator.serviceWorker.getRegistration("/")) || null;
  if (registration) {
    void registration.update().catch(() => {});
  }
  return registration;
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  let existing: ServiceWorkerRegistration | null = null;
  try {
    existing = await getExistingRegistration();
  } catch (err) {
    console.warn("[Push] Service worker registration lookup failed:", err);
  }
  return existing || registerPushServiceWorker();
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const { data } = await api.get("/push/vapid-key");
    return data.publicKey || null;
  } catch {
    return null;
  }
}

export async function isPushServerConfigured(): Promise<boolean> {
  return !!(await fetchVapidPublicKey());
}

export function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * The subscription was made with another key than the server's current VAPID
 * key (design §9.1): pushes to it would fail. An unknown key (no
 * `options.applicationServerKey`) counts as the same.
 */
export function subscriptionKeyDiffers(subscription: PushSubscription, vapidKey: string): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  let expected: Uint8Array;
  try {
    expected = urlBase64ToUint8Array(vapidKey);
  } catch {
    return false;
  }
  const actual = new Uint8Array(current);
  if (actual.length !== expected.length) return true;
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) return true;
  }
  return false;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!supportsPushNotifications()) return false;
  try {
    const registration = await getExistingRegistration();
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch (err) {
    // Never throw: callers (settings card, activation banner) await this inside
    // state refreshes that must always settle (task #93).
    console.warn("[Push] Subscription lookup failed:", err);
    return false;
  }
}

/** This browser's push endpoint, or null (not subscribed, unsupported, lookup failed). Never throws. */
export async function getPushSubscriptionEndpoint(): Promise<string | null> {
  if (!supportsPushNotifications()) return null;
  try {
    const registration = await getExistingRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    return subscription?.endpoint || null;
  } catch {
    return null;
  }
}

export async function subscribeWithVapidKey(registration: ServiceWorkerRegistration, vapidKey: string): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
  });
}

/** POST /push/subscribe; `oldEndpoint` replaces that subscription on the server (contract §3.2). Throws on failure. */
export async function reportPushSubscription(subscription: PushSubscription, oldEndpoint?: string | null): Promise<void> {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  await api.post("/push/subscribe", {
    endpoint,
    keys: {
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    },
    ...(oldEndpoint && oldEndpoint !== endpoint ? { oldEndpoint } : {}),
  });
  rememberPushEndpoint(endpoint);
}

/** DELETE /push/subscribe for an endpoint. Throws on failure. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await api.delete("/push/subscribe", { data: { endpoint } });
  if (rememberedPushEndpoint() === endpoint) rememberPushEndpoint(null);
}

export type EnablePushResult = NotificationPermission | "unsupported" | "unavailable" | "error";

async function subscribeAndSave(options: {
  requestPermission: boolean;
  respectOptOut: boolean;
  /** Called once `Notification.requestPermission` has resolved (the request ran at all). */
  onPermissionAsked?: () => void;
}): Promise<EnablePushResult | "opted_out"> {
  const permission = getPushPermissionState();
  if (permission === "unsupported") return permission;

  const fail = (kind: PushSubscribeFailureKind, error?: unknown) => {
    rememberPushSubscribeFailure(buildPushSubscribeFailure({
      kind,
      error,
      permission: getPushPermissionState(),
      endpoint: rememberedPushEndpoint(),
    }));
  };

  const vapidKey = await fetchVapidPublicKey();
  if (!vapidKey) {
    fail("vapid_unavailable");
    return "unavailable";
  }

  let resolvedPermission: NotificationPermission = permission;
  if (permission !== "granted") {
    if (!options.requestPermission) return permission;
    resolvedPermission = await Notification.requestPermission();
    options.onPermissionAsked?.();
  }
  if (resolvedPermission !== "granted") return resolvedPermission;

  const registration = await ensureRegistration();
  if (!registration) {
    fail("service_worker");
    return "error";
  }

  let step: PushSubscribeFailureKind = "push_subscribe";
  try {
    let subscription = await registration.pushManager.getSubscription();
    let oldEndpoint: string | null = rememberedPushEndpoint();
    // Made with another VAPID key: pushes to it fail, so replace it.
    if (subscription && subscriptionKeyDiffers(subscription, vapidKey)) {
      oldEndpoint = subscription.endpoint;
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await subscribeWithVapidKey(registration, vapidKey);
    }
    // Disabled while this was in flight: the user's last word wins.
    if (options.respectOptOut && isWebPushOptedOut()) {
      await subscription.unsubscribe().catch(() => false);
      return "opted_out";
    }
    step = "report";
    await reportPushSubscription(subscription, oldEndpoint);
    clearPushSubscribeFailure();
    return "granted";
  } catch (err) {
    console.error("[Push] Failed to enable push notifications:", err);
    fail(step, err);
    return "error";
  }
}

/** The user pressed Enable: clears the opt-out, asks for permission if needed, subscribes and reports. */
export async function enablePushNotifications(options: { onPermissionAsked?: () => void } = {}): Promise<EnablePushResult> {
  if (!supportsPushNotifications()) return "unsupported";
  writeStorage(WEB_PUSH_OPT_OUT_KEY, null);
  const result = await subscribeAndSave({ requestPermission: true, respectOptOut: false, onPermissionAsked: options.onPermissionAsked });
  return result === "opted_out" ? "error" : result;
}

/**
 * The automatic path (permission already granted, no subscription): subscribes
 * unless the user disabled push here. Never asks for permission.
 */
export async function ensurePushSubscriptionIfAllowed(): Promise<EnablePushResult | "opted_out"> {
  if (!supportsPushNotifications()) return "unsupported";
  if (isWebPushOptedOut()) return "opted_out";
  return subscribeAndSave({ requestPermission: false, respectOptOut: true });
}

export async function disablePushNotifications(): Promise<boolean> {
  if (!supportsPushNotifications()) return false;
  // First, so nothing running meanwhile (a focus, another tab) subscribes again.
  writeStorage(WEB_PUSH_OPT_OUT_KEY, "1");

  try {
    const registration = await getExistingRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    const remembered = rememberedPushEndpoint();
    if (!subscription) {
      if (remembered) {
        await deletePushSubscription(remembered).catch(() => {});
        rememberPushEndpoint(null);
      }
      return true;
    }

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await deletePushSubscription(endpoint);
    if (remembered && remembered !== endpoint) await deletePushSubscription(remembered).catch(() => {});
    rememberPushEndpoint(null);
    return true;
  } catch (err) {
    console.error("[Push] Failed to disable push notifications:", err);
    return false;
  }
}

/** Sends a test notification to this browser's subscription and waits for the service worker's ack (contract §6). */
export async function runWebTestNotification(): Promise<TestNotificationOutcome | { state: "failed"; reason: "not_subscribed" }> {
  const endpoint = await getPushSubscriptionEndpoint();
  if (!endpoint) return { state: "failed", reason: "not_subscribed" };
  return runTestNotification({ kind: "web", endpoint });
}
