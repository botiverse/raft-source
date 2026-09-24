import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
// SettingsPanel → ConnectedApps mounts the react-intl-migrated ConfirmDialog
// (client-secret regen confirm), which needs an <IntlProvider> ancestor.
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";
import { OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import api from "../src/api/client";
import RequestedScopeConsent from "../src/components/oauth/RequestedScopeConsent";
import SettingsPanel, { matchesConnectedAppFilter } from "../src/components/settings/SettingsPanel";
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
import HumanLoginSetupPage, { initialsForApp } from "../src/pages/HumanLoginSetupPage";
import IntegrationInvitePage from "../src/pages/IntegrationInvitePage";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

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
      gravatarHash: "",
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
      context="surface-list"
      type="app"
      appAvatarUrl="https://cdn.example.com/orbital.png"
      appInitials="ON"
    />,
  );

  const logo = document.querySelector("img");
  assert.equal(logo?.getAttribute("src"), "https://cdn.example.com/orbital.png");
  assert.equal(logo?.getAttribute("class"), "relative z-[1] h-full w-full object-cover");
  const fallbackLayer = logo?.previousElementSibling;
  assert.equal(fallbackLayer?.tagName, "SPAN");
  assert.equal(fallbackLayer?.classList.contains("absolute"), true);
  assert.equal(fallbackLayer?.classList.contains("z-0"), true);
  assert.equal(logo?.classList.contains("relative"), true);
  assert.equal(logo?.classList.contains("z-[1]"), true);
  assert.equal(logo?.parentElement?.classList.contains("bg-soft-signal"), true);
  assert.equal(logo?.parentElement?.classList.contains("font-black"), true);
  assert.equal(logo?.parentElement?.className.endsWith(" "), false);
  assert.equal(document.body.textContent?.trim(), "ON");

  fireEvent.error(logo!);
  assert.equal(logo?.hidden, true);
  assert.equal(document.body.textContent?.trim(), "ON");

  rerender(
    <AvatarSlot
      context="surface-list"
      type="app"
      appAvatarUrl="https://cdn.example.com/orbital-v2.png"
      appInitials="ON"
    />,
  );
  const replacementLogo = document.querySelector("img");
  assert.equal(replacementLogo?.getAttribute("src"), "https://cdn.example.com/orbital-v2.png");
  assert.equal(replacementLogo?.hidden, false);

  rerender(<AvatarSlot context="surface-list" type="app" appInitials=" orbital notes " />);
  assert.equal(document.body.textContent?.trim(), "OR");

  rerender(<AvatarSlot context="surface-list" type="app" />);
  assert.equal(document.body.textContent?.trim(), "A");

  rerender(<AvatarSlot context="surface-list" type="server" serverInitial=" beacon " />);
  assert.equal(document.body.textContent?.trim(), "B");
  assert.ok(document.querySelector(".bg-black.text-soft-signal.font-bold"));

  rerender(
    <AvatarSlot
      context="surface-list"
      type="server"
      serverAvatarUrl="https://cdn.example.com/broken-server.png"
      serverInitial="beacon"
    />,
  );
  const serverAvatar = document.querySelector("img");
  fireEvent.error(serverAvatar!);
  assert.equal(serverAvatar?.hidden, true);
  assert.equal(document.body.textContent?.trim(), "B");

  rerender(<AvatarSlot context="surface-list" type="human" humanPlaceholder />);
  assert.ok(document.querySelector(".bg-brutal-lavender.text-black"));
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
  assert.equal(within(requested).queryByText("Agent messaging"), null);
  assert.equal(within(requested).queryByText(enMessages["oauth.consent.agentLoginRequiredNotice"]), null);
  assert.equal(within(requested).queryByText("No recognized Raft scopes were requested."), null);
  assert.equal(within(requested).queryByText("Unrecognized scopes:"), null);
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
  assert.equal(within(requested).queryByText(enMessages["oauth.consent.agentLoginRequiredNotice"]), null);
  assert.equal(within(requested).queryByText("Stryker was here"), null);
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
  assert.equal(within(requested).queryByText("No recognized Raft scopes were requested."), null);
  assert.equal(within(requested).queryByText("Unrecognized scopes:"), null);

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

test("Connected Apps renders app logos, descriptions, homepage links, and built-in open state", async () => {
  resetStores();
  const opened: Array<{ url?: string; target?: string; features?: string }> = [];
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    opened.push({ url: String(url), target, features });
    return null;
  }) as typeof window.open;

  api.get = (async (url: string) => {
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
      return {
        data: [
          {
            id: "survey",
            clientId: "slock-survey",
            appType: "slock_builtin",
            name: "Raft Survey",
            description: "Collect meetup responses.",
            homepageUrl: "https://survey.slock.ai",
            returnUrl: "https://survey.slock.ai/callback",
            logoUrl: "https://cdn.example.com/survey.png",
            category: "Productivity & Collaboration",
            dataAccessSummary: "First-party survey responses.",
            publisherName: "Raft",
            allowedScopes: ["openid", "profile", "identity"],
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
          },
          {
            id: "draft",
            clientId: "raft-draft",
            appType: "slock_builtin",
            name: "Raft Draft",
            description: "Internal draft surface.",
            homepageUrl: null,
            returnUrl: null,
            logoUrl: null,
            category: "Other",
            dataAccessSummary: null,
            publisherName: "Raft",
            allowedScopes: ["openid", "profile"],
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
          },
        ],
      };
    }
    if (url === "/integrations/marketplace") {
      return {
        data: [
          {
            id: "market-client",
            clientId: "market-client",
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

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const builtInBand = await screen.findByTestId("connected-apps-built-in-band");
  assert.ok(within(builtInBand).getByText("RS"));
  assert.ok(within(builtInBand).getByText("RD"));
  const viewToggle = screen.getByTestId("connected-apps-view-toggle");
  const gridViewButton = within(viewToggle).getByRole("button", { name: "Grid view" });
  const listViewButton = within(viewToggle).getByRole("button", { name: "List view" });
  const categoryFilter = screen.getByRole("combobox", { name: "Filter connected apps by category" });
  const searchFilter = screen.getByTestId("connected-apps-search");
  const filters = screen.getByTestId("connected-apps-filters");
  assert.ok(categoryFilter.classList.contains("h-10"));
  assert.ok(categoryFilter.classList.contains("min-h-10"));
  assert.ok(searchFilter.classList.contains("box-border"));
  assert.ok(searchFilter.classList.contains("h-10"));
  assert.ok(filters.classList.contains("items-stretch"));
  assert.ok(viewToggle.classList.contains("h-10"));
  assert.equal(gridViewButton.getAttribute("aria-pressed"), "true");
  const builtInCollection = screen.getByTestId("connected-apps-built-in-collection");
  const marketplaceCollection = screen.getByTestId("connected-apps-marketplace-collection");
  assert.equal(builtInCollection.getAttribute("data-view"), "grid");
  assert.equal(marketplaceCollection.getAttribute("data-view"), "grid");
  assert.ok(within(marketplaceCollection).getByText("100+ installs"));
  assert.ok(within(marketplaceCollection).getByText("New"));
  assert.equal(within(builtInCollection).queryByText("Collect meetup responses."), null);
  assert.equal(within(marketplaceCollection).queryByText("Reviewed shared notes."), null);
  fireEvent.click(listViewButton);
  assert.equal(listViewButton.getAttribute("aria-pressed"), "true");
  assert.equal(builtInCollection.getAttribute("data-view"), "list");
  assert.equal(marketplaceCollection.getAttribute("data-view"), "list");
  assert.ok(Array.from(builtInCollection.children).every((card) => card.classList.contains("w-full")));
  assert.ok(Array.from(marketplaceCollection.children).every((card) => card.classList.contains("w-full")));
  assert.ok(within(builtInCollection).getByText("Collect meetup responses."));
  assert.ok(within(marketplaceCollection).getByText("Reviewed shared notes."));
  assert.equal(window.localStorage.getItem("raft:connected-apps:view-mode"), "list");
  fireEvent.click(gridViewButton);
  assert.equal(gridViewButton.getAttribute("aria-pressed"), "true");
  assert.equal(within(builtInCollection).queryByText("Collect meetup responses."), null);
  assert.equal(within(marketplaceCollection).queryByText("Reviewed shared notes."), null);
  assert.equal(window.localStorage.getItem("raft:connected-apps:view-mode"), "grid");

  fireEvent.click(screen.getByRole("combobox", { name: "Filter connected apps by category" }));
  assert.ok(await screen.findByRole("option", { name: "All categories" }));
  for (const category of OAUTH_CLIENT_CATEGORIES) {
    assert.ok(screen.getByRole("option", { name: category }));
  }
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.equal(within(installedTab).getByTestId("connected-apps-installed-collection").getAttribute("data-view"), "grid");
  assert.equal(within(installedTab).queryByText("Experimental"), null);
  assert.ok(within(installedTab).getByText("Marketplace Notes"));
  assert.equal(within(installedTab).queryByText("Reviewed shared notes."), null);
  assert.ok(within(installedTab).getByText("Private Reports"));
  assert.equal(within(installedTab).getAllByText("Published Reports").length, 1);
  assert.equal(within(installedTab).getAllByRole("button", { name: "Edit" }).length, 3);
  assert.equal(within(installedTab).getAllByRole("button", { name: "Uninstall" }).length, 1);
  assert.ok(within(installedTab).getAllByText("This server").length >= 1);
  assert.ok(within(installedTab).getByText("Infrastructure"));
  const installedLink = within(installedTab).getByRole("link", { name: "notes.example.com" });
  assert.equal(installedLink.getAttribute("href"), "https://notes.example.com/app");
  assert.equal(installedLink.getAttribute("target"), "_blank");
  assert.equal(installedLink.getAttribute("rel"), "noreferrer");
  assert.ok(installedLink.classList.contains("inline-flex"));
  assert.ok(installedLink.classList.contains("font-mono"));
  assert.ok(installedLink.classList.contains("mt-1"));
  fireEvent.click(listViewButton);
  assert.ok(
    Array.from(within(installedTab).getByTestId("connected-apps-installed-collection").children)
      .every((card) => card.classList.contains("w-full")),
  );
  assert.ok(within(installedTab).getByText("Reviewed shared notes."));
  fireEvent.click(gridViewButton);
  assert.equal(within(installedTab).queryByText("Reviewed shared notes."), null);

  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.equal(within(myAppsTab).getByTestId("connected-apps-my-apps-collection").getAttribute("data-view"), "grid");
  assert.ok(within(myAppsTab).getByText("Private Reports"));
  assert.ok(within(myAppsTab).getByText("Infrastructure"));
  assert.equal(within(myAppsTab).queryByText("Shared private reporting workflows."), null);
  assert.ok(
    within(myAppsTab)
      .getAllByRole("link", { name: "reports.example.com" })
      .some((link) => link.getAttribute("href") === "https://reports.example.com/private"),
  );
  assert.ok(within(myAppsTab).getByText("Reviewing Reports"));
  assert.equal(within(myAppsTab).queryByText("Source-owned app waiting on marketplace review."), null);
  assert.ok(within(myAppsTab).getByText("Marketplace review is pending. You can edit this app while it waits, or delete it to withdraw the request."));
  assert.ok(within(myAppsTab).getByText("Published Reports"));
  assert.equal(within(myAppsTab).queryByText("Source-owned published marketplace listing."), null);
  assert.ok(within(myAppsTab).getByText("Offline Reports"));
  assert.ok(within(myAppsTab).getByText("Offline requested"));
  assert.ok(within(myAppsTab).getByText("Marketplace offline review is pending. The app stays listed and installable until App Admin approves removal; approval revokes existing server installs and access."));
  assert.equal(within(myAppsTab).getAllByRole("button", { name: "Edit" }).length, 3);
  assert.equal(within(myAppsTab).queryByRole("button", { name: "Delete" }), null);
  assert.equal(within(myAppsTab).queryByRole("button", { name: "Request offline" }), null);

  fireEvent.click(listViewButton);
  assert.equal(within(myAppsTab).getByTestId("connected-apps-my-apps-collection").getAttribute("data-view"), "list");
  assert.ok(
    Array.from(within(myAppsTab).getByTestId("connected-apps-my-apps-collection").children)
      .every((card) => card.classList.contains("w-full")),
  );
  assert.ok(within(myAppsTab).getByText("Shared private reporting workflows."));
  assert.ok(within(myAppsTab).getByText("Source-owned app waiting on marketplace review."));
  assert.ok(within(myAppsTab).getByText("Source-owned published marketplace listing."));
  assert.equal(within(myAppsTab).queryByRole("link", { name: "reports.example.com" }), null);
  assert.ok(within(myAppsTab).getByText("Private Reports"));
  assert.ok(within(myAppsTab).getByText("Private"));
  assert.ok(within(myAppsTab).getAllByRole("button", { name: "Edit" }).length > 0);
  fireEvent.click(gridViewButton);

  fireEvent.click(within(myAppsTab).getAllByRole("button", { name: "Edit" })[0]);
  const editor = await screen.findByTestId("connected-app-editor");
  const editorRail = within(editor).getByTestId("connected-app-editor-rail");
  // The rail's App Notifications status resolves ASYNCHRONOUSLY, after the editor
  // itself mounts. Reading it synchronously here raced that load and produced the
  // intermittent "App NotificationsLoading" vs "App NotificationsOff" failure —
  // rare when this file runs alone, much likelier in the full suite, where the
  // node test runner runs files in parallel and the extra CPU pressure widens the
  // window. `waitFor` retries until it settles; it is not a sleep, and it fails
  // with the same diff if the value never becomes correct.
  await waitFor(() => {
    assert.deepEqual(
      within(editorRail).getAllByRole("button").map((button) => button.textContent?.replace(/\s+/g, " ").trim()),
      [
        "ProfileComplete",
        "Login with RaftOAuth ready",
        "App NotificationsOff",
        "DistributionPrivate",
        "Danger zoneRestricted",
      ],
    );
  });
  assert.ok(within(editor).getByTestId("connected-app-editor-section-profile"));
  assert.ok(within(editor).getByTestId("connected-app-editor-section-login"));
  assert.ok(within(editor).getByTestId("connected-app-editor-section-notifications"));
  assert.ok(within(editor).getByTestId("connected-app-editor-section-distribution"));
  assert.ok(within(editor).getByTestId("connected-app-editor-section-danger"));
  const editorContent = within(editor).getByTestId("connected-app-editor-content");
  editorContent.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  within(editor).getByTestId("connected-app-editor-section-profile").getBoundingClientRect = () => ({ top: -500 } as DOMRect);
  within(editor).getByTestId("connected-app-editor-section-login").getBoundingClientRect = () => ({ top: -100 } as DOMRect);
  within(editor).getByTestId("connected-app-editor-section-notifications").getBoundingClientRect = () => ({ top: 110 } as DOMRect);
  within(editor).getByTestId("connected-app-editor-section-distribution").getBoundingClientRect = () => ({ top: 500 } as DOMRect);
  within(editor).getByTestId("connected-app-editor-section-danger").getBoundingClientRect = () => ({ top: 900 } as DOMRect);
  Object.defineProperties(editorContent, {
    scrollHeight: { configurable: true, value: 2_000 },
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, value: 700, writable: true },
  });
  const notificationsRailButton = within(editorRail).getByRole("button", { name: /^App Notifications/ });
  Object.defineProperties(editorRail, {
    scrollWidth: { configurable: true, value: 900 },
    clientWidth: { configurable: true, value: 300 },
  });
  Object.defineProperties(notificationsRailButton, {
    offsetLeft: { configurable: true, value: 360 },
    offsetWidth: { configurable: true, value: 155 },
  });
  let railScrollLeft: number | undefined;
  editorRail.scrollTo = (options) => {
    if (typeof options === "object") railScrollLeft = options.left;
  };
  fireEvent.scroll(editorContent);
  assert.equal(notificationsRailButton.getAttribute("aria-current"), "true");
  assert.ok(notificationsRailButton.classList.contains("bg-soft-signal"));
  assert.ok((railScrollLeft ?? 0) > 0);
  const dangerRailButton = within(editorRail).getByRole("button", { name: /^Danger zone/ });
  fireEvent.click(dangerRailButton);
  assert.equal(dangerRailButton.getAttribute("aria-current"), "true");
  const deleteCard = within(editor).getByTestId("connected-app-delete-card");
  assert.ok(deleteCard.classList.contains("border-black"));
  assert.ok(deleteCard.classList.contains("shadow-brutal-sm"));
  assert.ok(within(deleteCard).getByText("Delete app"));
  assert.ok(within(deleteCard).getByText("Permanently deletes this app registration and its current credentials."));
  const deleteButton = within(deleteCard).getByRole("button", { name: "Delete" });
  assert.ok(deleteButton.classList.contains("bg-brutal-red"));
  assert.ok(deleteButton.classList.contains("h-7"));
  assert.ok(deleteButton.classList.contains("text-xs"));
  assert.equal(deleteButton.classList.contains("border-brutal-red"), false);
  fireEvent.click(within(editor).getByRole("button", { name: "Close app form" }));

  fireEvent.click(screen.getByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("Marketplace Notes"));
  const privateDetail = await screen.findByText("Requestable (declared)");
  const privateModal = privateDetail.closest(".card-brutal");
  assert.ok(privateModal, "marketplace app detail should open in a modal card");
  assert.ok(within(privateModal as HTMLElement).getByText("100+ installs"));
  assert.ok(within(privateModal as HTMLElement).getByText("Profile"));
  assert.ok(within(privateModal as HTMLElement).getByText("Login with Raft"));
  assert.ok(within(privateModal as HTMLElement).getByText("Distribution"));
  assert.ok(within(privateModal as HTMLElement).getByText("Danger zone"));
  assert.ok(within(privateModal as HTMLElement).getByText("Scopes this app may ask for when a human or agent connects."));
  assert.equal(within(privateModal as HTMLElement).getAllByText("Declared access").length, 1);
  assert.equal(within(privateModal as HTMLElement).queryByText("Read note metadata."), null);
  assert.ok(within(privateModal as HTMLElement).getByText("Productivity & Collaboration · by Notes Workspace"));
  assert.equal(within(privateModal as HTMLElement).getAllByText("Notes Workspace").length, 1);
  assert.equal(within(privateModal as HTMLElement).queryByText("Notes Inc"), null);
  assert.ok(within(privateModal as HTMLElement).getByText("openid"));
  assert.ok(within(privateModal as HTMLElement).getByText("profile"));
  assert.ok(within(privateModal as HTMLElement).getByText("identity"));
  const notificationChip = within(privateModal as HTMLElement).getByText("agent:notification:write");
  assert.equal(
    notificationChip.getAttribute("title"),
    "Sends notification messages to the one agent you authorize.",
  );
  assert.ok(notificationChip.classList.contains("bg-soft-signal/20"));
  assert.ok(within(privateModal as HTMLElement).getByRole("button", { name: "Uninstall from this server" }));
  fireEvent.click(within(privateModal as HTMLElement).getByRole("button", { name: "Close app detail" }));

  fireEvent.click(await screen.findByText("Raft Survey"));
  const sourcePanel = await screen.findByText("Profile");
  const modal = sourcePanel.closest(".card-brutal");
  assert.ok(modal, "built-in details should open in a modal card");
  assert.ok(within(modal as HTMLElement).getByText("Collect meetup responses."));
  assert.ok(within(modal as HTMLElement).getByText("Requestable (declared)"));
  assert.ok(within(modal as HTMLElement).getByText("Scopes this built-in app may ask for when a human or agent connects."));
  assert.ok(within(modal as HTMLElement).getByText("openid"));
  assert.ok(within(modal as HTMLElement).getByText("profile"));
  assert.ok(within(modal as HTMLElement).getByText("identity"));
  const detailLink = within(modal as HTMLElement).getByRole("link", { name: /https:\/\/survey\.slock\.ai/ });
  assert.equal(detailLink.getAttribute("href"), "https://survey.slock.ai");
  assert.equal(detailLink.getAttribute("target"), "_blank");
  assert.equal(detailLink.getAttribute("rel"), "noreferrer");
  assert.ok(detailLink.classList.contains("inline-flex"));
  assert.ok(detailLink.classList.contains("font-mono"));
  const openButton = within(modal as HTMLElement).getByRole("button", { name: "Open" });
  assert.equal(openButton.classList.contains("bg-brutal-pink"), true);
  fireEvent.click(openButton);
  assert.deepEqual(opened, [{ url: "https://survey.slock.ai", target: "_blank", features: "noopener,noreferrer" }]);

  fireEvent.click(within(modal as HTMLElement).getByRole("button", { name: "Close built-in app detail" }));
  fireEvent.click(await screen.findByText("Raft Draft"));
  const draftModal = (await screen.findByText("Not configured")).closest(".card-brutal");
  assert.ok(draftModal, "built-in details without homepage should still show source metadata");
  assert.equal(within(draftModal as HTMLElement).getByRole("button", { name: "Open" }).hasAttribute("disabled"), true);
  fireEvent.click(within(draftModal as HTMLElement).getByRole("button", { name: "Close built-in app detail" }));

  const search = screen.getByRole("searchbox", { name: "Search connected apps" });
  fireEvent.change(search, { target: { value: "Private Reports" } });
  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const filteredInstalledTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(within(filteredInstalledTab).getByText("Private Reports"));
  assert.equal(within(filteredInstalledTab).queryByText("Marketplace Notes"), null);
  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const filteredMyAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(filteredMyAppsTab).getByText("Private Reports"));
  assert.equal(within(filteredMyAppsTab).queryByText("Published Reports"), null);
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

  fireEvent.click(await screen.findByText("Approved Notes"));
  const approvedModal = (await screen.findByText("可请求（已声明）")).closest(".card-brutal") as HTMLElement;
  assert.ok(approvedModal, "approved marketplace app detail should open in a modal card");
  assert.ok(within(approvedModal).getByText("资料"));
  assert.ok(within(approvedModal).getByText("使用 Raft 登录"));
  assert.ok(within(approvedModal).getAllByText("App Notifications").length >= 1);
  assert.ok(within(approvedModal).getByText("分发"));
  assert.ok(within(approvedModal).getByText("危险区"));
  assert.ok(within(approvedModal).getByText("此应用在人类或 Agent 连接时可请求的 scope。"));
  assert.ok(within(approvedModal).getByText("已声明访问"));
  assert.ok(within(approvedModal).getByText("安装后可用的已批准 App Notifications 权限；投递仍需单独启用。"));
  assert.equal(within(approvedModal).queryByText("Permissions this app receives when installed."), null);
  fireEvent.click(within(approvedModal).getByRole("button", { name: "关闭应用详情" }));

  fireEvent.click(await screen.findByText("Pending Notes"));
  const pendingModal = (await screen.findByText("请求的 App Notifications 权限仍在审核中；批准前无法启用投递。")).closest(".card-brutal") as HTMLElement;
  assert.ok(pendingModal, "pending marketplace app detail should open in a modal card");
  assert.ok(within(pendingModal).getByText("App Review 待审核"));
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
        }],
      };
    }
    if (url === "/integrations/built-in") {
      return {
        data: [{
          id: "member-visible-built-in",
          clientId: "member-visible-built-in",
          appType: "slock_builtin",
          name: "Raft Survey",
          description: "Built-in surveys.",
          homepageUrl: "https://survey.raft.test",
          returnUrl: null,
          logoUrl: null,
          category: "Productivity & Collaboration",
          dataAccessSummary: null,
          publisherName: "Raft",
          allowedScopes: ["openid", "profile"],
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        }],
      };
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
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await screen.findByText("Raft Survey");
  const marketplaceTab = screen.getByTestId("connected-apps-marketplace-tab");
  assert.deepEqual(new Set(getCalls), new Set([
    "/integrations/clients",
    "/integrations/built-in",
    "/integrations/marketplace",
    "/integrations/overview",
  ]));
  assert.ok(within(marketplaceTab).getByText("Raft Survey"));
  assert.ok(within(marketplaceTab).getByText("Marketplace Notes"));
  assert.ok(within(marketplaceTab).getByText("Available"));
  assert.equal(screen.queryByRole("button", { name: "Register app" }), null);
  assert.equal(within(marketplaceTab).queryByText("Install", { exact: true }), null);

  fireEvent.click(within(marketplaceTab).getByText("Marketplace Notes"));
  const detail = (await screen.findByText("Profile")).closest(".card-brutal");
  assert.ok(detail);
  assert.ok(within(detail as HTMLElement).getByText("Login with Raft"));
  assert.ok(within(detail as HTMLElement).getByText("Distribution"));
  assert.ok(within(detail as HTMLElement).getByRole("button", { name: "Close" }));
  assert.equal(within(detail as HTMLElement).queryByRole("button", { name: "Install to this server" }), null);

  fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.ok(within(installedTab).getByText("Server Reports"));
  assert.equal(within(installedTab).queryByRole("button", { name: "Edit" }), null);
  assert.equal(within(installedTab).queryByRole("button", { name: "Uninstall" }), null);

  fireEvent.click(screen.getByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(myAppsTab).getByText("Server Reports"));
  assert.ok(within(myAppsTab).getByText("Apps registered by this server are shown here. Only server owners and admins can change them."));
  assert.equal(within(myAppsTab).queryByRole("button", { name: "Edit" }), null);
  assert.equal(within(myAppsTab).queryByRole("button", { name: "Request offline" }), null);
  assert.equal(within(myAppsTab).queryByRole("button", { name: "Delete" }), null);
});

test("Connected Apps edit drawer regenerates a client secret and reveals it once", async () => {
  resetStores();
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
  const postCalls: string[] = [];

  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/private-client/share-link") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  api.post = (async (url: string) => {
    postCalls.push(url);
    if (url === "/integrations/clients/private-client/regenerate-secret") {
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
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0], "/integrations/clients/private-client/regenerate-secret");
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
    if (url === "/integrations/clients/developer-client/share-link") {
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
      assert.equal(body, undefined);
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

  fireEvent.click(await screen.findByRole("button", { name: /Installed Alerts/ }));
  const installSummary = await screen.findByTestId("app-notifications-request-summary");
  assert.ok(within(installSummary).getByText("Server"));
  assert.ok(within(installSummary).getByText("Plan status changed"));
  assert.equal(within(installSummary).queryByRole("checkbox"), null);
  fireEvent.click(screen.getByRole("button", { name: "Close app detail" }));

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  fireEvent.click(within(await screen.findByTestId("connected-apps-my-apps-tab")).getByRole("button", { name: "Edit" }));
  const editor = await screen.findByTestId("connected-app-editor");
  const editorRail = within(editor).getByTestId("connected-app-editor-rail");
  const notificationsSection = within(editor).getByTestId("connected-app-editor-section-notifications");
  const notificationsRailButton = within(editorRail).getByRole("button", { name: /^App Notifications/ });
  const developerPanel = await screen.findByTestId("developer-app-notifications");
  const sourceInstallation = within(developerPanel).getByTestId("app-notifications-source-installation");
  const installationInput = within(sourceInstallation).getByRole("textbox", { name: "Installation ID" }) as HTMLInputElement;
  assert.equal(installationInput.value, "source-installation-1");
  fireEvent.focus(installationInput);
  assert.equal(installationInput.selectionStart, 0);
  assert.equal(installationInput.selectionEnd, installationInput.value.length);
  assert.ok(within(sourceInstallation).getByText("Installed", { exact: true }));
  assert.ok(within(developerPanel).getByText("Pending App Review"));
  assert.ok(within(developerPanel).getByTestId("app-notifications-delivery"));
  assert.match(notificationsRailButton.textContent ?? "", /Off/);
  assert.ok(within(notificationsSection).getByText("Off", { exact: true }));
  assert.equal(within(developerPanel).queryByTestId("app-notifications-permissions"), null);
  const enableSwitch = within(developerPanel).getByRole("switch", { name: "Enable App Notifications" });
  assert.equal(enableSwitch.getAttribute("aria-checked"), "false");
  assert.equal(within(developerPanel).queryByTestId("app-notifications-permission-picker"), null);
  assert.equal(within(developerPanel).queryByPlaceholderText("https://example.com/raft/events"), null);
  fireEvent.click(enableSwitch);
  assert.match(notificationsRailButton.textContent ?? "", /Setup/);
  assert.ok(within(notificationsSection).getByText("Setup", { exact: true }));
  assert.ok(within(developerPanel).getByTestId("app-notifications-permissions"));
  assert.ok(within(developerPanel).getByText("Revision 2 is pending App Review. Current approved permissions remain active until review completes."));
  assert.ok(within(developerPanel).getByText("Plan status changed"));
  fireEvent.change(within(developerPanel).getByPlaceholderText("https://example.com/raft/events"), {
    target: { value: "https://alerts.example.com/raft/events" },
  });
  const saveEndpointButton = within(developerPanel).getByRole("button", { name: "Save endpoint" });
  assert.ok(saveEndpointButton.classList.contains("h-9"));
  fireEvent.click(saveEndpointButton);
  assert.ok(await within(developerPanel).findByText("raft_webhook_secret_shown_once"));
  assert.ok(within(developerPanel).getByText("Signing secret · shown once"));
  await waitFor(() => {
    const currentSwitch = within(developerPanel).getByRole("switch", { name: "Enable App Notifications" });
    assert.equal(currentSwitch.getAttribute("aria-checked"), "true");
    assert.equal(currentSwitch.hasAttribute("data-disabled"), false);
    assert.match(notificationsRailButton.textContent ?? "", /Enabled/);
    assert.ok(within(notificationsSection).getByText("Enabled", { exact: true }));
  });
  await act(async () => {
    fireEvent.click(within(developerPanel).getByRole("switch", { name: "Enable App Notifications" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(within(developerPanel).queryByTestId("app-notifications-configuration"), null);
  assert.equal(disableWebhookCount, 1);
  assert.match(notificationsRailButton.textContent ?? "", /Off/);
  assert.ok(within(notificationsSection).getByText("Off", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Close app form" }));

  fireEvent.click(screen.getByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  assert.equal(within(installedTab).queryByRole("button", { name: /App Notifications/ }), null);
  const installedDetailsTrigger = within(installedTab).getByRole("button", { name: "Installed Alerts" });
  assert.equal(installedDetailsTrigger.getAttribute("tabindex"), "0");
  installedDetailsTrigger.focus();
  assert.equal(document.activeElement, installedDetailsTrigger);
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
  assert.equal(within(installedPanel).queryByRole("checkbox"), null);
  assert.equal(within(installedPanel).queryByText("Manage server approval"), null);
  assert.ok(within(installedPanel).getByText("Approved data, developer subscriptions, and active events for this server."));
  const approvalBanner = within(installedPanel).getByTestId("app-notifications-approval-required");
  assert.ok(within(approvalBanner).getByText("This app requests new data access. Review the new data groups before approving the update."));
  assert.ok(within(approvalBanner).getByText("New data group: Agent"));
  assert.equal(within(approvalBanner).queryByText("New data group: Server"), null);
  fireEvent.click(within(installedPanel).getByRole("button", { name: "Approve update" }));
  await waitFor(() => assert.equal(within(installedPanel).queryByRole("button", { name: "Approve update" }), null));
  fireEvent.click(screen.getByRole("button", { name: "Close installed app details" }));
  fireEvent.click(within(installedTab).getByRole("button", { name: "Uninstall" }));
  assert.ok(await screen.findByText("Uninstall Installed Alerts?"));
  assert.equal(screen.queryByTestId("installed-app-notifications"), null);
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
    if (url === "/integrations/clients/publish-client/share-link") {
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
  assert.equal(screen.queryByText("Declared data access"), null);
  assert.equal(screen.queryByText("Legacy free-text that must not be rendered or resubmitted."), null);
  assert.ok(screen.getByText("Category and data access come from the app metadata and declared scopes above. Requesting review saves those changes first."));

  fireEvent.click(screen.getByRole("button", { name: "Request publish" }));
  await waitFor(() => assert.equal(postCalls.length, 1));
  assert.deepEqual(patchBodies, [{
    name: "Storage Publisher",
    description: "Publishes stored reports.",
    homepageUrl: "https://storage.example.com",
    returnUrl: "https://storage.example.com/callback",
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "agent:event:write"],
    category: "Infrastructure",
  }]);
  assert.deepEqual(postCalls, [{ url: "/integrations/clients/publish-client/request-publish", body: undefined }]);
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

  fireEvent.click(await screen.findByRole("button", { name: "Register app" }));
  const editorRail = within(screen.getByTestId("connected-app-editor")).getByTestId("connected-app-editor-rail");
  assert.ok(within(editorRail).getByRole("button", { name: /App Notifications.*Save app first/ }));
  const picker = await screen.findByTestId("connected-app-declared-scopes");
  assert.ok(within(picker).getByText("Declared scopes"));
  assert.ok(within(picker).getByText("Choose what this app may request. Existing connections keep granted scopes until they reconnect or are revoked."));
  assert.ok(within(picker).getByText("Identity"));
  assert.ok(within(picker).getByText("openid"));
  assert.ok(within(picker).getByText("profile"));
  assert.ok(within(picker).getByText("identity"));
  const emailScope = within(picker).getByLabelText("email") as HTMLInputElement;
  assert.equal(emailScope.checked, false);
  fireEvent.click(emailScope);
  assert.equal(emailScope.checked, true);
  assert.ok(within(picker).getByText("Agent messaging"));
  assert.ok(within(picker).getByLabelText("agent:event:write"));
  assert.ok(within(picker).getByLabelText("agent:notification:write"));
  assert.equal(within(picker).queryByText("Requires resource: this server's agent inbound."), null);

  fireEvent.click(within(picker).getByLabelText("agent:event:write"));
  assert.ok(await within(picker).findByText("Requires resource: this server's agent inbound."));

  fireEvent.click(within(picker).getByLabelText("agent:notification:write"));
  assert.ok(within(picker).getByText("Requires resource: this server's agent inbound."));

  fireEvent.click(within(picker).getByLabelText("agent:event:write"));
  assert.ok(within(picker).getByText("Requires resource: this server's agent inbound."));

  fireEvent.click(within(picker).getByLabelText("agent:notification:write"));
  assert.equal(within(picker).queryByText("Requires resource: this server's agent inbound."), null);
});

test("Connected Apps retries permissions without recreating an app or losing its show-once secret", async () => {
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
    if (url === "/integrations/clients/created-client/share-link") {
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
  api.post = (async (url: string) => {
    assert.equal(url, "/integrations/clients");
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
    assert.deepEqual(body, { groups: ["server"], events: [] });
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

  fireEvent.click(await screen.findByRole("button", { name: "Register app" }));
  fireEvent.change(screen.getByPlaceholderText("db9 Cloud Drive"), { target: { value: "Created Alerts" } });
  const registrationPanel = screen.getByTestId("developer-app-notifications");
  const unavailableSwitch = within(registrationPanel).getByRole("switch", { name: "Enable App Notifications" });
  assert.equal(unavailableSwitch.hasAttribute("data-disabled"), true);
  assert.ok(within(registrationPanel).getByText("Save the app before enabling its webhook."));
  assert.equal(within(registrationPanel).queryByTestId("app-notifications-permission-picker"), null);
  const registrationForm = registrationPanel.closest("form");
  assert.ok(registrationForm);
  fireEvent.click(within(registrationForm).getByRole("button", { name: "Register app" }));

  assert.ok(await screen.findByText("raft_secret_create_once"));
  assert.equal(createCount, 1);
  assert.equal(permissionCount, 0);

  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myAppsTab).getByRole("button", { name: "Edit" }));
  const editPanel = await screen.findByTestId("developer-app-notifications");
  const enableSwitch = within(editPanel).getByRole("switch", { name: "Enable App Notifications" });
  await waitFor(() => assert.equal(enableSwitch.hasAttribute("data-disabled"), false));
  fireEvent.click(enableSwitch);
  const notificationPicker = await within(editPanel).findByTestId("app-notifications-permission-picker");
  fireEvent.click(within(notificationPicker).getByText("Server"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  assert.ok(await screen.findByText("permission write failed"));
  assert.ok(screen.getByText("raft_secret_create_once"));
  assert.equal(createCount, 1);
  assert.equal(permissionCount, 1);

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(permissionCount, 2));
  assert.equal(createCount, 1);
  assert.equal(patchCount, 2);
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
  assert.ok(screen.getByText("Login with"));
  assert.equal(screen.queryByText("Experimental"), null);

  assert.ok((await screen.findAllByText("Orbital Notes")).length >= 2);
  const description = screen.getByText("Review launch notes from Raft.");
  assert.equal(description.getAttribute("class"), "text-xs text-black/60");
  assert.equal(screen.queryByText("https://orbital.example.com/docs"), null);
  const detailLink = screen.getByRole("link", { name: "Open Orbital Notes" });
  assert.equal(detailLink.getAttribute("href"), "https://orbital.example.com/docs");
  assert.equal(detailLink.getAttribute("target"), "_blank");
  assert.equal(detailLink.getAttribute("rel"), "noreferrer");
  assert.equal(detailLink.getAttribute("title"), null);
  assert.equal(detailLink.classList.contains("hover:shadow-brutal"), true);

  const logo = document.querySelector('img[src="https://cdn.example.com/orbital-notes.png"]');
  assert.equal(logo?.getAttribute("class"), "relative z-[1] h-full w-full object-cover");

  const loginButton = screen.getByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(loginButton.disabled, false));
  assert.equal(loginButton.classList.contains("btn-brutal-sm"), true);
  assert.equal(loginButton.classList.contains("bg-brutal-pink"), true);
  assert.equal(loginButton.classList.contains("bg-soft-signal"), false);
  assert.equal(document.querySelector('button img[src="/brand/raft-logo.svg"]'), null);
  assert.equal(document.querySelector('button source[srcset="/brand/raft-logo-mono-light.svg"]'), null);
  assert.equal(loginButton.parentElement?.classList.contains("justify-end"), true);

  const backLink = screen.getByRole("link", { name: "Back" });
  assert.equal(backLink.classList.contains("btn-flat-sm"), true);
  assert.equal(backLink.classList.contains("underline"), false);
  const logoutButton = screen.getByRole("button", { name: "Log out" });
  assert.equal(logoutButton.classList.contains("btn-brutal-sm"), true);

  api.post = (async () => new Promise(() => {})) as typeof api.post;
  fireEvent.click(screen.getByRole("button", { name: "Login with Raft" }));
  assert.ok(await screen.findByRole("button", { name: "Continuing..." }));
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
        availability: "install_required",
        installation: { serverId, canInstall: serverId === adminServer.id },
      },
    };
  }) as typeof api.get;
  const postUrls: string[] = [];
  let resolveInstall!: () => void;
  const pendingInstall = new Promise<{ data: { installed: true } }>((resolve) => {
    resolveInstall = () => resolve({ data: { installed: true } });
  });
  api.post = (async (url: string) => {
    postUrls.push(url);
    if (url === "/integrations/marketplace/app-1/install") {
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
  assert.equal(installed.getAttribute("title"), "Installed and ready to use.");
  assert.equal(within(installed).queryByText("Installed"), null);
  assert.equal(installed.getAttribute("aria-label"), "Use this Server: Launch Server");
  assert.equal(installed.parentElement?.parentElement?.classList.contains("bg-brutal-cyan/15"), true);
  assert.match(screen.getByTestId("marketplace-login-commit-zone").textContent ?? "", /Selected Launch Server\./);
  assert.ok(screen.getByRole("button", { name: "Continue login" }));
  const installable = screen.getByTestId("login-server-status-server-2");
  assert.equal(installable.getAttribute("title"), "Not installed on this Server. You can install it here.");
  assert.ok(within(installable).getByText("Not installed"));
  fireEvent.click(installable);
  assert.equal(installed.parentElement?.parentElement?.classList.contains("bg-brutal-cyan/15"), false);
  assert.equal(installable.parentElement?.parentElement?.classList.contains("bg-brutal-cyan/15"), true);
  assert.match(screen.getByTestId("marketplace-login-commit-zone").textContent ?? "", /Build Server has not installed Orbital Notes/);
  assert.ok(screen.getByText("Access granted: openid · profile"));
  fireEvent.click(screen.getByRole("button", { name: "Install and continue" }));
  await waitFor(() => assert.deepEqual(postUrls, ["/integrations/marketplace/app-1/install"]));
  const pendingCommitZone = screen.getByTestId("marketplace-login-commit-zone");
  assert.equal(pendingCommitZone.getAttribute("aria-busy"), "true");
  const pendingButton = screen.getByRole("button", { name: "Installing and continuing..." }) as HTMLButtonElement;
  assert.equal(pendingButton.disabled, true);
  assert.ok(screen.getByTestId("marketplace-install-pending-row-spinner"));
  assert.ok(screen.getByTestId("marketplace-install-pending-button-spinner"));
  assert.equal((screen.getByRole("searchbox", { name: "Search Servers" }) as HTMLInputElement).disabled, true);
  assert.equal(installed.getAttribute("aria-disabled"), "true");
  assert.equal((installed as HTMLButtonElement).disabled, true);
  fireEvent.click(installed);
  fireEvent.click(pendingButton);
  assert.equal(installed.parentElement?.parentElement?.classList.contains("bg-brutal-cyan/15"), false);
  assert.equal(installable.parentElement?.parentElement?.classList.contains("bg-brutal-cyan/15"), true);
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
  assert.equal(within(installedAfterClick).queryByText("Not installed"), null);
  assert.equal(installedAfterClick.getAttribute("aria-label"), "Use this Server: Build Server");
  const memberOnly = screen.getByTestId("login-server-status-server-3");
  assert.equal(memberOnly.getAttribute("title"), "Not installed on this Server. Ask a Server owner or admin to install it.");
  assert.ok(within(memberOnly).getByText("Admin needed"));
  fireEvent.click(memberOnly);
  assert.match(screen.getByTestId("marketplace-login-commit-zone").textContent ?? "", /Only an owner or admin of this Server can install it/);
  assert.equal(screen.queryAllByRole("button", { name: "Continue login" }).length, 0);
  const findAdmin = screen.getByRole("link", { name: "Find a Server admin" });
  assert.equal(findAdmin.getAttribute("href"), "/s/member/members");
  assert.ok(findAdmin.classList.contains("btn-brutal-sm"));
  assert.ok(findAdmin.classList.contains("bg-white"));
  assert.ok(findAdmin.classList.contains("shadow-brutal-sm"));
  const unavailable = screen.getByTestId("login-server-status-server-4");
  assert.equal(unavailable.getAttribute("title"), "Installation status could not be loaded. Reload this page to try again.");
  assert.ok(within(unavailable).getByText("Unavailable"));
  assert.equal(screen.getAllByTestId(/^login-server-status-/).length, 22);
  const search = screen.getByRole("searchbox", { name: "Search Servers" });
  fireEvent.change(search, { target: { value: "member" } });
  assert.ok(screen.getByTestId("login-server-status-server-3"));
  assert.equal(screen.queryByTestId("login-server-status-server-1"), null);
  fireEvent.change(search, { target: { value: "missing" } });
  assert.ok(screen.getByText("No Servers match your search."));
  assert.ok(screen.getByText("All Raft Servers you can access are shown here. Continue with an installed Server, or install the App where you have permission."));
  assert.equal(screen.queryByText(/none of your accessible Servers has installed/), null);
  assert.equal(screen.queryByRole("button", { name: "Login with Raft" }), null);
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
  assert.equal(within(requested).queryByText(/Treated as untrusted/), null);
  assert.ok(within(requested).getByText(enMessages["oauth.consent.agentLoginRequiredNotice"]));
  assert.ok(within(requested).getByText("Unrecognized scopes:"));
  assert.ok(within(requested).getByText("agent:action_request:write"));
  assert.equal(within(requested).getAllByText("unknown").length, 1);

  const button = await screen.findByRole("button", { name: "Login with Raft" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.equal(screen.queryByText("Agent messaging access requires Raft Agent Login."), null);
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

test("private app invite page shows requested scopes like Login with Raft setup", async () => {
  resetStores();

  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") {
      return {
        data: {
          client: {
            id: "client-1",
            clientId: "orbital-notes",
            name: "Orbital Notes",
            description: "Review launch notes from Raft.",
            homepageUrl: "https://orbital.example.com/docs",
            returnUrl: "https://orbital.example.com/return",
            allowedScopes: ["openid", "profile", "identity", "agent:event:write", "agent:notification:write"],
            logoUrl: null,
            publisherName: "Orbital",
            sourceServerName: "Publisher Server",
            installedAt: null,
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
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/integration-invites/share-token"]}>
        <Routes>
          <Route path="/integration-invites/:token" element={<IntegrationInvitePage />} />
        </Routes>
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const page = await screen.findByTestId("integration-invite-page");
  assert.ok(page.className.includes("h-full"));
  assert.ok(page.className.includes("overflow-y-auto"));
  const requested = await screen.findByTestId("login-with-raft-requested-scopes");
  assert.ok(within(requested).getByText("Requested access"));
  assert.ok(within(requested).getByText("Identity"));
  assert.ok(within(requested).getByText("Agent messaging"));
  assert.ok(within(requested).getByText("openid"));
  assert.ok(within(requested).getByText("profile"));
  assert.ok(within(requested).getByText("identity"));
  assert.ok(within(requested).getByText("agent:event:write"));
  assert.ok(within(requested).getByText("agent:notification:write"));
  assert.ok(within(requested).getByText("Sends structured event messages to the one agent you authorize."));
  assert.ok(within(requested).getByText("Sends notification messages to the one agent you authorize."));
  assert.equal(within(requested).queryByText(/Treated as untrusted/), null);
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
  assert.equal(document.querySelector('img[src="https://cdn.example.com/orbital-notes.png"]'), null);
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
  assert.equal(document.querySelector("pre"), null);
  fireEvent.click(screen.getByRole("button", { name: "Login with Raft" }));

  const status = await screen.findByText("Failed to continue with Raft.");
  assert.equal(status.tagName, "PRE");
  assert.equal(status.getAttribute("class"), "mt-4 min-h-16 overflow-auto bg-black p-3 text-xs text-white");
});
