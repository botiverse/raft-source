import { useCallback } from "react";
import { useIntl } from "react-intl";
import { PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { usePaywallShown } from "../../analytics/paywall";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import { TextLink } from "@botiverse/raft-ui";

/**
 * Plan message-history cutoff notice ("Message history is limited to N days on
 * the Free plan") with an Upgrade link to the upgrade dialog. Shared by the channel list and the
 * thread panel: a thread whose replies all sit behind the cutoff must show this
 * notice, never "No replies yet" (task #14).
 */
export default function HistoryLimitBanner({ target = false }: {
  /** The user opened a specific message (search hit / permalink) that the cutoff hides. */
  target?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const upgrade = usePaywallUpgrade();
  const openUpgrade = useCallback(() => upgrade("history_30d", "conversation"), [upgrade]);
  usePaywallShown("history_30d", "conversation");
  const plan = (billing?.plan || server?.plan || "free") as ServerPlan;
  const days = getEffectiveLimits(plan).messageHistoryDays;

  return (
    <Banner intent="warning" density="sm" className="mx-auto mb-3 max-w-md justify-center text-center" data-testid={target ? "history-limit-target-banner" : "history-limit-banner"}>
      {formatMessage(
        { id: target ? "message.chatPanel.messageBeyondHistory" : "message.chatPanel.historyLimit" },
        { days, plan: PLAN_CONFIG[plan].displayName },
      )}
      <TextLink
        onClick={openUpgrade}
        variant="strong"
        className="ml-1"
        data-testid="history-limit-upgrade"
      >
        {formatMessage({ id: "billing.upgradeToPro" })}
      </TextLink>
    </Banner>
  );
}
