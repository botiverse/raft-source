import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
} from "@botiverse/raft-shared";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const originalApiGet = api.get;
const originalApiPost = api.post;

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  cleanup();
  resetServerFeatureFlagsForTests();
  useMessageStore.setState({ unreadCounts: {}, drafts: {}, mentionFlags: {} });
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: true });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true });
  useMachineStore.setState({ machines: [], loading: true });
  useServerStore.setState({ current: null, servers: [], members: [], settings: null, loadingSettings: false });
  useAuthStore.setState({ user: null, loading: false, initialized: true });
});

function installApiStub(providerConnectionsEnabled = false, slackBridgeEnabled = true) {
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      const request = body as { keys: string[] };
      return {
        data: {
          evaluations: request.keys.map((key) => ({
            key,
            enabled: key === SERVER_LABS_UI_FEATURE_FLAG_KEY
              || (providerConnectionsEnabled && key === PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY)
              || (slackBridgeEnabled && key === SLACK_BRIDGE_FEATURE_FLAG_KEYS.master),
          })),
        },
      };
    }
    return { data: {} };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") {
      return { data: [] };
    }
    return { data: [] };
  }) as typeof api.get;
}

function seedSettingsSidebar(
  feedbackEnabled: boolean | null = true,
  providerConnectionsEnabled = false,
  role: "owner" | "admin" | "member" = "owner",
  slackBridgeEnabled = true,
) {
  installApiStub(providerConnectionsEnabled, slackBridgeEnabled);
  localStorage.clear();
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
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
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role,
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    settings: feedbackEnabled === null
      ? null
      : { onboardSettings: {} as never, feedbackSettings: { enabled: feedbackEnabled } },
    servers: [],
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

test("member settings sidebar hides Plan & Billing and Administration", async () => {
  seedSettingsSidebar(true, false, "member");
  renderSettingsSidebar("/s/server/settings");
  await screen.findByRole("button", { name: "Server Profile" });

  assert.equal(screen.queryByRole("button", { name: "Plan & Billing" }), null);
  assert.equal(screen.queryByRole("button", { name: "Administration" }), null);
  assert.ok(screen.getByRole("button", { name: "Applications" }));
});

function LocationProbe() {
  const location = useLocation();
  return <output role="status" aria-label="Current route" data-testid="location-pathname">{location.pathname}</output>;
}

function renderSettingsSidebar(initialPath: string, mobileInline = true) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TestIntlProvider>
        <Sidebar mobileInline={mobileInline} />
        <LocationProbe />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function renderSettingsSidebarZh(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TestIntlProvider locale="zh-cn">
        <Sidebar mobileInline />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function expectSelected(button: HTMLElement) {
  assert.match(button.className, /bg-brutal-pink/);
  assert.match(button.className, /font-bold/);
}

function expectNotSelected(button: HTMLElement) {
  assert.doesNotMatch(button.className, /bg-brutal-pink/);
  assert.doesNotMatch(button.className, /font-bold/);
}

for (const { path, label } of [
  { path: "language-region", label: "Language & Region" },
  { path: "appearance", label: "Appearance" },
  { path: "notifications", label: "Notifications" },
  { path: "server", label: "Server Profile" },
  { path: "billing", label: "Plan & Billing" },
  { path: "administration", label: "Administration" },
  { path: "im-bridges", label: "IM Bridges" },
  { path: "applications", label: "Applications" },
  { path: "labs", label: "Labs" },
  { path: "mcp-servers", label: "MCP Servers" },
  { path: "about", label: "About" },
  { path: "feedback", label: "Feedback" },
] as const) {
  test(`mobile Settings sub-route /${path} selects ${label}`, async () => {
    seedSettingsSidebar();
    renderSettingsSidebar(`/s/server/settings/${path}`);

    expectSelected(await screen.findByRole("button", { name: label }));
  });
}

test("unknown Settings sub-route does not select any known sidebar row", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings/unknown-section");
  await screen.findByRole("button", { name: "Labs" });

  for (const label of [
    "Account",
    "Language & Region",
    "Appearance",
    "Notifications",
    "Server Profile",
    "Labs",
    "Plan & Billing",
    "Administration",
    "IM Bridges",
    "Applications",
    "MCP Servers",
    "About",
    "Documentation",
    "Feedback",
    "Release Notes",
  ]) {
    expectNotSelected(screen.getByRole(label === "Documentation" ? "link" : "button", { name: label }));
  }
});

for (const label of [
  "Account",
  "Language & Region",
  "Appearance",
  "Notifications",
  "Server Profile",
  "Plan & Billing",
  "Administration",
  "IM Bridges",
  "Applications",
  "Labs",
  "MCP Servers",
] as const) {
  test(`clicking ${label} from Settings root selects that row`, async () => {
    seedSettingsSidebar();
    renderSettingsSidebar("/s/server/settings");

    const button = await screen.findByRole("button", { name: label });
    fireEvent.click(button);

    await waitFor(() => expectSelected(button));
  });
}

test("mobile Settings root renders grouped settings items without selecting a subpage", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings");
  await screen.findByRole("button", { name: "Labs" });

  assert.ok(screen.getByText("Personal"));
  assert.ok(screen.getByText("Workspace"));
  assert.ok(screen.getByText("Resources"));
  assert.ok(screen.getByRole("button", { name: "About" }));
  for (const label of [
    "Account",
    "Language & Region",
    "Appearance",
    "Notifications",
    "Server Profile",
    "Plan & Billing",
    "Administration",
    "IM Bridges",
    "Applications",
    "Labs",
    "MCP Servers",
    "Computers",
    "Documentation",
    "Feedback",
    "Release Notes",
  ]) {
    assert.ok(screen.getByRole(label === "Documentation" ? "link" : "button", { name: label }));
  }

  expectNotSelected(screen.getByRole("button", { name: "Account" }));
});

test("Providers appears in Settings navigation only when its server feature is enabled", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings");
  await screen.findByRole("button", { name: "Labs" });
  assert.equal(screen.queryByRole("button", { name: "AI Providers" }), null);

  cleanup();
  resetServerFeatureFlagsForTests();
  seedSettingsSidebar(true, true);
  renderSettingsSidebar("/s/server/settings");
  const providers = await screen.findByRole("button", { name: "AI Providers" });
  fireEvent.click(providers);
  await waitFor(() => assert.equal(
    screen.getByTestId("location-pathname").textContent,
    "/s/server/settings/providers",
  ));
});

test("IM Bridges, Applications, Labs, and MCP Servers keep their order and canonical routes", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings");

  const labs = await screen.findByRole("button", { name: "Labs" });
  const imBridges = screen.getByRole("button", { name: "IM Bridges" });
  const applications = screen.getByRole("button", { name: "Applications" });
  const mcpServers = screen.getByRole("button", { name: "MCP Servers" });
  assert.ok(imBridges.compareDocumentPosition(applications) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(applications.compareDocumentPosition(labs) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(labs.compareDocumentPosition(mcpServers) & Node.DOCUMENT_POSITION_FOLLOWING);

  fireEvent.click(imBridges);
  await waitFor(() => assert.equal(
    screen.getByTestId("location-pathname").textContent,
    "/s/server/settings/im-bridges",
  ));

  fireEvent.click(applications);
  await waitFor(() => assert.equal(
    screen.getByTestId("location-pathname").textContent,
    "/s/server/settings/applications",
  ));

  fireEvent.click(labs);
  await waitFor(() => assert.equal(
    screen.getByTestId("location-pathname").textContent,
    "/s/server/settings/labs",
  ));

  fireEvent.click(mcpServers);
  await waitFor(() => assert.equal(
    screen.getByTestId("location-pathname").textContent,
    "/s/server/settings/mcp-servers",
  ));
});

test("Settings About and Release Notes sidebar items navigate and select their routes", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings");
  await screen.findByRole("button", { name: "Labs" });

  const about = screen.getByRole("button", { name: "About" });
  fireEvent.click(about);

  await waitFor(() => expectSelected(about));

  const releaseNotes = screen.getByRole("button", { name: "Release Notes" });
  fireEvent.click(releaseNotes);

  await waitFor(() => expectSelected(releaseNotes));
  assert.doesNotMatch(about.className, /bg-brutal-pink/);
});

test("Settings Documentation sidebar item opens the docs safely in a new tab", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings/about");
  await screen.findByRole("button", { name: "Labs" });

  const documentation = screen.getByRole("link", { name: "Documentation" });
  assert.equal(documentation.getAttribute("href"), "https://docs.raft.build");
  assert.equal(documentation.getAttribute("target"), "_blank");
  assert.equal(documentation.getAttribute("rel"), "noopener noreferrer");
  expectNotSelected(documentation);
});

// Stage-2 acceptance, updated for the layout namespace (PR-2). The full-page
// settings sidebar's 8 destination items still reuse the already-merged,
// AngLee-final `settings.tabs.*` ids, so under the zh-cn display locale they
// render the reviewed Chinese — the exact English list @artin screenshotted on
// the /settings/language-region page. This is the regression backstop that the
// Sidebar call sites are wired to formatMessage (not left as hardcoded English).
//
// BOUNDARY MOVED (2026-07-22): the group headers (Personal/Workspace/Resources),
// Computers, and Release Notes previously had to STAY English here, because
// #3874 only carried a machine-drafted zh for them. @AngLee finalized those rows
// on 2026-07-22 (notes/i18n-layout-zh-final.md), so they are now migrated under
// `layout.sidebar.settings*` and MUST render the approved Chinese — the earlier
// "stays English" / "not silently draft-migrated" assertions are inverted below.
// Note 工作空间, not the withdrawn draft 工作区: the language owner tracks the
// shipped English "Workspace" ("只跟随英文"), and 服务器资料 keeps 服务器
// because that item's English was never renamed.
//
// About destination + Documentation got their catalog rows on 2026-08-04
// (@AngLee: About→关于, Documentation→文档) — they now render the ruled zh,
// not the pending-English state.
test("the full-page settings sidebar items render the AngLee-final Chinese under zh-cn (reused settings.tabs.* + migrated layout.sidebar.*)", async () => {
  seedSettingsSidebar();
  renderSettingsSidebarZh("/s/server/settings/account");
  await screen.findByRole("button", { name: "Labs" });

  // 8 reused destinations → settings.tabs.* zh (byte-identical to the labels
  // already shipped on the settings panel header in A/B). Not duplicated under
  // `layout.*` — the reuse is the contract.
  for (const zh of [
    "账户",
    "语言与区域",
    "外观",
    "通知",
    "服务器资料",
    "Labs",
    "套餐与账单",
    "管理",
    "IM Bridges",
    "应用",
    "MCP 服务器",
    "反馈",
  ]) {
    assert.ok(screen.getByRole("button", { name: zh }), `settings sub-nav item ${zh}`);
  }

  // The five rows layout-A deliberately left English now carry the finalized zh.
  // Asserting each one individually is the teeth that a future edit which reverts
  // any single one back to a hardcoded English literal goes RED here.
  assert.ok(screen.getByText("个人"), "Personal group header → 个人");
  assert.ok(screen.getByText("工作空间"), "Workspace group header → 工作空间");
  assert.ok(screen.getByText("资源"), "Resources group header → 资源");
  assert.ok(screen.getByRole("button", { name: "计算机" }), "Computers item → 计算机");
  assert.ok(screen.getByRole("button", { name: "更新日志" }), "Release Notes item → 更新日志");
  // …and none of them may still be showing their English source under zh-cn.
  for (const english of ["Personal", "Workspace", "Computers", "Release Notes"]) {
    assert.equal(screen.queryByText(english), null, `${english} migrated away from English under zh-cn`);
  }
  // The withdrawn draft rendering must not come back (@AngLee chose 工作空间).
  assert.equal(screen.queryByText("工作区"), null, "Workspace uses the final 工作空间, not the withdrawn draft 工作区");
  // About destination and Documentation are now in the catalog (@AngLee ruling).
  assert.ok(screen.getByRole("button", { name: "关于" }), "About destination → 关于");
  assert.ok(screen.getByRole("link", { name: "文档" }), "Documentation → 文档");
  // The migrated ids must NOT still be showing their English source under zh-cn.
  assert.equal(screen.queryByRole("button", { name: "Applications" }), null, "Applications migrated away from English under zh-cn");
  assert.equal(screen.queryByText("About"), null, "About migrated away from English under zh-cn");
  assert.equal(screen.queryByText("Documentation"), null, "Documentation migrated away from English under zh-cn");
});

for (const mobileInline of [false, true]) {
  test(`${mobileInline ? "mobile" : "desktop"} Settings exposes Feedback in Resources group order`, async () => {
    seedSettingsSidebar();
    renderSettingsSidebar("/s/server/settings/about", mobileInline);

    const about = screen.getByRole("button", { name: "About" });
    const documentation = screen.getByRole("link", { name: "Documentation" });
    const feedback = await screen.findByRole("button", { name: "Feedback" });
    const releaseNotes = screen.getByRole("button", { name: "Release Notes" });

    assert.ok(about.compareDocumentPosition(documentation) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(documentation.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(feedback.compareDocumentPosition(releaseNotes) & Node.DOCUMENT_POSITION_FOLLOWING);
    expectNotSelected(feedback);
  });
}

test("Feedback navigates to and selects the right-hand Settings subpage", async () => {
  seedSettingsSidebar();
  renderSettingsSidebar("/s/server/settings/about");

  const feedback = await screen.findByRole("button", { name: "Feedback" });
  const route = screen.getByRole("status", { name: "Current route" });
  assert.equal(route.textContent, "/s/server/settings/about");
  expectSelected(screen.getByRole("button", { name: "About" }));

  fireEvent.click(feedback);

  await waitFor(() => assert.equal(route.textContent, "/s/server/settings/feedback"));
  expectSelected(feedback);
  expectNotSelected(screen.getByRole("button", { name: "About" }));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("Settings keeps Feedback available when the legacy capability field is disabled", async () => {
  seedSettingsSidebar(false);
  renderSettingsSidebar("/s/server/settings/about");

  const feedback = await screen.findByRole("button", { name: "Feedback" });
  fireEvent.click(feedback);
  await waitFor(() => {
    assert.equal(screen.getByRole("status", { name: "Current route" }).textContent, "/s/server/settings/feedback");
  });
});

test("Settings keeps Feedback available while the settings payload is unresolved", async () => {
  seedSettingsSidebar(null);
  renderSettingsSidebar("/s/server/settings/about");

  const feedback = await screen.findByRole("button", { name: "Feedback" });
  fireEvent.click(feedback);
  await waitFor(() => {
    assert.equal(screen.getByRole("status", { name: "Current route" }).textContent, "/s/server/settings/feedback");
  });
});

test("IM Bridges is hidden when the current server has no enabled bridge gate", async () => {
  seedSettingsSidebar(true, false, "owner", false);
  renderSettingsSidebar("/s/server/settings/account");

  await screen.findByRole("button", { name: "Account" });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "IM Bridges" }), null));
});
