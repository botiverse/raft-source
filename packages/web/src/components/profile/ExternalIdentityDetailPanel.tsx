import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { PanelAction, ProfilePanelBody, Separator, ScrollArea } from "@botiverse/raft-ui";
import { X } from "lucide-react";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import AvatarSlot from "../ui/AvatarSlot";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import {
  EXTERNAL_ACTOR_KIND_MESSAGE_IDS,
  formatExternalProviderLabel,
} from "../message/externalIdentityPresentation";
import { RowExpandAction } from "../layout/RowExpandAction";
import { RowMoveMenu } from "../layout/ColumnMoveMenu";
import { RowRegionBody } from "../layout/RowRegionBody";

const HEADER_CONTAINER_PROPS = { "data-testid": "external-identity-header" };

export default function ExternalIdentityDetailPanel({
  profile,
  onBack,
  onClose,
}: {
  profile: ExternalMessageAuthorProjection;
  onBack?: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const headerBack = onBack ?? onClose;
  const displayName = profile.actorKind === "bot" ? profile.profileDisplayName || profile.displayName : profile.displayName;
  const avatarUrl = profile.actorKind === "bot" && profile.profileAvatarUrl !== undefined ? profile.profileAvatarUrl : profile.avatarUrl;
  const providerLabel = formatExternalProviderLabel(profile.provider, formatMessage);
  const actorKindLabel = formatMessage({
    id: EXTERNAL_ACTOR_KIND_MESSAGE_IDS[profile.actorKind ?? "unknown"],
  });
  const subtitle = profile.actorKind === "bot" && profile.appName ? actorKindLabel : providerLabel
    ? formatMessage(
        { id: "message.externalIdentity.providerAndKind" },
        { provider: providerLabel, kind: actorKindLabel },
      )
    : actorKindLabel;
  const mobileBackProps = useMemo(() => ({
    "data-testid": "external-mobile-back",
    title: formatMessage({ id: "common.announcement.back" }),
  }), [formatMessage]);

  return (
    <>
      <PanelHeader
        title={displayName}
        subtitle={subtitle}
        iconSlot={
          <AvatarSlot
            context="panel-header"
            type="app"
            appAvatarUrl={avatarUrl}
            appInitials={displayName}
          />
        }
        iconAlwaysVisible
        iconKind="avatar"
        onMobileBack={headerBack}
        backButtonVisibility={onBack ? "always" : "responsive"}
        mobileBackProps={mobileBackProps}
        containerProps={HEADER_CONTAINER_PROPS}
        actions={
          <>
            {/* The profile's Expand (#189 rule 5), a window control against Close; none outside the planned row. */}
            <RowMoveMenu />
            <RowExpandAction />
            {/* DS header icon button, as on the human and agent profiles. */}
            <PanelAction
              onClick={onClose}
              className={onBack ? "flex" : "hidden md:flex"}
              aria-label={formatMessage({ id: "common.close" })}
              title={formatMessage({ id: "common.close" })}
            >
              <X size={22} aria-hidden="true" />
            </PanelAction>
          </>
        }
      />

      {/* Hidden while a region expanded in its column shows the profile as its head alone (#189 rule 5). */}
      <RowRegionBody>
      {/* The body renders as a raft-ui ScrollArea (its column layout kept):
          a region named after the profile, a tab stop once it overflows. */}
      {/* raft-ui: native-scroll restates the ScrollArea's own overflow, which PanelBody's recipe (overflow-hidden) would otherwise override */}
      <ProfilePanelBody render={<ScrollArea role="region" aria-label={displayName} />} className="flex-1 overflow-x-hidden overflow-y-auto bg-layer-canvas">
        {(profile.actorKind === "bot" && profile.appName && providerLabel) ? (
          <div data-testid="external-identity-source" className="px-(--surface-inset) py-3 text-callout font-semibold text-foreground">
            {formatMessage({ id: "message.externalIdentity.fromWorkspace" }, { workspace: `${providerLabel} · ${profile.appName}` })}
          </div>
        ) : profile.workspaceName ? (
          <div>
          <div
            data-testid="external-identity-source"
            className="px-(--surface-inset) py-3"
          >
            <SectionEyebrow as="div" className="mb-1">
              {formatMessage({ id: "member.detail.from" })}
            </SectionEyebrow>
            <div className="text-callout font-semibold text-foreground">
              {profile.workspaceName}
            </div>
          </div>
          <Separator />
          </div>
        ) : null}

        <div className="flex items-start gap-4 px-(--surface-inset) py-5">
          <AvatarSlot
            context="profile-hero"
            type="app"
            appAvatarUrl={avatarUrl}
            appInitials={displayName}
          />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="truncate text-headline text-foreground">
              {displayName}
            </div>
            <div className="mt-0.5 truncate text-caption text-foreground-hint">
              {subtitle}
            </div>
            {profile.actorKind === "bot" && displayName !== profile.displayName ? (
              <div className="mt-1 truncate text-footnote text-foreground-muted">
                {formatMessage({ id: "message.externalIdentity.postedAs" }, { name: profile.displayName })}
              </div>
            ) : null}
            <div className="mt-2 text-callout text-foreground-muted">
              {formatMessage({ id: "message.externalIdentity.externalProjection" })}
            </div>
          </div>
        </div>
      </ProfilePanelBody>
      </RowRegionBody>
    </>
  );
}
