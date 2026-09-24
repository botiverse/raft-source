import { useEffect, useRef, useState, useMemo } from "react";
import { Routes, Route, Navigate, useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useIntl } from "react-intl";
import { useLocale } from "./i18n/LocaleProvider";
import { shouldReconcileAccountLocale } from "./i18n/locale";
import { useServerStore } from "./store/serverStore";
import type { CommunityServerSlug } from "./store/serverStore";
import { useAgentStore } from "./store/agentStore";
import { useMachineStore } from "./store/machineStore";
import { serverPersistence } from "./store/serverPersistenceRegistry";
import MobileDownloadChooserPage from "./pages/MobileDownloadChooserPage";
import ChineseCommunityPage from "./pages/ChineseCommunityPage";
import DeviceLoginPage from "./pages/DeviceLoginPage";
import HumanLoginSetupPage from "./pages/HumanLoginSetupPage";
import IntegrationInvitePage from "./pages/IntegrationInvitePage";
import PublicServerPage from "./pages/PublicServerPage";
import { useChannelStore } from "./store/channelStore";
import api from "./api/client";
import PaletteAuditPage from "./pages/PaletteAuditPage";
import AccountBootstrapPreviewPage from "./pages/AccountBootstrapPreviewPage";
import ServerSetupComputerRuntimePreviewPage from "./pages/ServerSetupComputerRuntimePreviewPage";
import ServerSetupProjectionGate from "./components/onboarding/ServerSetupProjectionGate";
import LoginPage from "./components/auth/LoginPage";
import RegisterPage from "./components/auth/RegisterPage";
import AccountIdentitySetupPage from "./components/auth/AccountIdentitySetupPage";
import ForgotPasswordPage from "./components/auth/ForgotPasswordPage";
import ResetPasswordPage from "./components/auth/ResetPasswordPage";
import EmailVerificationPage from "./components/auth/EmailVerificationPage";
import InviteAcceptPage from "./components/auth/InviteAcceptPage";
import SocialAuthCallbackPage from "./components/auth/SocialAuthCallbackPage";
import ServerSelector from "./components/auth/ServerSelector";
import SignedInAs from "./components/auth/SignedInAs";
import ImageLightbox from "./components/ImageLightbox";
import DocumentPreviewHost from "./components/message/DocumentPreviewHost";
import MediaPreviewHost from "./components/message/MediaPreviewHost";
import MainLayout from "./components/layout/MainLayout";
import ThreadWindowRoute from "./components/window/ThreadWindowRoute";
import MessageSelectionShortcut from "./components/message/MessageSelectionShortcut";
import {
  MAX_AUTH_RESTORE_MS,
  getAuthBootstrapView,
  shouldRetryAuthRestore,
} from "./utils/authRestoreMachine";
import { getRestoreTimeoutAction } from "./utils/restoreTimeoutPolicy";
import { shouldRecoverAuthOnBrowserSignal } from "./utils/browserRecoveryPolicy";
import { PENDING_INVITE_STORAGE_KEY, takePendingInviteRedirectPath } from "./utils/socialAuth";
import { requiresAccountProfileSetup } from "./utils/accountProfileSetup";
import { useLastLocationResume } from "./hooks/useLastLocationResume";
import { readServerSurfaceMemory } from "./hooks/useTabRouteMemory";
import { getDesktopServerBootstrapTarget } from "./utils/serverSwitcherNavigation";
import {
  consumeServerSelectionRequest,
  isServerSelectionRequested,
  requestServerSelection,
} from "./utils/serverSelectionRequest";
import {
  isChangePasswordIntentPath,
  serverEntryPath,
} from "./utils/changePasswordNavigation";
import { NavigationDepthTracker, useAppNavigate } from "./hooks/useAppNavigate";
import { useJoinCommunityFlow } from "./hooks/useJoinCommunityFlow";
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
  isSlockdevEnvironment,
  shouldAutoLoginSlockdev,
} from "./utils/devMode";
import type {
  AuthView,
} from "./utils/devMode";
import { emitAuthTraceAndFlush } from "./utils/webAuthTrace";
import { getFlagOverride, setFlagOverride } from "./analytics/posthog";
import { FEATURE_FLAG_REGISTRY } from "./analytics/flagRegistry";
import DraggableDevOverlay from "./components/dev/DraggableDevOverlay";
import { HIDE_LOCAL_DEV_TOOLS_EVENT } from "./components/dev/devOverlayEvents";
import { Button } from "raft-ui";
import { Settings2, X } from "lucide-react";
import { isHostShell } from "./embed";
import { readNativeOnboardingGeneration } from "./embed/nativeOnboarding";
import {
  genericAppDocumentTitle,
  getServerRouteDocumentTitle,
  hostShellFallbackDocumentTitle,
  serverRouteAgentId,
  serverRouteMachineId,
  useBrowserDocumentTitle,
} from "./utils/browserDocumentTitle";

/** Parse URL search params once */
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const joinMatch = window.location.pathname.match(/^\/join\/([^/?#]+)/);
  return {
    authCallback: params.get("auth_callback"),
    verifyToken: params.get("verify"),
    resetToken: params.get("reset"),
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

function EnvironmentDevOverlay() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const { formatMessage } = useIntl();
  if (!environmentLabelMessageId) return null;
  if (isSlockdev && import.meta.env?.VITE_SLOCKDEV_HIDE_PANEL === "1") return null;
  if (hidden) return null;
  const environmentLabel = formatMessage({ id: environmentLabelMessageId });
  const previewEnvironmentDetails = getPreviewEnvironmentDetails(
    {
      branch: import.meta.env?.VITE_PREVIEW_BRANCH,
      commitSha: import.meta.env?.VITE_COMMIT_SHA,
      apiTarget: import.meta.env?.VITE_PREVIEW_API_TARGET,
    },
    formatMessage,
  );
  const badgeLabel = `${environmentLabel}${previewEnvironmentDetails ? ` · ${previewEnvironmentDetails}` : ""}`;
  const className = isSlockdev
    ? "bg-soft-signal"
    : "bg-brutal-orange";
  const triggerTitle = formatMessage(
    { id: isSlockdev ? "devTools.overlay.triggerTitle" : "env.badge.dragTitle" },
    { label: badgeLabel },
  );
  const hideAllDevTools = () => {
    document.documentElement.dataset.raftDevToolsHidden = "true";
    window.dispatchEvent(new Event(HIDE_LOCAL_DEV_TOOLS_EVENT));
    setOpen(false);
    setHidden(true);
  };

  return (
    <DraggableDevOverlay
      id="environment-dev-tools"
      handleSelector="[data-dev-overlay-handle]"
      panel={isSlockdev && open ? (
        <SlockdevDebugPanel
          onClose={() => setOpen(false)}
          onHideAll={hideAllDevTools}
        />
      ) : null}
      open={open}
      onOpenChange={setOpen}
      collapsible
      collapsedChildren={(
        <span
          aria-hidden="true"
          data-dev-overlay-handle
          className="flex size-6 touch-none select-none items-center justify-center border border-black bg-soft-signal text-sm leading-none shadow-brutal-sm cursor-grab active:cursor-grabbing"
        >
          <Settings2 size={12} strokeWidth={2.5} />
        </span>
      )}
      className="fixed z-40 max-w-[calc(100vw-1rem)] font-display"
      title={triggerTitle}
      testId="raftdev-debug-overlay"
    >
      {isSlockdev ? (
        <button
          type="button"
          data-dev-overlay-handle
          onClick={() => setOpen((value) => !value)}
          className={`max-w-full touch-none select-none truncate border-2 border-black px-2 py-1 text-[10px] font-bold tracking-widest shadow-brutal-sm cursor-grab active:cursor-grabbing ${className}`}
          data-testid="raftdev-debug-trigger"
        >
          <span data-testid="environment-badge">{badgeLabel}</span>
        </button>
      ) : (
        <div
          data-dev-overlay-handle
          className={`max-w-full touch-none select-none truncate border-2 border-black px-2 py-0.5 text-[10px] font-bold uppercase shadow-brutal-sm opacity-80 cursor-grab active:cursor-grabbing ${className}`}
          data-testid="environment-badge"
        >
          {badgeLabel}
        </div>
      )}
    </DraggableDevOverlay>
  );
}

interface SlockdevDebugPanelProps {
  onClose: () => void;
  onHideAll: () => void;
}

function SlockdevDebugPanel(props: SlockdevDebugPanelProps) {
  const { onClose, onHideAll } = props;
  const [copied, setCopied] = useState(false);
  const { formatMessage } = useIntl();
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const envName = import.meta.env?.VITE_SLOCKDEV_ENV_NAME || "";
  const previewDescription = import.meta.env?.VITE_SLOCKDEV_PREVIEW_DESCRIPTION?.trim() || "";
  const seedCommand = getSlockdevSeedCommand(envName);
  if (!isSlockdev) return null;
  if (import.meta.env?.VITE_SLOCKDEV_HIDE_PANEL === "1") return null;

  const clearLocalState = () => {
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "clearLocalState",
      logoutTrigger: "dev_clear_local_state",
    });
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    serverPersistence.clearLastServerSlug();
    localStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
    window.location.assign("/");
  };

  const copySeedCommand = async () => {
    try {
      await navigator.clipboard.writeText(seedCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.warn("Failed to copy raftdev seed command", err);
    }
  };

  return (
        <div className="w-72 max-w-[calc(100vw-1rem)] overflow-y-auto border-2 border-black bg-white p-3 text-xs shadow-brutal">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-bold uppercase tracking-widest text-black">
                {formatMessage({ id: "devTools.overlay.panelTitle" })}
              </div>
              <div className="mt-0.5 text-black/50">
                <div className="truncate">{envName || "slockdev"}</div>
                <div className="truncate">
                  {user ? <SignedInAs user={user} nameClassName="font-normal" /> : "Not signed in"}
                </div>
              </div>
            </div>
            <Button
              type="button"
              onClick={onClose}
              size="icon-xs"
              variant="ghost"
              aria-label={formatMessage({ id: "common.close" })}
              data-testid="raftdev-debug-close"
              className="size-6 shrink-0 self-start"
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>

          {previewDescription ? (
            <details className="mb-2 border border-black/20 bg-soft-signal/20 p-2" title={previewDescription}>
              <summary className="cursor-pointer select-none text-[10px] font-bold uppercase tracking-widest text-black/60">
                Preview description
              </summary>
              <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-black/70">
                {previewDescription}
              </p>
            </details>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => login(SLOCKDEV_EMAIL, SLOCKDEV_PASSWORD).catch((err) => {
                console.error("Dev login failed", err);
              })}
              className="border-2 border-black bg-brutal-pink px-2 py-1 font-bold disabled:opacity-50"
            >
              Dev login
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="border-2 border-black bg-white px-2 py-1 font-bold"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                requestServerSelection();
                serverPersistence.clearLastServerSlug();
                window.location.assign("/");
              }}
              className="border-2 border-black bg-white px-2 py-1 font-bold"
            >
              Server Picker
            </button>
            <button
              type="button"
              onClick={() => logout()}
              className="border-2 border-black bg-white px-2 py-1 font-bold"
            >
              Log out
            </button>
            <button
              type="button"
              onClick={clearLocalState}
              className="col-span-2 border-2 border-black bg-brutal-orange/30 px-2 py-1 font-bold"
            >
              Clear Local Session
            </button>
            <button
              type="button"
              onClick={copySeedCommand}
              className="col-span-2 border-2 border-black bg-soft-signal px-2 py-1 text-left font-mono text-[11px] font-bold"
            >
              {copied ? "Copied" : seedCommand}
            </button>
            <button
              type="button"
              onClick={onHideAll}
              className="col-span-2 border border-black bg-white px-2 py-1 text-left text-[10px] font-bold tracking-widest text-black/60 hover:bg-black hover:text-white"
            >
              {formatMessage({ id: "devTools.overlay.hideUntilReload" })}
            </button>
          </div>

          {/* Feature flags — local per-browser override toggles (stdrc
              #proj-activity:171042a3 2026-06-25). "Auto" = use PostHog / default;
              picking a variant forces it locally (render-only, doesn't change
              real experiment exposure). Reload applies it to all flag readers. */}
          {FEATURE_FLAG_REGISTRY.length > 0 && (
            <div className="mt-3 border-t-2 border-black/10 pt-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-black/60">
                Feature flags
              </div>
              {FEATURE_FLAG_REGISTRY.map((flag) => {
                const current = getFlagOverride(flag.key);
                const apply = (value: string | null) => {
                  setFlagOverride(flag.key, value);
                  window.location.reload();
                };
                return (
                  <div key={flag.key} className="mb-1.5">
                    <div className="mb-0.5 text-[11px] font-bold text-black/80" title={flag.key}>
                      {flag.label}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() => apply(null)}
                        className={`border border-black px-1.5 py-0.5 text-[10px] font-bold ${current === null ? "bg-black text-white" : "bg-white"}`}
                      >
                        Auto
                      </button>
                      {flag.variants.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => apply(v)}
                          className={`border border-black px-1.5 py-0.5 text-[10px] font-bold ${current === v ? "bg-brutal-pink text-white" : "bg-white"}`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
  );
}

/** Resolves server from URL slug and renders MainLayout */
export function ServerAccessDeniedPage() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const current = useServerStore((s) => s.current);
  const navigate = useNavigate();
  const lastSlug = serverPersistence.readLastServerSlug();
  const fallbackServer =
    (current ? servers.find((server) => server.id === current.id) : null) ??
    (lastSlug ? servers.find((server) => server.slug === lastSlug) : null) ??
    servers[0] ??
    null;
  const fallbackPath = fallbackServer
    ? (readServerSurfaceMemory(fallbackServer.slug) ?? `/s/${fallbackServer.slug}`)
    : "/";

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      navigate(fallbackPath, { replace: true });
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [fallbackPath, navigate]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream px-4 font-display safe-top safe-bottom">
      <div className="w-full max-w-md border-2 border-black bg-white p-6 shadow-brutal">
        <h1 className="text-2xl font-black text-black">{formatMessage({ id: "pages.serverNotFound.title" })}</h1>
        <p className="mt-3 text-sm leading-6 text-black/70">
          {fallbackServer
            ? formatMessage(
                { id: "pages.serverNotFound.redirectingToServer" },
                { name: () => <strong key="server-name">{fallbackServer.name}</strong> },
              )
            : formatMessage({ id: "pages.serverNotFound.redirectingToList" })}
        </p>
        <div className="mt-5">
          <button
            type="button"
            onClick={() => navigate(fallbackPath, { replace: true })}
            className="text-sm font-bold text-black/50 underline hover:text-black"
          >
            {fallbackServer
              ? formatMessage({ id: "pages.serverNotFound.goToMyServer" })
              : formatMessage({ id: "pages.serverNotFound.chooseServer" })}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const routeAgent = useAgentStore((state) =>
    routeAgentId ? state.agents.find((agent) => agent.id === routeAgentId) : undefined
  );
  const routeMachine = useMachineStore((state) =>
    routeMachineId ? state.machines.find((machine) => machine.id === routeMachineId) : undefined
  );
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
              agentLabel: routeAgent?.displayName || routeAgent?.name,
              machineLabel: routeMachine?.name,
            },
            hostShell,
            titleFallbacks,
          )
        : hostShell
          ? hostShellFallbackDocumentTitle(titleFallbacks)
          : genericAppDocumentTitle(),
    [hostShell, location.pathname, routeAgent?.displayName, routeAgent?.name, routeMachine?.name, routeServerName, routeServerSlug, titleFallbacks],
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
    }
  }, [serverSlug, server, loading, current?.id, setCurrent]);

  useBrowserDocumentTitle(routeDocumentTitle);

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
      });
  }, [appNav, current, jointInviteId, location.pathname, location.search, navigate, server]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  if (!server) {
    if (missingCommunitySlug && communityJoinFlow.joiningCommunitySlug === missingCommunitySlug) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
          <div className="text-xl font-bold">{formatMessage({ id: "pages.app.joiningCommunity" })}</div>
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
        <ServerSelector
          onSelect={(nextServer) => {
            setCurrent(nextServer);
            navigate(readServerSurfaceMemory(nextServer.slug) ?? `/s/${nextServer.slug}`, {
              replace: true,
            });
          }}
        />
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
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "common.loading" })}</div>
      </div>
    );
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
  if (location.pathname === `/s/${server.slug}/onboarding`) {
    const generation = readNativeOnboardingGeneration(location.search);
    // Only clients enter the standalone surface (artin, #proj-mobile d89d3318):
    // the client always opens this URL with its wake generation. A plain browser
    // without one gets the Modal flow on the main surface instead.
    if (!generation) return <Navigate to={`/s/${server.slug}`} replace />;
    return (
      <main
        className="relative flex min-h-0 flex-1 bg-brutal-cream font-display safe-top safe-bottom"
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

  if (location.pathname === `/s/${server.slug}/thread-window`) {
    // Remount on a new deep-link identity so an async failure from a previous
    // popup target cannot bleed into the next thread/task opened in this tab.
    return <ThreadWindowRoute key={location.search} />;
  }

  return <MainLayout key={server.id} />;
}

export function ServerSelectionPage() {
  const { formatMessage } = useIntl();
  const setCurrent = useServerStore((s) => s.setCurrent);
  const loading = useServerStore((s) => s.loading);
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  return (
    <ServerSelector
      onSelect={(server) => {
        setCurrent(server);
        navigate(readServerSurfaceMemory(server.slug) ?? `/s/${server.slug}`);
      }}
    />
  );
}

/** Auto-redirect to last server, or show ServerSelector */
export function ServerRedirect() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const loading = useServerStore((s) => s.loading);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();
  const [showServerSelector] = useState(() => consumeServerSelectionRequest());
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  // A deliberate Server Picker action must win over normal last-server and
  // deep-location restoration, including on a cold navigation to "/".
  if (showServerSelector) {
    return (
      <ServerSelector
        onSelect={(server) => {
          setCurrent(server);
          navigate(readServerSurfaceMemory(server.slug) ?? `/s/${server.slug}`, { replace: true });
        }}
      />
    );
  }

  const nativeTarget = getDesktopServerBootstrapTarget(location.search, servers);
  if (nativeTarget) {
    return <Navigate to={nativeTarget} replace />;
  }

  // `/.well-known/change-password` redirects here before auth is known. The
  // pathname survives the signed-out login screen, so once auth + the server
  // list are restored this same resolver can choose the browser's remembered
  // server without inventing an account-global settings surface.
  const changePasswordIntent = isChangePasswordIntentPath(location.pathname);

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
  return (
    <ServerSelector
      onSelect={(server) => {
        setCurrent(server);
        navigate(serverEntryPath({
          serverSlug: server.slug,
          rememberedSurface: readServerSurfaceMemory(server.slug),
          changePasswordIntent,
        }));
      }}
    />
  );
}

// Standalone palette audit page (#proj-uiux:0e6befb8 task #92).
// Bypasses auth + MainLayout so it can scroll freely (the normal
// shell pins #root with overflow:hidden which fights long pages).
// Routed at the App boundary so the auth/data hooks below run inside
// AppShell and are never conditionally skipped — earlier the early-return
// gated `window.location.pathname === "/palette-audit"` made every hook in
// AppShell rules-of-hooks-conditional under SPA nav.
/** Auth bootstrap loading / restoring chrome — exported for zh-cn i18n behavior tests. */
export function AuthBootstrapStatus({ view }: { view: "loading" | "restoring" }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
      <div className="text-xl font-bold">
        {view === "restoring"
          ? formatMessage({ id: "auth.bootstrap.restoringSession" })
          : formatMessage({ id: "common.loading" })}
      </div>
    </div>
  );
}

export function AppShell() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const initialized = useAuthStore((s) => s.initialized);
  const restoreState = useAuthStore((s) => s.restoreState);
  const login = useAuthStore((s) => s.login);
  const loadUser = useAuthStore((s) => s.loadUser);
  const logout = useAuthStore((s) => s.logout);

  const serverLoading = useServerStore((s) => s.loading);
  const loadServers = useServerStore((s) => s.loadServers);
  const navigate = useNavigate();
  const location = useLocation();

  const [authView, setAuthView] = useState<AuthView>("login");
  const [publicViewDismissed, setPublicViewDismissed] = useState(false);
  const [devAutoLoginAttempted, setDevAutoLoginAttempted] = useState(false);

  // Read URL params once on mount, but inviteToken is stateful so it can be cleared
  const urlParamsRef = useMemo(() => getUrlParams(), []);
  const [inviteToken, setInviteToken] = useState<string | null>(urlParamsRef.inviteToken);
  const urlParams = useMemo(() => ({ ...urlParamsRef, inviteToken }), [urlParamsRef, inviteToken]);

  // Load user on mount
  useEffect(() => {
    loadUser();
  }, [loadUser]);

  // Reconcile the UI display language to the signed-in user's server-persisted
  // preference once auth bootstrap settles (login / cold-load restore).
  // Missing/unsupported account values resolve English-first; explicit en or
  // zh-cn values win exactly. Waiting for an initialized, authenticated user
  // avoids overwriting a valid cached explicit choice while the account record
  // is in flight or after logout (signed-out state is not an account value).
  // Lives here (not in LocaleProvider) to keep the auth store out of the i18n
  // module graph.
  const { setLocaleFromUser } = useLocale();
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
  const publicServerRoute = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  let publicServerSlug: string | null = null;
  if (publicServerRoute) {
    try {
      publicServerSlug = decodeURIComponent(publicServerRoute[1]!);
    } catch {
      publicServerSlug = null;
    }
  }

  // Identity setup is account-global and must complete before any server data
  // or pending invite side effects are loaded.
  useEffect(() => {
    if (user && !profileSetupRequired) {
      loadServers();
    }
  }, [user, profileSetupRequired, loadServers]);

  // Precise PWA resume: restore the last deep location on cold start from `/`.
  // Only active once the user is authenticated and there's no pending invite,
  // so it doesn't fight with login / email-verification / invite redirects.
  const hasPendingInvite = !!localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
  const canResumeLocation = !!user
    && user.emailVerified
    && !profileSetupRequired
    && !urlParams.inviteToken
    && !hasPendingInvite
    && !serverLoading
    && !isServerSelectionRequested();
  useLastLocationResume(canResumeLocation);

  // Resume pending invite from localStorage (set during invite flow → login/register)
  // through the invite page, so login completion never mutates membership by
  // itself.
  useEffect(() => {
    if (!user || !user.emailVerified || profileSetupRequired) return;
    const pendingInviteRedirect = takePendingInviteRedirectPath();
    if (!pendingInviteRedirect) return;

    const pendingInvite = new URLSearchParams(pendingInviteRedirect.split("?")[1] ?? "").get("invite");
    if (!pendingInvite) return;

    setInviteToken(pendingInvite);
    navigate(pendingInviteRedirect, { replace: true });
  }, [user, profileSetupRequired, navigate]);

  // Determine page content
  let content: React.ReactNode;

  if (urlParams.authCallback === "social") {
    content = <SocialAuthCallbackPage />;
  } else if (authBootstrapView === "loading" || authBootstrapView === "restoring") {
    content = <AuthBootstrapStatus view={authBootstrapView} />;
  } else if (urlParams.resetToken && !user) {
    content = (
      <ResetPasswordPage
        token={urlParams.resetToken}
        onBack={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete("reset");
          window.history.replaceState({}, "", url.pathname + url.hash);
          setAuthView("login");
          window.location.reload();
        }}
      />
    );
  } else if (!user) {
    if (urlParams.inviteToken) {
      content = (
        <InviteAcceptPage
          token={urlParams.inviteToken}
          onInviteConsumed={() => setInviteToken(null)}
          onSwitchToLogin={() => {
            setInviteToken(null);
            setAuthView("login");
          }}
          onSwitchToRegister={() => {
            setInviteToken(null);
            setAuthView("register");
          }}
        />
      );
    } else if (publicServerSlug && !publicViewDismissed) {
      content = (
        <PublicServerPage
          slug={publicServerSlug}
          onSignIn={() => {
            setPublicViewDismissed(true);
            setAuthView("login");
          }}
          onRegister={() => {
            setPublicViewDismissed(true);
            setAuthView("register");
          }}
          onUnavailable={() => setPublicViewDismissed(true)}
        />
      );
    } else if (authView === "register") {
      content = <RegisterPage onSwitchToLogin={() => setAuthView("login")} />;
    } else if (authView === "forgot-password") {
      content = <ForgotPasswordPage onBack={() => setAuthView("login")} />;
    } else {
      content = (
        <LoginPage
          onSwitchToRegister={() => setAuthView("register")}
          onForgotPassword={() => setAuthView("forgot-password")}
        />
      );
    }
  } else if (urlParams.inviteToken) {
    content = (
      <InviteAcceptPage
        token={urlParams.inviteToken}
        onInviteConsumed={() => setInviteToken(null)}
        onSwitchToLogin={() => {}}
        onSwitchToRegister={() => {}}
      />
    );
  } else if (!user.emailVerified) {
    content = <EmailVerificationPage initialToken={urlParams.verifyToken} />;
  } else if (profileSetupRequired) {
    content = <AccountIdentitySetupPage />;
  } else if (serverLoading) {
    content = (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  } else {
    // Authenticated + servers loaded → URL-based server routing
    content = (
      <Routes>
        <Route path="/login-with-raft/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login-with-slock/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login-with-slock-human/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login/device" element={<DeviceLoginPage />} />
        <Route path="/integration-invites/:token" element={<IntegrationInvitePage />} />
        <Route path="/servers" element={<ServerSelectionPage />} />
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
        <Route path="*" element={<ServerRedirect />} />
      </Routes>
    );
  }

  return (
    <>
      <NavigationDepthTracker />
      <EnvironmentDevOverlay />
      {content}
      <MessageSelectionShortcut />
      <ImageLightbox />
      <DocumentPreviewHost />
      <MediaPreviewHost />
    </>
  );
}

export function PaletteAuditRoute({ isDev = import.meta.env.DEV }: { isDev?: boolean }) {
  return isDev ? <PaletteAuditPage /> : <Navigate to="/" replace />;
}

function App() {
  return (
    <Routes>
      <Route
        path="/palette-audit"
        element={<PaletteAuditRoute />}
      />
      <Route
        path="/dev/account-bootstrap"
        element={import.meta.env.DEV ? <AccountBootstrapPreviewPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/dev/server-setup"
        element={import.meta.env.DEV ? <ServerSetupComputerRuntimePreviewPage /> : <Navigate to="/" replace />}
      />
      {/* Public utility routes must render outside the authenticated shell.
          Place them before the catch-all, which would otherwise swallow them
          into AppShell. */}
      <Route path="/download" element={<MobileDownloadChooserPage />} />
      <Route path={CHINESE_COMMUNITY_PAGE_PATH} element={<ChineseCommunityPage />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

export default App;
