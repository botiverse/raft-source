/**
 * Boot warm-up of the push providers, off the dispatcher's path: the FCM
 * access token (AWS credentials, Google STS, impersonation: several round
 * trips) and the APNs provider token plus HTTP/2 connection. Without it the
 * first notifications after a start pay these inside their send deadline
 * (5 s per attempt, three attempts), which is how a fresh pod's first drains
 * took 10-20 s and an FCM send failed with `credential_exchange_failed:timeout`.
 *
 * Web Push has nothing to warm: every send resolves and pins its endpoint's
 * address (so a connection cannot be reused across subscriptions) and
 * web-push signs the VAPID JWT per request, which is cheap.
 *
 * Each provider warms on its own with its own bound; one that is slow or
 * failing neither delays the others nor the server start, and a failure only
 * means the first send does the work itself, as before.
 */
import { currentTimeMs } from "@botiverse/raft-shared";
import { warmApnsTransport } from "./apns";
import { fcmTransport } from "./fcm";

export type NotificationTransportWarmOutcome = "warmed" | "not_configured" | "failed";

export interface NotificationTransportWarmers {
  apns(): Promise<"warmed" | "not_configured">;
  fcm(): Promise<"warmed" | "not_configured">;
}

const defaultWarmers: NotificationTransportWarmers = {
  apns: () => warmApnsTransport(),
  fcm: () => fcmTransport.warm(),
};

/** Never rejects. Resolves with each provider's outcome once all have settled. */
export async function warmNotificationTransports(
  warmers: NotificationTransportWarmers = defaultWarmers,
): Promise<Record<keyof NotificationTransportWarmers, NotificationTransportWarmOutcome>> {
  const warm = async (name: keyof NotificationTransportWarmers): Promise<NotificationTransportWarmOutcome> => {
    const started = currentTimeMs();
    try {
      const outcome = await warmers[name]();
      if (outcome === "warmed") console.info(`[Notifications] ${name} warmed in ${currentTimeMs() - started}ms`);
      return outcome;
    } catch (err) {
      console.warn(`[Notifications] ${name} warm-up failed after ${currentTimeMs() - started}ms: ${err instanceof Error ? err.name : "unknown_error"}`);
      return "failed";
    }
  };
  const [apns, fcm] = await Promise.all([warm("apns"), warm("fcm")]);
  return { apns, fcm };
}
