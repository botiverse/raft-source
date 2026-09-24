import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import { AccountSection, AboutSection } from "../src/components/settings/SettingsPanel";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { WEB_APP_VERSION } from "../src/utils/webAppVersion";

// Settings sub-batch C (react-intl migration acceptance): the RESIDUE sweep over
// SettingsPanel.tsx after sub-batches A and B. A and B migrated whole sections;
// what was left behind was a scatter of individual strings the earlier passes
// missed. This file is the regression backstop for that residue, covering three
// call-site families that no earlier sub-batch renders:
//
//   1. AccountSignOutSection  → `settings.session.*`      (8 ids)
//   2. AboutSection           → `settings.about.*` version + workspace cards (4 ids)
//   3. WorkspaceModeSettingsCard → `settings.workspaceMode.*` (SEE GAP NOTE)
//
// Sub-batch A already renders `AccountSection`, but asserts nothing about the
// sign-out card nested inside it (line ~672) — so the session ids had no tooth
// until now, and A staying green proves nothing about them.
//
// GAP (declared, not silently dropped): `WorkspaceModeSettingsCard` is gated by
// `useWorkspaceGridAvailability()`, which reads `import.meta.env.DEV` — the
// Vite-only graph this node harness cannot shim, the same reason sub-batch A
// renders `AccountSection` instead of the full panel. Verified, not assumed:
// rendering it here throws `Cannot read properties of undefined (reading 'DEV')`,
// so the component is deliberately left unexported. Its two ids therefore get
// CATALOG parity coverage below rather than a render tooth. That is weaker: it
// proves the ids exist and are translated, NOT that they are wired to the call
// site — a hardcoded English string left at that call site would still pass.
// Follow-up owner: me; the render tooth belongs in the Playwright e2e layer,
// where a real Vite build resolves the flag.

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null } as never);
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

/** A workspace name no catalog string could ever contain — so finding it in the
 *  About card can only mean the real `currentServer.name` was rendered, and
 *  NOT the `settings.about.workspaceNameFallback` default. */
const PROBE_WORKSPACE_NAME = "zh-probe-73104";

function seedServer(withName = true) {
  const server = withName
    ? { id: "s1", slug: "s1", name: PROBE_WORKSPACE_NAME }
    : { id: "s1", slug: null, name: null };
  useServerStore.setState({
    servers: [server], current: server, members: [], loading: false,
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

test("the Account username label renders its migrated Chinese copy", () => {
  seedUser();
  seedServer();
  renderInZh(<AccountSection />);

  // settings.account.usernameLabel — a FormField label, distinct from the
  // already-covered settings.account.nameLabel (姓名) / displayNameLabel.
  assert.ok(screen.getByText("用户名"), "username label");
});

test("the sign-out card renders migrated Chinese copy, including the confirm dialog", () => {
  seedUser();
  seedServer();
  renderInZh(<AccountSection />);

  // settings.session.sectionLabel / logOutTitle / logOutDescription / logOutAction.
  assert.ok(screen.getByText("会话", { exact: true }), "session section label");
  assert.ok(
    screen.getByText("退出当前浏览器的登录状态。你的账户和数据会保留，随时可以重新登录。"),
    "log out description",
  );
  // Both the card heading and the button carry 退出登录.
  assert.ok(screen.getAllByText("退出登录").length >= 2, "log out title + action");

  // No raw English may survive on this card.
  assert.equal(screen.queryByText("Log out"), null, "no untranslated 'Log out'");
  assert.equal(screen.queryByText("Session"), null, "no untranslated 'Session'");

  // The ConfirmDialog copy is a SEPARATE set of ids that only mounts on click —
  // rendering the card alone would leave settings.session.confirm* untested.
  fireEvent.click(screen.getByTestId("account-logout"));
  assert.ok(
    screen.getByText("要退出当前浏览器的登录状态吗？你的账户和数据会保留，随时可以重新登录。"),
    "confirm dialog message",
  );
});

test("the About page renders the current version without the redundant summary", () => {
  seedUser();
  seedServer();
  renderInZh(<AboutSection />);

  assert.ok(screen.getByText("版本", { exact: true }), "version section label");
  assert.ok(document.querySelector(".lucide-tag"), "Version uses a tag icon instead of the About info icon");
  assert.equal(document.querySelector(".lucide-badge-info"), null, "no duplicate About info icon inside the page");
  assert.ok(screen.getByText("Raft", { exact: true }), "brand wordmark stays Raft across locales");
  assert.ok(screen.getByText(WEB_APP_VERSION, { exact: true }), "resolved current Web app version");
  assert.ok(screen.getByText("工作空间", { exact: true }), "workspace section label");
  assert.equal(screen.queryByText("关于", { exact: true }), null, "no third About heading inside the page");
  assert.equal(screen.queryByText("版本、诊断、反馈与更新记录都在「设置」中。"), null, "redundant summary removed");

  // The real server name must win over the fallback id.
  assert.ok(screen.getByText(PROBE_WORKSPACE_NAME), "server name rendered");
  assert.equal(screen.queryByText("当前工作空间"), null, "fallback must not render when a name exists");
});

test("the About page renders an injected deployment version", () => {
  seedUser();
  seedServer();
  renderInZh(<AboutSection appVersion="2026.08-preview" />);

  assert.ok(screen.getByText("2026.08-preview", { exact: true }), "deployment version override");
});

test("the About card falls back to migrated Chinese copy when the server has no name or slug", () => {
  seedUser();
  seedServer(false);
  renderInZh(<AboutSection />);

  // settings.about.workspaceNameFallback / workspaceDetailsFallback — the ?? and
  // ternary branches, which the happy-path test above can never reach.
  assert.ok(screen.getByText("当前工作空间"), "workspace name fallback");
  assert.ok(screen.getByText("工作空间详情与管理入口在「设置」中。"), "workspace details fallback");
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  // Reverse-RED: deleting an id from zh-cn.ts, or leaving it copy-pasted from
  // English, fails here even if no component test happens to render it. This is
  // also the ONLY coverage the workspaceMode ids get — see the GAP note above.
  const ids = [
    "settings.account.usernameLabel",
    "settings.session.sectionLabel",
    "settings.session.logOutTitle",
    "settings.session.logOutDescription",
    "settings.session.logOutAction",
    "settings.session.confirmTitle",
    "settings.session.confirmMessage",
    "settings.session.confirmLabel",
    "settings.session.confirmLoadingLabel",
    "settings.about.versionSectionLabel",
    "settings.about.workspaceSectionLabel",
    "settings.about.workspaceNameFallback",
    "settings.about.workspaceDetailsFallback",
    "settings.workspaceMode.title",
    "settings.workspaceMode.description",
  ];

  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of ids) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    // Every zh value must contain at least one CJK codepoint — catches a
    // whitespace-only or punctuation-only "translation" that would slip past
    // the notEqual check above.
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("the workspace SCOPE strings use 工作空间, never the agent-directory 工作区", () => {
  // These four shipped as 工作区 in sub-batch C and were corrected after @AngLee
  // ruled (2026-07-31). English collapses two concepts onto "Workspace"; Chinese
  // does not: 工作空间 = the server/workspace scope, 工作区 = an agent's own
  // working directory. sidebarSettingsRoot already pinned the sidebar surface —
  // this pins the Settings surface, which is where the drift got through.
  const zh = zhMessages as Record<string, string>;
  for (const id of [
    "settings.about.workspaceSectionLabel",
    "settings.about.workspaceNameFallback",
    "settings.about.workspaceDetailsFallback",
    "settings.workspaceMode.title",
  ]) {
    assert.ok(zh[id].includes("工作空间"), `${id} must use 工作空间`);
    assert.ok(
      !/工作区/.test(zh[id]),
      `${id} uses 工作区 — that is the agent working-directory term, not the scope term`,
    );
  }
});
