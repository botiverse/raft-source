import { useIntl } from "react-intl";

import type { Channel } from "../../store/channelStore";
import ChannelSideCard from "../task/ChannelSideCard";
import { ChannelFilesPanel } from "./DeferredChannelFilesPanel";

/** The channel's files, in the card beside the message list (was the Files tab). */
export default function ChannelFilesCard({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <ChannelSideCard
      title={formatMessage({ id: "message.chatPanel.tabFiles" })}
      closeLabelId="message.chatPanel.filesCard.close"
      onClose={onClose}
      testId="channel-files-card"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelFilesPanel channel={channel} variant="compact" />
      </div>
    </ChannelSideCard>
  );
}
