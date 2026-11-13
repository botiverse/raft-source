import { useEffect, useState } from "react";
import api from "../../api/client";
import { imageGalleryBackgroundClass } from "../../utils/imagePreviewStyles";
import { AttachmentTypeBadge } from "./AttachmentTypeBadge";
import type { ChannelFileEntry } from "./ChannelFilesPanel";
import type { AttachmentUrlResponse, fileTypeIcon } from "./ChannelFilesPanelFileRow";

function imageFitClass(file: ChannelFileEntry): string {
  if (!file.width || !file.height || file.width <= 0 || file.height <= 0) return "object-cover";
  const ratio = file.width / file.height;
  return ratio >= 2.2 || ratio <= 0.55 ? "object-contain" : "object-cover";
}

export function ChannelFileVisual({
  file,
  canPreview,
  icon: Icon,
  compact = false,
}: {
  file: ChannelFileEntry;
  canPreview: boolean;
  icon: ReturnType<typeof fileTypeIcon>;
  /** The 20px leading block of a compact row: the type icon, or a 20px
   *  thumbnail for an image; the name already carries the extension. */
  compact?: boolean;
}) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  // An inline source that failed to load shows the type icon, not a broken image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const candidateSrc = file.thumbnailUrl || fallbackUrl;
  const src = candidateSrc && candidateSrc !== failedSrc ? candidateSrc : null;

  // Async-loader pattern: when `file.id` or `canPreview` changes, reset the
  // fallback URL and (if the file lacks a `thumbnailUrl`) async-fetch a
  // presigned URL. The cascading reset+fetch is intended — a different file
  // needs a different presigned URL. Same family as PR #2530's async-loader
  // FPs. Listed all 3 sister rules per @铁根 msg=2e922c7d broaden strategy.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackUrl(null);
    if (!canPreview || file.thumbnailUrl) return () => {
      cancelled = true;
    };

    api
      .get<AttachmentUrlResponse>(`/attachments/${file.id}/url`)
      .then(({ data }) => {
        if (!cancelled) setFallbackUrl(data.url);
      })
      .catch(() => {
        if (!cancelled) setFallbackUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [canPreview, file.id, file.thumbnailUrl]);

  if (compact) {
    return (
      <span data-row-mark className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] text-foreground-hint" data-testid="channel-file-compact-visual">
        {canPreview && src ? (
          <img
            src={src}
            alt=""
            className={`block size-full border border-line-hairline object-cover ${imageGalleryBackgroundClass} rounded-[4px]`}
            loading="lazy"
            onError={() => setFailedSrc(src)}
          />
        ) : (
          <Icon size={16} aria-hidden="true" />
        )}
      </span>
    );
  }

  return (
    <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line-hairline bg-fill-muted text-foreground-muted">
      {canPreview && src ? (
        <img
          src={src}
          alt=""
          className={`block h-full w-full ${imageFitClass(file)} ${imageGalleryBackgroundClass}`}
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <Icon size={18} />
      )}
      <AttachmentTypeBadge
        filename={file.filename}
        data-message-affordance="channel-file-type-badge"
        className="absolute bottom-0 left-0"
      />
    </span>
  );
}
