import type { Server } from "socket.io";
import { asServerId } from "@botiverse/raft-shared";
import { attachJointChannelMetadata, canUserAccessChannel, getActiveJointChannelProjectionsByLocalChannel } from "./channelService";
import { isMember } from "./serverService";
import { fanoutWithAck } from "../socket/fanout";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { socketServerAllRooms } from "../socket/platformScope";
import { withVisitorVisible } from "./channelVisitorVisibility";

/**
 * The one exit for "this joint channel changed": every active participant's
 * projection gets `channel:updated` with fresh metadata. Every route that
 * changes shared joint state (human or agent) goes through here (or
 * emitJointLimitStateChange); channels.joint.api.test.ts walks each human
 * route and fails if one is missed.
 */
export async function emitJointProjectionUpdates(io: Server | null | undefined, localChannelId: string) {
  const projections = await getActiveJointChannelProjectionsByLocalChannel(localChannelId);
  const projectionChannels = await attachJointChannelMetadata(
    projections.map((projection) => ({ ...projection.channel, joined: true })),
  );
  for (const projection of projectionChannels) {
    io?.to(`channel:${projection.id}`).emit("channel:updated", { channel: projection });
  }
  return projectionChannels;
}

/** Metadata and subscription grants have the same read authority. Address the
 * concrete socket IDs we checked so eviction during a DB await cannot grant a
 * replacement connection a stale subscription. Works for existing clients.
 *
 * Publication only grants subscriptions and metadata, so a failed or timed out
 * fanout is logged rather than surfaced: the DB change is already committed,
 * a client retry could duplicate it (channel creation has no idempotency
 * key), and the missed grant repairs itself on the next reconnect. Access
 * removal never goes through this path; see accessRevocation, which stays
 * fail-closed. */
export async function publishChannelUpdate<T extends { id: string; serverId: string }>(
  io: Server | null | undefined, channel: T,
): Promise<void> {
  if (!io) return;
  try {
    await Promise.all([
      publishLocalChannelUpdate(io, channel),
      (async () => {
        const replies = await fanoutWithAck<{ ok?: boolean } | undefined>(io, "channel:publish", channel);
        if (replies.some((reply) => reply?.ok !== true)) {
          throw new Error("Channel subscription publication failed");
        }
      })(),
    ]);
  } catch (error) {
    console.error("[Socket] channel publication degraded; subscriptions repair on reconnect:", serializeErrorForLog(error));
  }
}

/** Each replica acknowledges only after its local sockets have joined. This
 * keeps an immediate task event from overtaking a remote subscription grant. */
export async function publishLocalChannelUpdate<T extends { id: string; serverId: string }>(
  io: Server, channel: T,
): Promise<void> {
  // Members and guests: guests are kept out of `server:<id>` (it carries
  // metadata they may not read) but must still be granted channels they can read.
  const sockets = await io.local.in(socketServerAllRooms(channel.serverId)).fetchSockets();
  const userIds = [...new Set(sockets.map((socket) => socket.data.userId).filter((id): id is string => typeof id === "string"))];
  const access = new Map<string, boolean>();
  await forEachBounded(userIds, ACCESS_CHECK_CONCURRENCY, async (userId) => {
    access.set(userId, await isMember(channel.serverId, userId)
      && await canUserAccessChannel(channel.id, userId, asServerId(channel.serverId)));
  });
  for (const socket of sockets) {
    const userId = socket.data.userId;
    if (typeof userId !== "string" || !access.get(userId)) continue;
    if (socket.data.accessRevoked) continue;
    await socket.join(`channel:${channel.id}`);
    socket.emit("channel:updated", { channel: withVisitorVisible(channel) });
  }
}

/** Per-user read checks are a few indexed queries each; run them a handful at
 * a time so a large server neither serializes them nor floods the pool. */
const ACCESS_CHECK_CONCURRENCY = 8;

async function forEachBounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  await Promise.all(workers);
}
