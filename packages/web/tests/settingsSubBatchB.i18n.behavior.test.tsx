import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

// Settings sub-batch B (react-intl migration acceptance): the Notifications /
// Server Profile / Administration / Connected Apps sections must render the
// AngLee-reviewed Chinese copy when the active display locale is zh-cn. Same
// teeth as settingsSubBatchA.i18n.behavior.test.tsx — LocaleProvider →
// IntlProviderWrapper resolves the active locale from storage, and these render
// assertions are the regression backstop that the migrated
// `settings.notifications.*`, `settings.serverProfile.*`, `settings.dangerZone.*`,
// the administration sub-object ids, and `settings.connectedApps.*` are actually
// wired to their call sites (not left as hardcoded English).

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null } as never);
  try {
    window.localStorage.clear();
  } catch {
    // ignore storageless environments
  }
});

function seed() {
  // Neutral loaders so the sections mount without a live backend; the static
  // section chrome we assert on renders synchronously regardless.
  api.get = (async () => ({ data: [] })) as typeof api.get;
  // The Notifications tab embeds the PWA install card, which probes
  // window.matchMedia on mount; the node DOM harness does not provide it.
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
      id: "user-1", email: "u@example.com", gravatarHash: "", name: "U", displayName: "U",
      description: null, avatarUrl: null, emailVerified: true,
      preferredLanguage: null, displayLanguage: null, preferredTimezone: null,
      autoTranslationEnabled: false, preferredTranslationDisplay: "translated",
      preferredTimeFormat: null, preferredMessageBodyFontSize: null,
      referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
    },
    loading: false, initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1", role: "owner" }],
    current: { id: "s1", slug: "s1", name: "S1", role: "owner" },
    members: [], loading: false,
  } as never);
}

function renderInZh(node: ReactElement) {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "zh-cn");
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>{node}</MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

test("the Notifications tab renders its migrated Chinese tab label + section copy", () => {
  seed();
  renderInZh(<SettingsPanel tab="notifications" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("通知"), "notifications tab label");

  // settings.notifications.sectionLabel + mainTitle.
  assert.ok(screen.getByText("推送通知"), "push notifications section label");
  assert.ok(screen.getByText("私信、直接提及以及已关注消息列的回复"), "notifications main title");
});

test("the Server Profile tab renders migrated Chinese profile + danger-zone copy", () => {
  seed();
  renderInZh(<SettingsPanel tab="server" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("服务器资料"), "server tab label");

  // settings.serverProfile.sectionLabel = 资料.
  assert.ok(screen.getByText("资料", { exact: true }), "profile section label");
  // settings.dangerZone.* section under the same tab. "删除服务器" appears twice
  // (deleteServerTitle + the button), so assert the unique description instead.
  assert.ok(screen.getByText("危险区域"), "danger zone section label");
  assert.ok(screen.getByText("永久删除此服务器及其所有数据。此操作无法撤销。"), "delete server description");
});

test("the Administration tab renders migrated Chinese section copy", () => {
  seed();
  renderInZh(<SettingsPanel tab="administration" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("管理"), "administration tab label");

  // settings.serverTranslation.* + settings.memberPermissions.* render for any
  // server (independent of capability gating).
  assert.ok(screen.getByText("翻译", { exact: true }), "translation section label");
  assert.ok(screen.getByText("为此服务器启用消息翻译"), "server translation enable title");
  assert.ok(screen.getByText("成员权限"), "member permissions section label");
});

test("the Applications tab renders migrated Chinese integrations copy", () => {
  seed();
  renderInZh(<SettingsPanel tab="integrations" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("应用"), "integrations tab label");

  // settings.connectedApps.title + the marketplace review note (default tab).
  assert.ok(screen.getByText("此服务器的第三方应用"), "connected apps title");
  assert.ok(screen.getByText("Raft 会在每个第三方应用出现在市场之前进行审核。"), "marketplace review note");
});
