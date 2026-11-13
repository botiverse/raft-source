import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Navigate, useLocation } from "react-router-dom";
import { Button, Card, Dialog, ScrollArea } from "@botiverse/raft-ui";
import type { DialogProps } from "@botiverse/raft-ui";
import { useMachineStore } from "../../store/machineStore";
import { useComputerConnectionWatch } from "../../hooks/useComputerConnectionWatch";
import { FramedDialogContent } from "../ui/NarrowDialog";
import type { DialogNarrow } from "../ui/NarrowDialog";
import ConfirmDialog from "../ConfirmDialog";
import { CreateAgentDialog } from "../agent/DeferredCreateAgentDialog";
import type { ServerSetupComputer } from "./ServerSetupComputerRuntimeStep";
import { lazyPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../layout/PanelLoading";
import {
  loadComputerRuntimeStep,
  loadDisplayStyleStep,
  loadHandoffStep,
  loadSurveyStep,
  loadUpgradeStep,
  preloadServerSetupSteps,
  projectionOwesSetupStep,
} from "./serverSetupStepChunks";
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { completeOnboardingDisplayStyle, useOnboardingDisplayStylePending } from "../../utils/onboardingDisplayStyle";
import { getServerUrl } from "../../utils/server";
import { emitHostEvent, hasRaftHostEventBridge, readRaftHostOnboardingContext } from "../../embed/hostBridge";
import { NATIVE_ONBOARDING_CONTRACT_VERSION } from "../../embed/nativeOnboarding";
import { serverSetupCopyAction, trackServerSetupAction, trackServerSetupBlocked, trackServerSetupStepShown } from "../../analytics/serverSetup";
import type { ServerSetupStep } from "../../analytics/serverSetup";
import type { CopyTarget } from "../machine/ComputerCommandGuide";
import {
  useOnboardingAnnouncementGateStore,
} from "../../store/onboardingAnnouncementGateStore";
import type {
  OnboardingAnnouncementGateState,
} from "../../store/onboardingAnnouncementGateStore";
import {
  createHostedCindyTestEntry,
  getServerSetupProjection,
  projectionAfterRefreshFailure,
  transitionServerSetup,
  resetServerSetup,
  useServerSetupRevision,
} from "./serverSetupProjection";
import type {
  HostedCindyTestEntryFailureCode,
  ServerSetupGateReason,
  ServerSetupProjection,
} from "./serverSetupProjection";

// The setup steps, each its own chunk (serverSetupStepChunks.ts). While a step's
// code loads, its dialog (or the dedicated page) stays up with a loading line in
// the step's place (StepLoading), so moving on never closes the dialog.
const ServerSetupComputerRuntimeStep = lazyPanel(loadComputerRuntimeStep);
const ServerSetupDisplayStyleStep = lazyPanel(loadDisplayStyleStep);
const ServerSetupHandoffStep = lazyPanel(loadHandoffStep);
const ServerSetupSurveyStep = lazyPanel(loadSurveyStep);
const ServerSetupUpgradeStep = lazyPanel(loadUpgradeStep);

type RuntimeOptions = NonNullable<ServerSetupProjection["runtimeOptions"]>;
type OfflineComputers = NonNullable<ServerSetupProjection["offlineComputers"]>;
const NO_RUNTIME_OPTIONS: RuntimeOptions = [];
const NO_OFFLINE_COMPUTERS: OfflineComputers = [];

type OpenChangeDetails = Parameters<NonNullable<DialogProps["onOpenChange"]>>[1];

/** Onboarding steps are blocking: Esc and a press outside don't close the step's dialog. It must not be possible to
 *  tap Escape and end up in an app that is not set up (stdrc, 2026-07-13). */
function keepSetupOpen(open: boolean, details: OpenChangeDetails) {
  if (!open) details.cancel();
}

/**
 * A setup step in the browser: a blocking raft-ui Dialog at layer 1, as the Modal it replaces (z-dialog-layer). Nothing
 * dismisses it: no ×, no Esc, no scrim press. Base UI owns the focus trap and the inert page, and while it is open
 * it is a modal layer of the shortcut registry, so global commands (⌘K) stop under it. Each step draws its own
 * framed card (FramedDialogContent); on a phone it is a sheet, except a `centered` step.
 * `confirm` (Start over) is rendered inside the dialog's tree, so raft-ui stacks it over the step on its own
 * lighter scrim and its Esc closes only it.
 */
function SetupStepDialog({
  label,
  narrow = "sheet",
  confirm = null,
  children,
}: {
  label: string;
  narrow?: DialogNarrow;
  confirm?: ReactNode;
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog open disablePointerDismissal onOpenChange={keepSetupOpen}>
      <FramedDialogContent
        ref={popupRef}
        narrow={narrow}
        layer={1}
        // Focus starts on the dialog itself, as the old Modal: a field that autofocused is already inside, and Base
        // UI leaves it there.
        initialFocus={popupRef}
        aria-label={label}
        // The steps keep a minimum height (520): in a short window (a phone in landscape) the step scrolls in the
        // window, as in the old Modal's backdrop, rather than spilling off an undismissable dialog.
        scrollsInWindow
        data-testid="server-setup-dialog"
      >
        <Suspense fallback={<StepLoading />}>{children}</Suspense>
        {confirm}
      </FramedDialogContent>
    </Dialog>
  );
}

// Copying says so where the click happened: the button turns into a tick.
function copyInstallCommand(_runtimeId: string, command: string) {
  void navigator.clipboard.writeText(command).catch(() => undefined);
}

function NativeOnboardingLoading() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-full w-full items-center justify-center p-6" data-testid="native-onboarding-loading">
      <p className="text-callout text-foreground-muted">{formatMessage({ id: "onboarding.native.loading" })}</p>
    </div>
  );
}

/** A step whose code is still loading, in the step dialog: the steps' minimum height, so the dialog doesn't jump. */
function StepLoading() {
  const { formatMessage } = useIntl();
  return <PanelLoading className="flex min-h-[520px] w-full" label={formatMessage({ id: "onboarding.native.loading" })} testId="server-setup-step-loading" />;
}

// The standalone onboarding page's scroller: a raft-ui ScrollArea (the
// scrollbar shows while the page is pointed at or scrolls, as on every page
// scroller), stretched to the page's height. The padding is the content's, so
// the scrollbar stays at the edge; the step centres in it (m-auto) and starts
// at the top once it is taller than the page.
function StepContainer({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-full w-full" contentClassName="flex min-h-full w-full p-4" data-testid="server-setup-step-scroller">
      <div className="m-auto flex w-full justify-center">
        <Suspense fallback={<NativeOnboardingLoading />}>{children}</Suspense>
      </div>
    </ScrollArea>
  );
}

export function isServerSettingsPath(pathname: string, serverSlug: string): boolean {
  const base = `/s/${serverSlug}/settings`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The activity-only agent page. The mobile app embeds it as the content of an
 *  agent's Activity tab, so a blocking setup modal would cover just that tab. */
export function isAgentActivityPath(pathname: string, serverSlug: string): boolean {
  const base = `/s/${serverSlug}/agent/`;
  if (!pathname.startsWith(base)) return false;
  return /^[^/]+\/activity\/?$/.test(pathname.slice(base.length));
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
  const displayStylePending = useOnboardingDisplayStylePending();
  const { pathname } = useLocation();
  const machines = useMachineStore((state) => state.machines);
  const loadMachines = useMachineStore((state) => state.loadMachines);
  // Every platform connects through Raft Computer's device authorization; the
  // retired standalone-daemon path (which minted a raw machine row + key) is gone.
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
  // "Use cloud agent" (staging test entry): two facts, neither derived from the other —
  // the request is in flight, and (once it has an answer) why it did not create Cindy.
  const [hostingCindy, setHostingCindy] = useState(false);
  const [hostedCindyFailure, setHostedCindyFailure] = useState<HostedCindyTestEntryFailureCode | null>(null);
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
  // Web only: the dedicated (native app) surface never shows the Pro step, so in-app
  // setup does not point at outside payment. It still owes nothing there: the step is
  // only ever owed before the handoff.
  const upgradePending = !dedicatedSurface && (projection?.postSetup?.upgradePending ?? false);
  const [loading, setLoading] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [error, setError] = useState("");
  // On a phone a setup step is a sheet (SetupStepDialog). It is blocking, so
  // it gets no × (it never had a way out); each step keeps its own head and
  // footer.
  // Each step draws its own title; the sheet is named for the flow.
  const setupLabel = formatMessage({ id: "layout.onboarding.setupServerEyebrow" });
  // No local "I clicked it" flag any more. `handoffPending` now reads the owner's durable
  // acknowledgment (stamped by the Let's Go command itself), not whether Cindy's briefing
  // happened to be delivered — so the server can answer this question on its own, in any
  // browser. The old session-only flag was the reason reopening elsewhere forgot the click.

  const refreshProjection = useCallback(async (holdCreateAgent = false) => {
    try {
      const nextProjection = await getServerSetupProjection(serverId);
      // A step is owed: every step's code now, so the next one is in when this one is done.
      if (projectionOwesSetupStep(nextProjection)) preloadServerSetupSteps();
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
  }, [machineSignature, gateStep, refreshProjection]);

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

  // Every handler is declared here, above the early returns below, so the hook order
  // is the same on every render.
  const refreshProjectionInBackground = useCallback(() => {
    void refreshProjection();
  }, [refreshProjection]);
  // The post-setup steps' one button each, counted where the gate hears it is done.
  const surveyDone = useCallback(() => {
    trackServerSetupAction(serverId, "survey", "continue");
    void refreshProjection();
  }, [refreshProjection, serverId]);
  const displayStyleDone = useCallback(() => {
    trackServerSetupAction(serverId, "display_style", "continue");
    completeOnboardingDisplayStyle();
  }, [serverId]);
  const handoffDone = useCallback(() => {
    trackServerSetupAction(serverId, "handoff", "lets_go");
    void refreshProjection();
  }, [refreshProjection, serverId]);

  const handleResume = useCallback(async () => {
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
  }, [formatMessage, loading, serverId]);
  const handleResumeClick = useCallback(() => {
    void handleResume();
  }, [handleResume]);

  // Read on every render now, including the completed-setup surfaces, which may omit
  // `allowedExits` entirely.
  const canResetSetup = projection?.allowedExits?.includes("reset") ?? false;
  const handleStartOver = useCallback(async () => {
    if (!canResetSetup || loading) return;
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
  }, [canResetSetup, formatMessage, loading, serverId]);
  const startOverFromComputer = useCallback(() => {
    trackServerSetupAction(serverId, "computer_runtime", "start_over");
    setConfirmStartOver(true);
  }, [serverId]);
  const startOverFromCreateAgent = useCallback(() => {
    trackServerSetupAction(serverId, "create_agent", "start_over");
    setConfirmStartOver(true);
  }, [serverId]);
  const trackCopiedCommand = useCallback((target: CopyTarget) => {
    const { action, os } = serverSetupCopyAction(target);
    trackServerSetupAction(serverId, "computer_runtime", action, os);
  }, [serverId]);
  const trackLeaveSetup = useCallback((way: "switch_server" | "server_settings") => {
    trackServerSetupAction(serverId, "computer_runtime", way);
  }, [serverId]);
  const trackCreateCindy = useCallback(() => {
    trackServerSetupAction(serverId, "create_agent", "create_cindy");
  }, [serverId]);
  const trackUseThisComputer = useCallback(() => {
    trackServerSetupAction(serverId, "computer_runtime", "use_this_computer");
  }, [serverId]);
  const copyRuntimeInstallCommand = useCallback((runtimeId: string, command: string) => {
    trackServerSetupAction(serverId, "computer_runtime", "copy_runtime_install_command");
    copyInstallCommand(runtimeId, command);
  }, [serverId]);
  const closeStartOverConfirm = useCallback(() => setConfirmStartOver(false), []);

  const handleComputerRuntimeNext = useCallback(() => {
    trackServerSetupAction(serverId, "computer_runtime", "next");
    if (pendingCreateAgentProjection) {
      setProjection(pendingCreateAgentProjection);
      setPendingCreateAgentProjection(null);
      return;
    }
    void refreshProjection();
  }, [pendingCreateAgentProjection, refreshProjection, serverId]);

  // "Use cloud agent": create the hosted Cindy instead of connecting a computer, then move
  // to whatever the server says is next. A success is NOT assumed, and not synthesized
  // locally like closeCompletedSetup: the created Cindy's first screen is Meet Cindy (a cold
  // agent the owner still has to brief), so the fresh projection decides the step.
  const handleUseCloudAgent = useCallback(async () => {
    if (hostingCindy) return;
    trackServerSetupAction(serverId, "computer_runtime", "use_cloud_agent");
    setHostingCindy(true);
    setHostedCindyFailure(null);
    try {
      const outcome = await createHostedCindyTestEntry(serverId);
      if (outcome.kind === "created") {
        await refreshProjection();
      } else {
        // `onboarding_agent_exists` is not a dead end: another tab (or another device) already
        // created Cindy, so re-read and let the server move straight into her flow, the same
        // way a create would. Every other code leaves the connect step as the way forward.
        if (outcome.code === "onboarding_agent_exists") await refreshProjection();
        setHostedCindyFailure(outcome.code);
      }
    } finally {
      setHostingCindy(false);
    }
  }, [hostingCindy, refreshProjection, serverId]);

  // The setup step on screen, mirroring the returns below, for the funnel (#proj-onboarding:#7):
  // seen once per step, and what holds it once per reason. Settings and agent-activity pages,
  // an unread or null projection and the member's display-style pick are no setup step.
  const onSetupRoute = dedicatedSurface
    || (!isServerSettingsPath(pathname, serverSlug) && !isAgentActivityPath(pathname, serverSlug));
  let shownSetupStep: ServerSetupStep | null = null;
  if (onSetupRoute && projectionResolved && projection && projection.phase !== null) {
    if (projection.surface === "complete") {
      if (surveyPending) shownSetupStep = "survey";
      else if (upgradePending) shownSetupStep = "upgrade";
      else if (handoffPending) shownSetupStep = displayStylePending ? "display_style" : "handoff";
    } else if (projection.blocksChat && projection.surface === "create_agent") {
      shownSetupStep = "create_agent";
    } else if (projection.blocksChat && projection.surface === "computer_runtime") {
      shownSetupStep = "computer_runtime";
    }
  }
  const setupGateReason = projection?.gateReason ?? null;
  useEffect(() => {
    trackServerSetupStepShown(serverId, shownSetupStep);
    trackServerSetupBlocked(serverId, shownSetupStep, setupGateReason);
  }, [serverId, shownSetupStep, setupGateReason]);

  // Settings is the setup flow's escape hatch (the footer links here; Delete lives
  // here), so the blocking modal stays down on it. The activity-only agent page
  // is tab content inside the mobile app, and is read-only. Every other route
  // still gets the gate, so this does not reopen a way to skip setup (task #246).
  if (!dedicatedSurface && isServerSettingsPath(pathname, serverSlug)) return null;
  if (!dedicatedSurface && isAgentActivityPath(pathname, serverSlug)) return null;

  if (!projectionResolved) {
    if (!dedicatedSurface) return null;
    return <NativeOnboardingLoading />;
  }
  // No projection, or a server-declared null phase (e.g. non-owner
  // insufficient_permission, or a first-load fetch failure) → render NOTHING.
  // This used to fall back to the legacy onboarding wizard, whose
  // still-live "enable-notifications" step was how a "Turn on notifications"
  // modal could pop up on any gate-mounting page. The wizard is gone; the
  // honest state when we don't know is to show nothing (task #164).
  // Task #247: a new account that is not in a setup of its own (an invited
  // member, or an owner whose setup is already behind them) picks its display
  // style here, in the slot where this gate would otherwise render nothing, so
  // it can never stack on a setup step.
  // A post-setup step is a blocking dialog in the browser and page content on the
  // dedicated (native) surface.
  // `centred`: the last step (Let's go) is a statement and one button, so it
  // stays a centred card on a phone too.
  const presentStep = (step: ReactNode, centred = false) => (dedicatedSurface
    ? <StepContainer>{step}</StepContainer>
    : <SetupStepDialog label={setupLabel} narrow={centred ? "centered" : "sheet"}>{step}</SetupStepDialog>);
  const memberDisplayStyle = displayStylePending && !dedicatedSurface
    ? presentStep(<ServerSetupDisplayStyleStep variant="member" onDone={completeOnboardingDisplayStyle} />)
    : null;
  if (!projection || projection.phase === null) {
    if (!dedicatedSurface) return memberDisplayStyle;
    const messageId = projectionLoadFailed
      ? "onboarding.native.loadFailed"
      : "onboarding.native.unavailable";
    return (
      <div className="flex min-h-full w-full items-center justify-center p-6" data-testid="native-onboarding-unavailable">
        <Card className="block w-full max-w-md p-5 text-center">
          <p className="text-subhead font-bold text-foreground">{formatMessage({ id: messageId })}</p>
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="mt-4"
            onClick={retryProjection}
          >
            {formatMessage({ id: "onboarding.native.retry" })}
          </Button>
        </Card>
      </div>
    );
  }
  // Both are checked ahead of the blocksChat guard on purpose: completing setup flips
  // blocksChat to false, so neither would get a chance to render otherwise. They only
  // apply once setup itself is done.
  const setupComplete = projection.surface === "complete";
  if (setupComplete && surveyPending) {
    const step = <ServerSetupSurveyStep onDone={surveyDone} />;
    return presentStep(step);
  }
  if (setupComplete && upgradePending) {
    const step = <ServerSetupUpgradeStep serverId={serverId} serverSlug={serverSlug} onDone={refreshProjectionInBackground} />;
    return presentStep(step);
  }
  // Task #247: after the survey, before the handoff, so Cindy's first message
  // arrives in the style the owner picked. Browser-local, like the theme.
  if (setupComplete && handoffPending && displayStylePending) {
    const step = <ServerSetupDisplayStyleStep onDone={displayStyleDone} />;
    return presentStep(step);
  }
  if (setupComplete && handoffPending) {
    const step = (
      <ServerSetupHandoffStep
        serverId={serverId}
        onDone={handoffDone}
      />
    );
    return presentStep(step, true);
  }
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
            <p className="text-callout text-foreground-muted">{formatMessage({ id: "onboarding.native.complete" })}</p>
          </div>
        );
      }
      return memberDisplayStyle;
    }
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-app flex justify-center px-4 pb-4"
        data-testid="server-setup-resume-bar"
      >
        <div className="pointer-events-auto flex w-full max-w-[560px] flex-wrap items-center justify-between gap-3 rounded-container bg-layer-popover px-4 py-3 text-foreground shadow-float ring-1 ring-line-seam">
          <p className="min-w-0 text-callout font-bold">
            {formatMessage({ id: "layout.onboarding.notSetUpYet" })}
          </p>
          <Button
            type="button"
            onClick={handleResumeClick}
            disabled={loading}
            size="md"
            variant="outline"
            className="shrink-0"
            data-testid="server-setup-resume"
          >
            {loading
              ? formatMessage({ id: "layout.onboarding.opening" })
              : formatMessage({ id: "layout.onboarding.resumeSetup" })}
          </Button>
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
  const serverUrl = getServerUrl();
  const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl);
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    platform: "windows",
  });

  // The confirm dialog. Rendered by the gate itself, never by a step — a confirm nested inside
  // a step never mounted at all on the Meet Cindy path in the first version, so clicking
  // "Start over" from that screen was silent (@cindyz caught it on staging). It sits at the
  // gate's level so wherever the trigger lives, this dialog lands: in the browser inside the
  // step's dialog (SetupStepDialog `confirm`, stacked over it), beside the page otherwise.
  const startOverConfirm = confirmStartOver ? (
    <ConfirmDialog
      title={formatMessage({ id: "layout.onboarding.startOverTitle" })}
      layer={1}
      confirmLabel={formatMessage({ id: "layout.onboarding.startOverConfirm" })}
      confirmTestId="server-setup-confirm-start-over"
      message={startOverMachineCount > 0
        ? formatMessage(
            { id: "layout.onboarding.startOverMessageWithComputers" },
            { count: startOverMachineCount },
          )
        : formatMessage({ id: "layout.onboarding.startOverMessageEmpty" })}
      onConfirm={handleStartOver}
      onClose={closeStartOverConfirm}
    />
  ) : null;

  if (projection.surface === "create_agent") {
    // "step" (browser dialog) keeps the pre-standalone first-agent navigation to
    // the onboarding-owner channel behind the modal; "page" (client standalone
    // page) must stay put for the survey/handoff steps.
    const createAgentStep = (
      <CreateAgentDialog
        onboarding
        onboardingShell={dedicatedSurface ? "page" : "step"}
        onClose={refreshProjectionInBackground}
        onOnboardingComplete={closeCompletedSetup}
        onOnboardingStartOver={canResetSetup ? startOverFromCreateAgent : undefined}
        onSubmitStart={trackCreateCindy}
      />
    );
    return dedicatedSurface ? (
      <>
      {startOverConfirm}
      <StepContainer>{createAgentStep}</StepContainer>
      </>
    ) : <SetupStepDialog label={setupLabel} confirm={startOverConfirm}>{createAgentStep}</SetupStepDialog>;
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
        runtimeOptions={authoritative.runtimeOptions ?? NO_RUNTIME_OPTIONS}
        hasConnectedComputer={authoritative.hasConnectedComputer ?? false}
        offlineComputers={authoritative.offlineComputers ?? NO_OFFLINE_COMPUTERS}
        serverSlug={serverSlug}
        showOwnApiKey={false}
        loading={loading}
        error={error || gateMessage(projection.gateReason, formatMessage)}
        setupCommand={computerCommands?.setup ?? null}
        computerInstallCommand={computerCommands?.install}
        computerInstallAndSetupCommand={computerCommands?.installAndSetup ?? null}
        windowsComputerSetupCommand={windowsComputerCommands?.setup ?? null}
        windowsComputerInstallCommand={windowsComputerCommands?.install}
        onCopyInstallCommand={copyRuntimeInstallCommand}
        canReset={canResetSetup}
        onStartOver={startOverFromComputer}
        hostedCindyTestEntry={projection.hostedCindyTestEntry === true}
        hostingCindy={hostingCindy}
        hostedCindyFailure={hostedCindyFailure}
        onUseCloudAgent={handleUseCloudAgent}
        onNext={handleComputerRuntimeNext}
        onCopyCommand={trackCopiedCommand}
        onUseThisComputer={trackUseThisComputer}
        onLeaveSetup={trackLeaveSetup}
      />
  );

  return dedicatedSurface ? (
    <>
    {startOverConfirm}
    <StepContainer>{computerRuntimeStep}</StepContainer>
    </>
  ) : <SetupStepDialog label={setupLabel} confirm={startOverConfirm}>{computerRuntimeStep}</SetupStepDialog>;
}
