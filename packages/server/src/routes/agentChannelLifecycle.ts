import { emitJointProjectionUpdates, publishChannelUpdate } from "../services/channelRealtimeEvents";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import type { Server as SocketServer } from "socket.io";
import { actorHasChannelCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { AGENT_CHANNEL_ID_NOT_FOUND_REFUSAL, AGENT_NO_LONGER_EXISTS_REFUSAL, agentServerRoleRequiredBody, type AgentRouteResult } from "../lib/agentServerRoleRequired";
import { ExternalChannelLimitError } from "../services/externalChannelLimitService";

export interface AgentChannelLifecycleActor {
  id: string;
  name: string;
  serverId: string;
}

export type AgentChannelLifecycleResult = AgentRouteResult;

export async function setChannelArchivedForAgent(input: {
  actor: AgentChannelLifecycleActor;
  serverId: string;
  channelId: string;
  archived: boolean;
  io?: SocketServer;
  agentOrchestrator?: AgentOrchestrator;
}): Promise<AgentChannelLifecycleResult> {
  const { actor, serverId, channelId, archived, io, agentOrchestrator } = input;
  const action = archived ? "archive" : "unarchive";
  const unsupportedCode = archived ? "channel_archive_unsupported" : "channel_unarchive_unsupported";
  addTraceEvent("agent_channel_lifecycle.request.started", {
    action,
    actor_server_match: actor.serverId === serverId,
  });

  if (actor.serverId !== serverId) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { ok: false, status: 401, refusal: AGENT_NO_LONGER_EXISTS_REFUSAL };
  }

  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "channel_not_found",
      status_code: 404,
    });
    return { ok: false, status: 404, refusal: AGENT_CHANNEL_ID_NOT_FOUND_REFUSAL };
  }
  if (channel.type !== "channel" && channel.type !== "private" && channel.type !== "joint") {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return {
      ok: false,
      status: 400,
      refusal: { code: unsupportedCode, error: `Only public, private, or joint channels can be ${archived ? "archived" : "unarchived"}` },
    };
  }
  if (!await channelService.canAgentAccessChannel(channel.id, actor.id)) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { ok: false, status: 404, refusal: AGENT_CHANNEL_ID_NOT_FOUND_REFUSAL };
  }
  // Archiving a joint channel archives it for every connected server: the
  // authority is the host's (channelActorHasCapability), exactly as the human
  // archive route decides it.
  const isJoint = channel.type === "joint";
  const hasAuthority = await actorHasChannelCapability(serverId, channel.id, "agent", actor.id, "archiveChannels");
  addTraceEvent("agent_channel_lifecycle.authorization.checked", {
    action,
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "archiveChannels",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "capability_required",
      status_code: 403,
    });
    return {
      ok: false,
      status: 403,
      refusal: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["archiveChannels"], action: `${action} channels`, ...(channel.type === "joint" ? { jointChannel: channel.name } : { channelAdminIn: channel.name }) }),
    };
  }

  try {
    const endedGuests: channelService.EndedChannelGuest[] = [];
    const { channel: updated, changed } = await withLockedChannelActorCapability({
          serverId,
          channelId: channel.id,
          actorType: "agent",
          actorId: actor.id,
          capability: "archiveChannels",
          // An unarchive checks the free plan's external channel rule under them (ADMISSION_LOCK_ORDER).
          admissionServerIds: archived ? [] : await channelService.unarchiveAdmissionServerIds(channel.id),
          // The Guests an archive removes: their users rows first.
          guessUserIds: archived ? () => channelService.archiveBoundGuestIds(channel.id) : undefined,
        }, (tx, _context, lockedUserIds) => {
          endedGuests.length = 0; // A restarted attempt starts over.
          return channelService.setLocalChannelArchivedByAgent(channel.id, actor.id, archived, tx, { endedGuests, lockedUserIds });
        });
    // An archive ends its Guests' server membership (in the commit); finish them after it.
    await channelService.finishEndedChannelGuests(updated.serverId, endedGuests);
    // After commit: an archived channel's Guests lose their live connections
    // (#wg-rbac:#15), also on an idempotent retry (repairs a failed revocation).
    if (archived && updated.archivedAt) await channelService.revokeBoundGuestSockets(updated.id);

    if (changed) {
      if (isJoint) {
        await emitJointProjectionUpdates(io, updated.id);
      } else {
        await publishChannelUpdate(io, updated);
      }
      if (io && agentOrchestrator) {
        const verb = archived ? "archived" : "unarchived";
        const icon = archived ? "📦" : "📤";
        try {
          // Fence the causal activity before acknowledging the lifecycle
          // request. This makes concurrent idempotent retries observably
          // exact-once: only the conditional-write winner emits, and no
          // delayed duplicate can arrive after both responses settle.
          // Joint-aware: a joint's notice goes to canonical storage, fanned out to every server (slock issue 15637).
          await messageService.broadcastSystemMessageToLocalSurfaces(
            io,
            agentOrchestrator,
            updated.id,
            `${icon} ${actor.name} ${verb} this channel`,
            {
              inboxFactPolicy: {
                mode: "record",
                producer: archived ? "channel.archive" : "channel.unarchive",
                reason: `channel ${action} is shared channel activity`,
                causalActor: { type: "agent", id: actor.id },
              },
            },
          );
        } catch (err) {
          addTraceEvent("agent_channel_lifecycle.activity.failed", {
            action,
            error_class: errorClassOf(err),
          });
        }
      }
    }

    addTraceEvent("agent_channel_lifecycle.updated", {
      action,
      changed,
      channel_visibility: updated.type === "private" ? "private" : "public",
    });
    return { ok: true, status: 200, body: updated };
  } catch (err) {
    // Unarchiving would put a free server in a second external channel: the admission's 409.
    if (err instanceof ExternalChannelLimitError) {
      addTraceEvent("agent_channel_lifecycle.request.failed", { action, reason: "free_external_limit", status_code: 409 });
      return { ok: false, status: 409, refusal: { code: err.code, error: err.message } };
    }
    const message = err instanceof Error ? err.message : "";
    if (message === "Channel capability required") {
      return { ok: false, status: 403, refusal: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["archiveChannels"], action: `${action} channels`, ...(channel.type === "joint" ? { jointChannel: channel.name } : { channelAdminIn: channel.name }) }) };
    }
    if (message.includes("#all") || message.includes("Only regular")) {
      addTraceEvent("agent_channel_lifecycle.request.failed", {
        action,
        reason: "forbidden_channel",
        status_code: 400,
      });
      return { ok: false, status: 400, refusal: { code: unsupportedCode, error: message } };
    }
    if (message === "Channel not found") {
      return { ok: false, status: 404, refusal: AGENT_CHANNEL_ID_NOT_FOUND_REFUSAL };
    }
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "unexpected_error",
      status_code: 500,
      error_class: errorClassOf(err),
    });
    return { ok: false, status: 500, body: { error: `Failed to ${action} channel` } };
  }
}
