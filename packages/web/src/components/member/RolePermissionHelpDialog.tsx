import { Card } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import DialogCard from "../ui/DialogCard";

type RoleHelpRow = {
  roleId: MessageId;
  summaryId: MessageId;
  detailsId: MessageId;
};

const HUMAN_ROWS: RoleHelpRow[] = [
  {
    roleId: "member.roles.owner",
    summaryId: "member.roles.help.ownerSummary",
    detailsId: "member.roles.help.ownerDetails",
  },
  {
    roleId: "member.roles.admin",
    summaryId: "member.roles.help.adminSummary",
    detailsId: "member.roles.help.humanAdminDetails",
  },
  {
    roleId: "member.roles.member",
    summaryId: "member.roles.help.memberSummary",
    detailsId: "member.roles.help.humanMemberDetails",
  },
];

const AGENT_ROWS: RoleHelpRow[] = [
  {
    roleId: "member.roles.admin",
    summaryId: "member.roles.help.adminSummary",
    detailsId: "member.roles.help.agentAdminDetails",
  },
  {
    roleId: "member.roles.member",
    summaryId: "member.roles.help.memberSummary",
    detailsId: "member.roles.help.agentMemberDetails",
  },
];

export default function RolePermissionHelpDialog({
  subject,
  onClose,
}: {
  subject: "human" | "agent";
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const rows = subject === "agent" ? AGENT_ROWS : HUMAN_ROWS;

  return (
    <DialogCard
      title={formatMessage({
        id: subject === "agent" ? "member.roles.help.agentRoles" : "member.roles.help.humanRoles",
      })}
      onClose={onClose}
      closeOnBackdrop
    >
        <div className="stack-y-2">
          {rows.map((row) => (
            <Card key={row.roleId} className="p-3">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="text-subhead font-bold text-foreground">{formatMessage({ id: row.roleId })}</div>
                <div className="text-footnote font-semibold text-foreground-hint">
                  {formatMessage({ id: row.summaryId })}
                </div>
              </div>
              <p className="text-callout text-foreground-muted">
                {formatMessage({ id: row.detailsId })}
              </p>
            </Card>
          ))}
        </div>
    </DialogCard>
  );
}
