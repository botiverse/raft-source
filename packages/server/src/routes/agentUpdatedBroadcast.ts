import type { Request } from "express";
import type { Server as SocketServer } from "socket.io";
import { emitAgentProfileToJointRooms } from "../services/actorUpdatedBroadcastService";
import { agentEventRoom } from "../socket/platformScope";

/**
 * Tell every open client on the server that an agent's stored profile changed.
 * The payload carries only the id: each client re-reads the agent list through
 * `GET /api/agents`, which applies that viewer's own visibility rules. A
 * personal assistant's change goes to its owner only: pass its
 * `assistantOwnerUserId` wherever the agent may be one.
 *
 * Viewers on other servers who see the agent through an active joint channel
 * get `actor:updated` with its external profile instead (looked up after
 * this returns; it never fails the request).
 */
export function broadcastAgentUpdated(req: Request, serverId: string, agentId: string, assistantOwnerUserId?: string | null): void {
  const io = req.app.get("io") as SocketServer | undefined;
  io?.to(agentEventRoom(serverId, assistantOwnerUserId)).emit("agent:updated", { agentId });
  if (!assistantOwnerUserId) void emitAgentProfileToJointRooms(io, serverId, agentId);
}
