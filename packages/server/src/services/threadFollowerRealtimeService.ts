import type { Server as SocketServer } from "socket.io";
import * as channelService from "./channelService";

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

let socketServer: SocketServer | null = null;

/** The socket server noteAgentThreadFollowResumed emits on (setupSocket). */
export function registerThreadFollowerSocketServer(io: SocketServer): void {
  socketServer = io;
}

/** Forget `io` if it is the registered one (its HTTP server closed). */
export function unregisterThreadFollowerSocketServer(io: SocketServer): void {
  if (socketServer === io) socketServer = null;
}

/**
 * An agent that had stopped following a thread follows it again (a mention, its
 * own reply, an action card's result: recordThreadFollow). Those writers have
 * no socket of their own, so `thread:followers-updated` goes out from here.
 * Never throws and never waits: the write it follows already happened.
 */
export function noteAgentThreadFollowResumed(threadChannelId: string): void {
  if (!socketServer) return;
  void emitThreadFollowersUpdated(socketServer, threadChannelId).catch((error: unknown) => {
    console.warn("[ThreadFollowers] follow_resumed_emit_failed", {
      threadChannelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
