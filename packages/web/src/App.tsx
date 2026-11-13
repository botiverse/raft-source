import { Button, ScrollArea, EmptyState, EmptyStateActions, EmptyStateContent, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@botiverse/raft-ui";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { usePreviewApiTarget } from "./hooks/usePreviewApiTarget";
import { Routes, Route, Navigate, useParams, useNavigate, useLocation, matchPath } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useOfflineSessionStore } from "./store/offlineSession";
import { useIntl } from "react-intl";
import { useLocale } from "./i18n/LocaleProvider";
import { shouldReconcileAccountLocale } from "./i18n/locale";
import { requestServerListEarly, useServerStore } from "./store/serverStore";
import { loadClientConfig } from "./store/clientConfig";
import { preloadServerRoute } from "./store/preloadServerRoute";
import { startRwRecovery } from "./store/rwStaleCounts";
import { clearAllLastCounts } from "./store/lastCounts";
import { forgetDrafts } from "./store/draftStorage";
import { localTableSession } from "./store/localTables/storeWriters";
import type { CommunityServerSlug, Server } from "./store/serverStore";
import { useAgentStore } from "./store/agentStore";
import { useMachineStore } from "./store/machineStore";
import { purgeStoredMachineKeys } from "./store/machineKeyStorage";
import { useTranslationStore } from "./store/translationStore";
import { serverPersistence } from "./store/serverPersistenceRegistry";
import { EXTERNAL_INVITE_ROUTE, SERVER_CONNECT_REQUEST_ROUTE, externalLinkSignIn } from "./components/externalInvite/externalInviteAccept";
import { INTEGRATION_INVITE_ROUTE } from "@botiverse/raft-shared";
import PublicServerPage from "./pages/PublicServerPage";
import { useChannelStore } from "./store/channelStore";
import { findStoredChannel } from "./store/storedChannel";
import { useThreadStore } from "./store/threadStore";
import api from "./api/client";
import ServerSetupProjectionGate from "./components/onboarding/ServerSetupProjectionGate";
import { SignInPage } from "./components/auth/SignInPage";
import InAppBrowserGuide from "./components/deeplinks/InAppBrowserGuide";
import { OpenInAppOffers } from "./components/deeplinks/OpenInAppOffers";
import { startServerFeatureFlagRefreshOnFocus } from "./store/serverFeatureFlags";
import { landingAfterVerify } from "./components/auth/verificationLanding";
import { PendingSecondFactorSignInStep, useSecondFactorSignInPending } from "./components/auth/SecondFactorSignInStep";
import { useRememberDesktopPasskeyAccount } from "./utils/desktopPasskeySignIn";
import { RECOVERY_CANCEL_PARAM, RECOVERY_CONFIRM_PARAM, parseRecoveryLinkToken } from "./components/auth/secondFactorRecovery";
import { takeAccountDeletionCancelLink } from "./pages/accountDeletionCancelLink";
import ServerSelector from "./components/auth/ServerSelector";
import SignedInAs from "./components/auth/SignedInAs";
import { ImageLightboxHost } from "./components/ImageLightboxHost";
import DocumentPreviewHost from "./components/message/DocumentPreviewHost";
import SecondFactorStepUpHost from "./components/settings/SecondFactorStepUpHost";
import { AccountDeletionGate } from "./pages/AccountDeletionGate";
import MediaPreviewHost from "./components/message/MediaPreviewHost";
import MainLayout from "./components/layout/MainLayout";
import MessageSelectionShortcut from "./components/message/MessageSelectionShortcut";
import DesktopNativeNotifications from "./notifications/desktopNative/DesktopNativeNotifications";
import NotificationRuntime from "./notifications/NotificationRuntime";
import {
  MAX_AUTH_RESTORE_MS,
  getAuthBootstrapView,
  shouldRetryAuthRestore,
} from "./utils/authRestoreMachine";
import { getRestoreTimeoutAction } from "./utils/restoreTimeoutPolicy";
import { shouldRecoverAuthOnBrowserSignal } from "./utils/browserRecoveryPolicy";
import { PENDING_INVITE_STORAGE_KEY, takePendingInviteRedirectPath } from "./utils/socialAuth";
import { ssoTestLandingPath } from "./utils/ssoSignIn";
import { requiresAccountProfileSetup } from "./utils/accountProfileSetup";
import { useLastLocationResume } from "./hooks/useLastLocationResume";
import { useEmbedParamsKeeper } from "./hooks/useEmbedParamsKeeper";
import { readServerSurfaceMemory } from "./hooks/useTabRouteMemory";
import {
  consumeServerSelectionRequest,
  isServerSelectionRequested,
  requestServerSelection,
} from "./utils/serverSelectionRequest";
import {
  isChangePasswordIntentPath,
  serverEntryPath,
} from "./utils/changePasswordNavigation";
import { NavigationDepthTracker, useAppNavigate, useHasInAppPageBehind } from "./hooks/useAppNavigate";
import { useJoinCommunityFlow } from "./hooks/useJoinCommunityFlow";
import { bootRequestsServerListEarly, isAuthHandoffPage, opensServerFrame } from "./boot/serverFrame";
import { ArtifactLinkLoading, artifactLinkLeaveServer, artifactPermalinkTargetOf, artifactShortAddressOf, loadArtifactPermalink, loadPublicArtifactPage } from "./apps/artifacts";
import {
  CHINESE_COMMUNITY_SERVER_SLUG,
  CHINESE_COMMUNITY_PAGE_PATH,
  DEFAULT_COMMUNITY_SERVER_SLUG,
} from "./utils/communityServers";
import {
  SLOCKDEV_EMAIL,
  SLOCKDEV_PASSWORD,
  getEnvironmentLabelMessageId,
  getPreviewEnvironmentDetails,
  getSlockdevSeedCommand,
  initialAuthView,
  isSlockdevEnvironment,
  shouldAutoLoginSlockdev,
} from "./utils/devMode";
import type {
  AuthView,
} from "./utils/devMode";
import { emitAuthTraceAndFlush } from "./utils/webAuthTrace";
import { jointInviteAcceptErrorMessage } from "./utils/jointChannelLimit";
import { showToast } from "./components/toastBridge";
import { LazyChunkBoundary } from "./boot/lazyChunk";
import { lazyPanel } from "./boot/deferredUi";
import { importHandledLocally } from "./utils/dynamicImportRecovery";
import { HIDE_LOCAL_DEV_TOOLS_EVENT } from "./components/dev/devOverlayEvents";
import Tooltip from "./components/ui/Tooltip";
import { ServerOff, Settings, X } from "lucide-react";
import { PendingServerLayout } from "./components/layout/PendingServerLayout";
import { OfflineServerLayout } from "./components/layout/OfflineServerLayout";
import { AuthBootstrapStatus, Landing } from "./components/auth/AuthBootstrapStatus";
import {
  MobileDownloadChooserPage,
  ChineseCommunityPage,
  AppSumoRedemptionPage,
  AppSumoServerCreationPage,
  DeviceLoginPage,
  DeviceLoginRevokePage,
  SecondFactorRecoveryLinkPage,
  AppLoginPage,
  HumanLoginSetupPage,
  IntegrationInvitePage,
  ExternalInvitePage,
  ExternalInviteLandingPage,
  ServerConnectRequestPage,
  AgentConnectionCallbackPage,
  RegisterPage,
  AccountIdentitySetupPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  EmailVerificationPage,
  InviteAcceptPage,
  SocialAuthCallbackPage,
  SsoAuthCallbackPage,
  AccountDeletionCancelLinkPage,
  AccountBootstrapPreviewPage,
} from "./pages/lazyLandingPages";
import { preloadSignedOutSteps } from "./pages/landingPages";
import { isHostShell } from "./embed";
import { HostIntegration } from "./host/hostCommands";
import { isNativeOnboardingPath, readNativeOnboardingGeneration } from "./embed/nativeOnboarding";
import {
  genericAppDocumentTitle,
  getServerRouteDocumentTitle,
  hostShellFallbackDocumentTitle,
  serverRouteChannelId,
  serverRouteDmId,
  serverRouteAgentId,
  serverRouteMachineId,
  useBrowserDocumentTitle,
  useServerPageDocumentLabelValue,
  documentTitleChannelLabel,
} from "./utils/browserDocumentTitle";

// Dev-only preview routes: lazy, so a production build drops them (the route
// renders a redirect there).
const ServerSetupComputerRuntimePreviewPage = lazyPanel(() => import("./pages/ServerSetupComputerRuntimePreviewPage"));
const DisplayStylePreviewPage = lazyPanel(() => import("./pages/DisplayStylePreviewPage"));

// The environment badge's draggable overlay: dev, staging and preview builds
// only (EnvironmentDevOverlay renders nothing in production), so a production
// page never loads it. A failed load leaves the badge out, not the app.
const DraggableDevOverlay = lazy(() => importHandledLocally(() => import("./components/dev/DraggableDevOverlay")));

/** Parse URL search params once */
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const joinMatch = window.location.pathname.match(/^\/join\/([^/?#]+)/);
  return {
    authCallback: params.get("auth_callback"),
    appLoginHandoff: !!matchPath("/login/app", window.location.pathname),
    verifyToken: params.get("verify"),
    // The verification link's page to land on after verifying (#88); validated by the server and again before use.
    verifyReturnTo: params.get("verify") ? params.get("returnTo") : null,
    resetToken: params.get("reset"),
    // A device login's revoke link (mailed after approving one); works signed in or out.
    deviceLoginRevokeToken: params.get("revoke_device_login"),
    // The two-step verification reset emails (confirm / cancel); work signed in or out.
    secondFactorRecoveryLink: params.has(RECOVERY_CONFIRM_PARAM)
      ? { mode: "confirm" as const, token: parseRecoveryLinkToken(params.get(RECOVERY_CONFIRM_PARAM)) }
      : params.has(RECOVERY_CANCEL_PARAM)
        ? { mode: "cancel" as const, token: parseRecoveryLinkToken(params.get(RECOVERY_CANCEL_PARAM)) }
        : null,
    // The account deletion email's cancel link; works signed in or out.
    accountDeletionCancelLink: takeAccountDeletionCancelLink(), // scrubs the token and sets no-referrer before any render
    inviteToken: params.get("invite") || joinMatch?.[1] || null,
  };
}

const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
const isSlockdev = isSlockdevEnvironment(deploymentEnv);
const environmentLabelMessageId = getEnvironmentLabelMessageId(deploymentEnv);

function routeCommunitySlug(value: string | undefined): CommunityServerSlug | null {
  if (value === DEFAULT_COMMUNITY_SERVER_SLUG || value === CHINESE_COMMUNITY_SERVER_SLUG) return value;
  return null;
}

export { requestServerSelection };

// Environment debug panel actions that need no component state. Kept apart from
// `clearLocalState` (below), the one panel action allowed to clear auth tokens.
function reloadPage() {
  window.location.reload();
}

function openServerPicker() {
  requestServerSelection();
  serverPersistence.clearLastServerSlug();
  window.location.assign("/");
}

function EnvironmentDevOverlay() {
  const { pathname } = useLocation();
  const isRaftBench = !!matchPath("/s/:serverSlug/raftbench", pathname);
  const previewApiTarget = usePreviewApiTarget(deploymentEnv === "web-preview");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const { formatMessage } = useIntl();
  const closePanel = useCallback(() => setOpen(false), []);
  const togglePanel = useCallback(() => setOpen((value) => !value), []);
  const hideAllDevTools = useCallback(() => {
    document.documentElement.dataset.raftDevToolsHidden = "true";
    window.dispatchEvent(new Event(HIDE_LOCAL_DEV_TOOLS_EVENT));
    setOpen(false);
    setHidden(true);
  }, []);
  if (!environmentLabelMessageId) return null;
  if (isSlockdev && import.meta.env?.VITE_SLOCKDEV_HIDE_PANEL === "1") return null;
  if (hidden) return null;
  const environmentLabel = formatMessage({ id: environmentLabelMessageId });
  const previewEnvironmentDetails = getPreviewEnvironmentDetails(
    {
      branch: import.meta.env?.VITE_PREVIEW_BRANCH,
      commitSha: import.meta.env?.VITE_COMMIT_SHA,
      apiTarget: previewApiTarget,
    },
    formatMessage,
  );
  const badgeLabel = `${environmentLabel}${previewEnvironmentDetails ? ` · ${previewEnvironmentDetails}` : ""}`;
  const triggerTitle = formatMessage(
    { id: "devTools.overlay.triggerTitle" },
    { label: badgeLabel },
  );
  return (
    <LazyChunkBoundary resetKey={null} failed={null}>
      <Suspense fallback={null}>
        <DraggableDevOverlay
          id="environment-dev-tools"
          handleSelector="[data-dev-overlay-handle]"
          panel={open ? (
            <EnvironmentDebugPanel
              environmentLabel={badgeLabel}
              onClose={closePanel}
              onHideAll={hideAllDevTools}
            />
          ) : null}
          open={open}
          onOpenChange={setOpen}
          collapsible
          collapsedChildren={(
            <Button
              type="button"
              variant="primary"
              size="icon-md"
              aria-hidden="true"
              data-dev-overlay-handle
              className="flex size-6 touch-none select-none items-center justify-center cursor-grab active:cursor-grabbing"
            >
              <Settings size={12} strokeWidth={2.5} />
            </Button>
          )}
          className={`fixed z-app w-max max-w-[calc(100vw-1rem)] font-display${isRaftBench ? " max-md:hidden" : ""}`}
          title={triggerTitle}
          testId="raftdev-debug-overlay"
        >
          <Button
            type="button"
            variant="primary"
            size="icon-md"
            data-dev-overlay-handle
            onClick={togglePanel}
            aria-label={triggerTitle}
            className="size-7 touch-none select-none cursor-grab active:cursor-grabbing"
            data-testid="raftdev-debug-trigger"
          >
            <Settings size={14} strokeWidth={2.5} aria-hidden="true" />
          </Button>
        </DraggableDevOverlay>
      </Suspense>
    </LazyChunkBoundary>
  );
}

function clearLocalState() {
  emitAuthTraceAndFlush("slock.auth.session_cleared", {
    clearSessionCaller: "clearLocalState",
    logoutTrigger: "dev_clear_local_state",
  });
  forgetDrafts(localTableSession());
  localStorage.removeItem("slock_access_token");
  localStorage.removeItem("slock_refresh_token");
  clearAllLastCounts();
  purgeStoredMachineKeys();
  serverPersistence.clearLastServerSlug();
  localStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
  window.location.assign("/");
}

interface EnvironmentDebugPanelProps {
  environmentLabel: string; // the badge label, shown as the header outside slockdev
  onClose: () => void;
  onHideAll: () => void;
}

// Every non-production environment's dev panel. Dev login, Clear Local Session
// (RFC 016 dev-only sink) and the seed command show only on slockdev.
function EnvironmentDebugPanel(props: EnvironmentDebugPanelProps) {
  const { environmentLabel, onClose, onHideAll } = props;
  const [copied, setCopied] = useState(false);
  const { formatMessage } = useIntl();
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const envName = import.meta.env?.VITE_SLOCKDEV_ENV_NAME || "";
  const previewDescription = import.meta.env?.VITE_SLOCKDEV_PREVIEW_DESCRIPTION?.trim() || "";
  const seedCommand = getSlockdevSeedCommand(envName);

  const devLogin = useCallback(() => login(SLOCKDEV_EMAIL, SLOCKDEV_PASSWORD).catch((err) => {
    console.error("Dev login failed", err);
  }), [login]);

  const handleLogout = useCallback(() => logout(), [logout]);

  const copySeedCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(seedCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.warn("Failed to copy raftdev seed command", err);
    }
  }, [seedCommand]);

  return (
    // No scroller here: the overlay's popover scrolls the panel (DraggableDevOverlay).
    <div className="w-72 max-w-[calc(100vw-1rem)] rounded-container bg-layer-popover p-3 text-caption text-foreground shadow-float ring-1 ring-line-seam">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-footnote font-bold text-foreground">
                {formatMessage({ id: "devTools.overlay.panelTitle" })}
              </div>
              <div className="mt-0.5 text-foreground-muted">
                <div className="truncate">{isSlockdev ? envName || "slockdev" : environmentLabel}</div>
                <div className="truncate">
                  {user ? <SignedInAs user={user} nameClassName="font-normal" /> : formatMessage({ id: "devTools.overlay.notSignedIn" })}
                </div>
              </div>
            </div>
            <Button
              type="button"
              onClick={onClose}
              size="icon-md"
              variant="ghost"
              aria-label={formatMessage({ id: "common.close" })}
              data-testid="raftdev-debug-close"
              className="size-6 shrink-0 self-start"
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>

          {isSlockdev && previewDescription ? (
            <Tooltip content={previewDescription}>
              <details className="mb-2 rounded-control border border-line-hairline bg-fill-muted p-2">
                <summary className="cursor-pointer select-none text-caption font-bold text-foreground-muted">
                  Preview description
                </summary>
                {/* A ScrollArea, a <div>: its scrollbars can't go in a <p>. */}
                <ScrollArea overscroll="auto" className="mt-1 max-h-24 whitespace-pre-wrap break-words text-foreground-muted">
                  {previewDescription}
                </ScrollArea>
              </details>
            </Tooltip>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            {isSlockdev ? (
              <Button
                type="button"
                disabled={loading}
                onClick={devLogin}
                variant="accent"
                size="md"
                className="w-full min-w-0"
              >
                Dev login
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={reloadPage}
              variant="outline"
              size="md"
              className="w-full min-w-0"
            >
              {formatMessage({ id: "devTools.overlay.reload" })}
            </Button>
            <Button
              type="button"
              onClick={openServerPicker}
              variant="outline"
              size="md"
              className="w-full min-w-0"
            >
              {formatMessage({ id: "devTools.overlay.serverPicker" })}
            </Button>
            <Button
              type="button"
              onClick={handleLogout}
              variant="outline"
              size="md"
              className={isSlockdev ? "w-full min-w-0" : "col-span-2 w-full min-w-0"}
            >
              {formatMessage({ id: "settings.session.logOutAction" })}
            </Button>
            {isSlockdev ? (
              <Button
                type="button"
                onClick={clearLocalState}
                variant="warning"
                size="md"
                className="col-span-2 w-full"
              >
                Clear Local Session
              </Button>
            ) : null}
            {isSlockdev ? (
              <Button
                type="button"
                onClick={copySeedCommand}
                variant="primary"
                size="md"
                className="col-span-2 h-auto min-h-8 w-full justify-start whitespace-normal break-all text-left font-mono text-[11px]"
              >
                {copied ? "Copied" : seedCommand}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={onHideAll}
              variant="outline"
              size="md"
              className="col-span-2 h-auto min-h-8 w-full justify-start whitespace-normal text-left text-[10px]"
            >
              {formatMessage({ id: "devTools.overlay.hideUntilReload" })}
            </Button>
          </div>

        </div>
  );
}

/** ServerSelector pick → make it current and open its remembered surface. */
function useOpenSelectedServer(replace: boolean) {
  const setCurrent = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();
  return useCallback((server: Server) => {
    setCurrent(server);
    navigate(readServerSurfaceMemory(server.slug) ?? `/s/${server.slug}`, { replace });
  }, [navigate, replace, setCurrent]);
}

/** `/s/<slug>` absent from the user's server list (#triage:#235). Not-a-member and
 *  no-such-server look the same here, so the copy is neutral. No auto-redirect: the
 *  one button goes to the current or last server, else to the picker at "/". */
export function ServerAccessDeniedPage() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const current = useServerStore((s) => s.current);
  const navigate = useNavigate();
  const lastSlug = serverPersistence.readLastServerSlug();
  const fallbackServer =
    (current ? servers.find((server) => server.id === current.id) : null) ??
    (lastSlug ? servers.find((server) => server.slug === lastSlug) : null) ??
    null;

  const leave = useCallback(() => {
    if (fallbackServer) {
      navigate(readServerSurfaceMemory(fallbackServer.slug) ?? `/s/${fallbackServer.slug}`, { replace: true });
      return;
    }
    // No known server to go back to, so "/" has none to restore: it shows the picker.
    navigate("/", { replace: true });
  }, [fallbackServer, navigate]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar px-4 font-display safe-top safe-bottom">
      <EmptyState data-testid="server-not-found">
        <EmptyStateContent>
          <EmptyStateIcon>
            <ServerOff size={36} />
          </EmptyStateIcon>
          <EmptyStateTitle render={<h1>{formatMessage({ id: "pages.serverNotFound.title" })}</h1>} />
          <EmptyStateDescription>{formatMessage({ id: "pages.serverNotFound.description" })}</EmptyStateDescription>
        </EmptyStateContent>
        <EmptyStateActions>
          <Button variant="default" size="md" type="button" onClick={leave}>
            {fallbackServer
              ? formatMessage({ id: "pages.serverNotFound.backToServer" }, { name: fallbackServer.name })
              : formatMessage({ id: "pages.serverNotFound.chooseServer" })}
          </Button>
        </EmptyStateActions>
      </EmptyState>
    </div>
  );
}


/** Resolves server from URL slug and renders MainLayout */
export function ServerResolver() {
  const { formatMessage } = useIntl();
  const { serverSlug } = useParams<{ serverSlug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const appNav = useAppNavigate();
  const servers = useServerStore((s) => s.servers);
  const current = useServerStore((s) => s.current);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const loading = useServerStore((s) => s.loading);
  const server = serverSlug ? servers.find((s) => s.slug === serverSlug) : undefined;
  const routeAgentId = serverSlug ? serverRouteAgentId(location.pathname, serverSlug) : null;
  const routeMachineId = serverSlug ? serverRouteMachineId(location.pathname, serverSlug) : null;
  const routeChannelId = serverSlug ? serverRouteChannelId(location.pathname, serverSlug) : null;
  const routeDmId = serverSlug ? serverRouteDmId(location.pathname, serverSlug) : null;
  const openThreadParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const openThreadParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const routeAgent = useAgentStore((state) =>
    routeAgentId ? state.agents.find((agent) => agent.id === routeAgentId) : undefined
  );
  const routeMachine = useMachineStore((state) =>
    routeMachineId ? state.machines.find((machine) => machine.id === routeMachineId) : undefined
  );
  const routeChannelTitleLabel = useChannelStore((state) => {
    const scopedChannelId = routeChannelId ?? routeDmId;
    if (!scopedChannelId) return null;
    return documentTitleChannelLabel(
      findStoredChannel(state, scopedChannelId),
    );
  });
  const threadChannelTitleLabel = useChannelStore((state) => {
    if (!openThreadParentMessageId || !openThreadParentChannelId) return null;
    return documentTitleChannelLabel(
      findStoredChannel(state, openThreadParentChannelId),
    );
  });
  const missingCommunitySlug = routeCommunitySlug(server ? undefined : serverSlug);
  const directCommunityRouteIntentRef = useRef<CommunityServerSlug | null>(null);
  const communityAutoJoinAttemptedRef = useRef<string | null>(null);
  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: (joinedServer) => {
      setCurrent(joinedServer);
    },
    onError: (error, slug, message) => {
      communityAutoJoinAttemptedRef.current = null;
      console.error(`[Community] Failed to join ${slug} from direct route: ${message}`, error);
    },
  });
  const jointInviteId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("jointInvite");
  }, [location.search]);
  const jointInviteAcceptingRef = useRef<string | null>(null);
  const [showServerSelector, setShowServerSelector] = useState(false);
  const routeServerName = server?.name;
  const routeServerSlug = server?.slug;
  // The page's own name for itself (the Artifacts home, the Artifact open over it), ahead of the route's.
  const pageTitleLabel = useServerPageDocumentLabelValue();
  const hostShell = isHostShell();
  const titleFallbacks = useMemo(() => ({
    agent: formatMessage({ id: "title.agentFallback" }),
    computer: formatMessage({ id: "title.computerFallback" }),
    computers: formatMessage({ id: "title.computers" }),
  }), [formatMessage]);
  const routeDocumentTitle = useMemo(
    () =>
      routeServerName !== undefined && routeServerSlug
        ? getServerRouteDocumentTitle(
            location.pathname,
            { name: routeServerName, slug: routeServerSlug },
            {
              pageLabel: pageTitleLabel,
              agentLabel: routeAgent?.displayName || routeAgent?.name,
              machineLabel: routeMachine?.name,
              channelLabel: routeChannelTitleLabel,
              threadChannelLabel: threadChannelTitleLabel,
            },
            hostShell,
            titleFallbacks,
          )
        : hostShell
          ? hostShellFallbackDocumentTitle(titleFallbacks)
          : genericAppDocumentTitle(),
    [hostShell, location.pathname, pageTitleLabel, routeAgent?.displayName, routeAgent?.name, routeChannelTitleLabel, routeMachine?.name, routeServerName, routeServerSlug, threadChannelTitleLabel, titleFallbacks],
  );

  useEffect(() => {
    if (loading || server) return;
    if (consumeServerSelectionRequest()) {
      directCommunityRouteIntentRef.current = null;
      setShowServerSelector(true);
      navigate("/", { replace: true });
      return;
    }
    if (missingCommunitySlug === CHINESE_COMMUNITY_SERVER_SLUG) {
      directCommunityRouteIntentRef.current = null;
      navigate(`${CHINESE_COMMUNITY_PAGE_PATH}?from=direct-community-route`, { replace: true });
      return;
    }
    if (missingCommunitySlug) {
      directCommunityRouteIntentRef.current = missingCommunitySlug;
    } else {
      directCommunityRouteIntentRef.current = null;
    }
  }, [loading, missingCommunitySlug, navigate, server]);

  useEffect(() => {
    if (loading || server || !missingCommunitySlug) return;
    if (directCommunityRouteIntentRef.current !== missingCommunitySlug) return;
    if (communityAutoJoinAttemptedRef.current === missingCommunitySlug) return;
    communityAutoJoinAttemptedRef.current = missingCommunitySlug;
    void communityJoinFlow.joinCommunity(missingCommunitySlug).then((outcome) => {
      if (outcome.status === "error") {
        communityAutoJoinAttemptedRef.current = null;
      }
    });
  }, [communityJoinFlow, loading, missingCommunitySlug, server]);

  useEffect(() => {
    if (server && directCommunityRouteIntentRef.current === server.slug) {
      directCommunityRouteIntentRef.current = null;
    }
  }, [server]);

  useEffect(() => {
    if (loading || !serverSlug) return;
    if (server && server.id !== current?.id) {
      setCurrent(server);
      // The conversation this URL opens starts loading now, not after the layout mounts.
      preloadServerRoute(window.location.pathname, window.location.search, useAuthStore.getState().user?.id ?? null);
    }
  }, [serverSlug, server, loading, current?.id, setCurrent]);

  useBrowserDocumentTitle(routeDocumentTitle);
  const openSelectedServer = useOpenSelectedServer(true);

  useEffect(() => {
    if (!jointInviteId || !server || !current || current.id !== server.id) return;
    if (jointInviteAcceptingRef.current === jointInviteId) return;

    jointInviteAcceptingRef.current = jointInviteId;
    api.post(`/channels/joint-invites/${encodeURIComponent(jointInviteId)}/accept`)
      .then(async ({ data }) => {
        const channelId = typeof data?.id === "string" ? data.id : null;
        if (channelId) {
          await useChannelStore.getState().ensureChannel(channelId);
          appNav.toChannel(channelId);
          return;
        }
        const params = new URLSearchParams(location.search);
        params.delete("jointInvite");
        const query = params.toString();
        navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true });
      })
      .catch((err) => {
        jointInviteAcceptingRef.current = null;
        console.error("Failed to accept joint channel invite", err);
        showToast({ title: jointInviteAcceptErrorMessage(err, formatMessage, server.name), type: "error" });
      });
  }, [appNav, current, formatMessage, jointInviteId, location.pathname, location.search, navigate, server]);

  if (loading) {
    return <PendingServerLayout />;
  }

  if (!server) {
    if (missingCommunitySlug && communityJoinFlow.joiningCommunitySlug === missingCommunitySlug) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar font-display safe-top">
          <div className="text-headline text-foreground-muted">{formatMessage({ id: "pages.app.joiningCommunity" })}</div>
        </div>
      );
    }
    // Someone who owns NO servers has not been denied anything — they simply have not
    // made one yet. Sending them to "server not found" and then bouncing them to the
    // create-server screen showed an error for something they never did wrong, and made
    // logging back in mid-onboarding flash a denial before landing where they left off.
    // The first-server flow IS the right screen here, so render it directly.
    if (showServerSelector || servers.length === 0) {
      return (
        <ServerSelector onSelect={openSelectedServer} />
      );
    }
    return (
      <>
        <ServerAccessDeniedPage />
        {communityJoinFlow.agreementDialog}
      </>
    );
  }

  if (!current || current.id !== server.id) {
    return <PendingServerLayout />;
  }

  // Standalone onboarding surface for CLIENT hosts only (Native WebView with a
  // wake generation). Renders only the server-authoritative setup gate — no
  // channel/sidebar/settings shell and no route-derived completion guess. The
  // browser flow renders the same gate as Modals inside MainLayout instead.
  // Authentication still goes through AppShell, and ServerResolver still proves
  // the slug belongs to the signed-in principal.
  // `key={server.id}` (same contract as MainLayout below): the gate's
  // projection state, wake once-refs, and connection-watch baselines are
  // per-server, and refreshProjection has no stale-response guard, so a
  // cross-server reuse would land server A's late projection read into
  // server B's surface. The `current.id !== server.id` guard above happens to
  // unmount the gate during a switch too, but that is update-timing, not a
  // stated contract — the key makes the isolation explicit.
  if (isNativeOnboardingPath(location.pathname, server.slug)) {
    const generation = readNativeOnboardingGeneration(location.search);
    // Only clients enter the standalone surface (artin, #proj-mobile d89d3318):
    // the client always opens this URL with its wake generation. A plain browser
    // without one gets the Modal flow on the main surface instead.
    if (!generation) return <Navigate to={`/s/${server.slug}`} replace />;
    return (
      <main
        className="relative flex min-h-0 flex-1 bg-layer-sidebar font-display safe-top safe-bottom"
        data-testid="native-onboarding-web-surface"
      >
        <ServerSetupProjectionGate
          key={server.id}
          serverId={server.id}
          serverSlug={server.slug}
          completionWakeGeneration={generation}
          dedicatedSurface
        />
      </main>
    );
  }

  // `/thread-window` is intentionally kept as a first-class route even though
  // the in-app "open in new tab" entry points (thread header / overflow menu,
  // task card, message context menu) were removed on 2026-09-10 by product
  // call. The route, its URL sync and the window components stay so the
  // standalone window can be re-exposed later without rebuilding the plumbing
  // — see utils/openPanelInNewTab.ts (builders, no UI callsites today).
  if (location.pathname === `/s/${server.slug}/thread-window`) {
    // Remount on a new deep-link identity so an async failure from a previous
    // popup target cannot bleed into the next thread/task opened in this tab.
    return <Landing><ThreadWindowRoute key={location.search} /></Landing>;
  }

  return <MainLayout key={server.id} />;
}

export function ServerSelectionPage() {
  const { formatMessage } = useIntl();
  const loading = useServerStore((s) => s.loading);
  const openSelectedServer = useOpenSelectedServer(false);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar font-display safe-top">
        <div className="text-headline text-foreground-muted">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  return (
    <ServerSelector onSelect={openSelectedServer} />
  );
}

// The standalone thread window (`/thread-window`, no in-app entry today): loaded only on its route.
const ThreadWindowRoute = lazyPanel(() => import("./components/window/ThreadWindowRoute"));
// The canonical Artifact link's page: loaded only on its route.
const ArtifactPermalink = lazyPanel(loadArtifactPermalink);
// The same link signed out, when the Artifact is public: loaded only on its route.
const PublicArtifactPage = lazyPanel(loadPublicArtifactPage);

/** Resolves once the reader's server list is in (or failed): whatever loads it, this only waits. */
function serverListSettled(): Promise<void> {
  return new Promise((resolve) => {
    if (!useServerStore.getState().loading) return resolve();
    const stop = useServerStore.subscribe((state) => {
      if (state.loading) return;
      stop();
      resolve();
    });
  });
}

/**
 * Route: the canonical Artifact link, `/artifacts/:artifactId` and
 * `/artifacts/:artifactId/v/:version` (the address agents post, phones open
 * in a web view and "Open in new page" opens). It names no server: the
 * Artifacts app asks `open` at once (no server sent, nothing waited for),
 * which answers where it opens; this route makes that server current, and
 * the Artifact shows on a page of its own, outside the server layout (no
 * rail, no sidebar). A public Artifact of a server the reader doesn't read
 * it in shows read-only, no server entered. Signed out, AppShell shows the
 * public page or sign-in at this same address first.
 *
 * Back (history back) only when there is an in-app page behind this one
 * (useHasInAppPageBehind: an entry this document showed): the Artifact's
 * page then has Back, else "Open in #channel" to where it lives
 * (#proj-workspace:#104). Its "can't open" page names who is signed in and
 * offers Switch Account (sign out: sign-in comes back at this same address),
 * the same Back, and Go to Raft, which goes to the reader's last server
 * rather than the server chooser.
 */
export function ArtifactPermalinkRoute() {
  const { artifactId, version } = useParams<{ artifactId: string; version: string }>();
  const navigate = useNavigate();
  const routeLocation = useLocation();
  // An older link's `pt_<uuid>`, followed inside the app: the address as links are written now (the short id), in
  // place (boot already did this for a link opened from outside). The same Artifact, so the page doesn't ask again.
  const shortAddress = artifactShortAddressOf(routeLocation.pathname);
  useEffect(() => {
    if (shortAddress) navigate(`${shortAddress}${routeLocation.search}${routeLocation.hash}`, { replace: true, state: routeLocation.state });
  }, [shortAddress, navigate, routeLocation.search, routeLocation.hash, routeLocation.state]);
  const open = useCallback((path: string) => navigate(path, { replace: true }), [navigate]);
  const go = useCallback((path: string) => navigate(path), [navigate]);
  // Another version is another address, a new history entry (Back returns to the one before).
  const showVersion = useCallback((path: string) => navigate(path), [navigate]);
  const leave = useCallback(() => {
    void serverListSettled().then(() => {
      const slug = artifactLinkLeaveServer(useServerStore.getState().servers, serverPersistence.readLastServerSlug());
      navigate(slug ? (readServerSurfaceMemory(slug) ?? `/s/${slug}`) : "/", { replace: true });
    });
  }, [navigate]);
  const account = useAuthStore((s) => s.user?.email ?? null);
  const logout = useAuthStore((s) => s.logout);
  // Raft's app owns the account (signing out here signs the app out): no Switch Account inside it.
  const switchAccount = useMemo(() => (isHostShell() ? undefined : () => logout()), [logout]);
  const pageBehind = useHasInAppPageBehind();
  const goBack = useCallback(() => navigate(-1), [navigate]);
  // Outside the server layout, so its keeper isn't mounted: a version switch (`/v/<n>`) drops the query, and the
  // App's WebView must find the embed params in the URL after a reload, as the latch keeps them for the session.
  useEmbedParamsKeeper();
  // The server it opens in becomes the current one, so the page's reads carry it (X-Server-Id). Making it current
  // needs its entry in the reader's list: already current, nothing to wait for; else the list, once it is in.
  const enterServer = useCallback(async ({ serverId }: { serverId: string }) => {
    if (useServerStore.getState().current?.id === serverId) return true;
    await serverListSettled();
    const state = useServerStore.getState();
    const server = state.servers.find((candidate) => candidate.id === serverId);
    if (!server) return false;
    if (state.current?.id !== server.id) state.setCurrent(server);
    return true;
  }, []);
  // `open`'s 404 fallback (a joint channel's Artifact seen from the reader's other server): `locate` asked, as the
  // link used to, from the current server, else the last one, else any, once the list is in.
  const locateFrom = useCallback(async () => {
    await serverListSettled();
    const { servers, current } = useServerStore.getState();
    const lastSlug = serverPersistence.readLastServerSlug();
    const from = (current ? servers.find((server) => server.id === current.id) : undefined)
      ?? (lastSlug ? servers.find((server) => server.slug === lastSlug) : undefined)
      ?? servers[0];
    return from ? { id: from.id, slug: from.slug } : null;
  }, []);
  // The located server becomes the current one, as `open`'s does.
  const enterLocated = useCallback((serverSlug: string) => {
    const state = useServerStore.getState();
    const server = state.servers.find((candidate) => candidate.slug === serverSlug);
    if (!server) return null;
    if (state.current?.id !== server.id) state.setCurrent(server);
    return { slug: server.slug, name: server.name };
  }, []);
  // A page of its own, not the server's: no server frame while it loads either. The open-in-app offers as on a
  // workspace page (#proj-mobile:#128): a computer's banner across the top, a phone's row at the bottom, for a share
  // link that landed here from outside (Raft Desktop opens `/artifacts/` since #14481).
  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <OpenInAppOffers slot="top" />
    <Suspense fallback={<ArtifactLinkLoading onGoBack={pageBehind ? goBack : undefined} />}>
      <ArtifactPermalink
        id={artifactId}
        version={version}
        onOpen={open}
        enterServer={enterServer}
        locateFrom={locateFrom}
        enterLocated={enterLocated}
        onGo={go}
        onShowVersion={showVersion}
        onLeave={leave}
        account={account}
        onSwitchAccount={switchAccount}
        onGoBack={pageBehind ? goBack : undefined}
      />
    </Suspense>
    <OpenInAppOffers slot="bottom" />
    </div>
  );
}

/** Auto-redirect to last server, or show ServerSelector */
export function ServerRedirect() {
  const servers = useServerStore((s) => s.servers);
  const loading = useServerStore((s) => s.loading);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();
  const [showServerSelector] = useState(() => consumeServerSelectionRequest());
  const location = useLocation();
  const openSelectedServer = useOpenSelectedServer(true);

  // `/.well-known/change-password` redirects here before auth is known. The
  // pathname survives the signed-out login screen, so once auth + the server
  // list are restored this same resolver can choose the browser's remembered
  // server without inventing an account-global settings surface.
  const changePasswordIntent = isChangePasswordIntentPath(location.pathname);

  const enterSelectedServer = useCallback((server: Server) => {
    setCurrent(server);
    // replace, like every other root → server hop: the picker at "/" only
    // exists while no last server is remembered, so a history Back onto it
    // would just re-run ServerRedirect and bounce forward again.
    navigate(serverEntryPath({
      serverSlug: server.slug,
      rememberedSurface: readServerSurfaceMemory(server.slug),
      changePasswordIntent,
    }), { replace: true });
  }, [changePasswordIntent, navigate, setCurrent]);

  if (loading) {
    return <PendingServerLayout />;
  }

  // A deliberate Server Picker action must win over normal last-server and
  // deep-location restoration, including on a cold navigation to "/".
  if (showServerSelector) {
    return <ServerSelector onSelect={openSelectedServer} />;
  }

  // Back from an SSO connection's test sign-in: that Server's SSO settings show the result.
  const ssoTestLanding = ssoTestLandingPath(location.search, servers);
  if (ssoTestLanding) return <Navigate to={ssoTestLanding} replace />;
  // Auto-redirect to last used server
  const lastSlug = serverPersistence.readLastServerSlug();
  const lastServer = lastSlug ? servers.find((s) => s.slug === lastSlug) : null;
  if (lastServer) {
    return (
      <Navigate
        to={serverEntryPath({
          serverSlug: lastServer.slug,
          rememberedSurface: readServerSurfaceMemory(lastServer.slug),
          changePasswordIntent,
        })}
        replace
      />
    );
  }

  // No last server — show selector (user picks or creates)
  return <ServerSelector onSelect={enterSelectedServer} />;
}

// Standalone palette audit page (#proj-uiux:0e6befb8 task #92).
// Bypasses auth + MainLayout so it can scroll freely (the normal
// shell pins #root with overflow:hidden which fights long pages).
// Routed at the App boundary so the auth/data hooks below run inside
// AppShell and are never conditionally skipped — earlier the early-return
// gated `window.location.pathname === "/palette-audit"` made every hook in
// AppShell rules-of-hooks-conditional under SPA nav.
// Already signed in: the login/register entry points are inert.
function ignoreAuthEntry() {}


export function AppShell() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const initialized = useAuthStore((s) => s.initialized);
  const restoreState = useAuthStore((s) => s.restoreState);
  // Opened offline: the last session from the device, while /auth/me can't be reached (store/offlineSession.ts).
  const offlineUser = useOfflineSessionStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const loadUser = useAuthStore((s) => s.loadUser);
  const logout = useAuthStore((s) => s.logout);

  const serverLoading = useServerStore((s) => s.loading);
  const servers = useServerStore((s) => s.servers);
  const loadServers = useServerStore((s) => s.loadServers);
  const navigate = useNavigate();
  const location = useLocation();

  const [authView, setAuthView] = useState<AuthView>(() => initialAuthView(location.pathname));
  const [publicViewDismissed, setPublicViewDismissed] = useState(false);
  const [externalInviteLandingDismissed, setExternalInviteLandingDismissed] = useState(false);
  // The canonical Artifact link (`/artifacts/<id>`, `/v/<n>`) whose public
  // page gave way to sign-in: not public (its one 404), or Sign In chosen.
  const [publicArtifactDismissedFor, setPublicArtifactDismissedFor] = useState<string | null>(null);
  const [devAutoLoginAttempted, setDevAutoLoginAttempted] = useState(false);

  // Read URL params once on mount, but inviteToken is stateful so it can be cleared
  const urlParamsRef = useMemo(() => getUrlParams(), []);
  const [inviteToken, setInviteToken] = useState<string | null>(urlParamsRef.inviteToken);
  const urlParams = useMemo(() => ({ ...urlParamsRef, inviteToken }), [urlParamsRef, inviteToken]);

  const appLoginHandoff = !!matchPath("/login/app", location.pathname);
  const secondFactorPending = useSecondFactorSignInPending();
  // Raft Desktop: once a signed-in account has a passkey, its sign-in page offers one (design D8).
  useRememberDesktopPasskeyAccount(user?.id ?? null);

  // Load user on mount. On a server page the server list goes out alongside
  // (requestServerListEarly), held until the gate below lets loadServers run.
  // The deployment's client config (Raft's app hosts) too, signed in or not:
  // once per page load (store/clientConfig).
  useEffect(() => {
    loadUser();
    void loadClientConfig();
    // A canonical Artifact link's page enters the server `open` names from the list too (ArtifactPermalinkRoute).
    // Same gate as main.tsx after an early token refresh (boot/serverFrame), plus Artifact links.
    if (bootRequestsServerListEarly(window.location)
      || (!isAuthHandoffPage(window.location) && artifactPermalinkTargetOf(window.location.pathname) !== null)) {
      requestServerListEarly();
    }
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- boot only: the first location decides
  }, [loadUser]);

  // Reconcile the UI display language to the signed-in user's server-persisted
  // preference once auth bootstrap settles (login / cold-load restore).
  // Missing/unsupported account values resolve English-first; explicit en or
  // zh-cn values win exactly. Waiting for an initialized, authenticated user
  // avoids overwriting a valid cached explicit choice while the account record
  // is in flight or after logout (signed-out state is not an account value).
  // Lives here (not in LocaleProvider) to keep the auth store out of the i18n
  // module graph.
  const { locale, setLocaleFromUser } = useLocale();
  const authenticatedUserId = user?.id ?? null;
  const userDisplayLanguage = user?.displayLanguage ?? null;
  // Syncs an external source (auth store's server-persisted preference, which
  // arrives async on login/restore) INTO the locale context — not derived
  // render state, so an effect is correct here.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    if (!shouldReconcileAccountLocale({ initialized, userId: authenticatedUserId })) return;
    setLocaleFromUser(userDisplayLanguage);
  }, [authenticatedUserId, initialized, userDisplayLanguage, setLocaleFromUser]);

  // The no-preference message-translation target is the display language;
  // push each change into the translation store (outside React).
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    useTranslationStore.getState().followDisplayLanguage(locale);
  }, [locale]);

  const hasStoredSession = !!(accessToken && refreshToken);
  const authBootstrapView = getAuthBootstrapView({ initialized, restoreState });
  const authRestoreStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!shouldAutoLoginSlockdev({
      deploymentEnv,
      initialized,
      attempted: devAutoLoginAttempted,
      hasUser: !!user,
      hasStoredSession,
      authView,
      authCallback: urlParams.authCallback,
      resetToken: urlParams.resetToken,
      inviteToken: urlParams.inviteToken,
    })) {
      return;
    }

    // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setDevAutoLoginAttempted(true);
    login(SLOCKDEV_EMAIL, SLOCKDEV_PASSWORD).catch((err) => {
      console.warn("Slockdev auto-login failed", err);
    });
  }, [
    initialized,
    devAutoLoginAttempted,
    user,
    hasStoredSession,
    authView,
    urlParams.authCallback,
    urlParams.resetToken,
    urlParams.inviteToken,
    login,
  ]);

  // Mobile browsers can transiently fail /auth/me during foreground restore.
  // Keep retrying session restoration while credentials still exist so the UI
  // doesn't bounce back to the login screen during a recoverable outage.
  //
  // Restore timeout policy (Auth Session Contract, #2494 / restoreTimeoutPolicy
  // #2497): a timer alone is TRANSIENT evidence and must never sign a user out
  // who still has a stored session. All three timer-only branches below
  // (initial check, retry-interval check, setTimeout fallback) route through
  // `getRestoreTimeoutAction()`: only `"logout"` calls `logout()`; the
  // stored-session timeout case returns `"degraded_retry"` so retry continues
  // without clearing the token. Terminal logout is the loadUser /
  // getAuthVerdict path's authority alone.
  useEffect(() => {
    if (!shouldRetryAuthRestore({ initialized, restoreState, hasStoredSession })) {
      authRestoreStartedAtRef.current = null;
      return;
    }

    if (authRestoreStartedAtRef.current === null) {
      authRestoreStartedAtRef.current = Date.now();
    }

    const elapsedMs = Date.now() - authRestoreStartedAtRef.current;
    const initialAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs });
    if (initialAction === "logout") {
      logout("restore_timeout");
      return;
    }

    const retryInterval = window.setInterval(() => {
      const retryElapsedMs = authRestoreStartedAtRef.current === null
        ? 0
        : Date.now() - authRestoreStartedAtRef.current;
      const retryAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs: retryElapsedMs });
      if (retryAction === "logout") {
        logout("restore_timeout");
        return;
      }
      loadUser();
    }, 1500);
    const timeout = window.setTimeout(() => {
      const timeoutElapsedMs = authRestoreStartedAtRef.current === null
        ? MAX_AUTH_RESTORE_MS
        : Date.now() - authRestoreStartedAtRef.current;
      const timeoutAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs: timeoutElapsedMs });
      if (timeoutAction === "logout") {
        logout("restore_timeout");
      }
    }, Math.max(0, MAX_AUTH_RESTORE_MS - elapsedMs));
    return () => {
      window.clearInterval(retryInterval);
      window.clearTimeout(timeout);
    };
  }, [initialized, restoreState, hasStoredSession, loadUser, logout]);

  useEffect(() => {
    const handleRecoverySignal = () => {
      if (
        shouldRecoverAuthOnBrowserSignal({
          visible: document.visibilityState === "visible",
          online: navigator.onLine,
          initialized,
          restoreState,
          hasStoredSession,
        })
      ) {
        loadUser();
      }
    };

    window.addEventListener("online", handleRecoverySignal);
    document.addEventListener("visibilitychange", handleRecoverySignal);
    return () => {
      window.removeEventListener("online", handleRecoverySignal);
      document.removeEventListener("visibilitychange", handleRecoverySignal);
    };
  }, [initialized, restoreState, hasStoredSession, loadUser]);

  const profileSetupRequired = requiresAccountProfileSetup(user);
  // Any `/s/<slug>/...` link can open the public read-only page for a
  // nonmember; a `/channel/<id>` deep link preselects that public channel.
  const publicServerRoute = location.pathname.match(/^\/s\/([^/]+)(?:\/channel\/([^/]+))?(?:\/.*)?$/);
  let publicServerSlug: string | null = null;
  let publicChannelId: string | null = null;
  if (publicServerRoute) {
    try {
      publicServerSlug = decodeURIComponent(publicServerRoute[1]!);
      publicChannelId = publicServerRoute[2] ? decodeURIComponent(publicServerRoute[2]) : null;
    } catch {
      publicServerSlug = null;
      publicChannelId = null;
    }
  }

  // Signed out, the canonical Artifact link tries the public page first
  // (public Artifacts v1); signed in it is ArtifactPermalinkRoute's (the Artifact's own page).
  const publicArtifactRoute = location.pathname.match(/^\/artifacts\/([^/]+)(?:\/v\/([^/]+))?\/?$/);
  // The external channel invite and approval links (#wg-rbac:#16): signed out, Sign In at the
  // link's address says why, and the page opens once signed in (and verified).
  const { purpose: externalLinkPurpose, inviteToken: externalInviteToken } = externalLinkSignIn(location.pathname);
  let publicArtifactId: string | null = null;
  let publicArtifactVersion: string | undefined;
  if (publicArtifactRoute) {
    try {
      publicArtifactId = decodeURIComponent(publicArtifactRoute[1]!);
      publicArtifactVersion = publicArtifactRoute[2] ? decodeURIComponent(publicArtifactRoute[2]) : undefined;
    } catch {
      publicArtifactId = null;
    }
  }
  const showPublicArtifact = publicArtifactId !== null && publicArtifactDismissedFor !== publicArtifactId;

  // Signing in from a public server temporarily dismisses the public page so
  // the login form can render at the same URL. Once identity arrives, restore
  // that page for a nonmember instead of treating the session as membership.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    if (authenticatedUserId && publicServerSlug) setPublicViewDismissed(false);
  }, [authenticatedUserId, publicServerSlug]);

  // App handoff and OAuth completion need account identity, not the workspace.
  // The callback navigates to its return URL once authentication completes.
  const deferServerBootstrap = appLoginHandoff || urlParamsRef.authCallback === "social" || urlParamsRef.authCallback === "sso";

  // Identity setup is account-global and must complete before any server data
  // or pending invite side effects are loaded.
  useEffect(() => {
    if (user && !profileSetupRequired && !deferServerBootstrap) {
      loadServers();
    }
  }, [user, profileSetupRequired, deferServerBootstrap, loadServers]);

  // Single boot entry for the cross-server unread summary. Components keep
  // only their event/interval triggers (LeftRail: prefs + local-unread edge;
  // Sidebar: interval/focus/visibility/prefs/eager edge) — previously each
  // mount issued its own boot fetch (the unread-summary boot wave).
  const serversCount = useServerStore((s) => s.servers.length);
  const loadServerUnreadSummary = useServerStore((s) => s.loadServerUnreadSummary);
  useEffect(() => {
    if (!user || serversCount === 0 || deferServerBootstrap) return;
    void loadServerUnreadSummary();
  }, [user, serversCount, deferServerBootstrap, loadServerUnreadSummary]);

  // Task #164: while the unread or Activity reads are stale or unavailable,
  // read them again with backoff until a clean answer (store/rwStaleCounts).
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    return startRwRecovery();
  }, [signedIn]);

  // Open tabs pick up server feature-flag changes: the page coming back
  // re-reads flags evaluated more than 5 minutes ago (store/serverFeatureFlags).
  useEffect(() => {
    if (!signedIn) return;
    return startServerFeatureFlagRefreshOnFocus();
  }, [signedIn]);

  // Precise PWA resume: restore the last deep location on cold start from `/`.
  // Only active once the user is authenticated and there's no pending invite,
  // so it doesn't fight with login / email-verification / invite redirects.
  const hasPendingInvite = !!localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
  const canResumeLocation = !!user
    && !deferServerBootstrap
    && user.emailVerified
    && !profileSetupRequired
    && !urlParams.inviteToken
    && !urlParams.resetToken
    && !hasPendingInvite
    && !serverLoading
    && !isServerSelectionRequested();
  const isJoinedServerSlug = useCallback((slug: string) => servers.some((server) => server.slug === slug), [servers]);
  useLastLocationResume(canResumeLocation, isJoinedServerSlug);

  // Resume pending invite from localStorage (set during invite flow → login/register)
  // through the invite page, so login completion never mutates membership by
  // itself.
  useEffect(() => {
    if (!user || !user.emailVerified || profileSetupRequired) return;
    // While a reset link is active, do NOT consume the pending invite or navigate
    // to /?invite=… — that would clobber the ?reset token (breaking refresh) and
    // burn the invite record. Leave it in storage untouched: when the reset is
    // done, onBack reloads the app, and that fresh mount (URL no longer carrying
    // ?reset) runs this effect and resumes the still-stored invite. Read resetToken
    // off urlParamsRef (the mount-frozen useMemo([]) source), not urlParams: the
    // resolved resetToken string is constant either way (so behavior is identical),
    // but urlParams derives from inviteToken — which this effect sets — so
    // oxlint react-doctor/no-chain-state-updates statically rejects listing
    // urlParams.resetToken as a dep. Depending on the mount-frozen ref avoids that
    // while keeping exhaustive-deps satisfied.
    if (urlParamsRef.resetToken || urlParamsRef.appLoginHandoff || urlParamsRef.deviceLoginRevokeToken || urlParamsRef.secondFactorRecoveryLink || urlParamsRef.accountDeletionCancelLink) return;
    const pendingInviteRedirect = takePendingInviteRedirectPath();
    if (!pendingInviteRedirect) return;

    const pendingInvite = new URLSearchParams(pendingInviteRedirect.split("?")[1] ?? "").get("invite");
    if (!pendingInvite) return;

    setInviteToken(pendingInvite);
    navigate(pendingInviteRedirect, { replace: true });
  }, [user, profileSetupRequired, urlParamsRef, navigate]);

  // Verified from a link naming a page (#88: the Artifact link signed up from): go there now, in place. A new
  // account's setup then shows at that address and the page opens once it is done (InNOut QA r97: landing on
  // "/" instead, setup led on to creating a server and the Artifact was lost).
  const landAfterVerify = useCallback((landing: string) => {
    const path = landingAfterVerify(landing);
    if (path) navigate(path, { replace: true });
  }, [navigate]);
  const showLogin = useCallback(() => setAuthView("login"), []);
  const showRegister = useCallback(() => setAuthView("register"), []);
  const showForgotPassword = useCallback(() => setAuthView("forgot-password"), []);
  const clearInviteToken = useCallback(() => setInviteToken(null), []);
  const inviteSwitchToLogin = useCallback(() => {
    setInviteToken(null);
    setAuthView("login");
  }, []);
  const inviteSwitchToRegister = useCallback(() => {
    setInviteToken(null);
    setAuthView("register");
  }, []);
  const dismissPublicView = useCallback(() => setPublicViewDismissed(true), []);
  const publicSignIn = useCallback(() => {
    setPublicViewDismissed(true);
    setAuthView("login");
  }, []);
  const publicRegister = useCallback(() => {
    setPublicViewDismissed(true);
    setAuthView("register");
  }, []);
  // Signed out, the invite link's landing page (#wg-rbac:#39) until Sign In or Create Account there, at the same address.
  const leaveExternalInviteLanding = useCallback((view: "login" | "register") => {
    setExternalInviteLandingDismissed(true);
    setAuthView(view);
  }, []);

  const dismissPublicArtifact = useCallback(() => setPublicArtifactDismissedFor(publicArtifactId), [publicArtifactId]);
  const publicArtifactSignIn = useCallback(() => {
    setPublicArtifactDismissedFor(publicArtifactId);
    setAuthView("login");
  }, [publicArtifactId]);
  const publicArtifactReader = useMemo(() => ({ kind: "visitor" as const, onSignIn: publicArtifactSignIn }), [publicArtifactSignIn]);

  const hasUser = !!user;
  // Signed out: the sign-in page's next steps load in idle time (pages/landingPages.ts).
  useEffect(() => { if (authBootstrapView === "signed_out" && !hasUser) preloadSignedOutSteps(); }, [authBootstrapView, hasUser]);
  const leaveResetPassword = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("reset");
    // Keep url.search: drop ONLY reset, preserve any invite/verify/other
    // params so the post-reset reload can still resume those flows.
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    // Logged-out → return to sign-in; logged-in → reload keeps the current
    // session and lands back in the app (never an implicit logout/switch).
    if (!hasUser) setAuthView("login");
    window.location.reload();
  }, [hasUser]);

  // Determine page content
  let content: React.ReactNode;

  if (urlParams.authCallback === "social" || urlParams.authCallback === "sso") {
    content = urlParams.authCallback === "sso" ? <Landing><SsoAuthCallbackPage /></Landing> : <Landing><SocialAuthCallbackPage /></Landing>;
  } else if (authBootstrapView === "restoring" && offlineUser) {
    // Offline with the last session on the device: its workspace, marked
    // Offline, instead of "Restoring session…" for as long as the network is gone.
    content = <OfflineServerLayout user={offlineUser} />;
  } else if (authBootstrapView === "loading" && opensServerFrame(location.pathname)) {
    // Signing in again from a stored session on a server page: the frame now,
    // each region loading in place, instead of a full-screen wait.
    content = <PendingServerLayout />;
  } else if ((authBootstrapView === "loading" || authBootstrapView === "restoring") && publicArtifactRoute) {
    // A canonical Artifact link says what it is loading from the first frame (the boot shell's) to its answer.
    content = <ArtifactLinkLoading />;
  } else if (authBootstrapView === "loading" || authBootstrapView === "restoring") {
    content = <AuthBootstrapStatus view={authBootstrapView} />;
  } else if (urlParams.resetToken) {
    // A reset link must work even when a session is already active (e.g. an
    // OAuth-created account setting its first password is, by definition, logged
    // in). The page only calls resetPassword(token, …), which resets the TOKEN's
    // owner server-side and never touches the current session — so a logged-in A
    // opening B's link resets B without mutating A. Checked before every other
    // branch so a reset token wins if it coexists with invite/verify params.
    content = (
      <Landing>
        <ResetPasswordPage
          token={urlParams.resetToken}
          onBack={leaveResetPassword}
        />
      </Landing>
    );
  } else if (urlParams.deviceLoginRevokeToken) {
    // Like a reset link: the token alone decides, whoever is signed in here.
    content = <Landing><DeviceLoginRevokePage token={urlParams.deviceLoginRevokeToken} /></Landing>;
  } else if (urlParams.secondFactorRecoveryLink) {
    // Like a revoke link: the token alone decides, whoever is signed in here.
    content = <Landing><SecondFactorRecoveryLinkPage mode={urlParams.secondFactorRecoveryLink.mode} token={urlParams.secondFactorRecoveryLink.token} /></Landing>;
  } else if (urlParams.accountDeletionCancelLink) { // Like a revoke link: the token alone decides.
    content = <Landing><AccountDeletionCancelLinkPage token={urlParams.accountDeletionCancelLink.token} /></Landing>;
  } else if (!user) {
    if (secondFactorPending) {
      // A password or Raft Desktop sign-in waits on its second step, wherever
      // it started (sign-in, sign-up's provider buttons, an invite).
      content = <PendingSecondFactorSignInStep />;
    } else if (urlParams.inviteToken) {
      content = (
        <Landing>
          <InviteAcceptPage
            token={urlParams.inviteToken}
            onInviteConsumed={clearInviteToken}
            onSwitchToLogin={inviteSwitchToLogin}
            onSwitchToRegister={inviteSwitchToRegister}
          />
        </Landing>
      );
    } else if (publicServerSlug && !publicViewDismissed) {
      content = (
        <PublicServerPage
          slug={publicServerSlug}
          initialChannelId={publicChannelId}
          onSignIn={publicSignIn}
          onRegister={publicRegister}
          onUnavailable={dismissPublicView}
        />
      );
    } else if (showPublicArtifact) {
      content = (
        <Suspense fallback={<ArtifactLinkLoading />}>
          <PublicArtifactPage
            id={publicArtifactId ?? undefined}
            version={publicArtifactVersion}
            reader={publicArtifactReader}
            onUnavailable={dismissPublicArtifact}
          />
        </Suspense>
      );
    } else if (externalInviteToken && !externalInviteLandingDismissed) {
      content = <Landing><ExternalInviteLandingPage token={externalInviteToken} onChoose={leaveExternalInviteLanding} /></Landing>;
    } else if (authView === "register") {
      content = <Landing><RegisterPage onSwitchToLogin={showLogin} /></Landing>;
    } else if (authView === "forgot-password") {
      content = <Landing><ForgotPasswordPage onBack={showLogin} /></Landing>;
    } else {
      content = (
        <SignInPage
          onSwitchToRegister={showRegister}
          onForgotPassword={showForgotPassword}
          // On a canonical Artifact link, why sign-in: back after #250 because it tells people what's happening
          // (xxchan, Kirby). The same line whatever the link (private, deleted, never was, not an Artifact's
          // address), so it can't tell a visitor whether the Artifact exists.
          purpose={publicArtifactRoute
            ? formatMessage({ id: "artifacts.permalink.signInPrompt" })
            : externalLinkPurpose ? formatMessage({ id: externalLinkPurpose }) : undefined}
        />
      );
    }
  } else if (urlParams.inviteToken && user.emailVerified && !profileSetupRequired) {
    // Joining needs a verified email and a finished profile (accept-invite
    // answers PROFILE_SETUP_REQUIRED otherwise): such an account does that first,
    // below, and the invite (still in state) opens once it has.
    content = (
      <Landing>
        <InviteAcceptPage
          token={urlParams.inviteToken}
          onInviteConsumed={clearInviteToken}
          onSwitchToLogin={ignoreAuthEntry}
          onSwitchToRegister={ignoreAuthEntry}
        />
      </Landing>
    );
  } else if (!user.emailVerified) {
    content = <Landing><EmailVerificationPage initialToken={urlParams.verifyToken} initialReturnTo={urlParams.verifyReturnTo} onVerified={landAfterVerify} /></Landing>;
  } else if (profileSetupRequired) {
    content = <Landing><AccountIdentitySetupPage /></Landing>;
  } else if (appLoginHandoff) {
    content = <Landing><AppLoginPage /></Landing>;
  } else if (serverLoading && !publicArtifactRoute) {
    // A canonical Artifact link doesn't wait here: its page asks `open` at once and waits for the list only to enter the server it names.
    content = opensServerFrame(location.pathname) ? (
      <PendingServerLayout />
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar font-display safe-top">
        <div className="text-headline text-foreground-muted">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  } else if (publicServerSlug && !publicViewDismissed && !servers.some((server) => server.slug === publicServerSlug)) {
    content = (
      <PublicServerPage
        slug={publicServerSlug}
        initialChannelId={publicChannelId}
        authenticated
        onSignIn={ignoreAuthEntry}
        onRegister={ignoreAuthEntry}
        onUnavailable={dismissPublicView}
      />
    );
  } else {
    // Authenticated + servers loaded → URL-based server routing
    content = (
      <Routes>
        <Route path="/login-with-raft/setup" element={<Landing><HumanLoginSetupPage /></Landing>} />
        <Route path="/login-with-slock/setup" element={<Landing><HumanLoginSetupPage /></Landing>} />
        <Route path="/login-with-slock-human/setup" element={<Landing><HumanLoginSetupPage /></Landing>} />
        <Route path="/login/device" element={<Landing><DeviceLoginPage /></Landing>} />
        <Route path={INTEGRATION_INVITE_ROUTE} element={<Landing><IntegrationInvitePage /></Landing>} />
        <Route path={EXTERNAL_INVITE_ROUTE} element={<Landing><ExternalInvitePage /></Landing>} />
        <Route path={SERVER_CONNECT_REQUEST_ROUTE} element={<Landing><ServerConnectRequestPage /></Landing>} />
        <Route path="/connections/callback" element={<Landing><AgentConnectionCallbackPage /></Landing>} />
        <Route path="/appsumo/redeem/create-server" element={<Landing><AppSumoServerCreationPage /></Landing>} />
        <Route path="/appsumo/redeem" element={<Landing><AppSumoRedemptionPage /></Landing>} />
        <Route path="/servers" element={<ServerSelectionPage />} />
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
        <Route path="/artifacts/:artifactId" element={<ArtifactPermalinkRoute />} />
        <Route path="/artifacts/:artifactId/v/:version" element={<ArtifactPermalinkRoute />} />
        <Route path="*" element={<ServerRedirect />} />
      </Routes>
    );
  }

  return (
    <>
      <NavigationDepthTracker />
      {/* Raft Desktop only: notifications. */}
      <DesktopNativeNotifications />
      {/* Signed in: presence report, read retraction, badge (web and desktop). */}
      {user ? <NotificationRuntime key={user.id} /> : null}
      <EnvironmentDevOverlay />
      <InAppBrowserGuide />
      {content}
      <MessageSelectionShortcut />
      <ImageLightboxHost />
      <DocumentPreviewHost />
      <MediaPreviewHost />
      {/* "Verify it's you" before a sensitive action (secondFactorStepUp.ts). */}
      <SecondFactorStepUpHost />
    </>
  );
}

// A dev-only page: kept out of the startup bundle.
const PaletteAuditPage = lazyPanel(() => import("./pages/PaletteAuditPage"));

export function PaletteAuditRoute({ isDev = import.meta.env.DEV }: { isDev?: boolean }) {
  return isDev ? <Suspense fallback={null}><PaletteAuditPage /></Suspense> : <Navigate to="/" replace />;
}

function App() {
  return (
    <>
      {/* The host's native commands, the server list it names, and the
          history tracker the top bar's ‹ › read: once, for the app's life. */}
      <HostIntegration />
      <Routes>
        <Route
          path="/palette-audit"
          element={<PaletteAuditRoute />}
        />
        <Route
          path="/dev/account-bootstrap"
          element={import.meta.env.DEV ? <Landing><AccountBootstrapPreviewPage /></Landing> : <Navigate to="/" replace />}
        />
        <Route
          path="/dev/server-setup"
          element={import.meta.env.DEV ? <Suspense fallback={null}><ServerSetupComputerRuntimePreviewPage /></Suspense> : <Navigate to="/" replace />}
        />
        <Route
          path="/dev/display-style"
          element={import.meta.env.DEV ? <Suspense fallback={null}><DisplayStylePreviewPage /></Suspense> : <Navigate to="/" replace />}
        />
        {/* Public utility routes must render outside the authenticated shell.
            Place them before the catch-all, which would otherwise swallow them
            into AppShell. */}
        <Route path="/download" element={<Landing><MobileDownloadChooserPage /></Landing>} />
        <Route path={CHINESE_COMMUNITY_PAGE_PATH} element={<Landing><ChineseCommunityPage /></Landing>} />
        {/* A scheduled account deletion refuses every API: its page stands in for
            the whole shell, so nothing in the shell keeps asking. */}
        <Route path="/*" element={<AccountDeletionGate><AppShell /></AccountDeletionGate>} />
      </Routes>
    </>
  );
}

export default App;
