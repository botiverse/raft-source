import { memo } from "react";
import { useIntl } from "react-intl";
import { Info } from "lucide-react";
import { Banner, BannerDescription, BannerTitle, SidebarItem, SidebarItemChannelIcon, SidebarItemContent, SidebarItemTitle } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import type { Server } from "../../store/serverStore";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import { channelKindIconProps } from "../channel/channelKind";
import { SidebarCellList } from "../../features/sidebar/rows/SidebarCellList";
import { sidebarItemClass } from "../../features/sidebar/rows/sidebarRowClasses";

/** What the offline frame shows (OfflineServerLayout): the server and its channel rows from the device. */
export interface OfflineFrame {
  server: Server | null;
  channels: readonly Channel[];
}

/**
 * The channel rows kept on the device, drawn as the sidebar draws them, but
 * shown only, and visibly so (Wug, #proj-frontend:#9): display-only rows
 * (raft-ui `interactive={false}`: a div, not a button, never focused), in
 * the hint ink (`tone="away"`), no pointer, `aria-disabled`, and no
 * selected row, even for the URL's channel: nothing here is live. No unread,
 * draft or menu (none of it is kept), so nothing here reads another store or
 * asks the server.
 */
export const OfflineChannelRows = memo(function OfflineChannelRows({ channels }: {
  channels: readonly Channel[];
}) {
  if (channels.length === 0) return null;
  return (
    <SidebarCellList data-testid="offline-sidebar-channels">
      {channels.map((channel) => (
          <SidebarItem
            key={channel.id}
            data-sidebar-channel-id={channel.id}
            data-slot="sidebar-item"
            interactive={false}
            aria-disabled="true"
            tone="away"
            className={`${sidebarItemClass(false)} cursor-default`}
          >
            <SidebarItemChannelIcon>
              {/* No store read here: the shared chooser on the kept row; the public page isn't live offline. */}
              <ChannelKindIcon {...channelKindIconProps(channel, false)} size={16} />
            </SidebarItemChannelIcon>
            <SidebarItemContent className="items-center">
              <SidebarItemTitle>{channel.name}</SidebarItemTitle>
            </SidebarItemContent>
          </SidebarItem>
      ))}
    </SidebarCellList>
  );
});

/**
 * A phone's Home, where the bar has room only for "Offline": the whole
 * reason above the rows (DS Feedback: an info banner, no action; recovery
 * is automatic).
 */
export function OfflineReasonNotice() {
  const { formatMessage } = useIntl();
  return (
    <div className="px-3 pt-2" data-testid="offline-reason-notice">
      <Banner status="info" size="sm">
        <Info />
        <BannerDescription>{formatMessage({ id: "layout.offline.indicator" })}</BannerDescription>
      </Banner>
    </div>
  );
}

/**
 * Where the conversation would be: messages are not kept on the device, so
 * offline there is nothing to open. Nothing failed (nothing was asked), so
 * not a warning: an info banner, a limit of being offline (DS Banner: info
 * for "information and limits"), not a skeleton that never ends.
 */
export function OfflineMessagesNotice() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas p-4" data-testid="offline-messages-notice">
      <Banner status="info">
        <Info />
        <BannerTitle>{formatMessage({ id: "layout.offline.title" })}</BannerTitle>
        <BannerDescription>{formatMessage({ id: "layout.offline.messagesUnavailable" })}</BannerDescription>
      </Banner>
    </div>
  );
}
