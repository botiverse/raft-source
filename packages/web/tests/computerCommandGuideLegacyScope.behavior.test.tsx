import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import ComputerCommandGuide from "../src/components/machine/ComputerCommandGuide";
import { TestIntlProvider } from "./helpers/intl";

/**
 * `ComputerCommandGuide` is SHARED by three surfaces: AddMachineDialog, MachineDetailPanel, and
 * the onboarding setup step. Task #197 closes the Legacy/Daemon entrance in ONLY the third one.
 *
 * This file exists because that scoping is the whole risk of the change. A global delete would
 * have been simpler and wrong: the Computers page has legitimate reasons to reach the legacy
 * path (attaching to an existing daemon fleet, recovering a raw machine), and stripping it there
 * would take an exit away from exactly the people #5254 already hurt.
 *
 * So the default is unchanged and asserted here, alongside the credential-masking coverage that
 * used to live in the onboarding Windows test. That coverage is about the guide, not about
 * onboarding — it must not disappear just because one caller stopped rendering the block.
 */

afterEach(() => cleanup());

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const SECRET = "sk_machine_windows_real_secret_1234";
const DAEMON_COMMAND = `npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key ${SECRET}`;

function renderGuide(props: Partial<React.ComponentProps<typeof ComputerCommandGuide>> = {}) {
  return render(
    <ComputerCommandGuide
      computerCommand="raft-computer setup /launch"
      computerInstallCommand="curl -fsSL https://downloads.raft.build/computer/install.sh | sh"
      windowsComputerCommand="raft-computer setup /launch"
      windowsComputerInstallCommand="irm https://cdn.raft.build/computer/install.ps1 | iex"
      macLinuxDaemonCommand="npx @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_abc"
      windowsDaemonCommand={DAEMON_COMMAND}
      {...props}
    />,
  );
}

test("default keeps the Legacy block — the Computers page is not touched by task #197", () => {
  renderGuide();
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  assert.ok(screen.getByTestId("windows-daemon-command-block"));
  assert.ok(screen.getByText("Daemon / Legacy"));
  assert.ok(screen.getByText(/npx\.cmd @botiverse\/raft-daemon/));
});

test("default still masks the daemon key in the DOM and on copy", async () => {
  const clipboardWrites: string[] = [];
  const consoleWrites: unknown[][] = [];
  const originalClipboard = navigator.clipboard;
  const consoleLog = mock.method(console, "log", (...args: unknown[]) => consoleWrites.push(["log", ...args]));
  const consoleError = mock.method(console, "error", (...args: unknown[]) => consoleWrites.push(["error", ...args]));
  const consoleWarn = mock.method(console, "warn", (...args: unknown[]) => consoleWrites.push(["warn", ...args]));
  const consoleInfo = mock.method(console, "info", (...args: unknown[]) => consoleWrites.push(["info", ...args]));
  const consoleDebug = mock.method(console, "debug", (...args: unknown[]) => consoleWrites.push(["debug", ...args]));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => clipboardWrites.push(value) },
  });

  try {
    renderGuide();
    fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

    assert.ok(screen.getByText(/sk_machine_win••••1234/), "the visible command contains only the bounded mask");
    assert.equal(document.body.innerHTML.includes(SECRET), false, "the complete key is absent from the rendered/screenshot surface");

    // Copy hands over the REAL command — masking is a display concern, not a functional one.
    fireEvent.click(screen.getByRole("button", { name: "Copy Windows daemon command" }));
    await waitFor(() => assert.deepEqual(clipboardWrites, [DAEMON_COMMAND]));
    assert.equal(document.body.innerHTML.includes(SECRET), false, "copying never switches the DOM to a visible-secret state");
    assert.equal(JSON.stringify(consoleWrites).includes(SECRET), false, "mask/copy never logs the complete key");
  } finally {
    consoleLog.mock.restore();
    consoleError.mock.restore();
    consoleWarn.mock.restore();
    consoleInfo.mock.restore();
    consoleDebug.mock.restore();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  }
});

test("default still offers to mint a Windows daemon command when the caller has none", () => {
  const onRequestWindowsDaemonCommand = mock.fn();
  renderGuide({ windowsDaemonCommand: "", onRequestWindowsDaemonCommand });
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  assert.equal(onRequestWindowsDaemonCommand.mock.callCount(), 0, "selecting Windows alone must not mint a credential");
  fireEvent.click(screen.getByTestId("computer-windows-daemon-request"));
  assert.equal(onRequestWindowsDaemonCommand.mock.callCount(), 1);
});

test("showLegacyDaemon={false} removes every Legacy affordance, including the mint request", () => {
  const onRequestWindowsDaemonCommand = mock.fn();
  // No windowsDaemonCommand: this is the state a fresh onboarding user is actually in, and it is
  // the branch that used to render the "generate a legacy command" button.
  renderGuide({ windowsDaemonCommand: "", onRequestWindowsDaemonCommand, showLegacyDaemon: false });
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  assert.equal(screen.queryByTestId("windows-daemon-command-block"), null);
  assert.equal(screen.queryByTestId("computer-windows-daemon-request"), null);
  assert.equal(screen.queryByText("Daemon / Legacy"), null);
  assert.equal(onRequestWindowsDaemonCommand.mock.callCount(), 0);

  // The Computer path is untouched by the flag — it suppresses the legacy route only.
  assert.ok(screen.getByText("irm https://cdn.raft.build/computer/install.ps1 | iex"));
});

test("showLegacyDaemon={false} suppresses a legacy command the caller already holds", () => {
  renderGuide({ showLegacyDaemon: false });
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  assert.equal(screen.queryByText(/npx\.cmd @botiverse\/raft-daemon/), null);
  assert.equal(document.body.innerHTML.includes(SECRET), false);
});
