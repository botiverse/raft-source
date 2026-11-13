import { and, eq, inArray, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { JOINT_CHANNEL_OVER_LIMIT_GRACE_MS } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channels, jointChannels, jointChannelServers, messages } from "../db/schema";

// Contract v0.3 §18.5/§18.8: limits live on the top-level ("parent") joint.
// Every sub-thread of a joint is also stored as its own joint_channels row,
// with no parent pointer, so anything keyed by a joint id must first resolve
// to the parent here. This module only reads stored state; it never consults
// billing, so request-time gates stay one row lookup. Task v2 conversations
// are sub-records too: a joint task conversation's canonical row (type
// 'task') names its canonical parent channel on the row (parent_channel_id),
// where a thread's is its parent message's channel.

export type JointLimitState = {
  parentJointId: string;
  overLimitSince: Date | null;
  graceEndsAt: Date | null;
  readOnly: boolean;
};

export function jointGraceEndsAt(overLimitSince: Date | null): Date | null {
  return overLimitSince ? new Date(overLimitSince.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS) : null;
}

/** Read-only is computed from the stored start, never flipped by a timer (§18.11 item 7). */
export function isJointReadOnlyAt(overLimitSince: Date | null, now: Date): boolean {
  const graceEndsAt = jointGraceEndsAt(overLimitSince);
  return graceEndsAt !== null && now.getTime() >= graceEndsAt.getTime();
}

/** A joint record of a sub-conversation (thread or task v2 conversation), never a top-level joint. */
export function isSubRecordType(type: string): boolean {
  return type === "thread" || type === "task";
}

/**
 * The parent joint of a sub-record: the joint whose canonical channel holds a
 * thread's parent message, or a task conversation's canonical parent channel.
 */
function subRecordParentJointCondition(
  parentJoint: { canonicalChannelId: AnyPgColumn },
  parentMessage: { channelId: AnyPgColumn },
) {
  return sql`${parentJoint.canonicalChannelId} = COALESCE(
    ${parentMessage.channelId},
    CASE WHEN ${channels.type} = 'task' THEN ${channels.parentChannelId} END
  )`;
}

/** Map any joint id (top-level or sub-thread record) to its top-level joint id. */
export async function resolveParentJointId(
  executor: DatabaseExecutor,
  jointChannelId: string,
): Promise<string | null> {
  const parentMessage = alias(messages, "joint_limit_parent_message");
  const parentJoint = alias(jointChannels, "joint_limit_parent_joint");
  const [row] = await executor
    .select({
      id: jointChannels.id,
      canonicalType: channels.type,
      parentJointId: parentJoint.id,
    })
    .from(jointChannels)
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .leftJoin(parentMessage, eq(parentMessage.id, channels.parentMessageId))
    .leftJoin(parentJoint, subRecordParentJointCondition(parentJoint, parentMessage))
    .where(eq(jointChannels.id, jointChannelId))
    .limit(1);
  if (!row) return null;
  if (!isSubRecordType(row.canonicalType)) return row.id;
  return row.parentJointId ?? null;
}

async function getActiveJointIdForLocalChannel(
  executor: DatabaseExecutor,
  localChannelId: string,
  serverId: string,
): Promise<string | null> {
  const [projection] = await executor
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, localChannelId),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return projection?.jointChannelId ?? null;
}

/**
 * Resolve the parent joint that gates writes to `channelId` as seen from
 * `serverId`. Accepts a local joint projection, a local joint-thread
 * projection (type "thread" with no parentMessageId), an ordinary thread whose
 * parent message lives in a joint projection, or a canonical storage id the
 * server participates in. Returns null for channels that are not joint.
 */
export async function resolveGatingParentJointId(
  executor: DatabaseExecutor,
  channelId: string,
  serverId: string,
): Promise<string | null> {
  const [channel] = await executor
    .select({ id: channels.id, type: channels.type, parentMessageId: channels.parentMessageId, parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.serverId, serverId)))
    .limit(1);

  let jointChannelId: string | null = null;
  if (!channel) {
    const [storage] = await executor
      .select({ jointChannelId: jointChannels.id })
      .from(jointChannels)
      .innerJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
      ))
      .where(and(eq(jointChannels.canonicalChannelId, channelId), eq(jointChannels.status, "active")))
      .limit(1);
    jointChannelId = storage?.jointChannelId ?? null;
  } else if (channel.type === "joint" || channel.type === "thread" || channel.type === "task") {
    // Local joint projections and local joint-thread projections both carry
    // a joint_channel_servers row. Joint-thread projections have no
    // parentMessageId, so they must be found here, not through the parent
    // message below.
    jointChannelId = await getActiveJointIdForLocalChannel(executor, channel.id, serverId);
    if (!jointChannelId && channel.type === "thread" && channel.parentMessageId) {
      const [parent] = await executor
        .select({ parentChannelId: channels.id, parentChannelType: channels.type })
        .from(messages)
        .innerJoin(channels, and(eq(channels.id, messages.channelId), eq(channels.serverId, serverId)))
        .where(eq(messages.id, channel.parentMessageId))
        .limit(1);
      if (parent?.parentChannelType === "joint") {
        jointChannelId = await getActiveJointIdForLocalChannel(executor, parent.parentChannelId, serverId);
      }
    }
    // Task v2: a local task conversation without its own projection row
    // (defensive) is gated by its parent channel's joint.
    if (!jointChannelId && channel.type === "task" && channel.parentChannelId) {
      const [parent] = await executor
        .select({ id: channels.id, type: channels.type })
        .from(channels)
        .where(and(eq(channels.id, channel.parentChannelId), eq(channels.serverId, serverId)))
        .limit(1);
      if (parent?.type === "joint") {
        jointChannelId = await getActiveJointIdForLocalChannel(executor, parent.id, serverId);
      }
    }
  }

  if (!jointChannelId) return null;
  const parentJointId = await resolveParentJointId(executor, jointChannelId);
  if (!parentJointId) {
    // A joint record whose parent cannot be resolved should not exist; it is
    // allowed through (as non-joint) but made visible, so a data problem
    // cannot quietly become a read-only bypass.
    console.warn(`[JointLimit] No parent joint for joint ${jointChannelId} (channel ${channelId}, server ${serverId}); treating as not limited`);
  }
  return parentJointId;
}

export async function getJointLimitState(
  executor: DatabaseExecutor,
  parentJointId: string,
  now: Date,
): Promise<JointLimitState> {
  const [row] = await executor
    .select({ overLimitSince: jointChannels.overLimitSince })
    .from(jointChannels)
    .where(eq(jointChannels.id, parentJointId))
    .limit(1);
  const overLimitSince = row?.overLimitSince ?? null;
  return {
    parentJointId,
    overLimitSince,
    graceEndsAt: jointGraceEndsAt(overLimitSince),
    readOnly: isJointReadOnlyAt(overLimitSince, now),
  };
}

/**
 * Batch form of resolveParentJointId + getJointLimitState for list endpoints
 * (sidebar, channel lists): one statement for any number of joints instead of
 * two per joint. Keyed by the given joint id; joints with no resolvable parent
 * map to null, as resolveParentJointId does.
 */
export async function getJointLimitStatesForJoints(
  executor: DatabaseExecutor,
  jointChannelIds: readonly string[],
  now: Date,
): Promise<Map<string, JointLimitState | null>> {
  const states = new Map<string, JointLimitState | null>();
  const ids = [...new Set(jointChannelIds)];
  if (ids.length === 0) return states;
  const parentMessage = alias(messages, "joint_limit_parent_message");
  const parentJoint = alias(jointChannels, "joint_limit_parent_joint");
  const rows = await executor
    .selectDistinctOn([jointChannels.id], {
      id: jointChannels.id,
      canonicalType: channels.type,
      overLimitSince: jointChannels.overLimitSince,
      parentJointId: parentJoint.id,
      parentOverLimitSince: parentJoint.overLimitSince,
    })
    .from(jointChannels)
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .leftJoin(parentMessage, eq(parentMessage.id, channels.parentMessageId))
    .leftJoin(parentJoint, subRecordParentJointCondition(parentJoint, parentMessage))
    .where(inArray(jointChannels.id, ids))
    .orderBy(jointChannels.id);
  for (const row of rows) {
    const isThread = isSubRecordType(row.canonicalType);
    const parentJointId = isThread ? row.parentJointId : row.id;
    if (!parentJointId) {
      states.set(row.id, null);
      continue;
    }
    const overLimitSince = (isThread ? row.parentOverLimitSince : row.overLimitSince) ?? null;
    states.set(row.id, {
      parentJointId,
      overLimitSince,
      graceEndsAt: jointGraceEndsAt(overLimitSince),
      readOnly: isJointReadOnlyAt(overLimitSince, now),
    });
  }
  for (const id of ids) if (!states.has(id)) states.set(id, null);
  return states;
}

/** One stored-field read for the posting gate (§18.11 item 6). */
export async function isChannelReadOnlyByJointLimit(
  channelId: string,
  serverId: string,
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const parentJointId = await resolveGatingParentJointId(executor, channelId, serverId);
  if (!parentJointId) return false;
  return (await getJointLimitState(executor, parentJointId, now)).readOnly;
}
