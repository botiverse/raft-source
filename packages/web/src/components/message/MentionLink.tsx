import { useContext, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { IntlContext } from "react-intl";
import { MessageReferenceReadMark, MessageReferenceText, PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@botiverse/raft-ui";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { enFallback } from "../../i18n/messages/enFallback";
import { useAuthStore } from "../../store/authStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { projectAgentReadReceipt } from "../../store/readReceiptDomain";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelExternalMember } from "../../hooks/useChannelMembers";
import ProfilePreviewCardContent from "./DeferredProfilePreviewCardContent";
import { ExternalIdentityPreviewBody } from "./ExternalIdentityPreviewCard";
import { useMessageReadReceiptScope } from "./messageReadReceiptScope";

interface MentionLinkProps {
  mentionType: "agent" | "user" | "external";
  mentionId: string;
  /** Zero-arg legacy navigation. Prefer the typed pair below so callers can
   *  pass stable references instead of per-item closures. */
  onNavigate?: () => void;
  /** Typed navigation pair — used (by mentionType) when `onNavigate` is absent. */
  onNavigateAgent?: (agentId: string) => void;
  onNavigateHuman?: (userId: string) => void;
  children: ReactNode;
  /** Handle from the mention token, so the hover card can render a graceful
   *  non-empty state when the entity is not in the local store. */
  fallbackLabel?: string;
  fallbackAgent?: Agent | null;
  fallbackMember?: ServerMember | null;
  /** Linked-provider member (Slack) for `type:"external"` mentions. */
  fallbackExternal?: ChannelExternalMember | null;
  /** Click handler for external mentions — opens the external-identity
   *  panel via `useProfileStore.openExternalProfile` (same flow a Slack-
   *  authored message avatar uses). */
  onNavigateExternal?: (profile: ExternalMessageAuthorProjection) => void;
  /** Draw a mention of the person reading as the yellow "you" sticker (default).
   *  False: bold ink like anyone else's, for text that names people rather than
   *  mentioning them (an action card's values). */
  highlightSelf?: boolean;
}

export default function MentionLink({ mentionType, mentionId, onNavigate, onNavigateAgent, onNavigateHuman, onNavigateExternal, children, fallbackLabel, fallbackAgent, fallbackMember, fallbackExternal, highlightSelf = true }: MentionLinkProps) {
  const viewerUserId = useAuthStore((s) => s.user?.id ?? null);
  const isSelfMention = highlightSelf && mentionType === "user" && viewerUserId === mentionId;
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const handleNavigate = useCallback(() => {
    if (onNavigate) {
      onNavigate();
      return;
    }
    if (mentionType === "agent") onNavigateAgent?.(mentionId);
    else if (mentionType === "user") onNavigateHuman?.(mentionId);
    // `external` has no Raft principal — render as plain text, no navigation.
  }, [onNavigate, onNavigateAgent, onNavigateHuman, mentionType, mentionId]);
  const handleTriggerClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewActionsRef.current?.close();
    handleNavigate();
  }, [handleNavigate]);

  // MentionLink is mounted standalone by some seams (e.g. mentionFirstPaint)
  // with no IntlProvider, so an unconditional useIntl() throws there. Same
  // context+catalog fallback CollapsibleMessageContent uses.
  const intl = useContext(IntlContext);

  // #693: read state for THIS agent on THIS message. Only agent mentions carry
  // a badge; human read state is deliberately not surfaced (artin 2026-07-27).
  const readScope = useMessageReadReceiptScope();
  // App-owned bots carry no read semantics a sender can act on — the badge's
  // "has this agent seen it" question has no operational answer for them, so
  // the mention renders without the corner mark (yezizp, 2026-10-21).
  const mentionedAgent = useAgentStore((s) => (mentionType === "agent" ? s.agents.find((a) => a.id === mentionId) : undefined));
  const isManagedBot = Boolean((mentionedAgent ?? fallbackAgent)?.managedByAppInstallId);
  const agentReadEligible = mentionType === "agent" && !!readScope?.enabled && !isManagedBot;
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
  // "unknown" = summary-only scope, not hydrated, or not a peer: the card says
  // nothing rather than implying "Not read yet".
  // A read mention carries raft-ui's read mark at its top right: a bare lime
  // check, no light and no box. An unread one shows nothing, and its hover
  // card says "Not read yet" (message-item.md, "Read receipts on a mention",
  // raft-ui 0.34).
  const readLabel = intl?.formatMessage({ id: "message.mention.agentRead" }) ?? enFallback["message.mention.agentRead"];
  const mentionContent = agentReadState === "read"
    ? (
      <>
        {children}
        <MessageReferenceReadMark data-testid={`mention-read-${mentionId}`} data-mention-read-state="read">
          {readLabel}
        </MessageReferenceReadMark>
      </>
    )
    : children;
  const readReceipt = agentReadState === "unknown" ? undefined : agentReadState;

  // External (provider-side) mentions carry no Raft principal, but hover and
  // click follow the same affordances as @human/@agent (yezizp): hover shows
  // the shared ExternalIdentityPreviewBody, click opens the external-identity
  // panel via `onNavigateExternal` (same flow a Slack-authored avatar uses).
  const handleExternalClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewActionsRef.current?.close();
    if (!fallbackExternal) return;
    onNavigateExternal?.({
      projectionId: fallbackExternal.id,
      provider: fallbackExternal.provider,
      appRegistrationId: "", // members endpoint intentionally omits provider-side ids
      installId: "",
      workspaceId: "",
      externalActorId: "",
      workspaceName: fallbackExternal.workspaceName,
      externalConversationId: "",
      externalMessageId: "",
      displayName: fallbackExternal.displayName,
      actorKind: fallbackExternal.actorKind,
      avatarUrl: fallbackExternal.avatarUrl,
      avatarDigest: null,
      actorProjectionRevision: 0,
    });
  }, [fallbackExternal, onNavigateExternal]);

  if (mentionType === "external") {
    return (
      <PreviewCard actionsRef={previewActionsRef}>
        <PreviewCardTrigger
          delay={200}
          closeDelay={120}
          render={(
            <MessageReferenceText
              variant="secondary"
              render={<a href="#">{children}</a>}
            />
          )}
          onClick={handleExternalClick}
        >
          {children}
        </PreviewCardTrigger>
        <PreviewCardContent sideOffset={6} collisionPadding={6}>
          <ExternalIdentityPreviewBody
            displayName={fallbackExternal?.displayName ?? fallbackLabel ?? ""}
            provider={fallbackExternal?.provider}
            workspaceName={fallbackExternal?.workspaceName}
            actorKind={fallbackExternal?.actorKind}
            avatarUrl={fallbackExternal?.avatarUrl}
          />
        </PreviewCardContent>
      </PreviewCard>
    );
  }

  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={(
          <MessageReferenceText
            variant={isSelfMention ? "primary" : "secondary"}
            render={<a href="#">{mentionContent}</a>}
          />
        )}
        onClick={handleTriggerClick}
      >
        {mentionContent}
      </PreviewCardTrigger>
      <PreviewCardContent sideOffset={6} collisionPadding={6}>
        <ProfilePreviewCardContent
          mentionType={mentionType}
          mentionId={mentionId}
          fallbackLabel={fallbackLabel}
          fallbackAgent={fallbackAgent}
          fallbackMember={fallbackMember}
          readReceipt={readReceipt}
        />
      </PreviewCardContent>
    </PreviewCard>
  );
}
