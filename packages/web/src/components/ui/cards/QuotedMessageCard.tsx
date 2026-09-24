import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Hash, MessageSquare } from "lucide-react";
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
    gravatarHash?: string;
    kind: "agent" | "user" | "external_projection";
    subtitle?: string;
  };
  content: string;
  attachments?: { label: string }[];
  onClick?: () => void;
  unavailable?: boolean;
}

export function Tag({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 border-[1.5px] border-black px-1.5 py-0.5 text-[11px] font-bold leading-none ${className}`}>
      {children}
    </span>
  );
}

export function ThreadMarker() {
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-1 font-bold text-brutal-pink">
      <MessageSquare size={10} className="shrink-0" />
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

  return <AvatarSlot context="compact-list" type="human" humanAvatarUrl={author.avatar ?? null} gravatarHash={author.gravatarHash ?? null} />;
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
}: QuotedMessageCardProps) {
  const intl = useIntl();
  if (unavailable) {
    return (
      <PreviewShell variant="muted" onClick={onClick} data-testid="quoted-message-card" className="group block w-full text-left">
        <div className="px-2.5 py-2 sm:px-3 sm:py-2.5">
          <div className="text-[13px] leading-snug">{intl.formatMessage({ id: "ui.quotedMessage.unavailable" })}</div>
        </div>
      </PreviewShell>
    );
  }

  return (
    <PreviewShell onClick={onClick} data-testid="quoted-message-card" className="group block w-full text-left">
      <div className="px-2.5 py-2 sm:px-3 sm:py-2.5">
        <div className="mb-1 flex items-start gap-2 sm:mb-1.5">
          <div className="min-w-0 flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-none">
            <span className="inline-flex items-center gap-1 font-bold text-black/70">
              {channelKind === "dm" ? null : <Hash size={11} className="shrink-0" />}
              {channelKind === "dm" ? `@${channelName}` : channelName}
            </span>
            <span className="text-black/30">·</span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <CompactUserAvatar author={author} />
              <span className="truncate font-bold text-black/70">{author.name}</span>
              {author.subtitle ? (
                <span className="truncate font-mono text-[10px] text-black/40">{author.subtitle}</span>
              ) : null}
            </span>
            {isThread ? (
              <>
                <span className="text-black/30">·</span>
                <ThreadMarker />
              </>
            ) : null}
            {isArchived ? (
              <>
                <span className="text-black/30">·</span>
                <Tag className="bg-brutal-orange/30 text-black">
                  {intl.formatMessage({ id: "ui.quotedMessage.archived" })}
                </Tag>
              </>
            ) : null}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-black/40">{timestamp}</span>
        </div>
        <div className="min-w-0">
          <div className="line-clamp-2 text-xs leading-snug text-black sm:text-[13px]">
            <InlineMarkdownPreview markdown={content} />
          </div>
          {attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <Tag key={attachment.label} className="bg-brutal-lavender font-mono text-[10px] font-bold text-black">
                  {attachment.label}
                </Tag>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </PreviewShell>
  );
}
