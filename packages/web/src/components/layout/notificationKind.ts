// Pure helpers for the notification-kind ordering used by the Notification
// Center trigger and popup. Kept in their own file so they can be unit-tested
// without dragging in Zustand stores or browser-only APIs (localStorage,
// service workers) that the React `useSystemNotifications` hook touches.

export type NotificationKind = "error" | "warning" | "info";

const KIND_RANK: Record<NotificationKind, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

/** Compare two kinds; negative when `a` is more severe than `b`. */
export function compareNotificationKind(a: NotificationKind, b: NotificationKind): number {
  return KIND_RANK[b] - KIND_RANK[a];
}

/**
 * Return the highest kind present in a list of items, or null if the list is
 * empty. Used by the Rail / mobile triggers to color-code the indicator dot
 * to the worst entry in the popup.
 */
export function topNotificationKind<T extends { kind: NotificationKind }>(
  items: T[],
): NotificationKind | null {
  if (items.length === 0) return null;
  let top: NotificationKind = "info";
  for (const it of items) {
    if (compareNotificationKind(it.kind, top) < 0) {
      top = it.kind;
      if (top === "error") return top;
    }
  }
  return top;
}
