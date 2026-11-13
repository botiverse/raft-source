import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import { trackEvent } from "../../analytics/track";
import { checkoutErrorMessage, startProCheckout } from "../../utils/proCheckout";
import { shareableWebOrigin } from "../../utils/desktopShell";
import { ProCheckoutChoices, ProOfferPanel, useProCheckoutDraft } from "../billing/ProOffer";
import { answerSetupUpgradePrompt } from "./serverSetupProjection";
import SetupSessionFooter from "./SetupSessionFooter";
import SetupStepFrame from "./SetupStepFrame";
import LeavingRaftMark from "../ui/LeavingRaftMark";

const SURFACE = "onboarding_setup";

/**
 * The Pro offer, between the survey and the handoff, on Free servers only (the server
 * decides that). An offer, not a gate: "Maybe Later" sits
 * beside the button, and either answer retires the step for good.
 *
 * Checkout starts right here: pick yearly or monthly and the seats, and go to Stripe.
 * Stripe sends them back to the server on the public web origin (also on desktop),
 * paid or not, where setup carries on with the handoff. Never send the desktop
 * app:// page origin as a return URL; the plan turns Pro when Stripe's webhook lands.
 *
 * Two halves: the offer as a price sticker on dotted cream paper, the choices on white.
 */
export default function ServerSetupUpgradeStep({
  serverId,
  serverSlug,
  onDone,
}: {
  serverId: string;
  serverSlug: string;
  onDone: () => void;
}) {
  const { formatMessage } = useIntl();
  const draft = useProCheckoutDraft();
  const { billingInterval, seats, minimumSeats } = draft;
  const [status, setStatus] = useState<"idle" | "checkout" | "not_now">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    trackEvent("upgrade_prompt_shown", { surface: SURFACE }, { serverId });
  }, [serverId]);

  const busy = status !== "idle";

  const handleCheckout = useCallback(async () => {
    setStatus("checkout");
    setError("");
    trackEvent("upgrade_prompt_interacted", { surface: SURFACE, action: "upgrade" }, { serverId });
    let checkoutUrl: string;
    try {
      checkoutUrl = await startProCheckout({
        entry: SURFACE,
        billingInterval,
        seatQuantity: seats,
        returnUrl: `${shareableWebOrigin()}/s/${serverSlug}`,
        serverId,
        defaultSeatQuantity: minimumSeats,
      });
    } catch (checkoutError) {
      setError(checkoutErrorMessage(checkoutError, formatMessage) ?? formatMessage({ id: "layout.onboarding.proCheckoutFailed" }));
      setStatus("idle");
      return;
    }
    // Answered before leaving, so coming back from Stripe (paid or cancelled) lands on the
    // handoff. A failed write only means the step shows once more.
    try {
      await answerSetupUpgradePrompt(serverId);
    } catch {
      // fall through
    }
    window.location.href = checkoutUrl;
  }, [billingInterval, formatMessage, minimumSeats, seats, serverId, serverSlug]);
  const handleCheckoutClick = useCallback(() => {
    void handleCheckout();
  }, [handleCheckout]);

  const handleNotNow = useCallback(async () => {
    setStatus("not_now");
    trackEvent("upgrade_prompt_interacted", { surface: SURFACE, action: "not_now" }, { serverId });
    try {
      await answerSetupUpgradePrompt(serverId);
    } catch {
      // Let them through: the step comes back on the next read rather than trapping them.
    }
    onDone();
  }, [onDone, serverId]);
  const handleNotNowClick = useCallback(() => {
    void handleNotNow();
  }, [handleNotNow]);

  return (
    <SetupStepFrame
      testId="server-setup-upgrade"
      eyebrow={formatMessage({ id: "layout.onboarding.setupServerEyebrow" })}
      title={formatMessage({ id: "layout.onboarding.proTitle" })}
      hint={formatMessage({ id: "layout.onboarding.proHint" })}
      flushBody
      bodyClassName="md:grid md:h-full md:grid-cols-[0.95fr_1.05fr] md:overflow-hidden"
      footer={
        <>
          <SetupSessionFooter disabled={busy} />
          <div className="flex flex-col-reverse items-center gap-4 sm:flex-row">
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={handleNotNowClick}
              disabled={busy}
              className="w-full sm:w-auto"
              data-testid="server-setup-upgrade-not-now"
            >
              {formatMessage({ id: "layout.onboarding.proNotNow" })}
            </Button>
            <Button
              type="button"
              onClick={handleCheckoutClick}
              disabled={busy}
              loading={status === "checkout"}
              loadingLabel={formatMessage({ id: "layout.onboarding.opening" })}
              size="lg"
              variant="accent"
              className="w-full sm:w-auto"
              data-testid="server-setup-upgrade-checkout"
            >
              {formatMessage({ id: "billing.upgradeToPro" })}
              <LeavingRaftMark data-icon="inline-end" destination="stripe" />
            </Button>
          </div>
        </>
      }
    >
      <ProOfferPanel billingInterval={billingInterval} testIdPrefix="server-setup-upgrade" />
      <ProCheckoutChoices draft={draft} busy={busy} error={error} testIdPrefix="server-setup-upgrade" />
    </SetupStepFrame>
  );
}
