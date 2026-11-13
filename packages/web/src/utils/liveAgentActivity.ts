import { normalizeActivity, normalizeActivityDetailKind } from "@botiverse/raft-shared";
import type { AgentActivity } from "@botiverse/raft-shared";
import type { Agent } from "../store/agentStore";
import type { Channel } from "../store/channelStore";
import type { Message } from "../store/messageStore";
import { enFallback } from "../i18n/messages/enFallback";
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
  /** The agent's latest signal. */
  createdAt: number;
  /** When this stretch of work began. Who-is-working lists and stacks are in this order. */
  startedAt: number;
  /** When the agent went idle; it stays listed for LIVE_AGENT_IDLE_GRACE_MS in case it resumes. */
  idleSince: number | null;
  /**
   * From a coarse state (AGENT_ACTIVITY_STATE_EVENT, an agent this tab does
   * not subscribe to): no heartbeat follows it, so the row stays until a
   * later state settles it instead of expiring after the visible window.
   */
  heldUntilChange?: boolean;
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
// An agent that goes idle stays in "Working now" this long before it leaves.
// Agents go idle between tool calls and pick up again a moment later; without
// the grace their faces dropped out of the stack and came back many times a
// minute (DS › AgentActivity: faces change only when someone starts or stops).
export const LIVE_AGENT_IDLE_GRACE_MS = 5_000;

function truncateText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

/** English-catalog fallback label when an agent row has no display name. */
export function agentFallbackLabel(): string {
  return enFallback["activity.live.agentFallback"];
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
    startedAt: event.timestamp ?? Date.now(),
    idleSince: null,
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
    /** A coarse state (no detail, no heartbeat after it): see LiveAgentActivityItem.heldUntilChange. */
    fromCoarseState?: boolean;
  },
  agents: Agent[],
): LiveAgentActivityItem[] {
  if (event.fromCoarseState === true) {
    const { fromCoarseState: _coarse, ...detailed } = event;
    const next = applyStatusActivityEvent(items, detailed, agents);
    if (!isLiveWorkActivity(normalizeActivity(event.activity))) return next;
    return next.map((item) => (item.agentId === event.agentId && item.kind === "activity" && item.idleSince === null ? { ...item, heldUntilChange: true } : item));
  }
  const activity = normalizeActivity(event.activityKind ?? event.activity);
  const now = event.timestamp ?? Date.now();
  if (event.isRefreshOnly === true || event.isHeartbeat === true) {
    // Refresh the agent's row in place: a snapshot never adds an agent or
    // moves one. A terminal snapshot settles it like an idle event.
    const activeItems = pruneExpiredLiveAgentActivityItems(items, now);
    if (!isLiveWorkActivity(activity)) return settleLiveAgentActivity(activeItems, event.agentId, now);
    const refreshedItem = buildStatusActivityItem(event, agents)!;
    let projected = false;
    return activeItems.map((item) => {
      if (projected || item.agentId !== event.agentId || item.kind !== "activity") return item;
      projected = true;
      return { ...refreshedItem, id: item.id, startedAt: item.startedAt };
    });
  }
  if (!isLiveWorkActivity(activity)) {
    return settleLiveAgentActivity(pruneExpiredLiveAgentActivityItems(items, now), event.agentId, now);
  }
  return appendLiveAgentActivityItem(items, buildStatusActivityItem(event, agents));
}

/** The agent went idle: keep its row (and its place) for the grace period. */
function settleLiveAgentActivity(items: LiveAgentActivityItem[], agentId: string, now: number): LiveAgentActivityItem[] {
  return items.map((item) => (item.agentId === agentId && item.idleSince === null ? { ...item, idleSince: now } : item));
}

/**
 * Who is working now (DS › AgentActivity): one row per agent, in the order
 * they started. A new event updates the agent's row where it is, so the face
 * stack and the Working-now list change only when someone starts or stops;
 * an agent picking up again within the idle grace keeps its place.
 */
export function appendLiveAgentActivityItem(
  items: LiveAgentActivityItem[],
  item: LiveAgentActivityItem | null,
): LiveAgentActivityItem[] {
  const now = item?.createdAt ?? Date.now();
  const activeItems = pruneExpiredLiveAgentActivityItems(items, now);
  if (!item) return activeItems;
  const index = activeItems.findIndex((existing) => existing.agentId === item.agentId);
  if (index === -1) return [...activeItems, { ...item, startedAt: item.createdAt, idleSince: null }];
  const current = activeItems[index];
  if (
    current.idleSince === null &&
    current.kind === item.kind &&
    current.text === item.text &&
    current.context === item.context &&
    Math.abs(current.createdAt - item.createdAt) < 2000
  ) {
    return activeItems;
  }
  const next = activeItems.slice();
  next[index] = { ...item, startedAt: current.startedAt, idleSince: null };
  return next;
}

export function pruneExpiredLiveAgentActivityItems(
  items: LiveAgentActivityItem[],
  now = Date.now(),
): LiveAgentActivityItem[] {
  return items.filter((item) => now < liveAgentActivityExpiry(item));
}

/** When a row leaves on its own: the idle grace runs out, or (the safety net) no signal for the visible window. */
function liveAgentActivityExpiry(item: LiveAgentActivityItem): number {
  if (item.idleSince === null) return item.heldUntilChange ? Number.POSITIVE_INFINITY : item.createdAt + LIVE_AGENT_ACTIVITY_VISIBLE_MS;
  return item.idleSince + LIVE_AGENT_IDLE_GRACE_MS;
}

/** The earliest moment any row leaves on its own, to schedule the next prune; null with no rows. */
export function nextLiveAgentActivityExpiry(items: readonly LiveAgentActivityItem[]): number | null {
  const next = items.length === 0 ? null : Math.min(...items.map(liveAgentActivityExpiry));
  return next === null || Number.isFinite(next) ? next : null;
}
