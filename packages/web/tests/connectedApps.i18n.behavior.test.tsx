import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  window.localStorage.removeItem("raft:connected-apps:view-mode");
});

test("catalog pins connected-apps read-only MessageIds", () => {
  assert.equal(
    en["settings.connectedApps.myAppsReadOnlyIntro"],
    "Apps registered by this server are shown here. Only server owners and admins can change them.",
  );
  assert.equal(
    en["settings.connectedApps.noRegisteredAppsMatch"],
    "No registered apps match this view.",
  );
  assert.match(zh["settings.connectedApps.myAppsReadOnlyIntro"], /\p{Script=Han}/u);
  assert.match(zh["settings.connectedApps.noRegisteredAppsMatch"], /\p{Script=Han}/u);
  assert.equal(en["settings.connectedApps.marketplaceNew"], "New");
  assert.equal(en["settings.connectedApps.marketplaceInstallCount"], "{count} installs");
  assert.equal(zh["settings.connectedApps.marketplaceNew"], "新上架");
  assert.equal(zh["settings.connectedApps.marketplaceInstallCount"], "{count} 个有效安装");
});

test("SettingsPanel renders connected-apps member copy from the zh-cn catalog", async () => {
  useAuthStore.setState({
    user: {
      id: "member-1",
      email: "member@example.com",
      name: "Member",
      displayName: "Member",
      avatarUrl: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{
      id: "server-1",
      name: "Launch Server",
      avatarUrl: null,
      slug: "launch",
      ownerId: "server-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-06-25T00:00:00.000Z",
    }],
    current: {
      id: "server-1",
      name: "Launch Server",
      avatarUrl: null,
      slug: "launch",
      ownerId: "server-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-06-25T00:00:00.000Z",
    },
    members: [],
    loading: false,
  } as never);

  api.get = (async (url: string) => {
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
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  assert.ok(within(myAppsTab).getByText(zh["settings.connectedApps.myAppsReadOnlyIntro"]));

  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing app" } });
  assert.ok(within(myAppsTab).getByText(zh["settings.connectedApps.noRegisteredAppsMatch"]));
  assert.doesNotMatch(myAppsTab.textContent ?? "", /Apps registered by this server|No registered apps match/);
});
