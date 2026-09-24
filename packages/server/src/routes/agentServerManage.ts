import * as serverService from "../services/serverService.js";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

export interface AgentServerManageActor {
  id: string;
  name: string;
  serverId: string;
}

export interface AgentServerManageResult {
  status: number;
  body: Record<string, unknown>;
}

export async function assertAgentCanManageServerProfile(input: {
  actor: AgentServerManageActor;
  serverId: string;
}): Promise<AgentServerManageResult | null> {
  const { actor, serverId } = input;
  addTraceEvent("agent_server_profile.authorization.started", {
    actor_server_match: actor.serverId === serverId,
  });
  if (actor.serverId !== serverId) {
    addTraceEvent("agent_server_profile.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { status: 401, body: { error: "Agent no longer exists" } };
  }

  const hasAuthority = await actorHasServerCapabilityInServer(serverId, "agent", actor.id, "editServerSettings");
  addTraceEvent("agent_server_profile.authorization.checked", {
    outcome: hasAuthority ? "allowed" : "denied",
    required_capability: "editServerSettings",
  });
  if (!hasAuthority) {
    addTraceEvent("agent_server_profile.request.failed", {
      reason: "capability_required",
      status_code: 403,
    });
    return { status: 403, body: { error: "Agent requires editServerSettings capability to edit the server profile" } };
  }
  return null;
}

export async function updateServerProfileForAgent(input: {
  actor: AgentServerManageActor;
  serverId: string;
  body: unknown;
}): Promise<AgentServerManageResult> {
  const authFailure = await assertAgentCanManageServerProfile(input);
  if (authFailure) return authFailure;

  const payload = typeof input.body === "object" && input.body !== null ? input.body as Record<string, unknown> : {};
  const updates: { name?: string; hideHumansFromMembers?: boolean } = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string") {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "invalid_name_type" });
      return { status: 400, body: { error: "Name must be a string" } };
    }
    const trimmed = payload.name.trim();
    if (!trimmed) {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "empty_name" });
      return { status: 400, body: { error: "Name is required" } };
    }
    if (trimmed.length > 100) {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "name_too_long" });
      return { status: 400, body: { error: "Name must be 100 characters or fewer" } };
    }
    updates.name = trimmed;
  }

  if (payload.hideHumansFromMembers !== undefined) {
    if (typeof payload.hideHumansFromMembers !== "boolean") {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "invalid_hide_humans_type" });
      return { status: 400, body: { error: "hideHumansFromMembers must be a boolean" } };
    }
    updates.hideHumansFromMembers = payload.hideHumansFromMembers;
  }

  if (updates.name === undefined && updates.hideHumansFromMembers === undefined) {
    addTraceEvent("agent_server_profile.validation.failed", { reason: "empty_update" });
    return { status: 400, body: { error: "At least one field is required" } };
  }

  const updated = await serverService.updateServerProfile(input.serverId, updates);
  if (!updated) {
    addTraceEvent("agent_server_profile.request.failed", {
      reason: "server_not_found",
      status_code: 404,
    });
    return { status: 404, body: { error: "Server not found" } };
  }
  addTraceEvent("agent_server_profile.updated", {
    renamed: updates.name !== undefined,
    hide_humans_changed: updates.hideHumansFromMembers !== undefined,
  });
  return { status: 200, body: updated };
}
