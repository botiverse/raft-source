import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import SettingsPanel, { DeclaredScopesPicker } from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { useAgentStore } from "../src/store/agentStore";

const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;
const en = enMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
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
      gravatarHash: "",
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
      preferredTimeFormat: "24h",
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

function renderPanel(tab: "language-region" | "administration" | "integrations") {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <SettingsPanel tab={tab} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("Connected Apps scope headings render identity before agent messaging", () => {
  render(
    <TestIntlProvider locale="en">
      <DeclaredScopesPicker value={[]} onChange={() => {}} />
    </TestIntlProvider>,
  );
  const identity = screen.getByText(en["settings.connectedApps.identitySection"]);
  const agentMessaging = screen.getByText(en["settings.connectedApps.agentMessagingSection"]);
  assert.ok(
    Boolean(identity.compareDocumentPosition(agentMessaging) & Node.DOCUMENT_POSITION_FOLLOWING),
    "identity heading must precede agent messaging",
  );
});

test("a failed language-region save surfaces the language fallback, not the date-time one", async () => {
  seedOwner();
  api.patch = (async () => {
    throw new Error("network blip");
  }) as typeof api.patch;

  renderPanel("language-region");
  fireEvent.click(await screen.findByTestId("translation-mode-manual"));
  const saveButtons = screen.getAllByRole("button", { name: en["settings.common.save"] });
  const languageSave = saveButtons[0] as HTMLButtonElement;
  await waitFor(() => assert.equal(languageSave.disabled, false));
  fireEvent.click(languageSave);

  assert.ok(await screen.findByText(en["settings.language.updateFailed"]));
  assert.equal(screen.queryByText(en["settings.dateTime.updateFailed"]), null);
});

test("a failed date-time save surfaces the date-time fallback, not the language one", async () => {
  seedOwner();
  api.patch = (async () => {
    throw new Error("network blip");
  }) as typeof api.patch;

  renderPanel("language-region");
  fireEvent.click(await screen.findByTestId("time-format-12h"));
  const saveButtons = screen.getAllByRole("button", { name: en["settings.common.save"] });
  const dateTimeSave = saveButtons[saveButtons.length - 1] as HTMLButtonElement;
  await waitFor(() => assert.equal(dateTimeSave.disabled, false));
  fireEvent.click(dateTimeSave);

  assert.ok(await screen.findByText(en["settings.dateTime.updateFailed"]));
  assert.equal(screen.queryByText(en["settings.language.updateFailed"]), null);
});

test("reopening server setup surfaces the onboarding fallback when the transition fails", async () => {
  seedOwner();
  api.get = (async (url: string) => {
    if (url === "/servers/s1/settings") {
      return {
        data: {
          settings: {
            onboardSettings: { onboardingAgentId: null, agentAllChannelGreetingEnabled: true },
          },
        },
      };
    }
    if (url === "/servers/s1/setup-projection") {
      return { data: { surface: "create_agent", phase: "deferred" } };
    }
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (String(url).includes("/setup-transition")) throw new Error("setup down");
    return { data: {} };
  }) as typeof api.post;

  renderPanel("administration");
  fireEvent.click(await screen.findByTestId("finish-server-setup"));
  assert.ok(await screen.findByText(en["settings.onboarding.reopenSetupFailed"]));
});

test("a failed marketplace unpublish request surfaces the marketplace fallback, not the regenerate one", async () => {
  seedOwner();
  const client = {
    id: "public-client",
    clientId: "public-client",
    appType: "server_local",
    name: "Public Reports",
    description: "Shared public reporting workflows.",
    homepageUrl: "https://reports.example.com/public",
    returnUrl: "https://reports.example.com/callback",
    logoUrl: null,
    publishStatus: "published",
    category: "Productivity & Collaboration",
    dataAccessSummary: null,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile", "identity"],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  };
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/public-client/share-link") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/integrations/clients/public-client/request-unpublish") throw new Error("review down");
    return { data: {} };
  }) as typeof api.post;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myAppsTab).getByRole("button", { name: "Edit" }));
  fireEvent.click(await screen.findByRole("button", { name: en["settings.connectedApps.editor.requestOffline"] }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: en["settings.connectedApps.editor.requestOffline"] }));
  assert.ok(await screen.findByText(en["settings.connectedApps.marketplaceReviewFailed"]));
  assert.equal(screen.queryByText(en["settings.connectedApps.regenerateSecretFailed"]), null);
});

test("a failed client-secret regenerate surfaces the regenerate fallback", async () => {
  seedOwner();
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
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [client] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/private-client/share-link") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/integrations/clients/private-client/regenerate-secret") throw new Error("rotate failed");
    return { data: {} };
  }) as typeof api.post;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myAppsTab).getByRole("button", { name: "Edit" }));
  fireEvent.click(await screen.findByTestId("connected-app-regenerate-secret-button"));
  fireEvent.click(await screen.findByTestId("connected-app-regenerate-secret-confirm-button"));
  assert.ok(await screen.findByText(en["settings.connectedApps.regenerateSecretFailed"]));
});
