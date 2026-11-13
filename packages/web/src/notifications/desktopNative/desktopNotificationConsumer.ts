// Raft Desktop's notifications: the web half of the `desktop-native`
// notification channel (utils/notificationChannel.ts). The shell only shows
// what it is given (raftDesktop.notifications.show) and reports its window's
// activity (getWindowActivity / onWindowActivity); every decision is made here.
//
//   - The server's `notification:desktop` stream (serverNotificationStream)
//     decides who is notified, on every server. There is no local path:
//     unread counts never raise a notification.
//   - The gate (notificationGate) holds back everything while the window is
//     attended (a test notification excepted), and repeats.
//   - A test notification's show result is acked to the server.
// The badge (notifications/badge.ts), read retraction (retractConsumer.ts)
// and the presence report (presenceReport.ts) run in NotificationRuntime,
// which is mounted only while someone is signed in, so sign-out clears the
// badge.

import type { RaftDesktopBridge } from "@botiverse/raft-shared";
import type { NotificationSocket, SocketSource } from "./followSocket";
import { createNotificationGate, createRecentIds } from "./notificationGate";
import { createServerNotificationSource } from "./serverNotificationStream";
import { observeWindowAttention } from "./windowAttention";
import { markDesktopAlertConsumerRunning } from "./alertAckCapability";

export type DesktopNotificationBridge = Pick<
  RaftDesktopBridge,
  "notifications" | "getWindowActivity" | "onWindowActivity"
>;

export interface DesktopNotificationConsumerDeps {
  bridge: DesktopNotificationBridge;
  sockets: SocketSource<NotificationSocket>;
  isMemberOf(serverId: string): boolean;
  now?: () => number;
  /** Acks a test notification's show result (ackTestNotification). */
  ackTest?: (testId: string, shown: boolean) => void;
  /** Records a test notification the shell could not confirm (noteUnconfirmedTestNotification). */
  noteUnconfirmed?: (testId: string) => void;
}

// Ids already handed to the shell, across restarts of the consumer in this
// page (the shell dedupes again).
const recentNotificationIds = createRecentIds();

export function startDesktopNotificationConsumer(deps: DesktopNotificationConsumerDeps): () => void {
  const now = deps.now ?? Date.now;
  const attention = observeWindowAttention(deps.bridge);
  const gate = createNotificationGate({
    bridge: deps.bridge,
    isAttended: attention.isAttended,
    recentIds: recentNotificationIds,
    ackTest: deps.ackTest,
    noteUnconfirmed: deps.noteUnconfirmed,
  });

  const stopServerStream = createServerNotificationSource({
    sockets: deps.sockets,
    now,
    isMemberOf: deps.isMemberOf,
    // Posted, or held back on purpose (attended, a repeat): delivered, so acked.
    onRequest: (request) => gate.deliver(request) !== "dropped",
  });
  const stopAcking = markDesktopAlertConsumerRunning();

  return () => {
    stopAcking();
    stopServerStream();
    attention.dispose();
  };
}
