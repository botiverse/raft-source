// Keeps this browser's Web Push subscription and the server's record of it in
// step (design §9.1, §9.2; contract §3.2), with no user action:
// - permission no longer granted: DELETE the subscription on the server;
// - disabled here (opt-out): no subscription is left behind;
// - made with an old VAPID key (checked at start): subscribe again;
// - rotated by the push service (pushsubscriptionchange, or an endpoint other
//   than the one last reported): POST /push/subscribe {oldEndpoint}.
// Runs at start, on window focus and when the page becomes visible.

import {
  deletePushSubscription,
  fetchVapidPublicKey,
  getExistingRegistration,
  isWebPushOptedOut,
  rememberedPushEndpoint,
  rememberPushEndpoint,
  reportPushSubscription,
  subscribeWithVapidKey,
  subscriptionKeyDiffers,
  supportsPushNotifications,
} from "../utils/pushNotifications";

/** Written by public/sw.js on pushsubscriptionchange (the worker has no bearer token). */
export const WEB_PUSH_CLIENT_STATE_CACHE = "raft-client-state-v1";
export const WEB_PUSH_SUBSCRIPTION_CHANGE_KEY = "/__raft/push-subscription-change";
export const WEB_PUSH_SUBSCRIPTION_CHANGED_MESSAGE = "RAFT_PUSH_SUBSCRIPTION_CHANGED";

export type WebPushReconcileTrigger = "start" | "focus" | "visible" | "subscription_changed";

export type WebPushReconcileResult =
  | "unsupported"
  | "lookup_failed"
  | "nothing"
  | "revoked"
  | "opted_out"
  | "resubscribed"
  | "reported"
  | "in_sync"
  | "error";

async function readPendingOldEndpoint(): Promise<string | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(WEB_PUSH_CLIENT_STATE_CACHE);
    const response = await cache.match(WEB_PUSH_SUBSCRIPTION_CHANGE_KEY);
    if (!response) return null;
    const value: unknown = await response.json();
    const oldEndpoint = value && typeof value === "object" ? (value as { oldEndpoint?: unknown }).oldEndpoint : null;
    return typeof oldEndpoint === "string" && oldEndpoint ? oldEndpoint : null;
  } catch {
    return null;
  }
}

async function clearPendingChange(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    await (await caches.open(WEB_PUSH_CLIENT_STATE_CACHE)).delete(WEB_PUSH_SUBSCRIPTION_CHANGE_KEY);
  } catch {
    // Read again next time; a repeated report is harmless.
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function deleteAll(endpoints: string[]): Promise<boolean> {
  let ok = true;
  for (const endpoint of endpoints) {
    try {
      await deletePushSubscription(endpoint);
    } catch {
      ok = false;
    }
  }
  return ok;
}

async function reconcileOnce(trigger: WebPushReconcileTrigger): Promise<WebPushReconcileResult> {
  if (!supportsPushNotifications()) return "unsupported";

  let subscription: PushSubscription | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  try {
    registration = await getExistingRegistration();
    subscription = registration ? await registration.pushManager.getSubscription() : null;
  } catch {
    // Not knowing is not "unsubscribed": change nothing.
    return "lookup_failed";
  }
  const remembered = rememberedPushEndpoint();
  const pendingOld = await readPendingOldEndpoint();

  // Permission revoked in the browser (design §9.2).
  if (Notification.permission !== "granted") {
    const endpoints = unique([subscription?.endpoint, remembered, pendingOld]);
    if (endpoints.length === 0) return "nothing";
    if (subscription) await subscription.unsubscribe().catch(() => false);
    if (await deleteAll(endpoints)) {
      rememberPushEndpoint(null);
      await clearPendingChange();
    }
    return "revoked";
  }

  // Disabled here: a subscription left over (a failed unsubscribe) goes too.
  if (isWebPushOptedOut()) {
    const endpoints = unique([subscription?.endpoint, remembered, pendingOld]);
    if (endpoints.length === 0) return "nothing";
    if (subscription) await subscription.unsubscribe().catch(() => false);
    if (await deleteAll(endpoints)) {
      rememberPushEndpoint(null);
      await clearPendingChange();
    }
    return "opted_out";
  }

  const previous = pendingOld ?? remembered;

  try {
    if (!subscription) {
      // Never reported from here (or reported and then disabled): leave it to
      // the user (Settings, the activation banner).
      if (!previous || !registration) return "nothing";
      // It was on and the push service dropped it: subscribe again.
      const vapidKey = await fetchVapidPublicKey();
      if (!vapidKey) return "error";
      const fresh = await subscribeWithVapidKey(registration, vapidKey);
      if (isWebPushOptedOut()) {
        await fresh.unsubscribe().catch(() => false);
        return "opted_out";
      }
      await reportPushSubscription(fresh, previous);
      await clearPendingChange();
      return "resubscribed";
    }

    // The VAPID key check costs a request: at start, and after a change.
    if (registration && (trigger === "start" || trigger === "subscription_changed")) {
      const vapidKey = await fetchVapidPublicKey();
      if (vapidKey && subscriptionKeyDiffers(subscription, vapidKey)) {
        const oldEndpoint = subscription.endpoint;
        await subscription.unsubscribe();
        const fresh = await subscribeWithVapidKey(registration, vapidKey);
        if (isWebPushOptedOut()) {
          await fresh.unsubscribe().catch(() => false);
          await deleteAll([oldEndpoint]);
          return "opted_out";
        }
        await reportPushSubscription(fresh, oldEndpoint);
        await clearPendingChange();
        return "resubscribed";
      }
    }

    if (subscription.endpoint !== remembered || pendingOld) {
      await reportPushSubscription(subscription, previous);
      await clearPendingChange();
      return "reported";
    }
    return "in_sync";
  } catch (err) {
    console.warn("[Push] Subscription reconcile failed:", err);
    return "error";
  }
}

let inFlight: Promise<WebPushReconcileResult> | null = null;

/** One reconcile at a time; a call while one runs shares it. Never throws. */
export function reconcileWebPushSubscription(trigger: WebPushReconcileTrigger): Promise<WebPushReconcileResult> {
  if (inFlight) return inFlight;
  inFlight = reconcileOnce(trigger)
    .catch((): WebPushReconcileResult => "error")
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Starts the checks (start, focus, visible, a worker's subscription change). Returns a stop function. */
export function startWebPushLifecycle(): () => void {
  if (typeof window === "undefined" || !supportsPushNotifications()) return () => {};

  void reconcileWebPushSubscription("start");
  const handleFocus = () => void reconcileWebPushSubscription("focus");
  const handleVisibility = () => {
    if (document.visibilityState === "visible") void reconcileWebPushSubscription("visible");
  };
  const handleWorkerMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data && typeof data === "object" && (data as { type?: unknown }).type === WEB_PUSH_SUBSCRIPTION_CHANGED_MESSAGE) {
      void reconcileWebPushSubscription("subscription_changed");
    }
  };
  const serviceWorker = "serviceWorker" in navigator ? navigator.serviceWorker : null;

  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibility);
  serviceWorker?.addEventListener("message", handleWorkerMessage);
  return () => {
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener("visibilitychange", handleVisibility);
    serviceWorker?.removeEventListener("message", handleWorkerMessage);
  };
}
