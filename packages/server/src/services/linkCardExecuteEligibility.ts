// Which Apps' card buttons may call their action endpoint on a Server
// (RFC 076 §4, §17).
//
// An approved official App with an approved action endpoint in force (§4), on
// any Server. Any other App (§17), only on a Server where it is actively
// installed, its registration not suspended and an action endpoint in force,
// decided by that installation's row:
// - its own Server, for a server_local App: on by default; someone with
//   manageIntegrations there may switch it off (`actions_off_at`). It follows
//   the App's endpoint changes.
// - any other Server (or a shared or published App on its own): only while
//   the endpoint in force is exactly the one someone with manageIntegrations
//   there allowed (`allowed_action_endpoint`). A change drops it to links
//   until allowed again or reverted.
// Nothing here was reviewed by the platform, so it acts only where the people
// who allowed it are accountable, and it is told to clients as
// `reviewed: false`.
//
// The read's button tier, execute's live check and execute's commit-time lock
// (installation row FOR SHARE) all decide the non-official half with
// unreviewedActionsBasis, each on the rows as they are at that moment
// (linkCardReadService, linkCardLiveState, messageCardActionService). A
// switch-off, a withdrawal, an uninstall or a suspension takes effect for
// cards already shown.

/** What the rule reads: the App, its registration, and its installation on the Server deciding. */
export type UnreviewedActionsInput = {
  app: { serverId: string; appType: "server_local" | "slock_builtin" | "third_party_global" };
  config: { actionEndpoint: string | null; suspendedAt: Date | null };
  installation: { allowedActionEndpoint: string | null; actionsOffAt: Date | null };
};

/** Why an App that is not official may act on a Server: its own Server's default, or this Server's allow. */
export type UnreviewedActionsBasis = "own_server" | "allowed";

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether `serverId` is a server_local App's own Server: where its card buttons are on unless switched off. */
export function isOwnServerOfLocalApp(app: UnreviewedActionsInput["app"], serverId: string): boolean {
  return app.appType === "server_local" && sameId(app.serverId, serverId);
}

/**
 * On which basis a card of this App, read or acted on from `serverId` (the
 * viewer's Server, from the session; `installation` is the App's row there),
 * may call its action endpoint under §17, or null. Says nothing about
 * official Apps (§4 decides those).
 */
export function unreviewedActionsBasis(entry: UnreviewedActionsInput, serverId: string): UnreviewedActionsBasis | null {
  const { actionEndpoint, suspendedAt } = entry.config;
  if (actionEndpoint === null || suspendedAt !== null) return null;
  if (isOwnServerOfLocalApp(entry.app, serverId)) return entry.installation.actionsOffAt === null ? "own_server" : null;
  return entry.installation.allowedActionEndpoint === actionEndpoint ? "allowed" : null;
}
