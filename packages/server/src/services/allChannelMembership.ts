// #all membership rows (#triage:64b44a12). Kept apart from channelService so the
// server- and agent-lifecycle services can call it without importing that module.
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { channelHumans, channels, messages, serverMembers } from "../db/schema";
import { raiseReadPositionForJoin } from "./readMutationSequencer";
import { assertJointUsersLocked } from "./jointHumanMembershipMirror";

const SYSTEM_ALL_CHANNEL_KEY = "all";

/**
 * People a reveal/repair of #all would insert, including while it is hidden.
 * Invite admission guesses these before its first lock, locks their users
 * rows first, and checks the actual missing set again when writing below.
 * Existing rows need no new FK check and no extra users lock.
 */
export async function missingAllChannelHumanUserIds(executor: DatabaseExecutor, serverId: string): Promise<string[]> {
  const rows = await executor.select({ userId: serverMembers.userId })
    .from(serverMembers)
    .innerJoin(channels, and(
      eq(channels.serverId, serverMembers.serverId),
      eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
      inArray(channels.type, ["channel", "private"]),
      isNull(channels.deletedAt),
    ))
    .leftJoin(channelHumans, and(eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, serverMembers.userId)))
    .where(and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest"), isNull(channelHumans.userId)));
  return rows.map(row => row.userId);
}

/**
 * Gives every non-guest human member of the server a `channel_humans` row in
 * the server's #all while it is enabled (#triage:64b44a12). #all's audience is
 * the server's members (#3054), but both inbox read paths (Postgres inline and
 * the RisingWave subscriptions) build subscriptions from `channel_humans`, so a
 * member without a row only ever saw #all as an outsider: no unread, mentions as
 * bare outsider rows. Rows are written only while #all is enabled (a hidden #all
 * keeps none: several surfaces list a private channel to anyone holding a row,
 * and hiding #all already deletes them). Guests get none (#all excludes them),
 * agents none (Tenny: a separate product decision). Idempotent.
 *
 * A new row starts its read position at the latest message, like any join.
 * `userIds` limits it to those members; omitted, it covers everyone (#all just
 * became enabled). Returns the users that got a row.
 */
export async function ensureAllChannelHumanRows(
  executor: DatabaseExecutor,
  serverId: string,
  opts: { userIds?: readonly string[]; lockedUserIds?: ReadonlySet<string> } = {},
): Promise<string[]> {
  if (opts.userIds && opts.userIds.length === 0) return [];
  const [allChannel] = await executor
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
      eq(channels.type, "channel"),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!allChannel) return [];
  const members = await executor
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .leftJoin(channelHumans, and(eq(channelHumans.channelId, allChannel.id), eq(channelHumans.userId, serverMembers.userId)))
    .where(and(
      eq(serverMembers.serverId, serverId),
      ne(serverMembers.role, "guest"),
      isNull(channelHumans.userId),
      ...(opts.userIds ? [inArray(serverMembers.userId, [...opts.userIds])] : []),
    ));
  if (members.length === 0) return [];
  // The set may grow between the unlocked guess and this admission. Restart
  // its transaction rather than acquire a new users FK lock after the Server.
  if (opts.lockedUserIds) assertJointUsersLocked(opts.lockedUserIds, members.map(member => member.userId));
  const inserted = await executor
    .insert(channelHumans)
    .values(members.map((member) => ({ channelId: allChannel.id, userId: member.userId })))
    .onConflictDoNothing()
    .returning({ userId: channelHumans.userId });
  if (inserted.length === 0) return [];
  const [latest] = await executor
    .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::int` })
    .from(messages)
    .where(eq(messages.channelId, allChannel.id));
  for (const row of inserted) {
    await raiseReadPositionForJoin(executor, "human", row.userId, allChannel.id, latest?.seq ?? 0);
  }
  return inserted.map((row) => row.userId);
}
