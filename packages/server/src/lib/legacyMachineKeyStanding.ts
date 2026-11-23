import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers } from "../db/schema";
import { getActorServerRoleInServer } from "./actorPermissions";

/**
 * Whether a legacy `sk_machine_*` key may still act (#wg-rbac:#78). The key
 * acts for the person who registered the machine (`daemons.user_id`, an
 * owner or admin when it was registered), and through it as every agent bound
 * to the machine. So it is refused once its server is deleted, and once that
 * person is no longer a member of the server (removed, left, or only a Guest
 * now). Removing a member also revokes these keys (serverService
 * executeMemberRemoval); this check covers the keys of people who left before
 * that, and any key a later rotation hands to a departed person's machine.
 *
 * Every legacy-key entry calls it: requireMachineAuth and the Computer-route
 * alias (middleware/auth.ts) and `/daemon/connect` (routes/daemon.ts).
 * A Computer key (`sk_computer_*`) is not checked here: its attacher's
 * departure revokes the Computer row itself.
 */
export type LegacyMachineKeyStanding = "live" | "server_gone" | "registrant_departed";

export async function legacyMachineKeyStanding(machine: { serverId: string; userId: string }): Promise<LegacyMachineKeyStanding> {
  const [server] = await getDb()
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, machine.serverId), isNull(servers.deletedAt)));
  if (!server) return "server_gone";
  const role = await getActorServerRoleInServer(machine.serverId, "user", machine.userId);
  if (role === null || role === "guest") return "registrant_departed";
  return "live";
}
