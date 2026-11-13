import assert from "node:assert/strict";
import { assertScrollAreaRailsOn } from "./helpers/scrollAreaRails";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
// SettingsPanel → ConnectedApps mounts the react-intl-migrated ConfirmDialog
// (client-secret regen confirm), which needs an <IntlProvider> ancestor.
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";
import { chooseRegisterAppMenuItem } from "./helpers/registerAppMenu";
import { OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import api from "../src/api/client";
import RequestedScopeConsent from "../src/components/oauth/RequestedScopeConsent";
import { SettingsPanel } from "../src/components/settings/SettingsPanel";
import { CONNECTED_APP_CATEGORY_LABEL_ID, matchesConnectedAppFilter } from "../src/features/apps/connected-apps/connectedAppCatalog";
import {
  toggleAppNotificationEvent,
  toggleAppNotificationGroup,
} from "../src/components/settings/AppNotificationsControls";
import AvatarSlot from "../src/components/ui/AvatarSlot";
import {
  AGENT_INBOUND_CANNOT_SUMMARY_ID,
  AGENT_INBOUND_NEGATIVE_CAPABILITY_ID,
  AGENT_INBOUND_OAUTH_SCOPES,
  DEFAULT_DECLARED_OAUTH_SCOPES,
  IDENTITY_SCOPE_GROUP_SUMMARY_ID,
  IDENTITY_OAUTH_SCOPES,
  OPTIONAL_IDENTITY_OAUTH_SCOPES,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  isVisibleOAuthScope,
  normalizeDeclaredOAuthScopes,
  normalizeVisibleOAuthScopes,
  scopeGroupLabelId,
} from "../src/lib/oauthScopePresentation";
import { en as enMessages } from "../src/i18n/messages/en";
import HumanLoginSetupPage from "../src/pages/HumanLoginSetupPage";
import { initialsForApp } from "../src/features/login-with-raft/appInitials";
import { authorizationErrorRedirectUrl } from "../src/features/login-with-raft/loginErrors";
import IntegrationInvitePage from "../src/pages/IntegrationInvitePage";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { serveMarketplaceListingsFromAppRecords } from "./helpers/marketplaceListings";

// The Marketplace tab reads pages of listings; these tests answer the App records.
serveMarketplaceListingsFromAppRecords();

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiPut = api.put;
const originalApiPatch = api.patch;
const originalApiDelete = api.delete;
const originalOpen = window.open;

const ownerServer: Server = {
  id: "server-1",
  name: "Launch Server",
  avatarUrl: null,
  slug: "launch",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-25T00:00:00.000Z",
};

function resetStores() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      name: "Owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);

  useServerStore.setState({
    servers: [ownerServer],
    current: ownerServer,
    members: [],
    loading: false,
  } as never);
}

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.put = originalApiPut;
  api.patch = originalApiPatch;
  api.delete = originalApiDelete;
  window.open = originalOpen;
  window.localStorage.removeItem("raft:connected-apps:view-mode");
  window.history.pushState({}, "", "/");
  resetStores();
});

test("Connected Apps filters share category and search semantics across tabs", () => {
  const storageApp = {
    name: "Private Reports",
    clientId: "private-reports",
    category: "Infrastructure" as const,
    description: "Shared reporting workflows",
    developer: "This server",
  };
  assert.equal(matchesConnectedAppFilter(storageApp, "", "all"), true);
  assert.equal(matchesConnectedAppFilter(storageApp, "", "Infrastructure"), true);
  assert.equal(matchesConnectedAppFilter(storageApp, "", "Productivity & Collaboration"), false);
  assert.equal(matchesConnectedAppFilter(storageApp, "private reports", "all"), true);
  assert.equal(matchesConnectedAppFilter(storageApp, "this server", "all"), true);
  assert.equal(matchesConnectedAppFilter(storageApp, "missing", "all"), false);
});

test("App Notifications picker removes events whose required group is disabled", () => {
  const selected = toggleAppNotificationGroup({ groups: [], events: [] }, "computer", true);
  const withAgent = toggleAppNotificationGroup(selected, "agent", true);
  const withEvent = toggleAppNotificationEvent(withAgent, "computer.agent_started", true);
  assert.deepEqual(withEvent, {
    groups: ["agent", "computer"],
    events: ["computer.agent_started"],
  });

  const withoutAgent = toggleAppNotificationGroup(withEvent, "agent", false);
  assert.deepEqual(withoutAgent, {
    groups: ["computer"],
    events: [],
  });
});

test("AvatarSlot renders app logos full-frame and deterministic app/server fallbacks", () => {
  const { rerender } = render(
    <AvatarSlot
      context="list-row"
      type="app"
      appAvatarUrl="https://cdn.example.com/orbital.png"
      appInitials="ON"
    />,
  );

  const logo = document.querySelector("img");
  assert.equal(logo?.getAttribute("src"), "https://cdn.example.com/orbital.png");
  assert.equal(logo?.getAttribute("class"), "relative z-raised h-full w-full object-cover");
  const fallbackLayer = logo?.previousElementSibling;
  assert.equal(fallbackLayer?.tagName, "SPAN");
  assert.equal(fallbackLayer?.classList.contains("absolute"), true);
  assert.equal(fallbackLayer?.classList.contains("z-base"), true);
  assert.equal(logo?.classList.contains("relative"), true);
  assert.equal(logo?.classList.contains("z-raised"), true);
  // Raft Design System › Avatar: initials are Grotesk 700 (raft-ui's fallback
  // slot sets them); an app keeps the default identity sticker (only a
  // workspace is the ink tile).
  const appFallback = logo?.closest('[data-slot="avatar-fallback"]');
  assert.equal(appFallback?.classList.contains("font-sans"), true);
  assert.equal(appFallback?.classList.contains("font-bold"), true);
  assert.equal(logo?.closest('[data-slot="avatar"]')?.classList.contains("bg-sticker-ink"), false);
  assert.equal(logo?.parentElement?.className.endsWith(" "), false);
  assert.equal(document.body.textContent?.trim(), "ON");

  fireEvent.error(logo!);
  assert.equal(logo?.hidden, true);
  assert.equal(document.body.textContent?.trim(), "ON");

  rerender(
    <AvatarSlot
      context="list-row"
      type="app"
      appAvatarUrl="https://cdn.example.com/orbital-v2.png"
      appInitials="ON"
    />,
  );
  const replacementLogo = document.querySelector("img");
  assert.equal(replacementLogo?.getAttribute("src"), "https://cdn.example.com/orbital-v2.png");
  assert.equal(replacementLogo?.hidden, false);

  rerender(<AvatarSlot context="list-row" type="app" appInitials=" orbital notes " />);
  assert.equal(document.body.textContent?.trim(), "OR");

  rerender(<AvatarSlot context="list-row" type="app" />);
  assert.equal(document.body.textContent?.trim(), "A");

  rerender(<AvatarSlot context="list-row" type="server" serverInitial=" beacon " />);
  assert.equal(document.body.textContent?.trim(), "B");
  assert.ok(document.querySelector('[data-avatar-type="server"] [data-slot="avatar-fallback"].font-bold'));
  // A workspace tile is the ink square with yellow initials.
  assert.ok(document.querySelector('[data-avatar-type="server"].bg-sticker-ink'));
  assert.ok(document.querySelector('[data-avatar-type="server"] [data-slot="avatar-fallback"].text-brand'));

  rerender(
    <AvatarSlot
      context="list-row"
      type="server"
      serverAvatarUrl="https://cdn.example.com/broken-server.png"
      serverInitial="beacon"
    />,
  );
  const serverAvatar = document.querySelector("img");
  fireEvent.error(serverAvatar!);
  assert.equal(serverAvatar?.hidden, true);
  assert.equal(document.body.textContent?.trim(), "B");

  rerender(<AvatarSlot context="list-row" type="human" humanPlaceholder />);
  assert.ok(document.querySelector('[data-avatar-type="human"] [data-slot="avatar-fallback"] svg.lucide-user'));
  assert.equal(document.body.textContent?.trim(), "");
});

test("Login with Raft app initials are deterministic for multi-word, single-word, and blank app names", () => {
  assert.equal(initialsForApp("Orbital Notes"), "ON");
  assert.equal(initialsForApp("  Orbital   Notes  "), "ON");
  assert.equal(initialsForApp("Launchpad"), "LA");
  assert.equal(initialsForApp(""), "A");
});

test("OAuth scope presentation normalizes visible identity and agent messaging scopes", () => {
  assert.deepEqual(IDENTITY_OAUTH_SCOPES, ["openid", "profile", "identity"]);
  assert.deepEqual(OPTIONAL_IDENTITY_OAUTH_SCOPES, ["email"]);
  assert.deepEqual(AGENT_INBOUND_OAUTH_SCOPES, ["agent:event:write", "agent:notification:write"]);
  assert.deepEqual(DEFAULT_DECLARED_OAUTH_SCOPES, ["openid", "profile", "identity"]);

  assert.equal(isVisibleOAuthScope("openid"), true);
  assert.equal(isVisibleOAuthScope("agent:event:write"), true);
  assert.equal(isVisibleOAuthScope("agent:action_request:write"), false);
  assert.equal(isVisibleOAuthScope("admin"), false);

  assert.deepEqual(
    normalizeVisibleOAuthScopes([
      "openid",
      "profile",
      "openid",
      "agent:event:write",
      "agent:action_request:write",
      "",
      "agent:notification:write",
    ]),
    ["openid", "profile", "agent:event:write", "agent:notification:write"],
  );
  assert.deepEqual(normalizeVisibleOAuthScopes(null), []);
  assert.deepEqual(normalizeDeclaredOAuthScopes(null), ["openid", "profile", "identity"]);
  assert.deepEqual(normalizeDeclaredOAuthScopes(["agent:event:write", "profile", "profile"]), ["agent:event:write", "profile"]);

  assert.equal(hasAgentInboundOAuthScope(["openid", "identity"]), false);
  assert.equal(hasAgentInboundOAuthScope(["openid", "agent:event:write"]), true);
  // The table holds ids now, so the English is asserted through the catalog.
  // Same property as before — these exact sentences still reach the screen —
  // but stated where the text actually lives.
  const en = enMessages as Record<string, string>;
  assert.equal(en[scopeGroupLabelId("identity")], "Identity");
  assert.equal(en[IDENTITY_SCOPE_GROUP_SUMMARY_ID], " — Who you are and your basic profile · no content access.");
  assert.equal(en[scopeGroupLabelId("agent_messaging")], "Agent messaging");

  assert.deepEqual(OAUTH_SCOPE_PRESENTATION.openid, {
    scope: "openid",
    tier: "identity",
    copyId: "oauth.scope.openid.copy",
    requiresResource: false,
  });
  assert.equal(en["oauth.scope.openid.copy"], "Signs you in with Raft and issues a stable identity token. Authentication only.");
  assert.deepEqual(OAUTH_SCOPE_PRESENTATION.profile, {
    scope: "profile",
    tier: "identity",
    copyId: "oauth.scope.profile.copy",
    requiresResource: false,
  });
  assert.equal(en["oauth.scope.profile.copy"], "Reads your basic profile fields (display name and similar). No access to messages, files, or agents.");
  assert.deepEqual(OAUTH_SCOPE_PRESENTATION.email, {
    scope: "email",
    tier: "identity",
    copyId: "oauth.scope.email.copy",
    requiresResource: false,
  });
  assert.equal(en["oauth.scope.email.copy"], "Reads your verified Raft account email address. No access to messages, files, or agents.");
  assert.deepEqual(OAUTH_SCOPE_PRESENTATION.identity, {
    scope: "identity",
    tier: "identity",
    copyId: "oauth.scope.identity.copy",
    requiresResource: false,
  });
  assert.equal(en["oauth.scope.identity.copy"], "Reads who you are — human or agent, your Raft subject, and which server/principal you're acting as. No content access.");
  assert.deepEqual(OAUTH_SCOPE_PRESENTATION["agent:event:write"], {
    scope: "agent:event:write",
    tier: "agent_messaging",
    copyId: "oauth.scope.agentEventWrite.copy",
    requiresResource: true,
  });
  assert.equal(en["oauth.scope.agentEventWrite.copy"], "Sends structured event messages to the one agent you authorize.");
  assert.deepEqual(OAUTH_SCOPE_PRESENTATION["agent:notification:write"], {
    scope: "agent:notification:write",
    tier: "agent_messaging",
    copyId: "oauth.scope.agentNotificationWrite.copy",
    requiresResource: true,
  });
  assert.equal(en["oauth.scope.agentNotificationWrite.copy"], "Sends notification messages to the one agent you authorize.");
  assert.equal(
    en[AGENT_INBOUND_NEGATIVE_CAPABILITY_ID],
    "This app cannot: send chat as you · speak as the agent · read your messages · take actions for you. It can only deliver event/notification payloads to the single agent you select.",
  );
  assert.equal(
    en[AGENT_INBOUND_CANNOT_SUMMARY_ID],
    "Cannot send chat as you, speak as the agent, read messages, or take actions.",
  );
});

test("RequestedScopeConsent renders default spacing and identity-only grant copy", () => {
  renderWithIntl(<RequestedScopeConsent scopes={["openid", "profile"]} />);

  const requested = screen.getByTestId("login-with-raft-requested-scopes");
  assert.equal(requested.classList.contains("mt-5"), true);
  assert.ok(within(requested).getByText("These scopes are the exact capabilities this Login with Raft request will grant."));
  assert.ok(within(requested).getByText("Identity"));
  assert.ok(within(requested).getByText("openid"));
  assert.ok(within(requested).getByText("profile"));
  const identityDetails = within(requested).getByText("Identity").closest("details");
  assert.ok(identityDetails);
  assert.equal(identityDetails.open, false);
  const identitySummary = identityDetails.querySelector("summary");
  assert.ok(identitySummary);
  assert.ok(within(identitySummary).getByText("— Who you are and your basic profile · no content access."));
  assert.equal(identitySummary.textContent, "Identity — Who you are and your basic profile · no content access.");
  const identityRows = identityDetails.querySelectorAll("[data-oauth-scope-row]");
  assert.equal(identityRows.length, 2);
  for (const row of identityRows) {
    assert.equal(row.classList.contains("border"), false);
    assert.equal(row.classList.contains("bg-white"), false);
  }
  assert.ok(within(requested).queryByText("Agent messaging") === null);
  assert.ok(within(requested).queryByText(enMessages["oauth.consent.agentLoginRequiredNotice"]) === null);
  assert.ok(within(requested).queryByText("No recognized Raft scopes were requested.") === null);
  assert.ok(within(requested).queryByText("Unrecognized scopes:") === null);
});

test("RequestedScopeConsent keeps the localized identity meaning visible while collapsed", () => {
  renderWithIntl(<RequestedScopeConsent scopes={["openid", "profile", "identity"]} />, { locale: "zh-cn" });

  const requested = screen.getByTestId("login-with-raft-requested-scopes");
  const identityDetails = within(requested).getByText("身份").closest("details");
  assert.ok(identityDetails);
  assert.equal(identityDetails.open, false);
  const identitySummary = identityDetails.querySelector("summary");
  assert.ok(identitySummary);
  assert.ok(within(identitySummary).getByText("—— 你是谁和你的基本资料 · 不访问内容。"));
  assert.equal(identitySummary.textContent, "身份 —— 你是谁和你的基本资料 · 不访问内容。");
});

test("RequestedScopeConsent trims and dedupes unrecognized scopes", () => {
  renderWithIntl(<RequestedScopeConsent scopes={[" unknown ", "unknown", "  agent:action_request:write  "]} className="custom-scope-card" />);

  const requested = screen.getByTestId("login-with-raft-requested-scopes");
  assert.equal(requested.className, "custom-scope-card");
  assert.ok(within(requested).getByText("Recognized capabilities are shown below. Review unrecognized requested scopes before continuing."));
  assert.ok(within(requested).getByText("No recognized Raft scopes were requested."));
  assert.ok(within(requested).getByText("Unrecognized scopes:"));
  assert.equal(within(requested).getAllByText("unknown").length, 1);
  assert.ok(within(requested).getByText("agent:action_request:write"));
  assert.ok(within(requested).queryByText(enMessages["oauth.consent.agentLoginRequiredNotice"]) === null);
  assert.ok(within(requested).queryByText("Stryker was here") === null);
});

test("RequestedScopeConsent expands only agent messaging for mixed scopes", () => {
  renderWithIntl(<RequestedScopeConsent scopes={["openid", "identity", "agent:event:write"]} />);

  const requested = screen.getByTestId("login-with-raft-requested-scopes");
  assert.ok(within(requested).getByText("Recognized capabilities are shown below. Agent messaging requires Agent Login."));
  assert.ok(within(requested).getByText("Identity"));
  assert.ok(within(requested).getByText("Agent messaging"));
  assert.ok(within(requested).getByText("agent:event:write"));
  assert.ok(within(requested).getByText("Sends structured event messages to the one agent you authorize."));
  assert.ok(within(requested).getByText(enMessages["oauth.consent.agentLoginRequiredNotice"]));
  assert.ok(within(requested).queryByText("No recognized Raft scopes were requested.") === null);
  assert.ok(within(requested).queryByText("Unrecognized scopes:") === null);

  const details = Array.from(requested.querySelectorAll("details")) as HTMLDetailsElement[];
  assert.equal(details.length, 2);
  assert.equal(
    details[0]?.querySelector("summary")?.textContent,
    "Identity — Who you are and your basic profile · no content access.",
  );
  assert.equal(details[0]?.open, false);
  assert.equal(details[1]?.querySelector("summary")?.textContent, "Agent messaging");
  assert.equal(details[1]?.open, true);
  const agentMessagingRows = details[1]?.querySelectorAll("[data-oauth-scope-row]") ?? [];
  assert.equal(agentMessagingRows.length, 1);
  assert.equal(agentMessagingRows[0]?.classList.contains("border"), false);
  assert.equal(agentMessagingRows[0]?.classList.contains("bg-white"), false);
});

test("Connected Apps loads registered surfaces without depending on the retired built-in endpoint", async () => {
  resetStores();
  const getCalls: string[] = [];

  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/integrations/clients") {
      return {
        data: [
          {
            id: "private-client",
            clientId: "private-client",
            appType: "third_party_global",
            name: "Private Reports",
            description: "Shared private reporting workflows.",
            homepageUrl: "https://reports.example.com/private",
            returnUrl: "https://reports.example.com/callback",
            logoUrl: null,
            publishStatus: "private",
            category: "Infrastructure",
            dataAccessSummary: null,
            agentManifestUrl: null,
            allowedScopes: ["openid", "profile", "identity", "agent:event:write"],
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
            installationId: "private-install",
            installStatus: "active",
          },
          {
            id: "pending-client",
            clientId: "pending-client",
            appType: "server_local",
            name: "Reviewing Reports",
            description: "Source-owned app waiting on marketplace review.",
            homepageUrl: "https://reports.example.com/reviewing",
            returnUrl: "https://reports.example.com/reviewing/callback",
            logoUrl: null,
            publishStatus: "publish_requested",
            category: "Productivity & Collaboration",
            dataAccessSummary: "Profile and report metadata.",
            agentManifestUrl: null,
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
          },
          {
            id: "published-client",
            clientId: "published-client",
            appType: "third_party_global",
            name: "Published Reports",
            description: "Source-owned published marketplace listing.",
            homepageUrl: "https://reports.example.com/published",
            returnUrl: "https://reports.example.com/published/callback",
            logoUrl: null,
            publishStatus: "published",
            category: "Productivity & Collaboration",
            dataAccessSummary: "Profile and report metadata.",
            agentManifestUrl: null,
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
            installationId: "published-install",
            installStatus: "active",
          },
          {
            id: "offline-client",
            clientId: "offline-client",
            appType: "third_party_global",
            name: "Offline Reports",
            description: "Source-owned listing waiting for offline approval.",
            homepageUrl: "https://reports.example.com/offline",
            returnUrl: "https://reports.example.com/offline/callback",
            logoUrl: null,
            publishStatus: "unpublish_requested",
            category: "Productivity & Collaboration",
            dataAccessSummary: "Profile and report metadata.",
            agentManifestUrl: null,
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
          },
        ],
      };
    }
    if (url === "/integrations/built-in") {
      throw new Error("retired built-in endpoint must not be requested");
    }
    if (url === "/integrations/marketplace") {
      return {
        data: [
          {
            id: "market-client",
            clientId: "market-client",
            official: true,
            purpose: "Publish and retrieve durable Raft artifacts.",
            name: "Marketplace Notes",
            description: "Reviewed shared notes.",
            homepageUrl: "https://notes.example.com/app",
            returnUrl: "https://notes.example.com/callback",
            logoUrl: null,
            category: "Productivity & Collaboration",
            dataAccessSummary: "Read note metadata.",
            publisherName: "Notes Inc",
            publisherServerName: "Notes Workspace",
            installedAt: "2026-06-25T00:00:00.000Z",
            marketplaceInstallBadge: { kind: "bucket", bucket: "100_plus" },
            privateShared: false,
            allowedScopes: ["openid", "profile", "identity", "agent:notification:write"],
          },
          {
            id: "published-client",
            clientId: "published-client",
            name: "Published Reports",
            description: "Source-owned published marketplace listing.",
            homepageUrl: "https://reports.example.com/published",
            returnUrl: "https://reports.example.com/published/callback",
            logoUrl: null,
            category: "Productivity & Collaboration",
            dataAccessSummary: "Profile and report metadata.",
            publisherName: "This server",
            installedAt: "2026-06-25T00:00:00.000Z",
            marketplaceInstallBadge: { kind: "new" },
            privateShared: false,
            allowedScopes: ["openid", "profile", "identity"],
          },
        ],
      };
    }
    if (url === "/integrations/overview") {
      return {
        data: [
          {
            id: "grant-1",
            type: "active",
            clientId: "market-client",
            clientKey: "market-client",
            clientName: "Marketplace Notes",
            agentName: "assistant",
            agentDisplayName: "Assistant",
            scopes: ["openid", "agent:notification:write"],
            revokedAt: null,
          },
          {
            id: "shared-client",
            clientId: "shared-client",
            name: "Shared Metrics",
            description: "Privately shared metrics dashboard.",
            homepageUrl: "https://metrics.example.com/app",
            returnUrl: "https://metrics.example.com/callback",
            logoUrl: null,
            category: "Productivity & Collaboration",
            dataAccessSummary: "Read metrics metadata.",
            publisherName: "Metrics Source",
            installedAt: "2026-06-25T00:00:00.000Z",
            privateShared: true,
          },
        ],
      };
    }
    if (url === "/integrations/clients/private-client/app-notifications") {
      return {
        data: {
          request_revision: 0,
          current_revision_id: null,
          current_groups: [],
          current_events: [],
          pending_revision: null,
          webhook: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  const sharePosts: string[] = [];
  const accidentalEditorPatches: string[] = [];
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { enabled: false } };
    if (url !== "/integrations/clients/private-client/share-links") throw new Error(`unexpected POST ${url}`);
    sharePosts.push(url);
    return { data: { client: { id: "private-client", clientId: "private-client", appType: "third_party_global",
      name: "Private Reports", publishStatus: "private", allowedScopes: ["openid", "profile"] },
      link: { id: "link-1", targetServerSlug: "target-team" }, token: "synthetic-test-token" } };
  }) as typeof api.post;
  api.patch = (async (url: string) => { accidentalEditorPatches.push(url); return { data: {} }; }) as typeof api.patch;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  // Installed is the tab the page opens on, in the grid view by default; the
  // switch at the toolbar's end turns every tab into a list, remembered.
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(screen.queryByTestId("connected-apps-built-in-band") === null);
  assert.equal(getCalls.includes("/integrations/built-in"), false);
  const viewToggle = screen.getByTestId("connected-apps-view-toggle");
  const gridViewButton = within(viewToggle).getByRole("radio", { name: "Grid view" });
  const listViewButton = within(viewToggle).getByRole("radio", { name: "List view" });
  assert.equal(gridViewButton.getAttribute("aria-checked"), "true");
  assert.ok(await within(installedTab).findByText("Marketplace Notes"));
  assert.equal(within(installedTab).getByTestId("connected-apps-installed-collection").getAttribute("data-view"), "grid");
  assert.ok(within(installedTab).queryByText("Reviewed shared notes.") === null, "a grid card has no description");
  fireEvent.click(listViewButton);
  assert.equal(listViewButton.getAttribute("aria-checked"), "true");
  assert.equal(window.localStorage.getItem("raft:connected-apps:view-mode"), "list");
  assert.equal(within(installedTab).getByTestId("connected-apps-installed-collection").getAttribute("data-view"), "list");
  assert.ok(within(installedTab).queryByText("Experimental") === null);
  assert.ok(within(installedTab).getByText("Reviewed shared notes."), "a row shows its description");
  assert.ok(within(installedTab).getByText("Private Reports"));
  assert.equal(within(installedTab).getAllByText("Published Reports").length, 1);
  // Apps v4 D3: an App built here and not installed here is under Developer only.
  assert.ok(within(installedTab).queryByText("Reviewing Reports") === null, "the uninstalled own App is not in Installed");
  assert.equal(within(installedTab).getAllByRole("button", { name: "Edit" }).length, 2);
  assert.equal(within(installedTab).getAllByRole("button", { name: "Uninstall" }).length, 1);
  fireEvent.click(within(installedTab).getByRole("button", { name: "Uninstall" }));
  const uninstallDialog = await screen.findByRole("dialog");
  assert.ok(uninstallDialog.textContent?.includes(enMessages["settings.connectedApps.uninstallOfficialOptOut"]));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.ok(within(installedTab).getAllByText("This server").length >= 1);
  assert.ok(within(installedTab).getByText("Infrastructure"));

  // The toolbar: search, then Type and Category; Sort orders only the Marketplace.
  assert.ok(screen.getByTestId("connected-apps-search"));
  assert.ok(screen.getByRole("combobox", { name: "All types" }));
  assert.ok(screen.queryByTestId("apps-filter-sort") === null);
  fireEvent.click(screen.getByRole("combobox", { name: "All categories" }));
  assert.ok(await screen.findByRole("option", { name: "All categories" }));
  for (const category of OAUTH_CLIENT_CATEGORIES) {
    // Each category value is shown as its catalog label (AI & automation).
    assert.ok(screen.getByRole("option", { name: enMessages[CONNECTED_APP_CATEGORY_LABEL_ID[category]!] }));
  }
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  fireEvent.click(screen.getByTestId("connected-apps-tab-marketplace"));
  const marketplaceCollection = await screen.findByTestId("connected-apps-marketplace-collection");
  assert.ok(within(marketplaceCollection).getByText("100+ installs"));
  assert.ok(within(marketplaceCollection).getByText("New"));
  assert.ok(within(marketplaceCollection).getByText("Reviewed shared notes."));
  assert.ok(screen.getByTestId("apps-filter-sort"), "the Marketplace has a Sort");

  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(myAppsTab).getByText("Private Reports"));
  assert.ok(within(myAppsTab).getByText("Infrastructure"));
  assert.ok(within(myAppsTab).getByText("Shared private reporting workflows."));
  assert.ok(within(myAppsTab).getByText("Reviewing Reports"));
  assert.ok(within(myAppsTab).getByText("Source-owned app waiting on marketplace review."));
  assert.ok(within(myAppsTab).getByText("Published Reports"));
  assert.ok(within(myAppsTab).getByText("Source-owned published marketplace listing."));
  assert.ok(within(myAppsTab).getByText("Offline Reports"));
  assert.ok(within(myAppsTab).getByText("Offline requested"));
  assert.ok(within(myAppsTab).getByText("Private"));
  assert.equal(within(myAppsTab).getAllByRole("button", { name: "Edit" }).length, 3);
  assert.ok(within(myAppsTab).queryByRole("button", { name: "Delete" }) === null);
  assert.ok(within(myAppsTab).queryByRole("button", { name: "Request Offline" }) === null);

  fireEvent.click(within(myAppsTab).getAllByRole("button", { name: "Edit" })[0]);
  const editor = await screen.findByTestId("connected-app-editor");
  // An existing App's logo field is its picture and Upload: no hint line (HelperText step 1, as an MCP App's).
  assert.ok(!editor.textContent?.includes("Upload a square logo"), "no logo hint once the App exists");
  // A wide centred dialog: the section list beside the scrolling sections,
  // each section's status a quiet tag beside its heading, and the commit in
  // the footer (Cancel, then the one pink button), never in the head.
  const editorNav = within(editor).getByTestId("connected-app-editor-nav");
  assert.deepEqual(
    within(editorNav).getAllByRole("button").map((button) => button.textContent),
    ["Profile", "Login with Raft", "Installation setup", "App permissions", "Webhook", "Distribution", "Danger zone"],
  );
  assert.equal(within(editorNav).getByRole("button", { name: "Profile" }).getAttribute("aria-current"), "true");
  fireEvent.click(within(editorNav).getByRole("button", { name: "Danger zone" }));
  assert.equal(within(editorNav).getByRole("button", { name: "Danger zone" }).getAttribute("aria-current"), "true");
  const sectionStatuses = () => Array.from(
    within(editor).getByTestId("connected-app-editor-content").querySelectorAll('[data-testid^="connected-app-editor-section-"]'),
  ).map((section) => [
    section.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim(),
    section.querySelector('[data-slot="form-section-status"]')?.textContent?.trim(),
  ]);
  // The Webhook status resolves ASYNCHRONOUSLY, after the editor itself
  // mounts; `waitFor` retries until it settles (it is not a sleep, and it
  // fails with the same diff if the value never becomes correct).
  await waitFor(() => {
    assert.deepEqual(sectionStatuses().map(([, status]) => status), [
      "Complete",
      "OAuth ready",
      "No setup required",
      "0 permissions selected",
      "Off",
      "Private",
      "Restricted",
    ]);
  });
  assert.deepEqual(
    sectionStatuses().map(([heading]) => heading?.replace(/Experimental$/, "")),
    ["Profile", "Login with Raft", "Installation setup", "App permissions", "Webhook", "Distribution", "Danger zone"],
  );
  const editorContent = within(editor).getByTestId("connected-app-editor-content");
  assert.deepEqual(
    Array.from(editorContent.querySelectorAll('[data-testid^="connected-app-editor-section-"]')).map((section) => section.getAttribute("data-testid")?.replace("connected-app-editor-section-", "")),
    ["profile", "login", "setup", "permissions", "notifications", "distribution", "danger"],
  );
  const editorFooter = within(editor).getByTestId("connected-app-editor-footer");
  assert.deepEqual(
    within(editorFooter).getAllByRole("button").map((button) => button.textContent),
    ["Cancel", "Save"],
  );
  const deleteCard = within(editor).getByTestId("connected-app-delete-card");
  // A plain row inside the Danger zone section, not a card inside a card.
  assert.ok(!deleteCard.classList.contains("rounded-container"));
  assert.ok(!deleteCard.classList.contains("bg-layer-card"));
  assert.ok(within(deleteCard).getByText("Delete app"));
  assert.ok(within(deleteCard).getByText("Permanently deletes this app registration and its current credentials."));
  const deleteButton = within(deleteCard).getByRole("button", { name: "Delete" });
  // The raft danger sticker: red fill, ink edge (not a red border), at the DS
  // small 32px row-action size.
  assert.equal(deleteButton.getAttribute("data-slot"), "button");
  assert.ok(deleteButton.classList.contains("bg-danger"));
  assert.ok(deleteButton.classList.contains("border-sticker-ink"));
  assert.ok(deleteButton.classList.contains("h-8"));
  assert.ok(deleteButton.classList.contains("text-control"));
  assert.equal(deleteButton.classList.contains("border-danger"), false);
  // The share controls live inside the actual editor form. Creating a link
  // must not submit the outer form or close the editor before revealing it.
  const shareTarget = within(editor).getByTestId("connected-app-share-target-input");
  fireEvent.change(shareTarget, { target: { value: "target-team" } });
  fireEvent.click(within(editor).getByTestId("connected-app-share-create-button"));
  await waitFor(() => assert.deepEqual(sharePosts, ["/integrations/clients/private-client/share-links"]));
  assert.deepEqual(accidentalEditorPatches, []);
  assert.ok(await within(editor).findByTestId("connected-app-share-created"));
  assert.ok(screen.getByTestId("connected-app-editor"));
  fireEvent.click(within(editor).getByRole("button", { name: "Close app form" }));

  fireEvent.click(screen.getByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("Marketplace Notes"));
  const privateDetail = await screen.findByText("Requestable (declared)");
  const privateModal = privateDetail.closest('[role="dialog"]');
  assert.ok(privateModal, "marketplace app detail should open in a modal card");
  assert.ok(within(privateModal as HTMLElement).getByText("100+ installs"));
  assert.ok(within(privateModal as HTMLElement).getByText("Profile"));
  assert.ok(within(privateModal as HTMLElement).getByText("Login with Raft"));
  assert.ok(within(privateModal as HTMLElement).getByText("Distribution"));
  assert.ok(within(privateModal as HTMLElement).getByText("Danger zone"));
  assert.ok(within(privateModal as HTMLElement).getByText("Scopes this app may ask for when a human or agent connects."));
  assert.equal(within(privateModal as HTMLElement).getAllByText("Declared access").length, 1);
  assert.ok(within(privateModal as HTMLElement).queryByText("Read note metadata.") === null);
  assert.ok(within(privateModal as HTMLElement).getByText("Productivity & collaboration · by Notes Workspace"));
  assert.equal(within(privateModal as HTMLElement).getAllByText("Notes Workspace").length, 1);
  assert.ok(within(privateModal as HTMLElement).queryByText("Notes Inc") === null);
  assert.ok(within(privateModal as HTMLElement).getByText("openid"));
  assert.ok(within(privateModal as HTMLElement).getByText("profile"));
  assert.ok(within(privateModal as HTMLElement).getByText("identity"));
  const notificationChip = within(privateModal as HTMLElement).getByText("agent:notification:write");
  assert.equal(notificationChip.getAttribute("title"), null);
  assert.ok(notificationChip.hasAttribute("data-base-ui-tooltip-trigger"), "scope chip description now rides the RUI tooltip trigger");
  // A scope that needs a resource is the cyan-soft (info) token chip.
  assert.ok(notificationChip.classList.contains("bg-info-soft"));
  assert.ok(within(privateModal as HTMLElement).getByRole("button", { name: "Uninstall from this server" }));
  fireEvent.click(within(privateModal as HTMLElement).getByRole("button", { name: "Close app detail" }));


  const search = screen.getByRole("searchbox", { name: "Search connected apps" });
  fireEvent.change(search, { target: { value: "Private Reports" } });
  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const filteredInstalledTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(within(filteredInstalledTab).getByText("Private Reports"));
  assert.ok(within(filteredInstalledTab).queryByText("Marketplace Notes") === null);
  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const filteredMyAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(filteredMyAppsTab).getByText("Private Reports"));
  assert.ok(within(filteredMyAppsTab).queryByText("Published Reports") === null);
});

test("Connected Apps detail modal renders cataloged zh-cn headings and App Notifications authority copy", async () => {
  resetStores();

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/marketplace") {
      return {
        data: [
          {
            id: "approved-market-client",
            clientId: "approved-market-client",
            name: "Approved Notes",
            description: "Reviewed shared notes.",
            homepageUrl: "https://notes.example.com/app",
            returnUrl: "https://notes.example.com/callback",
            logoUrl: null,
            category: "Productivity & Collaboration",
            dataAccessSummary: null,
            publisherName: "Notes Inc",
            publisherServerName: "Notes Workspace",
            installedAt: "2026-06-25T00:00:00.000Z",
            privateShared: false,
            allowedScopes: ["openid", "profile", "identity"],
            appNotificationGroups: ["server"],
            appNotificationEvents: ["server.member_added"],
            appNotificationReviewPending: false,
          },
          {
            id: "pending-market-client",
            clientId: "pending-market-client",
            name: "Pending Notes",
            description: "Review pending notes.",
            homepageUrl: "https://pending.example.com/app",
            returnUrl: "https://pending.example.com/callback",
            logoUrl: null,
            category: "Productivity & Collaboration",
            dataAccessSummary: null,
            publisherName: "Notes Inc",
            publisherServerName: "Notes Workspace",
            installedAt: null,
            privateShared: false,
            allowedScopes: ["openid", "profile"],
            appNotificationGroups: ["agent"],
            appNotificationEvents: ["agent.status_changed"],
            appNotificationReviewPending: true,
          },
        ],
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("Approved Notes"));
  const approvedModal = (await screen.findByText("可请求（已声明）")).closest('[role="dialog"]') as HTMLElement;
  assert.ok(approvedModal, "approved marketplace app detail should open in a modal card");
  assert.ok(within(approvedModal).queryByText("Permissions this app receives when installed.") === null);
  fireEvent.click(within(approvedModal).getByRole("button", { name: "关闭应用详情" }));

  fireEvent.click(await screen.findByText("Pending Notes"));
  const pendingModal = (await screen.findByText("新增的应用权限正在等待审核，原有已批准的访问保持可用。")).closest('[role="dialog"]') as HTMLElement;
  assert.ok(pendingModal, "pending marketplace app detail should open in a modal card");
});

test("Connected Apps gives members the full read surface without management actions", async () => {
  resetStores();
  const memberServer: Server = {
    ...ownerServer,
    ownerId: "server-owner",
    role: "member",
  };
  useServerStore.setState({
    servers: [memberServer],
    current: memberServer,
    members: [],
    loading: false,
  } as never);

  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/integrations/clients") {
      return {
        data: [{
          id: "member-visible-client",
          clientId: "member-visible-client",
          appType: "server_local",
          name: "Server Reports",
          description: "Reports registered by this server.",
          homepageUrl: "https://reports.example.com",
          returnUrl: "https://reports.example.com/callback",
          logoUrl: null,
          publishStatus: "private",
          category: "Productivity & Collaboration",
          dataAccessSummary: null,
          agentManifestUrl: null,
          allowedScopes: ["openid", "profile"],
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
          installationId: "member-visible-install",
          installStatus: "active",
        }],
      };
    }
    if (url === "/integrations/built-in") {
      throw new Error("retired built-in endpoint must not be requested");
    }
    if (url === "/integrations/marketplace") {
      return {
        data: [{
          id: "member-visible-listing",
          clientId: "member-visible-listing",
          name: "Marketplace Notes",
          description: "Reviewed notes app.",
          homepageUrl: "https://notes.example.com",
          returnUrl: "https://notes.example.com/callback",
          logoUrl: null,
          category: "Productivity & Collaboration",
          dataAccessSummary: "Profile metadata.",
          publisherName: "Notes Inc",
          publisherServerName: "Notes Workspace",
          installedAt: null,
          privateShared: false,
          allowedScopes: ["openid", "profile"],
        }],
      };
    }
    if (url === "/integrations/overview") return { data: [] };
    // MCP Apps are Apps too: members read their list (and see them in Installed / My apps).
    if (url === "/mcp/apps") return { data: { apps: [] } };
    // The person's own link-preview answers (the Link Previews row after the Apps).
    if (url === "/integrations/link-preview-consents") return { data: { allowed: [], declined: [] } };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  // A member reads the same page: the note says who can change it.
  assert.ok(await screen.findByTestId("apps-admin-only-note"));
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  await screen.findByText("Marketplace Notes");
  const marketplaceTab = screen.getByTestId("connected-apps-marketplace-tab");
  assert.deepEqual(new Set(getCalls), new Set([
    "/integrations/clients",
    "/integrations/link-preview-consents",
    "/integrations/marketplace",
    "/integrations/marketplace/listings",
    "/integrations/overview",
    "/mcp/apps",
  ]));
  assert.ok(within(marketplaceTab).queryByText("Raft Survey") === null);
  assert.ok(within(marketplaceTab).queryByTestId("connected-apps-built-in-band") === null);
  assert.ok(within(marketplaceTab).getByText("Marketplace Notes"));
  assert.ok(within(marketplaceTab).getByText("Available"));
  assert.ok(screen.queryByRole("button", { name: "Add app" }) === null);
  assert.ok(within(marketplaceTab).queryByText("Install", { exact: true }) === null);

  fireEvent.click(within(marketplaceTab).getByText("Marketplace Notes"));
  const detail = (await screen.findByText("Profile")).closest('[role="dialog"]');
  assert.ok(detail);
  assert.ok(within(detail as HTMLElement).getByText("Login with Raft"));
  assert.ok(within(detail as HTMLElement).getByText("Distribution"));
  assert.ok(within(detail as HTMLElement).getByRole("button", { name: "Close" }));
  assert.ok(within(detail as HTMLElement).queryByRole("button", { name: "Install to this server" }) === null);

  fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(within(installedTab).getByText("Server Reports"));
  assert.ok(within(installedTab).queryByRole("button", { name: "Edit" }) === null);
  assert.ok(within(installedTab).queryByRole("button", { name: "Uninstall" }) === null);

  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(myAppsTab).getByText("Server Reports"));
  assert.ok(within(myAppsTab).getByText("Raft Apps this server builds. Only server owners and admins can change them."));
  assert.ok(within(myAppsTab).queryByRole("button", { name: "Edit" }) === null);
  assert.ok(within(myAppsTab).queryByRole("button", { name: "Request Offline" }) === null);
  assert.ok(within(myAppsTab).queryByRole("button", { name: "Delete" }) === null);
});

test("Connected Apps edit drawer regenerates a client secret and reveals it once", async () => {
  resetStores();
  resetServerFeatureFlagsForTests();
  const client = {
    id: "private-client",
    clientId: "private-client",
    appType: "server_local",
    name: "Private Reports",
    description: "Shared private reporting workflows.",
    homepageUrl: "https://reports.example.com/private",
    returnUrl: "https://reports.example.com/callback",
    logoUrl: null,
    publishStatus: "private",
    category: "Productivity & Collaboration",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "identity"],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  const regenerateCalls: Array<{ url: string; body: unknown }> = [];

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/private-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    if (url === "/integrations/clients/private-client/regenerate-secret") {
      regenerateCalls.push({ url, body });
      return {
        data: {
          client: {
            ...client,
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
          clientSecret: "raft_secret_regenerated_once",
        },
      };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myAppsTab).getByRole("button", { name: "Edit" }));

  const regenerateButton = await screen.findByTestId("connected-app-regenerate-secret-button");
  assert.equal(regenerateButton.textContent, "Regenerate client secret");
  fireEvent.click(regenerateButton);

  const confirmButton = await screen.findByTestId("connected-app-regenerate-secret-confirm-button");
  fireEvent.click(confirmButton);

  assert.ok(await screen.findByText("raft_secret_regenerated_once"));
  assert.deepEqual(regenerateCalls, [{
    url: "/integrations/clients/private-client/regenerate-secret",
    body: undefined,
  }]);
  assert.ok(screen.getByTestId("connected-app-secret-copy-button"));
});

test("Connected Apps renders reviewed App Notifications state for developers and installers", async () => {
  resetStores();
  const developerClient = {
    id: "developer-client",
    clientId: "developer-client",
    appType: "third_party_global",
    name: "Developer Alerts",
    description: "Receives reviewed server lifecycle events.",
    homepageUrl: "https://alerts.example.com",
    returnUrl: "https://alerts.example.com/callback",
    logoUrl: null,
    publishStatus: "published",
    category: "Developer Tools",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "identity"],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  const installedClient = {
    id: "installed-client",
    clientId: "installed-client",
    name: "Installed Alerts",
    description: "Reviewed alerts from another server.",
    homepageUrl: "https://installed-alerts.example.com",
    returnUrl: "https://installed-alerts.example.com/callback",
    logoUrl: null,
    category: "Developer Tools",
    dataAccessSummary: null,
    publisherName: "Alert Publisher",
    publisherServerName: "Alert Source",
    installedAt: "2026-06-25T00:00:00.000Z",
    privateShared: false,
    allowedScopes: ["openid", "profile", "identity"],
    appNotificationGroups: ["server"],
    appNotificationEvents: ["server.plan_changed"],
    appNotificationReviewPending: false,
  };
  const developerState = {
    source_installation: { installation_id: "source-installation-1", status: "active", enabled: true,
      approved_request_revision_id: "revision-1", approved_groups: [] },
    request_revision: 2,
    current_revision_id: "revision-2",
    current_groups: [] as string[],
    current_events: [] as string[],
    pending_revision: {
      id: "revision-2",
      revision: 2,
      groups: ["server"],
      events: ["server.plan_changed"],
      created_at: "2026-07-20T00:00:00.000Z",
    },
    webhook: null as null | {
      endpoint_url: string;
      config_revision: number;
      enabled: boolean;
      previous_valid_until: null;
      updated_at: string;
    },
  };
  const installationState = {
    installation_id: "install-1",
    status: "active",
    approved_request_revision_id: "revision-1",
    requested_groups: ["agent", "server"],
    requested_events: ["agent.model_changed", "server.plan_changed"],
    requested_scopes: ["openid", "profile"],
    approved_groups: ["server"],
    subscribed_events: ["server.plan_changed"],
    effective_groups: ["server"],
    effective_events: ["server.plan_changed"],
    grant_revision: 1,
    subscription_revision: 1,
    app_review_pending: false,
    approval_required: true,
  };
  let disableWebhookCount = 0;

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [developerClient] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [installedClient] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/developer-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (url === "/integrations/clients/developer-client/app-notifications") {
      return { data: developerState };
    }
    if (url === "/integrations/marketplace/installed-client/install/app-notifications") {
      return { data: installationState };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.put = (async (url: string, body?: unknown) => {
    if (url === "/integrations/marketplace/installed-client/install/app-notifications/grant") {
      // Approving sends back exactly the set the page showed.
      assert.deepEqual(body, { expected_scopes: ["openid", "profile"], expected_groups: ["agent", "server"] });
      installationState.approved_request_revision_id = "revision-2";
      installationState.approved_groups = ["agent", "server"];
      installationState.effective_groups = ["agent", "server"];
      installationState.grant_revision = 2;
      installationState.approval_required = false;
      return { data: installationState };
    }
    if (url === "/integrations/clients/developer-client/app-notifications/webhook") {
      assert.deepEqual(body, { endpointUrl: "https://alerts.example.com/raft/events" });
      developerState.webhook = {
        endpoint_url: "https://alerts.example.com/raft/events",
        config_revision: 1,
        enabled: true,
        previous_valid_until: null,
        updated_at: "2026-07-20T00:01:00.000Z",
      };
      return {
        data: {
          endpoint_url: developerState.webhook.endpoint_url,
          config_revision: 1,
          enabled: true,
          signing_secret: "raft_webhook_secret_shown_once",
        },
      };
    }
    throw new Error(`unexpected PUT ${url}`);
  }) as typeof api.put;
  api.delete = (async (url: string) => {
    assert.equal(url, "/integrations/clients/developer-client/app-notifications/webhook");
    disableWebhookCount += 1;
    developerState.webhook = null;
    return { data: { success: true } };
  }) as typeof api.delete;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByRole("button", { name: /Installed Alerts/ }));
  const installSummary = await screen.findByTestId("app-notifications-request-summary");
  assert.ok(within(installSummary).getByText("Server · read"));
  assert.ok(within(installSummary).getByText("Plan status changed"));
  assert.ok(within(installSummary).queryByRole("checkbox") === null);
  fireEvent.click(screen.getByRole("button", { name: "Close app detail" }));

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  const editor = await screen.findByTestId("connected-app-editor");
  const notificationsSection = within(editor).getByTestId("connected-app-editor-section-notifications");
  // The Webhook section's status tag (beside its heading).
  const notificationsRailButton = notificationsSection.querySelector<HTMLElement>('[data-slot="form-section-status"]')!;
  const developerPanel = await screen.findByTestId("developer-app-notifications");
  const appPermissionsPanel = within(editor).getByTestId("developer-app-permissions");
  const sourceInstallation = within(appPermissionsPanel).getByTestId("app-notifications-source-installation");
  const installationInput = within(sourceInstallation).getByRole("textbox", { name: "Installation ID" }) as HTMLInputElement;
  assert.equal(installationInput.value, "source-installation-1");
  fireEvent.focus(installationInput);
  assert.equal(installationInput.selectionStart, 0);
  assert.equal(installationInput.selectionEnd, installationInput.value.length);
  assert.ok(within(sourceInstallation).getByText("Installed", { exact: true }));
  assert.ok(within(developerPanel).getByText("Pending app review"));
  assert.ok(within(developerPanel).getByTestId("app-notifications-delivery"));
  assert.match(notificationsRailButton.textContent ?? "", /Off/);
  assert.ok(within(notificationsSection).getByText("Off", { exact: true }));
  assert.ok(within(developerPanel).queryByTestId("app-notifications-permissions") === null);
  // Sending events needs an endpoint first: a checkbox, the endpoint under it
  // and one Save for both. Checking it only opens the draft.
  const enableBox = within(developerPanel).getByRole("checkbox", { name: "Enable webhook" });
  assert.equal(enableBox.getAttribute("aria-checked"), "false");
  assert.ok(within(developerPanel).queryByRole("switch") === null);
  assert.ok(within(developerPanel).queryByTestId("app-notifications-permission-picker") === null);
  assert.ok(within(developerPanel).queryByPlaceholderText("https://example.com/raft/events") === null);
  fireEvent.click(enableBox);
  assert.match(notificationsRailButton.textContent ?? "", /Setup/);
  assert.ok(within(notificationsSection).getByText("Setup", { exact: true }));
  assert.ok(within(developerPanel).getByTestId("app-notifications-permissions"));
  assert.ok(within(developerPanel).getByText("Revision 2 is pending App Review. Current approved permissions remain active until review completes."));
  assert.ok(within(developerPanel).getByText("Plan status changed"));
  const saveButton = within(developerPanel).getByTestId("app-notifications-save") as HTMLButtonElement;
  assert.equal(saveButton.textContent, "Save");
  assert.equal(saveButton.disabled, true, "nothing to save until there is an endpoint");
  fireEvent.change(within(developerPanel).getByPlaceholderText("https://example.com/raft/events"), {
    target: { value: "https://alerts.example.com/raft/events" },
  });
  assert.equal(saveButton.disabled, false);
  fireEvent.click(saveButton);
  assert.ok(await within(developerPanel).findByText("raft_webhook_secret_shown_once"));
  assert.ok(within(developerPanel).getByText("Signing secret · shown once"));
  await waitFor(() => {
    const currentBox = within(developerPanel).getByRole("checkbox", { name: "Enable webhook" });
    assert.equal(currentBox.getAttribute("aria-checked"), "true");
    assert.equal(currentBox.hasAttribute("data-disabled"), false);
    assert.match(notificationsRailButton.textContent ?? "", /Enabled/);
    assert.ok(within(notificationsSection).getByText("Enabled", { exact: true }));
  });
  // Unchecking stops nothing by itself: deliveries stop once it is saved.
  fireEvent.click(within(developerPanel).getByRole("checkbox", { name: "Enable webhook" }));
  assert.equal(disableWebhookCount, 0);
  assert.ok(within(developerPanel).queryByTestId("app-notifications-configuration") === null);
  assert.ok(within(developerPanel).getByTestId("app-notifications-disable-pending"));
  assert.match(notificationsRailButton.textContent ?? "", /Enabled/);
  await act(async () => {
    fireEvent.click(within(developerPanel).getByTestId("app-notifications-save"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(disableWebhookCount, 1);
  await waitFor(() => assert.match(notificationsRailButton.textContent ?? "", /Off/));
  assert.ok(within(notificationsSection).getByText("Off", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Close app form" }));

  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(within(installedTab).queryByRole("button", { name: /App notifications/ }) === null);
  const installedDetailsTrigger = within(installedTab).getByRole("button", { name: "Installed Alerts" });
  assert.equal(installedDetailsTrigger.getAttribute("tabindex"), "0");
  installedDetailsTrigger.focus();
  assert.ok(document.activeElement === installedDetailsTrigger);
  fireEvent.keyDown(installedDetailsTrigger, { key: "Enter" });
  let installedPanel = await screen.findByTestId("installed-app-notifications");
  assert.ok(within(installedPanel).getByText("Approved data"));
  fireEvent.click(screen.getByRole("button", { name: "Close installed app details" }));
  fireEvent.keyDown(installedDetailsTrigger, { key: " " });
  installedPanel = await screen.findByTestId("installed-app-notifications");
  assert.ok(within(installedPanel).getByText("Approved data"));
  assert.ok(within(installedPanel).getByText("Developer subscriptions"));
  assert.ok(within(installedPanel).getByText("Active events"));
  assert.equal(within(installedPanel).getAllByText("Plan status changed").length, 2);
  assert.ok(within(installedPanel).queryByRole("checkbox") === null);
  assert.ok(within(installedPanel).queryByText("Manage server approval") === null);
  // No summary of the permission model under the heading (HelperText step 1); the approval banner below names the consequence.
  assert.ok(!installedPanel.textContent?.includes("independent of user login"), installedPanel.textContent ?? "");
  const approvalBanner = within(installedPanel).getByTestId("app-notifications-approval-required");
  assert.ok(within(approvalBanner).getByText("This app requests new access. Review it before approving the update; until then it keeps the access you approved."));
  // The banner lists the whole set Approve Update sends back,
  // the groups and login scopes, with only the additions marked New.
  const approvalSet = within(approvalBanner).getByTestId("app-permission-set");
  const groupRow = (group: string) => approvalSet.querySelector(`[data-app-permission-kind="group"][data-app-permission-value="${group}"]`);
  const agentRow = groupRow("agent");
  const serverRow = groupRow("server");
  assert.ok(agentRow !== null && serverRow !== null);
  assert.ok(within(agentRow as HTMLElement).getByText("Agent · read"));
  assert.ok(within(agentRow as HTMLElement).getByText("New in this update"));
  assert.ok(within(serverRow as HTMLElement).getByText("Server · read"));
  assert.ok(within(serverRow as HTMLElement).queryByText("New in this update") === null);
  assert.ok(approvalSet.querySelector('[data-app-permission-kind="scope"][data-app-permission-value="openid"]') !== null);
  assert.ok(approvalSet.querySelector('[data-app-permission-kind="scope"][data-app-permission-value="profile"]') !== null);
  fireEvent.click(within(installedPanel).getByRole("button", { name: "Approve update" }));
  await waitFor(() => assert.ok(within(installedPanel).queryByRole("button", { name: "Approve update" }) === null));
  fireEvent.click(screen.getByRole("button", { name: "Close installed app details" }));
  fireEvent.click(within(installedTab).getByRole("button", { name: "Uninstall" }));
  assert.ok(await screen.findByText("Uninstall Installed Alerts?"));
  assert.ok(screen.queryByTestId("installed-app-notifications") === null);
});

test("Connected Apps saves category and declared scopes before requesting marketplace review", async () => {
  resetStores();
  const client = {
    id: "publish-client",
    clientId: "publish-client",
    appType: "server_local",
    name: "Storage Publisher",
    description: "Publishes stored reports.",
    homepageUrl: "https://storage.example.com",
    returnUrl: "https://storage.example.com/callback",
    logoUrl: null,
    publishStatus: "private",
    category: "Infrastructure",
    dataAccessSummary: "Legacy free-text that must not be rendered or resubmitted.",
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "agent:event:write"],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  const patchBodies: unknown[] = [];
  const postCalls: Array<{ url: string; body: unknown }> = [];

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/publish-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = (async (url: string, body: unknown) => {
    assert.equal(url, "/integrations/clients/publish-client");
    patchBodies.push(body);
    return { data: client };
  }) as typeof api.patch;
  api.post = (async (url: string, body?: unknown) => {
    // The editor reads this Server's feature flags; not part of the flow under test.
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postCalls.push({ url, body });
    return { data: { ...client, publishStatus: "publish_requested", dataAccessSummary: null } };
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  assert.ok(screen.queryByText("Declared data access") === null);
  assert.ok(screen.queryByText("Legacy free-text that must not be rendered or resubmitted.") === null);
  assert.ok(screen.getByText("Category and data access come from the app metadata and declared scopes above. Requesting review saves those changes first."));

  fireEvent.click(screen.getByRole("button", { name: "Request publish" }));
  await waitFor(() => assert.equal(postCalls.length, 1));
  assert.deepEqual(patchBodies, [{
    name: "Storage Publisher",
    description: "Publishes stored reports.",
    homepageUrl: "https://storage.example.com",
    returnUrl: "https://storage.example.com/callback",
    agentManifestUrl: null,
    whenToUse: null,
    allowedScopes: ["openid", "profile", "agent:event:write"],
    category: "Infrastructure",
    enableBot: false,
  }]);
  assert.deepEqual(postCalls, [{ url: "/integrations/clients/publish-client/request-publish", body: undefined }]);
});

test("Connected Apps withdraws a publish request still waiting for review, keeping the app", async () => {
  resetStores();
  const client = {
    id: "pending-client",
    clientId: "pending-client",
    appType: "server_local",
    name: "Pending Publisher",
    description: "Waits for marketplace review.",
    homepageUrl: "https://pending.example.com",
    returnUrl: "https://pending.example.com/callback",
    logoUrl: null,
    publishStatus: "publish_requested",
    category: "Infrastructure",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile"],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
  const postCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    throw { response: { status: 404, data: { error: "not found" } } };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postCalls.push(url);
    return { data: { ...client, publishStatus: "private" } };
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  const card = await screen.findByTestId("connected-app-withdraw-publish-card");
  assert.ok(within(card).getByText("Withdrawing returns the app to private. Its registration, credentials and installations stay, and you can request review again later."));

  fireEvent.click(within(card).getByRole("button", { name: "Withdraw request" }));
  await waitFor(() => assert.deepEqual(postCalls, ["/integrations/clients/pending-client/withdraw-publish"]));
  await waitFor(() => assert.ok(screen.queryByTestId("connected-app-withdraw-publish-card") === null));
  assert.ok(screen.getByRole("button", { name: "Request publish" }), "the app can request review again");
});

test("Connected Apps register form locks identity scopes and toggles agent messaging declarations", async () => {
  resetStores();
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await chooseRegisterAppMenuItem("own-service");
  const newAppEditor = screen.getByTestId("connected-app-editor");
  assert.equal(
    within(newAppEditor).getByTestId("connected-app-editor-section-notifications").querySelector('[data-slot="form-section-status"]')?.textContent,
    "Save app first",
  );
  // Sharing, publishing and lifecycle act on a saved app: a new app's form
  // stops at what can be filled in now.
  assert.ok(within(newAppEditor).queryByTestId("connected-app-editor-section-distribution") === null);
  assert.ok(within(newAppEditor).queryByTestId("connected-app-editor-section-danger") === null);
  assert.deepEqual(
    within(within(newAppEditor).getByTestId("connected-app-editor-footer")).getAllByRole("button").map((button) => button.textContent),
    ["Cancel", "Create"],
  );
  const picker = await screen.findByTestId("connected-app-declared-scopes");
  assert.ok(within(picker).getByText("Identity"));
  assert.ok(within(picker).getByText("openid"));
  assert.ok(within(picker).getByText("profile"));
  assert.ok(within(picker).getByText("identity"));
  const emailScope = within(picker).getByRole("checkbox", { name: "email" });
  assert.equal(emailScope.getAttribute("aria-checked"), "false");
  fireEvent.click(emailScope);
  assert.equal(emailScope.getAttribute("aria-checked"), "true");
  assert.ok(within(picker).getByText("Agent messaging"));
  assert.ok(within(picker).getByRole("checkbox", { name: "agent:event:write" }));
  assert.ok(within(picker).getByRole("checkbox", { name: "agent:notification:write" }));
  assert.ok(within(picker).queryByText("The user chooses the target agent when authorizing.") === null);

  fireEvent.click(within(picker).getByRole("checkbox", { name: "agent:event:write" }));
  assert.ok(await within(picker).findByText("The user chooses the target agent when authorizing."));

  fireEvent.click(within(picker).getByRole("checkbox", { name: "agent:notification:write" }));
  assert.ok(within(picker).getByText("The user chooses the target agent when authorizing."));

  fireEvent.click(within(picker).getByRole("checkbox", { name: "agent:event:write" }));
  assert.ok(within(picker).getByText("The user chooses the target agent when authorizing."));

  fireEvent.click(within(picker).getByRole("checkbox", { name: "agent:notification:write" }));
  assert.ok(within(picker).queryByText("The user chooses the target agent when authorizing.") === null);
});

test("Connected Apps creates Agent read without webhook and retries permission failure without duplicating the app", async () => {
  resetStores();
  const createdClient = {
    id: "created-client",
    clientId: "created-client",
    appType: "server_local",
    name: "Created Alerts",
    description: null,
    homepageUrl: null,
    returnUrl: null,
    logoUrl: null,
    publishStatus: "private",
    category: "Other",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "identity"],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  let createCount = 0;
  let permissionCount = 0;
  let patchCount = 0;

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: createCount ? [createdClient] : [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/created-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (url === "/integrations/clients/created-client/app-notifications") {
      return {
        data: {
          request_revision: 0,
          current_revision_id: null,
          current_groups: [],
          current_events: [],
          pending_revision: null,
          webhook: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/integrations/clients");
    assert.deepEqual((body as { allowedScopes: string[] }).allowedScopes, ["openid", "profile", "identity"]);
    createCount += 1;
    return { data: { client: createdClient, clientSecret: "raft_secret_create_once" } };
  }) as typeof api.post;
  api.patch = (async (url: string) => {
    assert.equal(url, "/integrations/clients/created-client");
    patchCount += 1;
    return { data: createdClient };
  }) as typeof api.patch;
  api.put = (async (url: string, body?: unknown) => {
    assert.equal(url, "/integrations/clients/created-client/app-notifications/permissions");
    assert.deepEqual(body, { groups: ["agent"], events: [] });
    permissionCount += 1;
    if (permissionCount === 1) {
      throw { response: { data: { error: "permission write failed" } } };
    }
    return { data: { state: "active" } };
  }) as typeof api.put;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await chooseRegisterAppMenuItem("own-service");
  fireEvent.change(screen.getByPlaceholderText("db9 Cloud Drive"), { target: { value: "Created Alerts" } });
  const registrationPanel = screen.getByTestId("developer-app-notifications");
  const unavailableSwitch = within(registrationPanel).getByRole("checkbox", { name: "Enable webhook" });
  assert.equal(unavailableSwitch.hasAttribute("data-disabled"), true);
  assert.ok(within(registrationPanel).getByText("Save the app before enabling its webhook."));
  assert.ok(within(registrationPanel).queryByTestId("app-notifications-permission-picker") === null);
  const permissionPanel = screen.getByTestId("developer-app-permissions");
  fireEvent.click(within(permissionPanel).getByRole("combobox", { name: "Agent · read" }));
  fireEvent.pointerDown(screen.getByRole("option", { name: "Read-only" }), { pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option", { name: "Read-only" }));
  const registrationForm = registrationPanel.closest("form");
  assert.ok(registrationForm);
  fireEvent.click(within(registrationForm).getByRole("button", { name: "Create" }));

  assert.ok(await screen.findByText("permission write failed"));
  assert.ok(screen.getByText("raft_secret_create_once"));
  assert.equal(createCount, 1);
  assert.equal(permissionCount, 1);

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(permissionCount, 2));
  assert.equal(createCount, 1);
  assert.equal(patchCount, 1);
  assert.ok(screen.getByText("raft_secret_create_once"));
});

test("Login with Raft setup page renders fetched app identity details", async () => {
  resetStores();
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn&state=setup-state");

  api.get = (async (url: string) => {
    if (url === "/oauth/clients/lookup") {
      return {
        data: {
          clientId: "orbital-notes",
          appType: "third_party_global",
          name: "Orbital Notes",
          description: "Review launch notes from Raft.",
          homepageUrl: "https://orbital.example.com/docs",
          returnUrl: "https://orbital.example.com/return",
          logoUrl: "https://cdn.example.com/orbital-notes.png",
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  const raftLogo = document.querySelector('img[src="/brand/raft-logo.svg"]');
  assert.equal(raftLogo?.getAttribute("aria-hidden"), "true");
  assert.equal(raftLogo?.closest('[aria-label="Raft"]') !== null, true);
  const darkModeLogo = raftLogo?.closest("picture")?.querySelector("source");
  assert.equal(darkModeLogo?.getAttribute("srcset"), "/brand/raft-logo-mono-light.svg");
  assert.equal(darkModeLogo?.getAttribute("media"), "(prefers-color-scheme: dark)");
  // "Login with [Raft]": the logo is an image named Raft, read as the sentence's last word.
  const lockup = within(screen.getByRole("banner")).getByRole("img", { name: "Raft" });
  const heading = screen.getByTestId("login-setup-heading");
  assert.equal([...heading.childNodes].map((node) => (node === lockup ? "Raft" : node.textContent?.trim())).join(" "), "Login with Raft");
  assert.ok(screen.queryByText("Experimental") === null);

  assert.ok((await screen.findAllByText("Orbital Notes")).length >= 2);
  const description = screen.getByText("Review launch notes from Raft.");
  assert.equal(description.getAttribute("class"), "text-footnote text-foreground-muted");
  assert.ok(screen.queryByText("https://orbital.example.com/docs") === null);
  const detailLink = screen.getByRole("link", { name: "Open Orbital Notes (opens in a new tab)" });
  assert.equal(detailLink.getAttribute("href"), "https://orbital.example.com/docs");
  assert.equal(detailLink.getAttribute("target"), "_blank");
  assert.equal(detailLink.getAttribute("rel"), "noopener noreferrer");
  assert.equal(detailLink.querySelector("svg.lucide-arrow-up-right")?.classList.contains("text-foreground-hint"), true, "↗ at the card's top right");
  assert.equal(detailLink.getAttribute("title"), null);
  // A readable clickable card: the subtle tier on hover, no lift or shadow (DS).
  assert.equal(detailLink.classList.contains("hover:overlay-subtle"), true);
  assert.equal(detailLink.classList.contains("hover:shadow-raft-md"), false);

  const logo = document.querySelector('img[src="https://cdn.example.com/orbital-notes.png"]');
  assert.equal(logo?.getAttribute("class"), "relative z-raised h-full w-full object-cover");

  const loginButton = screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(loginButton.disabled, false));
  assert.equal(loginButton.getAttribute("data-slot"), "button");
  // The solid accent call to action (raft sticker), not a soft fill.
  assert.ok(loginButton.classList.contains("bg-attention-400"));
  assert.ok(loginButton.classList.contains("border-sticker-ink"));
  assert.equal(loginButton.classList.contains("bg-brand-soft"), false);
  assert.ok(document.querySelector('button img[src="/brand/raft-logo.svg"]') === null);
  assert.ok(document.querySelector('button source[srcset="/brand/raft-logo-mono-light.svg"]') === null);
  assert.equal(loginButton.parentElement?.classList.contains("justify-end"), true);

  const backLink = screen.getByRole("link", { name: "Back" });
  // A real link drawn as the DS ghost button: no underline, no frame.
  assert.equal(backLink.getAttribute("href"), "/");
  assert.equal(backLink.classList.contains("hover:bg-fill-medium"), true);
  assert.equal(backLink.classList.contains("underline"), false);
  const logoutButton = screen.getByRole("button", { name: "Sign out" });
  assert.equal(logoutButton.getAttribute("data-slot"), "button");

  api.post = (async () => new Promise(() => {})) as typeof api.post;
  fireEvent.click(screen.getByRole("button", { name: "Login with Raft" }));
  // raft-ui Button `loading`: the spinner, named by what is happening.
  await waitFor(() => assert.equal(loginButton.getAttribute("data-loading"), "true"));
  assert.equal(loginButton.querySelector("[data-slot=button-loading-indicator] [role=status]")?.getAttribute("aria-label"), "Continuing...");
});

test("standard OIDC setup preserves redirect, state, nonce, PKCE, and email scope at consent", async () => {
  resetStores();
  const otherServer = { ...ownerServer, id: "server-2", slug: "other", name: "Other Server" };
  useServerStore.setState({ servers: [ownerServer, otherServer] } as never);
  const redirectUri = "https://open-webui.example.test/oauth/oidc/callback";
  const params = new URLSearchParams({
    flow: "oidc",
    client_id: "open-webui",
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state: "oidc-state",
    nonce: "oidc-nonce",
    code_challenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN012",
    code_challenge_method: "S256",
    server: ownerServer.slug,
  });
  window.history.pushState({}, "", `/login-with-raft/setup?${params}`);

  const lookupServerIds: string[] = [];
  api.get = (async (url: string, config?: { params?: { server_id?: string; scope?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    lookupServerIds.push(config?.params?.server_id ?? "");
    assert.equal(config?.params?.server_id, ownerServer.id);
    assert.equal(config?.params?.scope, "openid profile email");
    return {
      data: {
        clientId: "open-webui",
        appType: "server_local",
        name: "Open WebUI",
        description: "OIDC client",
        homepageUrl: "https://open-webui.example.test",
        returnUrl: redirectUri,
        logoUrl: null,
        allowedScopes: ["openid", "profile", "email"],
        scopeValidation: { allowed: true, reason: null, disallowedScopes: [] },
      },
    };
  }) as typeof api.get;

  let postedBody: Record<string, unknown> | null = null;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/oauth/authorize/human");
    postedBody = body as Record<string, unknown>;
    return new Promise(() => {});
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);
  assert.ok((await screen.findAllByText("Open WebUI")).length >= 2);
  assert.deepEqual(lookupServerIds, [ownerServer.id]);
  assert.ok(screen.getByText("email"));
  assert.ok(screen.getByText("Reads your verified Raft account email address. No access to messages, files, or agents."));
  fireEvent.click(screen.getByRole("button", { name: "Login with Raft" }));
  await waitFor(() => assert.ok(postedBody));
  assert.deepEqual(postedBody, {
    clientId: "open-webui",
    serverId: ownerServer.id,
    returnUrl: redirectUri,
    scopes: ["openid", "profile", "email"],
    oidc: true,
    nonce: "oidc-nonce",
    codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN012",
    codeChallengeMethod: "S256",
    server: ownerServer.slug,
  });
});

test("standard OIDC setup explains client-disallowed scopes before authorization", async () => {
  resetStores();
  const redirectUri = "https://open-webui.example.test/oauth/oidc/callback";
  const params = new URLSearchParams({
    flow: "oidc",
    client_id: "open-webui",
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state: "oidc-state",
    nonce: "oidc-nonce",
    server: ownerServer.slug,
  });
  window.history.pushState({}, "", `/login-with-raft/setup?${params}`);

  api.get = (async (url: string, config?: { params?: { scope?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    assert.equal(config?.params?.scope, "openid profile email");
    return {
      data: {
        clientId: "open-webui",
        appType: "server_local",
        name: "Open WebUI",
        description: "OIDC client",
        homepageUrl: "https://open-webui.example.test",
        returnUrl: redirectUri,
        logoUrl: null,
        allowedScopes: ["openid", "profile"],
        scopeValidation: { allowed: false, reason: "not_allowed", disallowedScopes: ["email"] },
      },
    };
  }) as typeof api.get;

  let postCount = 0;
  api.post = (async () => {
    postCount += 1;
    throw new Error("authorization must be blocked before POST");
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  assert.ok((await screen.findAllByText("Open WebUI")).length >= 2);
  const alert = screen.getByTestId("oauth-scope-configuration-error");
  assert.ok(within(alert).getByText("OAuth client permissions need attention"));
  assert.ok(within(alert).getByText("Open WebUI is requesting access it has not been granted: email. Ask the app owner to add these scopes to the OAuth client before trying again."));
  const loginButton = screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  assert.equal(loginButton.disabled, true);
  fireEvent.click(loginButton);
  assert.equal(postCount, 0);
});

test("an unapproved openid refusal goes back to the app's registered callback with invalid_scope and state", () => {
  const callback = "https://vault.example.test/oauth/callback?source=raft";
  const url = authorizationErrorRedirectUrl({
    error: "invalid_scope",
    errorCode: "OAUTH_SCOPE_NOT_APPROVED",
    error_description: "This Server's admin has not approved these scopes for the app: openid.",
    unapprovedScopes: ["openid"],
    returnUrl: callback,
  }, "oidc-state");
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, "https://vault.example.test/oauth/callback");
  assert.equal(parsed.searchParams.get("source"), "raft");
  assert.equal(parsed.searchParams.get("error"), "invalid_scope");
  assert.equal(parsed.searchParams.get("error_description"), "This Server's admin has not approved these scopes for the app: openid.");
  assert.equal(parsed.searchParams.get("state"), "oidc-state");
  assert.equal(parsed.searchParams.has("code"), false);
  // Every other refusal stays on Raft's page, and an unsafe callback never navigates.
  for (const body of [
    { error: "invalid_scope", errorCode: "OAUTH_SCOPE_NOT_ALLOWED", returnUrl: callback },
    { error: "installation_suspended", errorCode: "OAUTH_INSTALLATION_SUSPENDED" },
    { errorCode: "OAUTH_SCOPE_NOT_APPROVED", returnUrl: null },
    { errorCode: "OAUTH_SCOPE_NOT_APPROVED", returnUrl: "javascript:alert(1)" },
    null,
    "invalid_scope",
  ]) {
    assert.equal(authorizationErrorRedirectUrl(body, "oidc-state"), null, JSON.stringify(body));
  }
});

test("Login with Raft shows a suspended installation as unavailable with its reason, and never continues there", async () => {
  resetStores();
  const suspendedServer: Server = { ...ownerServer, id: "server-2", name: "Paused Server", slug: "paused", role: "member" };
  useServerStore.setState({ servers: [ownerServer, suspendedServer], current: ownerServer, members: [], loading: false } as never);
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");
  const baseClient = {
    id: "app-1",
    clientId: "orbital-notes",
    appType: "third_party_global",
    name: "Orbital Notes",
    description: "Review launch notes from Raft.",
    homepageUrl: "https://orbital.example.com/docs",
    returnUrl: "https://orbital.example.com/return",
    logoUrl: null,
  };
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    return config?.params?.server_id === suspendedServer.id
      ? { data: { ...baseClient, availability: "suspended" } }
      : { data: { ...baseClient, marketplace: true, availability: "ready" } };
  }) as typeof api.get;
  const postUrls: string[] = [];
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postUrls.push(url);
    return new Promise(() => {});
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);
  assert.ok((await screen.findAllByText("Orbital Notes")).length >= 2);
  const ready = screen.getByTestId("login-server-status-server-1");
  assert.equal(ready.hasAttribute("data-selected"), true, "the ready Server ranks first");
  const suspended = screen.getByTestId("login-server-status-server-2");
  assert.ok(within(suspended).getByText("Suspended"));
  fireEvent.click(suspended);
  const commitZone = screen.getByTestId("marketplace-login-commit-zone");
  assert.match(commitZone.textContent ?? "", /installation on this Server is suspended/);
  const continueButton = screen.getByRole("button", { name: "Continue login" }) as HTMLButtonElement;
  assert.equal(continueButton.disabled, true);
  fireEvent.click(continueButton);
  assert.deepEqual(postUrls, []);
});

test("Login with Raft explains a suspension when it is the app's only Server, instead of calling the app inaccessible", async () => {
  resetStores();
  useServerStore.setState({ servers: [ownerServer], current: ownerServer, members: [], loading: false } as never);
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=private-notes&return_to=https%3A%2F%2Fnotes.example.com%2Freturn");
  api.get = (async (url: string) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    return {
      data: {
        clientId: "private-notes",
        appType: "third_party_global",
        name: "Private Notes",
        description: null,
        homepageUrl: null,
        returnUrl: "https://notes.example.com/return",
        logoUrl: null,
        availability: "suspended",
      },
    };
  }) as typeof api.get;
  let postCount = 0;
  api.post = (async () => {
    postCount += 1;
    throw new Error("authorization must not be attempted");
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);
  assert.ok(await screen.findByText("This App's installation on this Server is suspended. Ask a Server owner or admin to restore it."));
  assert.ok(screen.queryByText("This app isn't available to you") === null);
  const loginButton = screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  assert.equal(loginButton.disabled, true);
  fireEvent.click(loginButton);
  assert.equal(postCount, 0);
});

test("public Marketplace setup always lists installed and uninstalled Servers together", async () => {
  resetStores();
  const adminServer: Server = {
    ...ownerServer,
    id: "server-2",
    name: "Build Server",
    slug: "build",
    role: "admin",
  };
  const memberServer: Server = {
    ...ownerServer,
    id: "server-3",
    name: "Member Server",
    slug: "member",
    role: "member",
  };
  const unavailableServer: Server = {
    ...ownerServer,
    id: "server-4",
    name: "Temporarily Unavailable Server",
    slug: "unavailable",
  };
  const extraServers: Server[] = Array.from({ length: 18 }, (_, offset) => offset + 5).map((index) => ({
    ...ownerServer,
    id: `server-${index}`,
    name: `Extra Server ${index}`,
    slug: `extra-${index}`,
    role: "member",
  }));
  useServerStore.setState({
    servers: [ownerServer, adminServer, memberServer, unavailableServer, ...extraServers],
    current: ownerServer,
    members: [],
    loading: false,
  } as never);
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");

  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    const serverId = config?.params?.server_id;
    const baseClient = {
      id: "app-1",
      clientId: "orbital-notes",
      appType: "third_party_global",
      name: "Orbital Notes",
      description: "Review launch notes from Raft.",
      homepageUrl: "https://orbital.example.com/docs",
      returnUrl: "https://orbital.example.com/return",
      logoUrl: null,
      marketplace: true,
    };
    if (serverId === ownerServer.id) {
      return { data: { ...baseClient, availability: "ready" } };
    }
    if (serverId === unavailableServer.id) {
      throw new Error("lookup temporarily unavailable");
    }
    return {
      data: {
        ...baseClient,
        allowedScopes: ["openid", "profile", "email"],
        appNotificationGroups: ["channel"],
        availability: "install_required",
        installation: { serverId, canInstall: serverId === adminServer.id },
      },
    };
  }) as typeof api.get;
  const postUrls: string[] = [];
  const installBodies: unknown[] = [];
  let resolveInstall!: () => void;
  const pendingInstall = new Promise<{ data: { installed: true } }>((resolve) => {
    resolveInstall = () => resolve({ data: { installed: true } });
  });
  api.post = (async (url: string, body?: unknown) => {
    // The page reads the install target's feature flags; not part of the flow under test.
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postUrls.push(url);
    if (url === "/integrations/marketplace/app-1/install") {
      installBodies.push(body);
      return pendingInstall;
    }
    if (url === "/oauth/authorize/human") {
      throw new Error("stop after proving install-to-authorize chaining");
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  assert.ok((await screen.findAllByText("Orbital Notes")).length >= 2);
  assert.ok(screen.getByText("Marketplace"));
  const installed = screen.getByTestId("login-server-status-server-1");
  assert.equal(installed.getAttribute("title"), null);
  assert.ok(installed.hasAttribute("data-base-ui-tooltip-trigger"), "status hint now rides the RUI tooltip trigger");
  assert.ok(within(installed).queryByText("Installed") === null);
  assert.equal(installed.getAttribute("aria-label"), "Use this server: Launch Server");
  // The picked server is the raft-ui ListRow selection (cyan-soft).
  assert.equal(installed.hasAttribute("data-selected"), true);
  assert.match(screen.getByTestId("marketplace-login-commit-zone").textContent ?? "", /Selected Launch Server\./);
  assert.ok(screen.getByRole("button", { name: "Continue login" }));
  const installable = screen.getByTestId("login-server-status-server-2");
  assert.equal(installable.getAttribute("title"), null);
  assert.ok(installable.hasAttribute("data-base-ui-tooltip-trigger"), "status hint now rides the RUI tooltip trigger");
  assert.ok(within(installable).getByText("Not installed"));
  fireEvent.click(installable);
  assert.equal(installed.hasAttribute("data-selected"), false);
  assert.equal(installable.hasAttribute("data-selected"), true);
  // Whether it can be installed, never the viewer's role (copy item 6, #proj-apps msg e9b17287).
  const commitZoneText = screen.getByTestId("marketplace-login-commit-zone").textContent ?? "";
  assert.match(commitZoneText, /Build Server hasn't installed Orbital Notes\. You can install it here; continuing installs it as you\./);
  assert.doesNotMatch(commitZoneText, /admin/i);
  // The commit zone lists what installing approves: the app's whole set,
  // email and the channel group included, not just this login's scopes.
  const commitSet = within(screen.getByTestId("marketplace-login-commit-zone")).getByTestId("app-permission-set");
  assert.deepEqual(
    [...commitSet.querySelectorAll("[data-app-permission-value]")].map((row) => row.getAttribute("data-app-permission-value")),
    ["openid", "profile", "email", "channel"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Install and continue" }));
  await waitFor(() => assert.deepEqual(postUrls, ["/integrations/marketplace/app-1/install"]));
  // Installing approves the app's whole set, not just the scopes this login asks for.
  assert.deepEqual(installBodies, [{ expected_scopes: ["openid", "profile", "email"], expected_groups: ["channel"] }]);
  const pendingCommitZone = screen.getByTestId("marketplace-login-commit-zone");
  assert.equal(pendingCommitZone.getAttribute("aria-busy"), "true");
  const pendingButton = screen.getByTestId("marketplace-login-commit") as HTMLButtonElement;
  // raft-ui 0.58.1: busy is aria-disabled (it keeps focus), never native disabled; a press does nothing.
  assert.equal(pendingButton.getAttribute("aria-disabled"), "true");
  assert.equal(pendingButton.disabled, false);
  assert.ok(screen.getByTestId("marketplace-install-pending-row-spinner"));
  // raft-ui Button `loading`: the spinner, named by what is happening.
  assert.equal(pendingButton.getAttribute("data-loading"), "true");
  assert.equal(pendingButton.querySelector("[data-slot=button-loading-indicator] [role=status]")?.getAttribute("aria-label"), "Installing and continuing...");
  assert.equal((screen.getByRole("searchbox", { name: "Search servers" }) as HTMLInputElement).disabled, true);
  assert.equal(installed.getAttribute("aria-disabled"), "true");
  assert.equal((installed as HTMLButtonElement).disabled, true);
  fireEvent.click(installed);
  fireEvent.click(pendingButton);
  assert.equal(installed.hasAttribute("data-selected"), false);
  assert.equal(installable.hasAttribute("data-selected"), true);
  assert.deepEqual(postUrls, ["/integrations/marketplace/app-1/install"]);
  await act(async () => {
    resolveInstall();
    await pendingInstall;
  });
  await waitFor(() => {
    assert.deepEqual(postUrls, ["/integrations/marketplace/app-1/install", "/oauth/authorize/human"]);
  });
  assert.equal(postUrls.filter((url) => url === "/oauth/authorize/human").length, 1);
  const installedAfterClick = screen.getByTestId("login-server-status-server-2");
  assert.ok(within(installedAfterClick).queryByText("Not installed") === null);
  assert.equal(installedAfterClick.getAttribute("aria-label"), "Use this server: Build Server");
  const memberOnly = screen.getByTestId("login-server-status-server-3");
  assert.equal(memberOnly.getAttribute("title"), null);
  assert.ok(memberOnly.hasAttribute("data-base-ui-tooltip-trigger"), "status hint now rides the RUI tooltip trigger");
  assert.ok(within(memberOnly).getByText("Admin needed"));
  fireEvent.click(memberOnly);
  assert.match(screen.getByTestId("marketplace-login-commit-zone").textContent ?? "", /Only an owner or admin of this Server can install it/);
  assert.equal(screen.queryAllByRole("button", { name: "Continue login" }).length, 0);
  const findAdmin = screen.getByRole("link", { name: "Find a server admin" });
  assert.equal(findAdmin.getAttribute("href"), "/s/member/members");
  // Still a link, drawn as the DS ink-line (paper) button.
  assert.ok(findAdmin.classList.contains("border-line-strong"));
  assert.ok(findAdmin.classList.contains("bg-layer-card"));
  assert.ok(!findAdmin.classList.contains("bg-attention"));
  const unavailable = screen.getByTestId("login-server-status-server-4");
  assert.equal(unavailable.getAttribute("title"), null);
  assert.ok(unavailable.hasAttribute("data-base-ui-tooltip-trigger"), "status hint now rides the RUI tooltip trigger");
  assert.ok(within(unavailable).getByText("Unavailable"));
  assert.equal(screen.getAllByTestId(/^login-server-status-/).length, 22);
  // The rows scroll in a raft-ui ScrollArea with the same max height; each row is a button, so no tab stop.
  const serverList = screen.getByTestId("login-server-status-server-4").closest<HTMLElement>(".r-scroll-area");
  assert.ok(serverList && serverList.classList.contains("max-h-72") && serverList.tabIndex === -1);
  const search = screen.getByRole("searchbox", { name: "Search servers" });
  fireEvent.change(search, { target: { value: "member" } });
  assert.ok(screen.getByTestId("login-server-status-server-3"));
  assert.ok(screen.queryByTestId("login-server-status-server-1") === null);
  fireEvent.change(search, { target: { value: "missing" } });
  assert.ok(screen.getByText("No Servers match your search"));
  assert.ok(screen.getByText("All Raft Servers you can access are shown here. Continue with an installed Server, or install the App where you have permission."));
  assert.ok(screen.queryByText(/none of your accessible Servers has installed/) === null);
  assert.ok(screen.queryByRole("button", { name: "Login with Raft" }) === null);
});

test("Login with Raft install shows the app's new set after a 409 and sends that set next", async () => {
  resetStores();
  const adminServer: Server = { ...ownerServer, id: "server-2", name: "Build Server", slug: "build", role: "admin" };
  useServerStore.setState({ servers: [adminServer], current: adminServer, members: [], loading: false } as never);
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    return {
      data: {
        id: "app-1",
        clientId: "orbital-notes",
        appType: "third_party_global",
        name: "Orbital Notes",
        returnUrl: "https://orbital.example.com/return",
        logoUrl: null,
        marketplace: true,
        // A reserved scope (not offered anywhere in the UI) is still listed.
        allowedScopes: ["openid", "profile", "agent:action_request:write"],
        appNotificationGroups: [],
        availability: "install_required",
        installation: { serverId: config?.params?.server_id, canInstall: true },
      },
    };
  }) as typeof api.get;
  const installBodies: unknown[] = [];
  api.post = (async (url: string, body?: unknown) => {
    if (url !== "/integrations/marketplace/app-1/install") throw new Error(`unexpected POST ${url}`);
    installBodies.push(body);
    if (installBodies.length === 1) {
      throw {
        response: {
          status: 409,
          data: {
            code: "APP_PERMISSIONS_CHANGED",
            current_scopes: ["openid", "profile", "agent:action_request:write", "email"],
            current_groups: ["server"],
          },
        },
      };
    }
    throw { response: { status: 400, data: { code: "EXPECTED_PERMISSIONS_REQUIRED", error: "server text" } } };
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  const commitZone = await screen.findByTestId("marketplace-login-commit-zone");
  const shownValues = () => [...within(commitZone).getByTestId("app-permission-set").querySelectorAll("[data-app-permission-value]")]
    .map((row) => row.getAttribute("data-app-permission-value"));
  await waitFor(() => assert.deepEqual(shownValues(), ["openid", "profile", "agent:action_request:write"]));
  assert.ok(within(commitZone).getByText("Lets the app ask the one agent you authorize to take an action. Reserved: Raft doesn't use it yet."));

  fireEvent.click(screen.getByRole("button", { name: "Install and continue" }));
  assert.ok(await screen.findByText("This app's permissions just changed. Review the current permissions below, then install again."));
  // The list now shows the set the server reported, without a reload.
  assert.deepEqual(shownValues(), ["openid", "profile", "agent:action_request:write", "email", "server"]);

  fireEvent.click(screen.getByRole("button", { name: "Install and continue" }));
  await waitFor(() => assert.equal(installBodies.length, 2));
  assert.deepEqual(installBodies, [
    { expected_scopes: ["openid", "profile", "agent:action_request:write"], expected_groups: [] },
    { expected_scopes: ["openid", "profile", "agent:action_request:write", "email"], expected_groups: ["server"] },
  ]);
  // A 400 means this page predates the check: only a reload fixes it.
  assert.ok(await screen.findByText("This page is out of date. Reload it, review the app's permissions, then try again."));
});

test("Login with Raft setup page blocks agent messaging scopes and shows exact requested access", async () => {
  resetStores();
  window.history.pushState(
    {},
    "",
    "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn&scope=openid%20profile%20identity%20agent%3Aevent%3Awrite%20agent%3Anotification%3Awrite%20agent%3Aaction_request%3Awrite%20unknown%20unknown",
  );

  api.get = (async (url: string) => {
    if (url === "/oauth/clients/lookup") {
      return {
        data: {
          clientId: "orbital-notes",
          appType: "third_party_global",
          name: "Orbital Notes",
          description: "Review launch notes from Raft.",
          homepageUrl: "https://orbital.example.com/docs",
          returnUrl: "https://orbital.example.com/return",
          logoUrl: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  const requested = await screen.findByTestId("login-with-raft-requested-scopes");
  assert.ok(within(requested).getByText("Requested access"));
  assert.ok(within(requested).getByText("Recognized capabilities are shown below. Review unrecognized requested scopes before continuing."));
  assert.ok(within(requested).getByText("Identity"));
  assert.ok(within(requested).getByText("Agent messaging"));
  assert.ok(within(requested).getByText("openid"));
  assert.ok(within(requested).getByText("profile"));
  assert.ok(within(requested).getByText("identity"));
  assert.ok(within(requested).getByText("agent:event:write"));
  assert.ok(within(requested).getByText("agent:notification:write"));
  assert.ok(within(requested).getByText("Sends structured event messages to the one agent you authorize."));
  assert.ok(within(requested).getByText("Sends notification messages to the one agent you authorize."));
  assert.ok(within(requested).queryByText(/Treated as untrusted/) === null);
  assert.ok(within(requested).getByText(enMessages["oauth.consent.agentLoginRequiredNotice"]));
  assert.ok(within(requested).getByText("Unrecognized scopes:"));
  assert.ok(within(requested).getByText("agent:action_request:write"));
  assert.equal(within(requested).getAllByText("unknown").length, 1);

  const button = await screen.findByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.ok(screen.queryByText("Agent messaging access requires Raft Agent Login.") === null);
});

test("Login with Raft setup page renders empty requested-scope fallback for unrecognized-only requests", async () => {
  resetStores();
  window.history.pushState(
    {},
    "",
    "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn&scope=%20unknown%20%20",
  );

  api.get = (async (url: string) => {
    if (url === "/oauth/clients/lookup") {
      return {
        data: {
          clientId: "orbital-notes",
          appType: "third_party_global",
          name: "Orbital Notes",
          description: null,
          homepageUrl: null,
          returnUrl: "https://orbital.example.com/return",
          logoUrl: null,
          scopeValidation: { allowed: false, reason: "unsupported", disallowedScopes: ["unknown"] },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  const requested = await screen.findByTestId("login-with-raft-requested-scopes");
  assert.ok(within(requested).getByText("Recognized capabilities are shown below. Review unrecognized requested scopes before continuing."));
  assert.ok(within(requested).getByText("No recognized Raft scopes were requested."));
  assert.ok(within(requested).getByText("Unrecognized scopes:"));
  assert.ok(within(requested).getByText("unknown"));
  const alert = screen.getByTestId("oauth-scope-configuration-error");
  assert.ok(within(alert).getByText("Unsupported OAuth scope"));
  assert.ok(within(alert).getByText("Orbital Notes requested OAuth scopes Raft does not support: unknown. Update the app's requested scopes before trying again."));
  assert.equal((screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement).disabled, true);
});

function inviteResponse(overrides: { allowedScopes?: string[] | null; appNotificationGroups?: string[] } = {}) {
  return {
    client: {
      id: "client-1",
      clientId: "orbital-notes",
      name: "Orbital Notes",
      description: "Review launch notes from Raft.",
      homepageUrl: "https://orbital.example.com/docs",
      returnUrl: "https://orbital.example.com/return",
      allowedScopes: ["openid", "profile", "identity", "agent:event:write", "agent:notification:write"],
      appNotificationGroups: ["channel"],
      logoUrl: null,
      publisherName: "Orbital",
      sourceServerName: "Publisher Server",
      installedAt: null,
      ...overrides,
    },
    link: {
      id: "link-1",
      expiresAt: null,
    },
    manageableServers: [{
      id: ownerServer.id,
      name: ownerServer.name,
      slug: ownerServer.slug,
      role: "owner",
      installedAt: null,
    }],
  };
}

function renderInvitePage() {
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/integration-invites/share-token"]}>
        <Routes>
          <Route path="/integration-invites/:token" element={<IntegrationInvitePage />} />
        </Routes>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function listedPermissions(kind: "scope" | "group") {
  return [...screen.getByTestId("app-permission-set").querySelectorAll(`[data-app-permission-kind="${kind}"]`)]
    .map((row) => row.getAttribute("data-app-permission-value"));
}

test("private app invite page lists the app's whole permission set and sends it back on install", async () => {
  resetStores();
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { ...inviteResponse(), manageableServers: [{ ...inviteResponse().manageableServers[0]!, installedAt: "2026-10-20T00:00:00.000Z" }] } };
  }) as typeof api.post;

  renderInvitePage();

  const page = await screen.findByTestId("integration-invite-page");
  assert.ok(page.className.includes("h-full"));
  // The page scrolls itself, in a raft-ui ScrollArea.
  assertScrollAreaRailsOn(page, { ownContainer: false, trigger: "hover" });
  assert.ok(await screen.findByText("Installing approves for this Server:"));
  assert.deepEqual(listedPermissions("scope"), ["openid", "profile", "identity", "agent:event:write", "agent:notification:write"]);
  assert.deepEqual(listedPermissions("group"), ["channel"]);

  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  await waitFor(() => assert.equal(posts.length, 1));
  assert.equal(posts[0]!.url, "/integration-invites/share-token/install");
  assert.deepEqual(posts[0]!.body, {
    serverId: ownerServer.id,
    expected_scopes: ["openid", "profile", "identity", "agent:event:write", "agent:notification:write"],
    expected_groups: ["channel"],
  });
});

test("private app invite page with no declared scopes shows and sends the default identity scopes", async () => {
  resetStores();
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse({ allowedScopes: null, appNotificationGroups: [] }) };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  const posts: unknown[] = [];
  api.post = (async (_url: string, body?: unknown) => {
    posts.push(body);
    return { data: inviteResponse() };
  }) as typeof api.post;

  renderInvitePage();

  await screen.findByText("Installing approves for this Server:");
  assert.deepEqual(listedPermissions("scope"), ["openid", "profile", "identity"]);
  assert.deepEqual(listedPermissions("group"), []);
  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  await waitFor(() => assert.equal(posts.length, 1));
  assert.deepEqual(posts[0], { serverId: ownerServer.id, expected_scopes: ["openid", "profile", "identity"], expected_groups: [] });
});

test("private app invite page shows the app's new set after a permissions-changed 409, and the next install sends it", async () => {
  resetStores();
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse({ allowedScopes: ["openid", "profile"], appNotificationGroups: ["channel"] }) };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  const posts: unknown[] = [];
  api.post = (async (_url: string, body?: unknown) => {
    posts.push(body);
    if (posts.length === 1) {
      throw {
        response: {
          status: 409,
          data: { code: "APP_PERMISSIONS_CHANGED", current_scopes: ["openid", "profile", "email"], current_groups: ["channel", "agent"] },
        },
      };
    }
    return { data: inviteResponse() };
  }) as typeof api.post;

  renderInvitePage();

  await screen.findByText("Installing approves for this Server:");
  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  assert.ok(await screen.findByText("This app's permissions just changed. Review the current permissions below, then install again."));
  assert.deepEqual(listedPermissions("scope"), ["openid", "profile", "email"]);
  assert.deepEqual(listedPermissions("group"), ["channel", "agent"]);

  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  await waitFor(() => assert.equal(posts.length, 2));
  assert.deepEqual(posts[1], { serverId: ownerServer.id, expected_scopes: ["openid", "profile", "email"], expected_groups: ["channel", "agent"] });
});

test("private app invite page names the link's one target server instead of offering a picker", async () => {
  resetStores();
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  const posts: unknown[] = [];
  api.post = (async (_url: string, body?: unknown) => {
    posts.push(body);
    return { data: { ...inviteResponse(), manageableServers: [{ ...inviteResponse().manageableServers[0]!, installedAt: "2026-10-20T00:00:00.000Z" }] } };
  }) as typeof api.post;

  renderInvitePage();

  const target = await screen.findByTestId("integration-invite-target");
  assert.ok(within(target).getByText(ownerServer.name));
  assert.ok(within(target).getByText(`/${ownerServer.slug}`));
  assert.ok(screen.queryByRole("combobox") === null, "one target: nothing to choose");
  assert.ok(screen.getByText(enMessages["pages.integrationInvite.singleUseNote"]));
  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  await waitFor(() => assert.equal(posts.length, 1));
  assert.equal((posts[0] as { serverId: string }).serverId, ownerServer.id);
  assert.ok(await screen.findByRole("button", { name: "Open Settings" }));
});

test("private app invite page answers an invalid link with one explanation, on load and on install", async () => {
  resetStores();
  const invalid = { response: { status: 404, data: { error: "This private app invite is invalid or has expired", code: "private_app_invite_invalid" } } };
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") throw invalid;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderInvitePage();
  assert.ok(await screen.findByText(enMessages["pages.integrationInvite.inviteInvalid"]));
  assert.ok(screen.queryByRole("button", { name: "Install app" }) === null);
  cleanup();

  // Spent (or revoked) between loading the page and clicking Install.
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async () => { throw invalid; }) as typeof api.post;
  renderInvitePage();
  fireEvent.click(await screen.findByRole("button", { name: "Install app" }));
  assert.ok(await screen.findByText(enMessages["pages.integrationInvite.inviteInvalid"]));
  assert.ok(screen.queryByRole("button", { name: "Install app" }) === null, "nothing left to install");
});

test("private app invite page tells a member of the target server whom to ask, on load and on install", async () => {
  resetStores();
  const adminRequired = {
    response: {
      status: 403,
      data: {
        error: "An owner or admin of Launch Server needs to install this app",
        code: "private_app_invite_admin_required",
        targetServer: { name: "Launch Server", slug: "launch" },
      },
    },
  };
  const expected = "An owner or admin of Launch Server needs to install this app. Send this link to one of them.";
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") throw adminRequired;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderInvitePage();
  assert.ok(await screen.findByText(expected));
  assert.ok(screen.queryByRole("button", { name: "Install app" }) === null);
  cleanup();

  // Demoted between loading the page and clicking Install.
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async () => { throw adminRequired; }) as typeof api.post;
  renderInvitePage();
  fireEvent.click(await screen.findByRole("button", { name: "Install app" }));
  assert.ok(await screen.findByText(expected));
  assert.ok(screen.queryByRole("button", { name: "Install app" }) === null);
});

test("Login with Raft setup page shows app initials when no logo is available", async () => {
  resetStores();
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");

  api.get = (async (url: string) => {
    if (url === "/oauth/clients/lookup") {
      return {
        data: {
          clientId: "orbital-notes",
          appType: "third_party_global",
          name: "  Orbital   Notes  ",
          description: null,
          homepageUrl: null,
          returnUrl: "https://orbital.example.com/return",
          logoUrl: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  assert.ok(await screen.findByText("ON"));
  assert.ok(document.querySelector('img[src="https://cdn.example.com/orbital-notes.png"]') === null);
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement).disabled, false));
});

test("Login with Raft setup page shows failed authorization status only after submit errors", async () => {
  resetStores();
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");

  api.get = (async (url: string) => {
    if (url === "/oauth/clients/lookup") {
      return {
        data: {
          clientId: "orbital-notes",
          appType: "third_party_global",
          name: "Orbital Notes",
          description: null,
          homepageUrl: null,
          returnUrl: "https://orbital.example.com/return",
          logoUrl: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async () => {
    throw new Error("network down");
  }) as typeof api.post;

  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);

  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement).disabled, false));
  assert.ok(document.querySelector("pre") === null);
  fireEvent.click(screen.getByRole("button", { name: "Login with Raft" }));

  const status = await screen.findByText("Failed to continue with Raft.");
  assert.equal(status.tagName, "PRE");
  // The <pre> is a raft-ui ScrollArea (a long line scrolls sideways), a region named for the status.
  assert.ok(status === screen.getByRole("region", { name: "Login status" }));
  for (const token of ["r-scroll-area", "r-scroll-area--horizontal-orientation", "mt-4", "min-h-16", "rounded-container", "border", "bg-layer-code", "p-3", "font-mono"]) {
    assert.ok(status.classList.contains(token), token);
  }
});


test("registration persists setup URL and instructions through the real form submit path", async () => {
  resetStores();
  api.get = (async () => ({ data: [] })) as typeof api.get;
  let submitted: { setupUrl?: string; setupDescription?: string } | undefined;
  api.post = (async (url: string, body: typeof submitted) => {
    assert.equal(url, "/integrations/clients");
    submitted = body;
    return { data: { client: { id: "setup-client", name: "Setup App", ...body }, clientSecret: "synthetic" } };
  }) as typeof api.post;
  render(<TestIntlProvider><MemoryRouter><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);
  await chooseRegisterAppMenuItem("own-service");
  fireEvent.change(screen.getByRole("textbox", { name: "App name" }), { target: { value: "Setup App" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Requires configuration after installation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Setup page URL*" }), { target: { value: "https://setup.example.test/configure" } });
  fireEvent.change(screen.getByRole("textbox", { name: /Configuration instructions/ }), { target: { value: "Choose a repository" } });
  const form = screen.getByRole("textbox", { name: "App name" }).closest("form");
  assert.ok(form);
  fireEvent.click(within(form).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.equal(submitted?.setupUrl, "https://setup.example.test/configure"));
  assert.equal(submitted?.setupDescription, "Choose a repository");
});

test("editor mutations returning bare rows keep the bot grant state", async () => {
  resetStores();
  resetServerFeatureFlagsForTests();
  const client = {
    id: "bot-client",
    clientId: "bot-client",
    appType: "server_local",
    name: "Bot App",
    description: null,
    homepageUrl: null,
    returnUrl: null,
    logoUrl: null,
    publishStatus: "publish_requested",
    category: "Other",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile"],
    enableBot: true,
    installationId: "install-1",
    installStatus: "active",
    botGrant: "granted",
    bot: { offered: true, grant: "granted", handle: "bot-client", agentId: "agent-1" },
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  const bareRow = () => {
    // What regenerate-secret / share-link / withdraw-publish / request-unpublish
    // actually return: OAUTH_CLIENT_PUBLIC_COLUMNS only, no install join.
    const { installationId: _i, installStatus: _s, botGrant: _b, bot: _bot, ...bare } = client as Record<string, unknown>;
    return bare;
  };
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/bot-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (url === "/integrations/clients/bot-client/app-notifications") {
      return { data: { revision: null, selection: { groups: [], events: [] } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    if (url === "/integrations/clients/bot-client/withdraw-publish") {
      client.publishStatus = "private";
      return { data: { ...bareRow(), publishStatus: "private" } };
    }
    if (url === "/integrations/clients/bot-client/regenerate-secret") {
      return { data: { client: bareRow(), clientSecret: "new-secret" } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));

  // The editor's bot hint reads the install-joined `bot`; a bare-row mutation
  // (withdraw publish) must not erase it.
  await screen.findByTestId("connected-app-bot-editor-hint");
  fireEvent.click(await screen.findByTestId("connected-app-withdraw-publish-button"));
  await waitFor(() => assert.ok(screen.queryByTestId("connected-app-withdraw-publish-button") === null, "withdraw applied"));
  assert.ok(screen.getByTestId("connected-app-bot-editor-hint"));

  // regenerate-secret returns {client: bare, clientSecret} — same rule.
  fireEvent.click(screen.getByRole("button", { name: "Regenerate client secret" }));
  fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
  await screen.findByText("new-secret");
  assert.ok(screen.getByTestId("connected-app-bot-editor-hint"));
});

test("Connected Apps editor toggles enableBot; the bot is added from the installed detail, not the editor", async () => {
  resetStores();
  resetServerFeatureFlagsForTests();
  const client = {
    id: "bot-client",
    clientId: "bot-client",
    appType: "server_local",
    name: "Bot App",
    description: null,
    homepageUrl: null,
    returnUrl: null,
    logoUrl: null,
    publishStatus: "private",
    category: "Other",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile"],
    enableBot: false,
    botGrant: null as "pending" | "granted" | "revoked" | null,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  // The server's install-joined row: `bot` while the App ships one (GET /clients and PATCH).
  const joinedRow = () => ({
    ...client,
    installationId: client.botGrant ? "install-1" : null,
    installStatus: client.botGrant ? "active" : null,
    botGrant: client.botGrant ?? null,
    ...(client.enableBot ? { bot: {
      offered: true,
      grant: client.botGrant ?? "pending",
      handle: "bot-client",
      ...(client.botGrant === "granted" ? { agentId: "agent-1" } : {}),
    } } : {}),
  });
  const patchBodies: unknown[] = [];
  const postCalls: Array<{ url: string; body: unknown }> = [];

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [joinedRow()] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/mcp/apps") return { data: { apps: [] } };
    if (url === "/integrations/clients/bot-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (url === "/integrations/clients/bot-client/app-notifications") {
      return { data: { revision: null, selection: { groups: [], events: [] } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = (async (url: string, body: unknown) => {
    assert.equal(url, "/integrations/clients/bot-client");
    patchBodies.push(body);
    client.enableBot = (body as { enableBot?: boolean }).enableBot === true;
    // Server cascade: turning the capability off disables a live bot and puts
    // the install back to "pending", so a re-enable asks again.
    if (client.enableBot === false && client.botGrant === "granted") client.botGrant = "pending";
    // The route returns the install-joined editor row (same shape as GET /clients).
    return { data: joinedRow() };
  }) as typeof api.patch;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    if (url === "/integrations/clients/bot-client/install/bot") {
      const action = (body as { action: string }).action;
      client.botGrant = action === "grant" ? "granted" : "revoked";
      return { data: { installationId: "install-1", botGrant: client.botGrant, bot: action === "grant" ? { agentId: "agent-1", state: "active", handle: "bot-client" } : null } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));

  // The Bot checkbox exists and starts unchecked; there is no hint yet.
  const botToggle = await screen.findByTestId("connected-app-enable-bot");
  const checkedAttr = botToggle.getAttribute("aria-checked") ?? botToggle.getAttribute("data-state");
  assert.ok(checkedAttr === "false" || checkedAttr === "unchecked", `checkbox starts unchecked (got ${checkedAttr})`);
  assert.ok(screen.queryByTestId("connected-app-bot-editor-hint") === null, "no hint while the app has no bot");

  // Check it, then save — PATCH must carry enableBot: true.
  fireEvent.click(botToggle);
  const saveButton = screen.getAllByRole("button").find((b) => /save|save changes/i.test(b.textContent ?? ""));
  assert.ok(saveButton);
  fireEvent.click(saveButton);
  await waitFor(() => assert.equal(patchBodies.length, 1));
  assert.equal((patchBodies[0] as { enableBot?: boolean }).enableBot, true);

  // Save closes the editor; reopened, the saved and checked box shows the hint,
  // and the editor has no Enable / Disable bot buttons any more.
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  const hint = await screen.findByTestId("connected-app-bot-editor-hint");
  assert.ok(screen.queryByRole("button", { name: /enable bot|disable bot/i }) === null);
  assert.ok(screen.queryByText("Bot enabled") === null);

  // The hint opens this App's installed detail, where the bot is added.
  fireEvent.click(within(hint).getByRole("button", { name: "Installed apps" }));
  const section = await screen.findByTestId("connected-app-bot-section");
  fireEvent.click(within(section).getByRole("button", { name: "Add @bot-client to Launch Server" }));
  await waitFor(() => assert.ok(postCalls.some((c) => c.url === "/integrations/clients/bot-client/install/bot" && (c.body as { action?: string }).action === "grant")));
  await waitFor(() => assert.equal(screen.getByTestId("connected-app-bot-section").getAttribute("data-bot-grant"), "granted"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  // Turning the capability off cascades on the server.
  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  const botToggleAgain = await screen.findByTestId("connected-app-enable-bot");
  fireEvent.click(botToggleAgain);
  await waitFor(() => assert.ok(screen.queryByTestId("connected-app-bot-editor-hint") === null, "unchecked: no hint"));
  const saveOff = screen.getAllByRole("button").find((b) => /save|save changes/i.test(b.textContent ?? ""));
  assert.ok(saveOff);
  fireEvent.click(saveOff);
  await waitFor(() => assert.equal(patchBodies.length, 2));
  assert.equal((patchBodies[1] as { enableBot?: boolean }).enableBot, false);
  assert.equal(client.botGrant, "pending", "disable cascade puts the grant back to pending");
});

function mockPendingInstalledPermissionUpdate({ failApproval = false, pending = true } = {}) {
  const installed = {
    id: "permission-update-app", serverId: "publisher-server", clientId: "permission-update",
    name: "Directory App", description: "Read the team's Agent directory", category: "Developer Tools",
    appType: "third_party_global", publishStatus: "published", enabled: true,
    humanMarketplaceVisible: true, publisherServerName: "App publisher", logoUrl: null,
    homepageUrl: "https://directory.example.test", returnUrl: "https://directory.example.test/callback",
    installedAt: "2026-10-01T00:00:00Z", privateShared: false,
    allowedScopes: ["openid", "profile"], appNotificationGroups: ["agent"], appNotificationEvents: [],
    appNotificationReviewPending: false, permissionApprovalRequired: pending,
  };
  const state = {
    installation_id: "permission-install", status: "active", approved_request_revision_id: null,
    requested_groups: ["agent"], requested_events: [], requested_scopes: ["openid", "profile"],
    approved_groups: [] as string[], subscribed_events: [], effective_groups: [] as string[], effective_events: [],
    grant_revision: 0, subscription_revision: 0, app_review_pending: false, approval_required: pending,
  };
  let writes = 0;
  const reads: string[] = [];
  api.get = (async (url: string) => {
    reads.push(url);
    if (url === "/integrations/marketplace") return { data: [{ ...installed }] };
    if (url === "/integrations/marketplace/permission-update-app/install/app-notifications") return { data: { ...state } };
    if (url === "/mcp/apps") return { data: { apps: [] } };
    return { data: [] };
  }) as typeof api.get;
  api.put = (async (url: string, body?: unknown) => {
    assert.equal(url, "/integrations/marketplace/permission-update-app/install/app-notifications/grant");
    assert.deepEqual(body, { expected_scopes: ["openid", "profile"], expected_groups: ["agent"] });
    writes += 1;
    if (failApproval) throw { response: { status: 403, data: { error: "Approval refused" } } };
    state.approved_groups = ["agent"]; state.effective_groups = ["agent"]; state.approval_required = false;
    installed.permissionApprovalRequired = false;
    return { data: {} };
  }) as typeof api.put;
  return { writes: () => writes, reads: () => reads };
}

for (const locale of ["en", "zh-cn"] as const) {
  test(`installed permission update is visible and reviewable without granting until confirmation (${locale})`, async () => {
    resetStores();
    const probe = mockPendingInstalledPermissionUpdate();
    render(<TestIntlProvider locale={locale}><MemoryRouter><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);
    const notice = await screen.findByTestId("connected-apps-permission-updates");
    // A prior filter must not hide the Apps the notice sends the user to.
    fireEvent.change(screen.getByTestId("connected-apps-search"), { target: { value: "unrelated search" } });
    // #triage:#156: the notice's button opens the waiting app's review itself
    // (it used to switch to Installed, where the notice already is: nothing happened).
    fireEvent.click(within(notice).getByRole("button"));
    const permissionPanel = await screen.findByTestId("installed-app-notifications");
    const item = await screen.findByTestId("connected-app-item-permission-update-app");
    assert.ok(within(item).getByTestId("app-permission-approval-required"));
    assert.equal(probe.writes(), 0, "opening the pending-permission review must not grant anything");
    const banner = within(permissionPanel).getByTestId("app-notifications-approval-required");
    fireEvent.click(within(banner).getByRole("button", { name: locale === "en" ? "Approve update" : "批准更新" }));
    await waitFor(() => assert.ok(screen.queryByTestId("connected-apps-permission-updates") === null));
    assert.equal(probe.writes(), 1);
    assert.ok(within(item).queryByTestId("app-permission-approval-required") === null, "successful approval refreshes the list immediately");
  });
}

test("failed permission approval keeps the installed notice; members get no approval action and no owner-or-admin read", async () => {
  resetStores();
  const probe = mockPendingInstalledPermissionUpdate({ failApproval: true });
  render(<TestIntlProvider><MemoryRouter><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);
  fireEvent.click(within(await screen.findByTestId("connected-apps-permission-updates")).getByRole("button"));
  const panel = await screen.findByTestId("installed-app-notifications");
  fireEvent.click(within(panel).getByRole("button", { name: "Approve update" }));
  await waitFor(() => assert.ok(screen.getAllByText("Approval refused").length > 0));
  assert.ok(screen.getByTestId("connected-apps-permission-updates"));
  assert.equal(probe.writes(), 1);
  cleanup();
  useServerStore.setState({ current: { ...ownerServer, role: "member" } } as never);
  render(<TestIntlProvider><MemoryRouter><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);
  // A member's notice opens the App's detail, but not its App Notifications review: the server
  // lets only owners and admins read it, so the member's detail neither shows nor requests it.
  const readsBefore = probe.reads().length;
  fireEvent.click(within(await screen.findByTestId("connected-apps-permission-updates")).getByRole("button"));
  await screen.findByText("Login with Raft access");
  const item = await screen.findByTestId("connected-app-item-permission-update-app");
  assert.equal(within(item).queryByRole("button", { name: "Review permissions" }) === null, true);
  assert.ok(screen.queryByTestId("installed-app-notifications") === null, "no App Notifications review for a member");
  assert.deepEqual(probe.reads().slice(readsBefore).filter((url) => url.includes("/app-notifications")), []);
  assert.ok(screen.queryByRole("button", { name: "Approve update" }) === null);
  assert.equal(probe.writes(), 1);
});


// #triage:59b61529: this Server's own non-public App installed here is in the
// list GET /integrations/marketplace returns (the notice counts it), so the
// Installed tab reviews it like any other App; the Marketplace tab still shows
// only public listings and other Servers' Apps.
function mockOwnAppPermissionUpdate() {
  const app = (id: string, name: string, fields: Record<string, unknown>) => ({
    id, serverId: ownerServer.id, clientId: id, name, description: `${name} description`, category: "Developer Tools",
    appType: "third_party_global", publishStatus: "private", enabled: true, humanMarketplaceVisible: false,
    homepageUrl: null, returnUrl: "https://own.example.test/callback", logoUrl: null, allowedScopes: ["openid", "profile", "email"],
    enableBot: false, createdByUserId: "user-1", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    ...fields,
  });
  const listed = (row: ReturnType<typeof app>, fields: Record<string, unknown>) => ({
    ...row, official: false, purpose: "", installationId: `${row.id}-install`, installStatus: "active",
    installedAt: "2026-10-01T00:00:00Z", botGrant: null, marketplaceInstallBadge: { kind: "none" },
    publisherName: "Owner", publisherServerName: ownerServer.name, privateShared: false,
    appNotificationGroups: [], appNotificationEvents: [], appNotificationReviewPending: false,
    appNotificationPendingRevisionId: null, appNotificationPendingGroups: [], appNotificationPendingEvents: [],
    permissionApprovalRequired: false, ...fields,
  });
  const ownApp = app("own-app", "Own Tool", {});
  const ownUnlisted = app("own-unlisted", "Own Unlisted", { publishStatus: "published" });
  const ownLocal = app("own-local", "Own Local", { appType: "server_local" });
  const sharedToUs = app("shared-to-us", "Shared To Us", { serverId: "publisher-server" });
  const publicApp = app("public-app", "Public App", { serverId: "publisher-server", publishStatus: "published", humanMarketplaceVisible: true });
  const ownListing = listed(ownApp, { privateShared: true, permissionApprovalRequired: true });
  const marketplace = [
    ownListing,
    listed(ownUnlisted, {}),
    listed(sharedToUs, { privateShared: true }),
    listed(publicApp, { installationId: null, installStatus: null, installedAt: null }),
  ];
  const state = {
    installation_id: "own-app-install", status: "active", approved_request_revision_id: null,
    requested_groups: [], requested_events: [], requested_scopes: ["openid", "profile", "email"],
    approved_scopes: ["openid", "profile"], new_scopes: ["email"],
    approved_groups: [] as string[], subscribed_events: [], effective_groups: [] as string[], effective_events: [],
    grant_revision: 0, subscription_revision: 0, app_review_pending: false, approval_required: true,
  };
  const puts: Array<{ url: string; body: unknown }> = [];
  api.get = (async (url: string) => {
    // GET /integrations/clients joins this Server's installation: the two listed ones are installed here.
    if (url === "/integrations/clients") {
      return { data: [
        { ...ownApp, installationId: "own-app-install", installStatus: "active" },
        { ...ownUnlisted, installationId: "own-unlisted-install", installStatus: "active" },
        ownLocal,
      ] };
    }
    if (url === "/integrations/marketplace") return { data: marketplace.map((row) => ({ ...row })) };
    if (url === "/integrations/marketplace/own-app/install/app-notifications") return { data: { ...state } };
    if (url === "/mcp/apps") return { data: { apps: [] } };
    return { data: [] };
  }) as typeof api.get;
  api.put = (async (url: string, body?: unknown) => {
    puts.push({ url, body });
    state.approved_scopes = ["openid", "profile", "email"]; state.new_scopes = []; state.approval_required = false;
    ownListing.permissionApprovalRequired = false;
    return { data: {} };
  }) as typeof api.put;
  return { puts };
}

test("this Server's own non-public installed App opens its detail with the Review block; the Marketplace tab hides it", async () => {
  resetStores();
  const probe = mockOwnAppPermissionUpdate();
  render(<TestIntlProvider><MemoryRouter><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);

  // The server leaves them off the Marketplace's listings (the test helper does as it does).
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  const marketplaceTab = await screen.findByTestId("connected-apps-marketplace-tab");
  await within(marketplaceTab).findByText("Public App");
  for (const hidden of ["Own Tool", "Own Unlisted", "Shared To Us"]) {
    assert.ok(within(marketplaceTab).queryByText(hidden) === null, `${hidden} is not a Marketplace listing`);
  }

  fireEvent.click(within(await screen.findByTestId("connected-apps-permission-updates")).getByRole("button"));
  const item = await screen.findByTestId("connected-app-item-own-app");
  assert.ok(within(item).getByTestId("app-permission-approval-required"));
  // The review opened the update's detail, a modal dialog: the list under it is hidden from assistive tech meanwhile.
  assert.ok(within(item).getByRole("button", { name: "Edit", hidden: true }), "still edited from its row");
  // Not installed here (server-local): under Developer only, not in Installed (Apps v4 D3).
  assert.ok(screen.queryByTestId("connected-app-item-own-local") === null);
  assert.ok(within(await screen.findByTestId("connected-app-item-own-unlisted")).getByRole("button", { name: "Own Unlisted", hidden: true }));

  fireEvent.click(within(item).getByRole("button", { name: "Own Tool", hidden: true }));
  const panel = await screen.findByTestId("installed-app-notifications");
  assert.equal(probe.puts.length, 0, "opening the detail grants nothing");
  const banner = within(panel).getByTestId("app-notifications-approval-required");
  fireEvent.click(within(banner).getByRole("button", { name: "Approve update" }));
  await waitFor(() => assert.ok(screen.queryByTestId("connected-apps-permission-updates") === null));
  assert.deepEqual(probe.puts, [{
    url: "/integrations/marketplace/own-app/install/app-notifications/grant",
    body: { expected_scopes: ["openid", "profile", "email"], expected_groups: [] },
  }]);
  assert.ok(within(item).queryByTestId("app-permission-approval-required") === null);
});

test("notification review link opens installed Apps without another tab selection", async () => {
  resetStores(); mockPendingInstalledPermissionUpdate();
  render(<TestIntlProvider><MemoryRouter initialEntries={["/s/launch/settings/applications?permission_updates=1"]}><SettingsPanel tab="integrations" /></MemoryRouter></TestIntlProvider>);
  assert.ok(await screen.findByTestId("connected-app-item-permission-update-app"));
  assert.ok(screen.getByTestId("connected-apps-installed-tab"));
  // Arriving from elsewhere, the review opens once the apps have loaded (#triage:#156).
  await waitFor(() => assert.equal(screen.queryByTestId("installed-app-notifications") !== null, true));
});
