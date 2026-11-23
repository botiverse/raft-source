import * as serverService from "../services/serverService";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions";
import { addTraceEvent } from "../tracing/semanticTrace";
import { AGENT_NO_LONGER_EXISTS_REFUSAL, agentServerRoleRequiredBody, type AgentRouteResult } from "../lib/agentServerRoleRequired";
import type { RefusalInput, RefusalStatus } from "../lib/refusal";

export interface AgentServerManageActor {
  id: string;
  name: string;
  serverId: string;
}

export type AgentServerManageResult = AgentRouteResult;

/** A refusal of the server-profile routes, for refuse(). */
export type AgentServerManageRefusal = { ok: false; status: RefusalStatus; refusal: RefusalInput };

export async function assertAgentCanManageServerProfile(input: {
  actor: AgentServerManageActor;
  serverId: string;
}): Promise<AgentServerManageRefusal | null> {
  const { actor, serverId } = input;
  addTraceEvent("agent_server_profile.authorization.started", {
    actor_server_match: actor.serverId === serverId,
  });
  if (actor.serverId !== serverId) {
    addTraceEvent("agent_server_profile.request.failed", {
      reason: "agent_server_mismatch",
      status_code: 401,
    });
    return { ok: false, status: 401, refusal: AGENT_NO_LONGER_EXISTS_REFUSAL };
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
    return { ok: false, status: 403, refusal: await agentServerRoleRequiredBody({ serverId, agentId: actor.id, capabilities: ["editServerSettings"], action: "edit the server profile" }) };
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
      return { ok: false, status: 400, refusal: { code: "server_name_invalid", error: "Name must be a string" } };
    }
    const trimmed = payload.name.trim();
    if (!trimmed) {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "empty_name" });
      return { ok: false, status: 400, refusal: { code: "server_name_invalid", error: "Name is required" } };
    }
    if (trimmed.length > 100) {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "name_too_long" });
      return { ok: false, status: 400, refusal: { code: "server_name_invalid", error: "Name must be 100 characters or fewer" } };
    }
    updates.name = trimmed;
  }

  if (payload.hideHumansFromMembers !== undefined) {
    if (typeof payload.hideHumansFromMembers !== "boolean") {
      addTraceEvent("agent_server_profile.validation.failed", { reason: "invalid_hide_humans_type" });
      return { ok: false, status: 400, refusal: { code: "server_hide_humans_invalid", error: "hideHumansFromMembers must be a boolean" } };
    }
    updates.hideHumansFromMembers = payload.hideHumansFromMembers;
  }

  if (updates.name === undefined && updates.hideHumansFromMembers === undefined) {
    addTraceEvent("agent_server_profile.validation.failed", { reason: "empty_update" });
    return { ok: false, status: 400, refusal: { code: "server_update_empty", error: "At least one field is required" } };
  }

  const updated = await serverService.updateServerProfile(input.serverId, updates, {
    audit: await agentServerProfileAudit(input.actor, input.serverId),
  });
  if (!updated) {
    addTraceEvent("agent_server_profile.request.failed", {
      reason: "server_not_found",
      status_code: 404,
    });
    return { ok: false, status: 404, refusal: { code: "server_not_found", error: "Server not found" } };
  }
  addTraceEvent("agent_server_profile.updated", {
    renamed: updates.name !== undefined,
    hide_humans_changed: updates.hideHumansFromMembers !== undefined,
  });
  return { ok: true, status: 200, body: updated };
}

/** Audit context for an agent's server-profile write: the agent and its live server role. */
export async function agentServerProfileAudit(
  actor: AgentServerManageActor,
  serverId: string,
): Promise<serverService.ServerProfileAuditContext> {
  return {
    actor: { type: "agent", id: actor.id },
    source: "api",
    agentServerRole: await getActorServerRoleInServer(serverId, "agent", actor.id),
  };
}
