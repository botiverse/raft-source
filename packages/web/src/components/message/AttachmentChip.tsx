import { Download, Eye, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { Message } from "../../store/messageStore";
import PreviewShell from "../ui/PreviewShell";
import AttachmentTooltip from "./attachmentTooltip";
import Spinner from "../ui/Spinner";

type MessageAttachment = NonNullable<Message["attachments"]>[number];

// `variant` is retained for callsite compatibility but the visual layout is
// now unified across types. stdrc 2026-05-20 #proj-theme:441c8b2b: "包括整个
// 不同的 attachment chip 内容物的 layout 和字体大小也全都要统一" — both compact
// and wide now render the same canonical chip (filename / meta / optional
// summary stacked vertically) with the affordance icon pinned to the
// bottom-right corner. The exception is the inline image gallery (separate
// surface, see `buildImageGalleryRows` in MessageItem) which keeps its
// preview-image-in-top-left layout per stdrc's exception.
type AttachmentChipVariant = "compact" | "wide";

interface AttachmentChipProps {
  attachment: MessageAttachment;
  /** Retained for callsite compatibility. Layout is unified across variants;
   *  only the message-flow grouping differs. */
  variant: AttachmentChipVariant;
  isOptimistic: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onClick?: () => void;
  affordance?: "download" | "preview" | "none";
  affordanceName?: string;
  meta?: ReactNode;
  summary?: ReactNode;
  secondaryDownload?: {
    onClick: () => void;
    label: string;
    affordanceName?: string;
  };
  /** Unused under the unified layout; retained for callsite compatibility. */
  icon?: ReactNode;
  /** Overrides the accessible name; defaults to the filename. */
  ariaLabel?: string;
}

// Layout-only token (border / bg / hover / active provided by PreviewShell so
// the press-flash + hover-bg stay aligned with QuotedMessageCard — stdrc
// 2026-05-22 #proj-theme:441c8b2b 7d19c377 / 4365db5a). messageAttachmentChip
// Width.test still pins this literal because the width-contract guards
// (w-44 / min-w-44 / max-w-44 / shrink-0 / overflow-hidden) live here.
const COMPACT_CHIP_LAYOUT = "group/img relative inline-flex h-20 w-44 min-w-44 max-w-44 shrink-0 flex-col justify-between overflow-hidden px-2.5 py-2 text-left transition-colors";
// Wide-variant alias preserved for downstream width-contract callers.
const WIDE_CHIP_LAYOUT = COMPACT_CHIP_LAYOUT;

function TruncatedAttachmentTooltip({
  content,
  className,
  affordance,
  children,
}: {
  content: ReactNode;
  className: string;
  affordance: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const node = ref.current;
    setIsTruncated(Boolean(node && node.scrollWidth > node.clientWidth + 1));
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const text = (
    <span
      ref={ref}
      data-message-affordance={affordance}
      className={className}
      onMouseEnter={measure}
    >
      {children}
    </span>
  );

  if (!isTruncated) return text;
  return <AttachmentTooltip content={content}>{text}</AttachmentTooltip>;
}

export function AttachmentChip({
  attachment,
  variant: _variant,
  isOptimistic,
  loading = false,
  loadingLabel,
  onClick,
  affordance = "none",
  affordanceName,
  meta,
  summary,
  secondaryDownload,
  icon: _icon,
  ariaLabel,
}: AttachmentChipProps) {
  const { formatMessage } = useIntl();
  const resolvedLoadingLabel = loadingLabel ?? formatMessage({ id: "message.attachment.openingPreview" });
  const disabled = isOptimistic || loading || !onClick;
  // Per-state bg overrides PreviewShell's default `bg-white` via Tailwind's
  // important modifier. Normal state inherits `hover:bg-black/5` from
  // PreviewShell (no active token — press inherits hover). Loading uses a
  // solid yellow tint without any opacity modifier so it sidesteps the
  // Chromium `color-mix(in oklab, …, transparent)` × element-opacity
  // cyan-rendering edge case; the loading bar + spinner remain the dominant
  // busy signal regardless.
  const stateClassName = isOptimistic
    ? "opacity-70"
    : loading
      ? "!bg-soft-signal/30 cursor-wait"
      : "";
  // Single canonical affordance box: bottom-right, no border, fixed 20px tap
  // boxes so sibling preview/download icons share the same baseline.
  const affordanceClassName = "absolute bottom-1.5 flex size-5 shrink-0 items-center justify-center text-black/60 group-hover/img:text-black";
  const loadingBar = (
    <div
      data-message-affordance="attachment-preview-loading"
      className="absolute inset-x-0 bottom-0 flex h-6 items-center gap-1.5 border-t-2 border-black bg-soft-signal px-2 text-[10px] font-bold uppercase tracking-wide text-black"
    >
      <Spinner size="xs" />
      <span className="truncate">{resolvedLoadingLabel}</span>
    </div>
  );

  const shell = (
    <PreviewShell
      onClick={disabled ? undefined : onClick}
      aria-busy={loading ? "true" : undefined}
      aria-label={ariaLabel ?? attachment.filename}
      className={`${COMPACT_CHIP_LAYOUT}${stateClassName ? ` ${stateClassName}` : ""}`}
    >
      <div data-message-affordance="attachment-text-slot" className="w-full min-w-0 max-w-full overflow-hidden">
        <TruncatedAttachmentTooltip
          content={attachment.filename}
          affordance="attachment-filename"
          className="block w-full max-w-full truncate text-xs font-bold text-black"
        >
          {attachment.filename}
        </TruncatedAttachmentTooltip>
        {meta || (attachment.commentCount ?? 0) > 0 ? (
          <div className="mt-0.5 flex min-w-0 max-w-full items-center overflow-hidden text-[10px] text-black/45">
            {meta}
            {/* Scoped attachment-comment count (MVP §5): rendered inside the
                existing meta line — text-language badge, no new chip layer.
                Suppressed for pdf/image: those surfaces have no comment
                entry (descoped, cindyz 6/11), so a count would dead-end. */}
            {(attachment.commentCount ?? 0) > 0
              && !attachment.mimeType?.startsWith("image/")
              && attachment.mimeType?.split(";")[0]?.trim().toLowerCase() !== "application/pdf" ? (
              <span data-message-affordance="attachment-comment-count" className="inline-flex items-center gap-1 pl-1">
                {meta ? <span className="text-black/35">·</span> : null}
                <MessageSquare size={9} className="shrink-0" />
                {attachment.commentCount}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {summary ? (
        <div
          data-message-affordance="attachment-summary-slot"
          className="flex min-w-0 max-w-full items-center overflow-hidden pr-6 font-mono text-[10px] font-bold tracking-[-0.04em] whitespace-nowrap"
        >
          <TruncatedAttachmentTooltip
            content={summary}
            affordance="attachment-summary-text"
            className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden truncate"
          >
            {summary}
          </TruncatedAttachmentTooltip>
        </div>
      ) : null}
      {loading ? loadingBar : isOptimistic ? (
        <Spinner size="sm" className="absolute bottom-2 right-2" />
      ) : affordance === "download" ? (
        <div
          data-message-affordance={affordanceName ?? "file-download"}
          className={`${affordanceClassName} right-1.5`}
        >
          <Download size={12} />
        </div>
      ) : affordance === "preview" ? (
        <div
          data-message-affordance={affordanceName ?? "file-preview"}
          className={`${affordanceClassName} right-1.5`}
        >
          <Eye size={12} />
        </div>
      ) : null}
      </PreviewShell>
  );

  if (!secondaryDownload || isOptimistic) return shell;

  return (
    <div className="relative inline-block h-20 w-44 min-w-44 max-w-44 shrink-0 align-top">
      {shell}
      <button
        type="button"
        data-message-affordance={secondaryDownload.affordanceName ?? "file-download"}
        aria-label={secondaryDownload.label}
        className={`${affordanceClassName} right-7 hover:text-black`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          secondaryDownload.onClick();
        }}
      >
        <Download size={12} />
      </button>
    </div>
  );
}

export const ATTACHMENT_CHIP_CLASS_CONTRACT = {
  compact: COMPACT_CHIP_LAYOUT,
  wide: WIDE_CHIP_LAYOUT,
};
