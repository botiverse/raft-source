import { useIntl } from "react-intl";
import { PaywallShown } from "../../analytics/paywall";
import type { Server } from "../../store/serverStore";
import Banner from "../ui/Banner";
import { limitOwnerNames, upgradesHere } from "./externalInviteAccept";
import type { ConnectableServer } from "./externalInviteAccept";

/**
 * Under the invite page's connect list, a line for each server there at the
 * free plan's one external channel (design v4 C, D): why it can't be chosen,
 * who can lift that, and what the viewer can do now. Its owner upgrades it
 * from the row's Upgrade; anyone else asks an owner (named when the server
 * says who), or goes Back to join as a guest where the invite allows one. An
 * admin an older server still offered Upgrade (it upgrades in the app, as
 * before) gets no line. Each line counts as its paywall shown.
 */
export function ConnectLimitNotes({ servers, myServer, viewerId, guest }: {
  servers: readonly ConnectableServer[];
  /** The viewer's own entry for a server (their role there). */
  myServer: (serverId: string) => Server | null;
  viewerId: string | null;
  /** The invite takes them as a guest. */
  guest: boolean;
}) {
  const { formatMessage, formatList } = useIntl();
  const notes = servers.flatMap((server) => {
    if (!server.atLimit) return [];
    const target = server.name;
    if (upgradesHere(server, myServer(server.id)?.role)) {
      return [{ server, text: formatMessage({ id: "externalInvite.connect.limitUpgrade" }, { target }) }];
    }
    if (server.canUpgrade) return [];
    const owners = limitOwnerNames(server.owners, viewerId);
    const values = { target, guest: guest ? "yes" : "no" };
    const text = owners.length > 0
      ? formatMessage({ id: "externalInvite.connect.limitAskOwnerNamed" }, { ...values, owners: formatList(owners, { type: "disjunction" }) })
      : formatMessage({ id: "externalInvite.connect.limitAskOwner" }, values);
    return [{ server, text }];
  });
  if (notes.length === 0) return null;
  return (
    <Banner intent="info" density="sm" withIcon live={false} data-testid="external-invite-connect-limit">
      {notes.map(({ server, text }) => (
        <p key={server.id}>
          {text}
          <PaywallShown gate="external_channel_free_limit" surface="external_invite_page" serverId={server.id} />
        </p>
      ))}
    </Banner>
  );
}
