import { publishChannelUpdate } from "../services/channelRealtimeEvents.js";
import { validateName } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import * as channelService from "../services/channelService.js";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

export interface AgentChannelCreateActor {
  id: string;
  name: string;
  serverId: string;
}

export interface AgentChannelCreateResult {
  status: number;
  body: Record<string, unknown>;
}

function parseVisibility(raw: unknown): channelService.RegularChannelType | null {
  if (raw === undefined || raw === null || raw === "" || raw === "public" || raw === "channel") {
    return "channel";
  }
  if (raw === "private") return "private";
  return null;
}

function normalizeDescription(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 500) {
    return { error: "Description must be a string of at most 500 characters" };
  }
  return raw;
}

export async function createChannelForAgent(input: {
  actor: AgentChannelCreateActor;
  serverId: string;
  body: unknown;
  io?: SocketServer;
}): Promise<AgentChannelCreateResult> {
  const { actor, serverId, body, io } = input;
  addTraceEvent("agent_channel_create.request.started", {
    actor_server_match: actor.serverId === serverId,
  });

  if (actor.serverId !== serverId) {
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const hasAuthority = await actorHasServerCapabilityInServer(serverId, "agent", actor.id, "createChannels");
  addTraceEvent("agent_channel_create.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "createChannels",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { status: 403, body: { error: "Agent requires createChannels capability to create channels" } };
  }

  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const rawName = typeof payload.name === "string" ? payload.name.trim().replace(/^#/, "") : "";
  const nameError = validateName(rawName, "Channel name");
  if (nameError) {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_name" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_name",
      status_code: 400,
    });
    return { status: 400, body: { error: nameError } };
  }
  if (rawName === "all") {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "reserved_name" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "reserved_name",
      status_code: 400,
    });
    return { status: 400, body: { error: 'Channel name "all" is reserved' } };
  }

  const type = parseVisibility(payload.visibility);
  if (!type) {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_visibility" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_visibility",
      status_code: 400,
    });
    return { status: 400, body: { error: "Visibility must be public or private" } };
  }
  const description = normalizeDescription(payload.description);
  if (typeof description === "object") {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_description" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_description",
      status_code: 400,
    });
    return { status: 400, body: { error: description.error } };
  }

  try {
    const channel = await channelService.createChannel(
      serverId,
      rawName,
      description,
      type,
      { type: "agent", id: actor.id },
    );
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    addTraceEvent("agent_channel_create.created", {
      visibility: type === "private" ? "private" : "public",
      has_description: Boolean(description),
      creator_joined: true,
    });

    await publishChannelUpdate(io, channelWithMetadata);
    io?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
    addTraceEvent("agent_channel_create.broadcasted", {
      visibility: type === "private" ? "private" : "public",
    });

    return { status: 200, body: { ...channelWithMetadata, createdByAgentId: actor.id } };
  } catch (err) {
    if (err instanceof channelService.ArchivedNameCollisionError) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "archived_name_collision",
        status_code: 409,
      });
      return {
        status: 409,
        body: {
          error: `Channel name "${err.channelName}" is held by an archived channel`,
          code: "archived_name_collision",
          archivedChannelId: err.archivedChannelId,
          archivedChannelName: err.channelName,
          archivedChannelType: err.archivedChannelType,
        },
      };
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("already taken")) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "name_taken",
        status_code: 409,
      });
      return { status: 409, body: { error: msg } };
    }
    if (msg.includes("Channel limit reached")) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "channel_limit_reached",
        status_code: 403,
      });
      return { status: 403, body: { error: msg } };
    }
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: err instanceof Error ? err.name : typeof err,
    });
    return { status: 500, body: { error: "Failed to create channel" } };
  }
}
