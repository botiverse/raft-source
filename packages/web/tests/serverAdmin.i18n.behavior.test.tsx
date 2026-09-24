import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createIntl } from "react-intl";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import {
  getAdminPrincipalLabel,
  getMemberLabel,
  unknownMemberLabel,
} from "../src/utils/serverAdminSettings";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
});

test("catalog pins server-admin unknown-member MessageId", () => {
  assert.equal(en["settings.admins.unknownMember"], "Unknown member");
  assert.equal(zh["settings.admins.unknownMember"], "未知成员");
  assert.match(zh["settings.admins.unknownMember"], /\p{Script=Han}/u);
  assert.notEqual(zh["settings.admins.unknownMember"], en["settings.admins.unknownMember"]);
});

test("member label helpers format unknown member through zh-cn intl", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const formatMessage = zhIntl.formatMessage;
  assert.equal(unknownMemberLabel(formatMessage), "未知成员");
  assert.equal(
    getMemberLabel({ name: "", displayName: null, email: null }, formatMessage),
    "未知成员",
  );
  assert.equal(
    getAdminPrincipalLabel({ kind: "human", name: "", displayName: null }, formatMessage),
    "未知成员",
  );
  assert.doesNotMatch(unknownMemberLabel(formatMessage), /Unknown member/);
});

test("SettingsPanel renders unknown humans and agent candidates through zh-cn helpers", async () => {
  useAuthStore.setState({
    user: {
      id: "owner-1",
      email: "owner@example.com",
      name: "Owner",
      displayName: "Owner",
      avatarUrl: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "server-1", slug: "launch", name: "Launch", role: "owner" }],
    current: { id: "server-1", slug: "launch", name: "Launch", role: "owner" },
    members: [{
      userId: "owner-1",
      email: null,
      gravatarHash: "",
      name: "",
      displayName: null,
      description: null,
      avatarUrl: null,
      role: "owner",
      joinedAt: "2026-08-19T00:00:00.000Z",
    }],
    loading: false,
    loadMembers: async () => {},
  } as never);
  useAgentStore.setState({
    agents: [{
      id: "agent-1",
      name: "helper",
      displayName: "Helper Bot",
      description: null,
      avatarUrl: null,
      status: "online",
      runtime: "codex",
      serverRole: "member",
      channelIds: [],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }],
    loading: false,
    loadAgents: async () => {},
  } as never);
  api.get = (async () => ({ data: [] })) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <SettingsPanel tab="administration" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(await screen.findByText(zh["settings.admins.unknownMember"]));
  fireEvent.click(await screen.findByTestId("admin-principal-picker"));
  assert.ok(await screen.findByText(
    zh["settings.admins.principalAgentSuffix"].replace("{name}", "Helper Bot"),
  ));
  assert.doesNotMatch(document.body.textContent ?? "", /Unknown member/);
});
