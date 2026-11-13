import { Button, IconTile, ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { AuthProvider } from "../../hooks/useAuthProviders";
import { SocialProviderIcon } from "../../features/settings/account/SocialProviderIcon";

export function ProviderAccountRow({
  provider,
  identity,
  linking,
  onCancelLinking,
  onConnect,
  onRequestDisconnect,
}: {
  provider: AuthProvider;
  identity: { providerEmail: string | null } | undefined;
  linking: boolean;
  /** Raft Desktop, while the link waits for the system browser: Cancel ends it. */
  onCancelLinking?: () => void;
  onConnect: (provider: AuthProvider) => void;
  onRequestDisconnect: (provider: AuthProvider) => void;
}) {
  const { formatMessage } = useIntl();
  const handleConnect = useCallback(() => onConnect(provider), [onConnect, provider]);
  const handleRequestDisconnect = useCallback(() => onRequestDisconnect(provider), [onRequestDisconnect, provider]);

  // One row of Settings › Account › Connected accounts' ListRowGroup (DS Forms ›
  // A setting's row): the provider's tile, its name and who it is connected as,
  // then Connect or Disconnect at the row's end.
  return (
    <ListRow
      variant="plain"
      interactive={false}
      role="group"
      aria-label={formatMessage({ id: "settings.account.providerAccountAria" }, { label: provider.label })}
    >
      <IconTile>
        <SocialProviderIcon providerId={provider.id} />
      </IconTile>
      <ListRowBody>
        <ListRowTitle>{provider.label}</ListRowTitle>
        <ListRowDescription>
          {identity?.providerEmail
            ? formatMessage({ id: "settings.account.connectedAs" }, { email: identity.providerEmail })
            : formatMessage({ id: "settings.account.notConnected" })}
        </ListRowDescription>
      </ListRowBody>
      {!identity && linking && onCancelLinking && (
        <Button variant="ghost" size="md" type="button" onClick={onCancelLinking} className="shrink-0">
          {formatMessage({ id: "auth.desktopSignIn.cancelWaiting" })}
        </Button>
      )}
      {!identity && (
        <Button
          variant="outline" size="md"
          type="button"
          onClick={handleConnect}
          disabled={linking}
          className="shrink-0"
        >
          {linking ? formatMessage({ id: "settings.account.connecting" }) : formatMessage({ id: "settings.account.connect" })}
        </Button>
      )}
      {identity && (
        <Button
          variant="outline" size="md"
          type="button"
          onClick={handleRequestDisconnect}
          aria-label={formatMessage({ id: "settings.account.disconnectAria" }, { label: provider.label })}
          className="shrink-0"
        >
          {formatMessage({ id: "settings.account.disconnect" })}
        </Button>
      )}
    </ListRow>
  );
}
