// Which Apps' link cards may call their action endpoint (RFC 076 §4, §17).
//
// Two ways in. An approved official App with an approved action endpoint in
// force (§4), on any Server. Or (§17) a server_local App (not published, not
// built in), only on its own Server, while the endpoint in force is exactly
// the one a person with manageIntegrations there confirmed and the
// registration is not suspended.
// Nothing here was reviewed by the platform, so it acts only where the people
// who confirmed it are accountable: a viewer on another Server (a joint
// channel) gets navigate buttons only.
//
// The read's button tier, execute's live check and execute's commit-time lock
// all decide the own-Server half with ownServerActionsInForce, each on the
// registration as it is at that moment (linkCardReadService,
// linkCardLiveState). A withdrawal or a suspension takes effect for cards
// already shown.

/** What the own-Server rule reads from a registered App. */
export type OwnServerActionsInput = {
  app: { serverId: string; appType: "server_local" | "slock_builtin" | "third_party_global" };
  config: { actionEndpoint: string | null; ownServerActionEndpoint: string | null; suspendedAt: Date | null };
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether a card of this App, read or acted on from `serverId` (the viewer's
 * Server, from the session), may call its action endpoint under §17: a
 * server_local App, on its own Server, an endpoint in force equal to the
 * confirmed one, not suspended.
 * Says nothing about official Apps (§4 decides those).
 */
export function ownServerActionsInForce(entry: OwnServerActionsInput, serverId: string): boolean {
  const { actionEndpoint, ownServerActionEndpoint, suspendedAt } = entry.config;
  return entry.app.appType === "server_local"
    && sameId(entry.app.serverId, serverId)
    && actionEndpoint !== null
    && ownServerActionEndpoint === actionEndpoint
    && suspendedAt === null;
}
