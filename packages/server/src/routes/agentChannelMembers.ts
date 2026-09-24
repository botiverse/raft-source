import { revokeSocketAccess } from "../socket/accessRevocation.js";
import type { Server as SocketServer } from "socket.io";
import * as agentService from "../services/agentService.js";
import * as channelService from "../services/channelService.js";
import * as messageService from "../services/messageService.js";
import * as serverService from "../services/serverService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { actorHasChannelCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";

export interface AgentChannelMemberActor {
  id: string;
  name: string;
  serverId: string;
}

export interface AgentChannelMemberAddResult {
  status: number;
  body: Record<string, unknown>;
}

export interface AgentChannelMemberRemoveResult {
  status: number;
  body: Record<string, unknown>;
}

type Target =
  | { type: "human"; id: string; name: string }
  | { type: "agent"; id: string; name: string };

function buildChannelMemberRemovalAttention(channel: { name: string }, target: Target) {
  const channelRef = `#${channel.name}`;
  return {
    state: "removed",
    ordinaryActivity: `Ordinary channel delivery for @${target.name} in ${channelRef} has stopped.`,
    stillArrives: [
      `If ${channelRef} is public, followed threads still notify @${target.name} until they unfollow them.`,
      "Personal @mentions can still notify when current visibility allows.",
    ],
    threadBoundary: "Removing a channel member does not unfollow existing thread follows. Private channel/thread content still requires current parent access.",
    manageCommand: `raft thread unfollow --target "${channelRef}:<thread-short-id>"`,
    manageApi: "POST /internal/agent-api/threads/unfollow",
  };
}

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^@/, "");
  return value || null;
}

function pickTarget(payload: Record<string, unknown>): { target?: TargetRequest; error?: string } {
  const requests: TargetRequest[] = [];
  if (typeof payload.userId === "string" && payload.userId.trim()) {
    requests.push({ type: "human", id: payload.userId.trim() });
  }
  if (typeof payload.agentId === "string" && payload.agentId.trim()) {
    requests.push({ type: "agent", id: payload.agentId.trim() });
  }
  const userHandle = normalizeHandle(payload.user);
  if (userHandle) requests.push({ type: "human", name: userHandle });
  const humanHandle = normalizeHandle(payload.human);
  if (humanHandle) requests.push({ type: "human", name: humanHandle });
  const agentHandle = normalizeHandle(payload.agent);
  if (agentHandle) requests.push({ type: "agent", name: agentHandle });

  if (requests.length === 0) {
    return { error: "One of userId, agentId, user, human, or agent is required" };
  }
  if (requests.length > 1) {
    return { error: "Provide exactly one member target" };
  }
  return { target: requests[0] };
}

type TargetRequest =
  | { type: "human"; id: string; name?: never }
  | { type: "agent"; id: string; name?: never }
  | { type: "human"; name: string; id?: never }
  | { type: "agent"; name: string; id?: never };

async function resolveTarget(serverId: string, request: TargetRequest): Promise<{ target?: Target; error?: string }> {
  if (request.type === "human") {
    if (request.id) {
      const role = await getActorServerRoleInServer(serverId, "user", request.id);
      if (!role) return { error: "User is not a member of this server" };
      const human = (await serverService.getServerMembers(serverId, null)).find((candidate) => candidate.userId === request.id);
      return { target: { type: "human", id: request.id, name: human?.name ?? request.id } };
    }
    const human = (await serverService.getServerMembers(serverId, null)).find((candidate) => candidate.name === request.name);
    if (!human) return { error: "User is not a member of this server" };
    return { target: { type: "human", id: human.userId, name: human.name } };
  }

  if (request.id) {
    const agent = await agentService.getAgent(request.id);
    if (!agent || agent.serverId !== serverId) return { error: "Agent not found in this server" };
    return { target: { type: "agent", id: agent.id, name: agent.name } };
  }
  const agent = (await agentService.listAgents(serverId)).find((candidate) => candidate.name === request.name);
  if (!agent) return { error: "Agent not found in this server" };
  return { target: { type: "agent", id: agent.id, name: agent.name } };
}

function emitChannelMembersUpdated(
  io: SocketServer | undefined,
  serverId: string,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  addedUserId?: string,
) {
  if (addedUserId) {
    io?.to(`user:${addedUserId}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  }
  if (channel.type === "private") {
    io?.to(`channel:${channel.id}`).emit("channel:members-updated", { channelId: channel.id });
    return;
  }
  io?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
}

async function broadcastMembershipSystemMessage(
  io: SocketServer | undefined,
  agentOrchestrator: AgentOrchestrator | undefined,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  target: Target,
  action: "added" | "removed",
  actor: AgentChannelMemberActor,
  persistedMessage?: Awaited<ReturnType<typeof messageService.createMessage>>,
) {
  if (!io || !agentOrchestrator) return;
  let targetAgentIds: string[] | undefined;
  if (target.type === "agent" && action === "removed" && channel.type !== "channel") {
    const remainingAgents = await channelService.getChannelAgents(channel.id);
    targetAgentIds = remainingAgents
      .filter((candidate) => candidate.id !== target.id)
      .map((candidate) => candidate.id);
  }
  const broadcast = persistedMessage
    ? messageService.broadcastSystemMessageToLocalSurfaces
    : messageService.broadcastSystemMessage;
  await broadcast(
    io,
    agentOrchestrator,
    channel.id,
    action === "added"
      ? `@${target.name} was added to this channel.`
      : `@${target.name} was removed from this channel.`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: target.type === "agent" ? "channel.agent_membership" : "channel.human_membership",
        reason: `${target.type} membership changes are shared channel activity`,
      },
      // The agent that added/removed the member should not see its own action
      // as unread.
      causalActor: { type: "agent", id: actor.id },
      targetAgentIds,
      persistedMessage,
    },
  );
}

export async function addChannelMemberForAgent(input: {
  actor: AgentChannelMemberActor;
  serverId: string;
  channelId: string;
  body: unknown;
  io?: SocketServer;
  agentOrchestrator?: AgentOrchestrator;
}): Promise<AgentChannelMemberAddResult> {
  const { actor, serverId, channelId, body, io, agentOrchestrator } = input;
  addTraceEvent("agent_channel_member_add.request.started", {
    actor_server_match: actor.serverId === serverId,
  });

  if (actor.serverId !== serverId) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "channel_not_found",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.type === "thread") {
    addTraceEvent("agent_channel_member_add.validation.failed", { reason: "thread_channel" });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "thread_channel",
      status_code: 400,
    });
    return { status: 400, body: { error: "Thread membership is managed via follow/unfollow" } };
  }
  if (channel.type !== "channel" && channel.type !== "private") {
    addTraceEvent("agent_channel_member_add.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only regular public or private channels are supported" } };
  }
  const canAccessChannel = await channelService.canAgentAccessChannel(channel.id, actor.id);
  const actorRole = await getActorServerRoleInServer(serverId, "agent", actor.id);
  const canManageUnjoined = actorRole === "owner" || actorRole === "admin";
  if (!canAccessChannel && !canManageUnjoined) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.archivedAt) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "channel_archived",
      status_code: 409,
    });
    return { status: 409, body: { error: "This channel is archived", code: "channel_archived" } };
  }
  const hasAuthority = await actorHasChannelCapability(serverId, channel.id, "agent", actor.id, "addChannelMembers");
  addTraceEvent("agent_channel_member_add.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "addChannelMembers",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { status: 403, body: { error: "Agent requires addChannelMembers capability to add channel members" } };
  }

  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const requested = pickTarget(payload);
  if (!requested.target) {
    addTraceEvent("agent_channel_member_add.validation.failed", { reason: "invalid_target" });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "invalid_target",
      status_code: 400,
    });
    return { status: 400, body: { error: requested.error ?? "Invalid member target" } };
  }

  const resolved = await resolveTarget(serverId, requested.target);
  if (!resolved.target) {
    addTraceEvent("agent_channel_member_add.validation.failed", {
      reason: requested.target.type === "agent" ? "agent_not_found" : "user_not_server_member",
    });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: requested.target.type === "agent" ? "agent_not_found" : "user_not_server_member",
      status_code: 400,
    });
    return { status: 400, body: { error: resolved.error ?? "Member not found" } };
  }

  const target = resolved.target;
  let alreadyMember = false;

  try {
    if (target.type === "agent") {
      const added = await withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "addChannelMembers",
      }, (tx) => channelService.addAgent(channel.id, target.id, { executor: tx }));
      alreadyMember = !added;
      if (!alreadyMember) {
        await broadcastMembershipSystemMessage(io, agentOrchestrator, channel, target, "added", actor);
      }
    } else {
      const persisted = await withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "addChannelMembers",
      }, (tx) => messageService.addHumanWithMembershipSystemMessage({
        channel,
        userId: target.id,
        userName: target.name,
        causalActor: { type: "agent", id: actor.id },
        executor: tx,
      }));
      alreadyMember = !persisted.added;
      if (persisted.added) {
        await broadcastMembershipSystemMessage(
          io,
          agentOrchestrator,
          channel,
          target,
          "added",
          actor,
          persisted.message,
        );
      }
    }
    emitChannelMembersUpdated(io, serverId, channel, target.type === "human" ? target.id : undefined);
    addTraceEvent("agent_channel_member_add.added", {
      target_type: target.type,
      already_member: alreadyMember,
      channel_visibility: channel.type === "private" ? "private" : "public",
    });
    addTraceEvent("agent_channel_member_add.broadcasted", {
      target_type: target.type,
      channel_visibility: channel.type === "private" ? "private" : "public",
    });
    return {
      status: 200,
      body: {
        ok: true,
        alreadyMember,
        channelId: channel.id,
        member: { type: target.type, id: target.id, name: target.name },
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === "Channel capability required") {
      addTraceEvent("agent_channel_member_add.request.failed", {
        reason: "capability_required_under_lock",
        status_code: 403,
      });
      return { status: 403, body: { error: "Agent requires addChannelMembers capability to add channel members" } };
    }
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: err instanceof Error ? err.name : typeof err,
    });
    return { status: 500, body: { error: "Failed to add member" } };
  }
}

export async function removeChannelMemberForAgent(input: {
  actor: AgentChannelMemberActor;
  serverId: string;
  channelId: string;
  body: unknown;
  io?: SocketServer;
  agentOrchestrator?: AgentOrchestrator;
}): Promise<AgentChannelMemberRemoveResult> {
  const { actor, serverId, channelId, body, io, agentOrchestrator } = input;
  addTraceEvent("agent_channel_member_remove.request.started", {
    actor_server_match: actor.serverId === serverId,
  });

  if (actor.serverId !== serverId) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "channel_not_found",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.type === "thread") {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "thread_channel" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "thread_channel",
      status_code: 400,
    });
    return { status: 400, body: { error: "Thread membership is managed via follow/unfollow" } };
  }
  if (channel.type !== "channel" && channel.type !== "private") {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only regular public or private channels are supported" } };
  }
  if (channelService.isAllSystemChannel(channel)) {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "all_channel" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "all_channel",
      status_code: 403,
    });
    return { status: 403, body: { error: "Cannot remove members from the #all channel" } };
  }
  if (!await channelService.canAgentAccessChannel(channel.id, actor.id)) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  const hasAuthority = await actorHasChannelCapability(serverId, channel.id, "agent", actor.id, "removeChannelMembers");
  addTraceEvent("agent_channel_member_remove.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "removeChannelMembers",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { status: 403, body: { error: "Agent requires removeChannelMembers capability to remove channel members" } };
  }
  if (channel.archivedAt) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "channel_archived",
      status_code: 409,
    });
    return { status: 409, body: { error: "This channel is archived", code: "channel_archived" } };
  }

  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const requested = pickTarget(payload);
  if (!requested.target) {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "invalid_target" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "invalid_target",
      status_code: 400,
    });
    return { status: 400, body: { error: requested.error ?? "Invalid member target" } };
  }

  const resolved = await resolveTarget(serverId, requested.target);
  if (!resolved.target) {
    addTraceEvent("agent_channel_member_remove.validation.failed", {
      reason: requested.target.type === "agent" ? "agent_not_found" : "user_not_server_member",
    });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: requested.target.type === "agent" ? "agent_not_found" : "user_not_server_member",
      status_code: 400,
    });
    return { status: 400, body: { error: resolved.error ?? "Member not found" } };
  }

  const target = resolved.target;
  const wasMember = target.type === "agent"
    ? await channelService.isChannelAgent(channel.id, target.id)
    : await channelService.isChannelHuman(channel.id, target.id);

  try {
    if (target.type === "agent") {
      await withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "removeChannelMembers",
      }, (tx) => channelService.removeAgent(channel.id, target.id, tx));
      if (wasMember) {
        await broadcastMembershipSystemMessage(io, agentOrchestrator, channel, target, "removed", actor);
      }
      if (wasMember && channel.type !== "channel") {
        await agentOrchestrator?.purgeAgentInboxForChannelTree(
          target.id,
          channel.id,
          "channel_membership_removed",
        );
      }
    } else {
      await withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "removeChannelMembers",
      }, (tx) => channelService.removeHuman(channel.id, target.id, tx));
      await revokeSocketAccess({ userId: target.id });
    }
    emitChannelMembersUpdated(io, serverId, channel);
    addTraceEvent("agent_channel_member_remove.removed", {
      target_type: target.type,
      was_member: wasMember,
      channel_visibility: channel.type === "private" ? "private" : "public",
    });
    return {
      status: 200,
      body: {
        ok: true,
        wasMember,
        channelId: channel.id,
        member: { type: target.type, id: target.id, name: target.name },
        ...(wasMember ? { attention: buildChannelMemberRemovalAttention(channel, target) } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("Cannot remove") || msg === "Channel capability required") {
      addTraceEvent("agent_channel_member_remove.request.failed", {
        reason: "forbidden_remove",
        status_code: 403,
      });
      return { status: 403, body: { error: msg } };
    }
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: err instanceof Error ? err.name : typeof err,
    });
    return { status: 500, body: { error: "Failed to remove member" } };
  }
}
