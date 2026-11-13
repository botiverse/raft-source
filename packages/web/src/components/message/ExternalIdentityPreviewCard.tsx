import { useRef } from "react";
import { useIntl } from "react-intl";
import type { ExternalActorKind } from "@botiverse/raft-shared";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "@botiverse/raft-ui";
import AvatarSlot from "../ui/AvatarSlot";
import {
  EXTERNAL_ACTOR_KIND_MESSAGE_IDS,
  formatExternalProviderLabel,
} from "./externalIdentityPresentation";

interface ExternalIdentityPreviewCardProps {
  displayName: string;
  provider?: string | null;
  workspaceName?: string | null;
  actorKind?: ExternalActorKind | null;
  avatarUrl?: string | null;
  profileDisplayName?: string | null;
  profileAvatarUrl?: string | null;
  appName?: string | null;
  testId?: string;
  onNavigate: () => void;
}

interface ExternalIdentityPreviewBodyProps {
  displayName: string;
  provider?: string | null;
  workspaceName?: string | null;
  actorKind?: ExternalActorKind | null;
  avatarUrl?: string | null;
  appName?: string | null;
  postedAs?: string | null;
}

/** Shared preview body — extracted so MentionLink (external @-mention) can
 *  reuse the same card chrome the message author avatar uses. */
export function ExternalIdentityPreviewBody({
  displayName,
  provider,
  workspaceName,
  actorKind,
  avatarUrl,
  appName,
  postedAs,
}: ExternalIdentityPreviewBodyProps) {
  const { formatMessage } = useIntl();
  const providerLabel = formatExternalProviderLabel(provider, formatMessage);
  const actorKindLabel = formatMessage({
    id: EXTERNAL_ACTOR_KIND_MESSAGE_IDS[actorKind ?? "unknown"],
  });
  return (
    <div data-testid="external-identity-preview" className="flex items-start gap-3 p-4">
      <AvatarSlot
        context="mention-card"
        type="app"
        appAvatarUrl={avatarUrl}
        appInitials={displayName}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-headline text-foreground">
          {displayName}
        </div>
        <div className="truncate text-footnote text-foreground-muted">
          {actorKind === "bot" && appName ? actorKindLabel : providerLabel
            ? formatMessage(
                { id: "message.externalIdentity.providerAndKind" },
                { provider: providerLabel, kind: actorKindLabel },
              )
            : actorKindLabel}
        </div>
        {actorKind === "bot" && appName && providerLabel ? (
          <div className="mt-1 truncate text-footnote text-foreground-muted">
            {formatMessage({ id: "message.externalIdentity.fromWorkspace" }, { workspace: `${providerLabel} · ${appName}` })}
          </div>
        ) : workspaceName ? (
          <div className="mt-1 truncate text-footnote text-foreground-muted">
            {formatMessage({ id: "message.externalIdentity.fromWorkspace" }, { workspace: workspaceName })}
          </div>
        ) : null}
        {postedAs && postedAs !== displayName ? (
          <div className="mt-1 truncate text-footnote text-foreground-muted">
            {formatMessage({ id: "message.externalIdentity.postedAs" }, { name: postedAs })}
          </div>
        ) : null}
        <div className="mt-1 text-caption text-foreground-hint">
          {formatMessage({ id: "message.externalIdentity.externalProjection" })}
        </div>
      </div>
    </div>
  );
}

export default function ExternalIdentityPreviewCard({
  displayName,
  provider,
  workspaceName,
  actorKind,
  avatarUrl,
  profileDisplayName,
  profileAvatarUrl,
  appName,
  testId,
  onNavigate,
}: ExternalIdentityPreviewCardProps) {
  const { formatMessage } = useIntl();
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
            onClick={() => {
              previewActionsRef.current?.close();
              onNavigate();
            }}
            aria-label={formatMessage(
              { id: "message.externalIdentity.openAria" },
              { name: displayName },
            )}
            data-testid={testId}
            data-avatar-kind="external"
            data-avatar-source={avatarUrl ? "external-avatar" : "placeholder"}
            className="mt-0.5 shrink-0 self-start rounded-sticker border-0 bg-transparent p-0 outline-none transition-[filter] duration-75 hover:brightness-90 focus-visible:shadow-focus"
          >
            <AvatarSlot
              context="panel-header"
              type="app"
              appAvatarUrl={avatarUrl}
              appInitials={displayName}
            />
          </button>
        }
      />
      <PreviewCardContent
        sideOffset={6}
        collisionPadding={6}
      >
        <ExternalIdentityPreviewBody
          displayName={actorKind === "bot" ? profileDisplayName || displayName : displayName}
          provider={provider}
          workspaceName={workspaceName}
          actorKind={actorKind}
          avatarUrl={actorKind === "bot" && profileAvatarUrl !== undefined ? profileAvatarUrl : avatarUrl}
          appName={appName}
          postedAs={actorKind === "bot" && profileDisplayName && profileDisplayName !== displayName ? displayName : null}
        />
      </PreviewCardContent>
    </PreviewCard>
  );
}
