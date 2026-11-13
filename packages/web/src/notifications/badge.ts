// The one badge number (docs/contracts/notifications.md §1.4, design §6):
// Activity unread summed over every server whose level is not `none`.
// `serverUnreadCounts[*].activityUnreadCount` already includes the object rows
// (utils/serverUnreadSummary.ts); a server whose row has no proven Activity
// count is skipped rather than guessed.
//   - Web: "(N) " before the document title, a dotted favicon while N > 0, and
//     navigator.setAppBadge(N) / clearAppBadge() where supported (installed PWA).
//   - Raft Desktop: raftDesktop.setBadgeCount(N) (dock / taskbar overlay / tray dot).

import { notificationBadgeCount } from "@botiverse/raft-shared";
import type { NotificationLevel, RaftDesktopBridge } from "@botiverse/raft-shared";
import { serverNotificationLevel, useNotificationSettingsStore } from "../store/notificationSettingsStore";
import { useServerStore } from "../store/serverStore";
import { setDocumentTitleUnreadCount } from "../utils/browserDocumentTitle";
import type { ServerUnreadSummary } from "../utils/serverUnreadSummary";

export function computeNotificationBadge(
  summaries: Readonly<Record<string, ServerUnreadSummary>>,
  levelOf: (serverId: string) => NotificationLevel,
): number {
  const rows: Array<{ level: NotificationLevel; activityUnreadCount: number }> = [];
  for (const [serverId, summary] of Object.entries(summaries)) {
    if (typeof summary?.activityUnreadCount !== "number") continue;
    rows.push({ level: levelOf(serverId), activityUnreadCount: summary.activityUnreadCount });
  }
  return notificationBadgeCount(rows);
}

/** The badge from the app's stores now. */
export function currentNotificationBadge(): number {
  const levels = useNotificationSettingsStore.getState().serverLevels;
  return computeNotificationBadge(useServerStore.getState().serverUnreadCounts, (serverId) => serverNotificationLevel(serverId, levels));
}

export type BadgeRenderer = (count: number) => void;

/**
 * Renders the badge now and on every change of its inputs (unread summary,
 * server levels, the server rows' legacy mute). Disposing renders 0.
 */
export function startNotificationBadge(render: BadgeRenderer, compute: () => number = currentNotificationBadge): () => void {
  let shown: number | null = null;
  const update = () => {
    const next = compute();
    if (next === shown) return;
    shown = next;
    try {
      render(next);
    } catch (err) {
      console.warn("[Notifications] Badge update failed:", err);
    }
  };
  update();
  const stopServer = useServerStore.subscribe(update);
  const stopLevels = useNotificationSettingsStore.subscribe(update);
  return () => {
    stopServer();
    stopLevels();
    if (shown !== 0) {
      try { render(0); } catch { /* best effort */ }
    }
  };
}

export function desktopBadgeRenderer(bridge: Pick<RaftDesktopBridge, "setBadgeCount">): BadgeRenderer {
  return (count) => bridge.setBadgeCount(count);
}

// ---------------------------------------------------------------------------
// Web: title, favicon, app badge
// ---------------------------------------------------------------------------

/** index.html's icon links (by `sizes`) and their dotted variants in public/. */
const DOTTED_FAVICON_BY_SIZE: Record<string, string> = {
  any: "/favicon-dot-32x32.png",
  "16x16": "/favicon-dot-16x16.png",
  "32x32": "/favicon-dot-32x32.png",
  "192x192": "/favicon-dot-192x192.png",
  "512x512": "/favicon-dot-192x192.png",
};
export const DOTTED_FAVICON_ASSETS = [...new Set(Object.values(DOTTED_FAVICON_BY_SIZE))];
const ORIGINAL_HREF = "raftOriginalHref";
const ORIGINAL_TYPE = "raftOriginalType";

/** Swaps every `<link rel="icon">` to its dotted variant (or back). */
export function setFaviconDot(doc: Document, dotted: boolean): void {
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    if (dotted) {
      const target = DOTTED_FAVICON_BY_SIZE[link.getAttribute("sizes") ?? "any"] ?? DOTTED_FAVICON_BY_SIZE.any;
      if (link.dataset[ORIGINAL_HREF] === undefined) {
        link.dataset[ORIGINAL_HREF] = link.getAttribute("href") ?? "";
        link.dataset[ORIGINAL_TYPE] = link.getAttribute("type") ?? "";
      }
      link.setAttribute("href", target);
      link.setAttribute("type", "image/png");
    } else {
      const href = link.dataset[ORIGINAL_HREF];
      if (href === undefined) continue;
      link.setAttribute("href", href);
      const type = link.dataset[ORIGINAL_TYPE];
      if (type) link.setAttribute("type", type);
      else link.removeAttribute("type");
      delete link.dataset[ORIGINAL_HREF];
      delete link.dataset[ORIGINAL_TYPE];
    }
  }
}

interface AppBadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function webBadgeRenderer(
  env: { document: Document; navigator: AppBadgeNavigator } = { document, navigator: navigator as AppBadgeNavigator },
): BadgeRenderer {
  return (count) => {
    setDocumentTitleUnreadCount(count);
    setFaviconDot(env.document, count > 0);
    const appBadge = count > 0 ? env.navigator.setAppBadge?.bind(env.navigator, count) : env.navigator.clearAppBadge?.bind(env.navigator);
    // Rejects outside an installed app or without permission: nothing to do.
    void appBadge?.()?.catch?.(() => {});
  };
}
