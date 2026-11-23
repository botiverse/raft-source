// An agent changes a channel member's channel role on its own authority
// (`POST /internal/agent-api/channels/member-role`, `raft channel set-role`).
// The rule, the locks and the refusals are the web route's
// (PATCH /api/channels/:id/members/:targetType/:memberId/role): both call
// channelService.changeChannelMembershipRole, with the agent as the requester,
// and both deliver through deliverChannelMembershipRoleChange.

import type { Server as SocketServer } from "socket.io";
import { RAFT_HINTS, type AgentApiChannelMemberRoleBody, type AgentApiChannelMemberRoleResponse } from "@botiverse/raft-shared";
import type { RefusalInput, RefusalStatus } from "../lib/refusal";
import { actorHasChannelCapability } from "../lib/channelActorPermissions";
import * as agentService from "../services/agentService";
import * as channelService from "../services/channelService";
import * as serverService from "../services/serverService";
import { deliverChannelMembershipRoleChange } from "../services/channelMembershipRoleOutbox";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";

export type AgentChannelMemberRoleResult =
  | { ok: true; body: AgentApiChannelMemberRoleResponse }
  | { ok: false; status: RefusalStatus; refusal: RefusalInput };

type MemberRequest = { type: "user" | "agent"; name: string };

function handle(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^@/, "");
}

/** A server member by handle, of the kind asked for; a personal assistant is no channel's member and is never found. */
async function resolveMember(serverId: string, request: MemberRequest): Promise<{ id: string; name: string } | null> {
  if (request.type === "user") {
    const human = (await serverService.getServerMembers(serverId, null)).find((candidate) => candidate.name === request.name);
    return human ? { id: human.userId, name: human.name } : null;
  }
  const agent = (await agentService.listAgents(serverId)).find((candidate) => candidate.name === request.name && !candidate.assistantOwnerUserId);
  return agent ? { id: agent.id, name: agent.name } : null;
}

/** The web route's refusal for the same error: its status, code and sentence, and a next step for an agent. */
function roleMutationRefusal(err: channelService.ChannelMembershipRoleMutationError, channelTarget: string, joint: boolean): { status: RefusalStatus; refusal: RefusalInput } {
  // On a joint channel only the host server's owners and admins change roles.
  const whoChanges = joint ? `an owner or admin of the host server of ${channelTarget}` : null;
  const sameAsWeb = { code: err.code, error: err.message };
  switch (err.code) {
    case "channel_not_found":
      return { status: 404, refusal: AGENT_CHANNEL_NOT_FOUND_REFUSAL };
    case "channel_capability_required":
      return { status: 403, refusal: { ...sameAsWeb, suggestedNextAction: whoChanges ? `Ask ${whoChanges} to change it.` : `Ask a channel admin of ${channelTarget}, or a server owner or admin, to change it.` } };
    case "protected_server_role":
      return { status: 403, refusal: { ...sameAsWeb, suggestedNextAction: "Their access comes from their server role; ask a server owner to change that role instead." } };
    case "unsupported_channel_shape":
      return { status: 400, refusal: { ...sameAsWeb, suggestedNextAction: "Channel roles exist only on public, private and joint channels; do not retry on this one." } };
    case "channel_member_required":
      return { status: 409, refusal: { ...sameAsWeb, next: RAFT_HINTS.channelMembers(channelTarget) } };
    case "channel_admin_self_demote_forbidden":
    case "channel_membership_conflict":
      return { status: 409, refusal: { ...sameAsWeb, suggestedNextAction: whoChanges ? `Ask ${whoChanges} to change your role.` : `Ask another channel admin of ${channelTarget}, or a server owner or admin, to change your role.` } };
    case "channel_archived":
      return { status: 409, refusal: { ...sameAsWeb, suggestedNextAction: `Unarchive ${channelTarget} first, then change the role.` } };
    case "guest_channel_admin_forbidden":
      return { status: 409, refusal: { ...sameAsWeb, suggestedNextAction: "A guest stays a plain member; ask a server owner or admin to make them a server member first." } };
  }
}

export async function setChannelMemberRoleForAgent(input: {
  agentId: string;
  serverId: string;
  body: AgentApiChannelMemberRoleBody;
  io?: SocketServer;
}): Promise<AgentChannelMemberRoleResult> {
  const { agentId, serverId, body, io } = input;
  const resolved = await channelService.resolveChannelByName(serverId, agentId, body.target);
  const channel = resolved ? await channelService.getChannel(resolved.channelId) : null;
  if (!channel || channel.serverId !== serverId) {
    return { ok: false, status: 404, refusal: AGENT_CHANNEL_NOT_FOUND_REFUSAL };
  }
  const channelTarget = `#${channel.name}`;

  // Refuse before resolving a target: different unknown/member answers must
  // not turn an unauthorized role change into a hidden-directory lookup.
  // The mutation still rechecks the same capability under its locks below.
  if (!await actorHasChannelCapability(serverId, channel.id, "agent", agentId, "changeChannelMemberRoles")) {
    return { ok: false, ...roleMutationRefusal(new channelService.ChannelMembershipRoleMutationError(
      "channel_capability_required", "You do not have permission to change channel member roles",
    ), channelTarget, channel.type === "joint") };
  }

  const user = handle(body.user);
  const agent = handle(body.agent);
  if ((user ? 1 : 0) + (agent ? 1 : 0) !== 1) {
    return {
      ok: false,
      status: 400,
      refusal: {
        code: "invalid_member_target",
        error: "Name exactly one member: a person by `user` or an agent by `agent`, as a handle.",
        next: RAFT_HINTS.channelMembers(channelTarget),
      },
    };
  }
  const request: MemberRequest = user ? { type: "user", name: user } : { type: "agent", name: agent };
  const member = await resolveMember(serverId, request);
  if (!member) {
    // An unknown handle reads like a server member outside the channel.
    return { ok: false, status: 409, refusal: { code: "channel_member_required", error: "Target must already be a channel member", next: RAFT_HINTS.channelMembers(channelTarget) } };
  }

  let result: Awaited<ReturnType<typeof channelService.changeChannelMembershipRole>>;
  try {
    result = await channelService.changeChannelMembershipRole({
      serverId,
      channelId: channel.id,
      requester: { type: "agent", id: agentId },
      targetType: request.type,
      targetId: member.id,
      nextRole: body.role,
    });
  } catch (err) {
    if (err instanceof channelService.ChannelMembershipRoleMutationError) {
      return { ok: false, ...roleMutationRefusal(err, channelTarget, channel.type === "joint") };
    }
    throw err;
  }
  if (result.changed) await deliverChannelMembershipRoleChange(io, channel, result);
  return {
    ok: true,
    body: {
      ok: true,
      changed: result.changed,
      channelId: channel.id,
      member: { type: request.type === "user" ? "human" : "agent", id: member.id, name: member.name },
      channelRole: result.channelRole,
    },
  };
}
