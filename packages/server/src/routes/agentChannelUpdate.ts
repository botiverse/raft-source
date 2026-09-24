import { publishChannelUpdate } from "../services/channelRealtimeEvents.js";
import { validateName } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import * as channelService from "../services/channelService.js";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { actorHasChannelCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

export interface AgentChannelUpdateActor {
  id: string;
  name: string;
  serverId: string;
}

export interface AgentChannelUpdateResult {
  status: number;
  body: Record<string, unknown>;
}

function parseVisibility(raw: unknown): channelService.RegularChannelType | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === "public" || raw === "channel") return "channel";
  if (raw === "private") return "private";
  return null;
}

export async function updateChannelForAgent(input: {
  actor: AgentChannelUpdateActor;
  serverId: string;
  channelId: string;
  body: unknown;
  io?: SocketServer;
}): Promise<AgentChannelUpdateResult> {
  const { actor, serverId, channelId, body, io } = input;
  addTraceEvent("agent_channel_update.request.started", {
    actor_server_match: actor.serverId === serverId,
  });

  if (actor.serverId !== serverId) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "channel_not_found",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.type !== "channel" && channel.type !== "private") {
    addTraceEvent("agent_channel_update.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only regular public or private channels are supported" } };
  }
  if (!await channelService.canAgentAccessChannel(channel.id, actor.id)) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.archivedAt) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "channel_archived",
      status_code: 409,
    });
    return { status: 409, body: { error: "This channel is archived", code: "channel_archived" } };
  }

  const [canEditChannelMetadata, canChangeChannelVisibility] = await Promise.all([
    actorHasChannelCapability(serverId, channel.id, "agent", actor.id, "editChannelMetadata"),
    actorHasServerCapabilityInServer(serverId, "agent", actor.id, "changeChannelVisibility"),
  ]);
  const hasAuthority = canEditChannelMetadata || canChangeChannelVisibility;
  addTraceEvent("agent_channel_update.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capabilities: "editChannelMetadata,changeChannelVisibility",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return {
      status: 403,
      body: {
        error: "Agent requires editChannelMetadata or changeChannelVisibility capability to update channels",
      },
    };
  }

  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const updates: { name?: string; description?: string; type?: channelService.RegularChannelType } = {};

  if ((payload.name !== undefined || payload.description !== undefined) && !canEditChannelMetadata) {
    return { status: 403, body: { error: "Agent lacks permission to edit channel metadata" } };
  }
  if (payload.visibility !== undefined && !canChangeChannelVisibility) {
    return { status: 403, body: { error: "Agent lacks permission to change channel visibility" } };
  }
  // #all is human-managed only (@cindyz, 2026-09-07, #wg-rbac msg=c1a72093).
  // This is the exact call that produced the incident report: an admin agent ran
  // `channel update --private` against #all, the write succeeded, and every later
  // agent call -- including the attempt to undo it -- returned "Channel not found",
  // because hiding #all removes the derived audience the agent was reaching it
  // through. Refuse before the write, and say where a human can do it instead.
  if (payload.visibility !== undefined && channelService.isAllSystemChannel(channel)) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "all_channel_visibility_managed_separately",
      status_code: 403,
    });
    return {
      status: 403,
      body: {
        error: channelService.ALL_CHANNEL_VISIBILITY_REFUSAL,
        code: "all_channel_visibility_managed_separately",
      },
    };
  }
  // Membership is required to change visibility, for agents as for humans. A
  // public channel needs no membership row to be reachable, so without this an
  // agent that was never a member could turn a channel private and then be locked
  // out of the channel it had just changed.
  if (payload.visibility !== undefined && !await channelService.isChannelAgent(channel.id, actor.id)) {
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "channel_membership_required",
      status_code: 403,
    });
    return {
      status: 403,
      body: {
        error: "Agent must be a member of this channel to change its visibility",
        code: "channel_membership_required",
      },
    };
  }

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string") {
      addTraceEvent("agent_channel_update.validation.failed", { reason: "invalid_name_type" });
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "invalid_name_type",
        status_code: 400,
      });
      return { status: 400, body: { error: "Channel name must be a string" } };
    }
    const rawName = payload.name.trim().replace(/^#/, "");
    const nameError = validateName(rawName, "Channel name");
    if (nameError) {
      addTraceEvent("agent_channel_update.validation.failed", { reason: "invalid_name" });
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "invalid_name",
        status_code: 400,
      });
      return { status: 400, body: { error: nameError } };
    }
    updates.name = rawName;
  }

  if (payload.description !== undefined) {
    if (typeof payload.description !== "string" || payload.description.length > 500) {
      addTraceEvent("agent_channel_update.validation.failed", { reason: "invalid_description" });
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "invalid_description",
        status_code: 400,
      });
      return { status: 400, body: { error: "Description must be a string of at most 500 characters" } };
    }
    updates.description = payload.description;
  }

  const visibility = parseVisibility(payload.visibility);
  if (visibility === null) {
    addTraceEvent("agent_channel_update.validation.failed", { reason: "invalid_visibility" });
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "invalid_visibility",
      status_code: 400,
    });
    return { status: 400, body: { error: "visibility must be one of: public, private" } };
  }
  if (visibility !== undefined) updates.type = visibility;

  if (updates.name === undefined && updates.description === undefined && updates.type === undefined) {
    addTraceEvent("agent_channel_update.validation.failed", { reason: "empty_update" });
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "empty_update",
      status_code: 400,
    });
    return { status: 400, body: { error: "At least one field is required" } };
  }

  try {
    const updated = await withLockedChannelActorCapability({
      serverId,
      channelId: channel.id,
      actorType: "agent",
      actorId: actor.id,
      capability: "editChannelMetadata",
    }, (tx) => channelService.updateChannel(channel.id, updates, tx));
    const visibilityChanged = updates.type !== undefined && updates.type !== channel.type;
    await channelService.revokeChannelAccessAfterUpdate(updates, updated);
    await publishChannelUpdate(io, updated);
    addTraceEvent("agent_channel_update.updated", {
      renamed: updates.name !== undefined && updates.name !== channel.name,
      description_changed: updates.description !== undefined,
      visibility_changed: visibilityChanged,
      channel_visibility: updated.type === "private" ? "private" : "public",
    });
    return { status: 200, body: updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("already taken")) {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "name_taken",
        status_code: 409,
      });
      return { status: 409, body: { error: msg } };
    }
    if (msg === "Channel capability required") {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "capability_required",
        status_code: 403,
      });
      return { status: 403, body: { error: "Agent lacks permission to edit channel metadata" } };
    }
    if (msg.includes("Cannot rename") || msg.includes("Cannot edit") || msg.includes("Cannot change visibility") || msg.includes("reserved")) {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "forbidden_update",
        status_code: 403,
      });
      return { status: 403, body: { error: msg } };
    }
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: err instanceof Error ? err.name : typeof err,
    });
    return { status: 500, body: { error: "Failed to update channel" } };
  }
}
