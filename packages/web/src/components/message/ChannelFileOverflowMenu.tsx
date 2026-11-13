import { Download, EllipsisVertical, MapPin } from "lucide-react";
import { useIntl } from "react-intl";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@botiverse/raft-ui";
import AttachmentTooltip from "./attachmentTooltip";
import type { ChannelFileEntry } from "./ChannelFilesPanel";

export function ChannelFileOverflowMenu({
  file,
  onOpenSource,
  onDownload,
}: {
  file: ChannelFileEntry;
  onOpenSource: () => void;
  onDownload: () => void;
}) {
  const { formatMessage } = useIntl();
  const menuLabel = formatMessage(
    { id: "message.channelFilesPanel.fileActions" },
    { filename: file.filename },
  );

  return (
    <DropdownMenu>
      <AttachmentTooltip content={menuLabel}>
        <DropdownMenuTrigger
          render={(
            <Button
              size="icon-md"
              variant="ghost"
              aria-label={menuLabel}
              data-testid="channel-file-overflow-trigger"
              data-file-id={file.id}
            >
              <EllipsisVertical size={14} />
            </Button>
          )}
        />
      </AttachmentTooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label={menuLabel}
        data-testid="channel-file-overflow-menu"
      >
        <DropdownMenuItem
          onClick={onOpenSource}
          data-testid="channel-file-overflow-jump"
        >
          <MapPin />
          {formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onDownload}
          data-testid="channel-file-overflow-download"
        >
          <Download />
          {formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
