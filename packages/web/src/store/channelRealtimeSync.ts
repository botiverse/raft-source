import { useChannelStore } from "./channelStore";
import type { ApiChannel } from "./channelStore";
import { useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";

export interface ChannelRealtimeSocket {
  emit(event: string, ...args: unknown[]): unknown;
}

type ChannelRealtimeBinding = {
  event: "dm:new" | "channel:updated" | "channel:members-updated";
  handler: (payload: unknown) => void;
};

export function applyMessageChannelActivity(
  msg: Message,
  scheduleInboxRefresh: () => void,
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
  scheduleInboxRefresh();
}

export function isMessageActivitySuppressedByMute(msg: Message): boolean {
  if (mentionsCurrentUser(msg)) return false;
  if (msg.conversationContext?.channelType === "thread") return false;
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
  scheduleInboxRefresh: () => void,
): ChannelRealtimeBinding[] {
  const dmNew = (payload: unknown) => {
    const channelId = readChannelId(payload);
    if (!channelId) return;
    socket.emit("join:channel", channelId);
    void useChannelStore.getState().addOrRefreshDM(channelId);
    scheduleInboxRefresh();
  };

  const channelUpdated = (payload: unknown) => {
    const channel = readApiChannel(payload);
    if (channel) {
      useChannelStore.getState().applyChannelPatch(channel);
      return;
    }

    const channelId = readChannelId(payload);
    if (channelId) {
      void useChannelStore.getState().ensureChannel(channelId);
      return;
    }

    void useChannelStore.getState().loadChannels();
  };

  const channelMembersUpdated = () => {
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
