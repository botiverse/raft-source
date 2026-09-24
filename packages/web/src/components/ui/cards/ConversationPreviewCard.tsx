import { forwardRef } from "react";
import type { ReactNode, MouseEvent, DragEvent } from "react";
import AvatarSlot from "../AvatarSlot";
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
      gravatarHash?: string | null;
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
   * One-shot focus highlight (e.g. after opening a permalink or dblclicking
   * the Inbox sidebar entry). Keep this visually aligned with message
   * permalink focus so "jumped here" reads the same across list surfaces.
   * Owners are responsible for clearing this state after the user has had
   * time to notice it.
   */
  focused?: boolean;
  /**
   * Sticky "this row is the currently-open conversation" highlight — keep it
   * set while the matching detail/thread panel is open so users can see at a
   * glance which list entry corresponds to the panel on the right. Distinct
   * from `focused`, which is a transient flash.
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
  focused = false,
  active = false,
  onClick,
  onContextMenu,
  draggable,
  onDragStart,
}, ref) {
  const interactive = Boolean(onClick || onContextMenu);
  const className = `relative flex w-full items-start gap-3 border-2 p-3 text-left transition-colors hover:border-black hover:shadow-brutal-sm ${
    interactive ? `active:border-black active:shadow-brutal-sm` : "cursor-default"
  } ${
    focused
      ? "border-black bg-brutal-cyan/25 shadow-brutal"
      : active
      ? "border-black bg-white shadow-brutal-sm"
      : "border-black/30 bg-white"
  }`;
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-4">
          <span className="font-bold text-black/50">{channelLabel}</span>
          {author && !previewAuthor ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-bold text-black">
              {author.kind === "agent" ? (
                <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={author.avatarUrl ?? null} />
              ) : (
                <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={author.avatarUrl ?? null} gravatarHash={author.gravatarHash ?? null} />
              )}
              <span className="truncate">{author.name}</span>
              {author.subtitle ? (
                <span className="font-mono text-[10px] text-black/40">{author.subtitle}</span>
              ) : null}
            </span>
          ) : null}
          {marker}
          {timestamp ? <span className="font-mono text-xs leading-4 text-black/40">{timestamp}</span> : null}
        </div>
        <p className={`${previewLineClampClassName} text-sm ${emphasized ? "font-bold" : ""} ${previewClassName ?? ""}`}>
          {previewLeading ? <span className="mr-1 inline-flex align-[-1px]">{previewLeading}</span> : null}
          {previewAuthor ? <span className="font-bold text-black/70">{previewAuthor}: </span> : null}
          <InlineMarkdownPreview markdown={preview} />
        </p>
        {secondaryPreview ? (
          <p className={`mt-1 line-clamp-1 text-xs ${secondaryPreviewClassName ?? "text-black/45"}`}>
            {secondaryPreview}
          </p>
        ) : null}
        {footer ? <div className="mt-1 flex items-center gap-3">{footer}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </>
  );

  if (!interactive) {
    return (
      <div
        aria-label={ariaLabel}
        title={title}
        data-testid={testId}
        data-focused={focused ? "true" : undefined}
        data-active={active ? "true" : undefined}
        aria-current={focused || active ? "true" : undefined}
        className={className}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      aria-label={ariaLabel}
      title={title}
      data-testid={testId}
      data-focused={focused ? "true" : undefined}
      data-active={active ? "true" : undefined}
      aria-current={focused || active ? "true" : undefined}
      className={className}
    >
      {content}
    </button>
  );
});

export default ConversationPreviewCard;
