/** The Activity list's per-channel group counts (the channel facet), apart from the inbox store. */
import { inboxItemGroupChannelId } from "./inboxItem";
import type { InboxItem } from "./inboxStore";

type ActivityPersistedItem = Exclude<InboxItem, { kind: "mention_action" | "object" }>;

export type InboxGroupCount = {
  channelId: string;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm";
  count: number;
  /** Server-owned maximum visible activity timestamp for this facet. */
  lastActivityAt?: string;
};

export function sortInboxGroupsByRecentActivity(groups: readonly InboxGroupCount[]): InboxGroupCount[] {
  const activityTimestamp = (group: InboxGroupCount) => {
    const parsed = Date.parse(group.lastActivityAt!);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const byRecentActivity = (left: InboxGroupCount, right: InboxGroupCount) => {
    const leftActivity = activityTimestamp(left);
    const rightActivity = activityTimestamp(right);
    if (leftActivity > rightActivity) return -1;
    if (leftActivity < rightActivity) return 1;
    const nameDelta = left.channelName.localeCompare(right.channelName);
    return nameDelta !== 0 ? nameDelta : left.channelId.localeCompare(right.channelId);
  };
  const dms = groups.filter((group) => group.channelType === "dm").sort(byRecentActivity);
  const channels = groups.filter((group) => group.channelType !== "dm").sort(byRecentActivity);
  return [...dms, ...channels];
}

export function preserveSelectedInboxGroup(
  incomingGroups: readonly InboxGroupCount[],
  previousGroups: readonly InboxGroupCount[],
  selectedChannelId: string | null,
): InboxGroupCount[] {
  const nextGroups = sortInboxGroupsByRecentActivity(incomingGroups);
  if (!selectedChannelId || nextGroups.some((group) => group.channelId === selectedChannelId)) {
    return nextGroups;
  }

  const selectedGroup = previousGroups.find((group) => group.channelId === selectedChannelId);
  if (!selectedGroup) return nextGroups;

  // A channel facet is independent from the top Activity view. When that
  // channel has zero rows in the newly selected view, the server correctly
  // omits it from that view's groups. Keep only its identity so the still-live
  // constraint remains visible and clearable; its old view count must not leak.
  return sortInboxGroupsByRecentActivity([
    ...nextGroups,
    { ...selectedGroup, count: 0 },
  ]);
}

export function decrementInboxGroupCounts(
  groups: InboxGroupCount[],
  items: readonly InboxItem[],
  selectedChannelId: string | null = null,
): InboxGroupCount[] {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: bypassing either empty-input fast path reaches the same empty map and returns the same array identity below.
  if (groups.length === 0 || items.length === 0) return groups;
  const removedByGroup = new Map<string, number>();
  for (const item of items) {
    const channelId = inboxItemGroupChannelId(item);
    if (!channelId) continue;
    removedByGroup.set(channelId, (removedByGroup.get(channelId) ?? 0) + 1);
  }
  if (removedByGroup.size === 0) return groups;
  return groups.flatMap((group) => {
    const removedCount = removedByGroup.get(group.channelId) ?? 0;
    // A selected facet may intentionally stay in state with count=0 so its
    // still-live constraint remains visible and clearable. Removing an item
    // from another group must not erase that retained identity.
    if (removedCount === 0) return [group];
    const count = Math.max(0, group.count - removedCount);
    return count > 0 || group.channelId === selectedChannelId ? [{ ...group, count }] : [];
  });
}

/**
 * Adds the rows back to their groups (per-channel counts under an Unread
 * filter): a row marked unread here comes back to the list, and to its group.
 */
export function incrementInboxGroupCounts(groups: InboxGroupCount[], items: readonly ActivityPersistedItem[]): InboxGroupCount[] {
  if (items.length === 0) return groups;
  let next = groups;
  for (const item of items) {
    const channelId = inboxItemGroupChannelId(item);
    if (!channelId) continue;
    const index = next.findIndex((group) => group.channelId === channelId);
    if (index !== -1) {
      next = next.map((group, i) => (i === index ? { ...group, count: group.count + 1 } : group));
      continue;
    }
    const thread = item.kind === "thread";
    next = sortInboxGroupsByRecentActivity([...next, {
      channelId,
      channelName: thread ? item.parentChannelName : item.channelName,
      channelType: thread ? item.parentChannelType : item.channelType,
      count: 1,
      lastActivityAt: thread ? item.lastActivityAt : item.lastMessageAt,
    }]);
  }
  return next;
}
