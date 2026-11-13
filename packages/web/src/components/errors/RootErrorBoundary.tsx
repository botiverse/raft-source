import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ThemeProvider } from "@botiverse/raft-ui";
import { reportClientError } from "../../utils/clientErrorTrace";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import { IntlProviderWrapper } from "../../i18n/IntlProviderWrapper";
import { isDynamicImportFailure } from "../../utils/dynamicImportRecovery";
import { reportUpdateGateDecision } from "../../utils/updateGateTrace";
import {
  APP_REFRESH_REQUIRED_EVENT,
  APP_UPDATE_AVAILABLE_EVENT,
  appUpdateState,
  clearAssetCacheAndReload,
  requestAppRefreshPrompt,
} from "../../utils/appUpdateGate";
import { setChunkStripShown } from "../../utils/webVersionCheck";
import RootErrorFallback from "./RootErrorFallback";
import { AppRefreshRequiredScreen, AppRefreshWarningBanner } from "./AppUpdateGate";

type RootErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
  /** The crash report's trace id, shown on the fallback for the user to send us. */
  traceId?: string | null;
  refreshRequired: boolean;
  refreshWarningVisible: boolean;
  refreshPromptDismissed: boolean;
};

type RootErrorBoundaryProps = {
  children: ReactNode;
  /** Refresh (the screen's and the strip's); tests replace the cache-clearing reload. */
  onRecoverAndRefresh?: () => void;
};

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
    info: null,
    refreshRequired: appUpdateState.refreshRequired,
    refreshWarningVisible: appUpdateState.updateAvailable,
    refreshPromptDismissed: false,
  };
  componentDidMount() {
    if (typeof window === "undefined") return;
    setChunkStripShown(this.state.refreshWarningVisible);
    window.addEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
    window.addEventListener(APP_UPDATE_AVAILABLE_EVENT, this.handleUpdateAvailable);
    if (this.state.refreshRequired || this.state.refreshWarningVisible) {
      reportUpdateGateDecision({
        action: "prompt_shown",
        reason: "dynamic_import_failure",
        triggerSource: appUpdateState.triggerSource,
      });
    }
  }
  // The new-version banner (NewWebVersionBanner) stays away while the strip shows.
  componentDidUpdate() {
    setChunkStripShown(this.state.refreshWarningVisible);
  }
  componentWillUnmount() {
    if (typeof window === "undefined") return;
    setChunkStripShown(false);
    window.removeEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
    window.removeEventListener(APP_UPDATE_AVAILABLE_EVENT, this.handleUpdateAvailable);
  }
  handleRefreshRequired = () => {
    if (this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "prompt_suppressed",
        reason: "dismissed_prompt",
        triggerSource: appUpdateState.triggerSource,
      });
      this.setState({ error: null, info: null, refreshRequired: false, refreshWarningVisible: true });
      return;
    }
    reportUpdateGateDecision({
      action: "prompt_shown",
      reason: "dynamic_import_failure",
      triggerSource: appUpdateState.triggerSource,
    });
    this.setState({ error: null, info: null, refreshRequired: true });
  };
  // The strip over the running app; once put away, not again this page.
  handleUpdateAvailable = () => {
    if (this.state.refreshWarningVisible || this.state.refreshRequired) return;
    if (this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "prompt_suppressed",
        reason: "dismissed_prompt",
        triggerSource: "vite_preload_error",
      });
      return;
    }
    reportUpdateGateDecision({
      action: "prompt_shown",
      reason: "dynamic_import_failure",
      triggerSource: "vite_preload_error",
    });
    this.setState({ refreshWarningVisible: true });
  };
  handleDismissWarning = () => {
    reportUpdateGateDecision({
      action: "continued",
      reason: "user_continue",
      triggerSource: appUpdateState.triggerSource,
    });
    appUpdateState.stripDismissed = true;
    this.setState({ refreshWarningVisible: false, refreshPromptDismissed: true });
  };
  handleContinueAnyway = () => {
    reportUpdateGateDecision({
      action: "continued",
      reason: "user_continue",
      triggerSource: appUpdateState.triggerSource,
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
    if (this.props.onRecoverAndRefresh) this.props.onRecoverAndRefresh();
    else void clearAssetCacheAndReload();
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
      appUpdateState.triggerSource = "later_action";
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected after later action");
      return;
    }
    if (requestAppRefreshPrompt(error, "error_boundary")) {
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected; showing refresh prompt");
      return;
    }
    console.error("[RootErrorBoundary]", error, info.componentStack);
    const traceId = reportClientError({ source: "error_boundary", error, componentStack: info.componentStack });
    this.setState({ error, info, traceId, refreshRequired: false, refreshWarningVisible: false });
  }
  render() {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    const mode = root?.classList.contains("dark") ? "dark" : "light";

    // RootErrorBoundary sits above AppThemeProvider and LocaleProvider; wrap intl-backed
    // and RUI fallbacks so formatMessage resolves the user's persisted display locale
    // and RUI components resolve the active mode from DOM without touching app stores.
    if (this.state.refreshRequired) {
      return (
        <ThemeProvider mode={mode} syncDom={false}>
          <LocaleProvider>
            <IntlProviderWrapper recovery>
              <AppRefreshRequiredScreen
                onContinueAnyway={this.handleContinueAnyway}
                onRecoverAndRefresh={this.handleRecoverAndRefresh}
              />
            </IntlProviderWrapper>
          </LocaleProvider>
        </ThemeProvider>
      );
    }

    if (this.state.error) {
      return (
        <ThemeProvider mode={mode} syncDom={false}>
          <LocaleProvider>
            <IntlProviderWrapper recovery>
              <RootErrorFallback
                error={this.state.error}
                componentStack={this.state.info?.componentStack}
                traceId={this.state.traceId}
              />
            </IntlProviderWrapper>
          </LocaleProvider>
        </ThemeProvider>
      );
    }
    return (
      <>
        {this.state.refreshWarningVisible ? (
          <ThemeProvider mode={mode} syncDom={false}>
            <LocaleProvider>
              <IntlProviderWrapper recovery>
                <AppRefreshWarningBanner
                  onRefresh={this.handleRecoverAndRefresh}
                  onDismiss={this.handleDismissWarning}
                />
              </IntlProviderWrapper>
            </LocaleProvider>
          </ThemeProvider>
        ) : null}
        {this.props.children}
      </>
    );
  }
}
