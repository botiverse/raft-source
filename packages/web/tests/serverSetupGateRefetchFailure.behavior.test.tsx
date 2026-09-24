import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import ServerSetupProjectionGate from "../src/components/onboarding/ServerSetupProjectionGate";
import { useServerSetupRevision } from "../src/components/onboarding/serverSetupProjection";
import { useMachineStore } from "../src/store/machineStore";
import { useOnboardingAnnouncementGateStore } from "../src/store/onboardingAnnouncementGateStore";
// The gate's "Start over?" flow mounts the react-intl-migrated ConfirmDialog,
// which needs an <IntlProvider> ancestor.
import { TestIntlProvider } from "./helpers/intl";

/**
 * Task #164 — the two teeth that keep the deleted legacy wizard from resurfacing.
 *
 * The gate used to `setProjection(null)` on ANY refetch error and then fall back to the
 * legacy OwnerOnboardingModal. That is how one flaky request — a socket event during a
 * redeploy, a tab waking from sleep, a second tab bumping the revision — could yank
 * someone out of setup and into the legacy "Turn on notifications" modal mid-flow.
 *
 * The wizard is gone. A failed read is the ABSENCE of a new reading, not a reading of
 * "nothing": a subsequent failure must keep what the server already told us, and a
 * first-load failure (no truth at all) must render NOTHING — never a modal.
 *
 * (Harness credit: @Jiayuan's api.get seam — non-projection requests return empty so the
 * socket/interval connection hooks stay quiet while the real gate is mounted.)
 */

const KNOWN_PROJECTION = {
  surface: "computer_runtime",
  phase: "in_progress",
  currentStep: "computer_runtime",
  blocksChat: true,
  allowedExits: ["defer", "return_to_server"],
  sideEffectState: { transitions: "enabled", completion: "disabled" },
  gateReason: "runtime_checking",
  computerStatus: "online",
  runtimeStatus: "checking",
  postSetup: { surveyPending: false, handoffPending: false },
};

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

beforeEach(() => {
  useServerSetupRevision.setState({ revision: 0 });
  useOnboardingAnnouncementGateStore.setState({ byServerId: {} });
});

afterEach(() => {
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  cleanup();
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useOnboardingAnnouncementGateStore.setState({ byServerId: {} });
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

function renderGate(completionWakeGeneration: string | null = null, dedicatedSurface = false) {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <ServerSetupProjectionGate
          serverId="server-1"
          serverSlug="server-1"
          completionWakeGeneration={completionWakeGeneration}
          dedicatedSurface={dedicatedSurface}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function installHostEventCapture(onboarding?: unknown) {
  const calls: Array<{ kind: string; payload: object }> = [];
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: Object.freeze({
      version: "raft-host-v1",
      onboarding,
      emit(kind: string, payload: object) {
        calls.push({ kind, payload });
      },
    }),
  });
  return calls;
}

test("a revision bump whose refetch FAILS does not erase the server's truth", async () => {
  // Let every pre-bump refetch succeed, record the count, then fail only the one the bump
  // triggers — otherwise the mount's own refetch could satisfy the assertion before the
  // revision path is ever exercised (@Dozy's catch on the original of this tooth).
  let calls = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    calls += 1;
    if (calls >= failFrom) throw new Error("network blip");
    return { data: KNOWN_PROJECTION };
  }) as typeof api.get;

  renderGate(null, true);
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  await waitFor(() => assert.ok(calls >= 1));
  const callsBeforeBump = calls;
  failFrom = callsBeforeBump + 1;

  // Another tab finishes setup and bumps the revision → this gate refetches → it fails.
  await act(async () => {
    useServerSetupRevision.getState().bump();
  });
  await waitFor(() => assert.ok(calls > callsBeforeBump, "the revision bump actually triggered a refetch"));

  // The user stays exactly where the server put them — the failed read did not clear it.
  assert.ok(screen.getByRole("heading", { name: "Connect a computer" }));
});

test("a FIRST read that fails renders nothing — no legacy modal, no fabricated screen", async () => {
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    throw new Error("network blip");
  }) as typeof api.get;

  const { container } = renderGate();

  // Nothing was ever known. The wizard fallback is gone, so the honest state is to render
  // nothing at all (the projection stays null → the gate returns null) — not a modal.
  await waitFor(() => assert.equal(container.textContent, ""));
  assert.equal(screen.queryByRole("heading", { name: "Connect a computer" }), null);
  await waitFor(() => assert.equal(
    useOnboardingAnnouncementGateStore.getState().byServerId["server-1"],
    "blocked",
    "unknown onboarding state fails closed so an announcement cannot overlap setup",
  ));
});

test("dedicated Native surface shows loading, then a retryable error, and recovers", async () => {
  let shouldFail = true;
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    if (shouldFail) throw new Error("network blip");
    return { data: KNOWN_PROJECTION };
  }) as typeof api.get;

  renderGate("webview:1", true);
  assert.ok(screen.getByTestId("native-onboarding-loading"));
  await waitFor(() => assert.ok(screen.getByText("We couldn't load onboarding for this server.")));

  shouldFail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.ok(screen.getByTestId("native-onboarding-loading"));
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  assert.equal(screen.queryByTestId("native-onboarding-unavailable"), null);
});

test("dedicated Native surface renders a non-empty phase:null state without waking the host", async () => {
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return {
      data: {
        ...KNOWN_PROJECTION,
        surface: "none",
        phase: null,
        currentStep: null,
        blocksChat: false,
        gateReason: "insufficient_permission",
      },
    };
  }) as typeof api.get;
  const calls = installHostEventCapture();

  renderGate("webview:1", true);
  await waitFor(() => assert.ok(screen.getByText("Onboarding isn't available for this account yet.")));
  assert.ok(screen.getByRole("button", { name: "Try again" }));
  assert.deepEqual(calls, []);
});

test("announcement takeover stays blocked through setup and becomes ready only after post-setup gates clear", async () => {
  let nextProjection: Record<string, unknown> = KNOWN_PROJECTION;
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: nextProjection };
  }) as typeof api.get;

  renderGate();
  await waitFor(() => assert.equal(
    useOnboardingAnnouncementGateStore.getState().byServerId["server-1"],
    "blocked",
  ));

  nextProjection = {
    ...KNOWN_PROJECTION,
    surface: "complete",
    phase: "complete",
    currentStep: null,
    blocksChat: false,
    gateReason: "setup_complete",
    postSetup: { surveyPending: false, handoffPending: false },
  };
  await act(async () => {
    useServerSetupRevision.getState().bump();
  });

  await waitFor(() => assert.equal(
    useOnboardingAnnouncementGateStore.getState().byServerId["server-1"],
    "ready",
  ));
});

test("dedicated Native surface emits one completion wake only after authoritative blocksChat=false", async () => {
  let nextProjection: Record<string, unknown> = KNOWN_PROJECTION;
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: nextProjection };
  }) as typeof api.get;
  const calls = installHostEventCapture();

  renderGate("webview:1", true);
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  assert.deepEqual(calls, [], "a blocking projection must not wake the host");

  nextProjection = {
    ...KNOWN_PROJECTION,
    surface: "complete",
    phase: "complete",
    currentStep: null,
    blocksChat: false,
    gateReason: "setup_complete",
    postSetup: { surveyPending: false, handoffPending: false },
  };
  await act(async () => {
    useServerSetupRevision.getState().bump();
  });

  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls, [{
    kind: "onboarding:completed",
    payload: {
      contractVersion: "raft-onboarding-v1",
      serverId: "server-1",
      serverSlug: "server-1",
      generation: "webview:1",
    },
  }]);

  await act(async () => {
    useServerSetupRevision.getState().bump();
  });
  await waitFor(() => assert.equal(calls.length, 1, "later refetches must not duplicate the wake"));
});

test("phase:null and ordinary Web gate mounts never emit Native completion", async () => {
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return {
      data: {
        ...KNOWN_PROJECTION,
        surface: "none",
        phase: null,
        currentStep: null,
        blocksChat: false,
        gateReason: "insufficient_permission",
      },
    };
  }) as typeof api.get;
  const calls = installHostEventCapture();

  const nativeGate = renderGate("webview:1");
  await waitFor(() => assert.equal(nativeGate.container.textContent, ""));
  assert.deepEqual(calls, [], "no rendered gate is not proof of completion");
  nativeGate.unmount();

  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return {
      data: {
        ...KNOWN_PROJECTION,
        surface: "complete",
        phase: "complete",
        currentStep: null,
        blocksChat: false,
        gateReason: "setup_complete",
      },
    };
  }) as typeof api.get;
  renderGate(null);
  await waitFor(() => assert.equal(
    useOnboardingAnnouncementGateStore.getState().byServerId["server-1"],
    "ready",
  ));
  assert.deepEqual(calls, [], "the normal Web shell must not emit Native-only wakes");
});

test("ordinary Web gate uses strict hosted onboarding context to wake on any route", async () => {
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return {
      data: {
        ...KNOWN_PROJECTION,
        surface: "complete",
        phase: "complete",
        currentStep: null,
        blocksChat: false,
        gateReason: "setup_complete",
      },
    };
  }) as typeof api.get;
  const calls = installHostEventCapture({
    contractVersion: "raft-onboarding-v1",
    generation: "webview:2",
    sourceServerId: "server-1",
  });

  renderGate(null);
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], {
    kind: "onboarding:completed",
    payload: {
      contractVersion: "raft-onboarding-v1",
      serverId: "server-1",
      serverSlug: "server-1",
      generation: "webview:2",
    },
  });
});

test("post-setup keeps the referral survey but never resurrects Join Community as a first-run gate", async () => {
  let nextProjection: Record<string, unknown> = KNOWN_PROJECTION;
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: nextProjection };
  }) as typeof api.get;

  renderGate(null, true);
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  assert.equal(screen.queryByText(/Join (the )?community/i), null, "the blocking setup window has no community gate");

  nextProjection = {
    ...KNOWN_PROJECTION,
    surface: "complete",
    phase: "complete",
    currentStep: null,
    blocksChat: false,
    gateReason: "setup_complete",
    postSetup: { surveyPending: true, handoffPending: false },
  };
  await act(async () => {
    useServerSetupRevision.getState().bump();
  });

  await waitFor(() => assert.ok(screen.getByTestId("server-setup-survey")));
  assert.ok(screen.getByText("How did you hear about Raft?"));
  assert.equal(screen.queryByText(/Join (the )?community/i), null);

  nextProjection = {
    ...nextProjection,
    postSetup: { surveyPending: false, handoffPending: false },
  };
  await act(async () => {
    useServerSetupRevision.getState().bump();
  });

  await waitFor(() => assert.equal(screen.queryByTestId("server-setup-survey"), null));
  assert.equal(screen.queryByText(/Join (the )?community/i), null);
});

/**
 * #5254 / task #197 — first connect cannot mint a legacy daemon credential AT ALL.
 *
 * This test used to end with "revealing the retained fallback mints exactly one legacy
 * credential", which was the correct contract while the Legacy path was a real fallback. It is
 * not one from inside onboarding: the setup gate only recognises a managed `computers` row, and
 * a legacy daemon produces a `machines` row, so that credential could never finish setup.
 *
 * The half worth keeping is the half that got stronger. `registerCalls` counts real calls into
 * `registerMachine` through the actual gate wiring (`ServerSetupProjectionGate` →
 * `ensureWindowsApiKey`), so this pins the credential boundary on the PRODUCT path, not just on
 * the component in isolation — the reveal is gone, and with it every route to minting one.
 */
test("Windows selection stays on Computer and first connect cannot mint a legacy daemon credential", async () => {
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: KNOWN_PROJECTION };
  }) as typeof api.get;
  let registerCalls = 0;
  useMachineStore.setState({
    machines: [],
    loadMachines: async () => {},
    registerMachine: async (name: string) => {
      registerCalls += 1;
      assert.equal(name, "Windows computer");
      return { machine: {} as never, apiKey: "sk_machine_windows_real_secret" };
    },
  } as never);

  renderGate(null, true);
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));
  await waitFor(() => assert.ok(screen.getByText("Experimental")));

  assert.equal(registerCalls, 0, "choosing the Windows Computer tab must not create a legacy row/key");
  assert.equal(screen.queryByRole("button", { name: "Copy Windows daemon command" }), null);

  // There is no longer anything to click: the reveal, the block it revealed, and the command it
  // would have produced are all gone from first connect.
  assert.equal(
    screen.queryByTestId("computer-windows-daemon-request"),
    null,
    "first connect offers no way to reveal the Legacy path",
  );
  assert.equal(screen.queryByTestId("windows-daemon-command-block"), null);
  assert.equal(screen.queryByText("Daemon / Legacy"), null);

  // The Computer path is untouched — this is a removal, not a broken screen.
  assert.ok(screen.getByText("Experimental"));

  assert.equal(registerCalls, 0, "first connect never mints a legacy credential, with or without a click");
});

test("Start over on Meet Cindy is the only clickable copy and opens the confirm dialog", async () => {
  // @cindyz caught this live on staging: clicking Start over from the Meet
  // Cindy dialog did nothing. The button set state; nothing rendered a dialog. Reason: the
  // ConfirmDialog lived inside the `computer_runtime` return branch only, so on the
  // `create_agent` branch it never mounted. Fixed by hoisting the dialog above both branches;
  // this tooth pins that the click actually produces a visible confirm on Meet Cindy.
  const CREATE_AGENT_PROJECTION = {
    surface: "create_agent",
    phase: "in_progress",
    currentStep: "create_agent",
    blocksChat: true,
    allowedExits: ["reset", "return_to_server"],
    sideEffectState: { transitions: "enabled", completion: "enabled" },
    gateReason: "completion_pending",
    computerStatus: "online",
    runtimeStatus: "ready_recommended",
    hasConnectedComputer: true,
    offlineComputers: [],
    postSetup: { surveyPending: false, handoffPending: false },
  };
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: CREATE_AGENT_PROJECTION };
  }) as typeof api.get;

  renderGate(null, true);
  await waitFor(() => assert.ok(screen.getByText("Meet Cindy")));
  // A description says WHEN Start over is for (someone who connected a computer they won't run
  // agents on), so it is not a bare, unexplained link. But only "Start over" is clickable — the
  // guidance around it is plain text, not part of the control.
  const description = screen.getByTestId("create-agent-start-over-description");
  assert.match(description.textContent ?? "", /computer you'?ll use/i, "a description explains when to start over");
  assert.equal(description.closest("button"), null, "the description is guidance, not part of the clickable control");
  assert.equal(screen.getAllByRole("button", { name: "Start over", exact: true }).length, 1, "only 'Start over' is clickable");
  assert.equal(screen.queryByText(/Wrong computer/i), null, "the hint does not blame the computer");

  await act(async () => {
    screen.getByTestId("create-agent-start-over").click();
  });
  await waitFor(() => assert.ok(screen.getByText("Start over?"), "the confirm dialog appears"));
});

test("Start over from S1 offline recovery requires confirmation and cancel stays on S1", async () => {
  const OFFLINE_RECOVERY_PROJECTION = {
    surface: "computer_runtime",
    phase: "in_progress",
    currentStep: "computer_runtime",
    blocksChat: true,
    allowedExits: ["reset", "return_to_server"],
    sideEffectState: { transitions: "enabled", completion: "disabled" },
    gateReason: "computer_offline",
    computerStatus: "offline",
    runtimeStatus: "unknown",
    hasConnectedComputer: true,
    offlineComputers: [{
      id: "computer-1",
      name: "Cindy MacAir",
      lastHeartbeat: null,
      isComputer: true,
    }],
    postSetup: { surveyPending: false, handoffPending: false },
  };
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: OFFLINE_RECOVERY_PROJECTION };
  }) as typeof api.get;
  let resetCalls = 0;
  api.post = (async (url: string) => {
    if (!url.includes("/setup-reset")) throw new Error(`Unexpected POST ${url}`);
    resetCalls += 1;
    return { data: OFFLINE_RECOVERY_PROJECTION };
  }) as typeof api.post;

  renderGate(null, true);
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Start your computer" })));
  const startOverButton = screen.getByRole("button", { name: "Start over", exact: true });
  const startOverDescription = screen.getByTestId("onboarding-recovery-start-over-description");
  assert.equal(
    startOverButton.contains(startOverDescription),
    false,
    "the editable description must remain outside the clickable Start over control",
  );

  await act(async () => {
    startOverButton.click();
  });
  assert.equal(resetCalls, 0, "opening the confirmation must not reset setup");
  await waitFor(() => assert.ok(screen.getByText("Start over?"), "S1 opens the shared confirm dialog"));
  assert.ok(screen.getByText(/disconnects your computer/i));

  await act(async () => {
    screen.getByRole("button", { name: "Cancel" }).click();
  });
  await waitFor(() => assert.equal(screen.queryByText("Start over?"), null));
  assert.equal(resetCalls, 0, "cancel must not reset setup");
  assert.ok(screen.getByRole("heading", { name: "Start your computer" }), "cancel keeps the user on S1");

  await act(async () => {
    screen.getByRole("button", { name: "Start over", exact: true }).click();
  });
  await waitFor(() => assert.ok(screen.getByText("Start over?")));
  await act(async () => {
    screen.getByTestId("server-setup-confirm-start-over").click();
  });
  await waitFor(() => assert.equal(resetCalls, 1, "confirm resets setup exactly once"));
});
