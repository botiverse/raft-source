import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import {
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import { runtimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";
import { renderWithIntl } from "./helpers/intl";

const originalGet = api.get;
const originalPost = api.post;
const initialAgentState = useAgentStore.getState();
const initialAuthState = useAuthStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-08-10T00:00:00.000Z",
};

const computer: Machine = {
  id: "computer-1",
  name: "Shared Computer",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["codex"],
  runtimeVersions: { codex: "0.75.1" },
  hostname: "shared-computer.local",
  os: "darwin",
  daemonVersion: "1.0.15",
  isComputer: true,
  computerAttachedByCurrentUser: false,
  creator: null,
  computerVersion: "1.0.15",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-08-10T00:00:00.000Z",
};

function renderComputer(
  role: "admin" | "member",
  attachedByCurrentUser: boolean,
  createdByCurrentUser = false,
) {
  useAuthStore.setState({ user: { id: "user-1", name: "Member" } } as never);
  useServerStore.setState({
    current: { ...server, role },
    members: [],
  });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel
        machine={{
          ...computer,
          computerAttachedByCurrentUser: attachedByCurrentUser,
          creator: createdByCurrentUser
            ? { type: "human", id: "user-1", name: "member", displayName: "Member", avatarUrl: null }
            : null,
        }}
        workspaceEmbedded
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  runtimeAccountUsageClient.clear();
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useAuthStore.setState(initialAuthState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

test("runtime usage chip is interactive for server admins, the Computer attacher, or its human creator, but inert for other members", async () => {
  api.post = (async (url: string) => {
    assert.equal(url, "/feature-flags/evaluate");
    return {
      data: {
        evaluations: [{ key: RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, enabled: true }],
      },
    };
  }) as typeof api.post;

  let usageReads = 0;
  api.get = (async (url: string) => {
    usageReads += 1;
    assert.equal(url, "/servers/server-1/machines/computer-1/runtime-account-usage/codex");
    return {
      data: {
        state: "fresh",
        snapshot: {
          protocolVersion: 2,
          provider: "codex",
          collectedAt: "2026-08-10T00:00:00.000Z",
          staleAfter: "2026-08-10T01:00:00.000Z",
          collectorVersion: "1.0.15",
          accounts: [{
            accountKey: "c".repeat(64),
            planLabel: "Pro",
            health: "ok",
            windows: [{
              id: "primary",
              label: "7 days",
              status: "ok",
              usedRatio: 0.2,
              resetsAt: "2026-08-17T00:00:00.000Z",
            }],
          }],
        },
      },
    };
  }) as typeof api.get;

  await prefetchServerFeatureFlags(server.id);

  const adminView = renderComputer("admin", false);
  const adminChip = screen.getByText("Codex CLI");
  assert.equal(adminChip.tagName, "BUTTON", "a server admin can open another person's Computer usage");
  await waitFor(() => assert.equal(usageReads, 1));
  fireEvent.focus(adminChip);
  await waitFor(() => assert.equal(screen.getByTestId("runtime-version-codex").textContent, "Version 0.75.1"));
  adminView.unmount();
  runtimeAccountUsageClient.clear();

  const attacherView = renderComputer("member", true);
  const attacherChip = screen.getByText("Codex CLI");
  assert.equal(attacherChip.tagName, "BUTTON", "the attaching member keeps access without an admin role");
  await waitFor(() => assert.equal(usageReads, 2));
  attacherView.unmount();
  runtimeAccountUsageClient.clear();

  const creatorView = renderComputer("member", false, true);
  const creatorChip = screen.getByText("Codex CLI");
  assert.equal(creatorChip.tagName, "BUTTON", "the human creator keeps access after role demotion");
  await waitFor(() => assert.equal(usageReads, 3));
  creatorView.unmount();
  runtimeAccountUsageClient.clear();

  renderComputer("member", false);
  const bystanderChip = screen.getByText("Codex CLI");
  assert.equal(bystanderChip.tagName, "SPAN", "another ordinary member sees an inert runtime label");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(usageReads, 3, "an unauthorized member must not probe cached usage");
});
