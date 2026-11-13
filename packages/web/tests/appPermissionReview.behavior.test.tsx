import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { SettingsPanel } from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { useAgentStore } from "../src/store/agentStore";
import { serveMarketplaceListingsFromAppRecords } from "./helpers/marketplaceListings";

// The App detail loads its permission state after the row is opened; on a busy
// CI machine that takes longer than Testing Library's 1s default (#11770,
// #11771, #11774), so the waits that span it get 5s.
const DETAIL_WAIT = { timeout: 5_000 };

// The Marketplace tab reads pages of listings; these tests answer the App records.
serveMarketplaceListingsFromAppRecords();

const originalGet = api.get;
const en = enMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useAgentStore.setState({ agents: [] } as never);
});

function seedOwner() {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as never;
  }
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "u@example.com",
      name: "U",
      displayName: "U",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: "UTC",
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1", role: "owner" }],
    current: { id: "s1", slug: "s1", name: "S1", role: "owner" },
    members: [],
    loading: false,
  } as never);
  useTranslationStore.setState({
    settings: {
      ...useTranslationStore.getInitialState().settings,
      preferredTranslationMode: "off",
      preferredTimeFormat: "24h",
      effectiveTimeFormat: "24h",
    },
    settingsServerId: "s1",
    settingsLoading: false,
    settingsError: null,
  } as never);
}

function renderPanel(tab: "integrations") {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <SettingsPanel tab={tab} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const pendingMarketplaceApp = {
  id: "market_tdoc",
  serverId: "other-server",
  clientId: "tdoc-7a927d",
  appType: "third_party_global",
  publishStatus: "published",
  category: "Productivity & Collaboration",
  dataAccessSummary: null,
  publishRejectionReason: null,
  name: "tdoc",
  description: "Docs sync.",
  homepageUrl: "https://example.com/tdoc",
  returnUrl: null,
  agentManifestUrl: null,
  allowedScopes: [],
  logoUrl: null,
  humanMarketplaceVisible: true,
  createdByUserId: "user-2",
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
  installedAt: null,
  publisherName: "julie",
  privateShared: false,
  appNotificationGroups: [],
  appNotificationEvents: [],
  appNotificationReviewPending: true,
  appNotificationPendingRevisionId: "rev-seen-by-reviewer",
  appNotificationPendingGroups: ["agent"],
  appNotificationPendingEvents: [],
};

// Permission updates are reviewed in App Admin (#proj-apps task #19): Raft
// shows what waits, with no approve action for anyone.
test("marketplace app detail shows pending permission groups and no approve action", async () => {
  seedOwner();
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") return { data: [pendingMarketplaceApp] };
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    return { data: [] };
  }) as typeof api.get;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("tdoc", undefined, DETAIL_WAIT));

  // Pending badge is the permission-update variant, not the generic review copy.
  assert.ok(await screen.findByText(en["settings.connectedApps.appNotifications.permissionUpdatePending"], undefined, DETAIL_WAIT));
  // Requested (pending) groups are surfaced, not just approved current_groups.
  const summary = await screen.findByTestId("app-notifications-request-summary", undefined, DETAIL_WAIT);
  assert.ok(summary.textContent?.includes("Agent"), "pending 'agent' group must be shown");
  assert.ok(summary.textContent?.includes(en["settings.connectedApps.appNotifications.requestedDataGroups"]));
  assert.ok(screen.queryByTestId("app-notifications-review-action") === null, "no review action");
  assert.ok(summary.querySelector("button") === null, "nothing in the summary approves the update");
});
