import type { RefusalInput } from "../lib/refusal";
import { AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL, isLoungeOutsiderAgent } from "../services/agentLoungeService";
import { formatLastMemberRefusal, isSubConversationType, LAST_MEMBER_DELETES_CHANNEL } from "@botiverse/raft-shared";
import { revokeSocketAccess } from "../socket/accessRevocation";
import type { Server as SocketServer } from "socket.io";
import * as agentService from "../services/agentService";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import * as serverService from "../services/serverService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { actorHasChannelCapability, resolveChannelActorContext, channelActorHasCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { agentRefusalBody, agentServerRoleRequiredBody, asSentence } from "../lib/agentServerRoleRequired";

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

/**
 * A removal an agent asked for, or null when it was refused because it would
 * have deleted a private channel with its last member and the agent didn't
 * pass `deleteIfLast` (nothing changed: the transaction rolled back).
 */
export async function removeUnlessLastMember(remove: () => Promise<channelService.ChannelMemberRemoval>): Promise<channelService.ChannelMemberRemoval | null> {
  try {
    return await remove();
  } catch (err) {
    if (err instanceof channelService.LastPrivateMemberError) return null;
    throw err;
  }
}

/** 409 `last_member_deletes_channel`: what it would have deleted, and the call that does it (CLI form; the SDK writes its own). */
export function lastMemberRefusalBody(input: { target: string; member?: { user: string } | { agent: string } }) {
  const { message, nextAction } = formatLastMemberRefusal(input);
  return agentRefusalBody(message, LAST_MEMBER_DELETES_CHANNEL, nextAction);
}

/** The same refusal for refuse(). */
export function lastMemberRefusal(input: { target: string; member?: { user: string } | { agent: string } }): RefusalInput {
  const { message, nextAction } = formatLastMemberRefusal(input);
  return { code: LAST_MEMBER_DELETES_CHANNEL, error: message, suggestedNextAction: nextAction };
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

async function resolveTarget(serverId: string, request: TargetRequest, jointRemovalChannelId?: string): Promise<{ target?: Target; error?: string }> {
  if (jointRemovalChannelId) {
    // Resolve only visible current J members, never a global agent directory.
    const members = await channelService.getChannelMembers(jointRemovalChannelId);
    const candidates = request.type === "human" ? members.humans : members.agents;
    const matches = candidates.filter(candidate => request.id ? candidate.id === request.id : candidate.name === request.name);
    if (matches.length !== 1) return { error: matches.length ? "Member handle is ambiguous; use its ID" : "Member not found in this channel" };
    return { target: { type: request.type, id: matches[0]!.id, name: matches[0]!.name } };
  }
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

  // A personal assistant is no channel's member but its owner DM's, and
  // nobody else may find it (agentFindableBy): it reads as not found, by id or
  // by handle, rather than refused later by addAgent.
  if (request.id) {
    const agent = await agentService.getAgent(request.id);
    if (!agent || agent.serverId !== serverId || agent.assistantOwnerUserId) return { error: "Agent not found in this server" };
    return { target: { type: "agent", id: agent.id, name: agent.name } };
  }
  const agent = (await agentService.listAgents(serverId)).find((candidate) => candidate.name === request.name && !candidate.assistantOwnerUserId);
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
        causalActor: { type: "agent", id: actor.id },
      },
      // The agent that added/removed the member should not see its own action
      // as unread.
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
  const canAccessChannel = await channelService.canAgentAccessChannel(channel.id, actor.id);
  const actorRole = await getActorServerRoleInServer(serverId, "agent", actor.id);
  // Same rule as the human route: owner/admin may add to a public or private
  // channel they are not in, never to a joint channel (#wg-rbac B6). Checked
  // before the channel-type refusals so an id the agent cannot see answers
  // 404 whatever its type, exactly like an id that does not exist (B14).
  const canManageUnjoined = (actorRole === "owner" || actorRole === "admin")
    && (channel.type === "channel" || channel.type === "private");
  if (!canAccessChannel && !canManageUnjoined) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (isSubConversationType(channel.type)) {
    addTraceEvent("agent_channel_member_add.validation.failed", { reason: "thread_channel" });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "thread_channel",
      status_code: 400,
    });
    return { status: 400, body: { error: "Thread membership is managed via follow/unfollow" } };
  }
  // Joint channels carry ordinary membership under the same admission rules
  // (canAddChannelMembers): candidates resolve from this server only, and the
  // write lands on this server's projection, exactly as for a human admin.
  if (channel.type !== "channel" && channel.type !== "private" && channel.type !== "joint") {
    addTraceEvent("agent_channel_member_add.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only public, private, or joint channels are supported" } };
  }
  if (channel.archivedAt) {
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "channel_archived",
      status_code: 409,
    });
    return { status: 409, body: { error: "This channel is archived", code: "channel_archived" } };
  }
  // Two refusals the role check would misreport as "ask an admin".
  if (channelService.isAllSystemChannel(channel)) {
    addTraceEvent("agent_channel_member_add.request.failed", { reason: "all_channel", status_code: 403 });
    return {
      status: 403,
      body: agentRefusalBody(
        "Cannot add members to the #all channel",
        "all_channel_membership_fixed",
        "Everyone on the server is already in #all; there is nobody to add. Do not retry.",
      ),
    };
  }
  // Owners and admins may add without being in the channel; members must be in it.
  if (!canManageUnjoined && !await channelService.isChannelAgent(channel.id, actor.id)) {
    addTraceEvent("agent_channel_member_add.request.failed", { reason: "channel_membership_required", status_code: 403 });
    return {
      status: 403,
      body: agentRefusalBody(
        "Agent must be a member of this channel to add members",
        "channel_membership_required",
        `Join #${channel.name} first (for a private channel, ask a member to add you), then retry.`,
      ),
    };
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
    return { status: 403, body: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["addChannelMembers"], action: "add channel members" }) };
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
  if (target.type === "agent" && await isLoungeOutsiderAgent(channel.id, target.id)) {
    addTraceEvent("agent_channel_member_add.request.failed", { reason: "agent_lounge_outsider", status_code: 403 });
    return { status: 403, body: { error: AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL, code: "agent_lounge_outsider" } };
  }
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
        humanSubjectIds: [target.id],
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
    if (err instanceof Error && err.message === channelService.ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE) {
      return {
        status: 403,
        body: agentRefusalBody(
          err.message,
          channelService.ASSISTANT_CHANNEL_FORBIDDEN_CODE,
          "A personal assistant stays in its DM with its owner and cannot be added to channels. Do not retry.",
        ),
      };
    }
    if (err instanceof Error && err.message === "Channel capability required") {
      addTraceEvent("agent_channel_member_add.request.failed", {
        reason: "capability_required_under_lock",
        status_code: 403,
      });
      return { status: 403, body: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["addChannelMembers"], action: "add channel members" }) };
    }
    addTraceEvent("agent_channel_member_add.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: errorClassOf(err),
    });
    return { status: 500, body: { error: "Failed to add member" } };
  }
}

function lastMemberRefused(channel: { name: string }, target: Target): AgentChannelMemberRemoveResult {
  addTraceEvent("agent_channel_member_remove.request.failed", {
    reason: "last_member_deletes_channel",
    status_code: 409,
  });
  const member = target.type === "agent" ? { agent: `@${target.name}` } : { user: `@${target.name}` };
  return { status: 409, body: lastMemberRefusalBody({ target: `#${channel.name}`, member }) };
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
  // Visibility before the channel-type refusals: an id the agent cannot see
  // answers 404 whatever its type, exactly like an id that does not exist
  // (#wg-rbac B14). Removing still requires seeing the channel, whatever the
  // agent's server role.
  if (!await channelService.canAgentAccessChannel(channel.id, actor.id)) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (isSubConversationType(channel.type)) {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "thread_channel" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "thread_channel",
      status_code: 400,
    });
    return { status: 400, body: { error: "Thread membership is managed via follow/unfollow" } };
  }
  // Joint channels carry ordinary membership under the same admission rules
  // (canAddChannelMembers): candidates resolve from this server only, and the
  // write lands on this server's projection, exactly as for a human admin.
  if (channel.type !== "channel" && channel.type !== "private" && channel.type !== "joint") {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only public, private, or joint channels are supported" } };
  }
  if (channelService.isAllSystemChannel(channel)) {
    addTraceEvent("agent_channel_member_remove.validation.failed", { reason: "all_channel" });
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "all_channel",
      status_code: 403,
    });
    return {
      status: 403,
      body: agentRefusalBody(
        "Cannot remove members from the #all channel",
        "all_channel_membership_fixed",
        "Everyone on the server is in #all, so nobody can be removed from it. Do not retry.",
      ),
    };
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

  const actorContext = await resolveChannelActorContext(serverId, channel.id, "agent", actor.id);
  const memberTargetType = requested.target.type === "agent" ? "agent" : "user";
  const hasAuthority = actorContext ? channelActorHasCapability(actorContext, "removeChannelMembers", memberTargetType) : false;
  addTraceEvent("agent_channel_member_remove.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "removeChannelMembers",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { status: 403, body: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["removeChannelMembers"], action: "remove channel members", channelAdminIn: channel.type === "joint" ? undefined : channel.name }) };
  }
  if (channel.archivedAt) {
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "channel_archived",
      status_code: 409,
    });
    return { status: 409, body: { error: "This channel is archived", code: "channel_archived" } };
  }

  const resolved = await resolveTarget(serverId, requested.target, actorContext?.jointAuthority ? channel.id : undefined);
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
  const targetChannel = target.type === "agent" ? await channelService.getJointAgentRemovalChannel(channel.id, target.id) : channel;
  const lastMember = payload.deleteIfLast === true ? "delete" : "refuse";
  const wasMember = target.type === "agent"
    ? Boolean(targetChannel && await channelService.isChannelAgent(targetChannel.id, target.id))
    : await channelService.isChannelHuman(channel.id, target.id);

  try {
    let removal: channelService.ChannelMemberRemoval | null;
    if (target.type === "agent") {
      removal = await removeUnlessLastMember(() => withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "removeChannelMembers",
        memberTargetType: "agent",
      }, (tx, context) => channelService.removeAgent(channel.id, target.id, tx, context, lastMember)));
      if (!removal) return lastMemberRefused(channel, target);
      if (wasMember && targetChannel && !removal.channelDeleted) {
        await broadcastMembershipSystemMessage(io, agentOrchestrator, targetChannel, target, "removed", actor);
      }
      if (wasMember && targetChannel && channel.type !== "channel") {
        await agentOrchestrator?.purgeAgentInboxForChannelTree(
          target.id,
          targetChannel.id,
          "channel_membership_removed",
        );
      }
    } else {
      removal = await removeUnlessLastMember(() => withLockedChannelActorCapability({
        serverId,
        channelId: channel.id,
        actorType: "agent",
        actorId: actor.id,
        capability: "removeChannelMembers",
        humanSubjectIds: [target.id],
      }, (tx, context) => channelService.removeHuman(channel.id, target.id, context, tx, lastMember)));
      if (!removal) return lastMemberRefused(channel, target);
      await channelService.finishChannelMemberRemoval(removal, target.id);
    }
    emitChannelMembersUpdated(io, serverId, channel);
    if (target.type === "agent" && channel.type === "joint") {
      for (const projection of await channelService.getActiveJointChannelProjectionsByLocalChannel(channel.id)) {
        if (projection.localChannelId !== channel.id) io?.to(`channel:${projection.localChannelId}`).emit("channel:members-updated", { channelId: projection.localChannelId });
      }
    }
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
        ...(removal.channelDeleted ? { channelDeleted: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Channel capability required") {
      addTraceEvent("agent_channel_member_remove.request.failed", {
        reason: "capability_required_under_lock",
        status_code: 403,
      });
      return { status: 403, body: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["removeChannelMembers"], action: "remove channel members", channelAdminIn: channel.type === "joint" ? undefined : channel.name }) };
    }
    if (msg.includes("Cannot remove")) {
      addTraceEvent("agent_channel_member_remove.request.failed", {
        reason: "forbidden_remove",
        status_code: 403,
      });
      return { status: 403, body: agentRefusalBody(msg, "channel_member_remove_forbidden", `${asSentence(msg)} Nobody can do this; do not retry.`) };
    }
    addTraceEvent("agent_channel_member_remove.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: errorClassOf(err),
    });
    return { status: 500, body: { error: "Failed to remove member" } };
  }
}
