import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { AgentActivity, ChannelAdminBasis, ChannelRole, RuntimeErrorCode, ServerRole } from "@botiverse/raft-shared";
import type { Agent } from "../store/agentStore";
import { useAgentStore } from "../store/agentStore";
import api from "../api/client";
import type { ChannelMemberServer } from "../utils/channelLocalMembership";
import { getSocket } from "../api/socket";
import { notifyChannelMembersChanged, subscribeChannelMembersChanged } from "../store/channelMemberEvents";
import { agentActorRow, currentActorScope, humanActorRow, upsertActorsIfCurrent } from "../store/localTables/actorResolve";

// oxlint-disable react-doctor/no-event-handler -- effect-as-subscription bridge (subscribeChannelMembersChanged); structure pinned by channelMemberEvents.test.ts, cannot inline-disable inside. YMNNE-family grandfathered; rule gates new code elsewhere. See docs/frontend/render-cost-contract.md.

export interface ChannelHuman {
  id: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  /** Joint channels only (RFC 075 phase 1): every server this person
   *  participates through, the viewed server first. */
  servers?: ChannelMemberServer[];
  /** Joint rosters only: whether the
   *  person belongs to the viewed server, any role including guest. There
   *  `servers` is their sources minus the viewed server. */
  inViewerServer?: boolean;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  /** Null for another server's person in a joint channel: their roles stay
   *  with their organization, and they read as a plain member. */
  role: ServerRole | null;
  serverRole: ServerRole | null;
  channelRole: ChannelRole | null;
  effectiveChannelRole: "owner" | "admin" | "member" | "guest";
  channelAdminBasis: ChannelAdminBasis;
  canChangeChannelRole: boolean;
  canRemoveFromChannel?: boolean;
}

export type ChannelAgent = Agent & {
  /** Computed joint rosters only: the agent's one server is the viewed one. */
  inViewerServer?: boolean;
  activity?: AgentActivity;
  activityDetail?: string;
  /** #wg-rbac:#57: the error's code while `activity` is "error". */
  activityErrorCode?: RuntimeErrorCode;
  serverRole?: ServerRole | null;
  channelRole?: ChannelRole | null;
  effectiveChannelRole?: "admin" | "member";
  channelAdminBasis?: ChannelAdminBasis;
  canChangeChannelRole?: boolean;
  canRemoveFromChannel?: boolean;
};

export interface ChannelExternalMember {
  id: string;
  provider: "slack";
  displayName: string;
  handles: string[];
  actorKind: "human" | "guest" | "remote" | "bot" | "unknown";
  mentionable?: boolean;
  avatarUrl: string | null;
  /** Slack workspace display name for the external-identity panel
   *  ("from <workspace>" line). Provider-side ids stay server-side. */
  workspaceName: string | null;
}

interface ChannelMembersPayload {
  agents: ChannelAgent[];
  humans: ChannelHuman[];
  externalMembers: ChannelExternalMember[];
}

export type AddChannelMembersBatchInput = {
  userIds: string[];
  agentIds: string[];
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
};

export type AddChannelMembersBatchResult = {
  added: AddChannelMembersBatchInput;
  alreadyMembers: AddChannelMembersBatchInput;
};

// ChatPanel, MessageInput, and task/member surfaces can legitimately subscribe
// to the same roster at once. Coalesce only concurrent reads; the entry is
// removed as soon as the request settles so a socket/local invalidation still
// performs a fresh fetch.
const inFlightMemberRequests = new Map<string, Promise<ChannelMembersPayload>>();
const EMPTY_CHANNEL_AGENTS: ChannelAgent[] = [];
const EMPTY_CHANNEL_HUMANS: ChannelHuman[] = [];
const EMPTY_CHANNEL_EXTERNAL_MEMBERS: ChannelExternalMember[] = [];

function requestChannelMembers(channelId: string): Promise<ChannelMembersPayload> {
  const existing = inFlightMemberRequests.get(channelId);
  if (existing) return existing;

  const actorScope = currentActorScope();
  const request = api.get(`/channels/${channelId}/members`)
    .then(({ data }) => {
      const payload = {
        agents: (data.agents ?? []) as ChannelAgent[],
        humans: (data.humans ?? []) as ChannelHuman[],
        externalMembers: (data.externalMembers ?? []) as ChannelExternalMember[],
      };
      // A joint channel's roster names the other server's people and agents
      // with their own serverId: the one place their faces arrive in bulk.
      // Entries without a serverId are skipped rather than guessed.
      if (actorScope) {
        upsertActorsIfCurrent(actorScope, [
          ...payload.humans.map((human) => humanActorRow(human.id, human)),
          ...payload.agents.map((agent) => agentActorRow(agent)),
        ]);
      }
      return payload;
    })
    .finally(() => {
      if (inFlightMemberRequests.get(channelId) === request) {
        inFlightMemberRequests.delete(channelId);
      }
    });
  inFlightMemberRequests.set(channelId, request);
  return request;
}

function hydrateChannelAgentActivities(agents: ChannelAgent[]) {
  const { updateActivity, seedExternalSeenFromRoster } = useAgentStore.getState();
  // A joint channel's other-server external agents: presence is in no agent
  // list the viewer has, so the roster's lastSeenAt seeds it.
  seedExternalSeenFromRoster(agents);
  for (const agent of agents) {
    if (typeof agent.activity === "string") {
      // #wg-rbac:#57: the roster's code, so a member's status reads its catalog copy.
      updateActivity(agent.id, agent.activity, agent.activityDetail || "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, agent.activityErrorCode);
    }
  }
}

/**
 * Fetches and manages the list of all members (agents + humans) assigned to a channel.
 * Automatically re-fetches when a `channel:members-updated` socket event fires for this channel.
 */
export function useChannelMembers(channelId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const requestVersionRef = useRef(0);
  const [result, setResult] = useState<{
    channelId: string;
    agents: ChannelAgent[];
    humans: ChannelHuman[];
    externalMembers: ChannelExternalMember[];
  } | null>(null);
  const [roleChangeFailedChannelId, setRoleChangeFailedChannelId] = useState<string | null>(null);
  const roleChangeFailed = roleChangeFailedChannelId === channelId;
  const channelAgentSnapshots = result?.channelId === channelId ? result.agents : EMPTY_CHANNEL_AGENTS;
  const channelHumans = result?.channelId === channelId ? result.humans : EMPTY_CHANNEL_HUMANS;
  const channelExternalMembers = result?.channelId === channelId
    ? result.externalMembers
    : EMPTY_CHANNEL_EXTERNAL_MEMBERS;
  const loading = enabled && Boolean(channelId) && result?.channelId !== channelId;
  const canonicalAgents = useAgentStore((state) => state.agents);
  const channelAgents = useMemo(() => {
    if (channelAgentSnapshots.length === 0 || canonicalAgents.length === 0) {
      return channelAgentSnapshots;
    }
    const canonicalById = new Map(canonicalAgents.map((agent) => [agent.id, agent]));
    return channelAgentSnapshots.map((snapshot) => {
      const canonical = canonicalById.get(snapshot.id);
      // Preserve relation-only fields (for example the activity snapshot), but
      // let every canonical profile field win for a known local identity.
      return canonical ? { ...snapshot, ...canonical } : snapshot;
    });
  }, [canonicalAgents, channelAgentSnapshots]);

  const loadMembers = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    if (!enabled || !channelId) return;
    try {
      const { agents, humans, externalMembers } = await requestChannelMembers(channelId);
      hydrateChannelAgentActivities(agents);
      if (requestVersion !== requestVersionRef.current) return;
      setResult({
        channelId,
        agents,
        humans,
        externalMembers,
      });
    } catch (err) {
      console.error(`Failed to load members for channel ${channelId}:`, err);
      if (requestVersion !== requestVersionRef.current) return;
      setResult({ channelId, agents: [], humans: [], externalMembers: [] });
    }
  }, [channelId, enabled]);

  // Async-loader pattern: `channelAgentSnapshots` and `channelHumans` are
  // server-fetched membership relations, not prop-derived state. Agent profile
  // fields are projected from the canonical agent store above: an avatar/name
  // update must not require refetching an unchanged membership relation, while
  // remote/joint agents absent from this server's directory retain the snapshot
  // as their fallback identity.
  useEffect(() => {
    if (!enabled) return;
    // oxlint-disable-next-line react-doctor/no-derived-state
    loadMembers();
  }, [enabled, loadMembers]);

  // Listen for real-time membership changes
  useEffect(() => {
    if (!enabled || !channelId) return;
    const socket = getSocket();
    const handler = (data: { channelId: string }) => {
      if (data.channelId === channelId) {
        loadMembers();
      }
    };
    socket.on("channel:members-updated", handler);
    return () => {
      socket.off("channel:members-updated", handler);
    };
  }, [channelId, enabled, loadMembers]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeChannelMembersChanged((changedChannelId) => {
      if (changedChannelId === null || changedChannelId === channelId) {
        loadMembers();
      }
    });
  }, [channelId, enabled, loadMembers]);

  const addAgent = useCallback(async (agentId: string, context?: { actionCardMessageId?: string; actionCardConfirmationVersion?: number }) => {
    try {
      await api.post(`/channels/${channelId}/members`, {
        agentId,
        ...(context?.actionCardMessageId ? { actionCardMessageId: context.actionCardMessageId } : {}),
        ...(context?.actionCardConfirmationVersion !== undefined ? { actionCardConfirmationVersion: context.actionCardConfirmationVersion } : {}),
      });
      notifyChannelMembersChanged(channelId);
      await loadMembers();
    } catch (err) {
      console.error(`Failed to add agent ${agentId} to channel ${channelId}:`, err);
      // Rethrow so batch callers (AddMembersDialog, the topbar-overflow
      // multi-select add flow) can track per-row success — previously the
      // swallow made every row look added even when the POST failed.
      throw err;
    }
  }, [channelId, loadMembers]);

  const removeAgent = useCallback(async (agentId: string) => {
    try {
      await api.delete(`/channels/${channelId}/members/agent/${agentId}`);
      notifyChannelMembersChanged(channelId);
      await loadMembers();
    } catch (err) {
      console.error(`Failed to remove agent ${agentId} from channel ${channelId}:`, err);
    }
  }, [channelId, loadMembers]);

  const addHuman = useCallback(async (userId: string, context?: { actionCardMessageId?: string; actionCardConfirmationVersion?: number }) => {
    try {
      await api.post(`/channels/${channelId}/members`, {
        userId,
        ...(context?.actionCardMessageId ? { actionCardMessageId: context.actionCardMessageId } : {}),
        ...(context?.actionCardConfirmationVersion !== undefined ? { actionCardConfirmationVersion: context.actionCardConfirmationVersion } : {}),
      });
      notifyChannelMembersChanged(channelId);
      await loadMembers();
    } catch (err) {
      console.error(`Failed to add human ${userId} to channel ${channelId}:`, err);
      throw err;
    }
  }, [channelId, loadMembers]);

  const addMembers = useCallback(async (
    input: AddChannelMembersBatchInput,
  ): Promise<AddChannelMembersBatchResult> => {
    try {
      const { data } = await api.post(`/channels/${channelId}/members/batch`, input);
      notifyChannelMembersChanged(channelId);
      await loadMembers();
      return {
        added: data.added as AddChannelMembersBatchInput,
        alreadyMembers: data.alreadyMembers as AddChannelMembersBatchInput,
      };
    } catch (err) {
      console.error(`Failed to add channel members to channel ${channelId}:`, err);
      throw err;
    }
  }, [channelId, loadMembers]);

  const removeHuman = useCallback(async (userId: string) => {
    try {
      await api.delete(`/channels/${channelId}/members/user/${userId}`);
      notifyChannelMembersChanged(channelId);
      await loadMembers();
    } catch (err) {
      console.error(`Failed to remove human ${userId} from channel ${channelId}:`, err);
    }
  }, [channelId, loadMembers]);

  const changeMemberRole = useCallback(async (
    targetType: "user" | "agent",
    memberId: string,
    role: ChannelRole,
  ) => {
    setRoleChangeFailedChannelId(null);
    try {
      await api.patch(`/channels/${channelId}/members/${targetType}/${memberId}/role`, { role });
      notifyChannelMembersChanged(channelId);
      await loadMembers();
    } catch (err) {
      console.error(`Failed to change ${targetType} ${memberId} role in channel ${channelId}:`, err);
      setRoleChangeFailedChannelId(channelId);
      // A rejected write did not change the roster. Keep the current view
      // mounted so its error boundary remains visible; a socket/capability
      // invalidation will still refresh stale authority independently.
      throw err;
    }
  }, [channelId, loadMembers]);
  return {
    channelAgents,
    channelHumans,
    channelExternalMembers,
    loading,
    loadMembers,
    addAgent,
    addMembers,
    removeAgent,
    addHuman,
    removeHuman,
    changeMemberRole,
    roleChangeFailed,
  };
}
