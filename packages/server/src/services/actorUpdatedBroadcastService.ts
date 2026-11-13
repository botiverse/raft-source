import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { ACTOR_UPDATED_EVENT } from "@botiverse/raft-shared";
import type { ActorUpdatedEvent } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { listJointActivityProjectionChannelIdsForAgent } from "./channelService";

type ChannelRoomEmitter = Pick<SocketServer, "to">;

/**
 * Push an agent's external profile (`actor:updated`) to the joint projection
 * channel rooms on other servers that see it through an active joint channel,
 * the same rooms `agent:activity` fans out to. Only members who can read a
 * projection channel are in its room. The payload is the external projection
 * (POST /api/actors/resolve), nothing only the home server sees. A deleted
 * agent gets no push. Never throws: a failure is logged, the write it follows
 * has already succeeded.
 */
export async function emitAgentProfileToJointRooms(
  io: ChannelRoomEmitter | null | undefined,
  homeServerId: string,
  agentId: string,
): Promise<void> {
  if (!io) return;
  try {
    const channelIds = await listJointActivityProjectionChannelIdsForAgent(agentId, homeServerId);
    if (channelIds.length === 0) return;
    const [agent] = await getDb()
      .select({
        id: agents.id,
        serverId: agents.serverId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        deletedAt: agents.deletedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent || agent.deletedAt || agent.serverId !== homeServerId) return;
    const payload: ActorUpdatedEvent = {
      kind: "agent",
      id: agent.id,
      homeServerId: agent.serverId,
      name: agent.name,
      displayName: agent.displayName ?? null,
      avatarUrl: agent.avatarUrl ?? null,
    };
    for (const channelId of channelIds) io.to(`channel:${channelId}`).emit(ACTOR_UPDATED_EVENT, payload);
  } catch (err) {
    console.error("[actor:updated] Failed to push agent profile to joint channel rooms", { agentId, err });
  }
}
