import * as channelService from "./channelService.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { jointChannels } from "../db/schema.js";

export type TaskSurfaceChannel = {
  id: string;
  name: string;
  serverId: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  deletedAt: Date | null;
};

export type TaskChannelSurface = {
  storageChannelId: string;
  localChannel: TaskSurfaceChannel;
  isJoint: boolean;
};

export type TaskRealtimeSurfaceTarget = {
  channelId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  serverId: string;
  localChannel: TaskSurfaceChannel;
};

function toSurfaceChannel(channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>): TaskSurfaceChannel {
  return {
    id: channel.id,
    name: channel.name,
    serverId: channel.serverId,
    type: channel.type,
    deletedAt: channel.deletedAt,
  };
}

async function isJointCanonicalStorageChannel(channelId: string): Promise<boolean> {
  const [joint] = await getDb()
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, channelId))
    .limit(1);
  return Boolean(joint);
}

export async function resolveTaskChannelSurface(
  serverId: string,
  channelId: string,
  opts?: { includeDeleted?: boolean },
): Promise<TaskChannelSurface | null> {
  const channel = await channelService.getChannel(channelId, { includeDeleted: opts?.includeDeleted });
  if (!channel || channel.serverId !== serverId) return null;
  if (channel.type !== "joint") {
    // A joint channel's canonical storage row can be an ordinary `channel`,
    // including on the same server in tests/legacy data. It is persistence,
    // never a request-authority surface: callers must enter through a local
    // joint projection so membership and response ids stay server-local.
    if (await isJointCanonicalStorageChannel(channel.id)) return null;
    return {
      storageChannelId: channel.id,
      localChannel: toSurfaceChannel(channel),
      isJoint: false,
    };
  }

  const resolved = await channelService.resolveChannelAccess({
    serverId,
    channelId,
    includeDeleted: opts?.includeDeleted,
  });
  if (!resolved || resolved.kind !== "joint") return null;
  return {
    storageChannelId: resolved.canonicalChannelId,
    localChannel: toSurfaceChannel(channel),
    isJoint: true,
  };
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
    return {
      storageChannelId,
      localChannel: toSurfaceChannel(localChannel),
      isJoint: true,
    };
  }

  if (await isJointCanonicalStorageChannel(storageChannelId)) return null;

  if (storageChannel.serverId !== serverId) return null;
  return {
    storageChannelId,
    localChannel: toSurfaceChannel(storageChannel),
    isJoint: false,
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
      channelType: localChannel.type,
      serverId: projection.serverId,
      localChannel: toSurfaceChannel(localChannel),
    });
  }
  return targets;
}
