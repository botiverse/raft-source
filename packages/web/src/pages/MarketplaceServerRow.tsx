import AvatarListRow from "../components/ui/AvatarListRow";
import AvatarSlot from "../components/ui/AvatarSlot";
import { Badge, Spinner } from "@botiverse/raft-ui";
import type { Server } from "../store/serverStore";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { AvailableServerClient } from "../features/login-with-raft/loginClientSummary";

export function MarketplaceServerRow({
  server,
  entry,
  selected,
  installPending,
  installInFlight,
  onSelect,
}: {
  server: Server;
  entry: AvailableServerClient | undefined;
  selected: boolean;
  /** This row's server is the one being installed into. */
  installPending: boolean;
  /** Any install is in flight; rows are locked until it settles. */
  installInFlight: boolean;
  onSelect: (serverId: string) => void;
}) {
  const { formatMessage } = useIntl();
  // Installed but suspended there: unavailable, with the reason.
  const suspended = entry?.client.availability === "suspended";
  const installed = entry != null && !suspended && entry.client.availability !== "install_required";
  const canInstall = entry?.client.installation?.canInstall === true;
  const rowTitle = formatMessage({ id: installed
    ? "pages.humanLogin.serverInstalledReady"
    : suspended
      ? "pages.humanLogin.installationSuspended"
      : canInstall
        ? "pages.humanLogin.serverNotInstalledCanInstall"
        : entry
          ? "pages.humanLogin.serverNotInstalledAskAdmin"
          : "pages.humanLogin.serverStatusUnavailable" });
  const serverId = server.id;
  const handleClick = useCallback(() => onSelect(serverId), [onSelect, serverId]);
  const ariaLabel = `${formatMessage({ id: "pages.humanLogin.useThisServer" })}: ${server.name}`;
  const buttonProps = useMemo(() => ({
    "data-testid": `login-server-status-${serverId}`,
    disabled: installInFlight,
    "aria-pressed": selected,
    "aria-disabled": installInFlight,
    "aria-label": ariaLabel,
    title: rowTitle,
  }), [ariaLabel, installInFlight, rowTitle, selected, serverId]);
  // Raft Design System › ListRow (raft-ui, through AvatarListRow): one row of
  // the server list's inset card, the picked server in cyan-soft. While an
  // install is in flight every row is disabled, and a disabled row greys its
  // words without a fill.
  return (
    <AvatarListRow
      avatar={(
        <AvatarSlot
          context="list-row"
          type="server"
          serverAvatarUrl={server.avatarUrl}
          serverInitial={server.name.slice(0, 1)}
        />
      )}
      name={server.name}
      subtitle={server.slug}
      rightContent={installPending ? (
        <Spinner
          size="sm"
          aria-hidden="true"
          data-testid="marketplace-install-pending-row-spinner"
        />
      ) : !installed ? (
        <Badge variant="muted" appearance="soft">
          {formatMessage({ id: !entry
            ? "pages.humanLogin.serverUnavailableCompact"
            : suspended
              ? "pages.humanLogin.suspendedCompact"
              : canInstall
                ? "pages.humanLogin.notInstalledCompact"
                : "pages.humanLogin.adminNeededCompact" })}
        </Badge>
      ) : null}
      selected={selected}
      onClick={handleClick}
      buttonProps={buttonProps}
    />
  );
}
