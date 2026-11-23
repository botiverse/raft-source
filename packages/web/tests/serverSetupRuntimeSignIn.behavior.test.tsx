// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// Screen B and a runtime's sign-in (mail #214). A bundled runtime (Kimi Code) is
// always "available", signed in or not: a Windows Computer with Claude Code not
// selectable sent the person on with Kimi Code signed out, and Cindy exited a
// second after every start. Screen B now reads the Computer's sign-in state:
// a signed-out runtime says so on its row, and with every usable runtime signed
// out the step leads with Sign In for the recommended one. And a Computer that
// is online but never lists its runtimes gets a hint and a way on.
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { getSetupRuntimeOptions } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import ServerSetupComputerRuntimeStep from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import type { ServerSetupRuntimeStatus } from "../src/components/onboarding/serverSetupProjection";
import { RuntimeAuthClient } from "../src/utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => undefined;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TestIntlProvider });

function setupRuntimeOptions(runtimeIds: readonly string[]): RuntimeSelectionOption[] {
  const installed = new Set(runtimeIds);
  return getSetupRuntimeOptions().map((runtime) => {
    const capabilityStatus = installed.has(runtime.id)
      ? "available" as const
      : runtime.binary === "" ? "update_required" as const : "not_installed" as const;
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

function view(runtimes: NonNullable<RuntimeAuthView["status"]>["runtimes"]): RuntimeAuthView {
  return {
    status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes },
    availability: "ok",
    runtimes: ["claude", "codex", "kimi"],
    canAct: true,
  };
}

function fakeClient(authView: RuntimeAuthView) {
  const http = { get: async <T,>() => authView as T, post: async <T,>() => ({}) as T };
  return new RuntimeAuthClient(http, { current: () => null, onReplaced: () => () => {} });
}

function renderStep({
  runtimeIds,
  runtimeStatus,
  authView,
  canReset = false,
  onStartOver,
  onRetryRuntimes,
}: {
  runtimeIds: string[];
  runtimeStatus: ServerSetupRuntimeStatus;
  authView?: RuntimeAuthView;
  canReset?: boolean;
  onStartOver?: () => void;
  onRetryRuntimes?: () => void;
}) {
  return render(
    <ServerSetupComputerRuntimeStep
      computer={{ id: "computer-1", name: "Mei's PC", status: "online", runtimeIds, isComputer: true }}
      runtimeStatus={runtimeStatus}
      runtimeOptions={setupRuntimeOptions(runtimeIds)}
      serverId="server-1"
      runtimeAuthClient={authView ? fakeClient(authView) : undefined}
      serverSlug="launch"
      setupCommand="raft-computer setup /launch"
      canReset={canReset}
      onStartOver={onStartOver}
      onRetryRuntimes={onRetryRuntimes}
      onNext={noop}
    />,
  );
}

test("every usable runtime signed out: the step leads with Sign In for it, and nothing says it is ready to use", async () => {
  renderStep({ runtimeIds: ["kimi-sdk"], runtimeStatus: "ready_other", authView: view({ kimi: { kind: "logged_out" } }) });
  await act(async () => {});

  assert.ok(screen.getByText("Sign in to a runtime"));
  assert.ok(screen.getByText("The runtimes on Mei's PC aren't signed in yet. Sign in to one so Cindy can start."));
  // The recommended (first usable) runtime is open on its notice and Sign In, the runtime picker's own.
  const notice = screen.getByTestId("runtime-picker-not-signed-in");
  assert.equal(notice.textContent?.includes("Kimi Code isn't signed in on Mei's PC."), true);
  assert.ok(screen.getByRole("button", { name: "Sign in" }));
  assert.ok(screen.queryByText(/It is ready to use|nothing to configure/) === null);
  // The log names it signed out, with the rows' warning mark instead of the green check.
  const runtimeLine = screen.getByTestId("onboarding-connect-log").querySelector("[data-line='runtime']");
  assert.equal(runtimeLine?.textContent, "Runtime detected: Kimi Code (not signed in).");
  assert.equal(runtimeLine?.getAttribute("data-state"), "attention");
});

test("row labels: a detected runtime that is signed out reads \"Detected · not signed in\"", async () => {
  renderStep({
    runtimeIds: ["claude", "kimi-sdk"],
    runtimeStatus: "ready_recommended",
    authView: view({ claude: { kind: "logged_out" }, kimi: { kind: "logged_out" } }),
  });
  await act(async () => {});

  assert.equal(screen.getByTestId("onboarding-runtime-row-claude").textContent?.includes("Detected · not signed in"), true);
  assert.equal(screen.getByTestId("onboarding-runtime-row-kimi-sdk").textContent?.includes("Detected · not signed in"), true);
  assert.equal(screen.getByTestId("onboarding-runtime-row-codex").textContent?.includes("Not detected"), true);
  // Claude Code leads (recommended) and is open on its Sign In, not on "best-tested - nothing to configure".
  assert.equal(screen.getByTestId("runtime-picker-not-signed-in").textContent?.includes("Claude Code isn't signed in on Mei's PC."), true);
  assert.ok(screen.queryByText(/nothing to configure/) === null);
});

test("a runtime with no single sign-in (OpenCode) counts as usable: no Sign In step", async () => {
  renderStep({ runtimeIds: ["kimi-sdk", "opencode"], runtimeStatus: "ready_other", authView: view({ kimi: { kind: "logged_out" } }) });
  await act(async () => {});
  assert.ok(screen.queryByText("Sign in to a runtime") === null);
});

test("a signed-in runtime is the one the step leads with: no Sign In step while one is signed in", async () => {
  renderStep({
    runtimeIds: ["claude", "kimi-sdk"],
    runtimeStatus: "ready_recommended",
    authView: view({ claude: { kind: "logged_out" }, kimi: { kind: "logged_in" } }),
  });
  await act(async () => {});
  assert.ok(screen.queryByText("Sign in to a runtime") === null);
  assert.ok(screen.queryByTestId("runtime-picker-not-signed-in") === null);
  assert.equal(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled"), false);
});

test("a Computer that cannot report sign-in (unknown) keeps the step as it was", async () => {
  renderStep({ runtimeIds: ["kimi-sdk"], runtimeStatus: "ready_other", authView: view({}) });
  await act(async () => {});
  assert.ok(screen.queryByText("Sign in to a runtime") === null);
});

test("online but the runtimes never arrive: after a while a hint, Check Again, and Start Over while online", async () => {
  vi.useFakeTimers();
  let checks = 0;
  let startOvers = 0;
  renderStep({
    runtimeIds: [],
    runtimeStatus: "checking",
    canReset: true,
    onStartOver: () => { startOvers += 1; },
    onRetryRuntimes: () => { checks += 1; },
  });
  await act(async () => { vi.advanceTimersByTime(14_000); });
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") === null, "the normal gap says nothing");

  await act(async () => { vi.advanceTimersByTime(1_000); });
  const hint = screen.getByTestId("onboarding-runtimes-not-reported");
  assert.equal(hint.textContent?.includes("Mei's PC is online but hasn't listed its runtimes yet."), true);

  fireEvent.click(screen.getByTestId("onboarding-runtimes-start-over"));
  assert.equal(startOvers, 1);
  fireEvent.click(screen.getByTestId("onboarding-runtimes-check-again"));
  assert.equal(checks, 1);
  // Check Again starts a fresh wait: the hint goes until that one runs out too.
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") === null);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  assert.ok(screen.getByTestId("onboarding-runtimes-not-reported"));
});

test("no hint once the server has an answer", async () => {
  vi.useFakeTimers();
  renderStep({ runtimeIds: ["claude"], runtimeStatus: "ready_recommended" });
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") === null);
});

test("a new wait starts its own 15 s: offline, then online again, shows no hint at once", async () => {
  vi.useFakeTimers();
  const step = (status: "online" | "offline") => (
    <ServerSetupComputerRuntimeStep
      computer={{ id: "computer-1", name: "Mei's PC", status, runtimeIds: [], isComputer: true }}
      runtimeStatus="checking"
      runtimeOptions={setupRuntimeOptions([])}
      serverSlug="launch"
      setupCommand="raft-computer setup /launch"
      onRetryRuntimes={noop}
      onNext={noop}
    />
  );
  const { rerender } = render(step("online"));
  await act(async () => { vi.advanceTimersByTime(15_000); });
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") !== null);

  rerender(step("offline"));
  await act(async () => {});
  rerender(step("online"));
  await act(async () => {});
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") === null, "the earlier timeout does not carry over");
  await act(async () => { vi.advanceTimersByTime(15_000); });
  assert.ok(screen.queryByTestId("onboarding-runtimes-not-reported") !== null);
});
