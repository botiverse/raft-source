import { AppSetupFields, AppSetupPanel, AppSetupRequirement } from "../../components/integrations/AppSetup";
import { AppWhenToUseField } from "../../components/settings/AppWhenToUseField";
import { ConnectedAppShareLinks } from "../../components/settings/ConnectedAppShareLinks";
import {
  Checkbox,
  Textarea,
  Button,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectIcon,
  SelectList,
  SelectTrigger,
  SelectValue,
  Separator,
  TextLink,
} from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { useCallback, useState, useEffect, useEffectEvent, useId, useMemo, useRef } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { notifyAppPermissionUpdatesChanged } from "../../components/layout/useAppPermissionUpdates";
import {
  Check,
  Copy,
  AlertTriangle,
  Trash2,
  Upload,
  Blocks,
  RefreshCw,
  AppWindow,
} from "lucide-react";
import {
  normalizeAppSetupUrl,
  isAppWhenToUseTooLong,
  APP_WHEN_TO_USE_MAX_CODE_POINTS,
  effectiveAllowedOAuthScopes,
} from "@botiverse/raft-shared";
import type {
  MarketplaceMcpListing,
  McpAppListItem,
  McpAppListResponse,
} from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import ConfirmDialog from "../../components/ConfirmDialog";
import { showToast } from "../../components/toastBridge";
import Banner from "../../components/ui/Banner";
import { FormDialog } from "../../components/ui/FormDialog";
import { DialogCommit } from "../../components/ui/NarrowDialog";
import api from "../../api/client";
import { appPermissionsChangedCurrentSet, expectedAppPermissionsBody, isAppPermissionsChangedError, isExpectedPermissionsRequiredError } from "../../lib/appPermissionExpectation";
import { AppPermissionSetList } from "../../components/integrations/AppPermissionSetList";
import { useIntl } from "react-intl";
import PanelHeader from "../../components/ui/PanelHeader";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import SectionHeader from "../../components/ui/SectionHeader";
import FormField from "../../components/ui/FormField";
import { ConnectedAppLogo } from "../../components/settings/ConnectedAppLogo";
import {
  DEFAULT_DECLARED_OAUTH_SCOPES,
  normalizeDeclaredOAuthScopes,
} from "../../lib/oauthScopePresentation";
import type { RaftOAuthScopeId } from "../../lib/oauthScopePresentation";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  appTextChangedCurrent,
  clientPromptTextPath,
  expectedTextRevisionBody,
  readClientPromptTextState,
} from "../../lib/appPromptText";
import type { AppPromptTextFields } from "../../lib/appPromptText";
import { readMarketplaceRecords } from "../../lib/marketplaceRecords";
import { AppPromptTextBlock } from "../../components/integrations/AppPromptText";
import { LinkPreviewAppChoice, LinkPreviewConsentsRow } from "../../components/settings/LinkPreviewConsents";
import { DeveloperPromptTextPanel, MarketplacePromptTextReview } from "../../components/settings/AppPromptTextPanels";
import type { ConnectedAppsTab } from "../../components/settings/SettingsSegmentedControls";
import {
  ConnectedAppsErrorBanner,
  CONNECTED_APPS_ERROR_FORM,
  CONNECTED_APPS_ERROR_LISTING,
  CONNECTED_APPS_ERROR_PAGE,
  getConnectedAppsErrorSurface,
} from "../../components/settings/connectedAppsErrorSurface";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";
import { InstalledConnectedAppItem, InstalledConnectedAppItemSkeleton } from "../../components/settings/InstalledConnectedAppItem";
import { useListSkeletonShown } from "../../components/ui/useListSkeletonShown";
import {
  ConnectedAppBotInstallOption,
  ConnectedAppBotLinkNotInstalledNotice,
  ConnectedAppBotPendingBanner,
  ConnectedAppBotRemoveDialog,
  ConnectedAppBotSection,
  APP_BOT_HANDLE_CONFLICT,
} from "../../components/settings/ConnectedAppBot";
import type { AppBotOffer } from "../../components/settings/ConnectedAppBot";
import { useProfileStore } from "../../store/profileStore";
import { RegisteredConnectedAppItem } from "../../components/settings/RegisteredConnectedAppItem";
import { McpAppEditor } from "../../components/settings/mcpApps/McpAppEditor";
import { RegisterAppMenu } from "../../components/settings/mcpApps/RegisterAppMenu";
import { mcpAppErrorMessage, profilePayload } from "../../components/settings/mcpApps/mcpAppApi";
import type { McpAppView } from "../../components/settings/mcpApps/mcpAppApi";
import { AppsToolbar } from "../../components/apps/AppsToolbar";
import { AppsNoMatchState, AppsSectionHeading } from "../../components/apps/AppsListParts";
import { MarketplaceListingsTab } from "../../components/apps/MarketplaceListingsTab";
import { AppsRecommendedSection } from "../../components/apps/AppsRecommendedSection";
import { appRecommendations } from "../../components/apps/appsRecommendations";
import { DEFAULT_APPS_FILTERS, hasActiveAppsFilters, matchesAppsType } from "../../components/apps/appsFilters";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import type { AppsFilters } from "../../components/apps/appsFilters";
import EmptyState from "../../components/ui/EmptyState";
import { ListRowSkeletonList } from "../../components/ui/Skeleton";
import { PagePullToRefreshIndicator } from "../../components/ui/PagePullToRefreshIndicator";
import { usePagePullToRefresh } from "../../hooks/usePagePullToRefresh";
import {
  AppNotificationRequestSummary,
  DeveloperAppNotifications,
  DeveloperAppPermissions,
  InstalledAppNotifications,
} from "../../components/settings/AppNotificationsControls";
import type {
  AppNotificationSelection,
  AppNotificationsDeveloperState,
} from "../../components/settings/AppNotificationsControls";
import { renderSelectItems } from "../settings/shared/renderSelectItems";
import type { IntegrationOverviewItem, MarketplaceOAuthClientRecord, OAuthClientRecord } from "./connected-apps/oauthClientRecords";
import type { ConnectedAppCategory, ConnectedAppListing, ConnectedAppsViewMode, InstalledConnectedApp, ServerRegisteredApp } from "./connected-apps/connectedAppTypes";
import {
  canDeleteSourceOwnedConnectedApp,
  canEditSourceOwnedConnectedApp,
  canRequestOfflineSourceOwnedConnectedApp,
  connectedAppDistributionStatus,
  sourceOwnedConnectedAppStatusHint,
} from "./connected-apps/connectedAppStatus";
import { CONNECTED_APPS_VIEW_MODE_STORAGE_KEY, connectedAppsCollectionClassName, getInitialConnectedAppsViewMode } from "./connected-apps/connectedAppsViewMode";
import { CONNECTED_APP_CATEGORY_LABEL_ID, CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS, matchesConnectedAppFilter } from "./connected-apps/connectedAppCatalog";
import { getDomainFromUrl } from "./connected-apps/getDomainFromUrl";
import {
  isMarketplaceTabClient,
  mapClientToMarketplaceApp,
  mapClientToRegisteredApp,
  mcpAppAsConnectedApp,
  renderMarketplaceText,
} from "./connected-apps/connectedAppMapping";
import { emptyAppNotificationState } from "./connected-apps/emptyAppNotificationState";
import { ConnectedAppsViewToggle } from "./connected-apps/ConnectedAppsViewToggle";
import { AppNotificationsLabel } from "./connected-apps/AppNotificationsLabel";
import { ConnectedAppEditorSection } from "./connected-apps/ConnectedAppEditorSection";
import { ConnectedAppLinkPreviewReadOnlyBanner } from "./connected-apps/ConnectedAppLinkPreviewReadOnlyBanner";
import { ConnectedAppEditorActionRow } from "./connected-apps/ConnectedAppEditorActionRow";
import { ConnectedAppMarketplaceInstallBadge } from "./connected-apps/ConnectedAppMarketplaceInstallBadge";
import { ConnectedAppUrlLink } from "./connected-apps/ConnectedAppUrlLink";
import { OAuthScopeSummaryPanel } from "./connected-apps/OAuthScopeSummaryPanel";
import { ConnectedAppDetailSection } from "./connected-apps/ConnectedAppDetailSection";
import { ConnectedAppDetailRow } from "./connected-apps/ConnectedAppDetailRow";
import { DeclaredScopesPicker } from "./connected-apps/DeclaredScopesPicker";
import { ConnectedAppDetailModal } from "./connected-apps/ConnectedAppDetailModal";
import { useMarketplaceListingsTotal } from "./useMarketplaceListingsTotal";
import { useAppBotLink } from "./useAppBotLink";
import { useInstalledAppBot } from "./useInstalledAppBot";
import { useMarketplaceBotHint } from "./useMarketplaceBotHint";

/**
 * The server's Apps: Installed, Marketplace and My Apps (#proj-apps task #22).
 * `page` is the Apps page (/apps): its own head, the tabs and their toolbar
 * with Add App at its end, and a scrolling list with pull to refresh on a phone.
 * `settings` is the same content inside Settings › Applications, which only
 * the native host shell's embedded settings page and a direct render still
 * open (the route sends everyone else to /apps).
 */
/**
 * Installed while it loads: item placeholders in the collection the Apps will
 * be in, in its view (the grid's cards or the list's rows), after the 1s wait
 * (raft-design Feedback), so the Apps land where these were (#proj-raft-ui:#231).
 */
export function InstalledAppsSkeleton({ viewMode, canManage }: { viewMode: ConnectedAppsViewMode; canManage: boolean }) {
  const shown = useListSkeletonShown();
  return (
    <div aria-busy="true" data-testid="apps-loading">
      {shown ? (
        <div className={connectedAppsCollectionClassName(viewMode)} data-view={viewMode} data-testid="apps-loading-collection">
          {Array.from({ length: 4 }, (_, index) => <InstalledConnectedAppItemSkeleton key={index} viewMode={viewMode} canManage={canManage} />)}
        </div>
      ) : null}
    </div>
  );
}

export function IntegrationsSection({ variant = "settings" }: { variant?: "page" | "settings" } = {}) {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const { capabilities } = useServerPermissions();
  const canManage = capabilities.manageIntegrations;
  // Off: every Connected Apps surface stays exactly as before.
  const promptTextConsent = useServerFeatureFlag(APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY).enabled;
  // Self-built apps whose agent prompt text this Server hasn't confirmed, by
  // app row id. Marketplace rows carry their own promptTextConfirmationRequired.
  const [textConfirmationByClientId, setTextConfirmationByClientId] = useState<Record<string, boolean>>({});
  const connectedAppsLabel = formatMessage({ id: "settings.connectedApps.label" });

  const location = useLocation();
  // Installed first: the rows that wait for an owner or admin are there.
  const [activeTab, setActiveTab] = useState<ConnectedAppsTab>("installed");
  const [filters, setFilters] = useState<AppsFilters>(DEFAULT_APPS_FILTERS);
  // Grid or list, on every tab, remembered on the device (as Settings had it).
  const [connectedAppsViewMode, setConnectedAppsViewMode] = useState<ConnectedAppsViewMode>(getInitialConnectedAppsViewMode);
  const marketplaceQuery = useDebouncedValue(filters.search.trim(), 300);
  // Bumped after an install, so the Marketplace's rows say Installed.
  const [marketplaceReloadKey, setMarketplaceReloadKey] = useState(0);
  // The first load of this server's Apps failed: a Retry, not an empty list.
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedListing, setSelectedListing] = useState<ConnectedAppListing | null>(null);
  // The installed App whose detail is open, and whether the bot add link
  // (?app_bot=) opened it: one state, so every open and close sets both.
  const [installedDetail, setInstalledDetail] = useState<{ app: InstalledConnectedApp; fromLink: boolean } | null>(null);
  const selectedInstalledApp = installedDetail?.app ?? null;
  const [marketplaceClients, setMarketplaceClients] = useState<MarketplaceOAuthClientRecord[]>([]);
  const [clients, setClients] = useState<OAuthClientRecord[]>([]);
  const [integrationOverview, setIntegrationOverview] = useState<IntegrationOverviewItem[]>([]);
  // MCP Apps come from their own list; a failure there must not take the OAuth Apps down with it.
  const [mcpApps, setMcpApps] = useState<McpAppListItem[]>([]);
  const [mcpAppsError, setMcpAppsError] = useState(false);
  // Add App ▸ Add a Custom MCP App (`appId: null`), an MCP App opened from its
  // row, or one just installed from the Marketplace (opened on Connections).
  const [mcpEditor, setMcpEditor] = useState<{ appId: string | null; initialSection?: "connections" } | null>(null);
  // This server's Apps have been read once: until then the lists show rows
  // that stand in for them, not an empty state.
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [error, setError] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdSecretClientId, setCreatedSecretClientId] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [showRegisterDrawer, setShowRegisterDrawer] = useState(false);
  const [editingClient, setEditingClient] = useState<OAuthClientRecord | null>(null);
  const [savingClientId, setSavingClientId] = useState<string | null>(null);
  const [regeneratingClientId, setRegeneratingClientId] = useState<string | null>(null);
  const [regenerateSecretTarget, setRegenerateSecretTarget] = useState<OAuthClientRecord | null>(null);
  const [deleteClientTarget, setDeleteClientTarget] = useState<ServerRegisteredApp | null>(null);
  const [offlineRequestTarget, setOfflineRequestTarget] = useState<ServerRegisteredApp | null>(null);
  const [marketplaceUninstallTarget, setMarketplaceUninstallTarget] = useState<InstalledConnectedApp | ConnectedAppListing | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientDescription, setClientDescription] = useState("");
  const [clientWhenToUse, setClientWhenToUse] = useState("");
  const [clientHomepageUrl, setClientHomepageUrl] = useState("");
  const [clientReturnUrl, setClientReturnUrl] = useState("");
  const [clientAgentManifestUrl, setClientAgentManifestUrl] = useState("");
  const [clientSetupRequired, setClientSetupRequired] = useState(false);
  const [clientSetupUrl, setClientSetupUrl] = useState("");
  const [clientSetupDescription, setClientSetupDescription] = useState("");
  const [clientAllowedScopes, setClientAllowedScopes] = useState<RaftOAuthScopeId[]>([...DEFAULT_DECLARED_OAUTH_SCOPES]);
  const [appNotificationSelection, setAppNotificationSelection] = useState<AppNotificationSelection>({ groups: [], events: [] });
  const [appNotificationState, setAppNotificationState] = useState<AppNotificationsDeveloperState | null>(null);
  const [appNotificationLoading, setAppNotificationLoading] = useState(false);
  const [appNotificationConfigurationOpen, setAppNotificationConfigurationOpen] = useState(false);
  const [clientCategory, setClientCategory] = useState<ConnectedAppCategory>("Other");
  const [clientEnableBot, setClientEnableBot] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const secretCopyResetRef = useRef<number | null>(null);

  const serverId = current?.id;
  const load = useCallback(async () => {
    if (!serverId) return;
    setError("");
    setLoadFailed(false);
    try {
      const [clientsRes, nextMarketplaceClients, overviewRes] = await Promise.all([
        api.get("/integrations/clients"),
        // Through the cache the install card's dialog reads too (always a new read here).
        readMarketplaceRecords({ fresh: true }),
        api.get("/integrations/overview"),
      ]);
      setClients(clientsRes.data);
      setMarketplaceClients(nextMarketplaceClients);
      const requestedMarketplaceId = new URLSearchParams(window.location.search).get("marketplace_app")?.trim();
      if (requestedMarketplaceId) {
        const requestedListing = nextMarketplaceClients
          .filter((app) => isMarketplaceTabClient(app, serverId))
          .map((client) => mapClientToMarketplaceApp(client, formatMessage))
          .find((app) => app.id === requestedMarketplaceId || app.clientId === requestedMarketplaceId);
        if (requestedListing) setSelectedListing(requestedListing);
      }
      // Keep an open detail modal in sync with the reloaded rows — e.g. a
      // permission-update approve must drop the pending badge instead of
      // showing a stale snapshot of the pre-review listing.
      setSelectedListing((currentListing) => {
        if (!currentListing) return currentListing;
        const fresh = nextMarketplaceClients
          .map((client) => mapClientToMarketplaceApp(client, formatMessage))
          .find((app) => app.id === currentListing.id || app.clientId === currentListing.clientId);
        return fresh ?? null;
      });
      setIntegrationOverview(overviewRes.data);
      // An install, an uninstall or an approval changes the Marketplace's rows too.
      setMarketplaceReloadKey((key) => key + 1);
      setLoaded(true);
    } catch {
      setLoadFailed(true);
    }
  }, [formatMessage, serverId]);

  const loadMcpApps = useCallback(async () => {
    if (!serverId) return;
    try {
      const { data } = await api.get<McpAppListResponse>("/mcp/apps");
      setMcpApps(Array.isArray(data?.apps) ? data.apps : []);
      setMcpAppsError(false);
    } catch {
      setMcpApps([]);
      setMcpAppsError(true);
    }
  }, [serverId]);

  // Load once per server; a locale switch (new `formatMessage`) must not refetch.
  const loadForServer = useEffectEvent(load);
  const loadMcpAppsForServer = useEffectEvent(loadMcpApps);
  useEffect(() => {
    void loadForServer();
    void loadMcpAppsForServer();
  }, [serverId]);

  // The installed list's "Needs confirmation" mark. Marketplace apps read it
  // from their GET /integrations/marketplace row; editable (self-built) apps,
  // which that list doesn't carry, from their own prompt-text state.
  useEffect(() => {
    if (!promptTextConsent || activeTab !== "installed") return;
    let cancelled = false;
    const editableIds = clients
      .filter((client) => client.appType === "server_local" || (client.appType === "third_party_global" && canEditSourceOwnedConnectedApp(client.publishStatus)))
      .map((client) => client.id);
    const reads = editableIds.map(async (id): Promise<[string, boolean]> => {
      const { data } = await api.get(clientPromptTextPath(id));
      return [id, readClientPromptTextState(data)?.localConfirmationRequired === true];
    });
    void Promise.allSettled(reads).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const result of results) {
        if (result.status === "fulfilled") next[result.value[0]] = result.value[1];
      }
      setTextConfirmationByClientId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, clients, promptTextConsent]);

  useEffect(() => {
    return () => {
      if (secretCopyResetRef.current) {
        window.clearTimeout(secretCopyResetRef.current);
      }
    };
  }, []);

  const resetForm = useCallback(() => {
    setClientName("");
    setClientId("");
    setClientDescription("");
    setClientWhenToUse("");
    setClientHomepageUrl("");
    setClientReturnUrl("");
    setClientAgentManifestUrl("");
    setClientSetupRequired(false); setClientSetupUrl(""); setClientSetupDescription("");
    setClientAllowedScopes([...DEFAULT_DECLARED_OAUTH_SCOPES]);
    setAppNotificationSelection({ groups: [], events: [] });
    setAppNotificationState(null);
    setAppNotificationLoading(false);
    setAppNotificationConfigurationOpen(false);
    setClientCategory("Other");
    setClientEnableBot(false);
  }, []);

  const openRegisterDrawer = useCallback(() => {
    setEditingClient(null);
    resetForm();
    setCreatedSecret(null);
    setCreatedSecretClientId(null);
    setSecretCopied(false);
    setError("");
    setShowRegisterDrawer(true);
  }, [resetForm]);

  const loadAppNotificationState = useCallback(async (clientId: string) => {
    setAppNotificationLoading(true);
    try {
      const { data } = await api.get(`/integrations/clients/${clientId}/app-notifications`);
      if (
        !data
        || typeof data !== "object"
        || Array.isArray(data)
        || !Array.isArray(data.current_groups)
        || !Array.isArray(data.current_events)
      ) {
        throw new Error("Invalid App Notifications settings response");
      }
      setAppNotificationState(data);
      setAppNotificationConfigurationOpen(!!data.webhook?.enabled);
      const requested = data.pending_revision ?? {
        groups: data.current_groups,
        events: data.current_events,
      };
      setAppNotificationSelection({ groups: requested.groups, events: requested.events });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedLoadAppNotifications" }));
    } finally {
      setAppNotificationLoading(false);
    }
  }, [formatMessage]);

  // RFC 084 §3: a listed, official or in-review App's client ID goes through review.
  const clientKeyEditable = editingClient !== null
    && !editingClient.official
    && (editingClient.publishStatus === "private" || editingClient.publishStatus === "rejected");

  const beginEditClient = useCallback((client: OAuthClientRecord) => {
    setEditingClient(client);
    setClientName(client.name);
    setClientId(client.clientId);
    setClientDescription(client.description ?? "");
    setClientWhenToUse(client.whenToUse ?? "");
    setClientHomepageUrl(client.homepageUrl ?? "");
    setClientReturnUrl(client.returnUrl ?? "");
    setClientAgentManifestUrl(client.agentManifestUrl ?? "");
    setClientSetupRequired(Boolean(client.setupUrl)); setClientSetupUrl(client.setupUrl ?? ""); setClientSetupDescription(client.setupDescription ?? "");
    setClientAllowedScopes(normalizeDeclaredOAuthScopes(client.allowedScopes));
    setAppNotificationSelection({ groups: [], events: [] });
    setAppNotificationState(null);
    setAppNotificationConfigurationOpen(false);
    setClientCategory(client.category);
    setClientEnableBot(client.enableBot === true);
    if (createdSecretClientId !== client.id) {
      setCreatedSecret(null);
      setCreatedSecretClientId(null);
    }
    setSecretCopied(false);
    setError("");
    void loadAppNotificationState(client.id);
    setShowRegisterDrawer(true);
  }, [createdSecretClientId, loadAppNotificationState]);

  const closeRegisterDrawer = useCallback(() => {
    setShowRegisterDrawer(false);
    setEditingClient(null);
    setError("");
    resetForm();
  }, [resetForm]);

  // Mutation responses that are not install-joined (regenerate-secret,
  // share-link, publish/offline requests) must not erase the editor's
  // install state: an undefined botGrant means "this response didn't carry
  // the join", while an explicit value (PATCH is install-joined) wins.
  const applyUpdatedClient = useCallback((client: OAuthClientRecord) => {
    const mergeInstallState = (previous: OAuthClientRecord): OAuthClientRecord => ({
      ...(client.botGrant === undefined
        ? { ...client, installationId: previous.installationId, installStatus: previous.installStatus, botGrant: previous.botGrant, bot: previous.bot }
        : client),
      // Only GET /integrations/clients carries it, and no edit here changes it.
      linkPreviewReadOnly: previous.linkPreviewReadOnly,
      official: previous.official,
    });
    setClients((items) => items.map((item) => item.id === client.id ? mergeInstallState(item) : item));
    setEditingClient((currentClient) => currentClient?.id === client.id ? mergeInstallState(currentClient) : currentClient);
  }, []);

  const handleBotChanged = useCallback((clientRowId: string, bot: AppBotOffer) => {
    const withBot = <T extends OAuthClientRecord>(client: T): T => (client.id === clientRowId ? { ...client, bot } : client);
    setMarketplaceClients((items) => items.map(withBot));
    setClients((items) => items.map(withBot));
    void load();
  }, [load]);
  const {
    botBusyClientId, botRemoveTarget, setBotRemoveTarget, handleInstalledBotAction, handleCloseBotRemove, handleConfirmBotRemove,
  } = useInstalledAppBot({ setError, onBotChanged: handleBotChanged });
  const openProfile = useProfileStore((s) => s.openProfile);

  const handleEnableBotCheckedChange = useCallback((checked: boolean | "indeterminate") => {
    setClientEnableBot(checked === true);
  }, []);

  const saveAppNotificationPermissions = useCallback(async (clientRowId: string) => {
    await api.put(`/integrations/clients/${clientRowId}/app-notifications/permissions`, {
      groups: appNotificationSelection.groups,
      events: appNotificationSelection.events,
    });
  }, [appNotificationSelection]);

  const appNotificationRequestChanged = useCallback(() => {
    if (!appNotificationState) return appNotificationSelection.groups.length > 0 || appNotificationSelection.events.length > 0;
    const requested = appNotificationState.pending_revision ?? {
      groups: appNotificationState.current_groups,
      events: appNotificationState.current_events,
    };
    return requested.groups.join("\0") !== appNotificationSelection.groups.join("\0")
      || requested.events.join("\0") !== appNotificationSelection.events.join("\0");
  }, [appNotificationSelection, appNotificationState]);

  const handleSaveClient = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!serverId) return;
    if (isAppWhenToUseTooLong(clientWhenToUse)) {
      setError(formatMessage({ id: "settings.connectedApps.whenToUseTooLong" }, { limit: APP_WHEN_TO_USE_MAX_CODE_POINTS }));
      return;
    }
    if (clientSetupRequired) {
      try { if (!normalizeAppSetupUrl(clientSetupUrl)) throw new Error("missing setup URL"); }
      catch { setError(formatMessage({ id: "appSetup.invalidUrl" })); return; }
    }
    setSubmitting(true);
    setSavingClientId(editingClient?.id ?? null);
    setError("");
    if (!editingClient) setCreatedSecret(null);
    try {
      if (editingClient) {
        const { data } = await api.patch(`/integrations/clients/${editingClient.id}`, {
          name: clientName,
          description: clientDescription || null,
          whenToUse: clientWhenToUse || null,
          homepageUrl: clientHomepageUrl || null,
          returnUrl: clientReturnUrl || null,
          agentManifestUrl: clientAgentManifestUrl || null,
          setupUrl: clientSetupRequired ? clientSetupUrl : null,
          setupDescription: clientSetupRequired ? clientSetupDescription : null,
          allowedScopes: clientAllowedScopes,
          category: clientCategory,
          enableBot: clientEnableBot,
          // A new client id for an unpublished App (RFC 084); unchanged it does nothing on the server.
          // Left empty, the App keeps the id it has.
          ...(clientKeyEditable && clientId.trim() ? { clientId: clientId.trim() } : {}),
        });
        applyUpdatedClient(data);
        if (appNotificationState && appNotificationRequestChanged()) {
          await saveAppNotificationPermissions(editingClient.id);
        }
        closeRegisterDrawer();
      } else {
        // Registering creates the app's first client secret: a fresh second step.
        const { data } = await withSecondFactorStepUp(() => api.post("/integrations/clients", {
          name: clientName,
          clientId: clientId || undefined,
          description: clientDescription || undefined,
          whenToUse: clientWhenToUse || undefined,
          homepageUrl: clientHomepageUrl || undefined,
          returnUrl: clientReturnUrl || undefined,
          agentManifestUrl: clientAgentManifestUrl || undefined,
          setupUrl: clientSetupRequired ? clientSetupUrl : undefined,
          setupDescription: clientSetupRequired ? clientSetupDescription : undefined,
          allowedScopes: clientAllowedScopes,
          category: clientCategory,
          enableBot: clientEnableBot,
        }), "secret");
        setCreatedSecret(data.clientSecret);
        setCreatedSecretClientId(data.client.id);
        setSecretCopied(false);
        setEditingClient(data.client);
        setClientId(data.client.clientId);
        setClients((items) => [...items, data.client]);
        setAppNotificationState(emptyAppNotificationState());
        if (appNotificationRequestChanged()) {
          await saveAppNotificationPermissions(data.client.id);
        }
        resetForm();
        setShowRegisterDrawer(false);
        setActiveTab("myapps");
        await load();
      }
    } catch (err: any) {
      if (isSecondFactorStepUpCancelled(err)) return;
      setError(err.response?.data?.error || (editingClient ? formatMessage({ id: "settings.connectedApps.failedUpdateApp" }) : formatMessage({ id: "settings.connectedApps.failedRegisterApp" })));
    } finally {
      setSubmitting(false);
      setSavingClientId(null);
    }
  }, [
    appNotificationRequestChanged,
    appNotificationState,
    applyUpdatedClient,
    clientKeyEditable,
    clientAgentManifestUrl,
    clientSetupRequired, clientSetupUrl, clientSetupDescription,
    clientAllowedScopes,
    clientCategory,
    clientDescription,
    clientEnableBot,
    clientHomepageUrl,
    clientId,
    clientName,
    clientReturnUrl,
    clientWhenToUse,
    closeRegisterDrawer,
    editingClient,
    formatMessage,
    load,
    resetForm,
    saveAppNotificationPermissions,
    serverId,
  ]);

  const handleCopyCreatedSecret = useCallback(async () => {
    if (!createdSecret) return;
    setError("");
    try {
      await navigator.clipboard.writeText(createdSecret);
      setSecretCopied(true);
      if (secretCopyResetRef.current) {
        window.clearTimeout(secretCopyResetRef.current);
      }
      secretCopyResetRef.current = window.setTimeout(() => {
        setSecretCopied(false);
        secretCopyResetRef.current = null;
      }, 1500);
    } catch (err: any) {
      setError(err?.message || formatMessage({ id: "settings.connectedApps.failedCopySecret" }));
    }
  }, [createdSecret, formatMessage]);

  const handleRegenerateClientSecret = useCallback(async (client: OAuthClientRecord) => {
    setRegeneratingClientId(client.id);
    setError("");
    try {
      const { data } = await withSecondFactorStepUp(() => api.post(`/integrations/clients/${client.id}/regenerate-secret`), "secret");
      applyUpdatedClient(data.client);
      setCreatedSecret(data.clientSecret);
      setCreatedSecretClientId(data.client.id);
      setSecretCopied(false);
    } catch (err: unknown) {
      if (isSecondFactorStepUpCancelled(err)) return;
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.regenerateSecretFailed" }));
      throw err;
    } finally {
      setRegeneratingClientId(null);
    }
  }, [applyUpdatedClient, formatMessage]);

  const handleLogoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!editingClient || !file) return;
    setLogoUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const { data } = await api.post(`/integrations/clients/${editingClient.id}/logo`, formData);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedUploadLogo" }));
    } finally {
      setLogoUploading(false);
      event.target.value = "";
    }
  };

  const handleClearLogo = useCallback(async () => {
    if (!editingClient) return;
    setLogoUploading(true);
    setError("");
    try {
      const { data } = await api.delete(`/integrations/clients/${editingClient.id}/logo`);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedResetLogo" }));
    } finally {
      setLogoUploading(false);
    }
  }, [applyUpdatedClient, editingClient, formatMessage]);

  const editingClientId = editingClient?.id;
  const handleDeleteClient = useCallback(async (client: ServerRegisteredApp) => {
    await api.delete(`/integrations/clients/${client.id}`);
    setClients((items) => items.filter((item) => item.id !== client.id));
    if (editingClientId === client.id) {
      closeRegisterDrawer();
    }
  }, [closeRegisterDrawer, editingClientId]);

  const handleRequestPublish = useCallback(async (client: ServerRegisteredApp) => {
    if (isAppWhenToUseTooLong(clientWhenToUse)) {
      setError(formatMessage({ id: "settings.connectedApps.whenToUseTooLong" }, { limit: APP_WHEN_TO_USE_MAX_CODE_POINTS }));
      return;
    }
    setSavingClientId(client.id);
    setError("");
    try {
      await api.patch(`/integrations/clients/${client.id}`, {
        name: clientName,
        description: clientDescription || null,
        whenToUse: clientWhenToUse || null,
        homepageUrl: clientHomepageUrl || null,
        returnUrl: clientReturnUrl || null,
        agentManifestUrl: clientAgentManifestUrl || null,
        allowedScopes: clientAllowedScopes,
        category: clientCategory,
        enableBot: clientEnableBot,
      });
      const { data } = await api.post(`/integrations/clients/${client.id}/request-publish`);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedRequestPublish" }));
    } finally {
      setSavingClientId(null);
    }
  }, [
    applyUpdatedClient,
    clientAgentManifestUrl,
    clientAllowedScopes,
    clientCategory,
    clientEnableBot,
    clientDescription,
    clientHomepageUrl,
    clientName,
    clientReturnUrl,
    clientWhenToUse,
    formatMessage,
  ]);

  // A publish request still waiting for review can be withdrawn: the app goes
  // back to private and keeps its registration, credentials and installs.
  const handleWithdrawPublish = useCallback(async (client: ServerRegisteredApp) => {
    setSavingClientId(client.id);
    setError("");
    try {
      const { data } = await api.post(`/integrations/clients/${client.id}/withdraw-publish`);
      applyUpdatedClient(data);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.editor.withdrawPublishFailed" }));
    } finally {
      setSavingClientId(null);
    }
  }, [applyUpdatedClient, formatMessage]);

  const handleRequestOffline = useCallback(async (client: ServerRegisteredApp) => {
    setSavingClientId(client.id);
    setError("");
    try {
      const { data } = await api.post(`/integrations/clients/${client.id}/request-unpublish`);
      applyUpdatedClient(data);
      setOfflineRequestTarget(null);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.marketplaceReviewFailed" }));
    } finally {
      setSavingClientId(null);
    }
  }, [applyUpdatedClient, formatMessage]);

  // f4: "Also add @bot" in the install dialog, checked for each App opened.
  const [installBotChoice, setInstallBotChoice] = useState<{ listingId: string; checked: boolean } | null>(null);
  const installWithBot = useCallback(
    (listingId: string) => (installBotChoice?.listingId === listingId ? installBotChoice.checked : true),
    [installBotChoice],
  );
  const handleInstallMarketplaceApp = useCallback(async (listing: ConnectedAppListing) => {
    setSavingClientId(listing.id);
    setError("");
    try {
      // Approving an app needs a sign-in that passed the second step: "Verify it's you", then once more.
      const { data } = await withSecondFactorStepUp(() => api.post<{ warnings?: string[] } | undefined>(
        `/integrations/marketplace/${listing.id}/install`,
        {
          ...expectedAppPermissionsBody(effectiveAllowedOAuthScopes(listing.allowedScopes), listing.appNotificationGroups),
          // Installing also confirms the agent prompt text shown in the detail.
          ...(promptTextConsent ? expectedTextRevisionBody(listing.promptTextRevisionId) : {}),
          // Unchecked declines the bot here ("revoked"), so this Server isn't asked again.
          ...(listing.bot ? { bot: installWithBot(listing.id) } : {}),
        },
      ), "appAccess");
      setSelectedListing(listing.setupUrl ? { ...listing, installed: true } : null);
      await load();
      // The install went through; only the bot didn't join (its handle is taken).
      if (listing.bot && data?.warnings?.includes(APP_BOT_HANDLE_CONFLICT)) {
        setError(formatMessage({ id: "settings.connectedApps.appIdentity.handleConflict" }, { handle: listing.bot.handle }));
      }
    } catch (err: any) {
      // "Verify it's you" closed: nothing was installed, nothing to report.
      if (isSecondFactorStepUpCancelled(err)) return;
      if (isAppPermissionsChangedError(err)) {
        // The 409 carries the app's current set (and, with the flag, its
        // current text): show it in place, so the next click sends what the
        // admin now sees. Without them, load() refreshes the open listing.
        const set = appPermissionsChangedCurrentSet(err);
        const text = promptTextConsent ? appTextChangedCurrent(err, listing.promptTextRevisionId) : null;
        const record = marketplaceClients.find((client) => client.id === listing.id);
        if (record && set && (!text || text.fields)) {
          const next: MarketplaceOAuthClientRecord = {
            ...record,
            allowedScopes: set.scopes,
            appNotificationGroups: set.groups as MarketplaceOAuthClientRecord["appNotificationGroups"],
            ...(text?.fields ? { ...text.fields, promptTextRevisionId: text.revisionId } : {}),
          };
          setMarketplaceClients((items) => items.map((client) => (client.id === next.id ? next : client)));
          setSelectedListing((open) => (open?.id === next.id ? { ...mapClientToMarketplaceApp(next, formatMessage), installed: open.installed } : open));
        } else {
          await load();
        }
        setError(formatMessage({ id: text ? "appPromptText.textChanged" : "settings.connectedApps.permissionsChanged" }));
        return;
      }
      if (isExpectedPermissionsRequiredError(err)) {
        setError(formatMessage({ id: "appPermissionSet.reloadRequired" }));
        return;
      }
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedInstall" }));
    } finally {
      setSavingClientId(null);
    }
  }, [formatMessage, installWithBot, load, marketplaceClients, promptTextConsent]);

  const handleUninstallMarketplaceApp = useCallback(async (app: InstalledConnectedApp | ConnectedAppListing) => {
    setSavingClientId(app.id);
    setError("");
    try {
      await api.delete(`/integrations/marketplace/${app.id}/install`);
      setSelectedListing(null);
      setMarketplaceUninstallTarget(null);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedUninstall" }));
    } finally {
      setSavingClientId(null);
    }
  }, [formatMessage, load]);

  const registeredApps = clients.map(mapClientToRegisteredApp);
  const grantedScopesByClientId = integrationOverview
    .filter((item) => item.type === "active" && !item.revokedAt)
    .reduce((map, item) => {
      const current = map.get(item.clientId) ?? new Set<string>();
      item.scopes.forEach((scope) => current.add(scope));
      map.set(item.clientId, current);
      return map;
    }, new Map<string, Set<string>>());
  const grantedScopesForClient = (id: string) => Array.from(grantedScopesByClientId.get(id) ?? []);
  const editableSourceOwnedClientIds = new Set(registeredApps
    .filter((app) => app.appType === "server_local" || (app.appType === "third_party_global" && canEditSourceOwnedConnectedApp(app.status)))
    .map((app) => app.id));
  // This Server's own Apps it has an installation of (GET /integrations/clients
  // joins it), the same rule as another Server's App with an installedAt.
  const ownAppsInstalledHere = new Set(clients.filter((client) => client.installationId).map((client) => client.id));
  // Every App this Server uses or builds, as an installed-app entry: what the
  // installed detail (permissions, the App's bot) opens on.
  const connectedAppEntries: InstalledConnectedApp[] = [
    ...marketplaceClients.filter((app) => app.installedAt && !editableSourceOwnedClientIds.has(app.id)).map((app) => ({
      id: app.id,
      clientId: app.clientId,
      name: renderMarketplaceText("app_name", app.name),
      developer: renderMarketplaceText("developer_name", app.publisherServerName ?? app.publisherName ?? formatMessage({ id: "settings.connectedApps.thirdPartyDeveloper" })),
      description: renderMarketplaceText("description", app.description),
      homepageUrl: app.homepageUrl,
      setupUrl: app.setupUrl, setupDescription: app.setupDescription,
      homepageDomain: getDomainFromUrl(app.homepageUrl),
      callbackDomain: getDomainFromUrl(app.returnUrl),
      logoUrl: app.logoUrl,
      defaultLogoSeed: app.clientId,
      origin: "marketplace" as const,
      privateShared: app.privateShared,
      editable: false,
      official: app.official,
      category: app.category,
      publishStatus: app.publishStatus ?? null,
      allowedScopes: app.allowedScopes,
      grantedScopes: grantedScopesForClient(app.id),
      promptTextConfirmationRequired: promptTextConsent && app.promptTextConfirmationRequired === true,
      permissionApprovalRequired: app.permissionApprovalRequired === true,
      needsAdminReview: app.needsAdminReview === true,
      bot: app.bot,
    })),
    ...registeredApps.filter((app) => editableSourceOwnedClientIds.has(app.id)).map((app) => ({
      id: app.id,
      clientId: app.clientId,
      name: app.name,
      developer: formatMessage({ id: "settings.connectedApps.thisServer" }),
      description: app.description,
      homepageUrl: app.homepageUrl,
      setupUrl: app.setupUrl, setupDescription: app.setupDescription,
      homepageDomain: getDomainFromUrl(app.homepageUrl),
      callbackDomain: getDomainFromUrl(app.returnUrl),
      logoUrl: app.logoUrl,
      defaultLogoSeed: app.defaultLogoSeed,
      origin: "private" as const,
      privateShared: false,
      editable: true,
      official: false,
      category: app.category,
      publishStatus: app.status,
      allowedScopes: app.allowedScopes,
      grantedScopes: grantedScopesForClient(app.id),
      sourceClientId: app.id,
      promptTextConfirmationRequired: promptTextConsent && textConfirmationByClientId[app.id] === true,
      // This Server's own installation of its App: the same list row (and
      // the same rule as the notice count) as another Server's App.
      permissionApprovalRequired: marketplaceClients.some((client) => client.id === app.id && client.permissionApprovalRequired === true),
      installedHere: ownAppsInstalledHere.has(app.id),
      needsAdminReview: app.needsAdminReview === true
        || marketplaceClients.some((client) => client.id === app.id && client.needsAdminReview === true),
      bot: app.bot,
    })),
  ];
  // Installed lists only what is installed here (Apps v4 D3): another Server's
  // App, or one built here once this Server has installed it. Every Raft App
  // this Server builds is under Developer.
  const installedApps = connectedAppEntries.filter((app) => !app.editable || app.installedHere === true);
  const permissionUpdatesCount = installedApps.filter((app) => app.permissionApprovalRequired).length;
  const normalizedSearch = filters.search.trim().toLowerCase();
  const matchesFilters = (app: Parameters<typeof matchesConnectedAppFilter>[0], mcp: boolean) => (
    matchesAppsType(filters.type, mcp) && matchesConnectedAppFilter(app, normalizedSearch, filters.category)
  );
  const filteredInstalledApps = installedApps.filter((app) => matchesFilters(app, false));
  const filteredRegisteredApps = registeredApps.filter((app) => matchesFilters(app, false));
  // MCP Apps are server-local Apps, installed here the moment they are added:
  // they are listed under Installed only, not under Developer (its Raft Apps).
  const mcpAppRows = mcpApps.map((app) => mcpAppAsConnectedApp(app, formatMessage));
  const filteredMcpApps = mcpAppRows.filter((app) => matchesFilters(app, true));
  const installedCount = installedApps.length + mcpApps.length;
  // Every segment of the scope carries its count (Raft DS › Page structure): the Marketplace's is its listings' total, read on the Apps page only.
  const marketplaceTotal = useMarketplaceListingsTotal(marketplaceReloadKey, variant === "page");
  // "Recommended for you": on the page's Installed tab (the Marketplace lists them), unfiltered, once loaded.
  const showRecommendations = variant === "page" && activeTab === "installed" && !hasActiveAppsFilters(filters) && loaded && !loadFailed;
  const recommendations = useMemo(
    () => (showRecommendations ? appRecommendations(marketplaceClients, serverId) : []),
    [marketplaceClients, serverId, showRecommendations],
  );
  const installedHeadingId = useId();
  const registeredCount = registeredApps.length;
  const connectedAppsTabOptions = useMemo(() => [
    { value: "installed" as const, label: formatMessage({ id: "settings.connectedApps.installed" }), count: installedCount, testId: "connected-apps-tab-installed", countTestId: "connected-apps-tab-installed-count" },
    { value: "marketplace" as const, label: formatMessage({ id: "settings.connectedApps.tabMarketplace" }), count: marketplaceTotal, testId: "connected-apps-tab-marketplace", countTestId: "connected-apps-tab-marketplace-count" },
    { value: "myapps" as const, label: formatMessage({ id: "settings.connectedApps.tabMyApps" }), count: registeredCount, testId: "connected-apps-tab-my-apps", countTestId: "connected-apps-tab-my-apps-count" },
  ], [formatMessage, installedCount, marketplaceTotal, registeredCount]);
  const publishCategoryItems = useMemo(() => CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS.map((option) => ({
    value: option.value,
    label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[option.value] }),
  })), [formatMessage]);
  const connectedAppsErrorSurface = getConnectedAppsErrorSurface(
    error,
    selectedListing,
    showRegisterDrawer,
    deleteClientTarget,
    offlineRequestTarget,
    marketplaceUninstallTarget,
  );
  const renderClientSecretReveal = () => {
    if (!createdSecret) return null;
    return (
      <div className="stack-y-2 rounded-container bg-success-soft p-3">
        <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.clientSecret" })}</SectionEyebrow>
        <div className="text-callout text-foreground">{formatMessage({ id: "settings.connectedApps.secretOnce" })}</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 break-all rounded-control border border-line-hairline bg-layer-card px-2.5 py-1.5 font-mono text-mono-meta text-foreground">{createdSecret}</div>
          <Tooltip content={secretCopied ? formatMessage({ id: "settings.connectedApps.copiedSecret" }) : formatMessage({ id: "settings.connectedApps.copySecret" })}>
          <Button
            variant="outline" size="icon-md"
            type="button"
            onClick={handleCopyCreatedSecret}
            className="shrink-0"
            data-testid="connected-app-secret-copy-button"
            data-slot="button"
            aria-live="polite"
            aria-label={secretCopied ? formatMessage({ id: "settings.connectedApps.copiedSecret" }) : formatMessage({ id: "settings.connectedApps.copySecret" })}
          >
            {secretCopied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
          </Tooltip>
        </div>
      </div>
    );
  };

  const profileStatus = formatMessage({ id: clientName.trim() && clientDescription.trim() && clientHomepageUrl.trim()
    ? "settings.connectedApps.editor.status.complete"
    : "settings.connectedApps.editor.status.needsDetails" });
  const loginStatus = formatMessage({ id: clientReturnUrl.trim()
    ? (editingClient
      ? "settings.connectedApps.editor.status.oauthReady"
      : "settings.connectedApps.editor.status.readyToSave")
    : "settings.connectedApps.editor.status.loginOptional" });
  const appPermissionsStatus = formatMessage({ id: "settings.connectedApps.appPermissions.selectionCount" }, { count: appNotificationSelection.groups.length });
  const notificationsStatus = appNotificationLoading
    ? formatMessage({ id: "common.loadingLabel" })
    : formatMessage({ id: !editingClient
      ? "settings.connectedApps.editor.status.saveAppFirst"
      : appNotificationState?.webhook?.enabled
        ? "settings.connectedApps.editor.status.enabled"
        : appNotificationConfigurationOpen
          ? "settings.connectedApps.editor.status.setup"
          : "settings.connectedApps.editor.status.off" });
  const distributionStatus = formatMessage({ id: connectedAppDistributionStatus(editingClient?.publishStatus ?? null) });
  // The editor's section list, in the order the sections are drawn (a new
  // app's form stops before Distribution and the Danger zone).
  const appEditorSections = useMemo(() => [
    { id: "connected-app-editor-profile", label: formatMessage({ id: "settings.connectedApps.section.profile" }) },
    { id: "connected-app-editor-login", label: formatMessage({ id: "settings.connectedApps.section.loginWithRaft" }) },
    { id: "connected-app-editor-setup", label: formatMessage({ id: "appSetup.title" }) },
    { id: "connected-app-editor-permissions", label: formatMessage({ id: "settings.connectedApps.section.appPermissions" }) },
    { id: "connected-app-editor-notifications", label: formatMessage({ id: "settings.connectedApps.section.webhook" }) },
    ...(editingClient
      ? [
        { id: "connected-app-editor-distribution", label: formatMessage({ id: "settings.connectedApps.section.distribution" }) },
        { id: "connected-app-editor-danger", label: formatMessage({ id: "settings.connectedApps.section.dangerZone" }) },
      ]
      : []),
  ], [editingClient, formatMessage]);
  const updateConnectedAppsViewMode = useCallback((viewMode: ConnectedAppsViewMode) => {
    setConnectedAppsViewMode(viewMode);
    try {
      window.localStorage.setItem(CONNECTED_APPS_VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // The preference is optional; the view switch must keep working when storage is unavailable.
    }
  }, []);
  const handleFiltersChange = useCallback((patch: Partial<AppsFilters>) => setFilters((current) => ({ ...current, ...patch })), []);
  // Clear All empties what narrows the list; the Marketplace's order stays.
  const clearFilters = useCallback(() => setFilters((current) => ({ ...DEFAULT_APPS_FILTERS, sort: current.sort })), []);
  // The bot add link (?app_bot=) opens the same detail, marked as opened from the link.
  const showAppBotLinkTarget = useCallback((app: InstalledConnectedApp | undefined) => {
    setActiveTab("installed");
    clearFilters();
    setError("");
    setInstalledDetail(app ? { app, fromLink: true } : null);
  }, [clearFilters]);
  const handleCloseInstalledApp = useCallback(() => setInstalledDetail(null), []);
  const handleOpenInstalledApp = useCallback((app: InstalledConnectedApp) => {
    setError("");
    setInstalledDetail({ app, fromLink: false });
  }, []);
  // A bot profile's App name (?installed_app=) opens the same detail as the card, on the Installed tab.
  const showInstalledAppLinkTarget = useCallback((app: InstalledConnectedApp) => {
    setActiveTab("installed");
    clearFilters();
    handleOpenInstalledApp(app);
  }, [clearFilters, handleOpenInstalledApp]);
  const botLink = useAppBotLink({ loaded, installedApps, show: showAppBotLinkTarget, openInstalled: showInstalledAppLinkTarget, closeDetail: handleCloseInstalledApp });
  // And the first waiting app's review, as its card's button: switching to Installed alone did nothing there (#triage:#156).
  const handleShowPermissionUpdates = useCallback(() => {
    setActiveTab("installed");
    clearFilters();
    const waiting = installedApps.find((app) => app.permissionApprovalRequired);
    if (waiting) handleOpenInstalledApp(waiting);
  }, [clearFilters, installedApps, handleOpenInstalledApp]);
  const handleBrowseMarketplace = useCallback(() => {
    setActiveTab("marketplace");
    clearFilters();
  }, [clearFilters]);
  const handleTabChange = useCallback((value: ConnectedAppsTab) => setActiveTab(value), []);
  const retryLoad = useCallback(() => { void load(); void loadMcpApps(); }, [load, loadMcpApps]);
  // A notification link is a navigation event (again once loaded: the waiting app is known then); later choices stay local.
  const openPermissionUpdatesFromLocation = useEffectEvent(handleShowPermissionUpdates);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("permission_updates") === "1") openPermissionUpdatesFromLocation();
  }, [location.search, loaded]);
  const handleInstalledApprovalUpdated = useCallback(async () => {
    notifyAppPermissionUpdatesChanged(serverId);
    await load();
  }, [load, serverId]);
  const handleEditInstalledApp = useCallback((app: InstalledConnectedApp) => {
    const match = clients.find((client) => client.id === (app.sourceClientId ?? app.id));
    if (match) beginEditClient(match);
  }, [beginEditClient, clients]);
  const handleRequestMarketplaceUninstall = useCallback((app: InstalledConnectedApp | ConnectedAppListing) => {
    setError("");
    setMarketplaceUninstallTarget(app);
  }, []);
  // The open installed App's bot, read live from the lists (not the snapshot
  // taken when the modal opened), so the banner and the section move together.
  const selectedInstalledAppId = selectedInstalledApp?.id ?? null;
  const selectedInstalledBot = selectedInstalledAppId
    ? connectedAppEntries.find((app) => app.id === selectedInstalledAppId)?.bot ?? null
    : null;
  const handleAddSelectedBot = useCallback(() => {
    if (selectedInstalledAppId && selectedInstalledBot) void handleInstalledBotAction(selectedInstalledAppId, selectedInstalledBot, "grant");
  }, [handleInstalledBotAction, selectedInstalledAppId, selectedInstalledBot]);
  // "Don't add": recorded as removed, so the banner goes and the section keeps its Add.
  const handleDeclineSelectedBot = useCallback(() => {
    if (selectedInstalledAppId && selectedInstalledBot) void handleInstalledBotAction(selectedInstalledAppId, selectedInstalledBot, "revoke");
  }, [handleInstalledBotAction, selectedInstalledAppId, selectedInstalledBot]);
  const handleRequestRemoveSelectedBot = useCallback(() => {
    if (selectedInstalledApp && selectedInstalledBot) {
      setBotRemoveTarget({ clientId: selectedInstalledApp.id, appName: selectedInstalledApp.name, bot: selectedInstalledBot });
    }
  }, [selectedInstalledApp, selectedInstalledBot, setBotRemoveTarget]);
  const handleViewBotProfile = useCallback((agentId: string) => {
    handleCloseInstalledApp();
    openProfile("agent", agentId);
  }, [handleCloseInstalledApp, openProfile]);
  // f5: the editor's hint goes to where every Server adds the bot: this App's
  // installed detail (also for an App built here and not yet installed, which
  // adding the bot installs), or the Installed tab when it has no entry.
  // The entries are rebuilt every render; the click reads the latest ones.
  const installedAppsRef = useRef<InstalledConnectedApp[]>([]);
  useEffect(() => {
    installedAppsRef.current = connectedAppEntries;
  });
  const editingClientRowId = editingClient?.id ?? null;
  const handleOpenBotFromEditor = useCallback(() => {
    const entry = editingClientRowId ? installedAppsRef.current.find((app) => app.id === editingClientRowId) : undefined;
    closeRegisterDrawer();
    setActiveTab("installed");
    clearFilters();
    if (entry) setInstalledDetail({ app: entry, fromLink: false });
  }, [clearFilters, closeRegisterDrawer, editingClientRowId]);
  const selectedListingId = selectedListing?.id ?? null;
  const renderUndecidedBotHint = useMarketplaceBotHint({
    installedApps, serverName: current?.name ?? "", canManage, botBusyClientId, onAdd: handleInstalledBotAction,
  });
  const handleInstallBotCheckedChange = useCallback((checked: boolean) => {
    if (selectedListingId) setInstallBotChoice({ listingId: selectedListingId, checked });
  }, [selectedListingId]);
  // Like an ordinary App, an MCP App's editor is for the people who manage Apps; nobody else gets one.
  const handleOpenMcpApp = useCallback((app: { id: string }) => {
    if (!canManage) return;
    setError("");
    setMcpEditor({ appId: app.id });
  }, [canManage]);
  const handleRegisterMcpServer = useCallback(() => {
    setError("");
    setMcpEditor({ appId: null });
  }, []);
  // A Marketplace MCP row's Install, in one step: the App is made from the
  // Raft template (its profile is the listing's), then its editor opens on
  // Connections, where a template's sign-in is added.
  // One install at a time: its row says Installing… and the others wait.
  const [installingTemplateKey, setInstallingTemplateKey] = useState<string | null>(null);
  const installingTemplateKeyRef = useRef<string | null>(null);
  const handleInstallMcpTemplate = useCallback(async (listing: MarketplaceMcpListing) => {
    if (!canManage || installingTemplateKeyRef.current) return;
    installingTemplateKeyRef.current = listing.templateKey;
    setInstallingTemplateKey(listing.templateKey);
    setError("");
    try {
      const { data } = await api.post<McpAppView>("/mcp/apps", {
        source: { kind: "template", templateKey: listing.templateKey },
        profile: profilePayload({
          name: listing.name,
          description: listing.description ?? "",
          homepageUrl: listing.homepageUrl,
          category: listing.category,
          whenToUse: "",
        }),
      });
      showToast({
        type: "success",
        data: { hasIcon: false },
        title: formatMessage(
          { id: data.server.authKind === "none" ? "settings.mcpApp.installedReady" : "settings.mcpApp.installedNeedsConnection" },
          { name: data.profile.name },
        ),
      });
      void loadMcpApps();
      setMarketplaceReloadKey((key) => key + 1);
      setMcpEditor({ appId: data.id, initialSection: "connections" });
    } catch (installError) {
      setError(mcpAppErrorMessage(installError, formatMessage));
    } finally {
      installingTemplateKeyRef.current = null;
      setInstallingTemplateKey(null);
    }
  }, [canManage, formatMessage, loadMcpApps]);
  // Custom MCP App ▸ Browse Marketplace: the MCP Apps Raft maintains.
  const handleBrowseMcpMarketplace = useCallback(() => {
    setMcpEditor(null);
    setActiveTab("marketplace");
    setFilters((current) => ({ ...DEFAULT_APPS_FILTERS, sort: current.sort, type: "mcp" }));
  }, []);
  const handleOpenMarketplaceListing = useCallback((listing: ConnectedAppListing) => {
    setError("");
    setSelectedListing(listing);
  }, []);
  const handleCloseMcpEditor = useCallback(() => setMcpEditor(null), []);
  const handleMcpAppChanged = useCallback(() => {
    void loadMcpApps();
    setMarketplaceReloadKey((key) => key + 1);
  }, [loadMcpApps]);
  const handleCloseListing = useCallback(() => setSelectedListing(null), []);
  const handleRequestUninstallSelectedListing = useCallback(() => {
    if (selectedListing) handleRequestMarketplaceUninstall(selectedListing);
  }, [handleRequestMarketplaceUninstall, selectedListing]);
  const handleInstallSelectedListing = useCallback(() => {
    if (selectedListing) void handleInstallMarketplaceApp(selectedListing);
  }, [handleInstallMarketplaceApp, selectedListing]);
  const handlePickLogo = useCallback(() => logoInputRef.current?.click(), []);
  const handleClientNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientName(event.target.value), []);
  const handleClientHomepageUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientHomepageUrl(event.target.value), []);
  const handleClientCategoryChange = useCallback((value: string | null) => {
    if (value == null) return;
    setClientCategory(value as ConnectedAppCategory);
  }, []);
  const handleClientDescriptionChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setClientDescription(event.target.value), []);
  const handleClientWhenToUseChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientWhenToUse(event.target.value), []);
  const handleClientIdChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientId(event.target.value), []);
  const handleClientReturnUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientReturnUrl(event.target.value), []);
  const handleClientSetupUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientSetupUrl(event.target.value), []);
  const handleClientSetupDescriptionChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientSetupDescription(event.target.value), []);
  const handleClientAgentManifestUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setClientAgentManifestUrl(event.target.value), []);
  const handleAppNotificationStateChange = useCallback((next: AppNotificationsDeveloperState) => {
    setAppNotificationState(next);
    const requested = next.pending_revision ?? { groups: next.current_groups, events: next.current_events };
    setAppNotificationSelection({ groups: requested.groups, events: requested.events });
  }, []);
  // The confirmed text is what agents get now: drop the list's mark without a reload.
  const handlePromptTextConfirmed = useCallback((clientRowId: string) => {
    setTextConfirmationByClientId((current) => ({ ...current, [clientRowId]: false }));
  }, []);
  const renderPromptTextReviewFrame = useCallback((children: ReactNode) => (
    <ConnectedAppDetailSection title={formatMessage({ id: "appPromptText.reviewTitle" })} tone="cream">
      {children}
    </ConnectedAppDetailSection>
  ), [formatMessage]);
  // A published app's text under Raft review is what the developer last
  // saved: the form edits from it, so saving again doesn't put back the live text.
  const handlePendingPromptText = useCallback((fields: AppPromptTextFields) => {
    setClientName(fields.name);
    setClientDescription(fields.description ?? "");
    setClientWhenToUse(fields.whenToUse ?? "");
  }, []);
  const handleRequestPublishEditingClient = useCallback(() => {
    if (editingClient) void handleRequestPublish(mapClientToRegisteredApp(editingClient));
  }, [editingClient, handleRequestPublish]);
  const handleRequestRegenerateSecret = useCallback(() => setRegenerateSecretTarget(editingClient), [editingClient]);
  const handleWithdrawPublishEditingClient = useCallback(() => {
    if (editingClient) void handleWithdrawPublish(mapClientToRegisteredApp(editingClient));
  }, [editingClient, handleWithdrawPublish]);

  const handleRequestOfflineEditingClient = useCallback(() => {
    if (editingClient) setOfflineRequestTarget(mapClientToRegisteredApp(editingClient));
  }, [editingClient]);
  const handleRequestDeleteEditingClient = useCallback(() => {
    if (editingClient) setDeleteClientTarget(mapClientToRegisteredApp(editingClient));
  }, [editingClient]);
  const handleCloseDeleteClient = useCallback(() => setDeleteClientTarget(null), []);
  const handleConfirmDeleteClient = useCallback(
    () => (deleteClientTarget ? handleDeleteClient(deleteClientTarget) : undefined),
    [deleteClientTarget, handleDeleteClient],
  );
  const handleCloseRegenerateSecret = useCallback(() => setRegenerateSecretTarget(null), []);
  const handleConfirmRegenerateSecret = useCallback(
    () => (regenerateSecretTarget ? handleRegenerateClientSecret(regenerateSecretTarget) : undefined),
    [handleRegenerateClientSecret, regenerateSecretTarget],
  );
  const handleCloseOfflineRequest = useCallback(() => setOfflineRequestTarget(null), []);
  const handleConfirmOfflineRequest = useCallback(
    () => (offlineRequestTarget ? handleRequestOffline(offlineRequestTarget) : undefined),
    [handleRequestOffline, offlineRequestTarget],
  );
  const handleCloseMarketplaceUninstall = useCallback(() => setMarketplaceUninstallTarget(null), []);
  const handleConfirmMarketplaceUninstall = useCallback(
    () => (marketplaceUninstallTarget ? handleUninstallMarketplaceApp(marketplaceUninstallTarget) : undefined),
    [handleUninstallMarketplaceApp, marketplaceUninstallTarget],
  );

  // The Apps page scrolls its list under the pinned tabs and toolbar; on a
  // phone a pull reloads it (a snapshot page: Raft DS › Navigation › Refreshing).
  const appsScrollRef = useRef<HTMLDivElement>(null);
  const refreshApps = useCallback(() => Promise.all([load(), loadMcpApps()]), [load, loadMcpApps]);
  const appsPull = usePagePullToRefresh(appsScrollRef, { onRefresh: refreshApps, disabled: variant !== "page" || !serverId });
  const onAppsMobileBack = useMobileBack(current?.slug ? `/s/${current.slug}` : "/");
  const appsMobileBackProps = useMemo(
    () => ({ "data-testid": "apps-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }),
    [formatMessage],
  );

  if (!current) return null;
  const selectedListingBotHint = selectedListing ? renderUndecidedBotHint(selectedListing.id) : null;

  // App Notifications settings are for owners and admins (the server refuses
  // anyone else), so a member's detail neither shows nor requests them.
  const installedPermissions = selectedInstalledApp && canManage ? (
    <InstalledAppNotifications
      clientId={selectedInstalledApp.id}
      service={selectedInstalledApp.clientId}
      canManage={canManage}
      promptTextConsent={promptTextConsent}
      onError={setError}
      onApprovalUpdated={handleInstalledApprovalUpdated}
    />
  ) : null;

  const pageTitle = formatMessage({ id: "apps.page.title" });
  const addAppMenu = canManage ? (
    <RegisterAppMenu
      inToolbar={variant === "page"}
      onRegisterOwnService={openRegisterDrawer}
      onRegisterMcpServer={handleRegisterMcpServer}
    />
  ) : undefined;
  const toolbar = (
    // The tabs are the toolbar's scope, at its start (Raft DS › The toolbar over a list).
    <AppsToolbar
      tab={activeTab}
      tabs={connectedAppsTabOptions}
      onTabChange={handleTabChange}
      filters={filters}
      showSort={activeTab === "marketplace"}
      onChange={handleFiltersChange}
      onClearAll={clearFilters}
      view={connectedAppsViewMode}
      onViewChange={updateConnectedAppsViewMode}
      viewSwitch={<ConnectedAppsViewToggle value={connectedAppsViewMode} onValueChange={updateConnectedAppsViewMode} />}
      // The page's Add App ends its toolbar; Settings keeps it in the section header.
      addApp={variant === "page" ? addAppMenu : undefined}
      variant={variant}
    />
  );
  // A failed load is a Retry, never an empty list (Raft DS › Feedback).
  const loadFailedBanner = (
    <Banner
      intent="warning"
      density="sm"
      live={false}
      data-testid="apps-load-failed"
      actions={(
        <Button type="button" variant="outline" size="md" onClick={retryLoad}>
          <RefreshCw size={16} />
          {formatMessage({ id: "apps.retry" })}
        </Button>
      )}
    >
      {formatMessage({ id: "settings.connectedApps.failedLoad" })}
    </Banner>
  );
  // Rows stand in only once the wait passes a second (ListRowSkeletonList).
  const loadingRows = (
    <div aria-busy="true" data-testid="apps-loading">
      <ListRowSkeletonList count={4} description />
    </div>
  );
  const installedTotal = installedApps.length + mcpApps.length;
  const installedList = (
    <div className="stack-y-2" data-testid="connected-apps-installed-tab">
      {recommendations.length > 0 ? (
        <AppsSectionHeading id={installedHeadingId}>{formatMessage({ id: "settings.connectedApps.installed" })}</AppsSectionHeading>
      ) : null}
      {loadFailed ? loadFailedBanner
        : !loaded ? <InstalledAppsSkeleton viewMode={connectedAppsViewMode} canManage={canManage} />
        : installedTotal === 0 ? (
          <EmptyState
            className="py-10"
            icon={<Blocks size={36} />}
            title={formatMessage({ id: "apps.installed.emptyTitle" })}
            description={formatMessage({ id: canManage ? "apps.installed.emptyDescription" : "apps.installed.emptyDescriptionMember" })}
            action={canManage ? (
              <Button type="button" variant="default" size="md" onClick={handleBrowseMarketplace} data-testid="apps-browse-marketplace">
                {formatMessage({ id: "apps.installed.browseMarketplace" })}
              </Button>
            ) : undefined}
            data-testid="apps-installed-empty"
          />
        )
        : filteredInstalledApps.length === 0 && filteredMcpApps.length === 0 ? (
          <AppsNoMatchState title={formatMessage({ id: "settings.connectedApps.noInstalledAppsMatch" })} filters={filters} onClearAll={clearFilters} />
        ) : (
          <div
            className={connectedAppsCollectionClassName(connectedAppsViewMode)}
            data-testid="connected-apps-installed-collection"
            data-view={connectedAppsViewMode}
          >
            {filteredInstalledApps.map((app) => (
              <InstalledConnectedAppItem
                key={`${app.origin}-${app.id}`}
                testId={`connected-app-item-${app.id}`}
                app={app}
                botAvailable={canManage && app.bot?.grant === "pending"}
                viewMode={connectedAppsViewMode}
                canManage={canManage}
                uninstalling={savingClientId === app.id}
                onOpen={handleOpenInstalledApp}
                onEdit={handleEditInstalledApp}
                onRequestUninstall={handleRequestMarketplaceUninstall}
              />
            ))}
            {filteredMcpApps.map((app) => (
              <InstalledConnectedAppItem
                key={`mcp-${app.id}`}
                testId={`connected-app-item-${app.id}`}
                app={app}
                mcp
                viewMode={connectedAppsViewMode}
                canManage={canManage}
                uninstalling={false}
                onOpen={handleOpenMcpApp}
                onEdit={handleOpenMcpApp}
                onRequestUninstall={handleOpenMcpApp}
              />
            ))}
          </div>
        )}
      {mcpAppsError ? <Banner intent="warning" density="sm">{formatMessage({ id: "settings.connectedApps.mcp.loadFailed" })}</Banner> : null}
      {/* Each person's own link-preview answers, one row at the bottom of
          Installed (#proj-apps task #22), as at the end of Settings ›
          Applications. */}
      {variant === "page" ? <div className="pt-4" data-testid="apps-link-previews"><LinkPreviewConsentsRow /></div> : null}
    </div>
  );
  const installedTab = (
    <AppsRecommendedSection recommendations={recommendations} viewMode={connectedAppsViewMode} canManage={canManage} onOpenApp={handleOpenMarketplaceListing}>
      {installedList}
    </AppsRecommendedSection>
  );
  const myAppsTab = (
    <div className="stack-y-3" data-testid="connected-apps-my-apps-tab">
      <div className="text-footnote text-foreground-muted">
        {canManage
          ? formatMessage({ id: "settings.connectedApps.myAppsIntro" })
          : formatMessage({ id: "settings.connectedApps.myAppsReadOnlyIntro" })}
      </div>
      {loadFailed ? loadFailedBanner
        : !loaded ? loadingRows
        : registeredApps.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={<Blocks size={36} />}
            title={formatMessage({ id: "settings.connectedApps.noRegisteredApps" })}
            description={formatMessage({ id: canManage ? "apps.myApps.emptyDescription" : "apps.myApps.emptyDescriptionMember" })}
            data-testid="apps-my-apps-empty"
          />
        )
        : filteredRegisteredApps.length === 0 ? (
          <AppsNoMatchState title={formatMessage({ id: "settings.connectedApps.noRegisteredAppsMatch" })} filters={filters} onClearAll={clearFilters} />
        ) : (
          <div
            className={connectedAppsCollectionClassName(connectedAppsViewMode)}
            data-testid="connected-apps-my-apps-collection"
            data-view={connectedAppsViewMode}
          >
            {filteredRegisteredApps.map((app) => (
              <RegisteredConnectedAppItem
                key={app.id}
                testId={`connected-app-item-${app.id}`}
                app={app}
                viewMode={connectedAppsViewMode}
                canManage={canManage}
                onEdit={beginEditClient}
              />
            ))}
          </div>
        )}
    </div>
  );
  const body = (
    <>
      {/* Each tab says what it holds; members also read who can change them. */}
      {!canManage ? (
        <div className="text-footnote text-foreground-muted" data-testid="apps-admin-only-note">
          {formatMessage({ id: "settings.connectedApps.adminOnlyNote" })}
        </div>
      ) : null}

      {permissionUpdatesCount > 0 ? (
        <Banner
          intent="warning" density="sm" live={false}
          data-testid="connected-apps-permission-updates"
          actions={<Button type="button" variant="outline" size="md" onClick={handleShowPermissionUpdates}>
            {formatMessage({ id: "settings.connectedApps.viewPermissionUpdates" })}
          </Button>}
        >
          {formatMessage({ id: canManage
            ? "settings.connectedApps.permissionUpdatesSummary"
            : "settings.connectedApps.permissionUpdatesMemberSummary" }, { count: permissionUpdatesCount })}
        </Banner>
      ) : null}

      <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_PAGE} error={error} />

      {botLink.notInstalled ? <ConnectedAppBotLinkNotInstalledNotice onClose={botLink.dismissNotInstalled} /> : null}

      {canManage && !showRegisterDrawer && renderClientSecretReveal()}

      {activeTab === "installed" ? installedTab : null}
      {activeTab === "marketplace" ? (
        <div data-testid="connected-apps-marketplace-tab">
          <MarketplaceListingsTab
            filters={filters}
            viewMode={connectedAppsViewMode}
            query={marketplaceQuery}
            canManage={canManage}
            reloadKey={marketplaceReloadKey}
            onOpenApp={handleOpenMarketplaceListing}
            onInstallMcp={handleInstallMcpTemplate}
            installingTemplateKey={installingTemplateKey}
            onClearFilters={clearFilters}
            botHint={renderUndecidedBotHint}
          />
          {/* Under the Marketplace whatever it shows, as in Settings. */}
          <div className="mt-3 text-center text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.connectedApps.reviewNote" })}
          </div>
        </div>
      ) : null}
      {activeTab === "myapps" ? myAppsTab : null}
    </>
  );
  const dialogs = (
    <>
      {selectedInstalledApp && (
        <ConnectedAppDetailModal
          labelledBy="connected-app-installed-title"
          onClose={handleCloseInstalledApp}
          closeLabel={formatMessage({ id: "settings.connectedApps.closeInstalledAppDetail" })}
          identity={(
              <div className="flex min-w-0 items-start gap-3">
                <ConnectedAppLogo name={selectedInstalledApp.name} logoUrl={selectedInstalledApp.logoUrl} seed={selectedInstalledApp.defaultLogoSeed} size="lg" />
                <div className="min-w-0">
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.installedAppEyebrow" })}</SectionEyebrow>
                  <div id="connected-app-installed-title" className="mt-1 break-words text-headline text-foreground">{selectedInstalledApp.name}</div>
                  <div className="mt-0.5 text-footnote text-foreground-muted">{selectedInstalledApp.developer}</div>
                </div>
              </div>
          )}
          footer={(
            <div>
              <Separator className="mb-4" />
              <div className="flex justify-end">
                <Button
                  type="button" variant="outline" onClick={handleCloseInstalledApp} size="lg">{formatMessage({ id: "settings.common.close" })}</Button>
              </div>
            </div>
          )}
        >
            {error ? <Banner intent="warning" density="sm">{error}</Banner> : null}
            {selectedInstalledBot && canManage && selectedInstalledBot.grant === "pending" ? (
              <ConnectedAppBotPendingBanner
                appName={selectedInstalledApp.name}
                bot={selectedInstalledBot}
                serverName={current.name}
                busy={botBusyClientId === selectedInstalledApp.id}
                onAdd={handleAddSelectedBot}
                onDecline={handleDeclineSelectedBot}
              />
            ) : null}
            {selectedInstalledApp.permissionApprovalRequired ? installedPermissions : null}
            {selectedInstalledBot ? (
              <ConnectedAppBotSection
                appName={selectedInstalledApp.name}
                logoUrl={selectedInstalledApp.logoUrl}
                logoSeed={selectedInstalledApp.defaultLogoSeed}
                bot={selectedInstalledBot}
                serverName={current.name}
                canManage={canManage}
                busy={botBusyClientId === selectedInstalledApp.id}
                onAdd={handleAddSelectedBot}
                onRequestRemove={handleRequestRemoveSelectedBot}
                onViewProfile={handleViewBotProfile}
                {...(installedDetail?.fromLink ? { addLink: botLink.addLink } : {})}
              />
            ) : null}
            {selectedInstalledApp.setupUrl && serverId ? <AppSetupPanel clientId={selectedInstalledApp.id} serverId={serverId} /> : null}
            <OAuthScopeSummaryPanel
              title={formatMessage({ id: "settings.connectedApps.loginAccessTitle" })}
              description={formatMessage({ id: "settings.connectedApps.loginAccessDescription" })}
              scopes={selectedInstalledApp.grantedScopes}
              defaultToDeclared={false}
            />
            {/* The viewer's own link-preview answer for this App, as in Link
                Previews › Manage; nothing when they haven't answered. */}
            <LinkPreviewAppChoice appId={selectedInstalledApp.id} />
            {!selectedInstalledApp.permissionApprovalRequired ? installedPermissions : null}
        </ConnectedAppDetailModal>
      )}

      {selectedListing && (
        <ConnectedAppDetailModal
          labelledBy="connected-app-detail-title"
          onClose={handleCloseListing}
          closeLabel={formatMessage({ id: "settings.connectedApps.closeAppDetail" })}
          identity={(
              <div className="flex items-start gap-3">
                <ConnectedAppLogo name={selectedListing.name} logoUrl={selectedListing.logoUrl} seed={selectedListing.defaultLogoSeed} size="lg" />
                <div>
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.appDetail" })}</SectionEyebrow>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 id="connected-app-detail-title" className="text-headline text-foreground">{selectedListing.name}</h2>
                    <ConnectedAppMarketplaceInstallBadge badge={selectedListing.marketplaceInstallBadge} />
                  </div>
                  <div className="mt-0.5 text-footnote text-foreground-muted">{formatMessage({ id: "settings.connectedApps.byLine" }, { category: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[selectedListing.category] ?? "settings.connectedApps.categoryOther" }), developer: selectedListing.developer })}</div>
                </div>
              </div>
          )}
          footer={(
            <div>
              <Separator className="mb-4" />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button" variant={canManage && !selectedListing.installed ? "ghost" : "outline"} onClick={handleCloseListing} size="lg">
                  {canManage ? formatMessage({ id: "settings.common.cancel" }) : formatMessage({ id: "settings.common.close" })}
                </Button>
                {canManage && !selectedListing.installed && (
                  <Button
                    type="button"
                    disabled={savingClientId === selectedListing.id}
                    onClick={handleInstallSelectedListing}
                    variant="accent"
                    size="lg"
                  >
                    {savingClientId === selectedListing.id ? formatMessage({ id: "settings.connectedApps.installing" }) : formatMessage({ id: "settings.connectedApps.installToServer" })}
                  </Button>
                )}
              </div>
            </div>
          )}
        >
            <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_LISTING} error={error} />
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.profile" })}>
              <p className="mb-2 text-callout text-foreground-muted">{selectedListing.description}</p>
              <div className="text-callout">
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.publisher" })}>
                  {selectedListing.developer}
                </ConnectedAppDetailRow>
                <Separator />
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.homepageUrlLabel" })}>
                  {selectedListing.homepageUrl ? (
                    <ConnectedAppUrlLink url={selectedListing.homepageUrl} />
                  ) : (
                    <span className="break-all font-mono text-mono-meta text-foreground">{selectedListing.homepageDomain}</span>
                  )}
                </ConnectedAppDetailRow>
                <Separator />
                {/* f4: a fact about the App, shown to everyone before the
                    install; not a Login with Raft scope (Kirby). */}
                {selectedListing.bot ? (
                  <>
                    <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.appIdentity.title" })}>
                      <span className="break-all font-mono text-mono-meta text-foreground" data-testid="connected-app-listing-bot">{formatMessage({ id: "common.handle" }, { name: selectedListing.bot.handle })}</span>
                      {/* Installed here with the bot undecided: its Add, or who can add it. */}
                      {selectedListingBotHint ? <div className="mt-2" data-testid="connected-app-listing-bot-hint">{selectedListingBotHint}</div> : null}
                    </ConnectedAppDetailRow>
                    <Separator />
                  </>
                ) : null}
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.redirectCallback" })}>
                  <span className="break-all font-mono text-mono-meta text-foreground">{selectedListing.callbackDomain}</span>
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
                scopes={selectedListing.allowedScopes}
              />
            </ConnectedAppDetailSection>
            {selectedListing.setupUrl ? selectedListing.installed && serverId
              ? <AppSetupPanel clientId={selectedListing.id} serverId={serverId} />
              : <AppSetupRequirement url={selectedListing.setupUrl} description={selectedListing.setupDescription} /> : null}
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.appPermissions" })} tone="cream">
              <AppNotificationRequestSummary
                groups={selectedListing.appNotificationGroups}
                events={selectedListing.appNotificationEvents}
                pendingGroups={selectedListing.appNotificationPendingGroups}
                pendingEvents={selectedListing.appNotificationPendingEvents}
                reviewPending={selectedListing.appNotificationReviewPending}
              />
            </ConnectedAppDetailSection>
            {promptTextConsent ? (
              <MarketplacePromptTextReview
                key={selectedListing.id}
                clientId={selectedListing.id}
                service={selectedListing.clientId}
                frame={renderPromptTextReviewFrame}
                onReviewed={load}
              />
            ) : null}
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.distribution" })} tone="cream">
              <div className="text-footnote text-foreground-muted">
                {formatMessage({ id: "settings.connectedApps.listingReviewNote" })}
              </div>
            </ConnectedAppDetailSection>
            {canManage && !selectedListing.installed && (
              // Exactly what Install sends as expected_scopes / expected_groups:
              // the effective login scopes and the current data
              // groups, unfiltered — not the pending revision shown above.
              <ConnectedAppDetailSection
                title={formatMessage({ id: "settings.connectedApps.section.installApproves" })}
                description={formatMessage({ id: "settings.connectedApps.detail.installApprovesDescription" })}
              >
                <AppPermissionSetList
                  scopes={effectiveAllowedOAuthScopes(selectedListing.allowedScopes)}
                  groups={selectedListing.appNotificationGroups}
                />
                {selectedListing.bot ? (
                  <ConnectedAppBotInstallOption
                    appName={selectedListing.name}
                    bot={selectedListing.bot}
                    serverName={current.name}
                    checked={installWithBot(selectedListing.id)}
                    disabled={savingClientId === selectedListing.id}
                    onCheckedChange={handleInstallBotCheckedChange}
                  />
                ) : null}
              </ConnectedAppDetailSection>
            )}
            {canManage && !selectedListing.installed && promptTextConsent && selectedListing.promptTextRevisionId ? (
              // Exactly what Install sends as expected_text_revision_id: the
              // app's live text, as agents on this Server would get it.
              <ConnectedAppDetailSection
                title={formatMessage({ id: "appPromptText.title" })}
                description={formatMessage({ id: "appPromptText.installNote" })}
              >
                <AppPromptTextBlock fields={selectedListing.promptTextFields} service={selectedListing.clientId} />
              </ConnectedAppDetailSection>
            ) : null}
            {canManage && selectedListing.installed && (
              <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.dangerZone" })}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-footnote text-foreground-muted">
                    {formatMessage({ id: "settings.connectedApps.detail.removeInstalledDescription" })}
                  </div>
                  <Button
                    type="button"
                    disabled={savingClientId === selectedListing.id}
                    onClick={handleRequestUninstallSelectedListing}
                    variant="danger"
                    size="md"
                  >
                    {savingClientId === selectedListing.id ? formatMessage({ id: "settings.connectedApps.uninstalling" }) : formatMessage({ id: "settings.connectedApps.uninstallFromServer" })}
                  </Button>
                </div>
              </ConnectedAppDetailSection>
            )}
        </ConnectedAppDetailModal>
      )}

      {mcpEditor && canManage ? (
        <McpAppEditor
          key={mcpEditor.appId ?? "new"}
          appId={mcpEditor.appId}
          initialSection={mcpEditor.initialSection}
          onBrowseMarketplace={handleBrowseMcpMarketplace}
          canManage={canManage}
          onClose={handleCloseMcpEditor}
          onChanged={handleMcpAppChanged}
        />
      ) : null}

      {canManage && showRegisterDrawer && (
        <FormDialog
          testId="connected-app-editor"
          bodyTestId="connected-app-editor-content"
          navTestId="connected-app-editor-nav"
          navLabel={formatMessage({ id: "settings.connectedApps.appEditorSectionsAriaLabel" })}
          sections={appEditorSections}
          title={editingClient ? formatMessage({ id: "settings.connectedApps.editTitle" }, { name: editingClient.name }) : formatMessage({ id: "settings.connectedApps.registerApp" })}
          closeLabel={formatMessage({ id: "settings.connectedApps.closeAppForm" })}
          onClose={closeRegisterDrawer}
          narrow="sheet"
          onSubmit={handleSaveClient}
          notice={error || createdSecret ? (
            <>
              <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_FORM} error={error} />
              {renderClientSecretReveal()}
            </>
          ) : null}
          footer={(
            <>
              <Button type="button" variant="ghost" size="lg" onClick={closeRegisterDrawer}>
                {formatMessage({ id: "settings.common.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    type="submit"
                    variant="accent"
                    size={inHead ? "md" : "lg"}
                    disabled={isAppWhenToUseTooLong(clientWhenToUse) || submitting || appNotificationLoading || savingClientId === editingClient?.id}
                  >
                    {submitting ? formatMessage({ id: "settings.common.saving" }) : editingClient ? formatMessage({ id: "settings.common.save" }) : formatMessage({ id: "settings.connectedApps.registerSubmit" })}
                  </Button>
                )}
              </DialogCommit>
            </>
          )}
        >
            <ConnectedAppEditorSection
              sectionId="profile"
              title={formatMessage({ id: "settings.connectedApps.section.profile" })}
              description={formatMessage({ id: "settings.connectedApps.editor.profileDescription" })}
              status={profileStatus}
            >
            {promptTextConsent && editingClient ? (
              <DeveloperPromptTextPanel
                key={editingClient.id}
                clientId={editingClient.id}
                service={editingClient.clientId}
                published={editingClient.publishStatus === "published" || editingClient.publishStatus === "unpublish_requested"}
                canManage={canManage}
                onPendingText={handlePendingPromptText}
                onConfirmed={handlePromptTextConfirmed}
              />
            ) : null}
            <FormField
              label={formatMessage({ id: "settings.connectedApps.logoLabel" })}
              // Only before the app exists, when there is no upload yet: how to get one (as an MCP App's).
              hint={editingClient ? undefined : formatMessage({ id: "settings.connectedApps.logoHintNew" })}
            >
              <div className="flex items-center gap-4">
                <ConnectedAppLogo
                  name={clientName || editingClient?.name || "App"}
                  logoUrl={editingClient?.logoUrl}
                  seed={clientId || editingClient?.clientId || "new-app"}
                  size="lg"
                />
                {editingClient && (
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={handleLogoFileChange}
                    />
                    <Button type="button" onClick={handlePickLogo} disabled={logoUploading} size="md">
                      <Upload size={16} />
                      {logoUploading ? formatMessage({ id: "settings.connectedApps.uploading" }) : editingClient.logoUrl ? formatMessage({ id: "settings.connectedApps.change" }) : formatMessage({ id: "settings.connectedApps.upload" })}
                    </Button>
                    {editingClient.logoUrl && (
                      <Button type="button" variant="ghost" onClick={handleClearLogo} disabled={logoUploading} size="md">
                        {formatMessage({ id: "settings.connectedApps.reset" })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </FormField>
            <FormField label={formatMessage({ id: "settings.connectedApps.appNameLabel" })}>
              <Input
                type="text"
                value={clientName}
                onChange={handleClientNameChange}
                className="w-full"
                placeholder={formatMessage({ id: "settings.connectedApps.appNamePlaceholder" })}
                required
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={formatMessage({ id: "settings.connectedApps.homepageUrlFieldLabel" })}>
                <Input
                  type="url"
                  value={clientHomepageUrl}
                  onChange={handleClientHomepageUrlChange}
                  className="w-full"
                  render={<input placeholder="https://example.com" />}
                />
              </FormField>
              <FormField label={formatMessage({ id: "settings.connectedApps.categoryLabel" })}>
                <Select
                  value={clientCategory}
                  onValueChange={handleClientCategoryChange}
                  items={publishCategoryItems}
                >
                  <SelectTrigger className="w-full" aria-label={formatMessage({ id: "settings.connectedApps.appCategoryAriaLabel" })}>
                    <SelectValue placeholder={formatMessage({ id: "settings.connectedApps.categoryLabel" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>{renderSelectItems(publishCategoryItems)}</SelectList>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label={formatMessage({ id: "settings.connectedApps.descriptionLabel" })}>
              <Textarea
                value={clientDescription}
                onChange={handleClientDescriptionChange}
                rows={3}
                placeholder={formatMessage({ id: "settings.connectedApps.descriptionPlaceholder" })}
                className="resize-none"
              />
            </FormField>
            <FormField
              label={formatMessage({ id: "settings.connectedApps.clientIdLabel" })}
              hint={formatMessage({ id: editingClient ? (clientKeyEditable ? "settings.connectedApps.clientIdEditHint" : "settings.connectedApps.clientIdLockedHint") : "settings.connectedApps.clientIdHint" })}
              optional={!editingClient}
            >
              <Input
                type="text"
                value={clientId}
                onChange={handleClientIdChange}
                className="w-full font-mono"
                placeholder={editingClient ? undefined : formatMessage({ id: "settings.connectedApps.clientIdPlaceholder" })}
                disabled={!!editingClient && !clientKeyEditable}
              />
            </FormField>
            <AppWhenToUseField value={clientWhenToUse} onChange={handleClientWhenToUseChange} />
            {editingClient?.linkPreviewReadOnly ? <ConnectedAppLinkPreviewReadOnlyBanner /> : null}
            </ConnectedAppEditorSection>

            <ConnectedAppEditorSection
              sectionId="login"
              title={formatMessage({ id: "settings.connectedApps.section.loginWithRaft" })}
              description={formatMessage({ id: "settings.connectedApps.editor.loginDescription" })}
              status={loginStatus}
            >
            <FormField label={formatMessage({ id: "settings.connectedApps.returnUrlLabel" })}>
              <Input
                type="url"
                value={clientReturnUrl}
                onChange={handleClientReturnUrlChange}
                className="w-full"
                render={<input placeholder="https://example.com/login/callback" />}
              />
            </FormField>
            <FormField label={formatMessage({ id: "settings.connectedApps.agentManifestLabel" })} optional>
              <Input
                type="url"
                value={clientAgentManifestUrl}
                onChange={handleClientAgentManifestUrlChange}
                className="w-full"
                render={<input placeholder="https://example.com/.well-known/raft-agent-manifest.json" />}
              />
            </FormField>
            <DeclaredScopesPicker value={clientAllowedScopes} onChange={setClientAllowedScopes} />
            </ConnectedAppEditorSection>
            <ConnectedAppEditorSection sectionId="setup" title={formatMessage({ id: "appSetup.title" })} description={formatMessage({ id: "appSetup.editorHint" })} status={formatMessage({ id: clientSetupRequired ? "appSetup.requiredAfterInstall" : "appSetup.notRequired" })}>
              <AppSetupFields required={clientSetupRequired} url={clientSetupUrl} description={clientSetupDescription} onRequiredChange={setClientSetupRequired} onUrlChange={handleClientSetupUrlChange} onDescriptionChange={handleClientSetupDescriptionChange} />
            </ConnectedAppEditorSection>
            <ConnectedAppEditorSection
              sectionId="permissions"
              title={formatMessage({ id: "settings.connectedApps.section.appPermissions" })}
              description={formatMessage({ id: "settings.connectedApps.appPermissions.description" })}
              status={appPermissionsStatus}
            >
              <DeveloperAppPermissions clientId={editingClient?.id ?? null} value={appNotificationSelection} onChange={setAppNotificationSelection} state={appNotificationState} loading={appNotificationLoading} />
              <Separator className="my-3" />
              <label className={`flex items-start gap-3 ${submitting ? "opacity-60" : ""}`}>
                <Checkbox
                  checked={clientEnableBot}
                  disabled={submitting}
                  onCheckedChange={handleEnableBotCheckedChange}
                  className="mt-0.5"
                  data-testid="connected-app-enable-bot"
                />
                <span className="min-w-0">
                  <span className="block text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.connectedApps.enableAppIdentityLabel" })}</span>
                  <span className="mt-0.5 block text-caption text-foreground-muted">
                    {formatMessage({ id: "settings.connectedApps.enableAppIdentityDescription" })}
                  </span>
                </span>
              </label>
              {/* The bot joins a Server from that Server's installed-app detail,
                  this one included (f5): the editor only says where. */}
              {editingClient?.enableBot && clientEnableBot && editingClient.bot ? (
                <p className="mt-2 pl-8 text-footnote text-foreground-muted" data-testid="connected-app-bot-editor-hint">
                  {formatMessage({ id: "settings.connectedApps.appIdentity.editorHint" }, {
                    handle: editingClient.bot.handle,
                    link: (chunks: ReactNode[]) => (
                      <TextLink key="installed-apps" variant="strong" onClick={handleOpenBotFromEditor}>{chunks}</TextLink>
                    ),
                  })}
                </p>
              ) : null}
            </ConnectedAppEditorSection>
            <ConnectedAppEditorSection
              sectionId="notifications"
              title={<AppNotificationsLabel />}
              description={formatMessage({ id: "settings.connectedApps.editor.notificationsDescription" })}
              status={notificationsStatus}
            >
            <DeveloperAppNotifications
              embedded
              clientId={editingClient?.id ?? null}
              value={appNotificationSelection}
              onChange={setAppNotificationSelection}
              state={appNotificationState}
              loading={appNotificationLoading}
              onConfigurationOpenChange={setAppNotificationConfigurationOpen}
              onStateChange={handleAppNotificationStateChange}
              onError={setError}
            />
            </ConnectedAppEditorSection>
            {/* Sharing, publishing and the app's lifecycle act on a saved app;
                a new app's form stops at what can be filled in now (the
                Webhook section says that it waits for the save). */}
            {editingClient && (
            <ConnectedAppEditorSection
              sectionId="distribution"
              title={formatMessage({ id: "settings.connectedApps.section.distribution" })}
              description={formatMessage({ id: "settings.connectedApps.editor.distributionDescription" })}
              status={distributionStatus}
            >
            {sourceOwnedConnectedAppStatusHint(editingClient.publishStatus) ? (
              <Banner live={false} intent="warning" density="sm">
                {formatMessage({ id: sourceOwnedConnectedAppStatusHint(editingClient.publishStatus)! })}
              </Banner>
            ) : null}
            {(editingClient.publishStatus === "publish_requested" || editingClient.publishStatus === "in_review") && (
              <ConnectedAppEditorActionRow
                testId="connected-app-withdraw-publish-card"
                title={formatMessage({ id: "settings.connectedApps.editor.withdrawPublishTitle" })}
                description={formatMessage({ id: "settings.connectedApps.editor.withdrawPublishDescription" })}
                action={(
                  <Button
                    type="button"
                    size="md"
                    onClick={handleWithdrawPublishEditingClient}
                    disabled={savingClientId === editingClient.id}
                    data-testid="connected-app-withdraw-publish-button"
                  >
                    {formatMessage({ id: "settings.connectedApps.editor.withdrawPublish" })}
                  </Button>
                )}
              />
            )}
            {(editingClient.publishStatus === "private" || editingClient.publishStatus === "rejected") && (
              <ConnectedAppEditorActionRow
                testId="connected-app-private-share-card"
                title={formatMessage({ id: "settings.connectedApps.privateShareTitle" })}
                description={formatMessage({ id: "settings.connectedApps.privateShareTargetDesc" })}
              >
                <ConnectedAppShareLinks
                  key={editingClient.id}
                  clientId={editingClient.id}
                  onClientUpdated={applyUpdatedClient}
                  onError={setError}
                />
              </ConnectedAppEditorActionRow>
            )}
            {(editingClient.publishStatus === "private" || editingClient.publishStatus === "rejected") && (
              <ConnectedAppEditorActionRow
                title={formatMessage({ id: "settings.connectedApps.publishRequestTitle" })}
                description={formatMessage({ id: "settings.connectedApps.distributionMetadataNote" })}
                action={(
                  <Button
                    type="button"
                    onClick={handleRequestPublishEditingClient}
                    disabled={isAppWhenToUseTooLong(clientWhenToUse) || savingClientId === editingClient.id}
                    size="md"
                  >
                    {savingClientId === editingClient.id ? formatMessage({ id: "settings.connectedApps.requesting" }) : formatMessage({ id: "settings.connectedApps.requestPublish" })}
                  </Button>
                )}
              />
            )}
            {editingClient.publishStatus === "published" ? (
              <Banner live={false} intent="success" density="sm">
                {formatMessage({ id: "settings.connectedApps.publishedMarketplaceNote" })}
              </Banner>
            ) : null}
            </ConnectedAppEditorSection>
            )}

            {editingClient && (
            <ConnectedAppEditorSection
              sectionId="danger"
              title={formatMessage({ id: "settings.connectedApps.section.dangerZone" })}
              description={formatMessage({ id: "settings.connectedApps.editor.dangerDescription" })}
              status={formatMessage({ id: "settings.connectedApps.editor.dangerStatusRestricted" })}
            >
              <ConnectedAppEditorActionRow
                title={formatMessage({ id: "settings.connectedApps.editor.clientSecretTitle" })}
                description={formatMessage({ id: "settings.connectedApps.editor.clientSecretDescription" })}
                action={(
                  <Button
                    type="button"
                    size="md"
                    variant="warning"
                    onClick={handleRequestRegenerateSecret}
                    disabled={submitting || regeneratingClientId === editingClient.id}
                    data-testid="connected-app-regenerate-secret-button"
                  >
                    {formatMessage({ id: regeneratingClientId === editingClient.id
                      ? "settings.connectedApps.editor.regeneratingClientSecret"
                      : "settings.connectedApps.editor.regenerateClientSecret" })}
                  </Button>
                )}
              />
              {canRequestOfflineSourceOwnedConnectedApp(editingClient.publishStatus) ? (
                <ConnectedAppEditorActionRow
                  title={formatMessage({ id: "settings.connectedApps.editor.marketplaceLifecycleTitle" })}
                  description={formatMessage({ id: "settings.connectedApps.editor.marketplaceLifecycleDescription" })}
                  action={(
                    <Button type="button" size="md" onClick={handleRequestOfflineEditingClient}>
                      {formatMessage({ id: "settings.connectedApps.editor.requestOffline" })}
                    </Button>
                  )}
                />
              ) : null}
              {canDeleteSourceOwnedConnectedApp(editingClient.publishStatus) ? (
                <ConnectedAppEditorActionRow
                  testId="connected-app-delete-card"
                  title={formatMessage({ id: "settings.connectedApps.deleteApp" })}
                  description={formatMessage({ id: "settings.connectedApps.deleteAppDescription" })}
                  action={(
                    <Button type="button" size="md" variant="danger" onClick={handleRequestDeleteEditingClient}>
                      <Trash2 size={16} />
                      {formatMessage({ id: "settings.connectedApps.delete" })}
                    </Button>
                  )}
                />
              ) : null}
            </ConnectedAppEditorSection>
            )}
        </FormDialog>
      )}

      {canManage && deleteClientTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.connectedApps.deleteAppTitle" }, { name: deleteClientTarget.name })}
          message={(
            <>
              {formatMessage({ id: "settings.connectedApps.deleteAppMessagePrefix" })}
              <code className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{deleteClientTarget.clientId}</code>
              {formatMessage({ id: "settings.connectedApps.deleteAppMessageSuffix" })}
            </>
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.deleteApp" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.deleting" })}
          confirmIcon={<Trash2 size={14} />}
          confirmTestId="connected-app-delete-confirm-button"
          layer={showRegisterDrawer ? 1 : undefined}
          onClose={handleCloseDeleteClient}
          onConfirm={handleConfirmDeleteClient}
        />
      )}

      {canManage && regenerateSecretTarget && (
        <ConfirmDialog
          title={formatMessage(
            { id: "settings.connectedApps.editor.regenerateSecretConfirmTitle" },
            { name: regenerateSecretTarget.name },
          )}
          message={formatMessage(
            { id: "settings.connectedApps.editor.regenerateSecretConfirmMessage" },
            {
              clientId: regenerateSecretTarget.clientId,
              code: (chunks) => <code key="client-id" className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{chunks}</code>,
            },
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.editor.regenerateSecretConfirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.editor.regeneratingClientSecret" })}
          confirmIcon={<AlertTriangle size={14} />}
          confirmVariant="warning"
          confirmTestId="connected-app-regenerate-secret-confirm-button"
          layer={1}
          onClose={handleCloseRegenerateSecret}
          onConfirm={handleConfirmRegenerateSecret}
        />
      )}

      {canManage && offlineRequestTarget && (
        <ConfirmDialog
          title={formatMessage(
            { id: "settings.connectedApps.editor.requestOfflineConfirmTitle" },
            { name: offlineRequestTarget.name },
          )}
          message={formatMessage(
            { id: "settings.connectedApps.editor.requestOfflineConfirmMessage" },
            {
              clientId: offlineRequestTarget.clientId,
              code: (chunks) => <code key="client-id" className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{chunks}</code>,
            },
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.editor.requestOfflineConfirm" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.editor.requestOfflineConfirmLoading" })}
          confirmIcon={<Upload size={14} className="rotate-180" />}
          confirmVariant="warning"
          layer={showRegisterDrawer ? 1 : undefined}
          onClose={handleCloseOfflineRequest}
          onConfirm={handleConfirmOfflineRequest}
        />
      )}

      {canManage && botRemoveTarget ? (
        <ConnectedAppBotRemoveDialog
          appName={botRemoveTarget.appName}
          handle={botRemoveTarget.bot.handle}
          onConfirm={handleConfirmBotRemove}
          onClose={handleCloseBotRemove}
        />
      ) : null}
      {canManage && marketplaceUninstallTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.connectedApps.uninstallAppTitle" }, { name: marketplaceUninstallTarget.name })}
          message={(
            <>
              {formatMessage({ id: "settings.connectedApps.uninstallMessagePrefix" })}
              <code className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{marketplaceUninstallTarget.clientId}</code>
              {formatMessage({ id: "settings.connectedApps.uninstallMessageSuffix" })}
              {marketplaceUninstallTarget.official && (
                <> {formatMessage({ id: "settings.connectedApps.uninstallOfficialOptOut" })}</>
              )}
            </>
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.uninstallApp" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.uninstallingConfirm" })}
          confirmIcon={<Trash2 size={14} />}
          confirmTestId="connected-app-uninstall-confirm-button"
          layer={selectedListing?.id === marketplaceUninstallTarget.id ? 1 : undefined}
          onClose={handleCloseMarketplaceUninstall}
          onConfirm={handleConfirmMarketplaceUninstall}
        />
      )}
    </>
  );

  if (variant === "page") {
    // Raft DS › Page structure: the head (the title alone), the toolbar (the
    // tabs its scope, Add App at its end) drawn at once and pinned; only the
    // list scrolls. On a phone it is a pushed page with Back.
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas text-foreground" data-testid="apps-page">
        <PanelHeader
          title={pageTitle}
          onMobileBack={onAppsMobileBack}
          mobileBackProps={appsMobileBackProps}
        />
        <div className="shrink-0">
          {toolbar}
        </div>
        <ScrollArea ref={appsScrollRef} className="min-h-0 flex-1" contentClassName="px-4 py-4 safe-bottom md:px-(--surface-inset)" data-testid="apps-page-scroller">
          <PagePullToRefreshIndicator pull={appsPull} />
          <div className="stack-y-4" data-testid="connected-apps-v3-section">
            {body}
          </div>
        </ScrollArea>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="mb-6 stack-y-4" data-testid="connected-apps-v3-section">
      <SectionHeader icon={<AppWindow size={16} />} label={connectedAppsLabel} action={addAppMenu} />
      <div>
        {toolbar}
      </div>
      {body}
      {dialogs}
    </div>
  );
}
