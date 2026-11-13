import { useCallback } from "react";
import { useIntl } from "react-intl";
import { ArchiveRestore } from "lucide-react";

import { Button } from "@botiverse/raft-ui";
import type { ArchivedChannel } from "./ArchivedChannelsSection";

export function UnarchiveChannelButton({
  channel,
  busy,
  disabled,
  onUnarchive,
}: {
  channel: ArchivedChannel;
  busy: boolean;
  disabled: boolean;
  onUnarchive: (channel: ArchivedChannel) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => void onUnarchive(channel), [onUnarchive, channel]);
  return (
    <Button
      size="md"
      variant="outline"
      className="w-full sm:w-auto"
      disabled={disabled}
      aria-label={formatMessage(
        { id: "settings.archivedChannels.unarchiveAriaLabel" },
        { name: channel.name },
      )}
      onClick={handleClick}
    >
      <ArchiveRestore size={14} />
      {busy
        ? formatMessage({ id: "channel.edit.unarchiving" })
        : formatMessage({ id: "channel.create.unarchive" })}
    </Button>
  );
}
