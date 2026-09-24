/**
 * Inbox projections — the L3 exemplar of RFC 037.
 *
 * The ONLY place inbox-derived facts are computed. Surfaces (Sidebar rail
 * badge, ThreadsInbox header, LeftRail dot, ServerSwitcher) import these;
 * none of them re-derives. Pure functions of domain state — the lint
 * override on store/projections/** pins the no-react/no-IO contract.
 *
 * Axis-preserving (RFC 037 §L3): selectors take the surface's semantic axes
 * as parameters instead of collapsing them. Converge the derivation, keep
 * the axes.
 */

import { getInboxItemKey } from "../inboxStore";
import type { InboxItem } from "../inboxStore";
import type { InboxDomainState } from "../events/inboxEvents";

/** Single source for the "99+" badge formatting that Phase A found
 *  copy-pasted three times in Sidebar alone. Returns null when nothing
 *  should render — surfaces map null to "no badge". */
export function formatUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export function selectTotalUnread(state: InboxDomainState): number {
  return state.totalUnreadCount;
}

export function selectInboxBadgeText(state: InboxDomainState): string | null {
  return formatUnreadBadge(state.totalUnreadCount);
}

export type InboxAttention = "none" | "unread" | "mention";

/** The rail/dot decision: mention outranks unread outranks none.
 *  `includeMuted=false` is the default surface behavior; muted rows still
 *  pierce when they carry a direct mention (product rule — the axis is a
 *  parameter, not a hardcode). Muted-ness itself is a channel fact the
 *  caller supplies, preserving the cross-store boundary. */
export function selectInboxAttention(
  state: InboxDomainState,
  opts: { isMuted?: (item: InboxItem) => boolean; includeMuted?: boolean } = {},
): InboxAttention {
  const isMuted = opts.isMuted ?? (() => false);
  let hasUnread = false;
  for (const item of state.items) {
    if (item.hasMention && item.unreadCount > 0) return "mention";
    if (item.unreadCount > 0 && (opts.includeMuted || !isMuted(item))) {
      hasUnread = true;
    }
  }
  return hasUnread ? "unread" : "none";
}

export function selectUnreadItems(state: InboxDomainState): InboxItem[] {
  return state.items.filter((item) => item.unreadCount > 0);
}

export function selectItemByKey(state: InboxDomainState, itemKey: string): InboxItem | null {
  return state.items.find((item) => getInboxItemKey(item) === itemKey) ?? null;
}
