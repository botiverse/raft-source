import { useContext, useRef } from "react";
import type { ReactNode } from "react";
import { IntlContext } from "react-intl";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "raft-ui";
import { en } from "../../i18n/messages/en";
import { useAuthStore } from "../../store/authStore";
import type { Agent } from "../../store/agentStore";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { projectAgentReadReceipt } from "../../store/readReceiptDomain";
import type { ServerMember } from "../../store/serverStore";
import ProfilePreviewCardContent from "./ProfilePreviewCardContent";
import { MSG_REF_CHIP } from "./messageRefChip";
import { useMessageReadReceiptScope } from "./messageReadReceiptScope";

interface MentionLinkProps {
  mentionType: "agent" | "user";
  mentionId: string;
  onNavigate: () => void;
  children: ReactNode;
  /** Handle from the mention token, so the hover card can render a graceful
   *  non-empty state when the entity is not in the local store. */
  fallbackLabel?: string;
  fallbackAgent?: Agent | null;
  fallbackMember?: ServerMember | null;
}

export default function MentionLink({ mentionType, mentionId, onNavigate, children, fallbackLabel, fallbackAgent, fallbackMember }: MentionLinkProps) {
  const viewerUserId = useAuthStore((s) => s.user?.id ?? null);
  const isSelfMention = mentionType === "user" && viewerUserId === mentionId;
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  // MentionLink is mounted standalone by some seams (e.g. mentionFirstPaint)
  // with no IntlProvider, so an unconditional useIntl() throws there. Same
  // context+catalog fallback CollapsibleMessageContent uses.
  const intl = useContext(IntlContext);

  // #693: read state for THIS agent on THIS message. Only agent mentions carry
  // a badge; human read state is deliberately not surfaced (artin 2026-07-27).
  const readScope = useMessageReadReceiptScope();
  const agentReadEligible = mentionType === "agent" && !!readScope?.enabled;
  // Select a PRIMITIVE: returning `{read}` here would hand useSyncExternalStore a
  // fresh object every render and loop forever ("Maximum update depth exceeded").
  const agentReadState = useReadReceiptStore((state): "read" | "unread" | "unknown" => {
    if (!agentReadEligible || !readScope) return "unknown";
    const projected = projectAgentReadReceipt(
      state.scopes[readScope.channelId],
      mentionId,
      readScope.messageSeq,
    );
    if (projected === null) return "unknown";
    return projected.read ? "read" : "unread";
  });
  // "unknown" = summary-only scope, not hydrated, or not a peer. Render nothing
  // rather than implying "unread".
  const readLabelId = agentReadState === "read"
    ? "message.mention.agentRead"
    : "message.mention.agentUnread";
  const readLabel = intl?.formatMessage({ id: readLabelId }) ?? en[readLabelId];
  const readBadge = agentReadState === "unknown"
    ? null
    : (
      <span
        data-mention-read-state={agentReadState}
        data-testid={`mention-read-${mentionId}`}
        title={readLabel}
        aria-label={readLabel}
        // The mention is inline text, so the span's box top sits well above the
        // glyphs (line-height), which made a `-top-1` badge read as floating
        // above the row rather than sitting on the mention's corner. Anchor it
        // down onto the corner and slightly further right (artin, 7-28).
        className={`pointer-events-none absolute -right-1.5 top-0 size-2 shrink-0 rounded-full border border-black ${
          agentReadState === "read" ? "bg-brutal-lime" : "bg-white"
        }`}
      />
    );

  const trigger = (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          previewActionsRef.current?.close();
          onNavigate();
        }}
        className={`cursor-default select-text font-bold text-black ${
          isSelfMention
            ? `${MSG_REF_CHIP} bg-soft-signal hover:bg-soft-signal/80`
            : "underline decoration-black/30 decoration-2 underline-offset-2 hover:text-brutal-pink hover:decoration-brutal-pink"
        }`}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
        <ProfilePreviewCardContent
          mentionType={mentionType}
          mentionId={mentionId}
          fallbackLabel={fallbackLabel}
          fallbackAgent={fallbackAgent}
          fallbackMember={fallbackMember}
        />
      </PreviewCardContent>
    </PreviewCard>
  );

  if (!readBadge) return trigger;

  // The badge hangs off the mention's own top-right corner, so it travels with
  // the token as the markdown line wraps.
  return (
    // `mr-2` reserves the badge's own width. The badge is absolutely positioned
    // so it contributes no layout, and without this the following word collides
    // with it. This wrapper only renders when a badge exists, so unbadged
    // mentions keep their natural spacing.
    <span className="relative mr-2 inline-block align-baseline">
      {trigger}
      {readBadge}
    </span>
  );
}
