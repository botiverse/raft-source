import { isElectronDesktopShell } from "./desktopShell";

// Which mechanism can deliver "someone DM'd / mentioned you" as a system
// notification in THIS runtime. Decided synchronously from capabilities — no
// network calls, no service-worker probes — so callers can never hang on it.
//
//   desktop-native  Raft Desktop: the web consumes the server's desktop stream
//                   and posts through the shell's raftDesktop.notifications.show
//                   (notifications/desktopNative), which main turns into OS
//                   notifications. Web Push does not apply: the app:// origin
//                   cannot host a service worker and Electron has no push service.
//   web-push        A browser with service workers + PushManager + Notification on
//                   a secure origin.
//   unsupported     Anything else, with the concrete reason so the UI can say why.
export type NotificationUnsupportedReason =
  | "no-window"
  | "no-notification-api"
  | "insecure-context"
  | "no-service-worker"
  | "no-push-manager";

export type NotificationChannel =
  | { kind: "desktop-native" }
  | { kind: "web-push" }
  | { kind: "unsupported"; reason: NotificationUnsupportedReason };

export function resolveNotificationChannel(): NotificationChannel {
  if (typeof window === "undefined") return { kind: "unsupported", reason: "no-window" };
  if (isElectronDesktopShell()) return { kind: "desktop-native" };
  if (typeof Notification === "undefined") return { kind: "unsupported", reason: "no-notification-api" };
  if (window.isSecureContext === false) return { kind: "unsupported", reason: "insecure-context" };
  if (!("serviceWorker" in navigator)) return { kind: "unsupported", reason: "no-service-worker" };
  if (!("PushManager" in window)) return { kind: "unsupported", reason: "no-push-manager" };
  return { kind: "web-push" };
}
