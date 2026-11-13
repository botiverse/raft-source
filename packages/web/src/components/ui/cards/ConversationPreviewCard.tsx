import { forwardRef } from "react";
import type { ReactNode, MouseEvent, DragEvent } from "react";
import AvatarSlot from "../AvatarSlot";
import Tooltip from "../Tooltip";
import InlineMarkdownPreview from "../../markdown/InlineMarkdownPreview";

type ConversationAuthor =
  | {
      kind: "agent";
      name: string;
      avatarUrl?: string | null;
      subtitle?: string | null;
    }
  | {
      kind: "user";
      name: string;
      avatarUrl?: string | null;
      subtitle?: string | null;
    };

export interface ConversationPreviewCardProps {
  channelLabel: string;
  author?: ConversationAuthor | null;
  timestamp?: string | null;
  preview: string;
  previewAuthor?: string | null;
  previewLeading?: ReactNode;
  previewLineClampClassName?: "line-clamp-2" | "line-clamp-3";
  previewClassName?: string;
  secondaryPreview?: ReactNode;
  secondaryPreviewClassName?: string;
  ariaLabel?: string;
  title?: string;
  testId?: string;
  marker?: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  emphasized?: boolean;
  /**
   * Sticky "this row is the currently-open conversation" highlight — keep it
   * set while the matching detail/thread panel is open so users can see at a
   * glance which list entry corresponds to the panel on the right.
   */
  active?: boolean;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
}

const ConversationPreviewCard = forwardRef<HTMLButtonElement, ConversationPreviewCardProps>(function ConversationPreviewCard({
  channelLabel,
  author,
  timestamp,
  preview,
  previewAuthor,
  previewLeading,
  previewLineClampClassName = "line-clamp-3",
  previewClassName,
  secondaryPreview,
  secondaryPreviewClassName,
  ariaLabel,
  title,
  testId,
  marker,
  footer,
  action,
  emphasized = false,
  active = false,
  onClick,
  onContextMenu,
  draggable,
  onDragStart,
}, ref) {
  const interactive = Boolean(onClick || onContextMenu);
  // Raft Design System › Inbox / ListRow: a preview is content — the card
  // surface with a hairline and the container radius, never an ink line or a
  // lift. Hover lays the row-hover wash over it, press the pressed one. The row that is open next
  // to the list (`active`) is the cyan-soft "this one" highlight.
  const highlighted = active;
  const className = `relative flex w-full items-start gap-3 rounded-container border border-line-hairline p-3 text-left transition-colors ${
    highlighted ? "bg-info-soft" : "bg-layer-card"
  } ${
    interactive
      ? `outline-none focus-visible:shadow-focus ${highlighted ? "" : "hover:overlay-subtle active:overlay-medium"}`
      : "cursor-default"
  }`;
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption">
          <span className="text-foreground-hint">{channelLabel}</span>
          {author && !previewAuthor ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-semibold text-foreground">
              {author.kind === "agent" ? (
                <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={author.avatarUrl ?? null} />
              ) : (
                <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={author.avatarUrl ?? null} />
              )}
              <span className="min-w-0 truncate">{author.name}</span>
              {author.subtitle ? (
                <span className="min-w-0 flex-1 max-w-fit truncate font-mono text-mono-meta font-normal text-foreground-hint">{author.subtitle}</span>
              ) : null}
            </span>
          ) : null}
          {marker}
          {timestamp ? <span className="font-mono text-mono-meta text-foreground-hint">{timestamp}</span> : null}
        </div>
        <p className={`${previewLineClampClassName} text-callout ${emphasized ? "font-bold text-foreground" : "text-foreground-muted"} ${previewClassName ?? ""}`}>
          {previewLeading ? <span className="mr-1 inline-flex align-[-1px]">{previewLeading}</span> : null}
          {previewAuthor ? <span className="font-semibold text-foreground">{previewAuthor}: </span> : null}
          <InlineMarkdownPreview markdown={preview} />
        </p>
        {secondaryPreview ? (
          <p className={`mt-1 line-clamp-1 text-caption ${secondaryPreviewClassName ?? "text-foreground-hint"}`}>
            {secondaryPreview}
          </p>
        ) : null}
        {footer ? <div className="mt-1 flex items-center gap-3">{footer}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </>
  );

  if (!interactive) {
    const card = (
      <div
        aria-label={ariaLabel}
        data-testid={testId}
        data-active={active ? "true" : undefined}
        aria-current={active ? "true" : undefined}
        className={className}
      >
        {content}
      </div>
    );
    return title ? <Tooltip content={title}>{card}</Tooltip> : card;
  }

  const card = (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      aria-label={ariaLabel}
      data-testid={testId}
      data-active={active ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      className={className}
    >
      {content}
    </button>
  );
  return title ? <Tooltip content={title}>{card}</Tooltip> : card;
});

export default ConversationPreviewCard;
