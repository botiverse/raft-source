// Mounts Raft Desktop's notification consumer (desktopNotificationConsumer.ts)
// for the app's whole life, inside the router. Renders nothing, and does
// nothing without the desktop bridge's notification capabilities (a browser,
// the phone app).

import { useEffect } from "react";
import { useServerStore } from "../../store/serverStore";
import { ackTestNotification, noteUnconfirmedTestNotification } from "../notificationApi";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { startDesktopNotificationConsumer } from "./desktopNotificationConsumer";
import { appSocketSource } from "./appSocketSource";

export default function DesktopNativeNotifications(): null {
  useEffect(() => {
    const bridge = getDesktopBridge();
    // Capability check, not just "is desktop": a partial bridge (a test or
    // smoke shell) gets nothing rather than a half-wired consumer.
    if (
      !bridge
      || typeof bridge.notifications?.show !== "function"
      || typeof bridge.onWindowActivity !== "function"
    ) return;
    return startDesktopNotificationConsumer({
      bridge,
      sockets: appSocketSource,
      isMemberOf: (serverId) => useServerStore.getState().servers.some((s) => s.id === serverId),
      ackTest: (testId, shown) => { void ackTestNotification(testId, shown); },
      noteUnconfirmed: noteUnconfirmedTestNotification,
    });
  }, []);

  return null;
}
