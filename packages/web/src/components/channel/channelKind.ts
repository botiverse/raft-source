import type { Channel } from "../../store/channelStore";
import { isSidebarExternalSectionChannel } from "../layout/sidebarChannelVisibility";

/**
 * Anyone can read the channel on the server's public page: the server's page
 * is live and the channel is visible to Guests (and not archived). One rule
 * for every surface that shows the channel's kind icon.
 */
export function isChannelOnPublicPage(
  serverPublicPageLive: boolean,
  channel: Pick<Channel, "guestVisible" | "archivedAt"> | null | undefined,
): boolean {
  return serverPublicPageLive && channel?.guestVisible === true && !channel.archivedAt;
}

/** The channel fields its kind icon is chosen from. */
export type ChannelKindSource = Pick<Channel, "type" | "conversionJob" | "hasExternalRelation" | "guestVisible" | "archivedAt">;

/**
 * The one chooser of a channel's kind icon: its type, whether it is in the
 * sidebar's External section (a guest, a guest server or an open invite;
 * Q12 A) and whether it is on the server's public page. Every surface that
 * draws a channel's kind takes it from here (or from ChannelIcon), so an
 * external, joint, private, public or published channel looks the same in
 * the sidebar, its header, the inbox, search, pickers and suggestions
 * (cindyz 2026-11-10: "如果sidebar里用了这个就要在channel header里和提到这个channel的地方都用这个").
 */
export function channelKindIconProps(
  channel: ChannelKindSource,
  serverPublicPageLive: boolean,
): { type: Channel["type"]; onPublicPage: boolean; external: boolean } {
  return {
    type: channel.type,
    onPublicPage: isChannelOnPublicPage(serverPublicPageLive, channel),
    external: isSidebarExternalSectionChannel(channel),
  };
}
