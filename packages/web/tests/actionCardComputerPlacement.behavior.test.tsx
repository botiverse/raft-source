import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { ActionCard } from "../src/components/actions/ActionCard";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
const originalPost = api.post;

function render(ui: ReactElement) {
  return rtlRender(<TestIntlProvider>{ui}</TestIntlProvider>);
}

function seedPlacementStores() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "server",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  const machine = {
    id: "machine-1",
    name: "Required Studio",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["codex"],
    hostname: "required.local",
    os: "darwin",
    daemonVersion: "1.0.13",
    lastHeartbeat: "2026-07-22T00:00:00.000Z",
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  useMachineStore.setState({
    machines: [
      machine,
      { ...machine, id: "machine-2", name: "Alternative Studio", hostname: "alternative.local" },
    ],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "source-channel",
      serverId: "server-1",
      name: "source-channel",
      type: "channel",
      joined: true,
      archivedAt: null,
    }],
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function mockPlacementApi() {
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: url.includes("machine-2") ? "machine-2" : "machine-1",
          options: [{
            runtimeId: "codex",
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
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (/^\/actions\/[^/]+\/event$/.test(url)) return { data: {} } as never;
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
}

function renderPlacementActionCard(mode: "required" | "suggested") {
  seedPlacementStores();
  mockPlacementApi();
  const targetKey = mode === "required" ? "requiredComputer" : "suggestedComputer";
  const metadata = {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "agent:create",
      name: "Placed Agent",
      [targetKey]: "machine-1",
    },
  } as const;

  render(
    <MemoryRouter initialEntries={["/s/server/channel/source-channel"]}>
      <ActionCard
        messageId={`placement-${mode}`}
        channelId="source-channel"
        metadata={metadata as never}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("agent:create ActionCard carries a required Computer into the real create dialog", async () => {
  renderPlacementActionCard("required");

  assert.ok(screen.getByText("Required computer:"));
  assert.ok(screen.getByText("Required Studio"));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  assert.ok(await screen.findByText("Required by the action card: Required Studio."));
  const computerSelect = screen.getAllByRole("combobox")[0];
  assert.match(computerSelect?.textContent ?? "", /Required Studio/);
  fireEvent.click(computerSelect!);
  const alternative = await screen.findByRole("option", { name: "Alternative Studio (alternative.local)" });
  assert.equal(alternative.getAttribute("aria-disabled"), "true");
});

test("agent:create ActionCard carries a suggested Computer without locking alternatives", async () => {
  renderPlacementActionCard("suggested");

  assert.ok(screen.getByText("Suggested computer:"));
  assert.ok(screen.getByText("Required Studio"));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  assert.ok(await screen.findByText("Suggested by the action card."));
  const computerSelect = screen.getAllByRole("combobox")[0];
  assert.match(computerSelect?.textContent ?? "", /Required Studio/);
  fireEvent.click(computerSelect!);
  const alternative = await screen.findByRole("option", { name: "Alternative Studio (alternative.local)" });
  assert.notEqual(alternative.getAttribute("aria-disabled"), "true");
});
