import { emitJointProjectionUpdates, publishChannelUpdate } from "../services/channelRealtimeEvents";
import { asServerId, validateName, type ServerId } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import * as channelService from "../services/channelService";
import { archivedNameCollisionBody } from "./archivedNameCollision";
import * as messageService from "../services/messageService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { actorHasChannelCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { agentRefusalBody, agentServerRoleRequiredBody, asSentence } from "../lib/agentServerRoleRequired";
import { refusalBody } from "../lib/refusal";
import { attachChannelAnnouncement, channelAnnouncementChange } from "../services/channelAnnouncements";
import { postChannelAnnouncementChange } from "../services/channelAnnouncementMessages";

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
  agentOrchestrator?: AgentOrchestrator;
}): Promise<AgentChannelUpdateResult> {
  const { actor, serverId, channelId, body, io, agentOrchestrator } = input;
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
  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const viewer = { type: "agent" as const, id: actor.id, serverId: asServerId(serverId) };
  // Joint channels take the same name/description edits as for a human admin;
  // visibility stays fixed (updateChannel refuses it for joint).
  if (channel.type !== "channel" && channel.type !== "private" && channel.type !== "joint") {
    // A DM or a thread has no announcement: say so, rather than the generic refusal.
    if (payload.announcement !== undefined) {
      const change = await channelAnnouncementChange({ actor: viewer, channel, raw: payload.announcement, canEditChannelMetadata: false });
      if (!change.ok) {
        addTraceEvent("agent_channel_update.request.failed", { reason: change.refusal.code, status_code: change.status });
        return { status: change.status, body: { ...refusalBody(change.refusal) } };
      }
    }
    addTraceEvent("agent_channel_update.validation.failed", { reason: "unsupported_channel_type" });
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return { status: 400, body: { error: "Only public, private, or joint channels are supported" } };
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
  // Channel announcements (channel_announcement_v0): the flag, then editChannelMetadata (the channel's owner, a
  // channel admin, or a server owner or admin), then an Artifact homed here. Checked before the generic
  // authority refusal so a refused agent is told who may set it.
  let announcementArtifactId: string | null | undefined;
  if (payload.announcement !== undefined) {
    const change = await channelAnnouncementChange({ actor: viewer, channel, raw: payload.announcement, canEditChannelMetadata });
    if (!change.ok) {
      addTraceEvent("agent_channel_update.request.failed", { reason: change.refusal.code, status_code: change.status });
      return { status: change.status, body: { ...refusalBody(change.refusal) } };
    }
    announcementArtifactId = change.artifactId;
  }
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
      body: await agentServerRoleRequiredBody({
        serverId,
        agentId: actor.id,
        capabilities: ["editChannelMetadata", "changeChannelVisibility"],
        action: "update channels",
        channelAdminIn: channel.name,
      }),
    };
  }

  const updates: { name?: string; description?: string; type?: channelService.RegularChannelType; announcementArtifactId?: string | null } = {};
  if (announcementArtifactId !== undefined) updates.announcementArtifactId = announcementArtifactId;

  if ((payload.name !== undefined || payload.description !== undefined) && !canEditChannelMetadata) {
    return {
      status: 403,
      body: {
        ...await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["editChannelMetadata"], action: "rename this channel or edit its description", channelAdminIn: channel.name }),
        error: "Agent lacks permission to edit channel metadata",
      },
    };
  }
  if (payload.visibility !== undefined && !canChangeChannelVisibility) {
    return {
      status: 403,
      body: {
        ...await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["changeChannelVisibility"], action: "change channel visibility" }),
        error: "Agent lacks permission to change channel visibility",
      },
    };
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
      body: agentRefusalBody(
        channelService.ALL_CHANNEL_VISIBILITY_REFUSAL,
        "all_channel_visibility_managed_separately",
        "Only a human can hide or restore #all, from channel settings or server settings. Ask a server owner or admin; do not retry this call.",
      ),
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
      body: agentRefusalBody(
        "Agent must be a member of this channel to change its visibility",
        "channel_membership_required",
        "Join this channel first (for a private channel, ask a member to add you), then retry.",
      ),
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

  if (updates.name === undefined && updates.description === undefined && updates.type === undefined && updates.announcementArtifactId === undefined) {
    addTraceEvent("agent_channel_update.validation.failed", { reason: "empty_update" });
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "empty_update",
      status_code: 400,
    });
    return { status: 400, body: { error: "At least one field is required" } };
  }

  try {
    // The announcement as it was under the lock: which change the event line names (set, replaced, removed).
    let announcementBefore: string | null = channel.announcementArtifactId ?? null;
    const updated = await withLockedChannelActorCapability({
      serverId,
      channelId: channel.id,
      actorType: "agent",
      actorId: actor.id,
      capability: "editChannelMetadata",
    }, async (tx) => {
      if (updates.announcementArtifactId !== undefined) {
        const before = await channelService.getChannel(channel.id, { executor: tx });
        if (before) announcementBefore = before.announcementArtifactId ?? null;
      }
      return channelService.updateChannel(channel.id, updates, tx);
    });
    const visibilityChanged = updates.type !== undefined && updates.type !== channel.type;
    const renamed = updates.name !== undefined && updates.name !== channel.name;
    await channelService.revokeChannelAccessAfterUpdate(updates, updated);
    if (updated.type === "joint") {
      await emitJointProjectionUpdates(io, updated.id);
    } else {
      await publishChannelUpdate(io, updated);
    }
    if (renamed && io && agentOrchestrator) {
      await messageService.broadcastSystemMessage(
        io,
        agentOrchestrator,
        channel.id,
        `@${actor.name} renamed this channel from #${channel.name} to #${updated.name}.`,
        {
          inboxFactPolicy: {
            mode: "record",
            producer: "channel.rename",
            reason: "channel rename is shared channel activity",
            causalActor: { type: "agent", id: actor.id },
          },
        },
      ).catch((err: unknown) => {
        console.error("agentChannelUpdate: failed to broadcast rename system message:", err);
      });
    }
    // Set, replaced or removed (not a new version of it): one event line, as for a person's change.
    if (updates.announcementArtifactId !== undefined) {
      await postChannelAnnouncementChange({
        io,
        agentOrchestrator,
        channelId: updated.id,
        actor: { type: "agent", id: actor.id },
        before: announcementBefore,
        after: updated.announcementArtifactId ?? null,
      });
    }
    addTraceEvent("agent_channel_update.updated", {
      renamed,
      description_changed: updates.description !== undefined,
      visibility_changed: visibilityChanged,
      announcement_changed: updates.announcementArtifactId !== undefined,
      channel_visibility: updated.type === "private" ? "private" : "public",
    });
    return { status: 200, body: await attachChannelAnnouncement(viewer, updated) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // A channel with external members or open external invites stays private
    // (cindyz; #wg-rbac:#16): the same refusal the human PATCH gives.
    if (err instanceof channelService.ExternalMembersKeepPrivateError) {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "external_members_keep_private",
        status_code: 409,
      });
      return {
        status: 409,
        body: agentRefusalBody(err.message, err.code, `${err.message} Remove its external members and revoke its external invites first; do not retry until then.`),
      };
    }
    if (err instanceof channelService.ArchivedNameCollisionError) {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "archived_name_collision",
        status_code: 409,
      });
      return {
        status: 409,
        body: await archivedNameCollisionBody(err, { type: "agent", id: actor.id, serverId: serverId as ServerId }),
      };
    }
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
      return {
        status: 403,
        body: {
          ...await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["editChannelMetadata"], action: "rename this channel or edit its description", channelAdminIn: channel.name }),
          error: "Agent lacks permission to edit channel metadata",
        },
      };
    }
    if (msg.includes("Cannot rename") || msg.includes("Cannot edit") || msg === channelService.JOINT_VISIBILITY_FIXED_MESSAGE || msg.includes("reserved")) {
      addTraceEvent("agent_channel_update.request.failed", {
        reason: "forbidden_update",
        status_code: 403,
      });
      return {
        status: 403,
        body: agentRefusalBody(msg, "channel_update_forbidden", `${asSentence(msg)} This channel cannot be changed this way by anyone; do not retry.`),
      };
    }
    addTraceEvent("agent_channel_update.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: errorClassOf(err),
    });
    return { status: 500, body: { error: "Failed to update channel" } };
  }
}
