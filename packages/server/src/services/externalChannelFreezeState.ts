/**
 * Read side of the free plan's external channel freeze (behind
 * external_channels_v1; the writes are externalChannelFreezeService's).
 *
 * A server's external channels (one definition, shared with the admission
 * checks of externalChannelLimitService):
 * - an ordinary channel of the server with at least one bound Guest
 *   (server_members role 'guest', guest_channel_id = the channel);
 * - the server's active projection of an active top-level joint channel
 *   (never a thread or task sub-record) that at least one OTHER non-deleted
 *   server also has an active projection of.
 * Archived and deleted channels are not external.
 *
 * A free server in more than one of them has a server_external_freezes row;
 * once its freeze_at has passed (read here, never flipped by a timer) the
 * server's side of every external channel is read-only: its humans, its
 * agents and, where it hosts the channel, the channel's Guests (whose entry
 * server is the host). The other servers of a joint keep writing.
 *
 * Imported by planService's write gate, so it imports nothing that imports
 * planService (the flag evaluation is loaded on first use).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channels, messages, serverExternalFreezes } from "../db/schema";
import { resolveGatingParentJointId } from "./jointChannelLimitState";

export type ExternalChannelOfServer = {
  /** The server's own channel: the Guest's channel, or its local projection of the joint. */
  channelId: string;
  /** The top-level joint, for a joint channel; null for a Guest channel. */
  jointId: string | null;
};

/**
 * The server's external channels, one row each (`channel_id`, `joint_id`),
 * as a subquery. The only definition: counts, the admission checks and the
 * write gate all read this.
 */
export function externalChannelsOfServerSql(serverId: string): SQL {
  return sql`
    SELECT sm.guest_channel_id AS channel_id, NULL::uuid AS joint_id
    FROM server_members sm
    JOIN channels c ON c.id = sm.guest_channel_id
    WHERE sm.server_id = ${serverId}::uuid
      AND sm.role = 'guest'
      AND c.deleted_at IS NULL
      AND c.archived_at IS NULL
    UNION
    SELECT own.local_channel_id AS channel_id, own.joint_channel_id AS joint_id
    FROM joint_channel_servers own
    JOIN joint_channels j ON j.id = own.joint_channel_id AND j.status = 'active'
    JOIN channels canonical ON canonical.id = j.canonical_channel_id AND canonical.type NOT IN ('thread', 'task')
    JOIN channels local ON local.id = own.local_channel_id AND local.deleted_at IS NULL AND local.archived_at IS NULL
    WHERE own.server_id = ${serverId}::uuid
      AND own.status = 'active'
      AND EXISTS (
        SELECT 1 FROM joint_channel_servers other
        JOIN servers os ON os.id = other.server_id AND os.deleted_at IS NULL
        WHERE other.joint_channel_id = own.joint_channel_id
          AND other.server_id <> own.server_id
          AND other.status = 'active'
      )
  `;
}

export async function listExternalChannelsOfServer(executor: DatabaseExecutor, serverId: string): Promise<ExternalChannelOfServer[]> {
  const result = await executor.execute<{ channel_id: string; joint_id: string | null }>(sql`
    SELECT DISTINCT channel_id, joint_id FROM (${externalChannelsOfServerSql(serverId)}) external_channels
  `);
  return result.rows.map((row) => ({ channelId: row.channel_id, jointId: row.joint_id }));
}

/** How many external channels the server is in, leaving out `exceptChannelId` (its own channel id) when given. */
export async function countExternalChannelsOfServer(
  executor: DatabaseExecutor,
  serverId: string,
  options: { exceptChannelId?: string | null } = {},
): Promise<number> {
  const result = await executor.execute<{ n: number }>(sql`
    SELECT count(DISTINCT channel_id)::int AS n FROM (${externalChannelsOfServerSql(serverId)}) external_channels
    WHERE ${options.exceptChannelId ? sql`channel_id <> ${options.exceptChannelId}::uuid` : sql`TRUE`}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** external_channels_v1 per server, with no user (a property of the server, the same for every caller and the sweep). */
export async function externalChannelsFlagOnFor(executor: DatabaseExecutor, serverIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(serverIds)];
  if (ids.length === 0) return new Set();
  // Loaded on first use: featureFlagService imports planService, which imports this module.
  const { evaluateFeatureFlags } = await import("./featureFlagService");
  const evaluations = await evaluateFeatureFlags(
    ids.map((serverId) => ({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId, userId: null })),
    executor,
  );
  return new Set(ids.filter((_, index) => evaluations[index]?.enabled === true));
}

/** Stored freeze times of these servers (a row = over the limit; its time may still be ahead). */
export async function getStoredExternalFreezeAt(executor: DatabaseExecutor, serverIds: readonly string[]): Promise<Map<string, Date>> {
  const ids = [...new Set(serverIds)];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ serverId: serverExternalFreezes.serverId, freezeAt: serverExternalFreezes.freezeAt })
    .from(serverExternalFreezes)
    .where(ids.length === 1 ? eq(serverExternalFreezes.serverId, ids[0]!) : inArray(serverExternalFreezes.serverId, ids));
  return new Map(rows.map((row) => [row.serverId, row.freezeAt]));
}

export function isExternalFreezeActiveAt(freezeAt: Date | null | undefined, now: Date): boolean {
  return !!freezeAt && freezeAt.getTime() <= now.getTime();
}

/**
 * The one staleness check of a stored freeze row, shared by the write gate
 * and channel metadata: the server's external channels while it is still
 * over (flag on, free, more than one external channel), or null when the row
 * is stale. Leaving the limit on any path (an upgrade, a channel gone) thus
 * unfreezes at once, whether or not that path reconciled; deleting the stale
 * row is the reconcile's or the sweep's. Only called for a server with a row.
 */
async function externalChannelsWhileOver(executor: DatabaseExecutor, serverId: string, now: Date): Promise<ExternalChannelOfServer[] | null> {
  if (!(await externalChannelsFlagOnFor(executor, [serverId])).has(serverId)) return null;
  const external = await listExternalChannelsOfServer(executor, serverId);
  if (external.length <= 1) return null;
  // freeServerIds lives in jointChannelLimitService, loaded on first use: it imports planService.
  const { freeServerIds } = await import("./jointChannelLimitService");
  if (!(await freeServerIds(executor, [serverId], now)).has(serverId)) return null;
  return external;
}

/**
 * The ordinary channel a thread or task conversation of `serverId` hangs off
 * (a thread's parent message's channel, a task's parent channel), or the
 * channel itself. Joint sub-records are resolved by resolveGatingParentJointId.
 */
async function ordinaryRootChannelId(executor: DatabaseExecutor, channelId: string, serverId: string): Promise<string> {
  const [channel] = await executor
    .select({ type: channels.type, parentMessageId: channels.parentMessageId, parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.serverId, serverId)))
    .limit(1);
  if (!channel) return channelId;
  if (channel.type === "task" && channel.parentChannelId) return channel.parentChannelId;
  if (channel.type === "thread" && channel.parentMessageId) {
    const [parent] = await executor.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, channel.parentMessageId)).limit(1);
    return parent?.channelId ?? channelId;
  }
  return channelId;
}

/**
 * The write gate (isChannelReadOnlyByBillingFeature): whether `serverId`, the
 * writer's entry server, is frozen and `channelId` is on its side of one of
 * its external channels: the channel itself, a thread or task conversation
 * under it, or a joint's canonical storage the server is in. One primary-key
 * read when the server has no freeze row (the common case); the rest only
 * once it is frozen.
 */
export async function getExternalFreezeOfChannel(
  channelId: string,
  serverId: string,
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<{ freezeAt: Date } | null> {
  const freezeAt = (await getStoredExternalFreezeAt(executor, [serverId])).get(serverId);
  if (!freezeAt || !isExternalFreezeActiveAt(freezeAt, now)) return null;
  const external = await externalChannelsWhileOver(executor, serverId, now);
  if (!external) return null;
  if (external.some((row) => row.channelId === channelId)) return { freezeAt };
  const externalJoints = new Set(external.flatMap((row) => (row.jointId ? [row.jointId] : [])));
  if (externalJoints.size > 0) {
    const parentJointId = await resolveGatingParentJointId(executor, channelId, serverId);
    if (parentJointId) return externalJoints.has(parentJointId) ? { freezeAt } : null;
  }
  const rootId = await ordinaryRootChannelId(executor, channelId, serverId);
  return rootId !== channelId && external.some((row) => row.channelId === rootId) ? { freezeAt } : null;
}

/**
 * For channel metadata: each row's server's freeze time (ISO), on the rows
 * that are one of that server's external channels; absent otherwise. Set
 * while the server is over the limit, also before the time has passed (the
 * client shows a notice until then, and read-only from then on). One query
 * for the rows' servers when none of them has a freeze row.
 */
export async function getExternalFreezeAtForChannels(
  executor: DatabaseExecutor,
  rows: ReadonlyArray<{ id: string; serverId: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const stored = await getStoredExternalFreezeAt(executor, rows.map((row) => row.serverId));
  if (stored.size === 0) return result;
  const now = new Date();
  for (const serverId of [...stored.keys()].sort()) {
    // The write gate's check: a server no longer over shows no notice either.
    const listed = await externalChannelsWhileOver(executor, serverId, now);
    if (!listed) continue;
    const external = new Set(listed.map((row) => row.channelId));
    const freezeAt = stored.get(serverId)!.toISOString();
    for (const row of rows) {
      if (row.serverId === serverId && external.has(row.id)) result.set(row.id, freezeAt);
    }
  }
  return result;
}
