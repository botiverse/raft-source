import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { getSetupRuntimeOptions } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import ServerSetupComputerRuntimeStep, {
  getServerSetupRuntimeCatalog,
} from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Screen A, as stdrc specified it (2026-07-12, #proj-onboarding:37429614):
 *
 *   "你会先给它命令，让它运行，并给出一个期待的可能流程。流程跑完之后，会有一个打勾的
 *    提示，表示 computer 连上了。接着显示 detecting runtime，detect 到之后又会打一个勾。"
 *
 * So: the setup command stays on screen, and underneath it a log prints the real
 * sequence, one tick at a time. There is no separate "Detect Runtime" step, no
 * "Connected" pill, no collapsible section, and no stepper — the old stepper had
 * three labels but only two reachable states, and its middle step could never be
 * current, because the browser cannot observe "the user ran the command".
 */

afterEach(() => cleanup());

const noop = () => undefined;
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

function setupRuntimeOptions(
  runtimeIds: readonly string[],
  include: (runtimeId: string) => boolean = () => true,
): RuntimeSelectionOption[] {
  const installed = new Set(runtimeIds);
  return getSetupRuntimeOptions()
    .filter((runtime) => include(runtime.id))
    .map((runtime) => {
      const capabilityStatus = installed.has(runtime.id)
        ? "available" as const
        : runtime.binary === ""
          ? "update_required" as const
          : "not_installed" as const;
      return {
        runtimeId: runtime.id,
        capabilityStatus,
        admissionStatus: "available_for_new" as const,
        admissionReason: null,
        current: false,
        availableForNew: true,
        manageableForCurrentAgent: false,
        canSelectInThisContext: capabilityStatus === "available",
      };
    });
}

function renderStep({
  runtimeIds = [],
  connected = true,
  status = "online",
  runtimeStatus = "checking" as const,
  hasConnectedComputer = false,
  isComputer = true,
  offlineComputers,
  computerInstallCommand = "",
  windowsComputerInstallCommand = "",
  windowsComputerSetupCommand = null,
  windowsDaemonCommand = "npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_abc",
  setupCommand = "curl install && raft-computer setup /launch",
  onRequestWindowsDaemonCommand,
  windowsDaemonCommandPending = false,
  canReset = false,
  onStartOver,
}: {
  runtimeIds?: string[];
  connected?: boolean;
  status?: "online" | "offline";
  /** The SERVER's verdict, off the setup projection. The browser never derives this. */
  runtimeStatus?: "ready_recommended" | "ready_other" | "not_ready" | "checking" | "error" | "unknown";
  /** DURABLE: a non-revoked computer exists. Not "a computer is online". */
  hasConnectedComputer?: boolean;
  isComputer?: boolean;
  offlineComputers?: Array<{ id: string; name: string; lastHeartbeat: string | null; isComputer?: boolean }>;
  computerInstallCommand?: string;
  windowsComputerInstallCommand?: string;
  windowsComputerSetupCommand?: string | null;
  windowsDaemonCommand?: string;
  setupCommand?: string;
  onRequestWindowsDaemonCommand?: () => void;
  windowsDaemonCommandPending?: boolean;
  /** The exits the SERVER allows. `defer` bypasses an unfinished setup; `reset` rolls it back. */
  canReset?: boolean;
  onStartOver?: () => void;
} = {}) {
  return render(
    <ServerSetupComputerRuntimeStep
      computer={connected ? { id: "computer-1", name: "Wenyi's MacBook Pro", status, runtimeIds, isComputer } : null}
      runtimeStatus={runtimeStatus}
      runtimeOptions={setupRuntimeOptions(runtimeIds)}
      hasConnectedComputer={hasConnectedComputer}
      canReset={canReset}
      onStartOver={onStartOver}
      offlineComputers={offlineComputers}
      serverSlug="launch"
      computerInstallCommand={computerInstallCommand}
      windowsComputerInstallCommand={windowsComputerInstallCommand}
      windowsComputerSetupCommand={windowsComputerSetupCommand}
      setupCommand={setupCommand}
      macLinuxDaemonCommand="npx @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_abc"
      windowsDaemonCommand={windowsDaemonCommand}
      onRequestWindowsDaemonCommand={onRequestWindowsDaemonCommand}
      windowsDaemonCommandPending={windowsDaemonCommandPending}
      onCopyInstallCommand={noop}
      onOpenApiKeySettings={noop}
      onNext={noop}
    />,
  );
}

test("fresh connect renders split install and setup commands with independent copy actions", async () => {
  const clipboardWrites: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboardWrites.push(value);
      },
    },
  });

  try {
    renderStep({
      connected: false,
      computerInstallCommand: "curl -fsSL https://downloads.raft.build/computer/install.sh | sh",
      setupCommand: "raft-computer setup /launch",
    });

    assert.ok(screen.getByText("1. Install"));
    assert.ok(screen.getByText("2. Setup"));
    assert.ok(screen.getByText("curl -fsSL https://downloads.raft.build/computer/install.sh | sh"));
    assert.ok(screen.getByText("raft-computer setup /launch"));

    fireEvent.click(screen.getByRole("button", { name: "Copy 1. install command" }));
    await waitFor(() => {
      assert.deepEqual(clipboardWrites, ["curl -fsSL https://downloads.raft.build/computer/install.sh | sh"]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy 2. setup command" }));
    await waitFor(() => {
      assert.deepEqual(clipboardWrites, [
        "curl -fsSL https://downloads.raft.build/computer/install.sh | sh",
        "raft-computer setup /launch",
      ]);
    });
  } finally {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});

function logLines() {
  return [...screen.getByTestId("onboarding-connect-log").querySelectorAll("li")].map((line) => ({
    key: line.getAttribute("data-line"),
    state: line.getAttribute("data-state"),
    text: line.textContent,
  }));
}

test("runtime catalog is derived from the shared registry with Screen B filtering and order", () => {
  const catalog = getServerSetupRuntimeCatalog(setupRuntimeOptions([]));
  assert.deepEqual(catalog.recommended.map((runtime) => runtime.displayName), ["Claude Code", "Codex CLI"]);
  assert.deepEqual(catalog.supported.map((runtime) => runtime.displayName), [
    "Copilot CLI",
    "Cursor CLI",
    "Grok Build",
    "Kimi Code",
    "OpenCode",
    "Pi",
  ]);
  assert.equal([...catalog.recommended, ...catalog.supported].some((runtime) => runtime.id === "builtin"), false);
  assert.equal([...catalog.recommended, ...catalog.supported].some((runtime) => runtime.id === "kimi"), false);
  assert.equal([...catalog.recommended, ...catalog.supported].some((runtime) => runtime.id === "gemini"), false);

  const detectedLegacy = getServerSetupRuntimeCatalog(setupRuntimeOptions(["kimi", "gemini"]));
  assert.equal([...detectedLegacy.recommended, ...detectedLegacy.supported].some((runtime) => runtime.id === "kimi"), false);
  assert.equal([...detectedLegacy.recommended, ...detectedLegacy.supported].some((runtime) => runtime.id === "gemini"), false);
});

test("flag-off Grok capability is absent from the server-owned setup catalog", () => {
  render(
    <ServerSetupComputerRuntimeStep
      computer={{ id: "computer-1", name: "Grok computer", status: "online", runtimeIds: ["grok"] }}
      runtimeStatus="not_ready"
      runtimeOptions={setupRuntimeOptions(["grok"], (runtimeId) => runtimeId !== "grok")}
      onNext={noop}
    />,
  );

  assert.equal(screen.queryByText("Grok Build"), null);
  assert.deepEqual(logLines().at(-1), {
    key: "runtime",
    state: "failed",
    text: "No usable runtime found on this computer.",
  });
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("deprecated detected runtimes stay out of the setup log and readiness path", () => {
  renderStep({ runtimeIds: ["gemini", "kimi"], runtimeStatus: "not_ready" });

  assert.deepEqual(logLines().at(-1), { key: "runtime", state: "failed", text: "No usable runtime found on this computer." });
  assert.equal(screen.queryByText(/Gemini CLI/i), null);
  assert.equal(screen.queryByText(/Kimi CLI/i), null);
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("nothing run yet: the command, the instructions, and one waiting line", () => {
  renderStep({ connected: false });

  assert.ok(screen.getByText("curl install && raft-computer setup /launch"));
  // Copying is the shared guide's: the button turns into a tick, no toast.
  assert.ok(screen.getByRole("button", { name: "Copy Computer CLI command" }));
  assert.deepEqual(logLines(), [
    {
      key: "approve",
      state: "pending",
      text: "Waiting for you to run the command and approve it in your browser…",
    },
  ]);
  // Instructions, not a progress tracker: nothing here claims to know what the
  // user has done in their terminal.
  assert.ok(screen.getByText("Paste the command above into your terminal and press Enter."));
  assert.equal(screen.queryByText(/Step \d/i), null);
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("approved but not yet online: the first tick lands and the next line starts waiting", () => {
  renderStep({ status: "offline" });

  assert.deepEqual(logLines(), [
    { key: "approve", state: "done", text: "Request approved." },
    { key: "online", state: "pending", text: "Waiting for Wenyi's MacBook Pro to come online…" },
  ]);
  assert.equal(screen.queryByText("No usable runtime yet"), null);
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("online but no runtime yet: two ticks, detection running, and NOTHING else flashes up", () => {
  renderStep();

  assert.deepEqual(logLines(), [
    { key: "approve", state: "done", text: "Request approved." },
    { key: "online", state: "done", text: "Wenyi's MacBook Pro is connected." },
    { key: "runtime", state: "pending", text: "Detecting runtime…" },
  ]);
  // A computer comes online a beat before its runtime list arrives. The education box
  // used to render in that gap and then vanish when the list landed — a box full of
  // runtime rows flashing up inside the modal for a fraction of a second. "Not answered
  // yet" is not "nothing usable found".
  assert.equal(screen.queryByText("No usable runtime yet"), null);
  assert.equal(screen.queryByText("Recommended"), null);
  assert.equal(screen.queryByRole("button", { name: /Claude Code/i }), null);
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("runtime detected: the third tick names EVERY runtime found, and Next opens", () => {
  // `runtimeReady` is the server's verdict. The log lines still come from the machine
  // store (they describe what the computer reported), but the GATE is the server's.
  renderStep({ runtimeIds: ["claude"], runtimeStatus: "ready_recommended" });
  assert.deepEqual(logLines().at(-1), { key: "runtime", state: "done", text: "Runtime detected: Claude Code." });

  // A machine with four runtimes installed said "Runtime detected: Claude Code." and
  // stopped, which reads like detection gave up at the first hit (stdrc, 2026-07-13).
  cleanup();
  renderStep({ runtimeIds: ["claude", "codex", "opencode", "pi"], runtimeStatus: "ready_recommended" });
  assert.deepEqual(logLines(), [
    { key: "approve", state: "done", text: "Request approved." },
    { key: "online", state: "done", text: "Wenyi's MacBook Pro is connected." },
    { key: "runtime", state: "done", text: "Runtimes detected: Claude Code, Codex CLI, OpenCode, Pi." },
  ]);
  // The command stays put: it is what the user just ran, and they may need it again
  // for a second machine.
  assert.ok(screen.getByText("curl install && raft-computer setup /launch"));
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, false);
});

test("a successful connect leaves no runtime box and no empty bordered strip behind it", () => {
  const { container } = renderStep({ runtimeIds: ["claude"], runtimeStatus: "ready_recommended" });

  assert.equal(screen.queryByText("No usable runtime yet"), null);
  assert.equal(screen.queryByRole("heading", { name: /Detect Runtime/i }), null);
  // The box used to render even with nothing in it, which drew a stray line across
  // the page under the log.
  assert.equal(
    [...container.querySelectorAll("div.border-2")].some((node) => node.textContent?.trim() === ""),
    false,
  );
  // Renaming is not part of connecting: it lived here as a link nobody needed mid-flow.
  assert.equal(screen.queryByRole("button", { name: /Rename/i }), null);
});

test("Pi is bundled with the computer, so a bare machine still detects a runtime", () => {
  // The daemon ships Pi in-process and its probe returns available unconditionally,
  // so a user who has installed no CLI at all still gets a usable runtime. Built-in
  // Pi (`builtin`) is NOT that: it runs on the user's own provider key, so it is
  // excluded everywhere and cannot open the gate on its own.
  renderStep({ runtimeIds: ["pi"], runtimeStatus: "ready_recommended" });
  assert.deepEqual(logLines().at(-1), { key: "runtime", state: "done", text: "Runtime detected: Pi." });
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, false);

  cleanup();
  renderStep({ runtimeIds: ["builtin"], runtimeStatus: "not_ready" });
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("a computer that answers with nothing usable prints a failure line, it does not spin forever", () => {
  renderStep({ runtimeIds: ["builtin"], runtimeStatus: "not_ready" });

  assert.deepEqual(logLines().at(-1), {
    key: "runtime",
    state: "failed",
    text: "No usable runtime found on this computer.",
  });
  assert.ok(screen.getByText("No usable runtime yet"));
});

test("no usable runtime keeps the education box, without turning it into a chooser", () => {
  // Reported (builtin only), so the question IS answered and the box belongs here.
  renderStep({ runtimeIds: ["builtin"], runtimeStatus: "not_ready" });
  assert.ok(screen.getByText("No usable runtime yet"));
  fireEvent.click(screen.getByRole("button", { name: /Own API key/i }));
  assert.ok(screen.getByText("Use your own API key instead of installing a runtime."));
  assert.equal(screen.queryByText(/same tier|not a fallback/i), null);
});

// task #159 — the whole point of the SSOT change. The machine store can shout
// "claude is installed!" all it likes; if the SERVER has not said the runtime is
// usable, Next stays dead. A client-side second opinion has no authority here.
test("a runtime visible in the machine store cannot enable Next by itself", () => {
  renderStep({ runtimeIds: ["claude"], runtimeStatus: "not_ready" });
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

// The inverse, and it is the one that used to break: the server says ready, but the
// socket-fed store has not caught up (dropped event / stale tab / replica lag). The
// card and Next must BOTH follow the server, not the store.
// @Dozy, task #160: a stale store holding a runtime must not be able to render
// "detection failed" while the server is still saying `checking`. "We have not been told
// yet" is not a finding, and drawing it as one is how we render OUR uncertainty as the
// USER's failure.
test("checking is not a verdict: a stale store cannot render a failure the server never issued", () => {
  renderStep({ runtimeIds: ["builtin"], runtimeStatus: "checking" });
  assert.equal(screen.queryByText("No usable runtime yet"), null, "no failure box while the server is still checking");
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});

test("the server's verdict enables Next even when the store has not caught up", () => {
  renderStep({ runtimeIds: [], runtimeStatus: "ready_recommended" });
  assert.equal((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, false);
  // and the failure block must not claim "no usable runtime" against the server's word
  assert.equal(screen.queryByText("No usable runtime yet"), null);
});

/**
 * #5254 / task #197 — the Legacy/Daemon entrance is retired from FIRST CONNECT.
 *
 * This test previously asserted the opposite ("retains the legacy daemon"), and it was right
 * for its time: on Windows the legacy daemon was the only path that existed. It is not an
 * alternative route any more. XX's RCA: a legacy connect creates a raw `machines` row and never
 * the managed `computers` attachment the setup projection gates on, so from inside onboarding it
 * is a deterministic dead end — the user runs the command, the daemon connects, and the gate
 * still says "Waiting for you to run the command". That is 杨战中's hard-lock.
 *
 * Scope this pins deliberately: only the FIRST-CONNECT entrance closes. People who already own a
 * legacy machine keep their command (see the `onboarding-recovery-legacy-daemon` test below —
 * that one must stay green), and the Computers page is untouched (see the shared-component test).
 * Closing the entrance stops NEW arrivals; it repairs nobody already stuck. Terminal-failure
 * signalling and raw-machine repair are Computer tasks #399/#400, not this change.
 */
test("first connect on Windows offers Computer only — no Legacy entrance, and no way to mint a legacy key", async () => {
  const secret = "sk_machine_windows_real_secret_1234";
  const daemonCommand = `npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key ${secret}`;
  const onRequestWindowsDaemonCommand = mock.fn();

  renderStep({
    connected: false,
    windowsComputerInstallCommand: "irm https://cdn.raft.build/computer/install.ps1 | iex",
    windowsComputerSetupCommand: "raft-computer setup /launch",
    // Supplied on purpose: even when the caller HAS a legacy command in hand, first connect
    // must not surface it. Hiding must not depend on the command being absent.
    windowsDaemonCommand: daemonCommand,
    onRequestWindowsDaemonCommand,
  });

  assert.ok(screen.getByRole("radio", { name: "macOS / Linux" }));
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  // The supported path is intact — this is a removal, not a regression of the real route.
  assert.ok(screen.getByText("Experimental"));
  assert.ok(screen.getByText("Raft Computer · Windows x64"));
  assert.ok(screen.getByText("irm https://cdn.raft.build/computer/install.ps1 | iex"));
  assert.ok(screen.getByText("raft-computer setup /launch"));
  assert.ok(screen.getByText("Approve the request when it opens in your browser."));
  assert.ok(screen.getByText("Open PowerShell and run the Install and Setup commands above."));
  assert.deepEqual(logLines(), [
    { key: "approve", state: "pending", text: "Waiting for you to run the command and approve it in your browser…" },
  ]);

  // The dead end is gone, in all three of its shapes.
  assert.equal(screen.queryByTestId("windows-daemon-command-block"), null, "no Legacy block at first connect");
  assert.equal(screen.queryByText("Daemon / Legacy"), null);
  assert.equal(screen.queryByText(/npx\.cmd @botiverse\/raft-daemon/), null);
  assert.equal(
    screen.queryByTestId("computer-windows-daemon-request"),
    null,
    "no button offering to generate a legacy daemon command",
  );

  // And nothing minted a credential on the way. This is the property that matters most: the
  // entrance is closed at the credential boundary, not merely hidden behind CSS.
  assert.equal(onRequestWindowsDaemonCommand.mock.callCount(), 0);
  assert.equal(document.body.innerHTML.includes(secret), false);

  // mac/Linux first connect is closed too — the legacy npx line was never Windows-only.
  fireEvent.click(screen.getByRole("radio", { name: "macOS / Linux" }));
  assert.equal(screen.queryByText(/npx @botiverse\/raft-daemon/), null, "no Legacy block at first connect on mac/Linux");
  assert.equal(onRequestWindowsDaemonCommand.mock.callCount(), 0);
});


// stdrc, 2026-07-13: a user who already connected a computer and simply rebooted must not
// be handed the install+setup commands again. The binary is already on that machine —
// re-running setup there changes nothing. `MachineDetailPanel` (task #247) worked this out
// first: "the binary is already on the machine — so this replaces the old install+setup
// surface." Onboarding was shipping a second opinion; now it reuses the answer.
test("a computer that is merely offline gets the START command, not install+setup again", () => {
  renderStep({
    connected: true,
    status: "offline",
    hasConnectedComputer: true,
    runtimeStatus: "unknown",
    canReset: true,
  });

  // The one thing they can actually do.
  assert.ok(screen.getByTestId("onboarding-offline-recovery"));
  // Same words Machine Detail uses — one product, one voice.
  assert.ok(screen.getByText(/Bring Wenyi's MacBook Pro back online/i));
  assert.ok(screen.getByText(/set up on \/launch but isn't connected right now/i));
  assert.equal(screen.getByTestId("onboarding-recovery-start-command").textContent, "raft-computer start");

  // And NOT the thing that would change nothing.
  assert.equal(screen.queryByText(/curl install/), null, "no install command for a machine that already has the binary");

  // The way out is ON THIS CARD, beside the machine that failed — not in the modal's bottom
  // corner, a room away from the thing it undoes. We do not guess "offline for N days ⇒ it's
  // dead": only the user knows that, so the door goes where they are already looking.
  assert.ok(screen.getByTestId("onboarding-recovery-start-over"));
});

test("someone who has never connected a computer still gets the install + setup commands", () => {
  renderStep({ connected: false, hasConnectedComputer: false });
  assert.equal(screen.queryByTestId("onboarding-offline-recovery"), null);
  assert.ok(screen.getByText("curl install && raft-computer setup /launch"));
});

// The answer to "none of these work" is NOT "connect another one" (@stdrc). That leaves the
// dead machines behind, and hands back the same install command they already could not run.
// It is "throw this away and start again" — the rollback, offered right here.
test("a computer that will never come back offers Start over — not another install command", async () => {
  const startOver = mock.fn();
  renderStep({
    connected: true,
    status: "offline",
    hasConnectedComputer: true,
    runtimeStatus: "unknown",
    canReset: true,
    onStartOver: startOver,
  });
  assert.equal(screen.queryByText("curl install && raft-computer setup /launch"), null, "no install command for a machine that already has the binary");

  await act(async () => {
    fireEvent.click(screen.getByTestId("onboarding-recovery-start-over"));
  });
  assert.equal(startOver.mock.callCount(), 1);
});


// Existing Windows daemon rows still have no Computer binary until the user migrates them.
// Machine Detail keys this off `isComputer`; so do we. Handing a legacy row
// `raft-computer start` would still be an action guaranteed to do nothing.
test("a legacy daemon machine (Windows) gets its daemon command back, not raft-computer start", () => {
  renderStep({
    connected: true,
    status: "offline",
    hasConnectedComputer: true,
    isComputer: false,
    runtimeStatus: "unknown",
  });

  assert.ok(screen.getByTestId("onboarding-recovery-legacy-daemon"));
  assert.equal(screen.queryByTestId("onboarding-recovery-start-command"), null, "no raft-computer start on a machine that never had the binary");
  assert.ok(screen.getByText(/legacy daemon/i));
});

// Mirroring Machine Detail means mirroring ALL of it: the diagnostics are how a user finds
// out WHY it is offline, and leaving them out would make this a prettier dead end.
test("the recovery card carries the same diagnostics Machine Detail offers", () => {
  renderStep({ connected: true, status: "offline", hasConnectedComputer: true, runtimeStatus: "unknown" });
  assert.equal(screen.getByTestId("onboarding-recovery-status").textContent, "raft-computer status");
  assert.equal(screen.getByTestId("onboarding-recovery-doctor").textContent, "raft-computer doctor");
  assert.equal(screen.getByTestId("onboarding-recovery-restart").textContent, "raft-computer restart");
});


// stdrc: "那如果我有多台 offline 的 computer 怎么办?" — the command is IDENTICAL on every
// machine and the server needs only ONE online, so there is nothing to choose. A picker
// would turn our implementation detail into their homework. We LIST what they have (name +
// last seen) and let them decide which one they can actually reach: that judgment lives in
// their head — one is at the office, one is at home, one was sold — not in our database.
test("several offline computers: list them all by name, one command, no chooser", () => {
  renderStep({
    connected: false,
    hasConnectedComputer: true,
    runtimeStatus: "unknown",
    offlineComputers: [
      { id: "m1", name: "Wenyi's MacBook Pro", lastHeartbeat: "2026-07-13T21:00:00Z" },
      { id: "m2", name: "Wenyi's Mac Studio", lastHeartbeat: null },
      { id: "m3", name: "office-linux", lastHeartbeat: "2026-07-01T09:00:00Z" },
    ],
  });

  const list = screen.getByTestId("onboarding-offline-computer-list");
  assert.equal(list.querySelectorAll("li").length, 3, "every machine they own is named");
  assert.ok(screen.getByText("Wenyi's MacBook Pro"));
  assert.ok(screen.getByText("office-linux"));

  // ONE command, not a per-machine selector.
  assert.equal(screen.getByTestId("onboarding-recovery-start-command").textContent, "raft-computer start");
  assert.ok(screen.getByText(/Any one of these will do/i));

  // Still no install command: they have all three already.
  assert.equal(screen.queryByText(/curl install/), null);
});

// A machine with no heartbeat on record shows NO last-seen line rather than a fabricated
// one. We say what we know; the gap is left visible instead of filled in.
test("a computer we have never heard from shows no last-seen, not a made-up one", () => {
  renderStep({
    connected: false,
    hasConnectedComputer: true,
    runtimeStatus: "unknown",
    offlineComputers: [{ id: "m2", name: "Wenyi's Mac Studio", lastHeartbeat: null }],
  });
  const row = screen.getByText("Wenyi's Mac Studio").closest("li")!;
  assert.match(row.textContent ?? "", /Offline/);
  assert.doesNotMatch(row.textContent ?? "", /last seen/i);
});

// The exit. "Set up later" is a BYPASS — it walks past an unfinished server and leaves it
// half-built forever. "Start over" is a ROLLBACK — it clears the server and lets the user
// try again. New servers get the rollback only; the bypass survives just for the ~9,474
// existing servers whose owners have no other door, and would otherwise be locked out of
// their own chat overnight.
//
// Only ONE of the two is ever on screen. Offering both asks someone already stuck to first
// understand our state machine well enough to pick an escape.
test("a v2 server never shows the bypass, and keeps its footer clear", () => {
  renderStep({ connected: false, hasConnectedComputer: true, canDefer: false, canReset: true });

  // No bypass, and no rollback link down in the modal chrome either (@stdrc). On a v2 server
  // the footer carries nothing but Next: the exit belongs on the card that failed.
  assert.equal(screen.queryByText("I'll set this up myself"), null, "the bypass is gone for v2");
  assert.ok(screen.getByTestId("onboarding-recovery-start-over"), "the exit lives on the recovery card");
});

test("there is no bypass anywhere — the only way out is to finish or start over", () => {
  renderStep({ connected: false, hasConnectedComputer: true, canReset: true });

  // "Set up later" is gone from the code path entirely (@stdrc), not merely hidden behind a
  // contract version. A bypass leaves a half-built server that can never tell its owner they
  // are done; the ~9,474 rows still holding one are being cleared in the database, not by
  // keeping a second exit alive in here forever.
  assert.equal(screen.queryByText("I'll set this up myself"), null);
  assert.ok(screen.getByTestId("onboarding-recovery-start-over"), "finish, or start over");
});
