import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import {
  IntegrationsSection,
  ConnectedAppOriginBadges,
  DeclaredScopesPicker,
} from "../src/components/settings/SettingsPanel";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Settings sub-batch D (react-intl migration acceptance): the Connected Apps
// residue in SettingsPanel.tsx — the strings sub-batch B left behind when it
// migrated the `settings.connectedApps.*` section. Three call-site families:
//
//   1. IntegrationsSection      → section description, admin note, filter a11y labels
//   2. ConnectedAppOriginBadges → `Shared` / `This server` origin badges
//   3. DeclaredScopesPicker     → declared-scopes title + description
//
// WHY THE A11Y LABELS MATTER HERE: several `aria-label`s sat directly beside an
// ALREADY-MIGRATED `placeholder` on the same element (e.g. the app search input).
// A screen-reader user got Chinese placeholder text and an English accessible
// name from one control. Sub-batch B was green throughout.
//
// The section description was found by DUMPING THE RENDERED DOM, not by the
// heuristic scanner — the scanner does not flag it, because the sentence is
// split by an inline `{canManage ? "manage" : "view"}` ternary. That ternary was
// also an i18n defect in its own right: it substitutes an English VERB into an
// English sentence frame, which cannot be translated as a unit. It is now two
// complete messages selected by `canManage`, not one message with a verb slot.

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

function seed() {
  useAuthStore.setState({
    user: { id: "u1", name: "U", displayName: "U", email: "u@example.com" },
    loading: false, initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1" }],
    current: { id: "s1", slug: "s1", name: "S1" },
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

test("the Connected Apps filter controls expose Chinese ACCESSIBLE NAMES, not just Chinese placeholders", () => {
  seed();
  renderInZh(<IntegrationsSection />);

  // settings.connectedApps.searchAppsAriaLabel / filterByCategoryAriaLabel.
  // Queried by role+name so this asserts the ACCESSIBLE NAME, which is the thing
  // that was still English while the adjacent placeholder was already migrated.
  assert.ok(screen.getByRole("searchbox", { name: "搜索已连接应用" }), "search accessible name");
  assert.ok(
    document.querySelector('[aria-label="按分类筛选已连接应用"]'),
    "category filter accessible name",
  );

  assert.equal(
    document.querySelector('[aria-label="Search connected apps"]'), null,
    "no untranslated search aria-label",
  );
  assert.equal(
    document.querySelector('[aria-label="Filter connected apps by category"]'), null,
    "no untranslated filter aria-label",
  );
});

test("the Connected Apps section description renders in Chinese (the scanner-invisible string)", () => {
  seed();
  renderInZh(<IntegrationsSection />);

  // canManage is false for a plain member, so the `view` variant + the admin-only
  // note both render. Asserting the WHOLE sentence — a verb-slot regression would
  // leave an English fragment mid-string and fail here.
  assert.ok(
    screen.getByText("浏览已审核的市场应用，查看本服务器已安装的应用，以及由本服务器注册的应用。"),
    "section description (view variant)",
  );
  assert.ok(
    screen.getByText("只有服务器所有者和管理员可以安装、编辑或移除应用。"),
    "admin-only note",
  );
  assert.ok(
    !document.body.textContent?.includes("Browse reviewed marketplace apps"),
    "no untranslated section description",
  );
});

test("the app origin badges render migrated Chinese copy", () => {
  seed();
  const app = { privateShared: true, origin: "private" } as never;
  renderInZh(<ConnectedAppOriginBadges app={app} />);

  assert.ok(screen.getByText("共享"), "shared badge");
  assert.ok(screen.getByText("此服务器"), "this-server badge");
  assert.equal(screen.queryByText("Shared"), null, "no untranslated Shared");
  assert.equal(screen.queryByText("This server"), null, "no untranslated This server");
});

test("the declared-scopes picker renders migrated Chinese copy", () => {
  seed();
  renderInZh(<DeclaredScopesPicker value={[]} onChange={() => {}} />);

  assert.ok(screen.getByText("声明的权限范围"), "declared scopes title");
  assert.ok(
    screen.getByText(
      "选择此应用可以请求哪些权限。已有连接会保留已授予的权限，直到重新连接或被撤销。",
    ),
    "declared scopes description",
  );
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  // Reverse-RED for the ids whose call sites need marketplace data this harness
  // does not load (the installed-app detail panel: eyebrow, close button, and the
  // Login-with-Raft scope summary). Weaker than a render tooth — it proves the id
  // is translated, NOT that it is wired — same caveat as sub-batch C's gap note.
  const ids = [
    "settings.connectedApps.searchAppsAriaLabel",
    "settings.connectedApps.filterByCategoryAriaLabel",
    "settings.connectedApps.available",
    "settings.connectedApps.sharedBadge",
    "settings.connectedApps.thisServerBadge",
    "settings.connectedApps.installedAppEyebrow",
    "settings.connectedApps.closeInstalledAppDetail",
    "settings.connectedApps.loginAccessTitle",
    "settings.connectedApps.loginAccessDescription",
    "settings.connectedApps.declaredScopesTitle",
    "settings.connectedApps.declaredScopesDescription",
    "settings.connectedApps.appEditorSectionsAriaLabel",
    "settings.connectedApps.appCategoryAriaLabel",
    "settings.connectedApps.sectionDescriptionManage",
    "settings.connectedApps.sectionDescriptionView",
    "settings.connectedApps.adminOnlyNote",
  ];

  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of ids) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }

  // The manage/view pair must stay two DISTINCT strings. If a later edit collapses
  // them back into one shared message, the canManage branch silently stops
  // mattering — and the English verb slot creeps back in.
  assert.notEqual(
    zh["settings.connectedApps.sectionDescriptionManage"],
    zh["settings.connectedApps.sectionDescriptionView"],
    "manage/view variants must stay distinct",
  );
});
