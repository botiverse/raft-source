import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { serverMembers, servers } from "../db/schema";

/**
 * Projection-only server-wide setup completion, derived from the durable rows we already have.
 *
 * `server_members.setup_status` records which owner actually ran the flow, but setup is
 * not owed once per owner: one completed owner completes the server for every owner.
 * Neither onboarding-agent pointer is read: the greeter (`onboarding_agent_id`) is any agent
 * an admin picks, and servers whose official Cindy was their only completion record were
 * given owner rows by the migration that split the two (official_onboarding_agent).
 *
 * This is deliberately separate from the reset-safety question. Do not use this projection
 * predicate to authorize destructive reset. Reset keeps its own independently named guard;
 * changing either contract requires separate product and permission review.
 */
export async function hasServerCompletedSetupForProjection(
  db: DatabaseExecutor,
  serverId: string,
): Promise<boolean> {
  const [server] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!server) return false;

  // Do not filter by the member's current role. Completion is monotonic: an owner who
  // completed setup may later be demoted without making the server incomplete again.
  const [completedMembership] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.setupStatus, "complete"),
    ))
    .limit(1);

  return Boolean(completedMembership);
}
