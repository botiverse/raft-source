// Raft Desktop — bundled frontend entry.
//
// The desktop APP's own frontend. It reuses the web app's REAL bootstrap: the
// same provider tree and the same top-level <App/> (which owns login, register,
// forgot/reset password, the social-auth callback, email-verification and
// profile-setup gates, the restore/retry loading machine, and the authenticated
// route tree). We only swap in the pieces a packaged desktop app needs:
//   - HashRouter instead of BrowserRouter (app:// has no server to rewrite paths)
//   - the desktop shell adaptation + native bridge
//   - a thin error boundary around the web's real RootErrorFallback (the web's
//     own boundary also does stale-build / dynamic-import recovery, which is a
//     web-deploy concern — a packaged app ships its chunks locally and versioned)
// We deliberately drop the web's PWA service worker, analytics bootstrap, and
// Tauri handshake, none of which apply here.

import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "raft-ui";
import { BrowserRouter } from "react-router-dom";
import { LocaleProvider } from "@web/i18n/LocaleProvider";
import { IntlProviderWrapper } from "@web/i18n/IntlProviderWrapper";
import { ForwardToastProvider } from "@web/components/message/ForwardToastProvider";
import {
  installGlobalClientErrorReporters,
  reportClientError,
} from "@web/utils/clientErrorTrace";
import RootErrorFallback from "@web/components/errors/RootErrorFallback";
import { applyDesktopAppAdaptation } from "./desktop/desktopAppAdaptation";
import { useAuthStore } from "@web/store/authStore";
import App from "@web/App";
import { DesktopNativeBridge } from "./desktop/DesktopNativeBridge";
import { DesktopTopBar } from "./desktop/DesktopTopBar";
import { DesktopSelfComputerMount } from "./desktop/computer/DesktopSelfComputerMount";
import { DesktopOnboardingComputerMount } from "./desktop/computer/DesktopOnboardingComputerMount";
import { initSkin } from "./desktop/skins";
import { installDesktopOAuth } from "./desktop/desktopOAuth";
import "./index.css";

// The desktop shell: a unified top toolbar (only when signed in — the login
// page keeps its own brand bar) above the reused app, which fills the rest.
// #root is a fixed-height flex column, so this flex-1 wrapper fills the window.
// Signed-out / bootstrap pages have no DesktopTopBar, so the frameless window
// would have no drag region there. This strip provides one and reserves the
// traffic-light corner. It is h-12 to MATCH the signed-in DesktopTopBar (h-12):
// the native traffic lights sit at a fixed y (TRAFFIC_LIGHT_INSET_Y) tuned to
// center in a 48px bar, so a shorter strip left them uncentered on blank pages
// (e.g. the "restoring session" screen, which has no auth brand bar beneath the
// strip to fill the height). On the login page it still reads as one signal-
// colored bar with the brand bar below it.
function DesktopLoginTitlebar() {
  return <div data-raft-titlebar className="h-12 shrink-0 bg-soft-signal" />;
}

function DesktopShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {user ? <DesktopTopBar /> : <DesktopLoginTitlebar />}
      <div className="flex min-h-0 flex-1">{children}</div>
      {/* Portals the "This Computer" self-card into the reused Sidebar's
          Computers list (desktop-only; fully inert without the computer bridge). */}
      <DesktopSelfComputerMount />
      {/* Turns onboarding's "connect a computer" CLI step into a one-click Enable
          (desktop bundles the binary + has the session); inert off the step. */}
      <DesktopOnboardingComputerMount />
    </div>
  );
}

class DesktopErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; componentStack: string | null }
> {
  state = { error: null as Error | null, componentStack: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    reportClientError({ source: "error_boundary", error, componentStack: info.componentStack });
  }

  render() {
    if (this.state.error) {
      // RootErrorFallback uses react-intl, so it must live under the locale
      // providers even when the app tree below has crashed.
      return (
        <LocaleProvider>
          <IntlProviderWrapper>
            <RootErrorFallback error={this.state.error} componentStack={this.state.componentStack} />
          </IntlProviderWrapper>
        </LocaleProvider>
      );
    }
    return this.props.children;
  }
}

// Report uncaught errors / rejections, and mark the document as the Electron
// shell before first paint (activates the web's desktop-only CSS).
installGlobalClientErrorReporters();
applyDesktopAppAdaptation();
// Apply the persisted skin before first paint so surfaces open in the chosen
// color. Skin switching lives only in the top bar (DesktopTopBar's SkinSwitcher).
initSkin();
// Route social-login clicks through the native PKCE + loopback flow.
installDesktopOAuth();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <DesktopErrorBoundary>
        <ThemeProvider defaultTheme="brutal" defaultMode="light">
          <TooltipProvider>
            <ToastProvider>
              <ForwardToastProvider>
                {/* BrowserRouter (not HashRouter): the app:// protocol handler
                    SPA-falls-back to index.html for every path, so real paths
                    resolve on reload — and, unlike HashRouter, window.location
                    reflects the route, which the web's query-param layer
                    (useLiveSearchParams) requires. HashRouter silently broke
                    ?thread= / ?msg= writes (thread-open would immediately close). */}
                <BrowserRouter>
                  <LocaleProvider>
                    <IntlProviderWrapper>
                      <DesktopNativeBridge />
                      <DesktopShell>
                        <App />
                      </DesktopShell>
                    </IntlProviderWrapper>
                  </LocaleProvider>
                </BrowserRouter>
              </ForwardToastProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </DesktopErrorBoundary>
    </StrictMode>,
  );
}
