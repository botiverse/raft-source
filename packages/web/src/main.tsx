import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { installGlobalClientErrorReporters } from "./utils/clientErrorTrace";
import { preloadInitialLocaleMessages } from "./i18n/preloadLocaleMessages";
import { AppProviders } from "./AppProviders";
import { WindowControlsOverlayShell } from "./components/topbar/windowControlsOverlay";
import App from "./App";
import ServiceWorkerNavigationBridge from "./components/pwa/ServiceWorkerNavigationBridge";
import "./index.css";
import { registerPushServiceWorker, supportsPushNotifications } from "./utils/pushNotifications";
import { assertOfflineBundleStart } from "./utils/offlineBundleHost";
import { installExternalTranslationGuard } from "./utils/externalTranslationGuard";
import { RootErrorBoundary } from "./components/errors/RootErrorBoundary";
import { installAppUpdateGate } from "./utils/appUpdateGate";
import { installWebVersionCheck } from "./utils/webVersionCheck";
import { NewWebVersionBanner } from "./components/errors/NewWebVersionBanner";
import "./buildIdentity";
import { trackVisualViewport } from "./utils/visualViewport";
import { installViewSwitchTracking } from "./observability/viewSwitchSpan";
import { captureLandingPage } from "./analytics/publicVisits";
import { captureMessageLinkLanding } from "./utils/messageLinkLanding";
import { applyBootServerTheme } from "./theme/serverTheme";
import { isBootTimingReported, markBootMilestone, startBootTiming } from "./boot/bootTiming";
import { armFirstScreenGate, openFirstScreenGate } from "./boot/deferredUi";
import { fetchDeferredUiAfterFirstScreen } from "./boot/deferredUiStart";
import { openServerFromDevice } from "./boot/openServerFromDevice";
import { preloadComputersRackForRoute } from "./features/computer/computersRackChunk";
import { preloadLandingPageForLocation } from "./pages/landingPages";
import { preloadThreadPanelForLocation } from "./features/thread/threadPanelChunk";
import { openArtifactFromDevice, shortenArtifactAddress, startArtifactPermalink } from "./boot/openArtifactFromDevice";
import { flushLocalTables, hydrateLocalTables } from "./store/localTables/persistence";
import { localTableSession, startMeWriter } from "./store/localTables/storeWriters";
import { startOfflineSession } from "./store/offlineSession";
import { refreshExpiredTokenAtBoot, useAuthStore } from "./store/authStore";
import { requestServerListEarly } from "./store/serverStore";
import { bootRequestsServerListEarly, isAuthHandoffPage } from "./boot/serverFrame";
import { followSignedInUser } from "./store/signedInUser";

// Local dev tools must be installed before React's first render. Gate the render
// on them rather than using top-level await: any TLA in the module graph makes
// Rolldown turn off common-chunk merging for the whole production build.
const localDevToolsReady = import.meta.env.DEV
  ? import("./devtools/localReactDevTools").then(({ installLocalReactDevTools }) => installLocalReactDevTools())
  : null;

// The E2E hooks (window.__SLOCK_E2E__) exist only in the Playwright build
// (VITE_E2E=true). Any other build drops this import, so neither the hooks nor
// what they import (the screenshot export...) are in its first download; the
// E2E build attaches them before the first render, as a static import did.
// A failed load still renders (with the cause in the console), so an E2E
// failure shows why rather than a blank page.
const e2eHooksReady = import.meta.env.VITE_E2E === "true"
  ? import("./testHooks").then(() => {}, (error: unknown) => {
    console.error("[e2e] window.__SLOCK_E2E__ hooks failed to load; rendering without them", error);
  })
  : null;

// The Artifacts fake dev build (VITE_ARTIFACTS_SOURCE=fake) installs the fake
// before the first render, so boot reads (an Artifact opened from the device)
// answer from it, not the API. Every other build drops this import.
const fakeArtifactsReady = import.meta.env.DEV === true && import.meta.env.VITE_ARTIFACTS_SOURCE === "fake"
  ? import("./apps/artifacts").then(({ installFakeArtifactSourceForDev }) => installFakeArtifactSourceForDev())
    .catch((error: unknown) => { console.error("[artifacts] the fake data source failed to load", error); })
  : null;

if (supportsPushNotifications()) {
  void registerPushServiceWorker();
}

// The service worker's release messages and what a failed chunk does (utils/appUpdateGate).
installAppUpdateGate();
// A newer Web version published since this tab loaded: reload or offer Reload (utils/webVersionCheck).
installWebVersionCheck();

// Keyboard-only visualViewport pinning (#5888 / #725): trackVisualViewport
// pins #root's height only while a text field is focused and the visual
// viewport is substantially shorter than the layout viewport. Task #15
// still owns the no-keyboard path (CSS 100dvh / fixed #root) — we do not
// reintroduce always-on JS height pinning that left the PWA bottom gap.
trackVisualViewport();
installExternalTranslationGuard();
// An older Artifact link (`/artifacts/pt_<uuid>`) shows as links are written now, before anything reads the address.
shortenArtifactAddress(window.location, window.history);
// Before the first render moves the URL: where a Public Server visit came from.
captureLandingPage();
captureMessageLinkLanding();
// The server this page opens shows its own theme from the first frame.
applyBootServerTheme(window.location.pathname);
// slock.web.boot_timing: what this load opens; milestones report as they come.
startBootTiming();
// The messages store reads replies for whoever the auth store has signed in,
// from before the first request (store/signedInUser.ts).
followSignedInUser();
// The local tables (store/localTables): the stored session's are put back from
// the device, and the person's own row follows the auth store from now on.
const localTablesHydrated = hydrateLocalTables(localTableSession());
// A server link opens its server from them, before GET /servers answers.
void openServerFromDevice(window.location, localTablesHydrated);
// A page that opens on Computers (the native WebView's) starts the rack's code
// now, alongside the first requests, not once the page has rendered.
preloadComputersRackForRoute(window.location.pathname);
// A link to a landing page (sign-in setup, an invite, a reset email...) starts that page's code now too.
preloadLandingPageForLocation(window.location);
// So does an address with a thread open: the thread panel is deferred (features/thread/threadPanelChunk.ts).
preloadThreadPanelForLocation(window.location);
// An expired access token held every early request until refresh, /auth/me
// and the server list had run one after another (+1.7 s median for a third of
// boots). Refresh now, then send them alongside /auth/me: a canonical Artifact
// link's `open` too, and the list its page enters the server from.
if (!isAuthHandoffPage(window.location)) void refreshExpiredTokenAtBoot().then((refreshed) => {
  if (!refreshed) return;
  void openServerFromDevice(window.location, localTablesHydrated);
  const openedArtifact = openArtifactFromDevice(window.location);
  if (bootRequestsServerListEarly(window.location) || openedArtifact) requestServerListEarly();
});
// A canonical Artifact link starts its page, and its one call (`open`) with the stored token, alongside /auth/me.
startArtifactPermalink(window.location);
startMeWriter(useAuthStore.subscribe);
// Opened offline: once /auth/me fails unreachable and the tables are back, the
// last session's workspace from them, marked Offline (store/offlineSession).
startOfflineSession(useAuthStore.subscribe, useAuthStore.getState, localTablesHydrated);
window.addEventListener("pagehide", flushLocalTables);
// First-screen-optional requests wait for the content milestone; a load that
// shows no conversation lets them go after this.
const FIRST_SCREEN_GATE_FALLBACK_MS = 4_000;
armFirstScreenGate();
// Its content milestone: the first conversation's first page is in. Then the
// UI kept out of the first download is fetched (boot/deferredUi); a load that
// shows no conversation fetches it after a while anyway.
// A load reported earlier (a landing that isn't a conversation reports at
// its frame, a hidden tab when hidden) still opens the first-screen gate when
// a conversation's first page comes in.
fetchDeferredUiAfterFirstScreen(() => {
  if (!isBootTimingReported()) markBootMilestone("content");
});
setTimeout(openFirstScreenGate, FIRST_SCREEN_GATE_FALLBACK_MS);

// A host injection that is present but invalid is a failed offline start: show the
// root error screen instead of running as an ordinary page. The host's own
// timeout then falls back to the last good bundle.
function OfflineBundleStartGate() {
  assertOfflineBundleStart();
  return null;
}

installGlobalClientErrorReporters();
// Back and Forward start a `web.view.switch` span (observability/viewSwitchSpan.ts).
installViewSwitchTracking();

const renderRoot = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <OfflineBundleStartGate />
      {/* Root composition lives in AppProviders — shared with the desktop
          shell, never re-listed here (see that file). */}
      <AppProviders insideRouter={<ServiceWorkerNavigationBridge />}>
        {/* Installed as an app with the browser's window controls laid over
            the page: the top bar is the window's title bar (no-op otherwise). */}
        <WindowControlsOverlayShell>
          <App />
        </WindowControlsOverlayShell>
        <NewWebVersionBanner />
      </AppProviders>
    </RootErrorBoundary>
  </StrictMode>
);

// index.html puts the app stylesheet after the boot frame so it does not hold
// the first paint; wait for it here instead, so the first render is styled.
const STYLESHEET_WAIT_MAX_MS = 3000;

function stylesheetsReady(): Promise<void> | null {
  const loading = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .filter((link) => !link.sheet);
  if (loading.length === 0) return null;
  // A sheet that already failed has no sheet and fires no more events: never wait
  // longer than a few seconds, so a broken stylesheet costs styling, not the app.
  return Promise.race([
    Promise.all(loading.map((link) => new Promise<void>((resolve) => {
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => resolve(), { once: true });
    }))).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, STYLESHEET_WAIT_MAX_MS);
    }),
  ]);
}

const initialLocaleReady = preloadInitialLocaleMessages();
const initialStylesReady = stylesheetsReady();
const startRoot = () => (initialLocaleReady || initialStylesReady
  ? void Promise.all([initialLocaleReady, initialStylesReady]).then(renderRoot)
  : renderRoot());

if (localDevToolsReady || e2eHooksReady || fakeArtifactsReady) {
  void Promise.all([localDevToolsReady, e2eHooksReady, fakeArtifactsReady]).then(startRoot);
}
else startRoot();
