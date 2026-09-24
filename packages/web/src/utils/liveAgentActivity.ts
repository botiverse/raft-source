import { normalizeActivity, normalizeActivityDetailKind } from "@botiverse/raft-shared";
import type { AgentActivity } from "@botiverse/raft-shared";
import type { Agent } from "../store/agentStore";
import type { Channel } from "../store/channelStore";
import type { Message } from "../store/messageStore";
import { en } from "../i18n/messages/en";
import { getActivityText, getActivityTextDescriptor } from "./activity";
import type { ActivityTextDescriptor } from "./activity";

export type LiveAgentActivityKind = "activity" | "message";

export interface LiveAgentActivityItem {
  id: string;
  kind: LiveAgentActivityKind;
  agentId: string;
  agentName: string;
  agentAvatarUrl: string | null;
  text: string;
  textDescriptor?: ActivityTextDescriptor;
  context: string | null;
  activity: AgentActivity | null;
  createdAt: number;
}

export interface ThreadContextLike {
  threadChannelId: string;
  parentChannelName: string;
}

const MAX_TEXT_LENGTH = 140;
// How long a live-work item stays visible without a fresh signal. This is a
// SAFETY NET, not the primary lifecycle: a working/thinking item is normally
// replaced when the agent emits a new activity and removed the moment the agent
// emits a terminal (idle/online) activity. The net must outlast the daemon's
// status heartbeat (`ACTIVITY_HEARTBEAT_MS = 60_000`, see agentProcessManager),
// otherwise a steadily-working agent that isn't changing its activity text goes
// dark for ~50s of every 60s — the bar looks frozen / "not refreshing". 90s
// survives one heartbeat (plus network jitter) while still clearing a crashed
// agent that stopped heartbeating within ~1.5 missed beats.
export const LIVE_AGENT_ACTIVITY_VISIBLE_MS = 90_000;

function truncateText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

/** English-catalog fallback label when an agent row has no display name. */
export function agentFallbackLabel(): string {
  return en["activity.live.agentFallback"];
}

function agentLabel(agentId: string, agents: Agent[], fallback?: string): string {
  const agent = agents.find((item) => item.id === agentId);
  return agent?.displayName || agent?.name || fallback || agentFallbackLabel();
}

function agentAvatarUrl(agentId: string, agents: Agent[]): string | null {
  return agents.find((item) => item.id === agentId)?.avatarUrl ?? null;
}

function isLiveWorkActivity(activity: AgentActivity): boolean {
  return activity === "working" || activity === "thinking";
}

export function buildMessageActivityItem(
  message: Pick<Message, "id" | "senderType" | "senderId" | "senderName" | "content" | "channelId" | "createdAt" | "attachments" | "messageType">,
  _context: {
    agents: Agent[];
    channels: Channel[];
    dmChannels: Channel[];
    threads?: ThreadContextLike[];
  },
): LiveAgentActivityItem | null {
  void message;
  return null;
}

export function buildStatusActivityItem(
  event: { agentId: string; activity: string; activityKind?: string; detail?: string; detailKind?: string; timestamp?: number },
  agents: Agent[],
): LiveAgentActivityItem | null {
  const activity = normalizeActivity(event.activityKind ?? event.activity);
  const detail = truncateText(event.detail || "");

  if (!isLiveWorkActivity(activity)) return null;

  const detailKind = normalizeActivityDetailKind(event.detailKind);
  const textDescriptor = getActivityTextDescriptor(activity, detail, detailKind);
  const text = getActivityText(activity, detail, detailKind);

  return {
    id: `activity:${event.agentId}:${activity}:${detail}:${event.timestamp ?? Date.now()}`,
    kind: "activity",
    agentId: event.agentId,
    agentName: agentLabel(event.agentId, agents),
    agentAvatarUrl: agentAvatarUrl(event.agentId, agents),
    text,
    textDescriptor,
    context: null,
    activity,
    createdAt: event.timestamp ?? Date.now(),
  };
}

export function applyStatusActivityEvent(
  items: LiveAgentActivityItem[],
  event: {
    agentId: string;
    activity: string;
    activityKind?: string;
    detail?: string;
    detailKind?: string;
    timestamp?: number;
    isHeartbeat?: boolean;
    isRefreshOnly?: boolean;
  },
  agents: Agent[],
  maxItems = 20,
): LiveAgentActivityItem[] {
  const activity = normalizeActivity(event.activityKind ?? event.activity);
  const now = event.timestamp ?? Date.now();
  if (event.isRefreshOnly === true || event.isHeartbeat === true) {
    // Refresh the current live-work row in place without manufacturing or
    // reordering ticker history. A terminal snapshot still clears the row.
    const activeItems = pruneExpiredLiveAgentActivityItems(items, now);
    if (!isLiveWorkActivity(activity)) {
      return activeItems.filter((item) => item.agentId !== event.agentId);
    }
    const refreshedItem = buildStatusActivityItem(event, agents)!;
    let projected = false;
    return activeItems.map((item) => {
      if (projected || item.agentId !== event.agentId || item.kind !== "activity") return item;
      projected = true;
      return { ...refreshedItem, id: item.id };
    });
  }
  if (!isLiveWorkActivity(activity)) {
    return pruneExpiredLiveAgentActivityItems(items, now)
      .filter((item) => item.agentId !== event.agentId);
  }
  return appendLiveAgentActivityItem(items, buildStatusActivityItem(event, agents), maxItems);
}

export function appendLiveAgentActivityItem(
  items: LiveAgentActivityItem[],
  item: LiveAgentActivityItem | null,
  maxItems = 20,
): LiveAgentActivityItem[] {
  const now = item?.createdAt ?? Date.now();
  const activeItems = pruneExpiredLiveAgentActivityItems(items, now);
  if (!item) return activeItems;
  const last = activeItems[0];
  if (
    last &&
    last.kind === item.kind &&
    last.agentId === item.agentId &&
    last.text === item.text &&
    last.context === item.context &&
    Math.abs(last.createdAt - item.createdAt) < 2000
  ) {
    return activeItems;
  }
  return [item, ...activeItems.filter((existing) => existing.id !== item.id)].slice(0, maxItems);
}

export function pruneExpiredLiveAgentActivityItems(
  items: LiveAgentActivityItem[],
  now = Date.now(),
): LiveAgentActivityItem[] {
  return items.filter((item) => now - item.createdAt < LIVE_AGENT_ACTIVITY_VISIBLE_MS);
}
