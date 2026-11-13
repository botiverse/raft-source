import { Archive, Clock, Download, File, FileText, Image, MapPin, Video } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  FileRow,
} from "@botiverse/raft-ui";
import api from "../../api/client";
import { isHeicImageMimeType } from "../../utils/imageMimeTypes";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import AvatarListRow from "../ui/AvatarListRow";
import AttachmentTooltip from "./attachmentTooltip";
import {
  formatChannelFileSize,
  getChannelFileType,
} from "../../utils/channelFiles";
import type {
  ChannelFileTypeFilter,
} from "../../utils/channelFiles";
import { ChannelFileOverflowMenu } from "./ChannelFileOverflowMenu";
import { ChannelFileVisual } from "./ChannelFileVisual";
import {
  COMPACT_ROW_MONO,
  COMPACT_ROW_STRETCHED,
  COMPACT_ROW_TITLE,
  COMPACT_ROW_TITLE_GROUP,
  COMPACT_ROW_TRAILING,
  COMPACT_ROW_WITH_ACTIONS,
} from "../task/compactRow";
import type { ChannelFileEntry } from "./ChannelFilesPanel";

export interface AttachmentUrlResponse {
  url: string;
  expiresAt: string | null;
}

export function fileTypeIcon(type: Exclude<ChannelFileTypeFilter, "all">) {
  if (type === "image") return Image;
  if (type === "video") return Video;
  if (type === "pdf") return FileText;
  if (type === "archive") return Archive;
  return File;
}

export function isPreviewableImage(file: ChannelFileEntry): boolean {
  const mimeType = file.mimeType.split(";")[0]?.trim().toLowerCase();
  // SVG and HEIC preview only through the server raster thumbnail; the raw
  // file is active content (SVG) or undecodable outside Safari (HEIC).
  if (mimeType === "image/svg+xml" || isHeicImageMimeType(mimeType)) return Boolean(file.thumbnailUrl);
  return mimeType?.startsWith("image/") ?? false;
}

export async function downloadAttachment(file: ChannelFileEntry) {
  const { data } = await api.get(`/attachments/${file.id}/url?disposition=attachment`);
  const link = document.createElement("a");
  link.href = data.url;
  link.download = file.filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Per-file row (task #709 oxlint slice): the row's click handlers close over
// `file`, so they live here — memoized per row — instead of being recreated
// as inline closures for every row on every panel render.
export function ChannelFilesPanelFileRow({
  file,
  onOpenPreview,
  onOpenSource,
  compact = false,
}: {
  file: ChannelFileEntry;
  onOpenPreview: (file: ChannelFileEntry) => Promise<void>;
  onOpenSource: (file: ChannelFileEntry) => void;
  /** The Files card's compact row (see ChannelFilesPanel). */
  compact?: boolean;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime, formatCompactDate, formatMediumDateTime } = useTimeFormatter();
  const type = getChannelFileType(file);
  const Icon = fileTypeIcon(type);
  const canPreview = isPreviewableImage(file);

  const handlePreview = useCallback(() => {
    void onOpenPreview(file);
  }, [onOpenPreview, file]);
  const handleOpenSource = useCallback(() => {
    onOpenSource(file);
  }, [onOpenSource, file]);
  const handleDownload = useCallback(() => {
    void downloadAttachment(file);
  }, [file]);
  const previewButtonProps = useMemo(
    () => ({ "aria-label": formatMessage({ id: "message.channelFilesPanel.previewFile" }) }),
    [formatMessage],
  );

  const actions = (
    <div className="channel-file-responsive-actions" data-testid="channel-file-responsive-actions">
      <div className="channel-file-inline-actions" data-testid="channel-file-inline-actions">
        <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}>
          <Button
            onClick={handleOpenSource}
            size="icon-md"
            variant="ghost"
            aria-label={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
            data-testid="channel-file-inline-jump"
          >
            <MapPin size={14} />
          </Button>
        </AttachmentTooltip>
        <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}>
          <Button
            onClick={handleDownload}
            size="icon-md"
            variant="ghost"
            aria-label={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
            data-testid="channel-file-inline-download"
          >
            <Download size={14} />
          </Button>
        </AttachmentTooltip>
      </div>
      <div className="channel-file-overflow-actions">
        <ChannelFileOverflowMenu
          file={file}
          onOpenSource={handleOpenSource}
          onDownload={handleDownload}
        />
      </div>
    </div>
  );

  if (compact) {
    // One line: the type icon, the name with its size right after it, then
    // the compact time and the actions at the right. At a card's 320px the
    // row stays on one line; the right group wraps, whole, only where the
    // name would get less than 160px. The preview button stretches over the
    // row (the whole row opens the file) and the actions sit on top of it, so
    // each stays its own button (raft-design patterns/tasks.md, "Rows in a
    // compact list"). `channel-file-row` keeps the container the responsive
    // actions measure (index.css).
    return (
      <div className={`channel-file-row ${COMPACT_ROW_WITH_ACTIONS}`} data-testid="channel-file-row" data-file-id={file.id}>
        <button type="button" onClick={handlePreview} className={COMPACT_ROW_STRETCHED} {...previewButtonProps}>
          <ChannelFileVisual file={file} canPreview={canPreview} icon={Icon} compact />
          <span className={COMPACT_ROW_TITLE_GROUP}>
            {/* Above the stretched hit area, so its tooltip (the full name)
                still opens on hover; a press on it still previews. */}
            <AttachmentTooltip content={file.filename}>
              <span className={`relative z-raised ${COMPACT_ROW_TITLE}`} data-testid="channel-file-name">{file.filename}</span>
            </AttachmentTooltip>
            <span className={COMPACT_ROW_MONO} data-testid="channel-file-size">{formatChannelFileSize(file.sizeBytes, formatMessage)}</span>
          </span>
        </button>
        <span className={COMPACT_ROW_TRAILING}>
          {/* Compact: the clock today, the month and day this year, the
              ISO date before, so the row keeps to one line in the card. */}
          <time dateTime={file.createdAt} title={formatMediumDateTime(file.createdAt)} className={COMPACT_ROW_MONO} data-testid="channel-file-time">
            {formatCompactDate(file.createdAt)}
          </time>
          {/* The last icon box ends on the row's margin, its hit area hanging
              outward ((32px button - 14px icon) / 2), as a chevron's does in
              the task rows (raft-design foundations/alignment.md). It hangs
              into the padding above and below by as much as it is taller
              than the row's line, so it takes no more than the line: a file
              row is as tall as a task row (34px with a mouse), and the
              button is centred on the text's line. With a mouse the button
              is raft-ui's 28px bar button, so its inset is 7px. */}
          <span data-row-mark className="relative z-raised -my-[calc((2rem-var(--text-callout--line-height))/2)] -mr-[9px] md:pointer-fine:-my-[calc((var(--bar-button-size)-var(--text-callout--line-height))/2)] md:pointer-fine:-mr-[7px] md:pointer-fine:**:data-[slot=button]:size-(--bar-button-size) md:pointer-fine:**:data-[slot=button]:rounded-(--bar-button-radius)">{actions}</span>
        </span>
      </div>
    );
  }

  return (
    <FileRow className="contents">
    <AvatarListRow
      align="start"
      avatar={<ChannelFileVisual file={file} canPreview={canPreview} icon={Icon} />}
      name={<AttachmentTooltip content={file.filename}><span>{file.filename}</span></AttachmentTooltip>}
      subtitle={
        <>
          <span>{formatChannelFileSize(file.sizeBytes, formatMessage)}</span>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} />
            {formatShortDateTime(file.createdAt)}
          </span>
        </>
      }
      onClick={handlePreview}
      buttonProps={previewButtonProps}
      actionContent={actions}
      className="channel-file-row"
    />
    </FileRow>
  );
}
