export const SERVER_NOTIFICATION_PREFS_UPDATED_EVENT = "slock:server-notification-prefs-updated";

export type ServerNotificationPrefsUpdatedDetail = {
  serverId: string;
  serverPushMuted: boolean;
  prefsVersion?: number;
};

export function dispatchServerNotificationPrefsUpdated(detail: ServerNotificationPrefsUpdatedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new window.CustomEvent<ServerNotificationPrefsUpdatedDetail>(
    SERVER_NOTIFICATION_PREFS_UPDATED_EVENT,
    { detail },
  ));
}
