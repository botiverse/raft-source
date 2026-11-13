import { Panel, ScrollArea, Spinner } from "@botiverse/raft-ui";
import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { CurrentServerNotificationsCard } from "./notifications/NotificationSettingsSection";
import { useMobileBack } from "../../hooks/useAppNavigate";
import ServerThemeSection from "./ServerThemeSection";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useIntl } from "react-intl";
import PanelHeader from "../ui/PanelHeader";
import { SettingsSubPageTitle } from "./SettingsSubPageTitle";
import IMBridgesSettingsSection from "./IMBridgesSettingsSection";
import { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";
import { useChannelStore } from "../../store/channelStore";
import { hasChatSurfaces } from "../../embed";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { LinkPreviewConsentsRow } from "./LinkPreviewConsents";
import {
  SETTINGS_TAB_TITLE_ID,
  canOpenSettingsTab,
  canViewServerApplications,
  normalizeSettingsTab,
} from "./settingsNavigation";
import { LazyAboutFeedbackPanel } from "./LazyAboutFeedbackDialog";
import ProviderConnectionsSettings from "./ProviderConnectionsSettings";
import { IntegrationsSection } from "../../features/apps/IntegrationsSection";
import { ServerTabContent } from "../../features/settings/server/ServerTabContent";
import { AdministrationTabContent } from "../../features/settings/administration/AdministrationTabContent";
import { AccountSection } from "../../features/settings/account/AccountSection";
import { DeleteAccountPage } from "../../features/settings/account/DeleteAccountPage";
import { useParams } from "react-router-dom";
import { useScrollToSettingsSection } from "../../features/settings/shared/useScrollToSettingsSection";
import { useSettingsSearchLifetime } from "../../features/settings/search/settingsSearchStore";
import { NotificationsTabContent } from "../../features/settings/notifications/NotificationsTabContent";
import type { PublicTranslationSettingsContext } from "../../features/settings/language-region/publicTranslationSettingsContext";
import { LanguageRegionSection } from "../../features/settings/language-region/LanguageRegionSection";
import { LabsTabContent } from "../../features/settings/labs/LabsTabContent";
import { BillingTabContent } from "../../features/settings/billing/BillingTabContent";
import { AppearanceSection } from "../../features/settings/appearance/AppearanceSection";
import { AboutSection } from "../../features/settings/about/AboutSection";

export function SettingsPanel({
  tab: tabProp,
  accountInitialError,
  accountPasswordChangeIntent = false,
  showAboutWorkspace = true,
  publicTranslationContext,
  publicSurface = false,
}: {
  tab?: string;
  accountInitialError?: string;
  accountPasswordChangeIntent?: boolean;
  showAboutWorkspace?: boolean;
  publicTranslationContext?: PublicTranslationSettingsContext;
  /** Rendered inside the public server page (anonymous or nonmember). */
  publicSurface?: boolean;
}) {
  const { formatMessage } = useIntl();
  // A host-shell embed skips the chat startup loads, and the channel list is one
  // of them. Two sections here read it (system channels, archived channels), so
  // settings asks for it itself there.
  const settingsServerId = useServerStore((s) => s.current?.id ?? null);
  useEffect(() => {
    if (!hasChatSurfaces() && settingsServerId) void useChannelStore.getState().loadChannels();
  }, [settingsServerId]);
  const requestedSettingsTab = normalizeSettingsTab(tabProp);
  const providerConnectionsGate = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY);
  const providerConnectionsEnabled = providerConnectionsGate.enabled;
  const slackBridgeGate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const slackBridgeEnabled = isSlackBridgeSurfaceEnabled(slackBridgeGate);
  const { capabilities, role } = useServerPermissions();
  // A gated tab opened directly (a link, the App's embed) waits for its flag
  // and the person's role instead of showing Account until they arrive and
  // then switching (#triage:#166). Only a flag that is off, or no permission,
  // falls back to Account.
  const gatedTabPending = (requestedSettingsTab === "providers" && (!providerConnectionsGate.resolved || role === null))
    || (requestedSettingsTab === "im-bridges" && !slackBridgeGate.resolved);
  const gatedTabClosed = (requestedSettingsTab === "providers" && (!providerConnectionsEnabled || !capabilities.manageExternalAuth))
    || (requestedSettingsTab === "im-bridges" && !slackBridgeEnabled);
  const settingsTab = gatedTabPending
    ? requestedSettingsTab
    : gatedTabClosed || !canOpenSettingsTab(requestedSettingsTab, capabilities)
    ? "account"
    : requestedSettingsTab;
  // Every tab title maps through the catalog — and now the type says so, so the
  // claim cannot go stale again. It had: `about` was absent, and this fallback
  // silently rendered the English `label`.
  // Account › Delete Account (/settings/account/delete) is Account's level-2
  // page: its own title, and back goes to Account.
  const subPage = useParams()["*"];
  const deleteAccount = settingsTab === "account" && subPage === "delete";
  const activeLabel = formatMessage({ id: deleteAccount ? "accountDeletion.action" : SETTINGS_TAB_TITLE_ID[settingsTab] });
  const serverSlug = useServerStore((s) => s.current?.slug);
  useScrollToSettingsSection();
  // A phone's settings page keeps Search settings' query for Back to the results.
  useSettingsSearchLifetime(serverSlug);
  // Mobile back: Settings sub-pages (account / browser / server) are
  // level-2 views inside the Settings tab. Per iOS NavigationView model
  // (@stdrc 2026-04-30 #proj-uiux:c8711d2a), every level-2+ view must
  // cover the tab bar and show a top-left back button — so we pop back
  // to the Settings tab home here.
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings${deleteAccount ? "/account" : ""}` : "/");
  // embed=1: the mobile app renders this tab inside an in-app WebView with its
  // own native header (Administration/Billing pattern, botiverse/mobile#868).
  // Drop the panel header so the page isn't double-chromed; content only.
  const embedded = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";
  const headerContainerProps = useMemo(() => ({
    "data-testid": "settings-panel-header",
    "data-slock-settings-tab": settingsTab,
  }), [settingsTab]);
  const mobileBackProps = useMemo(
    () => ({ "data-testid": "settings-mobile-back", title: formatMessage({ id: "settings.tabs.back" }) }),
    [formatMessage],
  );

  return (
    // One seam between two regions: the settings list beside this panel
    // already draws it, so the frame is inset and draws none of its own.
    // Settings content sits on paper.
    <Panel edge="inset" className="flex min-h-0 flex-1 flex-col bg-layer-canvas text-foreground" data-testid="settings-panel-frame">
      {!embedded && settingsTab !== "feedback" && (
        <PanelHeader
          title={activeLabel}
          titleSlot={deleteAccount && serverSlug ? (
            <SettingsSubPageTitle
              tabLabel={formatMessage({ id: "settings.tabs.account" })}
              tabHref={`/s/${serverSlug}/settings/account`}
              title={activeLabel}
            />
          ) : undefined}
          containerProps={headerContainerProps}
          onMobileBack={onMobileBack}
          mobileBackProps={mobileBackProps}
        />
      )}

      {/* Content: Feedback fills the panel and scrolls itself; every other
          tab scrolls in a raft-ui ScrollArea, padded inside it so the
          scrollbar stays at the panel's edge. */}
      <SettingsContentFrame feedback={settingsTab === "feedback"}>
        {gatedTabPending && (
          <div aria-busy="true" className="flex min-h-40 items-center justify-center" data-testid="settings-tab-pending">
            <Spinner size="md" aria-label={formatMessage({ id: "common.loading" })} />
          </div>
        )}
        {deleteAccount && <DeleteAccountPage />}
        {settingsTab === "account" && !deleteAccount && (
          <AccountSection
            initialError={accountInitialError}
            passwordChangeIntent={accountPasswordChangeIntent}
          />
        )}
        {settingsTab === "language-region" && <LanguageRegionSection publicContext={publicTranslationContext} />}
        {settingsTab === "appearance" && <AppearanceSection publicSurface={publicSurface} />}
        {settingsTab === "notifications" && <NotificationsTabContent />}
        {settingsTab === "theme" && <ServerThemeSection />}
        {settingsTab === "server-notifications" && <CurrentServerNotificationsCard />}
        {settingsTab === "server" && <ServerTabContent />}
        {settingsTab === "providers" && !gatedTabPending && <ProviderConnectionsSettings />}
        {settingsTab === "labs" && <LabsTabContent />}
        {settingsTab === "billing" && <BillingTabContent />}
        {settingsTab === "administration" && <AdministrationTabContent />}
        {settingsTab === "im-bridges" && !gatedTabPending && <IMBridgesSettingsSection />}
        {settingsTab === "integrations" && canViewServerApplications(role) && <IntegrationsSection />}
        {/* Link previews are each person's own answer, so everyone sees them
            in Applications: one row after the Apps, which stay on top; a
            guest sees only it. */}
        {settingsTab === "integrations" && <LinkPreviewConsentsRow guest={!canViewServerApplications(role)} />}
        {settingsTab === "about" && <AboutSection showWorkspace={showAboutWorkspace} />}
        {settingsTab === "feedback" && <LazyAboutFeedbackPanel />}
      </SettingsContentFrame>
    </Panel>
  );
}

function SettingsContentFrame({ feedback, children }: { feedback: boolean; children: ReactNode }) {
  if (feedback) return <div className="min-h-0 flex-1 bg-layer-canvas">{children}</div>;
  return (
    <ScrollArea
      className="flex-1 bg-layer-canvas text-foreground"
      contentClassName="px-4 py-4 mobile-nav-clearance md:px-(--surface-inset) md:pointer-fine:pt-(--page-top) md:pointer-fine:pb-(--page-inset)"
    >
      {children}
    </ScrollArea>
  );
}
