import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { currentTimeMs } from "@botiverse/raft-shared";
import { installGlobalClientErrorReporters, reportClientError } from "./utils/clientErrorTrace";
import { ThemeProvider, ToastProvider, TooltipProvider } from "raft-ui";
import { BrowserRouter } from "react-router-dom";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { IntlProviderWrapper } from "./i18n/IntlProviderWrapper";
import App from "./App";
import ServiceWorkerNavigationBridge from "./components/pwa/ServiceWorkerNavigationBridge";
import "./index.css";
import { isDynamicImportFailure } from "./utils/dynamicImportRecovery";
import {
  reportUpdateGateDecision,
  reportUpdateGateDecisionBeforeUnload,
} from "./utils/updateGateTrace";
import type {
  UpdateGateTriggerSource,
} from "./utils/updateGateTrace";
import { registerPushServiceWorker, supportsPushNotifications } from "./utils/pushNotifications";
import { initAnalytics, identifyUser, resetAnalytics } from "./analytics/posthog";
import { useAuthStore } from "./store/authStore";
import { installExternalTranslationGuard } from "./utils/externalTranslationGuard";
import RootErrorFallback from "./components/errors/RootErrorFallback";
import {
  AppRefreshRequiredScreen,
  AppRefreshWarningBanner,
} from "./components/errors/AppUpdateGate";
import "./buildIdentity";
import {
  bootstrapDesktopHandshake,
  renderDesktopHandshakeRecovery,
} from "./desktopHandshake";
import { installDesktopServerWindowBinding } from "./desktopServerWindow";
import { installDesktopServerTitleBinding } from "./desktopServerTitle";
import "./testHooks"; // attaches window.__SLOCK_E2E__ only when built with VITE_E2E=true
import { ForwardToastProvider } from "./components/message/ForwardToastProvider";
import { trackVisualViewport } from "./utils/visualViewport";

const desktopHandshake = bootstrapDesktopHandshake();
installDesktopServerWindowBinding(desktopHandshake);
installDesktopServerTitleBinding(desktopHandshake);
void desktopHandshake.catch((error) => {
  console.error("[Raft Desktop] handshake failed", error);
  renderDesktopHandshakeRecovery();
});

if (import.meta.env.DEV) {
  await import("./devtools/localReactDevTools").then(({ installLocalReactDevTools }) => installLocalReactDevTools());
}

if (supportsPushNotifications()) {
  void registerPushServiceWorker();
}

// Env-gated: no-op unless VITE_POSTHOG_KEY is configured (staging/prod). Off in
// dev / self-host / CI so nothing leaves the domain without an operator key.
initAnalytics();

// Tie analytics identity to the logged-in user across login / cold-load restore
// / logout — a single subscription instead of touching every auth mutation
// site. identify() also gives PostHog a stable distinct_id for deterministic
// feature-flag bucketing. All calls no-op when analytics is disabled.
{
  const seedUser = useAuthStore.getState().user;
  if (seedUser) identifyUser(seedUser.id);
  let lastUserId = seedUser?.id ?? null;
  useAuthStore.subscribe((state) => {
    const nextId = state.user?.id ?? null;
    if (nextId === lastUserId) return;
    lastUserId = nextId;
    if (nextId) identifyUser(nextId);
    else resetAnalytics();
  });
}

// Keyboard-only visualViewport pinning (#5888 / #725): trackVisualViewport
// writes --vv-height only while a text field is focused and the visual
// viewport is substantially shorter than the layout viewport. Task #15
// still owns the no-keyboard path (CSS 100dvh / fixed #root) — we do not
// reintroduce always-on JS height pinning that left the PWA bottom gap.
trackVisualViewport();
installExternalTranslationGuard();

const APP_REFRESH_REQUIRED_EVENT = "raft:app-refresh-required";
let appRefreshRequired = false;
let appRefreshTriggerSource: UpdateGateTriggerSource = "error_boundary";

async function clearAssetCacheAndReload() {
  reportUpdateGateDecision({
    action: "recovery_started",
    reason: "user_recover",
    triggerSource: appRefreshTriggerSource,
  });
  let cleanupFailureCount = 0;
  let serviceWorkerCount = 0;
  let assetCacheCount = 0;
  try {
    const cleanup: Array<Promise<unknown>> = [];

    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      serviceWorkerCount = registrations.length;
      cleanup.push(
        ...registrations
          .filter((registration) => {
            try {
              return new URL(registration.scope).origin === window.location.origin;
            } catch {
              return false;
            }
          })
          .map((registration) => registration.update().catch(() => { cleanupFailureCount += 1; })),
      );
      cleanup.push(navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => { cleanupFailureCount += 1; }));
    }

    if ("caches" in window) {
      const keys = await window.caches.keys();
      assetCacheCount = keys.filter((key) => key.startsWith("slock-assets-")).length;
      cleanup.push(
        ...keys
          .filter((key) => key.startsWith("slock-assets-"))
          .map((key) => window.caches.delete(key).catch(() => { cleanupFailureCount += 1; return false; })),
      );
    }

    await Promise.all(cleanup);
  } catch (error) {
    cleanupFailureCount += 1;
    console.warn("[RootErrorBoundary] app refresh cache cleanup failed", error);
  } finally {
    await reportUpdateGateDecisionBeforeUnload({
      action: "recovery_finished",
      reason: cleanupFailureCount === 0 ? "cleanup_completed" : "cleanup_partial_failure",
      triggerSource: appRefreshTriggerSource,
      cleanupFailureCount,
      serviceWorkerCount,
      assetCacheCount,
    });
    const url = new URL(window.location.href);
    url.searchParams.set("raft_recover", String(currentTimeMs()));
    window.location.replace(url.toString());
  }
}

function requestAppRefreshPrompt(error: unknown, triggerSource: UpdateGateTriggerSource): boolean {
  try {
    if (typeof window !== "undefined" && isDynamicImportFailure(error)) {
      reportUpdateGateDecision({
        action: "detected",
        reason: "dynamic_import_failure",
        triggerSource,
      });
      appRefreshTriggerSource = triggerSource;
      appRefreshRequired = true;
      window.dispatchEvent(new CustomEvent(APP_REFRESH_REQUIRED_EVENT));
      return true;
    }
  } catch (promptError) {
    console.warn("[RootErrorBoundary] app refresh prompt guard failed", promptError);
  }
  return false;
}

if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload ?? event;
    requestAppRefreshPrompt(payload, "vite_preload_error");
    // Do not cancel this event. Vite treats a canceled preload error as
    // handled and resolves the failed import to undefined. React.lazy then
    // masks the useful chunk error with "reading 'default'" instead of
    // letting the root boundary show the refresh recovery screen.
  });
}

type RootErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
  refreshRequired: boolean;
  refreshWarningVisible: boolean;
  refreshPromptDismissed: boolean;
};

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
    info: null,
    refreshRequired: appRefreshRequired,
    refreshWarningVisible: false,
    refreshPromptDismissed: false,
  };
  componentDidMount() {
    if (typeof window === "undefined") return;
    window.addEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
    if (this.state.refreshRequired) {
      reportUpdateGateDecision({
        action: "prompt_shown",
        reason: "dynamic_import_failure",
        triggerSource: appRefreshTriggerSource,
      });
    }
  }
  componentWillUnmount() {
    if (typeof window === "undefined") return;
    window.removeEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
  }
  handleRefreshRequired = () => {
    if (this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "prompt_suppressed",
        reason: "dismissed_prompt",
        triggerSource: appRefreshTriggerSource,
      });
      this.setState({ error: null, info: null, refreshRequired: false, refreshWarningVisible: true });
      return;
    }
    reportUpdateGateDecision({
      action: "prompt_shown",
      reason: "dynamic_import_failure",
      triggerSource: appRefreshTriggerSource,
    });
    this.setState({ error: null, info: null, refreshRequired: true });
  };
  handleContinueAnyway = () => {
    reportUpdateGateDecision({
      action: "continued",
      reason: "user_continue",
      triggerSource: appRefreshTriggerSource,
    });
    this.setState({
      error: null,
      info: null,
      refreshRequired: false,
      refreshWarningVisible: true,
      refreshPromptDismissed: true,
    });
  };
  handleRecoverAndRefresh = () => {
    void clearAssetCacheAndReload();
  };
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isDynamicImportFailure(error) && this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "detected",
        reason: "dynamic_import_failure",
        triggerSource: "later_action",
      });
      reportUpdateGateDecision({
        action: "prompt_shown",
        reason: "dynamic_import_failure",
        triggerSource: "later_action",
      });
      appRefreshTriggerSource = "later_action";
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected after later action");
      return;
    }
    if (requestAppRefreshPrompt(error, "error_boundary")) {
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected; showing refresh prompt");
      return;
    }
    this.setState({ error, info, refreshRequired: false, refreshWarningVisible: false });
    console.error("[RootErrorBoundary]", error, info.componentStack);
    reportClientError({ source: "error_boundary", error, componentStack: info.componentStack });
  }
  render() {
    // RootErrorBoundary sits above the app LocaleProvider; wrap intl-backed
    // fallbacks so formatMessage resolves the user's persisted display locale.
    if (this.state.refreshRequired) {
      return (
        <LocaleProvider>
          <IntlProviderWrapper>
            <AppRefreshRequiredScreen
              onContinueAnyway={this.handleContinueAnyway}
              onRecoverAndRefresh={this.handleRecoverAndRefresh}
            />
          </IntlProviderWrapper>
        </LocaleProvider>
      );
    }

    if (this.state.error) {
      return (
        <LocaleProvider>
          <IntlProviderWrapper>
            <RootErrorFallback
              error={this.state.error}
              componentStack={this.state.info?.componentStack}
            />
          </IntlProviderWrapper>
        </LocaleProvider>
      );
    }
    return (
      <>
        {this.state.refreshWarningVisible ? (
          <LocaleProvider>
            <IntlProviderWrapper>
              <AppRefreshWarningBanner onRefresh={this.handleRecoverAndRefresh} />
            </IntlProviderWrapper>
          </LocaleProvider>
        ) : null}
        {this.props.children}
      </>
    );
  }
}

installGlobalClientErrorReporters();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ThemeProvider defaultTheme="brutal" defaultMode="light">
        <TooltipProvider>
          <ToastProvider>
            <ForwardToastProvider>
              <BrowserRouter>
                <ServiceWorkerNavigationBridge />
                <LocaleProvider>
                  <IntlProviderWrapper>
                    <App />
                  </IntlProviderWrapper>
                </LocaleProvider>
              </BrowserRouter>
            </ForwardToastProvider>
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>
);
