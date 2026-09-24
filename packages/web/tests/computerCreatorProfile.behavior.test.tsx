import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useProfileStore } from "../src/store/profileStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialProfileState = useProfileStore.getState();
const initialServerState = useServerStore.getState();

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const managedComputer: Machine = {
  id: "computer-1",
  name: "Creator's Computer",
  description: null,
  status: "offline",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "creator-computer.local",
  os: "darwin",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  creator: {
    type: "human",
    id: "creator-1",
    name: "ada",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    gravatarHash: null,
  },
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-08-08T00:00:00.000Z",
};

function renderMachine(machine: Machine) {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  return renderWithIntl(
    <MemoryRouter initialEntries={[`/s/acme/settings/computers/${machine.id}`]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useProfileStore.setState(initialProfileState, true);
  useServerStore.setState(initialServerState, true);
});

test("managed Computer renders its creator beside Created and opens the human profile", () => {
  renderMachine(managedComputer);

  assert.ok(screen.getByText("Created"));
  assert.ok(screen.getByText("Creator"));
  const creatorButton = screen.getByText("Ada Lovelace").closest("button");
  assert.ok(creatorButton);
  assert.equal(screen.getByText("@ada").closest("button"), creatorButton);

  fireEvent.click(creatorButton);
  assert.equal(useProfileStore.getState().profileType, "human");
  assert.equal(useProfileStore.getState().profileId, "creator-1");
});

test("raw daemon omits the Computer-only creator row", () => {
  renderMachine({
    ...managedComputer,
    id: "daemon-1",
    isComputer: false,
    computerAttachedByCurrentUser: false,
    creator: undefined,
    computerVersion: null,
  });

  assert.ok(screen.getByText("Created"));
  assert.equal(screen.queryByText("Creator"), null);
  assert.equal(screen.queryByText("Ada Lovelace"), null);
});

test("managed Computer with no current creator renders the existing fallback", () => {
  renderMachine({ ...managedComputer, creator: null });

  assert.ok(screen.getByText("Creator"));
  assert.ok(screen.getByText("No creator assigned"));
  assert.equal(screen.queryByText("Ada Lovelace"), null);
});
