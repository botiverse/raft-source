import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { useComputerUpgradeCard } from "../../../components/machine/useComputerUpgradeCard";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { ComputerServiceActionsCard } from "../ComputerServiceActionsCard";
import { RackRowAction } from "../RackRowAction";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

const server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-owner",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-10-19T00:00:00.000Z",
} satisfies Server;

/** An online Linux Computer the server would upgrade from the web to 1.0.59. */
function computer(overrides: Partial<Machine> = {}): Machine {
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
    computerVersion: "1.0.57",
    lastHeartbeat: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    isComputer: true,
    versionGate: null,
    remoteUpgradeSupported: true,
    computerUpgradeAvailable: true,
    computerBroadcastPolicy: {
      eligibility: "eligible",
      targetVersion: "1.0.59",
      targetRole: "independent_bugfix",
      migrationClass: "seamless",
      policyRevision: "rev-1",
      reasonCode: "eligible",
    },
    ...overrides,
  };
}

/** The Computer page's card and the Computers row, from the same hook, as the app wires them. */
function Surfaces({ machine }: { machine: Machine }) {
  const upgrade = useComputerUpgradeCard(machine);
  return (
    <>
      <ComputerServiceActionsCard
        machine={machine}
        computerOperationProgress={null}
        handleComputerRestartClick={() => {}}
        canControl
        cardState={upgrade.cardState}
        versionTier={upgrade.versionTier}
        webUpgradeOn={upgrade.webUpgradeOn}
        upgradeRefusal={upgrade.upgradeRefusal}
        recommendRepair={upgrade.recommendRepair}
        upgradeRequest={upgrade.upgradeRequest}
        requestOutcomeStillTrue={upgrade.requestOutcomeStillTrue}
        upgradeFailureHint={upgrade.upgradeFailureHint}
        handleRemoteUpgradeV2Click={upgrade.startUpgrade}
        computerFreshInstallCommands={{ install: "curl -fsSL https://raft.example/install.sh | sh" } as never}
        statusCommand={null}
        noResponseLine={null}
        releaseNotesForUpdate={null}
        windowsMachine={false}
        copiedCommand={null}
        handleCopy={() => {}}
        machineComputerCommands={null}
        terminalRestartCommand={null}
      />
      <RackRowAction
        machine={machine}
        canManage
        canControl
        variant="desktop"
        upgrade={upgrade}
        restart={{ progress: null } as never}
      />
    </>
  );
}

function renderFor(machine: Machine) {
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ machines: [machine], latestComputerVersion: "1.0.59", computerUpgradeSubmitting: {} });
  return render(<Surfaces machine={machine} />);
}

const EXPLANATION = /runs as a system service, so upgrading from the web would stop it mid-upgrade/;

test("unknown (no upgradeScope): Upgrade is offered on the card and the row, as before", () => {
  renderFor(computer());
  const cardButtons = Array.from(screen.getByTestId("computer-upgrade-actions").querySelectorAll("button")).map((button) => button.textContent);
  assert.deepEqual(cardButtons, ["Restart", "Upgrade to v1.0.59"], "the card's Upgrade");
  assert.ok(screen.queryByTestId("rack-upgrade-m1") !== null, "the row's Upgrade");
  assert.ok(screen.queryByText(EXPLANATION) === null, "no explanation");
});

test("an explicit refusal: no web Upgrade anywhere; one line says why and what to do, with the install command", () => {
  renderFor(computer({ upgradeScope: { ok: false, reason: "Failed to start transient scope unit: Access denied" } }));
  assert.ok(screen.queryByTestId("rack-upgrade-m1") === null, "no one-click Upgrade on the row");
  const status = screen.getByTestId("computer-upgrade-status");
  assert.match(status.textContent ?? "", EXPLANATION);
  assert.match(status.textContent ?? "", /stop its systemd service, run the install command below, then start the service again/);
  // The card's only buttons are Restart; the row's opens the steps (no web upgrade).
  const actions = screen.getByTestId("computer-upgrade-actions");
  assert.deepEqual(Array.from(actions.querySelectorAll("button")).map((button) => button.textContent), ["Restart"]);
  assert.ok(screen.queryByTestId("computer-upgrade-system-service") !== null, "the install command on the card");
  assert.ok(screen.queryByTestId("rack-manual-upgrade-m1") !== null, "the row opens the steps instead");
});
