import { publishChannelUpdate } from "../services/channelRealtimeEvents.js";
import type { Server as SocketServer } from "socket.io";
import { actorHasChannelCapability, withLockedChannelActorCapability } from "../lib/channelActorPermissions.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import * as channelService from "../services/channelService.js";
import * as messageService from "../services/messageService.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

export interface AgentChannelLifecycleActor {
  id: string;
  name: string;
  serverId: string;
}

export interface AgentChannelLifecycleResult {
  status: number;
  body: Record<string, unknown>;
}

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
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "channel_not_found",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  if (channel.type !== "channel" && channel.type !== "private") {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "unsupported_channel_type",
      status_code: 400,
    });
    return {
      status: 400,
      body: { error: `Only regular public or private channels can be ${archived ? "archived" : "unarchived"}` },
    };
  }
  if (!await channelService.canAgentAccessChannel(channel.id, actor.id)) {
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "channel_not_visible",
      status_code: 404,
    });
    return { status: 404, body: { error: "Channel not found" } };
  }
  const hasAuthority = await actorHasChannelCapability(
    serverId,
    channel.id,
    "agent",
    actor.id,
    "archiveChannels",
  );
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
      status: 403,
      body: { error: `Agent requires archiveChannels capability to ${action} channels` },
    };
  }

  try {
    const { channel: updated, changed } = await withLockedChannelActorCapability({
      serverId,
      channelId: channel.id,
      actorType: "agent",
      actorId: actor.id,
      capability: "archiveChannels",
    }, (tx) => channelService.setLocalChannelArchivedByAgent(channel.id, actor.id, archived, tx));

    if (changed) {
      await publishChannelUpdate(io, updated);
      if (io && agentOrchestrator) {
        const verb = archived ? "archived" : "unarchived";
        const icon = archived ? "📦" : "📤";
        try {
          // Fence the causal activity before acknowledging the lifecycle
          // request. This makes concurrent idempotent retries observably
          // exact-once: only the conditional-write winner emits, and no
          // delayed duplicate can arrive after both responses settle.
          await messageService.broadcastSystemMessage(
            io,
            agentOrchestrator,
            updated.id,
            `${icon} ${actor.name} ${verb} this channel`,
            {
              inboxFactPolicy: {
                mode: "record",
                producer: archived ? "channel.archive" : "channel.unarchive",
                reason: `channel ${action} is shared channel activity`,
              },
              causalActor: { type: "agent", id: actor.id },
            },
          );
        } catch (err) {
          addTraceEvent("agent_channel_lifecycle.activity.failed", {
            action,
            error_class: err instanceof Error ? err.name : typeof err,
          });
        }
      }
    }

    addTraceEvent("agent_channel_lifecycle.updated", {
      action,
      changed,
      channel_visibility: updated.type === "private" ? "private" : "public",
    });
    return { status: 200, body: updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "Channel capability required") {
      return { status: 403, body: { error: `Agent requires archiveChannels capability to ${action} channels` } };
    }
    if (message.includes("#all") || message.includes("Only regular")) {
      addTraceEvent("agent_channel_lifecycle.request.failed", {
        action,
        reason: "forbidden_channel",
        status_code: 400,
      });
      return { status: 400, body: { error: message } };
    }
    if (message === "Channel not found") {
      return { status: 404, body: { error: message } };
    }
    addTraceEvent("agent_channel_lifecycle.request.failed", {
      action,
      reason: "unexpected_error",
      status_code: 500,
      error_class: err instanceof Error ? err.name : typeof err,
    });
    return { status: 500, body: { error: `Failed to ${action} channel` } };
  }
}
