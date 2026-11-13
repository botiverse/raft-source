import type {
  AgentContextViewGrant,
  AgentContextViewGrantCreated,
  AgentContextViewGrantId,
  AgentContextViewGrantList,
} from "@botiverse/raft-shared";
import api from "../../../api/client";

/**
 * View Context grants (#13530, shared agentContextViewGrant.ts): the
 * owner/admin list, grant and revoke. Every route is behind
 * `agent_context_view_v0`.
 */
const grantsPath = (serverId: string) => `/servers/${serverId}/agent-context-view-grants`;

export async function listContextViewGrants(serverId: string): Promise<AgentContextViewGrant[]> {
  const { data } = await api.get<AgentContextViewGrantList>(grantsPath(serverId));
  return data.grants;
}

export async function grantContextView(serverId: string, agentId: string): Promise<AgentContextViewGrantCreated> {
  const { data } = await api.post<AgentContextViewGrantCreated>(grantsPath(serverId), { agentId });
  return data;
}

/**
 * Revoke: `gone` when the server no longer has the grant (404
 * `context_view_grant_not_found`: already revoked by someone else, or, after
 * #13543, one the caller may not revoke, which reads the same). Already
 * revoked (200, `revoked: false`) is the same outcome for the list. Any other
 * failure throws.
 */
export async function revokeContextViewGrant(serverId: string, grantId: AgentContextViewGrantId): Promise<"revoked" | "gone"> {
  try {
    const { data } = await api.delete<{ ok: true; revoked: boolean }>(`${grantsPath(serverId)}/${grantId}`);
    return data.revoked ? "revoked" : "gone";
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { code?: string } } }).response;
    if (response?.status === 404 && response.data?.code === "context_view_grant_not_found") return "gone";
    throw err;
  }
}
