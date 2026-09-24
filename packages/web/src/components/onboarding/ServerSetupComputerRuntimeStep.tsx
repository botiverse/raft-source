import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { clearClockTimeout, getMachineRuntimeDisplayOptions, getSetupRuntimeOptions, setClockTimeout } from "@botiverse/raft-shared";
import type { RuntimeInfo, RuntimeSelectionOption } from "@botiverse/raft-shared";
import { Check, ChevronRight, Copy, KeyRound, Monitor, Terminal, X } from "lucide-react";
import type { ServerSetupRuntimeStatus } from "./serverSetupProjection";
import { formatRelativeTime } from "../../utils/relativeTime";
import ComputerCommandGuide from "../machine/ComputerCommandGuide";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import TextLink from "../ui/TextLink";
import SetupSessionFooter from "./SetupSessionFooter";

const RECOMMENDED_RUNTIME_IDS = ["claude", "codex"] as const;
const RUNTIME_INSTALL_COMMANDS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

type ConnectionMotionPhase = "idle" | "success" | "handoff" | "settled";
type ConnectionMotionState = {
  computerExpanded: boolean;
  phase: ConnectionMotionPhase;
};
type ConnectionMotionAction =
  | { type: "toggle" }
  | { type: "start" }
  | { type: "handoff" }
  | { type: "settle" }
  | { type: "skip" }
  | { type: "cancel" };

function connectionMotionReducer(state: ConnectionMotionState, action: ConnectionMotionAction): ConnectionMotionState {
  switch (action.type) {
    case "toggle":
      return { ...state, computerExpanded: !state.computerExpanded };
    case "start":
      return { computerExpanded: true, phase: "success" };
    case "handoff":
      return { computerExpanded: false, phase: "handoff" };
    case "settle":
      return { ...state, phase: "settled" };
    case "skip":
      return { computerExpanded: false, phase: "settled" };
    case "cancel":
      return { computerExpanded: true, phase: "settled" };
  }
}

/**
 * The connection motion timers are scheduled in parallel from one start, not
 * chained: `handoff` at 1400ms and `settle` at 2040ms are independent. `settle`
 * is the moment the step stops animating and hands the screen back to the user,
 * so its arrival time is the quantity worth pinning — see the timing assertion
 * in `serverSetupComputerRuntimeMotion.behavior.test.tsx`.
 *
 * Exported for that test: the schedule is real behavior, and asserting it from
 * source text would only prove the code was written, not that it still runs.
 */
export function startConnectionMotion(
  dispatch: (action: ConnectionMotionAction) => void,
  reducedMotion: boolean,
): () => void {
  if (reducedMotion) {
    dispatch({ type: "skip" });
    return () => undefined;
  }

  dispatch({ type: "start" });
  const handoffTimer = setClockTimeout(() => dispatch({ type: "handoff" }), 1_400);
  const settleTimer = setClockTimeout(() => dispatch({ type: "settle" }), 2_040);

  return () => {
    clearClockTimeout(handoffTimer);
    clearClockTimeout(settleTimer);
  };
}

export type ServerSetupComputer = {
  id: string;
  name: string;
  status: "online" | "offline";
  runtimeIds: readonly string[];
  /** A managed Computer, not a legacy daemon machine. */
  isComputer?: boolean;
};

export type ServerSetupRuntimeCatalogEntry = RuntimeInfo & {
  detected: boolean;
  recommended: boolean;
};

export type ServerSetupComputerRuntimeStepProps = {
  computer: ServerSetupComputer | null;
  computerInstallCommand?: string;
  /**
   * The server's verdict, from `ServerSetupProjection`. Not derived in the browser — and
   * NOT a boolean: "we have not been told yet" (`checking`/`unknown`) is a different thing
   * from "we were told there is nothing usable" (`not_ready`), and collapsing them is how
   * the screen used to render our own uncertainty as the user's failure.
   */
  runtimeStatus: ServerSetupRuntimeStatus;
  /** Server-owned setup-context options; raw machine runtimes remain capability telemetry only. */
  runtimeOptions?: readonly RuntimeSelectionOption[];
  /**
   * They have a Computer already — it is simply not running. Distinct from `computer`
   * (the live connection being watched) and from `computerStatus === "offline"`: this is
   * the DURABLE fact "a non-revoked computer row exists on this server". A closed laptop
   * is not the same as never having connected one, and the two must not read alike.
   */
  hasConnectedComputer?: boolean;
  /**
   * Every computer this server has. Screen B used to know only about the machine that
   * appeared DURING this setup attempt — so a user with three old, sleeping computers and
   * no new connection got an unnamed "Your computer isn't running". Having the name is the
   * whole point: it is the difference between "I remember you" and "who are you?".
   */
  offlineComputers?: ReadonlyArray<{ id: string; name: string; lastHeartbeat: string | null; isComputer?: boolean }>;
  /** For the recovery copy: "set up on /{slug}", mirroring Machine Detail. */
  serverSlug?: string | null;
  showOwnApiKey?: boolean;
  loading?: boolean;
  error?: string;
  setupCommand?: string | null;
  macLinuxDaemonCommand?: string;
  windowsComputerInstallCommand?: string;
  windowsComputerSetupCommand?: string | null;
  windowsDaemonCommand?: string;
  onRequestWindowsDaemonCommand?: () => void;
  windowsDaemonCommandPending?: boolean;
  onCopyInstallCommand?: (runtimeId: string, command: string) => void;
  onOpenApiKeySettings?: () => void;
  /**
   * The two ways out, decided by the server, not by this component.
   *
   * `canReset` — "Start over": throw this half-built server away. True while it has never
   * had an agent, which is the only state in which we can honestly promise nothing is lost.
   */
  canReset?: boolean;
  onStartOver?: () => void;
  onNext: () => void;
};

export function getServerSetupRuntimeCatalog(runtimeOptions: readonly RuntimeSelectionOption[]): {
  recommended: ServerSetupRuntimeCatalogEntry[];
  supported: ServerSetupRuntimeCatalogEntry[];
} {
  const visible = runtimeOptions.flatMap((option) => {
    const runtime = getSetupRuntimeOptions().find((candidate) => candidate.id === option.runtimeId);
    return runtime ? [{ runtime, option }] : [];
  });
  const toEntry = ({ runtime, option }: { runtime: RuntimeInfo; option: RuntimeSelectionOption }): ServerSetupRuntimeCatalogEntry => ({
    ...runtime,
    detected: option.capabilityStatus === "available",
    recommended: RECOMMENDED_RUNTIME_IDS.some((id) => id === runtime.id),
  });
  const recommended = RECOMMENDED_RUNTIME_IDS.flatMap((id) => {
    const entry = visible.find(({ runtime }) => runtime.id === id);
    return entry ? [toEntry(entry)] : [];
  });
  const supported = visible
    .filter(({ runtime }) => !RECOMMENDED_RUNTIME_IDS.some((id) => id === runtime.id))
    .map(toEntry)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  return { recommended, supported };
}

function getPreferredReadyRuntime(runtimeOptions: readonly RuntimeSelectionOption[]) {
  const selectable = new Set(
    runtimeOptions.filter((option) => option.canSelectInThisContext).map((option) => option.runtimeId),
  );
  return getSetupRuntimeOptions().find((runtime) => selectable.has(runtime.id)) ?? null;
}

// Everything the computer actually found. The log used to name only the first one
// ("Runtime detected: Claude Code.") on a machine that also had Codex, OpenCode and Pi —
// it reads as though detection stopped at the first hit.
function getDetectedRuntimeNames(runtimeOptions: readonly RuntimeSelectionOption[]): string[] {
  const detected = new Set(
    runtimeOptions.filter((option) => option.capabilityStatus === "available").map((option) => option.runtimeId),
  );
  return getMachineRuntimeDisplayOptions()
    .filter((runtime) => detected.has(runtime.id) && runtime.id !== "builtin")
    .map((runtime) => runtime.displayName);
}

export default function ServerSetupComputerRuntimeStep({
  computer,
  runtimeStatus,
  runtimeOptions = [],
  hasConnectedComputer = false,
  offlineComputers = [],
  serverSlug = null,
  showOwnApiKey = true,
  loading = false,
  error = "",
  setupCommand = null,
  computerInstallCommand = "",
  macLinuxDaemonCommand = "",
  windowsComputerInstallCommand = "",
  windowsComputerSetupCommand = null,
  windowsDaemonCommand = "",
  onRequestWindowsDaemonCommand,
  windowsDaemonCommandPending = false,
  onCopyInstallCommand,
  onOpenApiKeySettings,
  canReset = false,
  onStartOver,
  onNext,
}: ServerSetupComputerRuntimeStepProps) {
  const { formatMessage } = useIntl();
  // The connect step is no longer collapsible, so only the motion phase is read
  // from here; `computerExpanded` still drives the reducer's phase transitions.
  const [{ phase: connectionMotionPhase }, dispatchConnectionMotion] = useReducer(connectionMotionReducer, {
    computerExpanded: true,
    phase: "idle",
  });
  const [platform, setPlatform] = useState<"mac-linux" | "windows">("mac-linux");
  // The escape hatch, for the machine that is never coming back (it died, it was returned,
  // they left the company). We cannot know that — only they can — so we do not guess from
  // "offline for N days". We ask, by putting the door on the page and letting them open it.
  const [expandedRuntimeId, setExpandedRuntimeId] = useState<string | null>(null);
  // oxlint-disable-next-line react-doctor/no-event-handler -- The server-authoritative offline->online edge is the event that drives this one-shot presentation timeline. Moving it upward would duplicate the same previous-value tracking without changing ownership or render cost.
  const computerOnline = computer?.status === "online";
  const previousComputerOnlineRef = useRef(computerOnline);
  const connectionMotionPlayedRef = useRef(false);
  const verifyingComputer = !!computer && !computerOnline;
  const catalog = getServerSetupRuntimeCatalog(runtimeOptions);
  const preferredRuntime = getPreferredReadyRuntime(runtimeOptions);
  const detectedRuntimeNames = getDetectedRuntimeNames(runtimeOptions);
  // ONE question, ONE answer — and five possible answers, not two.
  //
  // The server decides; the browser draws. The first pass of this change replaced only
  // the Next button's `ready` flag and left the FAILURE verdict ("No usable runtime yet")
  // keyed on `runtimeIds.length > 0` from the socket-fed machine store — so a stale store
  // could still render "detection failed" while the server was saying `checking`. That is
  // the same second reader, just smaller (@Dozy caught it).
  //
  // `checking`/`unknown` mean WE HAVE NOT BEEN TOLD YET. They are not a finding, and they
  // must never be drawn as one.
  const ready = runtimeStatus === "ready_recommended" || runtimeStatus === "ready_other";
  // `checking` / `unknown` are exactly the state where NEITHER of these is true: the
  // server has issued no verdict, so the screen shows "Detecting runtime…" and nothing
  // else. That absence is the whole point — an un-answered question is not a finding.
  const runtimeAnswered = runtimeStatus === "not_ready" || runtimeStatus === "error";
  const defaultExpandedRuntimeId = preferredRuntime?.id ?? "claude";
  const activeExpandedRuntimeId = expandedRuntimeId ?? defaultExpandedRuntimeId;
  const runtimeVisible = computerOnline && connectionMotionPhase !== "success";
  // They connected a computer before; it is just not running. Do NOT hand them the install
  // and setup commands again — the binary is already on that machine, and re-running setup
  // on the same box changes nothing. `MachineDetailPanel` worked this out first (task #247:
  // "the binary is already on the machine — so this replaces the old install+setup surface")
  // and onboarding simply never used the answer. Two screens, one fact, two attitudes: the
  // computer page recognised the user, this one asked who they were.
  const recovering = !computerOnline && hasConnectedComputer;
  const recoveringMany = recovering && offlineComputers.length > 1;
  // The computer has actually answered the runtime question (whatever the answer was),
  // as opposed to being online but not having reported yet.
  // The computer has ANSWERED the runtime question (whatever the answer was) — per the
  // server, not per whatever the store happens to be holding.
  const runtimesReported = runtimeAnswered || ready;

  useEffect(() => {
    const wasOnline = previousComputerOnlineRef.current;
    previousComputerOnlineRef.current = computerOnline;
    if (!computerOnline) {
      if (connectionMotionPlayedRef.current) dispatchConnectionMotion({ type: "cancel" });
      return;
    }
    if (wasOnline || connectionMotionPlayedRef.current) return;

    connectionMotionPlayedRef.current = true;
    return startConnectionMotion(
      dispatchConnectionMotion,
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    );
  }, [computerOnline]);

  return (
    <section className="flex w-full max-w-[960px] flex-col border-2 border-black bg-white shadow-brutal md:h-[min(720px,calc(100dvh-3rem))] md:min-h-[520px] md:overflow-hidden">
      <header className="shrink-0 border-b-2 border-black px-6 pb-4 pt-6 sm:px-9">
        <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-black/55">
          {formatMessage({ id: "onboarding.computerRuntime.eyebrow" })}
        </p>
        {/* Do not ask a returning user who they are. "Connect a computer" is the right
            question only for someone who has never connected one; for someone whose machine
            is merely asleep it is the product saying it does not remember them. */}
        <h1 className="mt-2 text-xl font-bold">
          {/* Three independent sentences, one id each — not a composed string.
              zh does not keep this clause order. */}
          {formatMessage({
            id: recoveringMany
              ? "onboarding.computerRuntime.titleRecoverMany"
              : recovering
                ? "onboarding.computerRuntime.titleRecoverOne"
                : "onboarding.computerRuntime.titleConnect",
          })}
        </h1>
        <p className="mt-1 text-xs leading-5 text-black/60">
          {formatMessage({
            id: recoveringMany
              ? "onboarding.computerRuntime.bodyRecoverMany"
              : recovering
                ? "onboarding.computerRuntime.bodyRecoverOne"
                : "onboarding.computerRuntime.bodyConnect",
          })}
        </p>
      </header>

      <div className="space-y-3 px-5 py-4 sm:px-9 md:min-h-0 md:flex-1 md:overflow-y-auto">
        {error ? <Banner intent="warning" density="sm" className="font-bold">{error}</Banner> : null}

        {/* The connect step is one linear flow, not a collapsible section: its
            title is already the modal's heading, and wrapping it in a second
            "Connect Computer" box just repeated that title inside another
            border.

            The command stays on screen after the computer connects. It is the thing
            the user just ran: hiding it the moment it works rewrites the screen out
            from under them, and leaves nothing to point at if they have to run it
            again on a second machine. The log prints underneath it, line by line. */}
        <div
          className={`space-y-3 ${connectionMotionPhase === "success" ? "onboarding-connect-success-reveal" : ""}`}
          data-motion-state={connectionMotionPhase}
          data-testid={computerOnline ? "onboarding-computer-connected" : undefined}
        >
          {/* The SAME component Add Computer uses. Platform-specific shell commands stay in
              the shared builder/guide so onboarding cannot invent a WSL or daemon-only
              Windows path that disagrees with the Computer page. */}
          {recovering ? (
            <OfflineComputerRecovery
              computers={offlineComputers.length > 0
                ? offlineComputers
                : computer
                  ? [{ id: computer.id, name: computer.name, lastHeartbeat: null, isComputer: computer.isComputer }]
                  : []}
              serverSlug={serverSlug ?? null}
              macLinuxDaemonCommand={macLinuxDaemonCommand}
              windowsDaemonCommand={windowsDaemonCommand}
              onRequestWindowsDaemonCommand={onRequestWindowsDaemonCommand}
              windowsDaemonCommandPending={windowsDaemonCommandPending}
              canReset={canReset}
              onStartOver={onStartOver}
            />
          ) : null}
          {recovering ? null : (
            <>
              <ComputerCommandGuide
                computerCommand={setupCommand}
                computerInstallCommand={computerInstallCommand}
                windowsComputerCommand={windowsComputerSetupCommand}
                windowsComputerInstallCommand={windowsComputerInstallCommand}
                macLinuxDaemonCommand={macLinuxDaemonCommand}
                windowsDaemonCommand={windowsDaemonCommand}
                onPlatformChange={setPlatform}
                onRequestWindowsDaemonCommand={onRequestWindowsDaemonCommand}
                windowsDaemonCommandPending={windowsDaemonCommandPending}
                // #5254 / task #197: setup must not offer the legacy daemon path. It creates
                // only a raw `machines` row, which can never satisfy the managed `computers`
                // attachment this projection gates on — so here it is not an alternative, it is
                // a route that cannot finish. The Computers page keeps it (default true).
                showLegacyDaemon={false}
              />
              {/* Instructions are for someone who has not run it yet; once the computer is
                  online they are just history. The log takes over. */}
              {computerOnline ? null : <ConnectComputerInstructions platform={platform} />}
            </>
          )}
          {recovering ? null : (
          <ConnectProgressLog
            computerName={computer?.name ?? null}
            computerOnline={computerOnline}
            waiting={verifyingComputer}
            runtimeReady={ready}
            runtimeNames={detectedRuntimeNames}
            runtimesReported={runtimesReported}
          />
          )}
        </div>

        {/* No separate "Detect Runtime" step. Runtime detection is not something the
            user does, it is something that happens; the log above ticks it off as it
            lands. What remains here is only the picker for the case where nothing
            usable was found — and when there is nothing to put in it, the box is not
            rendered at all. An empty bordered div is just a stray line across the page.

            `runtimesReported` is what keeps it from FLASHING. A computer comes online a
            beat before its runtime list arrives, and in that gap "no usable runtime" is
            not a finding, it is simply an unanswered question — rendering the box there
            made it appear and vanish again the moment the list landed. The log's
            "Detecting runtime…" spinner is the honest thing to show while we wait. */}
        {runtimeVisible && !ready && runtimeAnswered ? (
        <div
          className={`border-2 border-black ${connectionMotionPhase === "handoff" ? "onboarding-runtime-reveal" : ""}`}
          data-motion-state={connectionMotionPhase}
        >
          <div className="px-4 py-3">
            <h2 className="text-sm font-bold">{formatMessage({ id: "onboarding.computerRuntime.noRuntimeTitle" })}</h2>
            <p className="mt-1 text-xs text-black/55">
              {formatMessage({ id: "onboarding.computerRuntime.noRuntimeBody" })}
            </p>
          </div>

          <div>
          <RuntimeGroupLabel note={formatMessage({ id: "onboarding.computerRuntime.recommendedNote" })}>
            {formatMessage({ id: "onboarding.computerRuntime.recommended" })}
          </RuntimeGroupLabel>
          {catalog.recommended.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              computerName={computer?.name ?? null}
              expanded={activeExpandedRuntimeId === runtime.id}
              onToggle={() => setExpandedRuntimeId(activeExpandedRuntimeId === runtime.id ? "" : runtime.id)}
              onCopyInstallCommand={onCopyInstallCommand}
            />
          ))}

          <RuntimeGroupLabel>{formatMessage({ id: "onboarding.computerRuntime.allSupported" })}</RuntimeGroupLabel>
          {catalog.supported.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              computerName={computer?.name ?? null}
              expanded={activeExpandedRuntimeId === runtime.id}
              onToggle={() => setExpandedRuntimeId(activeExpandedRuntimeId === runtime.id ? "" : runtime.id)}
              onCopyInstallCommand={onCopyInstallCommand}
              quiet={!runtime.detected}
            />
          ))}
          {showOwnApiKey ? (
            <OwnApiKeyRow
              expanded={activeExpandedRuntimeId === "own-api-key"}
              onToggle={() => setExpandedRuntimeId(activeExpandedRuntimeId === "own-api-key" ? "" : "own-api-key")}
              onOpenSettings={onOpenApiKeySettings}
            />
          ) : null}
          </div>
        </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-col-reverse gap-3 border-t-2 border-black px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-9">
        <div className="flex min-w-0 items-center gap-3">
          <SetupSessionFooter disabled={loading} />
        </div>
        <Button
          type="button"
          onClick={onNext}
          disabled={loading || !ready}
          size="lg"
          tone="pink"
          className="w-full sm:w-auto"
        >
          {formatMessage({
            id: loading ? "onboarding.computerRuntime.saving" : "onboarding.computerRuntime.next",
          })}
        </Button>
      </footer>
    </section>
  );
}


/**
 * The connect sequence, printed as it happens.
 *
 * Not a stepper with a fake "current" dot, and not a separate "Detect Runtime"
 * section the user has to notice: one continuous log that ticks off as each thing
 * actually becomes true. Two or three ticks land in sequence, which is what gives
 * the sense of gradually coming online.
 *
 * Every line is derived from real state. Nothing here predicts.
 */
/**
 * They already have a Computer; it just is not running.
 *
 * The command is `raft-computer start`, NOT install+setup. The binary is already on that
 * machine — re-running setup on the same box would change nothing, and asking someone who
 * just connected a computer to "connect a computer" is how a product tells a user it does
 * not remember them. `MachineDetailPanel` (task #247) reached this conclusion first and
 * says so in the same words; onboarding is finally reusing the answer instead of shipping
 * a second opinion.
 */
function RecoveryCommandRow({
  command,
  testId,
  copied,
  onCopy,
}: {
  command: string;
  testId: string;
  copied: string | null;
  onCopy: (command: string) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex items-center gap-2">
      <code
        className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
        data-testid={testId}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => onCopy(command)}
        className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
        title={formatMessage({ id: "onboarding.computerRuntime.copyCommand" }, { command })}
        aria-label={formatMessage({ id: "onboarding.computerRuntime.copyCommand" }, { command })}
      >
        {copied === command ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function OfflineComputerRecovery({
  computers,
  serverSlug,
  macLinuxDaemonCommand,
  windowsDaemonCommand,
  onRequestWindowsDaemonCommand,
  windowsDaemonCommandPending = false,
  canReset = false,
  onStartOver,
}: {
  computers: ReadonlyArray<{ id: string; name: string; lastHeartbeat: string | null; isComputer?: boolean }>;
  serverSlug: string | null;
  macLinuxDaemonCommand: string;
  windowsDaemonCommand: string;
  onRequestWindowsDaemonCommand?: () => void;
  windowsDaemonCommandPending?: boolean;
  canReset?: boolean;
  onStartOver?: () => void;
}) {
  const { formatMessage, locale } = useIntl();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (command: string) => {
    void navigator.clipboard?.writeText(command);
    setCopied(command);
    setClockTimeout(() => setCopied(null), 1_500);
  };

  const many = computers.length > 1;
  // `raft-computer start` is the SAME command on every one of their machines, and the
  // server only needs ONE online to continue. So this is not a chooser — making them pick
  // would be turning our implementation detail into their homework. It is a LIST: we tell
  // them what they have (name, last seen) and they decide which one they can actually
  // reach. Which machine is easiest to switch on lives in their head, not in our database.
  const anyLegacyDaemon = computers.some((c) => c.isComputer === false);

  return (
    <div className="space-y-4" data-testid="onboarding-offline-recovery">
      <div className="flex items-center gap-2">
        <Terminal size={16} className="text-black" />
        <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-black/55">
          {many
            ? formatMessage({ id: "onboarding.computerRuntime.titleRecoverMany" })
            : formatMessage(
                { id: "onboarding.computerRuntime.bringBackOnline" },
                { computer: computers[0]?.name ?? formatMessage({ id: "onboarding.computerRuntime.yourComputer" }) },
              )}
        </p>
      </div>

      {computers.length > 0 ? (
        <ul className="space-y-2" data-testid="onboarding-offline-computer-list">
          {computers.map((c) => {
            const lastSeen = formatRelativeTime(c.lastHeartbeat, locale);
            return (
              <li key={c.id} className="flex items-center gap-3 border-2 border-black bg-white px-3 py-2">
                <Monitor size={16} className="shrink-0 text-black/60" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold">{c.name}</p>
                  {/* Only what we actually know. No last-seen row rather than a made-up one. */}
                  <p className="text-[11px] text-black/50">
                    {/* `lastSeen` is app-locale correct: task #53 (#5848) gave
                        formatRelativeTime an explicit locale parameter, and this
                        call site passes the one from useIntl. */}
                    {lastSeen
                      ? formatMessage({ id: "onboarding.computerRuntime.offlineLastSeen" }, { when: lastSeen })
                      : formatMessage({ id: "onboarding.computerRuntime.offline" })}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {anyLegacyDaemon ? (
        <div data-testid="onboarding-recovery-legacy-daemon">
          <p className="mb-2 text-xs leading-5 text-black/60">
            {formatMessage({ id: "onboarding.computerRuntime.legacyDaemon" })}
          </p>
          <ComputerCommandGuide
            computerCommand={null}
            computerInstallCommand={null}
            macLinuxDaemonCommand={macLinuxDaemonCommand}
            windowsDaemonCommand={windowsDaemonCommand}
            onRequestWindowsDaemonCommand={onRequestWindowsDaemonCommand}
            windowsDaemonCommandPending={windowsDaemonCommandPending}
          />
        </div>
      ) : (
        <>
          <div>
            <p className="mb-2 text-xs leading-5 text-black/60">
              {many
                ? formatMessage({ id: "onboarding.computerRuntime.recoverManyHint" })
                : formatMessage(
                    { id: "onboarding.computerRuntime.recoverOneHint" },
                    { server: serverSlug ?? formatMessage({ id: "onboarding.computerRuntime.yourServer" }) },
                  )}
            </p>
            <RecoveryCommandRow command="raft-computer start" testId="onboarding-recovery-start-command" copied={copied} onCopy={copy} />
          </div>

          <div>
            <p className="mb-2 text-xs leading-5 text-black/60">
              {/* REUSED from the Computer detail page rather than minted again: it is the
                  same prompt, and this whole recovery card exists because
                  MachineDetailPanel worked the problem out first (see the note at
                  the top of this file). Minting a second id is what produced the
                  drift the catalog ratchet just caught. */}
              {formatMessage({ id: "machine.detail.offlineDiagnosticsPrompt" })}
            </p>
            <div className="space-y-2">
              <RecoveryCommandRow command="raft-computer status" testId="onboarding-recovery-status" copied={copied} onCopy={copy} />
              <RecoveryCommandRow command="raft-computer doctor" testId="onboarding-recovery-doctor" copied={copied} onCopy={copy} />
              <RecoveryCommandRow command="raft-computer restart" testId="onboarding-recovery-restart" copied={copied} onCopy={copy} />
            </div>
          </div>
        </>
      )}

      {/*
        The way out lives HERE, next to the thing that failed — not in a corner of the modal
        chrome. Someone who cannot reach any of these machines is stuck on THIS card, and the
        answer to "none of these work" is not "connect another one" (which strands the dead
        ones behind them, and is the same install command they already can't run) — it is
        "throw this away and start again". One question, one answer, in the same place.
      */}
      {!canReset ? null : (
        <div className="flex flex-wrap items-baseline gap-x-1 text-sm">
          <span data-testid="onboarding-recovery-start-over-description">
            {formatMessage({
              id: many
                ? "onboarding.computerRuntime.startOverPromptMany"
                : "onboarding.computerRuntime.startOverPromptOne",
            })}
          </span>
          <TextLink onClick={onStartOver} data-testid="onboarding-recovery-start-over">
            {formatMessage({ id: "onboarding.computerRuntime.startOver" })}
          </TextLink>
        </div>
      )}
    </div>
  );
}

function ConnectProgressLog({
  computerName,
  computerOnline,
  waiting,
  runtimeReady,
  runtimeNames,
  runtimesReported = false,
}: {
  computerName: string | null;
  computerOnline: boolean;
  waiting: boolean;
  runtimeReady: boolean;
  runtimeNames: readonly string[];
  // The computer has answered the runtime question, whatever the answer was.
  runtimesReported?: boolean;
}) {
  const { formatMessage } = useIntl();
  const lines: Array<{ key: string; text: string; done: boolean; pending: boolean; failed?: boolean }> = [
    {
      key: "approve",
      text: formatMessage({
        id: waiting || computerOnline
          ? "onboarding.computerRuntime.logApproved"
          : "onboarding.computerRuntime.logWaitingApproval",
      }),
      done: waiting || computerOnline,
      pending: !waiting && !computerOnline,
    },
  ];

  if (waiting || computerOnline) {
    lines.push({
      key: "online",
      // The computer name sits INSIDE both sentences and zh puts it elsewhere,
      // so it is an ICU argument, not a prefix.
      text: formatMessage(
        {
          id: computerOnline
            ? "onboarding.computerRuntime.logConnected"
            : "onboarding.computerRuntime.logWaitingOnline",
        },
        { computer: computerName ?? formatMessage({ id: "onboarding.computerRuntime.yourComputer" }) },
      ),
      done: computerOnline,
      pending: !computerOnline,
    });
  }

  if (computerOnline) {
    // Three outcomes, not two. The computer having ANSWERED with a runtime list we
    // cannot use is a result, not a state to spin on: without this the log sat on
    // "Detecting runtime…" forever and the only sign of failure was a box below it.
    const detectionFailed = !runtimeReady && runtimesReported;
    lines.push({
      key: "runtime",
      // Was an English plural (`Runtimes`) AND a conditional suffix nested in one
      // template. The plural belongs to ICU; the with/without-names split is two
      // ids, because a language may not attach the list the same way.
      text: runtimeReady
        ? formatMessage(
            {
              id: runtimeNames.length
                ? "onboarding.computerRuntime.logRuntimeDetectedNamed"
                : "onboarding.computerRuntime.logRuntimeDetected",
            },
            { count: runtimeNames.length, names: runtimeNames.join(", ") },
          )
        : formatMessage({
            id: detectionFailed
              ? "onboarding.computerRuntime.logNoRuntime"
              : "onboarding.computerRuntime.logDetecting",
          }),
      done: runtimeReady,
      pending: !runtimeReady && !detectionFailed,
      failed: detectionFailed,
    });
  }

  return (
    <ol
      className="space-y-1.5 font-mono text-xs leading-5"
      aria-live="polite"
      data-testid="onboarding-connect-log"
    >
      {lines.map((line) => (
        <li
          key={line.key}
          className="flex items-start gap-2"
          data-line={line.key}
          data-state={line.done ? "done" : line.failed ? "failed" : line.pending ? "pending" : "idle"}
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {line.done ? (
              <span className="flex size-4 items-center justify-center border-2 border-black bg-brutal-lime">
                <Check size={10} strokeWidth={4} />
              </span>
            ) : line.failed ? (
              <span className="flex size-4 items-center justify-center border-2 border-black bg-brutal-orange">
                <X size={10} strokeWidth={4} />
              </span>
            ) : line.pending ? (
              <Spinner size="sm" />
            ) : null}
          </span>
          <span className={line.done || line.failed ? "font-bold text-black" : "text-black/60"}>{line.text}</span>
        </li>
      ))}
    </ol>
  );
}

// What to do, stated as instructions rather than as a progress tracker.
//
// A tracker would have to lie. Between "user runs the command" and "a computer
// row appears" the browser is blind: the device authorization is created by the
// CLI and is deliberately not bound to any user or server until the user
// approves it (see the device_authorizations schema note), so nothing tells us
// the command was ever run. The old stepper papered over that by highlighting
// step 1 from the moment the modal opened and jumping straight to step 3 on
// approval — its middle step, "go approve in your browser", could never be the
// current one, which is exactly the moment the user most needs that sentence.
// So: instructions here, and a real status below for the one intermediate state
// we can actually observe (row exists, not yet online).
function ConnectComputerInstructions({ platform }: { platform: "mac-linux" | "windows" }) {
  const { formatMessage } = useIntl();
  // Only step 1 differs by platform; steps 2 and 3 are shared ids rather than
  // two copies of the same sentence.
  const steps = [
    formatMessage({
      id: platform === "windows"
        ? "onboarding.computerRuntime.stepRunWindows"
        : "onboarding.computerRuntime.stepRunUnix",
    }),
    formatMessage({ id: "onboarding.computerRuntime.stepApprove" }),
    formatMessage({ id: "onboarding.computerRuntime.stepAppears" }),
  ];

  return (
    <ol
      className="space-y-1.5 text-xs leading-5 text-black/65"
      aria-label={formatMessage({ id: "onboarding.computerRuntime.instructionsAria" })}
      data-testid="onboarding-computer-instructions"
    >
      {steps.map((label, index) => (
        <li key={label} className="flex gap-2">
          <span
            aria-hidden="true"
            className="mt-px flex size-4 shrink-0 items-center justify-center border border-black/30 font-mono text-[9px] font-bold text-black/60"
          >
            {index + 1}
          </span>
          <span className="min-w-0">{label}</span>
        </li>
      ))}
    </ol>
  );
}


function RuntimeGroupLabel({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="border-t border-black/15 px-3.5 pb-1 pt-2.5 first:border-t-0">
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-black/45">{children}</span>
      {note ? <span className="ml-2 text-[10px] text-black/40">{note}</span> : null}
    </div>
  );
}

function RuntimeRow({
  runtime,
  computerName,
  expanded,
  onToggle,
  onCopyInstallCommand,
  quiet = false,
}: {
  runtime: ServerSetupRuntimeCatalogEntry;
  computerName: string | null;
  expanded: boolean;
  onToggle: () => void;
  onCopyInstallCommand?: (runtimeId: string, command: string) => void;
  quiet?: boolean;
}) {
  const { formatMessage } = useIntl();
  const command = RUNTIME_INSTALL_COMMANDS[runtime.id];
  // Says so where the click happened, instead of throwing a toast across the screen.
  const [copied, setCopied] = useState(false);
  return (
    <div className={`border-t border-black/10 ${expanded ? "bg-soft-signal/20" : ""}`}>
      <button
        type="button"
        className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left ${quiet ? "text-black/50" : ""}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={`flex shrink-0 items-center justify-center border-2 border-black bg-white font-mono text-[9px] font-bold ${runtime.recommended ? "size-7" : "size-6"}`}>
          {runtime.abbreviation}
        </span>
        <span className={`min-w-0 flex-1 font-bold ${runtime.recommended ? "text-[13px]" : "text-xs"}`}>
          {runtime.displayName}
        </span>
        <span className={`shrink-0 border-2 px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${runtime.detected ? "border-black bg-brutal-lime text-black" : "border-black/20 bg-white text-black/40"}`}>
          {formatMessage({
            id: runtime.detected
              ? "onboarding.computerRuntime.detected"
              : "onboarding.computerRuntime.notDetected",
          })}
        </span>
        <ChevronRight size={15} className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded ? (
        <div className="px-3.5 pb-3 pl-12 text-[11px] leading-5 text-black/65">
          {runtime.detected ? (
            <p>
              {/* Was a sentence plus a leading-space fragment concatenated in JSX.
                  Two whole messages instead: a translation cannot be expected to
                  produce a trailing clause that happens to start with a space. */}
              {formatMessage(
                {
                  id: runtime.id === "claude"
                    ? "onboarding.computerRuntime.runtimeFoundBestTested"
                    : "onboarding.computerRuntime.runtimeFound",
                },
                {
                  computer: computerName ?? formatMessage({ id: "onboarding.computerRuntime.yourComputer" }),
                  b: (chunks: ReactNode) => <strong key="b" className="text-black">{chunks}</strong>,
                },
              )}
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                {formatMessage(
                  { id: "onboarding.computerRuntime.runtimeInstallHint" },
                  {
                    runtime: runtime.displayName,
                    b: (chunks: ReactNode) => <strong key="b" className="text-black">{chunks}</strong>,
                  },
                )}
              </p>
              {command && onCopyInstallCommand ? (
                <button
                  type="button"
                  onClick={() => {
                    onCopyInstallCommand(runtime.id, command);
                    setCopied(true);
                    setClockTimeout(() => setCopied(false), 2_000);
                  }}
                  className="inline-flex items-center gap-1 font-bold text-black underline underline-offset-2"
                >
                  {copied ? <Check size={12} strokeWidth={3} /> : <Copy size={12} />}
                  {formatMessage({
                    id: copied
                      ? "onboarding.computerRuntime.copied"
                      : "onboarding.computerRuntime.copyInstallCommand",
                  })}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function OwnApiKeyRow({
  expanded,
  onToggle,
  onOpenSettings,
}: {
  expanded: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className={`border-t border-black/10 ${expanded ? "bg-soft-signal/20" : ""}`}>
      <button type="button" className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left" aria-expanded={expanded} onClick={onToggle}>
        <span className="flex size-6 shrink-0 items-center justify-center border-2 border-black bg-white">
          <KeyRound size={13} />
        </span>
        <span className="min-w-0 flex-1 text-xs font-bold">
          {formatMessage({ id: "onboarding.computerRuntime.ownApiKey" })}
        </span>
        <span className="shrink-0 border-2 border-black/20 bg-white px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-black/40">
          {formatMessage({ id: "onboarding.computerRuntime.notSet" })}
        </span>
        <ChevronRight size={15} className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-3 pl-12 text-[11px] leading-5 text-black/65">
          <p>
            {formatMessage({ id: "onboarding.computerRuntime.ownApiKeyHint" })}
          </p>
          {onOpenSettings ? (
            <button type="button" onClick={onOpenSettings} className="font-bold text-black underline underline-offset-2">
              {formatMessage({ id: "onboarding.computerRuntime.addApiKey" })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
