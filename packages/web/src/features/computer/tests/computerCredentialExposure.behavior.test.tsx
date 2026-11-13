import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MachineDetailPanel } from "../MachineDetailPanel";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

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
  createdAt: "2026-10-19T00:00:00.000Z",
};

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1",
    name: "Build Box",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "build-box",
    os: "linux x64",
    daemonVersion: "1.0.0",
    lastHeartbeat: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

function seed(machines: Machine[]) {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    machines,
    loading: false,
    loadStatus: "loaded",
    loadError: false,
    computerOperationProgress: {},
    loadMachines: async () => {},
  });
}

function renderDetail(target: Machine) {
  seed([target]);
  return render(
    <MemoryRouter initialEntries={[`/s/acme/computers/${target.id}`]}>
      <MachineDetailPanel machine={target} hideHeader deploymentEnv="production" />
    </MemoryRouter>,
  );
}

// #proj-raft-computer task #38: the server sends `credentialExposureFoundAt`
// to the machine's owner only, so the page shows the warning whenever it is set.
test("a legacy machine whose key an agent may have read shows the warning, pointing to the move to Raft Computer", () => {
  renderDetail(machine({ isComputer: false, credentialExposureFoundAt: "2026-11-03T11:00:00.000Z" }));
  const banner = screen.getByTestId("computer-credential-exposure");
  assert.match(banner.textContent ?? "", /An agent may have read this computer's key/);
  assert.match(banner.textContent ?? "", /Move this computer to Raft Computer/);
  assert.match(banner.textContent ?? "", /Nov 3, 2026/);
});

test("no warning without a finding, and none on a Computer", () => {
  renderDetail(machine({ isComputer: false, credentialExposureFoundAt: null }));
  assert.ok(screen.queryByTestId("computer-credential-exposure") === null, "no credential exposure warning");
  cleanup();
  renderDetail(machine({ isComputer: true, credentialExposureFoundAt: "2026-11-03T11:00:00.000Z" }));
  assert.ok(screen.queryByTestId("computer-credential-exposure") === null, "no credential exposure warning");
});
