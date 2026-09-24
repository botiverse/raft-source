import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import AddMachineDialog from "../src/components/machine/AddMachineDialog";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

(import.meta as unknown as { env: Record<string, string | undefined> }).env = {
  VITE_DEPLOYMENT_ENV: "test",
};

const server: Server = {
  id: "server-1",
  name: "Design",
  avatarUrl: null,
  slug: "design",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-09T00:00:00.000Z",
};

const registeredMachine: Machine = {
  id: "machine-1",
  name: "my-computer",
  description: null,
  status: "offline",
  statusVersion: 1,
  apiKeyPrefix: "slk_test",
  runtimes: [],
  hostname: null,
  os: null,
  daemonVersion: null,
  isComputer: false,
  computerAttachedByCurrentUser: false,
  lastHeartbeat: null,
  createdAt: "2026-07-09T00:00:00.000Z",
};

function seedWaitingDialog() {
  useServerStore.setState({
    current: server,
    servers: [server],
    loading: false,
  } as never);
  useMachineStore.setState({
    machines: [],
    loading: false,
    registerMachine: async () => ({ machine: registeredMachine, apiKey: "sk_machine_test" }),
    loadMachines: async () => {},
    deleteMachine: async () => {},
  } as never);
}

async function renderWaitingDialog() {
  seedWaitingDialog();
  render(
    <MemoryRouter initialEntries={["/s/design"]}>
      <TestIntlProvider>
        <AddMachineDialog onClose={() => {}} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  });
  assert.ok(await screen.findByText("Waiting for computer to connect..."));
}

afterEach(() => {
  cleanup();
  useServerStore.setState(useServerStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
});

test("connect computer dialog does not expose inline device code approval", async () => {
  await renderWaitingDialog();

  assert.equal(screen.queryByText("Enter Authorization Code"), null);
  assert.equal(screen.queryByPlaceholderText("XXXX-XXXX"), null);
  assert.equal(screen.queryByRole("button", { name: "Approve" }), null);
  assert.ok(screen.getByText("Waiting for computer to connect..."));
});
