import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MachineDetailPanel } from "../MachineDetailPanel";
import { useAgentStore } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const initialAgentState = useAgentStore.getState();
const initialAuthState = useAuthStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useAuthStore.setState(initialAuthState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

const ADOPTER = "user-adopter";
const PREVIOUS_OWNER = "user-previous-owner";

// A plain member: no machine capability, so only being the machine's controller offers its controls.
const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-owner",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-10-19T00:00:00.000Z",
};

/**
 * A Computer the adopter took over from its previous machine-row owner, whose
 * key was then revoked: no live attach record, so no controller
 * (computerControllerUserId is the live attacher only). The list sends no
 * attacher, creator or `controlledByCurrentUser` to anyone, and the row still
 * belongs to the previous owner (`userId`). Only owners and admins act on it.
 */
function revokedAdoptedComputer(): Machine {
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
    isComputer: false,
    computerAttachedByCurrentUser: false,
    creator: null,
    userId: PREVIOUS_OWNER,
    controlledByCurrentUser: false,
    runtimeDetection: { status: "incomplete", reason: "deadline", unfinishedRuntimes: [] },
  };
}

function renderAs(viewer: string, role: Server["role"] = "member") {
  const target = revokedAdoptedComputer();
  useAuthStore.setState({ user: { id: viewer } } as never);
  useServerStore.setState({ current: { ...server, role }, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    machines: [target],
    loading: false,
    loadStatus: "loaded",
    loadError: false,
    computerOperationProgress: {},
    loadMachines: async () => {},
  });
  return render(
    <MemoryRouter initialEntries={[`/s/acme/computers/${target.id}`]}>
      <MachineDetailPanel machine={target} hideHeader deploymentEnv="production" />
    </MemoryRouter>,
  );
}

const renameButton = () => screen.queryByRole("button", { name: "Edit computer name" });

test("after a revoke the adopter, a plain member, no longer gets rename or rescan: the revoked record names no controller", () => {
  renderAs(ADOPTER);
  assert.equal(renameButton() === null, true, "no rename for the former attacher");
  assert.equal(screen.queryByTestId("machine-runtime-detection-rescan") === null, true, "no rescan for the former attacher");
  assert.equal(screen.queryByTestId("machine-runtime-detection-rescan-hint") !== null, true, "the rescan-not-allowed hint instead");
});

test("after a revoke an admin still gets rename and rescan", () => {
  renderAs("user-admin", "admin");
  assert.equal(renameButton() !== null, true, "rename offered to the admin");
  assert.equal(screen.queryByTestId("machine-runtime-detection-rescan") !== null, true, "rescan offered to the admin");
});

test("after a revoke the previous machine-row owner gets neither, though the row is still theirs", () => {
  renderAs(PREVIOUS_OWNER);
  assert.equal(renameButton() === null, true, "no rename for the previous machine-row owner");
  assert.equal(screen.queryByTestId("machine-runtime-detection-rescan") === null, true, "no rescan for the previous machine-row owner");
  assert.equal(screen.queryByTestId("machine-runtime-detection-rescan-hint") !== null, true, "the rescan-not-allowed hint instead");
});

test("restart and upgrade stay hidden from the adopter on the revoked Computer", () => {
  renderAs(ADOPTER);
  assert.equal(screen.queryByTestId("computer-service-actions") === null, true, "no restart/upgrade card");
  assert.equal(screen.queryByTestId("computer-upgrade-actions") === null, true, "no upgrade actions");
  assert.equal(screen.queryByRole("button", { name: "Restart" }) === null, true, "no Restart button");
});
