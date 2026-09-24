type ChannelMembersChangedHandler = (channelId: string | null) => void;

const channelMemberEvents = new EventTarget();
const CHANNEL_MEMBERS_CHANGED = "channel-members-changed";

export function notifyChannelMembersChanged(channelId: string) {
  channelMemberEvents.dispatchEvent(
    new CustomEvent(CHANNEL_MEMBERS_CHANGED, { detail: { channelId } }),
  );
}

export function notifyAllChannelMembersChanged() {
  channelMemberEvents.dispatchEvent(
    new CustomEvent(CHANNEL_MEMBERS_CHANGED, { detail: { channelId: null } }),
  );
}

export function subscribeChannelMembersChanged(handler: ChannelMembersChangedHandler): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ channelId?: unknown }>).detail;
    if (typeof detail?.channelId === "string") {
      handler(detail.channelId);
    } else if (detail?.channelId === null) {
      handler(null);
    }
  };
  channelMemberEvents.addEventListener(CHANNEL_MEMBERS_CHANGED, listener);
  return () => channelMemberEvents.removeEventListener(CHANNEL_MEMBERS_CHANGED, listener);
}
