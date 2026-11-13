import type { Channel } from "../../store/channelStore";
import { useChannelSideCardStore } from "../../store/channelSideCardStore";
import { releaseJoinDeferred } from "../../store/joinDeferred";
import { isSidebarExternalSectionChannel } from "../layout/sidebarChannelVisibility";

/** Tagged External in the details (a guest, a guest server or an open invite; or joint): the tag and who-sees line. */
export function channelDetailsExternal(channel: Channel | null | undefined): boolean {
  return channel ? isSidebarExternalSectionChannel(channel) || channel.type === "joint" : false;
}

/**
 * As the channel details open, however they open (the toggle, the channel's name, the archived banner,
 * Announcement settings): right after a join the channel's members and settings load now, not at idle
 * (#proj-frontend:#24); where the row shows its columns as tabs, the details opened last are the tab shown.
 */
export function prepareChannelDetailsOpen(channelId: string) {
  releaseJoinDeferred(channelId);
  useChannelSideCardStore.getState().focusCard("details");
}
