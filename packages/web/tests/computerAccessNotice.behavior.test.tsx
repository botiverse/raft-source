import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AddMachineDialog from "../src/components/machine/AddMachineDialog";
import ServerSetupComputerRuntimeStep from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";

// Task #475: connecting a Computer says, before anything is connected, that
// agents on it can read and write files and run commands and local tools with
// the person's own access. Shown once: on Add Computer's choice, or on its
// command when the dialog opens there (a browser), and above onboarding's
// connect step. Assertions compare strings / booleans only.

const NOTICE = "Agents work on this computer: they can read and write files and run commands and local tools, with the same access as your account.";

const desktop = vi.hoisted(() => ({ host: null as null | { ready: boolean; self: { deviceKind: "mac"; machineId: null } } }));
vi.mock("../src/components/machine/localComputer/useLocalComputerHost", () => ({
  useLocalComputerHost: () => desktop.host,
}));
// No plan caps Computers today; the limit test gives one a cap of 1.
const limits = vi.hoisted(() => ({ maxMachines: null as number | null }));
vi.mock("@botiverse/raft-shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@botiverse/raft-shared")>();
  return {
    ...shared,
    getEffectiveLimits: (...args: Parameters<typeof shared.getEffectiveLimits>) => {
      const real = shared.getEffectiveLimits(...args);
      return limits.maxMachines === null ? real : { ...real, maxMachines: limits.maxMachines };
    },
  };
});
vi.mock("../src/components/machine/localComputer/useAddComputerOnDesktop", () => ({
  useAddComputerOnDesktop: (host: unknown) => (host ? { kind: "connect" } : null),
}));

const initialServerState = useServerStore.getState();
const initialMachineState = useMachineStore.getState();

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

beforeEach(() => {
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ machines: [], addMachineIntent: null, loadMachines: async () => undefined });
});

afterEach(() => {
  cleanup();
  desktop.host = null;
  limits.maxMachines = null;
  useServerStore.setState(initialServerState, true);
  useMachineStore.setState(initialMachineState, true);
});

function noticeCount(): number {
  return screen.queryAllByText(NOTICE).length;
}

function mountDialog() {
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computers"]}>
      <AddMachineDialog onClose={() => undefined} />
    </MemoryRouter>,
  );
}

test("browser: Add Computer opens on the command and says what agents can do there, above the command", () => {
  mountDialog();
  assert.equal(noticeCount(), 1);
  const notice = screen.getByTestId("computer-access-notice");
  const hint = screen.getByTestId("add-machine-own-computer-hint");
  assert.equal(notice.textContent, NOTICE);
  // Part of the step, read before acting: not a live region that interrupts a screen reader.
  assert.equal(notice.getAttribute("role"), null);
  assert.equal(Boolean(notice.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING), true);
});

test("Raft Desktop: the notice is on the Which computer? choice, and not repeated on the command after it", () => {
  desktop.host = { ready: true, self: { deviceKind: "mac", machineId: null } };
  mountDialog();
  assert.equal(screen.queryByText("Which computer?") !== null, true);
  assert.equal(noticeCount(), 1);

  fireEvent.click(screen.getByText("Another computer"));
  fireEvent.click(screen.getByTestId("add-machine-next"));
  assert.equal(screen.queryByTestId("add-machine-other-computer-hint") !== null, true);
  assert.equal(noticeCount(), 0);
});

test("browser at the plan's limit: the choice says the limit, not what agents can do", () => {
  limits.maxMachines = 1;
  useMachineStore.setState({
    machines: [{ id: "m-1", name: "m-1", status: "online", runtimes: [], isComputer: true } as unknown as Machine],
  });
  mountDialog();
  assert.equal(screen.queryByText("Which computer?") !== null, true);
  assert.equal(noticeCount(), 0);
});

type OnboardingState = { hasConnectedComputer: boolean; online: boolean };

function onboardingStep({ hasConnectedComputer, online }: OnboardingState) {
  return (
    <ServerSetupComputerRuntimeStep
      computer={hasConnectedComputer ? { id: "computer-1", name: "MacBook", status: online ? "online" : "offline", runtimeIds: [], isComputer: true } : null}
      runtimeStatus="checking"
      runtimeOptions={[]}
      hasConnectedComputer={hasConnectedComputer}
      canReset={false}
      offlineComputers={hasConnectedComputer && !online ? [{ id: "computer-1", name: "MacBook", lastHeartbeat: null }] : undefined}
      serverSlug="acme"
      computerInstallCommand=""
      windowsComputerInstallCommand=""
      windowsComputerSetupCommand={null}
      setupCommand="raft-computer setup /acme"
      onCopyInstallCommand={() => undefined}
      onOpenApiKeySettings={() => undefined}
      onNext={() => undefined}
    />
  );
}

function mountOnboarding(state: OnboardingState) {
  return render(onboardingStep(state), { wrapper: TestIntlProvider });
}

test("onboarding: the connect step says it once, above the command", () => {
  mountOnboarding({ hasConnectedComputer: false, online: false });
  assert.equal(noticeCount(), 1);
  const notice = screen.getByTestId("computer-access-notice");
  const command = screen.getByText("raft-computer setup /acme");
  assert.equal(Boolean(notice.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING), true);
  assert.equal(notice.getAttribute("role"), null);
});

test("onboarding: a fresh connect keeps the same notice once the computer comes online", () => {
  const view = mountOnboarding({ hasConnectedComputer: false, online: false });
  const before = screen.getByTestId("computer-access-notice");
  view.rerender(onboardingStep({ hasConnectedComputer: true, online: true }));
  assert.equal(screen.queryByTestId("onboarding-computer-connected") !== null, true);
  assert.equal(noticeCount(), 1);
  // The very node it was, so nothing above the command moves.
  assert.equal(screen.getByTestId("computer-access-notice") === before, true);
});

test("onboarding: returning with a computer already connected and online does not say it", () => {
  mountOnboarding({ hasConnectedComputer: true, online: true });
  assert.equal(screen.queryByTestId("onboarding-computer-connected") !== null, true);
  assert.equal(noticeCount(), 0);
});

test("onboarding: bringing back a computer already connected does not say it again", () => {
  mountOnboarding({ hasConnectedComputer: true, online: false });
  assert.equal(screen.queryByTestId("onboarding-offline-recovery") !== null, true);
  assert.equal(noticeCount(), 0);
});
