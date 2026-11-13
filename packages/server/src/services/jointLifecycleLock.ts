import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { jointChannels, jointChannelServers } from "../db/schema";
import { resolveParentJointId } from "./jointChannelLimitState";
import { acquireServerLock, JOINT_LIFECYCLE_LOCK_NAMESPACE } from "./planService";

/**
 * A joint channel's lifecycle lock (JOINT_LIFECYCLE_LOCK_NAMESPACE, keyed on
 * the parent joint). Writers that change every projection of a joint
 * (archive, unarchive, metadata fan-out) and writers that create a projection
 * (joint accept, external connect) take it before any channel row of the
 * joint, J or the joint row, so a new projection is either seen by the fan-out
 * or sees its result (#wg-rbac:#16 P2a-3, Cody 1125ecca / 7b055bc6).
 *
 * Order where both apply (ADMISSION_LOCK_ORDER in planService): the
 * admission lock(s), the connecting server's ns-3 lock, then this, then
 * channel rows, server/member rows, J, JOINT_HOST, the joint row.
 */
export async function lockJointLifecycle(tx: DatabaseExecutor, jointChannelId: string): Promise<string> {
  const parentJointId = await resolveParentJointId(tx, jointChannelId) ?? jointChannelId;
  await acquireServerLock(tx, parentJointId, JOINT_LIFECYCLE_LOCK_NAMESPACE);
  return parentJointId;
}

/** The parent joint of a channel that is an active projection (or a joint's storage channel), or null. */
export async function parentJointOfLocalChannel(tx: DatabaseExecutor, channelId: string): Promise<string | null> {
  const [projection] = await tx.select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(eq(jointChannelServers.localChannelId, channelId), eq(jointChannelServers.status, "active"), eq(jointChannels.status, "active")));
  const jointChannelId = projection?.jointChannelId
    ?? (await tx.select({ id: jointChannels.id }).from(jointChannels)
      .where(and(eq(jointChannels.canonicalChannelId, channelId), eq(jointChannels.status, "active"))))[0]?.id
    ?? null;
  if (!jointChannelId) return null;
  return await resolveParentJointId(tx, jointChannelId) ?? jointChannelId;
}

/**
 * For a writer entered from one channel: the lifecycle lock of the joint it
 * is a projection of (none for an ordinary channel), taken before the
 * channel's row. Call it again after locking the row
 * (assertJointLifecycleUnchanged): a channel that became or stopped being a
 * projection in between is refused rather than written under the wrong lock.
 */
export async function lockJointLifecycleOfChannel(tx: DatabaseExecutor, channelId: string): Promise<string | null> {
  const parentJointId = await parentJointOfLocalChannel(tx, channelId);
  if (parentJointId) await acquireServerLock(tx, parentJointId, JOINT_LIFECYCLE_LOCK_NAMESPACE);
  return parentJointId;
}

export class JointLifecycleChangedError extends Error {
  constructor() {
    super("The channel was connected or disconnected meanwhile; try again");
    this.name = "JointLifecycleChangedError";
  }
}

export async function assertJointLifecycleUnchanged(tx: DatabaseExecutor, channelId: string, locked: string | null): Promise<void> {
  if (await parentJointOfLocalChannel(tx, channelId) !== locked) throw new JointLifecycleChangedError();
}
