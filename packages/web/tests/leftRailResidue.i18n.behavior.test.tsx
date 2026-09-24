import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { TestIntlProvider } from "./helpers/intl";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import {
  publishServerFeatureFlagValuesFromLabsReadback,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalApiGet = api.get;
const originalApiPost = api.post;

function LocationProbe() {
  return <span data-testid="rail-route">{useLocation().pathname}</span>;
}

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  cleanup();
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useAuthStore.setState({ user: null, loading: false, initialized: true });
  useServerStore.setState({ current: null, servers: [], members: [] });
  useWorkspaceGridNavigationStore.setState({ active: false, enabled: false, railMode: null });
});

test("catalog pins left-rail residue MessageIds with Chinese", () => {
  assert.equal(en["layout.leftRail.tabSaved"], "Saved");
  assert.equal(en["layout.leftRail.tabHumans"], "Humans");
  assert.equal(en["layout.leftRail.tabWiki"], "Wiki");
  assert.equal(en["layout.leftRail.enterWorkspace"], "Enter Workspace");
  assert.equal(en["layout.leftRail.exitWorkspace"], "Exit Workspace");
  assert.equal(zh["layout.leftRail.tabSaved"], "已保存");
  assert.equal(zh["layout.leftRail.tabHumans"], "人类");
  assert.equal(zh["layout.leftRail.tabWiki"], "Wiki");
  assert.equal(zh["layout.leftRail.enterWorkspace"], "进入工作空间");
  assert.equal(zh["layout.leftRail.exitWorkspace"], "退出工作空间");
  assert.match(zh["layout.leftRail.enterWorkspace"], /\p{Script=Han}/u);
  assert.match(zh["layout.leftRail.exitWorkspace"], /\p{Script=Han}/u);
});

test("LeftRail residue tabs and workspace toggle render Chinese under zh-cn", () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  api.post = (async () => ({
    data: { evaluations: [{ key: WIKI_FEATURE_FLAG_KEY, enabled: true }] },
  })) as typeof api.post;
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
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    servers: [],
    members: [],
  } as never);
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-1",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: WIKI_FEATURE_FLAG_KEY,
      name: "Wiki",
      description: "",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  const first = render(
    <MemoryRouter initialEntries={["/s/server"]}>
      <TestIntlProvider locale="zh-cn">
        <LeftRail workspaceModeAvailable />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("button", { name: "进入工作空间" }));
  assert.ok(screen.getByRole("button", { name: "Wiki" }));
  assert.equal(screen.queryByRole("button", { name: "Enter Workspace" }), null);
  assert.deepEqual(
    Array.from(first.container.querySelectorAll<HTMLElement>('[data-testid^="left-rail-tab-"]'))
      .map((element) => element.dataset.testid),
    [
      "left-rail-tab-search",
      "left-rail-tab-chat",
      "left-rail-tab-activity",
      "left-rail-tab-tasks",
      "left-rail-tab-wiki",
      "left-rail-tab-members",
      "left-rail-tab-computers",
    ],
    "classic rail keeps gated Wiki between Tasks and Members",
  );

  first.unmount();
  act(() => {
    useWorkspaceGridNavigationStore.setState({
      active: true,
      enabled: true,
      railMode: "saved",
      railLayout: { left: ["saved", "humans", "wiki"], right: [] },
    });
  });
  const workspace = render(
    <MemoryRouter initialEntries={["/s/server/wiki"]}>
      <TestIntlProvider locale="zh-cn">
        <LeftRail workspaceModeAvailable />
        <LocationProbe />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  for (const label of ["已保存", "人类", "Wiki", "退出工作空间"]) {
    assert.ok(screen.getByRole("button", { name: label }), label);
  }
  for (const label of ["Saved", "Humans", "Exit Workspace"]) {
    assert.equal(screen.queryByRole("button", { name: label }), null, label);
  }
  assert.equal(screen.getByTestId("rail-route").textContent, "/s/server/wiki");
  fireEvent.click(screen.getByRole("button", { name: "已保存" }));
  assert.equal(screen.getByTestId("rail-route").textContent, "/s/server");
  assert.equal(useWorkspaceGridNavigationStore.getState().sidebars.left.activeItem, "saved");

  workspace.unmount();
  act(() => {
    publishServerFeatureFlagValuesFromLabsReadback({
      serverId: "server-1",
      serverLabVersion: 2,
      masterEnabled: true,
      labs: [{
        key: WIKI_FEATURE_FLAG_KEY,
        name: "Wiki",
        description: "",
        state: "open",
        enrolled: false,
        effective: false,
      }],
    });
  });
  const gated = render(
    <MemoryRouter initialEntries={["/s/server"]}>
      <TestIntlProvider locale="zh-cn">
        <LeftRail workspaceModeAvailable />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  assert.equal(screen.queryByRole("button", { name: "Wiki" }), null);
  assert.deepEqual(
    Array.from(gated.container.querySelectorAll<HTMLElement>("[data-workspace-rail-item]"))
      .map((element) => element.dataset.workspaceRailItem),
    ["saved", "humans"],
    "a gated-off Wiki leaves no visible Workspace rail slot",
  );
});
