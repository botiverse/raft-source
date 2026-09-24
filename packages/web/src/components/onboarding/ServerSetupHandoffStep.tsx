import { useState } from "react";
import { useIntl } from "react-intl";
import PixelAvatar from "../agent/PixelAvatar";
import Button from "../ui/Button";
import { acknowledgeSetupHandoff } from "./serverSetupProjection";
import SetupSessionFooter from "./SetupSessionFooter";

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
  const handleDone = async () => {
    setHandingOff(true);
    try {
      await acknowledgeSetupHandoff(serverId);
    } catch {
      // fall through
    }
    onDone();
  };
  return (
    <section
      className="flex w-full max-w-[560px] flex-col overflow-hidden border-2 border-black bg-white shadow-brutal"
      data-testid="server-setup-handoff"
    >
      <div className="flex flex-col items-center px-8 pb-7 pt-9 text-center">
        <div className="relative mb-6">
          <span
            className="onboarding-cindy-pop-mark absolute -right-5 top-1 size-3 rotate-12 border-2 border-black bg-brutal-lime"
            aria-hidden="true"
          />
          <span
            className="onboarding-cindy-pop-mark absolute -left-5 top-8 size-2.5 -rotate-12 border-2 border-black bg-soft-signal [animation-delay:70ms]"
            aria-hidden="true"
          />
          <PixelAvatar
            avatarKey="mug"
            size={104}
            className="onboarding-cindy-entrance relative z-10 border-2 border-black shadow-brutal-lg"
          />
        </div>

        <h1 className="text-2xl font-black tracking-normal">
          {formatMessage({ id: "layout.onboarding.handoffTitle" }, { agentName })}
        </h1>
        {/* text-balance so the last line can never be left holding a single orphan word
            ("real." on a line of its own, @Artea). The browser evens the lines out instead of
            filling greedily and dumping the remainder. Fixed here and not in the copy: the
            sentence was never wrong, and a container that only fits THIS wording would strand
            the next one (@Cat owns the copy contract; @Josh called the same fix). */}
        <p className="mt-3 max-w-[42ch] text-balance text-base leading-relaxed text-black/70">
          {formatMessage({ id: "layout.onboarding.handoffBody" }, { agentName })}
        </p>

      </div>

      <div className="flex flex-col-reverse gap-3 border-t-2 border-black px-8 py-4 sm:flex-row sm:items-center sm:justify-between">
        <SetupSessionFooter disabled={handingOff} />
        <Button
          type="button"
          onClick={() => void handleDone()}
          disabled={handingOff}
          size="lg"
          tone="pink"
          className="w-full sm:w-auto"
          data-testid="server-setup-handoff-done"
        >
          {handingOff
            ? formatMessage({ id: "layout.onboarding.starting" })
            : formatMessage({ id: "layout.onboarding.letsGo" })}
        </Button>
      </div>
    </section>
  );
}
