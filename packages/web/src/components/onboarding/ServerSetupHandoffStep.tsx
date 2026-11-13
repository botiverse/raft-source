import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import AvatarSlot from "../ui/AvatarSlot";
import { Button } from "@botiverse/raft-ui";
import { acknowledgeSetupHandoff } from "./serverSetupProjection";
import SetupSessionFooter from "./SetupSessionFooter";
import SetupStepFrame from "./SetupStepFrame";

/**
 * The last thing the setup gate shows: Cindy is created, and she — not this
 * wizard — carries the rest of onboarding.
 *
 * Without it the modal simply vanished and dropped the owner into an empty
 * channel with no idea that the greeting waiting there was the next step. This
 * screen exists to hand the baton over out loud.
 */
export default function ServerSetupHandoffStep({
  agentName = "Cindy",
  serverId,
  onDone,
}: {
  agentName?: string;
  serverId: string;
  onDone: () => void;
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
  const handleDone = useCallback(async () => {
    setHandingOff(true);
    try {
      await acknowledgeSetupHandoff(serverId);
    } catch {
      // fall through
    }
    onDone();
  }, [onDone, serverId]);
  const handleDoneClick = useCallback(() => {
    void handleDone();
  }, [handleDone]);
  return (
    <SetupStepFrame
      testId="server-setup-handoff"
      bodyClassName="flex flex-col items-center justify-center"
      footer={
        <>
          <SetupSessionFooter disabled={handingOff} />
          <Button
            type="button"
            onClick={handleDoneClick}
            disabled={handingOff}
            size="lg"
            variant="accent"
            className="w-full sm:w-auto"
            data-testid="server-setup-handoff-done"
          >
            {handingOff
              ? formatMessage({ id: "layout.onboarding.starting" })
              : formatMessage({ id: "layout.onboarding.letsGo" })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center text-center">
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
          {formatMessage({ id: "layout.onboarding.handoffTitle" }, { agentName })}
        </h1>
        {/* text-balance so the last line can never be left holding a single orphan word
            ("real." on a line of its own, @Artea). The browser evens the lines out instead of
            filling greedily and dumping the remainder. Fixed here and not in the copy: the
            sentence was never wrong, and a container that only fits THIS wording would strand
            the next one (@Cat owns the copy contract; @Josh called the same fix). */}
        <p className="mt-3 max-w-[42ch] text-balance text-subhead text-foreground-muted">
          {formatMessage({ id: "layout.onboarding.handoffBody" }, { agentName })}
        </p>

      </div>
    </SetupStepFrame>
  );
}
