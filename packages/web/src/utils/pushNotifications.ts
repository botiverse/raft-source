import api from "../api/client";

const SERVICE_WORKER_PATH = "/sw.js";
export type WebPushPromptEvent =
  | "web_push_prompt_shown"
  | "web_push_native_result"
  | "web_push_subscription_saved"
  | "web_push_subscription_failed";

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

export function supportsPushNotifications(): boolean {
  return typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined";
}

export function getPushPermissionState(): NotificationPermission | "unsupported" {
  if (!supportsPushNotifications()) return "unsupported";
  return Notification.permission;
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
    void registration.update().catch(() => {});
    return registration;
  } catch (err) {
    console.error("[Push] Failed to register service worker:", err);
    return null;
  }
}

async function getExistingRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = (await navigator.serviceWorker.getRegistration("/")) || null;
  if (registration) {
    void registration.update().catch(() => {});
  }
  return registration;
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (await getExistingRegistration()) || registerPushServiceWorker();
}

async function fetchVapidPublicKey(): Promise<string | null> {
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

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!supportsPushNotifications()) return false;
  const registration = await getExistingRegistration();
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  return !!subscription;
}

export async function enablePushNotifications(): Promise<NotificationPermission | "unsupported" | "unavailable" | "error"> {
  const permission = getPushPermissionState();
  if (permission === "unsupported") return permission;

  const vapidKey = await fetchVapidPublicKey();
  if (!vapidKey) return "unavailable";

  const resolvedPermission = permission === "granted" ? permission : await Notification.requestPermission();
  if (resolvedPermission !== "granted") return resolvedPermission;

  const registration = await ensureRegistration();
  if (!registration) return "error";

  try {
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }

    const json = subscription.toJSON();
    await api.post("/push/subscribe", {
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      },
    });
    return "granted";
  } catch (err) {
    console.error("[Push] Failed to enable push notifications:", err);
    return "error";
  }
}

export async function disablePushNotifications(): Promise<boolean> {
  if (!supportsPushNotifications()) return false;

  try {
    const registration = await getExistingRegistration();
    if (!registration) return true;

    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api.delete("/push/subscribe", { data: { endpoint } });
    return true;
  } catch (err) {
    console.error("[Push] Failed to disable push notifications:", err);
    return false;
  }
}

export async function sendTestPushNotification(): Promise<"ok" | "unsupported" | "unavailable" | "not_subscribed" | "error"> {
  if (!supportsPushNotifications()) return "unsupported";

  try {
    await api.post("/push/test");
    return "ok";
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 503) return "unavailable";
    if (status === 409) return "not_subscribed";
    console.error("[Push] Failed to send test push notification:", err);
    return "error";
  }
}
