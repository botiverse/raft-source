import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, Separator } from "@botiverse/raft-ui";
import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { AppSetupPanel, AppSetupRequirement } from "../../components/integrations/AppSetup";
import { AppPermissionSetList } from "../../components/integrations/AppPermissionSetList";
import { AppPromptTextBlock } from "../../components/integrations/AppPromptText";
import { AppNotificationRequestSummary } from "../../components/settings/AppNotificationsControls";
import { MarketplacePromptTextReview } from "../../components/settings/AppPromptTextPanels";
import { ConnectedAppBotInstallOption } from "../../components/settings/ConnectedAppBot";
import { ConnectedAppLogo } from "../../components/settings/ConnectedAppLogo";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "./connected-apps/connectedAppCatalog";
import { ConnectedAppDetailModal } from "./connected-apps/ConnectedAppDetailModal";
import { ConnectedAppDetailRow } from "./connected-apps/ConnectedAppDetailRow";
import { ConnectedAppDetailSection } from "./connected-apps/ConnectedAppDetailSection";
import { ConnectedAppMarketplaceInstallBadge } from "./connected-apps/ConnectedAppMarketplaceInstallBadge";
import { OAuthScopeSummaryPanel } from "./connected-apps/OAuthScopeSummaryPanel";
import { ConnectedAppUrlLink } from "./connected-apps/ConnectedAppUrlLink";
import type { ConnectedAppListing } from "./connected-apps/connectedAppTypes";

const TITLE_ID = "connected-app-detail-title";
const ADD_ID = "connected-app-detail-add";

/**
 * A Raft App's details from the Marketplace (Discover, and the Recommended
 * cards on Yours): what it is, what it may ask for, and, for owners and
 * admins while this Server hasn't added it, what adding it approves. Add sits
 * at the head's top-right (R41) and adds it with what this detail shows
 * (the "Installing approves" section: its permissions, its bot, its agent
 * text). A card's own Add skips the detail: it opens the same set as a
 * confirmation (`MarketplaceInstallConfirm`). Everyone else reads it.
 */
export function MarketplaceListingDetail({
  listing,
  canManage,
  serverId,
  serverName,
  promptTextConsent,
  saving,
  errorBanner,
  botHint,
  installWithBot,
  onClose,
  onAdd,
  onRequestUninstall,
  onBotCheckedChange,
  onReviewed,
  renderPromptTextReviewFrame,
}: {
  listing: ConnectedAppListing;
  canManage: boolean;
  serverId: string | undefined;
  serverName: string;
  promptTextConsent: boolean;
  /** Its add or removal is running. */
  saving: boolean;
  errorBanner: ReactNode;
  /** Installed here with the bot undecided: its Add, or who can add it. */
  botHint: ReactNode;
  /** "Also add @bot": what Add sends. */
  installWithBot: boolean;
  onClose: () => void;
  onAdd: () => void;
  onRequestUninstall: () => void;
  onBotCheckedChange: (checked: boolean) => void;
  onReviewed: () => Promise<void> | void;
  renderPromptTextReviewFrame: (children: ReactNode) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const canAdd = canManage && !listing.installed;
  return (
    <ConnectedAppDetailModal
      labelledBy={TITLE_ID}
      onClose={onClose}
      closeLabel={formatMessage({ id: "settings.connectedApps.closeAppDetail" })}
      identity={(
        <div className="flex min-w-0 items-start gap-3">
          <ConnectedAppLogo name={listing.name} logoUrl={listing.logoUrl} seed={listing.defaultLogoSeed} size="lg" />
          <div className="min-w-0">
            <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.appDetail" })}</SectionEyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 id={TITLE_ID} className="text-headline text-foreground">{listing.name}</h2>
              <ConnectedAppMarketplaceInstallBadge badge={listing.marketplaceInstallBadge} />
            </div>
            <div className="mt-0.5 text-footnote text-foreground-muted">{formatMessage({ id: "settings.connectedApps.byLine" }, { category: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[listing.category] ?? "settings.connectedApps.categoryOther" }), developer: listing.developer })}</div>
          </div>
        </div>
      )}
      actions={canAdd ? (
        // Named by its label and the App, as the card's Add: "Add Orbital Notes".
        <Button id={ADD_ID} aria-labelledby={`${ADD_ID} ${TITLE_ID}`} type="button" disabled={saving} onClick={onAdd} variant="accent" size="md" data-testid="connected-app-detail-add">
          {formatMessage({ id: saving ? "apps.detail.adding" : "apps.card.add" })}
        </Button>
      ) : null}
      footer={(
        <div>
          <Separator className="mb-4" />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} size="lg">
              {formatMessage({ id: "settings.common.close" })}
            </Button>
          </div>
        </div>
      )}
    >
      {errorBanner}
      <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.profile" })}>
        <p className="mb-2 text-callout text-foreground-muted">{listing.description}</p>
        <div className="text-callout">
          <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.publisher" })}>
            {listing.developer}
          </ConnectedAppDetailRow>
          <Separator />
          <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.homepageUrlLabel" })}>
            {listing.homepageUrl ? (
              <ConnectedAppUrlLink url={listing.homepageUrl} />
            ) : (
              <span className="break-all font-mono text-mono-meta text-foreground">{listing.homepageDomain}</span>
            )}
          </ConnectedAppDetailRow>
          <Separator />
          {/* f4: a fact about the App, shown to everyone before the
              install; not a Login with Raft scope (Kirby). */}
          {listing.bot ? (
            <>
              <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.appIdentity.title" })}>
                <span className="break-all font-mono text-mono-meta text-foreground" data-testid="connected-app-listing-bot">{formatMessage({ id: "common.handle" }, { name: listing.bot.handle })}</span>
                {botHint ? <div className="mt-2" data-testid="connected-app-listing-bot-hint">{botHint}</div> : null}
              </ConnectedAppDetailRow>
              <Separator />
            </>
          ) : null}
          <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.redirectCallback" })}>
            <span className="break-all font-mono text-mono-meta text-foreground">{listing.callbackDomain}</span>
          </ConnectedAppDetailRow>
        </div>
      </ConnectedAppDetailSection>
      <ConnectedAppDetailSection
        title={formatMessage({ id: "settings.connectedApps.section.loginWithRaft" })}
        description={formatMessage({ id: "settings.connectedApps.detail.loginDescription" })}
        tone="cream"
      >
        <OAuthScopeSummaryPanel
          title={formatMessage({ id: "settings.connectedApps.detail.requestableDeclared" })}
          scopes={listing.allowedScopes}
        />
      </ConnectedAppDetailSection>
      {listing.setupUrl ? listing.installed && serverId
        ? <AppSetupPanel clientId={listing.id} serverId={serverId} />
        : <AppSetupRequirement url={listing.setupUrl} description={listing.setupDescription} /> : null}
      <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.appPermissions" })} tone="cream">
        <AppNotificationRequestSummary
          groups={listing.appNotificationGroups}
          events={listing.appNotificationEvents}
          pendingGroups={listing.appNotificationPendingGroups}
          pendingEvents={listing.appNotificationPendingEvents}
          reviewPending={listing.appNotificationReviewPending}
        />
      </ConnectedAppDetailSection>
      {promptTextConsent ? (
        <MarketplacePromptTextReview
          key={listing.id}
          clientId={listing.id}
          service={listing.clientId}
          frame={renderPromptTextReviewFrame}
          onReviewed={onReviewed}
        />
      ) : null}
      <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.distribution" })} tone="cream">
        <div className="text-footnote text-foreground-muted">
          {formatMessage({ id: "settings.connectedApps.listingReviewNote" })}
        </div>
      </ConnectedAppDetailSection>
      {canAdd && (
        // Exactly what Add sends as expected_scopes / expected_groups:
        // the effective login scopes and the current data
        // groups, unfiltered — not the pending revision shown above.
        <div data-testid="connected-app-detail-add-approves">
          <ConnectedAppDetailSection
            title={formatMessage({ id: "settings.connectedApps.section.installApproves" })}
            description={formatMessage({ id: "settings.connectedApps.detail.installApprovesDescription" })}
          >
            <AppPermissionSetList
              scopes={effectiveAllowedOAuthScopes(listing.allowedScopes)}
              groups={listing.appNotificationGroups}
            />
            {listing.bot ? (
              <ConnectedAppBotInstallOption
                appName={listing.name}
                bot={listing.bot}
                serverName={serverName}
                checked={installWithBot}
                disabled={saving}
                onCheckedChange={onBotCheckedChange}
              />
            ) : null}
          </ConnectedAppDetailSection>
        </div>
      )}
      {canAdd && promptTextConsent && listing.promptTextRevisionId ? (
        // Exactly what Add sends as expected_text_revision_id: the
        // app's live text, as agents on this Server would get it.
        <ConnectedAppDetailSection
          title={formatMessage({ id: "appPromptText.title" })}
          description={formatMessage({ id: "appPromptText.installNote" })}
        >
          <AppPromptTextBlock fields={listing.promptTextFields} service={listing.clientId} />
        </ConnectedAppDetailSection>
      ) : null}
      {canManage && listing.installed && (
        <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.dangerZone" })}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.connectedApps.detail.removeInstalledDescription" })}
            </div>
            <Button
              type="button"
              disabled={saving}
              onClick={onRequestUninstall}
              variant="danger"
              size="md"
            >
              {formatMessage({ id: saving ? "settings.connectedApps.uninstalling" : "settings.connectedApps.uninstallFromServer" })}
            </Button>
          </div>
        </ConnectedAppDetailSection>
      )}
    </ConnectedAppDetailModal>
  );
}
