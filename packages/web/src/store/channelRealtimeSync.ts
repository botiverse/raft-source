import { useChannelStore } from "./channelStore";
import type { ApiChannel } from "./channelStore";
import { useServerStore } from "./serverStore";
import { useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { clearChannelAccessLost } from "./channelAccessLoss";
import type { InboxRefreshTrigger } from "@botiverse/raft-shared";

/** Asks for a throttled Activity re-read, naming the event that asked (#triage:#229). */
export type ScheduleInboxRefresh = (trigger: InboxRefreshTrigger) => void;

export interface ChannelRealtimeSocket {
  emit(event: string, ...args: unknown[]): unknown;
}

type ChannelRealtimeBinding = {
  event: "dm:new" | "channel:updated" | "channel:members-updated";
  handler: (payload: unknown) => void;
};

export function applyMessageChannelActivity(
  msg: Message,
  scheduleInboxRefresh: ScheduleInboxRefresh,
  trigger: Extract<InboxRefreshTrigger, "message_new" | "message_echo">,
) {
  if (!msg?.channelId) return;
  if (isMessageActivitySuppressedByMute(msg)) return;
  useChannelStore.getState().touchChannelActivity(
    msg.channelId,
    typeof msg.createdAt === "string" ? msg.createdAt : null,
  );
  if (useChannelStore.getState().dmChannels.some((c) => c.id === msg.channelId)) {
    void useChannelStore.getState().addOrRefreshDM(msg.channelId);
  }
  scheduleInboxRefresh(trigger);
}

export function isMessageActivitySuppressedByMute(msg: Message): boolean {
  if (mentionsCurrentUser(msg)) return false;
  return isMessageInMutedActivityRange(msg);
}

/**
 * Is this message at or past its channel's Activity mute, mention or not? The
 * served channel row stops at the mute (a mention reaches Activity, but not
 * that row's preview).
 */
export function isMessageInMutedActivityRange(msg: Message): boolean {
  if (msg.conversationContext?.channelType === "thread") return false;
  // A task conversation (task v2) follows the thread rule: following it, not
  // the channel's mute, decides whether it reaches Activity.
  if (msg.conversationContext?.channelType === "task") return false;
  const activityChannelId = msg.channelId;
  const channelState = useChannelStore.getState();
  const muteSource = channelState.channels.find((channel) => channel.id === activityChannelId)
    ?? channelState.dmChannels.find((channel) => channel.id === activityChannelId);
  if (muteSource?.activityMuted !== true) return false;
  const muteFromSeq = normalizeSeq(muteSource.muteFromSeq);
  if (muteFromSeq == null) return true;
  const messageSeq = normalizeSeq(msg.seq);
  return messageSeq == null || messageSeq >= muteFromSeq;
}

function mentionsCurrentUser(msg: Message): boolean {
  const currentUserId = useMessageStore.getState().currentUserId;
  if (!currentUserId) return false;
  return (msg.mentions ?? []).some((mention) => {
    const candidate = mention as { type?: unknown; id?: unknown; targetType?: unknown; targetId?: unknown };
    const mentionType = candidate.type ?? candidate.targetType;
    const mentionId = candidate.id ?? candidate.targetId;
    return mentionType === "user" && mentionId === currentUserId;
  });
}

function normalizeSeq(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function createChannelRealtimeBindings(
  socket: ChannelRealtimeSocket,
  scheduleInboxRefresh: ScheduleInboxRefresh,
): ChannelRealtimeBinding[] {
  const dmNew = (payload: unknown) => {
    const channelId = readChannelId(payload);
    if (!channelId) return;
    socket.emit("join:channel", channelId);
    void useChannelStore.getState().addOrRefreshDM(channelId);
    scheduleInboxRefresh("dm_new");
  };

  const channelUpdated = (payload: unknown) => {
    const channel = readApiChannel(payload);
    if (channel) {
      // Some events go to the user's room, which spans every server they have
      // open. A joint channel has one row per participating server, so a row
      // from another server must not land in this server's list.
      const currentServerId = useServerStore.getState().current?.id;
      if (channel.serverId && currentServerId && channel.serverId !== currentServerId) return;
      // Added back (the route sends the added person their row, joined).
      if (channel.joined === true) clearChannelAccessLost(channel.id);
      useChannelStore.getState().applyChannelPatch(channel);
      return;
    }

    // An id-only event means "this channel changed, re-read it" (e.g. a joint
    // participant disconnected, which can end the over-limit lock). A cached
    // row is exactly what is stale, so refetch rather than return it.
    const channelId = readChannelId(payload);
    if (channelId) {
      void useChannelStore.getState().ensureChannel(channelId, { refresh: true });
      return;
    }

    void useChannelStore.getState().loadChannels();
  };

  const channelMembersUpdated = (payload: unknown) => {
    // Members of one channel changed — refresh only that channel's row (its
    // member count and members list), never the whole 300KB channel list.
    // useChannelMembers re-fetches its own member page on the same event.
    const channelId = readChannelId(payload);
    if (channelId) {
      // Our own join's event (sent before its reply): the join re-reads the
      // row itself when it settles, accepted or not (store/channelJoin.ts).
      if (useChannelStore.getState().joiningChannelIds[channelId]) return;
      void useChannelStore.getState().ensureChannel(channelId, { refresh: true });
      return;
    }

    void useChannelStore.getState().loadChannels();
  };

  return [
    { event: "dm:new", handler: dmNew },
    { event: "channel:updated", handler: channelUpdated },
    { event: "channel:members-updated", handler: channelMembersUpdated },
  ];
}

function readChannelId(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const { channelId, id } = payload as { channelId?: unknown; id?: unknown };
  if (typeof channelId === "string") return channelId;
  if (typeof id === "string") return id;
  return null;
}

function readApiChannel(payload: unknown): ApiChannel | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = "channel" in payload
    ? (payload as { channel?: unknown }).channel
    : payload;
  if (!candidate || typeof candidate !== "object") return null;
  const id = (candidate as { id?: unknown }).id;
  const name = (candidate as { name?: unknown }).name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return candidate as ApiChannel;
}
