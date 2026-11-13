import { Checkbox } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";

/**
 * RFC 075 §4.5: shown when the inviter is inviting themselves on a server
 * they administer. The connection is made directly, so it must be confirmed
 * explicitly before the invite is submitted.
 */
export function SameAdminJointNotice({
  sourceServerName,
  targetServerName,
  confirmed,
  onConfirmedChange,
  disabled,
}: {
  sourceServerName: string;
  targetServerName: string;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <Banner intent="info" className="stack-y-2" data-testid="joint-same-admin-notice">
      <p>
        {formatMessage(
          { id: "channel.jointInvite.sameAdmin.notice" },
          { source: sourceServerName, target: targetServerName },
        )}
      </p>
      <label className="flex items-start gap-2 text-callout font-semibold">
        <Checkbox
          checked={confirmed}
          disabled={disabled}
          onCheckedChange={onConfirmedChange}
        />
        <span>{formatMessage({ id: "channel.jointInvite.sameAdmin.confirm" })}</span>
      </label>
    </Banner>
  );
}
