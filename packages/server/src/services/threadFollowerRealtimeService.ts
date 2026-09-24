import type { Server as SocketServer } from "socket.io";
import * as channelService from "./channelService.js";

export async function emitThreadFollowersUpdated(
  io: SocketServer | undefined,
  threadChannelId: string,
): Promise<void> {
  if (!io) return;
  const audienceThreadChannelIds = await channelService.getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId);
  for (const localThreadChannelId of audienceThreadChannelIds) {
    io.to(`channel:${localThreadChannelId}`).emit("thread:followers-updated", {
      threadChannelId: localThreadChannelId,
    });
  }
}
