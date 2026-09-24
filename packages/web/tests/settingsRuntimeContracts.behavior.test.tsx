import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import SettingsNavList from "../src/components/settings/SettingsNavList";
import SettingsPanel, { PlanSection } from "../src/components/settings/SettingsPanel";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_NAV_LABEL_ID,
  SETTINGS_TAB_TITLE_ID,
  canOpenSettingsTab,
} from "../src/components/settings/settingsNavigation";
import { getServerCapabilities } from "@botiverse/raft-shared";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;

window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  window.history.pushState({}, "", "/");
});

function seedSettings({ loadingBilling = false, role = "owner" }: { loadingBilling?: boolean; role?: "owner" | "admin" | "member" } = {}) {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "u@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
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
    servers: [{ id: "server-1", slug: "raft", name: "Raft", role }],
    current: {
      id: "server-1",
      slug: "raft",
      name: "Raft",
      role,
      plan: "free",
      planDowngradedAt: null,
    },
    members: [],
    loading: false,
    usage: null,
    billing: null,
    loadingUsage: loadingBilling,
    loadingBilling,
    loadUsage: async () => {},
    loadBilling: async () => {},
  } as never);
}

function renderZh(node: ReactNode) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>{node}</MemoryRouter>
    </TestIntlProvider>,
  );
}

function renderEn(node: ReactNode) {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </TestIntlProvider>,
  );
}

test("every settings tab has a nav label and a header title in both catalogs", () => {
  const ids = SETTINGS_TABS.map((tab) => tab.id);
  assert.ok(ids.length >= 12, `expected the full tab set, got ${ids.length}`);
  for (const id of ids) {
    for (const [which, map] of [
      ["nav", SETTINGS_TAB_NAV_LABEL_ID],
      ["title", SETTINGS_TAB_TITLE_ID],
    ] as const) {
      const messageId = map[id];
      assert.ok(messageId, `${id}: no ${which} message id`);
      assert.ok(en[messageId], `${id}: ${which} id ${messageId} missing from en`);
      assert.ok(zh[messageId], `${id}: ${which} id ${messageId} missing from zh`);
    }
  }
});

test("the settings host marker exposes the raw tab id, not localized display copy", () => {
  seedSettings();
  renderZh(<SettingsPanel tab="about" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.equal(header.getAttribute("data-slock-settings-tab"), "about");
  assert.notEqual(header.getAttribute("data-slock-settings-tab"), "关于");
});

test("member direct routes cannot open billing or administration settings", () => {
  const capabilities = getServerCapabilities("member");
  assert.equal(canOpenSettingsTab("billing", capabilities), false);
  assert.equal(canOpenSettingsTab("administration", capabilities), false);
  assert.equal(canOpenSettingsTab("server", capabilities), true);
});

test("Guest settings hide Applications and MCP without hiding personal settings", () => {
  const capabilities = getServerCapabilities("guest");
  assert.equal(canOpenSettingsTab("integrations", capabilities, "guest"), false);
  assert.equal(canOpenSettingsTab("mcp", capabilities, "guest"), false);
  assert.equal(canOpenSettingsTab("account", capabilities, "guest"), true);
  assert.equal(canOpenSettingsTab("integrations", getServerCapabilities("member"), "member"), true);
});

test("billing renders a busy skeleton surface until both usage and billing resolve", () => {
  seedSettings({ loadingBilling: true });
  const { container } = renderEn(<PlanSection />);

  const busy = container.querySelector<HTMLElement>('[aria-busy="true"]');
  assert.ok(busy, "billing loading region should announce itself as busy");
  assert.ok(within(busy).getByText("Plan & Billing"));
  assert.ok(within(busy).getByText("Manage Plan"));
  assert.ok(
    busy.querySelectorAll('[aria-hidden="true"].animate-pulse').length >= 12,
    "the loading surface should reserve the loaded billing-card geometry",
  );

  act(() => {
    useServerStore.setState({ loadingUsage: false, loadingBilling: false });
  });
  assert.equal(container.querySelector('[aria-busy="true"]'), null);
  assert.equal(container.querySelector('[aria-hidden="true"].animate-pulse'), null);
});

test("the mounted free-plan notice renders the global last active trial day", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-22T12:00:00.000Z") });
  seedSettings();
  renderEn(<PlanSection />);

  assert.ok(screen.getByText("Final Trial Period"));
  assert.ok(screen.getByText(/Full-featured free trial remains active through Jun 22, 2026/));
});

test("the About nav item and panel header both resolve through the zh catalog", () => {
  seedSettings();
  renderZh(
    <>
      <SettingsNavList activeTab="about" onSelect={() => {}} />
      <SettingsPanel tab="about" />
    </>,
  );

  const nav = screen.getByTestId("workspace-settings-navigation");
  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(nav).getByText("关于"), "sidebar nav resolves SETTINGS_TAB_NAV_LABEL_ID.about");
  assert.ok(within(header).getByText("关于"), "panel header resolves SETTINGS_TAB_TITLE_ID.about");
  assert.equal(within(nav).queryByText("About"), null);
  assert.equal(within(header).queryByText("About"), null);
});
