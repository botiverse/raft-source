/**
 * Other people's agents on the person's own computers (#triage:d10ace06):
 * the wire shapes and calls that both ways of taking a computer away share.
 * Delete Account (features/settings/account/accountDeletionApi.ts) and
 * deleting one computer on its own (the Computer key revoke below) are held up
 * by them, and ask their owners to move them through a notify-agent-owners
 * route. Server: packages/server/src/routes/servers.ts (revoke-computer-key,
 * notify-agent-owners) and services/accountDeletion/ownerNotices.ts.
 */
import api from "../../api/client";
import type { Agent } from "../../store/agentStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";

/** Who created another member's agent; null when no person did (nobody to notify). */
export type AgentOwner = { id: string; name: string } | null;

/**
 * The person's own agent, as the server tells it apart from other people's
 * (services/computerAgents.ts `ownedByActor`): they created it, or it is their
 * personal assistant. Only these are left to the person to move.
 */
export function isOwnAgent(agent: Pick<Agent, "creatorType" | "creatorId" | "assistantOwnerUserId">, userId: string | null): boolean {
  if (!userId) return false;
  return (agent.creatorType === "user" && agent.creatorId === userId) || agent.assistantOwnerUserId === userId;
}

/** The owner fields every list of other people's agents carries. */
export interface OthersAgent {
  id: string;
  name: string;
  /** The owner's display name (else their username); null when no person created it. */
  owner: AgentOwner;
  /** When Raft last reminded that owner to move it. */
  ownerNotifiedAt: string | null;
  /** When the next reminder is allowed (once a day, shared with Delete Account); null: it can go now. */
  ownerNextNotifyAt: string | null;
  /** Its owner's personal assistant: only the owner can move it. */
  personalAssistant: boolean;
}

export function ownerOf(value: unknown): AgentOwner {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record || typeof record.id !== "string") return null;
  return { id: record.id, name: typeof record.name === "string" && record.name ? record.name : record.id };
}

export function timeOf(value: unknown): string | null {
  return typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The owner fields of one wire entry (`record.id` already checked). */
export function othersAgentOf(record: Record<string, unknown> & { id: string }): OthersAgent {
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : record.id,
    owner: ownerOf(record.owner),
    ownerNotifiedAt: timeOf(record.ownerNotifiedAt),
    ownerNextNotifyAt: timeOf(record.ownerNextNotifyAt),
    personalAssistant: record.personalAssistant === true,
  };
}

/**
 * Why the server didn't remind an agent's owner. `not_delivered`: the message
 * couldn't be sent (a failed DM write, say); it doesn't count against the
 * daily limit, so it can be tried again at once.
 */
export type NotifySkipReason = "rate_limited" | "not_on_your_computer" | "no_owner" | "not_delivered";

export interface NotifyAgentOwnersResult {
  notified: Array<{ agentId: string; notifiedAt: string }>;
  skipped: Array<{ agentId: string; reason: NotifySkipReason; nextAllowedAt: string | null }>;
}

const SKIP_REASONS = new Set<string>(["rate_limited", "not_on_your_computer", "no_owner", "not_delivered"]);

/** The most ids one call may carry (more answers 400 `invalid_agent_ids`). */
export const NOTIFY_AGENT_IDS_MAX = 200;

/**
 * Notify Owner to Move It, at either notify-agent-owners route: Raft sends
 * each agent's owner a system message asking them to move it to another
 * computer (the person sends nothing themselves). Once per agent per 24 hours
 * (`rate_limited`, with `nextAllowedAt`). `{ agentIds }`; an empty list, more
 * than 200 ids or a non-string one is 400 `invalid_agent_ids`, so this never
 * sends one: no call for no ids, and more than 200 go in batches. Any refusal
 * rejects.
 */
export async function postNotifyAgentOwners(url: string, agentIds: string[]): Promise<NotifyAgentOwnersResult> {
  const ids = [...new Set(agentIds.filter((id) => typeof id === "string" && id))];
  const result: NotifyAgentOwnersResult = { notified: [], skipped: [] };
  for (let start = 0; start < ids.length; start += NOTIFY_AGENT_IDS_MAX) {
    const { data } = await api.post<{ notified?: unknown; skipped?: unknown }>(url, { agentIds: ids.slice(start, start + NOTIFY_AGENT_IDS_MAX) });
    const batch = notifyResultOf(data);
    result.notified.push(...batch.notified);
    result.skipped.push(...batch.skipped);
  }
  return result;
}

function notifyResultOf(data: { notified?: unknown; skipped?: unknown } | undefined): NotifyAgentOwnersResult {
  const notified = Array.isArray(data?.notified) ? data.notified.flatMap((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const notifiedAt = timeOf(record?.notifiedAt);
    return record && typeof record.agentId === "string" && notifiedAt ? [{ agentId: record.agentId, notifiedAt }] : [];
  }) : [];
  const skipped = Array.isArray(data?.skipped) ? data.skipped.flatMap((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.agentId !== "string" || typeof record.reason !== "string" || !SKIP_REASONS.has(record.reason)) return [];
    return [{ agentId: record.agentId, reason: record.reason as NotifySkipReason, nextAllowedAt: timeOf(record.nextAllowedAt) }];
  }) : [];
  return { notified, skipped };
}

const machinePath = (serverId: string, machineId: string) =>
  `/servers/${encodeURIComponent(serverId)}/machines/${encodeURIComponent(machineId)}`;

/** POST /servers/:id/machines/:machineId/notify-agent-owners: the owners of other people's agents on this computer. */
export function notifyComputerAgentOwners(serverId: string, machineId: string, agentIds: string[]): Promise<NotifyAgentOwnersResult> {
  return postNotifyAgentOwners(`${machinePath(serverId, machineId)}/notify-agent-owners`, agentIds);
}

export type ComputerKeyRevokeResult =
  | { kind: "revoked" }
  | { kind: "others_agents"; agents: OthersAgent[] };

/** Revoke-and-delete: `deleted` when the server removed the machine in the same request. */
export type ComputerRevokeAndDeleteResult = ComputerKeyRevokeResult | { kind: "deleted" };

function othersAgentsOf(err: unknown): OthersAgent[] | null {
  const response = getApiErrorResponse(err);
  const listed = (err as { response?: { data?: { agents?: unknown } } }).response?.data?.agents;
  if (response?.status !== 409 || response.code !== "others_agents_on_computer" || !Array.isArray(listed)) return null;
  const agents = listed.flatMap((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    return record && typeof record.id === "string" ? [othersAgentOf(record as Record<string, unknown> & { id: string })] : [];
  });
  return agents.length > 0 ? agents : null;
}

/**
 * POST /servers/:id/machines/:machineId/revoke-computer-key, by the person
 * who attached the computer: it goes offline for good (a new attach brings it
 * back) and the machine stays. While other people's live agents are on it the
 * server answers 409 `others_agents_on_computer` with them, unless
 * `forceAgentIds` names every one: then they are unbound and stopped (not
 * deleted) in the same transaction, and each owner gets a system notice. A
 * newer list (more arrived) is that 409 again, and nothing happened. 409
 * `no_live_computer_key`: its key was already revoked, which is what this asked
 * for. The person's own agents never hold it up and stay bound.
 */
export async function revokeComputerKey(serverId: string, machineId: string, forceAgentIds: readonly string[] = []): Promise<ComputerKeyRevokeResult> {
  try {
    await api.post(`${machinePath(serverId, machineId)}/revoke-computer-key`, forceAgentIds.length > 0 ? { forceAgentIds: [...forceAgentIds] } : {});
    return { kind: "revoked" };
  } catch (err) {
    const response = getApiErrorResponse(err);
    if (response?.status === 409 && response.code === "no_live_computer_key") return { kind: "revoked" };
    const agents = othersAgentsOf(err);
    if (agents) return { kind: "others_agents", agents };
    throw err;
  }
}

/**
 * The same POST with `delete: true`, for Delete Computer on the person's own
 * computer: the server revokes the key and removes the machine in one request
 * and one transaction, authorized while it is still attached by them (after a
 * revoke on its own they could no longer remove it: only an owner or admin
 * can). `deleted`: both happened. `others_agents`: the 409 above, nothing
 * happened. Any other refusal (an agent of theirs still on it, a move in
 * progress: deleteMachine's 409) rejects with nothing changed. `revoked`: the
 * key was revoked but the machine is still there (its key had already been
 * revoked, or a server without `delete`); the caller removes it with DELETE.
 */
export async function revokeKeyAndDeleteComputer(serverId: string, machineId: string, forceAgentIds: readonly string[] = []): Promise<ComputerRevokeAndDeleteResult> {
  try {
    const { data } = await api.post<{ deleted?: unknown }>(
      `${machinePath(serverId, machineId)}/revoke-computer-key`,
      { delete: true, ...(forceAgentIds.length > 0 ? { forceAgentIds: [...forceAgentIds] } : {}) },
    );
    return data?.deleted === true ? { kind: "deleted" } : { kind: "revoked" };
  } catch (err) {
    const response = getApiErrorResponse(err);
    if (response?.status === 409 && response.code === "no_live_computer_key") return { kind: "revoked" };
    const agents = othersAgentsOf(err);
    if (agents) return { kind: "others_agents", agents };
    throw err;
  }
}
