import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { writeCreateAgentLastConfig } from "../src/utils/createAgentLastConfig";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;
const originalPost = api.post;

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function seedCreateAgentStores() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-14T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["claude"],
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

test("catalog pins create-agent residue MessageIds", () => {
  assert.equal(en["agent.create.failedCreate"], "Failed to create agent");
  assert.equal(en["agent.create.viewPlans"], "View Plans");
  assert.equal(en["agent.create.suggestedByActionCard"], "Suggested by the action card.");
  assert.equal(
    en["agent.create.suggestedComputerUnavailable"],
    "The suggested computer is unavailable. Pick a computer to continue.",
  );
  assert.equal(en["agent.create.offlineSuffix"], " (offline)");
  assert.match(en["agent.create.capacityReached"], /\{limitLabel\}/);
  assert.match(en["agent.create.capacityReached"], /<upgrade>/);
  assert.match(en["agent.create.requiresDaemon"], /\{version\}/);
  assert.match(zh["agent.create.failedCreate"], /\p{Script=Han}/u);
  assert.match(zh["agent.create.capacityReached"], /\{usage\}/);
});

test("create-agent ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "agent.create.failedCreate" }),
    /Failed to create/,
  );
  assert.match(
    String(
      zhIntl.formatMessage(
        { id: "agent.create.capacityReached" },
        {
          limitLabel: "Agents",
          usage: 3,
          limit: 3,
          planName: "Free",
          upgrade: (chunks) => chunks,
        },
      ),
    ),
    /\p{Script=Han}/u,
  );
});

test("mounted CreateAgentDialog renders Chinese chrome instead of English residue", () => {
  seedCreateAgentStores();
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="zh-cn">
        <CreateAgentDialog onClose={() => undefined} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("heading", { name: zh["agent.create.dialogTitle"] }));
  assert.ok(screen.getByRole("button", { name: zh["common.confirm.cancel"] }));
  assert.equal(screen.queryByRole("heading", { name: "Create Agent" }), null);
  assert.equal(screen.queryByRole("button", { name: "Cancel" }), null);
  assert.doesNotMatch(document.body.textContent ?? "", /Failed to create agent/);
  assert.doesNotMatch(document.body.textContent ?? "", /Suggested by the action card/);
});

test("mounted CreateAgentDialog surfaces Chinese generic-create fallback after a failed submit", async () => {
  seedCreateAgentStores();
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
  });
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "claude",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: false,
            availableForNew: true,
            manageableForCurrentAgent: false,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    return {
      data: {
        models: [
          { id: "opus", label: "Claude Opus" },
          { id: "sonnet", label: "Claude Sonnet" },
        ],
        default: "opus",
      },
    } as never;
  }) as typeof api.get;
  api.post = (async (url: string) => {
    assert.equal(url, "/agents");
    throw new Error("network blip");
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="zh-cn">
        <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  await waitFor(() => {
    const selected = screen.getAllByRole("combobox").map((el) => el.textContent ?? "");
    assert.ok(selected.some((text) => text.includes("Claude Code")), selected.join(" | "));
    assert.ok(selected.some((text) => text.includes("Claude Sonnet")), selected.join(" | "));
  });
  fireEvent.change(screen.getByPlaceholderText(zh["agent.create.namePlaceholder"]), {
    target: { value: "Alice" },
  });
  const submit = screen.getByRole("button", { name: zh["agent.create.submitCreateAgent"] });
  await waitFor(() => assert.equal((submit as HTMLButtonElement).disabled, false));
  fireEvent.click(submit);

  assert.ok(await screen.findByText(zh["agent.create.failedCreate"]));
  assert.doesNotMatch(document.body.textContent ?? "", /Failed to create agent/);
});
