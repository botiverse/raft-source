import type { TaskReadOnlyReason } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelConversionJobs, channels, jointChannelServers, jointChannels, tasks } from "../db/schema";

/** Channel types that can hold tasks: never a task conversation (task v2). */
export type TaskChannelType = "channel" | "private" | "joint" | "dm" | "thread";

export function asTaskChannelType(type: typeof channels.$inferSelect["type"]): TaskChannelType {
  if (type === "task") throw new Error("a task conversation never holds tasks");
  return type;
}

export type TaskSurfaceChannel = {
  id: string;
  name: string;
  serverId: string;
  type: TaskChannelType;
  deletedAt: Date | null;
  taskReadOnlyBefore?: Date | null;
};

/** One resource rule for read projections and every mutation admission path. */
export function getTaskReadOnlyReason(
  channel: Pick<TaskSurfaceChannel, "taskReadOnlyBefore">,
  createdAt: Date | string | undefined,
): TaskReadOnlyReason | null {
  if (!channel.taskReadOnlyBefore) return null;
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt ?? "");
  return !Number.isFinite(created) || created <= channel.taskReadOnlyBefore.getTime()
    ? "historical_joint_task" : null;
}

export type TaskChannelSurface = {
  storageChannelId: string;
  localChannel: TaskSurfaceChannel;
  isJoint: boolean;
  jointRole: "host" | "participant" | null;
  /** The conversion start boundary. Existing tasks on participant surfaces
   * are read-only; tasks created after the cutover follow normal Joint rules. */
  jointHistoricalCutoffAt: Date | null;
};

export type TaskRealtimeSurfaceTarget = {
  channelId: string;
  channelType: TaskChannelType;
  serverId: string;
  localChannel: TaskSurfaceChannel;
};

function toSurfaceChannel(channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>): TaskSurfaceChannel {
  return {
    id: channel.id,
    name: channel.name,
    serverId: channel.serverId,
    type: asTaskChannelType(channel.type),
    deletedAt: channel.deletedAt,
  };
}

async function toTaskSurfaceChannel(channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>): Promise<TaskSurfaceChannel> {
  if (channel.type === "thread") {
    const thread = await channelService.getJointThreadProjectionByLocalThread(channel.id, channel.serverId);
    if (thread) {
      const parent = await getJointParentSurface(thread.localParentChannelId, channel.serverId);
      return { ...toSurfaceChannel(channel), taskReadOnlyBefore: parent?.role === "participant" ? await getJointHistoricalCutoffAt(parent.jointChannelId) : null };
    }
  }
  const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(channel.id);
  const projection = projections.find((row) => row.localChannelId === channel.id && row.serverId === channel.serverId);
  return { ...toSurfaceChannel(channel), taskReadOnlyBefore: projection?.role === "participant" ? await getJointHistoricalCutoffAt(projection.jointChannelId) : null };
}

async function isJointCanonicalStorageChannel(channelId: string): Promise<boolean> {
  const [joint] = await getDb()
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, channelId))
    .limit(1);
  return Boolean(joint);
}

async function getJointHistoricalCutoffAt(jointChannelId: string): Promise<Date | null> {
  const [job] = await getDb()
    .select({ createdAt: channelConversionJobs.createdAt })
    .from(channelConversionJobs)
    .where(and(
      eq(channelConversionJobs.jointChannelId, jointChannelId),
      eq(channelConversionJobs.status, "done"),
    ))
    .orderBy(asc(channelConversionJobs.createdAt))
    .limit(1);
  return job?.createdAt ?? null;
}

async function getJointParentSurface(
  localParentChannelId: string,
  serverId: string,
): Promise<{ jointChannelId: string; role: "host" | "participant" } | null> {
  const projection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(localParentChannelId))
    .find((candidate) => candidate.serverId === serverId);
  return projection ? { jointChannelId: projection.jointChannelId, role: projection.role } : null;
}

function jointSurfaceFields(role: "host" | "participant" | null, cutoff: Date | null) {
  return { jointRole: role, jointHistoricalCutoffAt: cutoff };
}

/**
 * Single-channel access/storage mapping (task #12): the BATCH resolver
 * (`resolveTaskChannelSurfaces`) is the single rule — this delegates to it.
 * The batched implementation documents and enforces exactly the rules that
 * used to live here twice (channel: never a canonical storage surface;
 * joint: storage = the local projection's canonical channel + role + cutoff).
 *
 * `includeDeleted` has no batched equivalent and no current caller; it keeps
 * the legacy per-channel path (`resolveTaskChannelSurfaceFallback`).
 */
export async function resolveTaskChannelSurface(
  serverId: string,
  channelId: string,
  opts?: { includeDeleted?: boolean },
): Promise<TaskChannelSurface | null> {
  if (opts?.includeDeleted) {
    return resolveTaskChannelSurfaceFallback(serverId, channelId, opts);
  }
  const surfaces = await resolveTaskChannelSurfaces(serverId, [channelId]);
  return surfaces.get(channelId) ?? null;
}

/** The legacy per-channel resolver: fallback for types the batched set-based
 * query does not cover (thread/private/dm) and for `includeDeleted` reads. */
async function resolveTaskChannelSurfaceFallback(
  serverId: string,
  channelId: string,
  opts?: { includeDeleted?: boolean },
): Promise<TaskChannelSurface | null> {
  const channel = await channelService.getChannel(channelId, { includeDeleted: opts?.includeDeleted });
  if (!channel || channel.serverId !== serverId) return null;
  // A task's own conversation is no task surface: it holds no tasks.
  if (channel.type === "task") return null;
  // Thread projections have their own canonical storage row.  Treating the
  // local projection id as storage would make task reads/writes disappear
  // immediately after Channel -> Joint conversion, because thread tasks are
  // remapped to the canonical Thread namespace during the conversion.
  if (channel.type === "thread") {
    const threadProjection = await channelService.getJointThreadProjectionByLocalThread(channel.id, serverId);
    if (threadProjection) {
      const parentSurface = await getJointParentSurface(threadProjection.localParentChannelId, serverId);
      return {
        storageChannelId: threadProjection.canonicalThreadChannelId,
        localChannel: await toTaskSurfaceChannel(channel),
        isJoint: true,
        ...jointSurfaceFields(
          parentSurface?.role ?? threadProjection.role,
          parentSurface ? await getJointHistoricalCutoffAt(parentSurface.jointChannelId) : null,
        ),
      };
    }
    // A converted local Thread has no parentMessageId by design. If its
    // projection map is gone, fail closed instead of treating the local id as
    // a fresh ordinary storage namespace and silently losing task identity.
    if (channel.parentMessageId == null) return null;
  }
  if (channel.type !== "joint") {
    // A joint channel's canonical storage row can be an ordinary `channel`,
    // including on the same server in tests/legacy data. It is persistence,
    // never a request-authority surface: callers must enter through a local
    // joint projection so membership and response ids stay server-local.
    if (await isJointCanonicalStorageChannel(channel.id)) return null;
    return {
      storageChannelId: channel.id,
      localChannel: await toTaskSurfaceChannel(channel),
      isJoint: false,
      ...jointSurfaceFields(null, null),
    };
  }

  const resolved = await channelService.resolveChannelAccess({
    serverId,
    channelId,
    includeDeleted: opts?.includeDeleted,
  });
  if (!resolved || resolved.kind !== "joint") return null;
  const cutoff = await getJointHistoricalCutoffAt(resolved.jointChannelId);
  return {
    storageChannelId: resolved.canonicalChannelId,
    localChannel: await toTaskSurfaceChannel(channel),
    isJoint: true,
    ...jointSurfaceFields(resolved.role, cutoff),
  };
}

/**
 * Batched `resolveTaskChannelSurface` for many local channels of one server,
 * in a constant number of queries. Returns a map keyed by the requested local
 * channel id; ids that resolve to `null` are absent.
 *
 * `channel` and `joint` ids are resolved set-based with exactly the rules of
 * the single-channel path (non-thread branches):
 *  - the channel must exist, be undeleted and live on `serverId`;
 *  - `channel`: a joint canonical storage row is never a surface; storage is
 *    the channel itself;
 *  - `joint`: storage is the canonical channel of the channel's active local
 *    projection on this server (active joint), with that projection's role and
 *    the joint's first `done` conversion job as the historical cutoff;
 *  - `localChannel.taskReadOnlyBefore` is that cutoff only when this server's
 *    active projection of the channel is a participant.
 * Any other type (thread/private/dm) falls back to the single resolver.
 */
export async function resolveTaskChannelSurfaces(
  serverId: string,
  channelIds: readonly string[],
): Promise<Map<string, TaskChannelSurface>> {
  const surfaces = new Map<string, TaskChannelSurface>();
  if (channelIds.length === 0) return surfaces;
  const rows = await getDb()
    .select({
      id: channels.id,
      name: channels.name,
      serverId: channels.serverId,
      type: channels.type,
      deletedAt: channels.deletedAt,
      isCanonical: sql<boolean>`EXISTS (SELECT 1 FROM ${jointChannels} storage_joint WHERE storage_joint.canonical_channel_id = ${channels.id})`,
      role: jointChannelServers.role,
      canonicalChannelId: jointChannels.canonicalChannelId,
      cutoffAt: sql`(SELECT first_done_job.created_at FROM ${channelConversionJobs} first_done_job
        WHERE first_done_job.joint_channel_id = ${jointChannelServers.jointChannelId} AND first_done_job.status = 'done'
        ORDER BY first_done_job.created_at ASC LIMIT 1)`.mapWith(channelConversionJobs.createdAt),
    })
    .from(channels)
    // The single active projection of this local channel on its own server,
    // only while its joint is active (resolveChannelAccess /
    // getActiveJointChannelProjectionsByLocalChannel condition).
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.localChannelId, channels.id),
      eq(jointChannelServers.serverId, channels.serverId),
      eq(jointChannelServers.status, "active"),
      sql`EXISTS (SELECT 1 FROM ${jointChannels} active_joint WHERE active_joint.id = ${jointChannelServers.jointChannelId} AND active_joint.status = 'active')`,
    ))
    .leftJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      inArray(channels.id, [...channelIds]),
      isNull(channels.deletedAt),
      eq(channels.serverId, serverId),
    ));

  const fallback: string[] = [];
  for (const row of rows) {
    const { id, type } = row;
    // Threads need their projection mapping: per-channel fallback. private/dm
    // follow the channel branch (the fallback's non-thread, non-joint rule:
    // not a canonical storage row, storage = itself, no projection cutoff).
    if (type !== "channel" && type !== "joint" && type !== "private" && type !== "dm") { fallback.push(id); continue; }
    const role = (row.role ?? null) as "host" | "participant" | null;
    const cutoff = (row.cutoffAt as Date | null) ?? null;
    const localChannel: TaskSurfaceChannel = {
      id,
      name: row.name,
      serverId: row.serverId,
      type,
      deletedAt: row.deletedAt,
      taskReadOnlyBefore: role === "participant" ? cutoff : null,
    };
    if (type !== "joint") {
      if (row.isCanonical) continue;
      surfaces.set(id, { storageChannelId: id, localChannel, isJoint: false, ...jointSurfaceFields(null, null) });
      continue;
    }
    if (row.canonicalChannelId == null || role == null) continue;
    surfaces.set(id, {
      storageChannelId: row.canonicalChannelId,
      localChannel,
      isJoint: true,
      ...jointSurfaceFields(role, cutoff),
    });
  }
  for (const id of fallback) {
    const surface = await resolveTaskChannelSurfaceFallback(serverId, id);
    if (surface) surfaces.set(id, surface);
  }
  return surfaces;
}

export async function resolveTaskChannelSurfaceForStorage(
  serverId: string,
  storageChannelId: string,
  opts?: { includeDeleted?: boolean },
): Promise<TaskChannelSurface | null> {
  const storageChannel = await channelService.getChannel(storageChannelId, { includeDeleted: opts?.includeDeleted });
  if (!storageChannel) return null;

  const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(storageChannelId);
  if (projections.length > 0) {
    const projection = projections.find((candidate) => candidate.serverId === serverId);
    if (!projection) return null;
    const localChannel = await channelService.getChannel(projection.localChannelId, { includeDeleted: opts?.includeDeleted });
    if (!localChannel || localChannel.serverId !== serverId) return null;
    const cutoff = await getJointHistoricalCutoffAt(projection.jointChannelId);
    return {
      storageChannelId,
      localChannel: await toTaskSurfaceChannel(localChannel),
      isJoint: true,
      ...jointSurfaceFields(projection.role as "host" | "participant", cutoff),
    };
  }

  // The canonical Thread itself is not a request-authority surface. Resolve
  // it back to the server-local Thread projection before exposing tasks so
  // board/detail/permalink routes retain local identity while reading the
  // canonical task namespace.
  const threadProjections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(storageChannelId);
  const threadProjection = threadProjections.find((candidate) => candidate.localServerId === serverId);
  if (threadProjection) {
    const localChannel = await channelService.getChannel(threadProjection.localThreadChannelId, { includeDeleted: opts?.includeDeleted });
    if (!localChannel || localChannel.serverId !== serverId) return null;
    const parentSurface = await getJointParentSurface(threadProjection.localParentChannelId, serverId);
    const cutoff = parentSurface ? await getJointHistoricalCutoffAt(parentSurface.jointChannelId) : null;
    return {
      storageChannelId,
      localChannel: await toTaskSurfaceChannel(localChannel),
      isJoint: true,
      ...jointSurfaceFields(parentSurface?.role ?? threadProjection.role, cutoff),
    };
  }

  if (await isJointCanonicalStorageChannel(storageChannelId)) return null;

  if (storageChannel.serverId !== serverId) return null;
  return {
    storageChannelId,
    localChannel: await toTaskSurfaceChannel(storageChannel),
    isJoint: false,
    ...jointSurfaceFields(null, null),
  };
}

export function isHistoricalJointTaskReadOnly(surface: TaskChannelSurface, createdAt: Date | string): boolean {
  return getTaskReadOnlyReason(surface.localChannel, createdAt) !== null;
}

/**
 * Whether a task conversation is read-only on this server: the conversation
 * of a historical joint task, seen from a participant workspace. Its task is
 * read-only there (`isHistoricalJointTaskReadOnly`), and so is its
 * discussion. Any other channel: false.
 */
export async function isTaskConversationReadOnly(
  serverId: string,
  conversation: { type: string; taskId?: string | null; parentChannelId?: string | null },
): Promise<boolean> {
  if (conversation.type !== "task" || !conversation.taskId || !conversation.parentChannelId) return false;
  const [task] = await getDb()
    .select({ createdAt: tasks.createdAt })
    .from(tasks)
    .where(eq(tasks.id, conversation.taskId))
    .limit(1);
  if (!task) return false;
  const surface = await resolveTaskChannelSurface(serverId, conversation.parentChannelId);
  return surface !== null && isHistoricalJointTaskReadOnly(surface, task.createdAt);
}

export function writeTaskSurfaceFields(surface: TaskChannelSurface): Pick<TaskChannelSurface, "isJoint" | "jointRole" | "jointHistoricalCutoffAt"> {
  return {
    isJoint: surface.isJoint,
    jointRole: surface.jointRole,
    jointHistoricalCutoffAt: surface.jointHistoricalCutoffAt,
  };
}

export async function getTaskRealtimeSurfaceTargets(surface: TaskChannelSurface): Promise<TaskRealtimeSurfaceTarget[]> {
  const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(surface.storageChannelId);
  if (projections.length === 0) {
    return [{
      channelId: surface.localChannel.id,
      channelType: surface.localChannel.type,
      serverId: surface.localChannel.serverId,
      localChannel: surface.localChannel,
    }];
  }

  const targets: TaskRealtimeSurfaceTarget[] = [];
  for (const projection of projections) {
    const localChannel = await channelService.getChannel(projection.localChannelId);
    if (!localChannel) continue;
    targets.push({
      channelId: localChannel.id,
      channelType: asTaskChannelType(localChannel.type),
      serverId: projection.serverId,
      localChannel: await toTaskSurfaceChannel(localChannel),
    });
  }
  return targets;
}

/**
 * Realtime targets for a task known only by its storage channel (no request
 * surface at hand, e.g. a lazily created task v2 conversation): every active
 * joint projection, or the storage channel itself.
 */
export async function getTaskRealtimeTargetsForStorageChannel(storageChannelId: string): Promise<TaskRealtimeSurfaceTarget[]> {
  const storage = await channelService.getChannel(storageChannelId);
  if (!storage) return [];
  return getTaskRealtimeSurfaceTargets({
    storageChannelId,
    localChannel: await toTaskSurfaceChannel(storage),
    isJoint: false,
    ...jointSurfaceFields(null, null),
  });
}
