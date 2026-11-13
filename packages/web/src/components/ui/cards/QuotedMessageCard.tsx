import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Hash } from "lucide-react";
import {
  Badge,
  MessageQuotedPreviewAttachment,
  MessageQuotedPreviewAttachments,
  MessageQuotedPreviewAuthor,
  MessageQuotedPreviewAuthorMeta,
  MessageQuotedPreviewAuthorName,
  MessageQuotedPreviewChannel,
  MessageQuotedPreviewContent,
  MessageQuotedPreviewHeader,
  MessageQuotedPreviewText,
  MessageQuotedPreviewThread,
  MessageQuotedPreviewTimestamp,
  MessageQuotedPreviewUnavailable,
} from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import type { BadgeProps } from "@botiverse/raft-ui";
import { MessageQuotedPreviewAuthorDelegatedBy } from "@botiverse/raft-ui/wip";
import AvatarSlot from "../AvatarSlot";
import InlineMarkdownPreview from "../../markdown/InlineMarkdownPreview";
import PreviewShell from "../PreviewShell";

export interface QuotedMessageCardProps {
  channelName: string;
  channelKind?: "channel" | "dm";
  isThread?: boolean;
  isArchived?: boolean;
  timestamp: string;
  author: {
    name: string;
    avatar?: string;
    kind: "agent" | "user" | "external_projection";
    subtitle?: string;
    /** RFC 077: "(sent by Friday)" after the name, already in the reader's language. */
    delegatedByLabel?: string;
  };
  content: string;
  attachments?: { label: string }[];
  onClick?: () => void;
  unavailable?: boolean;
  /** The line an unavailable quote shows; defaults to "Message unavailable". */
  unavailableText?: string;
  /** A line in place of the message text (its header stays), e.g. a message
   *  older than the plan's history window. The card is not a button then:
   *  the line carries its own action. */
  notice?: ReactNode;
}

export function Tag({
  children,
  className,
  variant = "muted",
}: {
  children: ReactNode;
  className?: string;
  variant?: BadgeProps["variant"];
}) {
  return (
    <Badge appearance="soft" variant={variant} className={className}>
      {children}
    </Badge>
  );
}

/** "Thread" marker in a preview header. A hint, not a signal: it takes the
 *  part's ink-3 type (raft-ui `MessageQuotedPreviewThread`), no pink. */
export function ThreadMarker() {
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-1">
      <ThreadIcon width={14} height={14} className="shrink-0" aria-hidden="true" />
      {intl.formatMessage({ id: "ui.quotedMessage.thread" })}
    </span>
  );
}

function CompactUserAvatar({ author }: { author: QuotedMessageCardProps["author"] }) {
  if (author.kind === "agent") {
    return <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={author.avatar ?? null} />;
  }

  if (author.kind === "external_projection") {
    return <AvatarSlot context="compact-list" type="app" appAvatarUrl={author.avatar ?? null} appInitials={author.name} />;
  }

  return <AvatarSlot context="compact-list" type="human" humanAvatarUrl={author.avatar ?? null} />;
}

export default function QuotedMessageCard({
  channelName,
  channelKind = "channel",
  isThread = false,
  isArchived = false,
  timestamp,
  author,
  content,
  attachments,
  onClick,
  unavailable = false,
  unavailableText,
  notice,
}: QuotedMessageCardProps) {
  const intl = useIntl();
  if (unavailable) {
    return (
      <PreviewShell variant="muted" onClick={onClick} data-testid="quoted-message-card" className="group block w-full text-left">
        {/* The card is the frame here, so the part's own quote bar is dropped. */}
        <MessageQuotedPreviewUnavailable className="border-l-0 px-3 py-2.5">
          <div>{unavailableText ?? intl.formatMessage({ id: "ui.quotedMessage.unavailable" })}</div>
        </MessageQuotedPreviewUnavailable>
      </PreviewShell>
    );
  }

  return (
    <PreviewShell onClick={notice ? undefined : onClick} data-testid="quoted-message-card" className="group block w-full text-left">
      <div className="px-3 py-2.5">
        <MessageQuotedPreviewHeader className="mb-1 flex items-start gap-2">
          <div className="min-w-0 flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
            <MessageQuotedPreviewChannel className="inline-flex items-center gap-1">
              {channelKind === "dm" ? null : <Hash size={14} className="shrink-0" aria-hidden="true" />}
              {channelKind === "dm" ? `@${channelName}` : channelName}
            </MessageQuotedPreviewChannel>
            <span className="text-foreground-hint">·</span>
            <MessageQuotedPreviewAuthor className="inline-flex min-w-0 items-center gap-1.5">
              <CompactUserAvatar author={author} />
              <MessageQuotedPreviewAuthorName className="min-w-0 truncate">
                {author.name}
              </MessageQuotedPreviewAuthorName>
              {author.delegatedByLabel ? (
                <MessageQuotedPreviewAuthorDelegatedBy data-testid="quoted-message-delegated-by">
                  {author.delegatedByLabel}
                </MessageQuotedPreviewAuthorDelegatedBy>
              ) : null}
              {author.subtitle ? (
                <MessageQuotedPreviewAuthorMeta className="min-w-0 flex-1 max-w-fit truncate">
                  {author.subtitle}
                </MessageQuotedPreviewAuthorMeta>
              ) : null}
            </MessageQuotedPreviewAuthor>
            {isThread ? (
              <>
                <span className="text-foreground-hint">·</span>
                <MessageQuotedPreviewThread>
                  <ThreadMarker />
                </MessageQuotedPreviewThread>
              </>
            ) : null}
            {isArchived ? (
              <>
                <span className="text-foreground-hint">·</span>
                {/* Archived is a stopped state, not a problem: stone, not orange. */}
                <Tag variant="muted">
                  {intl.formatMessage({ id: "ui.quotedMessage.archived" })}
                </Tag>
              </>
            ) : null}
          </div>
          <MessageQuotedPreviewTimestamp className="shrink-0">
            {timestamp}
          </MessageQuotedPreviewTimestamp>
        </MessageQuotedPreviewHeader>
        <MessageQuotedPreviewContent className="min-w-0">
          <MessageQuotedPreviewText className="line-clamp-2">
            {notice ?? <InlineMarkdownPreview markdown={content} />}
          </MessageQuotedPreviewText>
          {!notice && attachments?.length ? (
            <MessageQuotedPreviewAttachments className="flex flex-wrap gap-1.5">
              {/* The raft-ui attachment part is itself the DS token chip
                  (22px, sunken fill, Space Mono), so the label sits in it
                  directly rather than in a second badge. */}
              {attachments.map((attachment) => (
                <MessageQuotedPreviewAttachment key={attachment.label}>
                  {attachment.label}
                </MessageQuotedPreviewAttachment>
              ))}
            </MessageQuotedPreviewAttachments>
          ) : null}
        </MessageQuotedPreviewContent>
      </div>
    </PreviewShell>
  );
}
