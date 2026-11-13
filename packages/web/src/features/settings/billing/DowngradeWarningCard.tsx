import { PLAN_CONFIG } from "@botiverse/raft-shared";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import { showsPlanDowngradeNotice } from "../../../utils/planDowngrade";

/** What going back to Free took away, for a week after it happened. Only an
 *  owner, who can pay, is told that upgrading brings it back. */
export function DowngradeWarningCard({ server, canManageBilling }: {
  server: { name: string; plan: string; planDowngradedAt: string | null };
  canManageBilling: boolean;
}) {
  const { formatMessage } = useIntl();
  if (!showsPlanDowngradeNotice(server)) return null;

  return (
    // What changed, not an emergency: the orange warning banner (red is only
    // for what cannot be undone).
    <Banner
      intent="warning"
      withIcon
      className="mb-4"
      title={formatMessage({ id: "billing.downgraded.title" }, { server: server.name })}
    >
      <p>
        {formatMessage(
          { id: canManageBilling ? "billing.downgraded.whatChangedUpgrade" : "billing.downgraded.whatChanged" },
          { days: PLAN_CONFIG.free.limits.messageHistoryDays },
        )}
      </p>
    </Banner>
  );
}
