// `notification:retract` (docs/contracts/notifications.md §5): a conversation
// was read on some device; close this device's notifications for it up to
// `throughSeq`. Listens on the app's current socket and every replacement.
//   - Raft Desktop: the shell closes them (raftDesktop.notifications.clearGroup;
//     main knows each notification's seq).
//   - Web: the page closes the matching Web Push notifications itself
//     through the service worker registration (getNotifications({tag}) +
//     close; tag = groupKey), which works even when this page is not
//     controlled by the worker (first load, hard reload). Without a
//     registration it forwards it to the controlling worker (public/sw.js).
//     Without an open tab nothing retracts: browsers allow no silent push to
//     do it, so the next notification of the group replaces it (tag).

import {
  NOTIFICATION_RETRACT_EVENT,
  SW_NOTIFICATION_RETRACT_MESSAGE,
  parseNotificationRetractPayload,
} from "@botiverse/raft-shared";
import type { NotificationRetractPayload, RaftDesktopBridge } from "@botiverse/raft-shared";
import { listenOnEverySocket } from "./desktopNative/followSocket";
import type { EventSocketLike, SocketSource } from "./desktopNative/followSocket";

export type Retract = (payload: NotificationRetractPayload) => void;

export function startRetractConsumer(sockets: SocketSource<EventSocketLike>, retract: Retract): () => void {
  return listenOnEverySocket(sockets, NOTIFICATION_RETRACT_EVENT, (raw: unknown) => {
    const payload = parseNotificationRetractPayload(raw);
    if (!payload) return;
    try {
      retract(payload);
    } catch (err) {
      console.warn("[Notifications] Retract failed:", err);
    }
  });
}

export function desktopRetract(bridge: Pick<RaftDesktopBridge, "notifications">): Retract {
  return ({ groupKey, throughSeq }) => {
    bridge.notifications.clearGroup(groupKey, throughSeq);
  };
}

export interface RetractableNotification {
  readonly data?: unknown;
  close(): void;
}

export interface NotificationRegistrationLike {
  getNotifications(filter?: { tag?: string }): Promise<readonly RetractableNotification[]>;
}

export interface ServiceWorkerContainerLike {
  readonly controller: { postMessage(message: unknown): void } | null;
  getRegistration?(): Promise<NotificationRegistrationLike | undefined>;
}

/**
 * Closes the shown notifications of `groupKey` with seq <= throughSeq (all of
 * them when null); the same rule as public/sw.js retractNotifications.
 */
export async function closeGroupNotifications(
  registration: NotificationRegistrationLike,
  groupKey: string,
  throughSeq: number | null,
): Promise<number> {
  let closed = 0;
  for (const notification of await registration.getNotifications({ tag: groupKey })) {
    const data = (notification.data ?? {}) as { groupKey?: unknown; seq?: unknown };
    if (data.groupKey !== groupKey) continue;
    if (throughSeq !== null && !(typeof data.seq === "number" && data.seq <= throughSeq)) continue;
    notification.close();
    closed += 1;
  }
  return closed;
}

export function webRetract(
  container: () => ServiceWorkerContainerLike | null | undefined = () =>
    (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined),
): Retract {
  return ({ groupKey, throughSeq }) => {
    const workers = container();
    if (!workers) return;
    const forward = () => workers.controller?.postMessage({ type: SW_NOTIFICATION_RETRACT_MESSAGE, groupKey, throughSeq });
    if (typeof workers.getRegistration !== "function") {
      forward();
      return;
    }
    void workers.getRegistration()
      .then(async (registration) => {
        if (registration) await closeGroupNotifications(registration, groupKey, throughSeq);
        else forward();
      })
      .catch(() => forward());
  };
}
