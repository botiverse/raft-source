import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Navigate } from "react-router-dom";
import { useMachineStore } from "../../store/machineStore";
import { useComputerConnectionWatch } from "../../hooks/useComputerConnectionWatch";
import Modal from "../Modal";
import ConfirmDialog from "../ConfirmDialog";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import ServerSetupComputerRuntimeStep from "./ServerSetupComputerRuntimeStep";
import type { ServerSetupComputer } from "./ServerSetupComputerRuntimeStep";
import ServerSetupHandoffStep from "./ServerSetupHandoffStep";
import ServerSetupSurveyStep from "./ServerSetupSurveyStep";
import { getComputerCommands, getDaemonConnectCommand } from "../../utils/computerSetupCommand";
import { getServerUrl } from "../../utils/server";
import { emitHostEvent, hasRaftHostEventBridge, readRaftHostOnboardingContext } from "../../embed/hostBridge";
import { NATIVE_ONBOARDING_CONTRACT_VERSION } from "../../embed/nativeOnboarding";
import {
  useOnboardingAnnouncementGateStore,
} from "../../store/onboardingAnnouncementGateStore";
import type {
  OnboardingAnnouncementGateState,
} from "../../store/onboardingAnnouncementGateStore";
import {
  getServerSetupProjection,
  projectionAfterRefreshFailure,
  transitionServerSetup,
  resetServerSetup,
  useServerSetupRevision,
} from "./serverSetupProjection";
import type {
  ServerSetupGateReason,
  ServerSetupProjection,
} from "./serverSetupProjection";

function StepContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full w-full overflow-y-auto p-4">
      <div className="m-auto flex w-full justify-center">
        {children}
      </div>
    </div>
  );
}

type ServerSetupProjectionGateProps = {
  serverId: string;
  serverSlug: string;
  completionWakeGeneration?: string | null;
  /** Standalone onboarding page: steps render as page content, not modals. */
  dedicatedSurface?: boolean;
};

function gateMessage(
  reason: ServerSetupGateReason,
  formatMessage: IntlShape["formatMessage"],
): string {
  switch (reason) {
    case "runtime_error":
      // Genuine block with a next action (rule 5): keep.
      return formatMessage({ id: "onboarding.runtimeDetectionFailed" });
    // runtime_status_unknown intentionally returns "" (no banner): post-#142 it
    // is only a benign pre-"Ready"/offline transient needing no user action, and
    // the tracker's "Wait for setup…" step + the card's "Connecting…" already
    // carry that state — a third orange banner is a rule-9a duplicate + a wrong
    // whose-turn signal (@Cat corpus gate).
    default:
      return "";
  }
}

function responseErrorMessage(
  error: unknown,
  formatMessage: IntlShape["formatMessage"],
): string {
  const responseError = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  return typeof responseError === "string"
    ? responseError
    : formatMessage({ id: "onboarding.serverSetupUpdateFailed" });
}

export default function ServerSetupProjectionGate({
  serverId,
  serverSlug,
  completionWakeGeneration = null,
  dedicatedSurface = false,
}: ServerSetupProjectionGateProps) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((state) => state.machines);
  const loadMachines = useMachineStore((state) => state.loadMachines);
  const registerMachine = useMachineStore((state) => state.registerMachine);
  // The Windows Computer path uses device authorization and must not mint a legacy
  // machine row. A raw machine/key is created only after the user explicitly asks to
  // reveal the retained Daemon / Legacy fallback.
  const [windowsApiKey, setWindowsApiKey] = useState("");
  const [windowsKeyPending, setWindowsKeyPending] = useState(false);

  const ensureWindowsApiKey = useCallback(async () => {
    if (windowsApiKey || windowsKeyPending) return;
    setWindowsKeyPending(true);
    try {
      const { apiKey } = await registerMachine("Windows computer");
      setWindowsApiKey(apiKey);
    } catch {
      setError(formatMessage({ id: "layout.onboarding.windowsCommandFailed" }));
    } finally {
      setWindowsKeyPending(false);
    }
  }, [formatMessage, registerMachine, windowsApiKey, windowsKeyPending]);
  const [projection, setProjection] = useState<ServerSetupProjection | null>(null);
  // Whether the CURRENT projection state came back from the server, as opposed
  // to closeCompletedSetup's locally-synthesized completion (which spreads the
  // previous step's stale postSetup). Only server truth may close the Native
  // WebView — an optimistic complete must never window.close() past a
  // still-owed survey/handoff (task #314 review blocker).
  const [projectionAuthoritative, setProjectionAuthoritative] = useState(false);
  const [pendingCreateAgentProjection, setPendingCreateAgentProjection] = useState<ServerSetupProjection | null>(null);
  const [projectionResolved, setProjectionResolved] = useState(false);
  const [projectionLoadFailed, setProjectionLoadFailed] = useState(false);
  const completionWakeSent = useRef(new Set<string>());
  const hostedOnboardingContext = readRaftHostOnboardingContext();
  const effectiveWakeGeneration = hostedOnboardingContext?.sourceServerId === serverId
    ? hostedOnboardingContext.generation
    : completionWakeGeneration;
  // The survey and the handoff are NOT browser state. They are owed until the server
  // says otherwise: the survey until it is answered, the handoff until Cindy has
  // actually been briefed (which the "Let's Go" click is what triggers). Closing the
  // tab on either one and coming back therefore returns you to it, rather than
  // dropping you into the app with an agent who was never briefed.
  const surveyPending = projection?.postSetup?.surveyPending ?? false;
  const handoffPending = projection?.postSetup?.handoffPending ?? false;
  const [loading, setLoading] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [error, setError] = useState("");
  // No local "I clicked it" flag any more. `handoffPending` now reads the owner's durable
  // acknowledgment (stamped by the Let's Go command itself), not whether Cindy's briefing
  // happened to be delivered — so the server can answer this question on its own, in any
  // browser. The old session-only flag was the reason reopening elsewhere forgot the click.

  const refreshProjection = useCallback(async (holdCreateAgent = false) => {
    try {
      const nextProjection = await getServerSetupProjection(serverId);
      if (holdCreateAgent && nextProjection.surface === "create_agent") {
        setPendingCreateAgentProjection(nextProjection);
      } else {
        setProjection(nextProjection);
        setPendingCreateAgentProjection(null);
      }
      setProjectionAuthoritative(true);
      setProjectionLoadFailed(false);
      setError("");
    } catch {
      // Keep the last-good projection on a refetch failure. A transient error mid-setup (a
      // machine-change re-read that fails, a socket event during a redeploy, a tab waking
      // from sleep) must not wipe the projection and bounce the user out of the step they
      // are on — a failed read is the ABSENCE of a new reading, not a reading of "nothing".
      // The helper `projectionAfterRefreshFailure` is `(current) => current`; the assignment
      // stays here so the pinning test can see the behaviour in source.
      // First-load failure leaves `projection` null (it was never set), which the
      // null-projection guard below renders as nothing.
      setProjection(projectionAfterRefreshFailure);
      setProjectionLoadFailed(true);
    } finally {
      setProjectionResolved(true);
    }
  }, [serverId]);

  const retryProjection = useCallback(() => {
    setProjectionResolved(false);
    setProjectionLoadFailed(false);
    void refreshProjection();
  }, [refreshProjection]);

  const closeCompletedSetup = useCallback(() => {
    // Optimistic: hides the finished step without waiting for the round-trip.
    // NOT server truth — postSetup here is the previous step's stale copy, so
    // mark the projection non-authoritative until refreshProjection resolves.
    setProjectionAuthoritative(false);
    setProjection((current) => current
      ? { ...current, surface: "complete", phase: "complete", currentStep: null, blocksChat: false, gateReason: "setup_complete" }
      : current);
    void refreshProjection();
  }, [refreshProjection]);

  useEffect(() => {
    void Promise.all([loadMachines(), refreshProjection()]);
  }, [loadMachines, refreshProjection]);

  useEffect(() => {
    if (!effectiveWakeGeneration || !projection) return;
    // This event carries no completion authority. It merely wakes the Native host,
    // which re-reads setup-projection under its current account/server/generation
    // fence. Never emit for phase:null: absence of a Web gate is not completion.
    if (projection.phase === null || projection.blocksChat) return;
    const wakeKey = `${serverId}\0${effectiveWakeGeneration}`;
    if (completionWakeSent.current.has(wakeKey)) return;
    completionWakeSent.current.add(wakeKey);
    // emitHostEvent is a silent no-op when the host bridge is absent, so a missed
    // wake is invisible in Native logs. This breadcrumb reaches logcat via the
    // chromium console and tells the host side whether the emit had a bridge to
    // land on (2026-09-03 fresh repro: completion panel shown, zero callbacks).
    console.warn(
      `[onboarding] completion wake emit for generation ${effectiveWakeGeneration}; RaftHost bridge ${hasRaftHostEventBridge() ? "present" : "ABSENT"}`,
    );
    emitHostEvent("onboarding:completed", {
      contractVersion: NATIVE_ONBOARDING_CONTRACT_VERSION,
      serverId,
      serverSlug,
      generation: effectiveWakeGeneration,
    });
  }, [effectiveWakeGeneration, projection, serverId, serverSlug]);

  // Once setup is fully complete on the dedicated Native surface, the client owns
  // closing this page (artin, #proj-mobile d89d3318): the wake above is the
  // authoritative signal for the host, and window.close() is the Web-side assist
  // for hosts that surface a close request. Defined after the wake effect so the
  // wake is emitted first in the same commit. Whether close works depends on the
  // host (a WebView routes it to its close callback; a regular tab ignores it),
  // which is why the completion panel below stays as the non-blank state.
  const nativeCompletionParked = dedicatedSurface
    && !!effectiveWakeGeneration
    && projectionAuthoritative
    && !!projection
    && projection.phase !== null
    && projection.phase !== "deferred"
    && !projection.blocksChat
    && !surveyPending
    && !handoffPending;
  useEffect(() => {
    if (!nativeCompletionParked) return;
    try {
      window.close();
    } catch {
      // Host without close support — the wake and the panel carry the state.
    }
  }, [nativeCompletionParked]);

  const announcementGateState: OnboardingAnnouncementGateState = !projectionResolved
    ? "pending"
    : !projection
      ? "blocked"
      : projection.phase === null
      ? "ready"
      : projection.phase !== "complete" || surveyPending || handoffPending
        ? "blocked"
        : "ready";
  useEffect(() => {
    useOnboardingAnnouncementGateStore.getState().setForServer(serverId, announcementGateState);
    return () => {
      useOnboardingAnnouncementGateStore.getState().clearForServer(serverId);
    };
  }, [announcementGateState, serverId]);

  // Someone else changed setup state (Settings → "Finish setup"). Re-read it.
  const setupRevision = useServerSetupRevision((state) => state.revision);
  useEffect(() => {
    if (setupRevision === 0) return;
    void refreshProjection();
  }, [setupRevision, refreshProjection]);

  const machineSignature = machines
    .map((machine) => `${machine.id}:${machine.status}:${machine.runtimes.join(",")}`)
    .sort()
    .join("|");

  // Re-read the projection whenever the machines change OR the step we are standing on
  // changes. Watching the machines alone had a hole: the effect also runs on mount, when
  // the projection has not arrived yet, and its guard made it return without doing
  // anything. If the computer was already online by then, the signature never changed
  // again — so nothing ever re-fetched, and Next stayed dead while the log cheerfully
  // ticked "connected / runtimes detected" (which reads the machine list, not the
  // projection). Resuming a deferred setup lands in exactly that shape.
  const gateStep = projection?.surface ?? null;
  useEffect(() => {
    if (gateStep !== "computer_runtime") return;
    void refreshProjection(true);
  }, [machineSignature, gateStep]); // oxlint-disable-line react-hooks/exhaustive-deps -- refreshProjection is stable per serverId; adding it would re-fire on every render.

  // The computer this setup attempt is bringing online, resolved by the same
  // state machine the Add Computer dialog uses. The old code here just grabbed
  // `machines.find(isComputer) ?? machines[0]`, which ignores ownership and any
  // notion of "new since we showed the command" — on a server that already had
  // a stale offline row it would latch onto that row and report it as the one
  // being connected. The shared watch also polls as a fallback, so a dropped
  // socket event no longer strands this screen on "waiting" forever.
  const connectionProgress = useComputerConnectionWatch({
    active: projection?.surface === "computer_runtime",
  });

  const computer = useMemo<ServerSetupComputer | null>(() => {
    const machine = connectionProgress.machine;
    return machine
      ? { id: machine.id, name: machine.name, status: machine.status, runtimeIds: machine.runtimes, isComputer: machine.isComputer }
      : null;
  }, [connectionProgress.machine]);

  if (!projectionResolved) {
    if (!dedicatedSurface) return null;
    return (
      <div className="flex min-h-full w-full items-center justify-center p-6" data-testid="native-onboarding-loading">
        <p className="text-sm font-bold text-black/60">{formatMessage({ id: "onboarding.native.loading" })}</p>
      </div>
    );
  }
  // No projection, or a server-declared null phase (e.g. non-owner
  // insufficient_permission, or a first-load fetch failure) → render NOTHING.
  // This used to fall back to the legacy onboarding wizard, whose
  // still-live "enable-notifications" step was how a "Turn on notifications"
  // modal could pop up on any gate-mounting page. The wizard is gone; the
  // honest state when we don't know is to show nothing (task #164).
  if (!projection || projection.phase === null) {
    if (!dedicatedSurface) return null;
    const messageId = projectionLoadFailed
      ? "onboarding.native.loadFailed"
      : "onboarding.native.unavailable";
    return (
      <div className="flex min-h-full w-full items-center justify-center p-6" data-testid="native-onboarding-unavailable">
        <div className="w-full max-w-md border-2 border-black bg-white p-5 text-center shadow-brutal">
          <p className="text-sm font-bold text-black">{formatMessage({ id: messageId })}</p>
          <button
            type="button"
            className="mt-4 border-2 border-black bg-soft-signal px-4 py-2 text-sm font-bold shadow-brutal-sm active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
            onClick={retryProjection}
          >
            {formatMessage({ id: "onboarding.native.retry" })}
          </button>
        </div>
      </div>
    );
  }
  // Both are checked ahead of the blocksChat guard on purpose: completing setup flips
  // blocksChat to false, so neither would get a chance to render otherwise. They only
  // apply once setup itself is done.
  const setupComplete = projection.surface === "complete";
  if (setupComplete && surveyPending) {
    const step = <ServerSetupSurveyStep onDone={() => void refreshProjection()} />;
    if (!dedicatedSurface) {
      return <Modal onClose={() => undefined} layer={1} closeOnEscape={false}>{step}</Modal>;
    }
    return <StepContainer>{step}</StepContainer>;
  }
  if (setupComplete && handoffPending) {
    const step = (
      <ServerSetupHandoffStep
        serverId={serverId}
        onDone={() => void refreshProjection()}
      />
    );
    if (!dedicatedSurface) {
      return <Modal onClose={() => undefined} layer={1} closeOnEscape={false}>{step}</Modal>;
    }
    return <StepContainer>{step}</StepContainer>;
  }
  // Declared before the deferred branch below uses it: the early return means the later
  // handler declarations never execute on that path.
  const handleResume = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setProjection(await transitionServerSetup(serverId, "start"));
    } catch (nextError) {
      setError(responseErrorMessage(nextError, formatMessage));
    } finally {
      setLoading(false);
    }
  };

  if (!projection.blocksChat) {
    if (dedicatedSurface && !effectiveWakeGeneration) {
      return <Navigate to={`/s/${serverSlug}`} replace />;
    }
    if (projection.phase !== "deferred") {
      if (dedicatedSurface) {
        // Native completion (wake generation present): the client closes this page
        // (artin, #proj-mobile d89d3318) — the wake effect emitted the
        // onboarding:completed signal and the close effect asked the host to close
        // us. Never park on null: returning null here stranded users on a blank
        // WebView whenever the host missed the wake (task #311). Deliberately NOT
        // a <Navigate> into the app — the WebView must not end up hosting the full
        // app shell inside the onboarding page.
        return (
          <div className="flex min-h-full w-full items-center justify-center p-6" data-testid="native-onboarding-complete">
            <p className="text-sm font-bold text-black/60">{formatMessage({ id: "onboarding.native.complete" })}</p>
          </div>
        );
      }
      return null;
    }
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4"
        data-testid="server-setup-resume-bar"
      >
        <div className="pointer-events-auto flex w-full max-w-[560px] flex-wrap items-center justify-between gap-3 border-2 border-black bg-soft-signal px-4 py-3 shadow-brutal">
          <p className="min-w-0 text-sm font-bold">
            {formatMessage({ id: "layout.onboarding.notSetUpYet" })}
          </p>
          <button
            type="button"
            onClick={() => void handleResume()}
            disabled={loading}
            className="btn-brutal shrink-0 bg-white px-4 py-2 text-sm disabled:opacity-50"
            data-testid="server-setup-resume"
          >
            {loading
              ? formatMessage({ id: "layout.onboarding.opening" })
              : formatMessage({ id: "layout.onboarding.resumeSetup" })}
          </button>
        </div>
      </div>
    );
  }

  // Start over: the exit for a setup that cannot be finished.
  //
  // Confirmed through the app's own ConfirmDialog, not `window.confirm`. A browser confirm is
  // a hand-rolled dialog wearing the OS's clothes — it cannot be styled, cannot be tested, and
  // the repo pins raw Modal usage precisely so these do not creep in. (The pin caught me.)
  //
  // The copy says the part the user cannot see: revoking a computer does not uninstall it. The
  // daemon stays on their laptop holding a key the server will reject forever, so a rollback
  // nobody told them about is indistinguishable from a machine that mysteriously stopped
  // working.
  //
  // Every computer on this server is revoked, not just the offline ones — so it counts them
  // all. Promising to disconnect "your 2 offline machines" and then also cutting loose the
  // third one that happens to be awake would be a lie told by an off-by-one.
  // S1 already has the server-authoritative offline Computer list. The socket-fed browser
  // store may still be empty on first render; counting only that store made the confirmation
  // omit the Computer credential revocation it is about to perform. Keep the larger known
  // count so a stale local projection cannot weaken the destructive-action warning.
  const startOverMachineCount = Math.max(machines.length, projection.offlineComputers?.length ?? 0);
  const handleStartOver = async () => {
    if (!projection.allowedExits.includes("reset") || loading) return;
    setLoading(true);
    setError("");
    try {
      setProjection(await resetServerSetup(serverId));
      setConfirmStartOver(false);
    } catch (nextError) {
      setError(responseErrorMessage(nextError, formatMessage));
    } finally {
      setLoading(false);
    }
  };

  // Copying says so where the click happened: the button turns into a tick.
  const handleCopyInstallCommand = async (_runtimeId: string, command: string) => {
    await navigator.clipboard.writeText(command).catch(() => undefined);
  };

  const serverUrl = getServerUrl();
  const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl);
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    platform: "windows",
  });
  const daemonDistTag = deploymentEnv === "staging" ? "staging" : "latest";
  const daemonCommandFor = (platform: "mac-linux" | "windows") => getDaemonConnectCommand({
    apiKey: windowsApiKey,
    distTag: daemonDistTag,
    platform,
    serverUrl,
  });

  // The confirm dialog. Rendered ALONGSIDE whichever surface is up (Meet Cindy or Screen B),
  // never nested inside its Modal — a confirm nested in an onboarding Modal never mounted at
  // all on the Meet Cindy path in the first version, so clicking "Start over" from that
  // screen was silent (@cindyz caught it on staging). It sits at the top level so wherever
  // the trigger lives, this dialog lands.
  const startOverConfirm = confirmStartOver ? (
    <ConfirmDialog
      title={formatMessage({ id: "layout.onboarding.startOverTitle" })}
      layer={2}
      confirmLabel={formatMessage({ id: "layout.onboarding.startOverConfirm" })}
      confirmTestId="server-setup-confirm-start-over"
      message={startOverMachineCount > 0
        ? formatMessage(
            { id: "layout.onboarding.startOverMessageWithComputers" },
            { count: startOverMachineCount },
          )
        : formatMessage({ id: "layout.onboarding.startOverMessageEmpty" })}
      onConfirm={handleStartOver}
      onClose={() => setConfirmStartOver(false)}
    />
  ) : null;

  if (projection.surface === "create_agent") {
    // "step" (browser Modal) keeps the pre-standalone first-agent navigation to
    // the onboarding-owner channel behind the modal; "page" (client standalone
    // page) must stay put for the survey/handoff steps.
    const createAgentStep = (
      <CreateAgentDialog
        onboarding
        onboardingShell={dedicatedSurface ? "page" : "step"}
        onClose={() => void refreshProjection()}
        onOnboardingComplete={closeCompletedSetup}
        onOnboardingStartOver={projection.allowedExits.includes("reset") ? () => setConfirmStartOver(true) : undefined}
      />
    );
    return (
      <>
      {startOverConfirm}
      {dedicatedSurface
        ? <StepContainer>{createAgentStep}</StepContainer>
        : <Modal onClose={() => undefined} layer={1} closeOnEscape={false}>{createAgentStep}</Modal>}
      </>
    );
  }

  // Read the server's VERDICT, never infer it from the shape of the response.
  //
  // The first pass treated `pendingCreateAgentProjection !== null` as "ready", which is
  // inferring a verdict from a surface — the same disease one layer up (@Dozy). A
  // prefetched projection is still the server speaking, so we read ITS `runtimeStatus`;
  // we do not conclude "ready" merely because a next-step projection exists.
  const authoritative = pendingCreateAgentProjection ?? projection;
  const runtimeStatusFromProjection = authoritative.runtimeStatus ?? "unknown";

  if (projection.surface !== "computer_runtime") return null;

  const computerRuntimeStep = (
      <ServerSetupComputerRuntimeStep
        computer={computer}
        runtimeStatus={runtimeStatusFromProjection}
        runtimeOptions={authoritative.runtimeOptions ?? []}
        hasConnectedComputer={authoritative.hasConnectedComputer ?? false}
        offlineComputers={authoritative.offlineComputers ?? []}
        serverSlug={serverSlug}
        showOwnApiKey={false}
        loading={loading}
        error={error || gateMessage(projection.gateReason, formatMessage)}
        setupCommand={computerCommands?.setup ?? null}
        computerInstallCommand={computerCommands?.install}
        windowsComputerSetupCommand={windowsComputerCommands?.setup ?? null}
        windowsComputerInstallCommand={windowsComputerCommands?.install}
        macLinuxDaemonCommand={daemonCommandFor("mac-linux")}
        windowsDaemonCommand={windowsApiKey ? daemonCommandFor("windows") : ""}
        onRequestWindowsDaemonCommand={() => void ensureWindowsApiKey()}
        windowsDaemonCommandPending={windowsKeyPending}
        onCopyInstallCommand={(runtimeId, command) => void handleCopyInstallCommand(runtimeId, command)}
        canReset={projection.allowedExits.includes("reset")}
        onStartOver={() => setConfirmStartOver(true)}
        onNext={() => {
          if (pendingCreateAgentProjection) {
            setProjection(pendingCreateAgentProjection);
            setPendingCreateAgentProjection(null);
            return;
          }
          void refreshProjection();
        }}
      />
  );

  return (
    <>
    {startOverConfirm}
    {dedicatedSurface
      ? <StepContainer>{computerRuntimeStep}</StepContainer>
      : <Modal onClose={() => undefined} layer={1} closeOnEscape={false}>{computerRuntimeStep}</Modal>}
    </>
  );
}
