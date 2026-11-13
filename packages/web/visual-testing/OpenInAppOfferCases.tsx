import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import MainLayout from "../src/components/layout/MainLayout";
import { resetDesktopPlatformsForTest } from "../src/components/settings/DesktopDownloadOptions";
import { useAuthStore } from "../src/store/authStore";
import { DEEP_LINKS_FLAG_KEY, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { captureMessageLinkLanding } from "../src/utils/messageLinkLanding";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// Deep links v1: the Raft Desktop offer in the strip across the window
// (ShellFrame's topStrip), on the real MainLayout at desktop width. The page is opened fresh by
// the capture, with no referrer, so the app's own boot capture
// (captureMessageLinkLanding) records it as a landing from outside; the flag
// is seeded on. `desktop-used`: the account used Raft Desktop lately.
// `desktop-download`: no such sign, so the lead-in and this computer's
// download. The phone's row has no case: it shows only on a web host that has
// an open host (utils/openInAppLink.ts), which the fixture host is not.

export const OPEN_IN_APP_OFFER_CASE_IDS = [
  "screens.shell.open-in-app.desktop-used",
  "screens.shell.open-in-app.desktop-download",
] as const;
type OpenInAppOfferCaseId = (typeof OPEN_IN_APP_OFFER_CASE_IDS)[number];

export function isOpenInAppOfferCase(caseId: string): caseId is OpenInAppOfferCaseId {
  return (OPEN_IN_APP_OFFER_CASE_IDS as readonly string[]).includes(caseId);
}

export const OPEN_IN_APP_OFFER_CASE_PATH = `/s/${fixtureData.server.slug}/computers`;

const ALL_AVAILABLE = { mac: { status: "available" }, linux: { status: "available" }, windows: { status: "available" } } as const;

function prime(caseId: OpenInAppOfferCaseId, primeShell: () => void) {
  primeShell();
  setServerFeatureFlagForTests(fixtureData.server.id, DEEP_LINKS_FLAG_KEY, true);
  resetDesktopPlatformsForTest(async () => ALL_AVAILABLE);
  if (caseId.endsWith(".desktop-used")) {
    useAuthStore.setState((state) => ({ user: state.user ? { ...state.user, usedDesktopAppRecently: true } : state.user }));
  }
  captureMessageLinkLanding();
}

export function OpenInAppOfferCase({ caseId, primeShell }: { caseId: OpenInAppOfferCaseId; primeShell: () => void }) {
  useMemo(() => prime(caseId, primeShell), [caseId, primeShell]);
  if (window.location.pathname !== OPEN_IN_APP_OFFER_CASE_PATH) return null;
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}
