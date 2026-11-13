import { Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ServerRole } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import AvatarListRow from "../ui/AvatarListRow";
import { canRemoveAdminPrincipal, getAdminPrincipalKey, getAdminPrincipalLabel, getMemberLabel } from "../../utils/serverAdminSettings";
import type { ServerAdminSettingsPrincipal } from "../../utils/serverAdminSettings";
import { renderPrincipalAvatar } from "../../features/settings/administration/renderPrincipalAvatar";

export function AdminPrincipalRow({
  admin,
  role,
  ownerCount,
  savingPrincipalKey,
  onDemote,
}: {
  admin: ServerAdminSettingsPrincipal;
  role: ServerRole | null;
  ownerCount: number;
  savingPrincipalKey: string | null;
  onDemote: (principal: ServerAdminSettingsPrincipal) => void;
}) {
  const { formatMessage } = useIntl();
  const handleDemote = useCallback(() => onDemote(admin), [admin, onDemote]);
  const canRemove = canRemoveAdminPrincipal(role, admin, ownerCount);
  const label = admin.kind === "human" ? getMemberLabel(admin, formatMessage) : getAdminPrincipalLabel(admin, formatMessage);
  const key = getAdminPrincipalKey(admin);
  const roleLabel = admin.role === "owner"
    ? formatMessage({ id: "member.roles.owner" })
    : admin.role === "admin"
      ? formatMessage({ id: "member.roles.admin" })
      : admin.role === "member"
        ? formatMessage({ id: "member.roles.member" })
        : admin.role;
  const subtitle = admin.kind === "human"
    ? admin.email ? `${admin.email} · ${roleLabel}` : roleLabel
    : formatMessage({ id: "settings.admins.agentPrefix" }, { role: roleLabel });

  return (
    <AvatarListRow
      avatar={
        // stdrc #wg-theme:7470ca2a: admin avatar pins to the
        // top of the row (so the avatar lines up with the
        // first line — the name) while the Remove button on
        // the right stays vertically centered. self-start on
        // the avatar achieves that without disrupting the
        // shared row alignment.
        renderPrincipalAvatar(admin, "list-row")
      }
      name={label}
      subtitle={subtitle}
      rightContent={
        canRemove ? (
          <Button
            variant="outline" size="md"
            type="button"
            onClick={handleDemote}
            disabled={savingPrincipalKey != null}
            className="shrink-0"
          >
            {savingPrincipalKey === key ? formatMessage({ id: "settings.common.saving" }) : admin.role === "owner" ? formatMessage({ id: "settings.admins.removeOwner" }) : formatMessage({ id: "settings.admins.removeAdmin" })}
          </Button>
        ) : (
          <span className="shrink-0 text-footnote text-foreground-hint">
            {admin.role === "owner" && ownerCount <= 1 ? formatMessage({ id: "settings.admins.lastOwner" }) : formatMessage({ id: "settings.admins.ownerOnly" })}
          </span>
        )
      }
    />
  );
}
