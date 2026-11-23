import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import AvatarSlot from "../ui/AvatarSlot";
import { Button } from "@botiverse/raft-ui";
import { LogIn } from "lucide-react";
import { acknowledgeSetupHandoff } from "./serverSetupProjection";
import SetupSessionFooter from "./SetupSessionFooter";
import SetupStepFrame from "./SetupStepFrame";
import { FirstAgentStartFailureNotice } from "./FirstAgentStartFailureNotice";
import { useFirstAgentStartFailure } from "./useFirstAgentStartFailure";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { useAgentCurrentActivityState, useAgentStore } from "../../store/agentStore";
import { useOnboardingAgentWatch } from "./useOnboardingAgentWatch";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";

/**
 * The last thing the setup gate shows: Cindy is created, and she — not this
 * wizard — carries the rest of onboarding.
 *
 * Without it the modal simply vanished and dropped the owner into an empty
 * channel with no idea that the greeting waiting there was the next step. This
 * screen exists to hand the baton over out loud.
 *
 * It is also where setup waits on her first start: when she could not start
 * (mail #214), it says so with the next step (FirstAgentStartFailureNotice)
 * rather than promise a greeting that is not coming.
 */
export default function ServerSetupHandoffStep({
  agentName: fallbackAgentName = "Cindy",
  serverId,
  onDone,
  onOpenAgent,
  pollAgent = false,
  runtimeAuthClient,
}: {
  agentName?: string;
  serverId: string;
  /** Resolves false when the step could not be re-read, so it stays up: the press can be retried. */
  onDone: () => void | Promise<boolean | void>;
  /** Opens the agent's profile, for Switch runtime. The gate leaves it out on the dedicated native page, which never opens the app. */
  onOpenAgent?: (agentId: string) => void;
  /** The dedicated native page: no app shell carries live agent pushes there, so re-read her while this shows. */
  pollAgent?: boolean;
  /** Tests only: the runtime-auth client. */
  runtimeAuthClient?: RuntimeAuthClient;
}) {
  const [handingOff, setHandingOff] = useState(false);
  // Display-language (react-intl) — layout namespace. "Let's Go" is the one
  // string the deleted OwnerOnboardingModal handed to this successor step, so
  // it keeps the catalog id the copy was reviewed under.
  const { formatMessage } = useIntl();

  // This click is the handoff, and it is recorded as such: the server stamps the owner's
  // acknowledgment first, then briefs Cindy best-effort. It used to piggyback on a profile
  // PATCH and let the briefing's delivery timestamp stand in for the click — so a briefing
  // that could not be delivered (agent still booting) left this button on "Starting…"
  // forever, and reopening in another browser forgot the click entirely.
  //
  // If the call fails we still let them through: a door that will not open is worse than a
  // handoff we record on the next attempt.
  //
  // Once only: a double click, a held Enter (raft-ui's TextLink repeats it, as a native button
  // does) or Let's Go then Switch runtime in the same moment would otherwise each run it.
  // `handingOff` only disables the button after a render; the ref holds from the first call.
  // Resolves true for the call that ran it, false for one that was ignored. A failed call is
  // not recorded, and a failed re-read keeps the stale state: either way the step stays up, so
  // clear both, and the next press tries again.
  const handingOffRef = useRef(false);
  const handleDone = useCallback(async () => {
    if (handingOffRef.current) return false;
    handingOffRef.current = true;
    setHandingOff(true);
    let failed = false;
    try {
      await acknowledgeSetupHandoff(serverId);
    } catch {
      failed = true;
    }
    const refreshed = await onDone();
    if (failed || refreshed === false) {
      handingOffRef.current = false;
      setHandingOff(false);
    }
    return true;
  }, [onDone, serverId]);
  const handleDoneClick = useCallback(() => {
    void handleDone();
  }, [handleDone]);
  // The server's official onboarding agent (CreateAgentDialog records it on create), watched while this step shows.
  const agentId = useServerStore((s) => s.servers.find((server) => server.id === serverId)?.officialOnboardingAgentId
    ?? (s.current?.id === serverId ? s.current.officialOnboardingAgentId : null)) ?? "";
  const agent = useAgentStore((s) => s.agents.find((candidate) => candidate.id === agentId && !candidate.deletedAt));
  // Loaded here too: the native page has no app shell that loads the agent list.
  useOnboardingAgentWatch(agentId, pollAgent);
  const activity = useAgentCurrentActivityState(agentId);
  const computerName = useMachineStore((s) => s.machines.find((machine) => machine.id === agent?.machineId)?.name)
    ?? formatMessage({ id: "onboarding.computerRuntime.yourComputer" });
  const agentName = agent ? agent.displayName || agent.name : fallbackAgentName;
  // Her runtime is changed on her profile: finish setup there.
  const switchRuntime = useCallback(() => {
    void handleDone().then((ran) => {
      if (ran) onOpenAgent?.(agentId);
    });
  }, [agentId, handleDone, onOpenAgent]);
  const startAgain = useCallback(() => {
    if (agentId) void useAgentStore.getState().startAgent(agentId).catch(() => undefined);
  }, [agentId]);
  const start = useFirstAgentStartFailure({ serverId, agent, activity, onSignedIn: startAgain, client: runtimeAuthClient });
  // "She is waiting in your channel" is not true of an agent that could not start.
  const startFailed = start.failed;
  // She could not start: the next step is the page's pink button (Cat; never a button in the card,
  // Raft DS Banner). Sign in where it can be offered, else another runtime where her profile can
  // be opened; with neither (the native page, a Computer that can't sign in from here) none.
  const primaryAction = !startFailed ? null
    : start.canSignIn
      ? { signIn: true, testId: "first-agent-failed-sign-in", label: formatMessage({ id: "onboarding.firstAgentFailed.signInAction" }, { runtime: start.runtimeName }), icon: <LogIn size={16} aria-hidden="true" /> }
      : !start.signInNext && onOpenAgent
        ? { signIn: false, testId: "first-agent-failed-switch-runtime-action", label: formatMessage({ id: "onboarding.firstAgentFailed.switchRuntimeAction" }), icon: null }
        : null;
  return (
    <SetupStepFrame
      testId="server-setup-handoff"
      bodyClassName="flex flex-col items-center justify-center"
      footer={
        <>
          <SetupSessionFooter disabled={handingOff} />
          {/* The pink action last: at the far right from sm, on top on a phone (column-reverse),
              with Switch server under both (the frame's own column-reverse). */}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center" data-testid="server-setup-handoff-actions">
            <Button
              type="button"
              onClick={handleDoneClick}
              disabled={handingOff}
              size="lg"
              // She could not start: this only skips past the next step (it still finishes setup
              // and enters the server), so it is the secondary button (Cat).
              variant={startFailed ? "default" : "accent"}
              className="w-full sm:w-auto"
              data-testid="server-setup-handoff-done"
            >
              {handingOff
                ? formatMessage({ id: "layout.onboarding.starting" })
                : formatMessage({ id: startFailed ? "layout.onboarding.skipForNow" : "layout.onboarding.letsGo" })}
            </Button>
            {primaryAction ? (
              <Button type="button" onClick={primaryAction.signIn ? start.openSignIn : switchRuntime} disabled={handingOff} size="lg" variant="accent" className="w-full sm:w-auto" data-testid={primaryAction.testId}>
                {primaryAction.icon}
                {primaryAction.label}
              </Button>
            ) : null}
          </div>
          {start.signInDialog}
        </>
      }
    >
      <div className="flex w-full flex-col items-center text-center">
        <div className="relative mb-6">
          <span
            className="onboarding-cindy-pop-mark absolute -right-5 top-1 size-3 rotate-12 rounded-[2px] border-[1.5px] border-sticker-ink bg-success"
            aria-hidden="true"
          />
          <span
            className="onboarding-cindy-pop-mark absolute -left-5 top-8 size-2.5 -rotate-12 rounded-[2px] border-[1.5px] border-sticker-ink bg-brand [animation-delay:70ms]"
            aria-hidden="true"
          />
          <AvatarSlot
            context="profile-hero"
            type="agent"
            agentAvatarUrl="pixel:mug"
            className="onboarding-cindy-entrance z-raised"
          />
        </div>

        <h1 className="text-title text-foreground sm:text-display">
          {/* She could not start: not "takes it from here" yet, one more step first (Cat). */}
          {startFailed
            ? formatMessage({ id: "layout.onboarding.handoffTitleStartFailed" })
            : formatMessage({ id: "layout.onboarding.handoffTitle" }, { agentName })}
        </h1>
        {/* text-balance so the last line can never be left holding a single orphan word
            ("real." on a line of its own, @Artea). The browser evens the lines out instead of
            filling greedily and dumping the remainder. Fixed here and not in the copy: the
            sentence was never wrong, and a container that only fits THIS wording would strand
            the next one (@Cat owns the copy contract; @Josh called the same fix). */}
        {startFailed ? null : (
          <p className="mt-3 max-w-[42ch] text-balance text-subhead text-foreground-muted">
            {formatMessage({ id: "layout.onboarding.handoffBody" }, { agentName })}
          </p>
        )}
        {startFailed ? (
          <div className="mt-6 w-full max-w-[520px] text-left">
            <FirstAgentStartFailureNotice start={start} computerName={computerName} onSwitchRuntime={onOpenAgent ? switchRuntime : undefined} />
          </div>
        ) : null}

      </div>
    </SetupStepFrame>
  );
}
