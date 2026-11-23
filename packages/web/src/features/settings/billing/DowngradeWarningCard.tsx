import { FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES, PLAN_CONFIG } from "@botiverse/raft-shared";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import { showsPlanDowngradeNotice } from "../../../utils/planDowngrade";

/** What going back to Free took away, for a week after it happened: the short
 *  sentence the Bell also shows, then Free's limits in full (#proj-commercial:#28).
 *  Only an owner, who can pay, is told that upgrading lifts them. */
export function DowngradeWarningCard({ server, canManageBilling }: {
  server: { name: string; plan: string; planDowngradedAt: string | null };
  canManageBilling: boolean;
}) {
  const { formatMessage, formatNumber } = useIntl();
  if (!showsPlanDowngradeNotice(server)) return null;
  const megabytes = (bytes: number) => formatMessage({ id: "common.fileSize.mb" }, { value: formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 0 }) });

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
      <p>
        {formatMessage(
          { id: "planBilling.downgraded.freeLimits" },
          { upload: megabytes(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES), perFile: megabytes(FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES) },
        )}
      </p>
    </Banner>
  );
}
