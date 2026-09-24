import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import SettingsPanel, { AccountSection } from "../src/components/settings/SettingsPanel";
import SettingsNavList from "../src/components/settings/SettingsNavList";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useAppearanceStore } from "../src/store/appearanceStore";

// Settings sub-batch A (react-intl migration acceptance): the Settings NAV/tab
// labels + the Account / Language & Region / Appearance sections must render the
// AngLee-reviewed Chinese copy when the active display locale is zh-cn. This
// mirrors the zh-coverage-notice teeth in displayLanguageLoop.behavior.test.tsx
// (LocaleProvider → IntlProviderWrapper → active locale resolved from storage),
// and is the regression backstop that the migrated `settings.tabs.*`,
// `settings.common.*`, `settings.account.*`, `settings.language.*`, and
// `settings.appearance.*` ids are actually wired to their call sites (not left
// as hardcoded English). Two DISTINCT nav maps are covered by two distinct teeth:
// the SettingsPanel panel-header title (`SETTINGS_TAB_TITLE_ID`) via the section
// tests below, and the desktop sidebar nav (`SETTINGS_TAB_NAV_LABEL_ID`) via a
// dedicated `SettingsNavList` render — they are not the same map, so the header
// test does NOT stand in for nav coverage.
//
// The desktop nav lives inside WorkspaceSettingsModal, which also renders the
// full SettingsPanel (whose account tab reads the Vite-only `import.meta.env.DEV`
// graph the node harness cannot shim). So the nav is extracted into the pure
// `SettingsNavList` and rendered directly here — same production
// `SETTINGS_TAB_NAV_LABEL_ID` + formatMessage, no test-only path. The Account
// section is likewise rendered via the exported `AccountSection` for the same
// import.meta reason.

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null } as never);
  useAppearanceStore.setState({ showLiveAgentActivityBar: true });
  try {
    window.localStorage.clear();
  } catch {
    // ignore storageless environments
  }
});

function seedUser() {
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
}

function seedServer() {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1" }], current: { id: "s1", slug: "s1", name: "S1" },
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

test("the Language & Region tab renders its migrated Chinese tab label + section copy", () => {
  seedUser();
  seedServer();
  renderInZh(<SettingsPanel tab="language-region" />);

  // Panel header title = settings.tabs.languageRegion (nav/tab label mapping).
  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("语言与区域"), "language & region tab label");

  // settings.language.sectionLabel (exact, so it does not match 语言与区域).
  assert.ok(screen.getByText("语言", { exact: true }), "language section label");
  assert.ok(screen.getByText("手动", { exact: true }), "manual translation mode label");
  // settings.common.save reused by the section's Save button(s).
  assert.ok(screen.getAllByText("保存").length > 0, "save button");
});

test("the Appearance tab renders its migrated Chinese tab label + section copy", async () => {
  seedUser();
  seedServer();
  renderInZh(<SettingsPanel tab="appearance" />);

  const header = screen.getByTestId("settings-panel-header");
  assert.ok(within(header).getByText("外观"), "appearance tab label");

  assert.ok(screen.getByText("消息字号"), "message font size title");
  assert.ok(screen.getAllByText("已保存到此设备。").length >= 2, "saved-on-device hints");
  assert.ok(screen.getByText("预览"), "preview label");

  const activityToggle = screen.getByRole("switch", { name: /实时 Agent 动态/ });
  assert.equal(activityToggle.getAttribute("aria-checked"), "true");
  assert.ok(screen.getByText("在侧栏底部和移动端标签栏上方显示最新的 Agent 状态。"));

  fireEvent.click(activityToggle);
  assert.equal(useAppearanceStore.getState().showLiveAgentActivityBar, false);
  assert.equal(activityToggle.getAttribute("aria-checked"), "false");
  assert.equal(document.querySelector('[data-slot="toast-viewport"]'), null, "appearance preference changes should not show a toast");
});

test("the Account section renders migrated Chinese copy", () => {
  seedUser();
  seedServer();
  renderInZh(<AccountSection />);

  // settings.account.sectionLabel (= 账户, identical to the tabs.account label).
  assert.ok(screen.getAllByText("账户").length > 0, "account section label");
  assert.ok(screen.getByText("显示名称"), "display name label");
  assert.ok(screen.getByText("邮箱"), "email label");
  assert.ok(screen.getByText("已验证"), "verified badge");
  assert.ok(screen.getByText("保存资料"), "save profile button");
  assert.ok(screen.getByText("修改密码"), "change password toggle");
});

test("the desktop settings sidebar nav (SETTINGS_TAB_NAV_LABEL_ID) renders migrated Chinese labels", () => {
  // Real nav runtime evidence: render the pure SettingsNavList (the exact
  // sidebar WorkspaceSettingsModal mounts), which consumes the production
  // SETTINGS_TAB_NAV_LABEL_ID map + formatMessage — NOT the panel-header title
  // map. Distinct from the section tests above.
  renderInZh(<SettingsNavList activeTab="account" onSelect={() => {}} />);
  const nav = screen.getByTestId("workspace-settings-navigation");
  // Migrated in sub-batch H1: this is a zh render test, so the nav's accessible
  // name must now be Chinese too — it previously asserted the un-migrated English.
  assert.equal(nav.getAttribute("aria-label"), "设置分区");
  // Item labels resolve via SETTINGS_TAB_NAV_LABEL_ID → settings.tabs.* (zh-cn).
  for (const zh of ["账户", "语言与区域", "外观", "通知", "服务器资料", "Wiki 设置", "账单", "管理", "应用", "MCP 服务器"]) {
    assert.ok(within(nav).getByText(zh), `nav label ${zh}`);
  }
});
