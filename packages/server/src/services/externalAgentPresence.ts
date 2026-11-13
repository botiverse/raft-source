// External-agent presence ("online if seen in the last 120 s").
//
// External agents have no daemon, so the server never learns their liveness
// from a runtime heartbeat. Instead, presence is derived from use of the
// agent's own credential: every authenticated `/internal/agent-api/*` request
// and every heartbeat tick of an open `/wake-hints/stream` counts as "seen".
//
// Stateless by design: the durable signal is `agent_credentials.last_used_at`
// (throttled to one write per credential per 30 s per process by
// `recordAgentCredentialUse`). `GET /agents` serves it as `lastSeenAt`, and the
// client decides online vs. "last active" from the timestamp. When a write
// actually lands for an external agent we push `agent:seen` to the agent's
// server room (a personal assistant's: its owner only, agentEventRoom;
// cross-replica via the socket.io Redis adapter) so open clients
// update without a refetch, and to each other server's projection room of an
// active joint channel the agent is in, so people there see it too (their
// roster, `GET /channels/:id/members`, serves the same `lastSeenAt`). The push
// is best-effort; the REST reads converge.
//
// The peer lookup is one query per landed write, and writes are throttled per
// credential, so heartbeats cost no extra queries.

import type { Request } from "express";
import type { Server as SocketServer } from "socket.io";
import type { AgentSeenEvent } from "@botiverse/raft-shared";
import { recordAgentCredentialUse } from "./agentCredentialService";
import { listJointActivityProjectionChannelIdsForAgent } from "./channelService";
import { agentEventRoom } from "../socket/platformScope";

type SeenEmitter = Pick<SocketServer, "to">;

export function emitAgentSeen(
  io: SeenEmitter | null | undefined,
  input: { agentId: string; serverId: string; assistantOwnerUserId: string | null; lastSeenAt: Date },
): void {
  if (!io) return;
  const payload: AgentSeenEvent = {
    agentId: input.agentId,
    lastSeenAt: input.lastSeenAt.toISOString(),
  };
  try {
    io.to(agentEventRoom(input.serverId, input.assistantOwnerUserId)).emit("agent:seen", payload);
  } catch {
    // Best-effort realtime hint; `GET /agents` is the convergence path.
  }
  // Joint channels: the other servers' projection rooms (only the two fields).
  void listJointActivityProjectionChannelIdsForAgent(input.agentId, input.serverId).then((channelIds) => {
    for (const channelId of channelIds) {
      try {
        io.to(`channel:${channelId}`).emit("agent:seen", payload);
      } catch {
        // Best-effort; the joint roster serves the same `lastSeenAt`.
      }
    }
  }, () => {});
}

/**
 * Record that the credential on this (already authenticated) agent-API
 * request was used. Fire-and-forget; never throws.
 */
export function recordAgentApiSeen(req: Request): void {
  const credentialId = req.agentCredentialId;
  const agentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!credentialId || !agentId || !serverId) return;
  const isExternal = req.actingAgentIsExternal === true;
  const assistantOwnerUserId = req.actingAgentAssistantOwnerUserId ?? null;
  const io = isExternal ? (req.app?.get("io") as SeenEmitter | undefined) : undefined;
  void recordAgentCredentialUse({
    credentialId,
    ip: typeof req.ip === "string" ? req.ip : null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  }).then((writtenAt) => {
    if (writtenAt && isExternal) emitAgentSeen(io, { agentId, serverId, assistantOwnerUserId, lastSeenAt: writtenAt });
  }, () => {});
}
