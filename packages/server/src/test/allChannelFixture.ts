import { and, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channels } from "../db/schema";
import { ensureAllChannelHumanRows } from "../services/allChannelMembership";

/**
 * A new server's #all is born hidden and is revealed once the server grows into
 * a team (humans + agents >= ALL_CHANNEL_TEAM_THRESHOLD). Tests that only need a
 * live #all as a precondition call this instead of seeding a whole team: it does
 * what the team-threshold reveal does (flip to `channel`, give every non-guest
 * member their row) and nothing else.
 */
export async function revealAllChannelForTest(serverId: string, db: DatabaseExecutor = getDb()) {
  await db
    .update(channels)
    .set({ type: "channel" })
    .where(and(eq(channels.serverId, serverId), eq(channels.name, "all"), eq(channels.type, "private")));
  await ensureAllChannelHumanRows(db, serverId);
}

/**
 * Shapes a freshly created server like an established one (created before the
 * onboarding opener launched): #all live and no private `onboarding-owner`
 * channel. For fixtures whose consumers exercise messaging and sidebar behavior
 * rather than onboarding, and whose expectations were written for that shape.
 */
export async function shapeEstablishedServerForTest(serverId: string, db: DatabaseExecutor = getDb()) {
  await revealAllChannelForTest(serverId, db);
  await db
    .delete(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.name, "onboarding-owner"), eq(channels.type, "private")));
}
