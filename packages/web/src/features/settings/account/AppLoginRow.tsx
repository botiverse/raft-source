import { Button, ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import AvatarSlot from "../../../components/ui/AvatarSlot";
import { initialsForApp } from "../../login-with-raft/appInitials";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import type { AppLogin } from "./appLoginsApi";

/** One App the person signed in to with Raft, a row of the section's ListRowGroup: logo, name, when, and Revoke. */
export function AppLoginRow({ login, onRevoke, revokeRef }: {
  login: AppLogin;
  onRevoke: (login: AppLogin) => void;
  /** The row's Revoke button, so the list can move focus to it after another row goes. */
  revokeRef?: (clientId: string, button: HTMLButtonElement | null) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const handleRevoke = useCallback(() => onRevoke(login), [login, onRevoke]);
  const { clientId } = login;
  const handleRevokeRef = useCallback((button: HTMLButtonElement | null) => revokeRef?.(clientId, button), [clientId, revokeRef]);
  return (
    <ListRow
      variant="plain"
      interactive={false}
      role="group"
      aria-label={login.name}
      data-testid={`app-login-row-${login.clientId}`}
    >
      <AvatarSlot context="list-row" type="app" appAvatarUrl={login.logoUrl} appInitials={initialsForApp(login.name)} />
      <ListRowBody>
        <ListRowTitle>{login.name}</ListRowTitle>
        <ListRowDescription>
          {formatMessage({ id: "settings.account.appLogins.signedIn" }, { date: formatCompactDate(login.grantedAt) })}
        </ListRowDescription>
      </ListRowBody>
      <Button
        variant="outline"
        size="md"
        type="button"
        ref={handleRevokeRef}
        onClick={handleRevoke}
        className="shrink-0"
        data-testid={`app-login-revoke-${login.clientId}`}
      >
        {formatMessage({ id: "settings.account.appLogins.revoke" })}
      </Button>
    </ListRow>
  );
}
