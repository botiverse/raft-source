import { publishChannelUpdate } from "../services/channelRealtimeEvents";
import { createChannelCapabilityFor, validateName, type ServerId } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import * as channelService from "../services/channelService";
import { archivedNameCollisionBody } from "./archivedNameCollision";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { AGENT_NO_LONGER_EXISTS_REFUSAL, agentRefusalBody, agentServerRoleRequiredBody, type AgentRouteResult } from "../lib/agentServerRoleRequired";

export interface AgentChannelCreateActor {
  id: string;
  name: string;
  serverId: string;
}

export type AgentChannelCreateResult = AgentRouteResult;

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
    return { ok: false, status: 401, refusal: AGENT_NO_LONGER_EXISTS_REFUSAL };
  }

  const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  // The capability follows the requested visibility, read before the body is
  // validated so a refusal still comes before a 400, as it did.
  const requiredCapability = createChannelCapabilityFor(payload.visibility);
  const hasAuthority = await actorHasServerCapabilityInServer(serverId, "agent", actor.id, requiredCapability);
  addTraceEvent("agent_channel_create.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: requiredCapability,
  });
  if (!hasAuthority) {
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { ok: false, status: 403, refusal: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: [requiredCapability], action: "create channels" }) };
  }

  const rawName = typeof payload.name === "string" ? payload.name.trim().replace(/^#/, "") : "";
  const nameError = validateName(rawName, "Channel name");
  if (nameError) {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_name" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_name",
      status_code: 400,
    });
    return { ok: false, status: 400, refusal: { code: "channel_name_invalid", error: nameError } };
  }
  if (rawName === "all") {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "reserved_name" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "reserved_name",
      status_code: 400,
    });
    return { ok: false, status: 400, refusal: { code: "channel_name_reserved", error: 'Channel name "all" is reserved' } };
  }

  const type = parseVisibility(payload.visibility);
  if (!type) {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_visibility" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_visibility",
      status_code: 400,
    });
    return { ok: false, status: 400, refusal: { code: "channel_visibility_invalid", error: "Visibility must be public or private" } };
  }
  const description = normalizeDescription(payload.description);
  if (typeof description === "object") {
    addTraceEvent("agent_channel_create.validation.failed", { reason: "invalid_description" });
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "invalid_description",
      status_code: 400,
    });
    return { ok: false, status: 400, refusal: { code: "channel_description_invalid", error: description.error } };
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

    return { ok: true, status: 200, body: { ...channelWithMetadata, createdByAgentId: actor.id } };
  } catch (err) {
    if (err instanceof channelService.ArchivedNameCollisionError) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "archived_name_collision",
        status_code: 409,
      });
      // refusal-ok: the archived-name body, the hidden case byte-identical to the live "already taken" below (archivedNameCollision.ts, #proj-chat:#19)
      return {
        ok: false,
        status: 409,
        body: await archivedNameCollisionBody(err, { type: "agent", id: actor.id, serverId: serverId as ServerId }),
      };
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("already taken")) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "name_taken",
        status_code: 409,
      });
      // refusal-ok: must stay byte-identical to the hidden archived-name body (archivedNameCollision.ts), no existence oracle (#proj-chat:#19)
      return { ok: false, status: 409, body: { error: msg } };
    }
    if (msg.includes("Channel limit reached")) {
      addTraceEvent("agent_channel_create.request.failed", {
        reason: "channel_limit_reached",
        status_code: 403,
      });
      return {
        ok: false,
        status: 403,
        refusal: agentRefusalBody(
          msg,
          "channel_limit_reached",
          "This server has reached its channel limit. Tell a server owner: they can archive unused channels or change the plan. Do not retry until then.",
        ),
      };
    }
    addTraceEvent("agent_channel_create.request.failed", {
      reason: "unexpected_error",
      status_code: 500,
      error_class: errorClassOf(err),
    });
    return { ok: false, status: 500, body: { error: "Failed to create channel" } };
  }
}
