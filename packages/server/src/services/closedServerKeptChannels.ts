// What the closed-server purge keeps of a server (closedServerPurgeDelete.ts:
// the channel step skips `all`, the apps are told `apps`). One rule for the
// purge and for what of a closed server is still read: platform/visibility
// closedServerJointObjects asks keptChannelsOf too (an app object homed in
// `apps` is kept, and read by a joint's live servers), so the two never drift.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { agentMigrationReceiptChannels, channels, jointChannels, jointChannelServers } from "../db/schema";
import { uuidArray } from "./visibilityService";

/**
 * The channels the purge keeps (header): roots by why, and every kept channel
 * of the server (roots, `joint` channels, what is under them: `all`, what the
 * channel step skips and the finish's row deletes keep). `apps`: what the
 * apps are told (keepChannelIds), `all` without the server's copies of the
 * joints it has left (and what is under them), and the storage channels of
 * every joint the server is still in (a projection of
 * KEPT_STORAGE_PROJECTION_STATUSES), and what is under them: the joint's
 * messages there are another server's (joint_storage) and stay, so an app
 * object of the server homed there stays with them (Tenny, 2026-11: the server's Artifacts in a joint follow its
 * messages there). Only for the apps: a finish row naming a storage channel
 * is still the closed server's own (a read cursor, a pref) and goes.
 */
export interface KeptChannels {
  joint: ReadonlySet<string>;
  receipt: ReadonlySet<string>;
  all: string[];
  apps: string[];
}

/**
 * The projection statuses whose joint's storage channel the apps keep
 * (KeptChannels.apps): only a joint the server is still in (Tenny,
 * 2026-11); one it has disconnected from is purged as before.
 */
export const KEPT_STORAGE_PROJECTION_STATUSES = ["active"] as const satisfies ReadonlyArray<typeof jointChannelServers.$inferSelect.status>;

export async function keptChannelsOf(tx: DatabaseExecutor, serverId: ServerId): Promise<KeptChannels> {
  const projections = await tx.select({ id: jointChannelServers.localChannelId, status: jointChannelServers.status }).from(jointChannelServers)
    .where(eq(jointChannelServers.serverId, serverId));
  const joint = projections.map((row) => row.id);
  const receipt = (await tx.select({ id: agentMigrationReceiptChannels.channelId }).from(agentMigrationReceiptChannels)
    .where(eq(agentMigrationReceiptChannels.serverId, serverId))).map((row) => row.id);
  const canonical = (await tx.select({ id: jointChannels.canonicalChannelId }).from(jointChannels)
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(eq(channels.serverId, serverId))).map((row) => row.id);
  const roots = [...new Set([...joint, ...canonical, ...receipt])];
  // closedServerPurgeDelete.ts isKept's rule as one query: a `joint` channel, a root, or a channel under a root.
  const all = (await tx.select({ id: channels.id }).from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      roots.length > 0
        ? or(eq(channels.type, "joint"), inArray(channels.id, roots), inArray(channels.parentChannelId, roots))
        : eq(channels.type, "joint"),
    ))).map((row) => row.id);
  // The storage channels of the server's joints, wherever they are: its projections (idx_joint_channel_servers_server)
  // to their joint by key. A joint's creator has a projection too (channelService createJointChannel), and so has
  // every server in a joint thread or task conversation it opened. Then what is under them (one uuid[] parameter).
  // A child's (a thread's, a task conversation's) is kept only under a kept top-level one: a disconnect
  // disconnects the server's thread copies but not its task conversations' (channelService
  // disconnectJointProjectionInTransaction), so a child's own projection alone doesn't say the server is still in.
  const projected = await tx.select({ id: jointChannels.canonicalChannelId, parentChannelId: channels.parentChannelId }).from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(and(eq(jointChannelServers.serverId, serverId), inArray(jointChannelServers.status, [...KEPT_STORAGE_PROJECTION_STATUSES])));
  const storage = projected.filter((row) => row.parentChannelId === null).map((row) => row.id);
  const underStorage = storage.length === 0 ? [] : (await tx.select({ id: channels.id }).from(channels)
    .where(sql`${channels.parentChannelId} = ANY(${uuidArray(storage)})`)).map((row) => row.id);
  // Not for the apps: the server's own copies of the joints it has left, and what is under them (its copies of
  // their threads and task conversations), whatever their own projection says. The channel step still keeps them.
  const leftCopies = projections.filter((row) => !(KEPT_STORAGE_PROJECTION_STATUSES as readonly string[]).includes(row.status)).map((row) => row.id);
  const left = new Set(leftCopies.length === 0 ? [] : [...leftCopies, ...(await tx.select({ id: channels.id }).from(channels)
    .where(sql`${channels.parentChannelId} = ANY(${uuidArray(leftCopies)})`)).map((row) => row.id)]);
  const apps = [...new Set([...all.filter((id) => !left.has(id)), ...storage, ...underStorage])];
  return { joint: new Set([...joint, ...canonical]), receipt: new Set(receipt), all, apps };
}
