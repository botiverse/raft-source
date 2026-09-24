import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { runtimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
  runtimeAccountUsageClient.clear();
});

function seedAgentStores(
  agent: Record<string, unknown>,
  opts: {
    currentUserId?: string;
    role?: "owner" | "admin" | "member";
    activityDetail?: string;
    externalLastActivityAt?: string | null;
    machines?: unknown[];
  } = {},
) {
  useAuthStore.setState({ user: { id: opts.currentUserId ?? "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server", role: opts.role ?? "owner" },
    members: [],
  } as never);
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, false);
  useMachineStore.setState({ machines: opts.machines ?? [] } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({
    agents: [agent],
    agentActivities: opts.activityDetail
      ? {
          [String(agent.id)]: {
            activity: "error",
            activityDetail: opts.activityDetail,
            detailKind: "runtime_progress",
          },
        }
      : {},
    activityLogs: {},
    fetchExternalAgentStatus: async () => ({
      setupState: "connected",
      credentialLastUsedAt: null,
      lastActivityAt: opts.externalLastActivityAt ?? null,
    }),
  } as never);
}

function renderAgentZh(agent: Record<string, unknown>) {
  seedAgentStores(agent);
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function renderAgentChatEn(agent: Record<string, unknown>) {
  seedAgentStores(agent);
  return render(
    <MemoryRouter initialEntries={[`/s/playwright-server/agent/${String(agent.id)}?agentTab=chat`]}>
      <TestIntlProvider>
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function renderAgentEn(
  agent: Record<string, unknown>,
  opts: Parameters<typeof seedAgentStores>[1] = {},
) {
  seedAgentStores(agent, opts);
  return render(
    <MemoryRouter initialEntries={[`/s/playwright-server/agent/${String(agent.id)}`]}>
      <TestIntlProvider>
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("catalog pins agent-detail residue MessageIds", () => {
  assert.equal(en["agent.detail.cancel"], "Cancel");
  assert.equal(en["agent.detail.deleted"], "Deleted");
  assert.equal(
    en["agent.detail.deprecatedRuntimeWarning"],
    "This agent uses a deprecated runtime. It can keep running, but new agents cannot select this runtime.",
  );
  assert.equal(
    en["agent.detail.modelNotInComputerConfig"],
    "{model} (not in this computer's config)",
  );
  assert.match(zh["agent.detail.deleted"], /\p{Script=Han}/u);
  assert.match(zh["agent.detail.deprecatedRuntimeWarning"], /\p{Script=Han}/u);
  assert.match(zh["agent.detail.modelNotInComputerConfig"], /\{model\}/);
  assert.match(zh["agent.detail.modelNotInComputerConfig"], /\p{Script=Han}/u);
});

test("agent-detail model-not-in-config formats under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const text = zhIntl.formatMessage(
    { id: "agent.detail.modelNotInComputerConfig" },
    { model: "gpt-test" },
  );
  assert.match(text, /gpt-test/);
  assert.match(text, /\p{Script=Han}/u);
  assert.doesNotMatch(text, /not in this computer's config/);
});

test("model-switch reset dialog keeps actions short and the explanation in its body", () => {
  assert.equal(en["common.confirm.cancel"], "Cancel");
  assert.equal(en["agent.detail.reset"], "Reset");
  assert.equal(zh["common.confirm.cancel"], "取消");
  assert.equal(zh["agent.detail.reset"], "重置");
  assert.match(en["agent.detail.switchModelResetMessage"], /\{model\}.*resets the current runtime session/);
  assert.match(zh["agent.detail.switchModelResetMessage"], /\{model\}.*重置当前运行时会话/);
});

test("mounted deleted AgentDetailPanel renders Chinese deleted chrome", () => {
  renderAgentZh({
    id: "agent-1",
    name: "witty",
    displayName: "witty",
    runtime: "claude",
    status: "idle",
    deletedAt: "2026-08-08T00:00:00.000Z",
  });

  assert.ok(screen.getByText(zh["agent.detail.deleted"]));
  assert.equal(screen.queryByText("Deleted"), null);
});

test("mounted deprecated-runtime AgentDetailPanel renders Chinese warning, not English residue", () => {
  renderAgentZh({
    id: "agent-2",
    name: "legacy",
    displayName: "legacy",
    runtime: "gemini",
    status: "active",
    lastRuntimeError: null,
  });

  assert.ok(screen.getByText(zh["agent.detail.deprecatedRuntimeWarning"]));
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /This agent uses a deprecated runtime/,
  );
});

test("mounted agent chat keeps a five-channel preview with a real show-all toggle", async () => {
  const channels = Array.from({ length: 7 }, (_, index) => ({
    id: `channel-${index + 1}`,
    name: `channel-${index + 1}`,
    description: null,
    type: "channel",
    createdAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    activityMuted: false,
    muteFromSeq: null,
  }));
  api.get = (async (url: string) => {
    if (url === "/agents/agent-chat/agent-dms") return { data: [] } as never;
    if (url === "/agents/agent-chat/channels") return { data: channels } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderAgentChatEn({
    id: "agent-chat",
    name: "chat-agent",
    displayName: "chat-agent",
    runtime: "claude",
    status: "active",
    creatorType: "user",
    creatorId: "user-1",
    deletedAt: null,
    lastRuntimeError: null,
  });

  assert.ok(await screen.findByText("Channels & DMs"));
  await waitFor(() => assert.ok(screen.getByText("channel-5")));
  assert.equal(screen.queryByText("channel-6") !== null, false);
  assert.equal(screen.queryByText("channel-7") !== null, false);

  fireEvent.click(screen.getByRole("button", { name: "Show all 7 channels" }));
  assert.ok(screen.getByText("channel-6"));
  assert.ok(screen.getByText("channel-7"));

  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  assert.equal(screen.queryByText("channel-6") !== null, false);
  assert.equal(screen.queryByText("channel-7") !== null, false);
});

test("mounted agent manager shares one copy lifecycle across every diagnostic trigger", async (t) => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copiedTexts: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text: string) {
        copiedTexts.push(text);
      },
    },
  });
  t.after(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  renderAgentEn({
    id: "agent-manager",
    name: "managed",
    displayName: "Managed Agent",
    runtime: "claude",
    status: "active",
    creatorType: "user",
    creatorId: "user-2",
    deletedAt: null,
    lastRuntimeError: { message: "manager-only diagnostic" },
  }, { role: "owner", activityDetail: "manager-only diagnostic" });

  for (const label of ["Profile", "Activity", "Chat", "Reminders", "Workspace", "Apps", "MCP"]) {
    assert.ok(screen.getByText(label));
  }
  assert.ok(screen.getAllByText(/manager-only diagnostic/).length >= 1);
  assert.ok(document.querySelector('span.min-w-0.truncate.text-sm.font-mono[title*="manager-only diagnostic"]'));
  const bannerCopy = screen.getByRole("button", { name: "Copy info" });
  const profileCopy = screen.getByRole("button", { name: "Copy Diagnostic Info" });
  fireEvent.click(bannerCopy);
  await waitFor(() => assert.equal(copiedTexts.length, 1));
  assert.match(copiedTexts[0] ?? "", /manager-only diagnostic/);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Copied" })));
  assert.ok(
    screen.getByRole("button", { name: "Diagnostic Info Copied" }),
    "every diagnostic trigger must reflect the one shared copied lifecycle",
  );
  assert.equal(profileCopy.hasAttribute("disabled"), false);
  assert.ok(screen.getAllByRole("button", { name: "Restart / Reset" }).length >= 1);
});

test("mounted human creator keeps Agent management after server-role demotion", () => {
  renderAgentEn({
    id: "agent-creator",
    name: "creator-agent",
    displayName: "Creator Agent",
    runtime: "claude",
    status: "active",
    creatorType: "user",
    creatorId: "user-1",
    deletedAt: null,
    lastRuntimeError: { message: "creator-private diagnostic" },
  }, { role: "member", activityDetail: "creator-private diagnostic" });

  for (const label of ["Profile", "Activity", "Chat", "Reminders", "Workspace", "Apps", "MCP"]) {
    assert.ok(screen.getByText(label));
  }
  assert.ok(screen.getAllByText(/creator-private diagnostic/).length >= 1);
  assert.ok(document.querySelector('span.min-w-0.truncate.text-sm.font-mono[title*="creator-private diagnostic"]'));
  assert.ok(screen.getAllByRole("button", { name: "Restart / Reset" }).length >= 1);
  assert.ok(screen.getByTitle("Edit display name"));
  assert.ok(screen.getByRole("button", { name: "Delete Agent" }));
});

test("mounted non-creator member gets public profile plus runtime controls without private management", () => {
  renderAgentEn({
    id: "agent-member",
    name: "member-agent",
    displayName: "Member Agent",
    runtime: "claude",
    status: "active",
    creatorType: "user",
    creatorId: "user-2",
    deletedAt: null,
    lastRuntimeError: { message: "do-not-leak-this-diagnostic" },
  }, { role: "member", activityDetail: "do-not-leak-this-diagnostic" });

  assert.ok(screen.getByText("Profile"));
  for (const label of ["Activity", "Chat", "Reminders", "Workspace", "Apps", "MCP"]) {
    assert.equal(screen.queryByText(label), null);
  }
  assert.doesNotMatch(document.body.textContent ?? "", /do-not-leak-this-diagnostic/);
  assert.equal(screen.queryByRole("button", { name: "Copy Diagnostic Info" }), null);
  assert.ok(screen.getAllByRole("button", { name: "Restart / Reset" }).length >= 1);
  assert.equal(screen.queryByTitle("Edit display name"), null);
  assert.equal(screen.queryByRole("button", { name: "Delete Agent" }), null);
});

test("mounted agent runtime badge opens Computer account usage only across the existing usage boundary", async () => {
  let usageReads = 0;
  api.get = (async (url: string) => {
    if (url === "/agents/agent-usage/runtime-options") {
      return { data: { options: [{ runtimeId: "codex", canSelectInThisContext: true }] } } as never;
    }
    if (url === "/servers/server-1/machines/machine-usage/runtime-models/codex") {
      return { data: { kind: "unsupported" } } as never;
    }
    if (url === "/servers/server-1/machines/machine-usage/runtime-account-usage/codex") {
      usageReads += 1;
      return {
        data: {
          state: "fresh",
          snapshot: {
            protocolVersion: 2,
            provider: "codex",
            collectedAt: "2026-08-20T00:00:00.000Z",
            staleAfter: "2026-08-20T01:00:00.000Z",
            collectorVersion: "test",
            accounts: [{
              accountKey: "c".repeat(64),
              planLabel: "Team",
              health: "ok",
              windows: [{
                id: "primary",
                label: "7 days",
                status: "ok",
                usedRatio: 0.4,
                resetsAt: "2026-08-27T00:00:00.000Z",
              }],
            }],
          },
        },
      } as never;
    }
    return { data: { kind: "unsupported" } } as never;
  }) as typeof api.get;

  const machine = {
    id: "machine-usage",
    name: "Creator Computer",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["codex"],
    hostname: "creator.local",
    os: "darwin",
    daemonVersion: "1.0.17",
    isComputer: true,
    computerAttachedByCurrentUser: true,
    creator: { type: "human", id: "user-1", name: "owner", displayName: "Owner", avatarUrl: null },
    computerVersion: "1.0.17",
    computerUpgradeAvailable: false,
    lastHeartbeat: null,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  const agent = {
    id: "agent-usage",
    name: "usage-agent",
    displayName: "Usage Agent",
    runtime: "codex",
    model: "gpt-5",
    status: "active",
    creatorType: "user",
    creatorId: "user-1",
    machineId: "machine-usage",
    deletedAt: null,
    lastRuntimeError: null,
  };

  setServerFeatureFlagForTests("server-1", RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, true);
  renderAgentEn(agent, { machines: [machine] });

  const runtimeBadge = await screen.findByRole("button", { name: "Codex CLI" });
  await waitFor(() => assert.equal(usageReads, 1));
  fireEvent.focus(runtimeBadge);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" })));
  assert.ok(screen.getByText("Team"));
  assert.ok(screen.getByText(/40% used/));

  cleanup();
  runtimeAccountUsageClient.clear();
  usageReads = 0;

  setServerFeatureFlagForTests("server-1", RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, true);
  renderAgentEn(agent, {
    role: "member",
    machines: [{ ...machine, computerAttachedByCurrentUser: false, creator: null }],
  });

  const inertRuntimeBadge = await screen.findByText("Codex CLI");
  assert.equal(inertRuntimeBadge.tagName, "SPAN");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(usageReads, 0);
});

test("mounted public external agent withholds last-activity timestamp and private tabs", async () => {
  renderAgentEn({
    id: "agent-external",
    name: "external-agent",
    displayName: "External Agent",
    runtime: "external",
    external: true,
    status: "active",
    creatorType: "user",
    creatorId: "user-2",
    deletedAt: null,
    lastRuntimeError: null,
  }, {
    role: "member",
    externalLastActivityAt: "2026-08-20T00:00:00.000Z",
  });

  await waitFor(() => assert.ok(screen.getByText("External")));
  assert.doesNotMatch(document.body.textContent ?? "", /Last activity/);
  for (const label of ["Activity", "Chat", "Reminders", "Workspace", "Apps", "MCP"]) {
    assert.equal(screen.queryByText(label), null);
  }
  assert.equal(screen.queryByRole("button", { name: "Restart / Reset" }), null);
});
