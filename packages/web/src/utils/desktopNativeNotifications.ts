import { getSocket } from "../api/socket";
import { runTestNotification } from "../notifications/notificationApi";
import type { TestNotificationOutcome } from "../notifications/notificationApi";
import { getDesktopBridge } from "./desktopBridge";

// Raft Desktop notifications are posted by the shell's main process
// (raftDesktop.notifications.show): the web decides what to show
// (notifications/desktopNative), main owns the OS notification, its grouping
// and its click.
//
// The shell exposes no API for the OS authorization switch (System Settings →
// Notifications → Raft Desktop), and the Chromium `Notification.permission`
// in the shell says nothing about it. The test notification is therefore a
// real one: the server sends it through `notification:desktop` to this
// socket, the consumer posts it and acks the shell's show result
// (docs/contracts/notifications.md §6).

export function isDesktopNativeNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && typeof getDesktopBridge()?.notifications?.show === "function";
}

/**
 * Sends a test notification to this desktop's socket and waits for the
 * outcome: shown / sent but not shown / failed. `no_socket` when this page has
 * no connected socket to receive it.
 */
export async function runDesktopTestNotification(deps: {
  run?: typeof runTestNotification;
  socket?: () => { connected: boolean; id?: string | undefined };
} = {}): Promise<TestNotificationOutcome> {
  const socket = (deps.socket ?? getSocket)();
  const socketId = socket.connected ? socket.id : undefined;
  if (!socketId) return { state: "failed", reason: "no_socket" };
  return (deps.run ?? runTestNotification)({ kind: "desktop", socketId });
}
