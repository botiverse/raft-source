import { Button } from "@botiverse/raft-ui";
import { X } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { ThreadAgentFollower } from "../../store/threadAgentFollowerStore";
import { useProfileStore } from "../../store/profileStore";
import { AgentActivityInfo, agentStatusFallbackActivity } from "../agent/channelMemberParts";
import { ChannelMemberRow } from "../channel/ChannelMemberList";
import type { Agent } from "../../store/agentStore";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import Tooltip from "../ui/Tooltip";

/** The follower endpoint reports transport-ish statuses (for example
 *  "online"); normalize to the shared AgentStatus union the activity stores
 *  and profiles speak (task #701). */
function followerAgentStatus(status: string | null | undefined): Agent["status"] {
  return status === "active" || status === "online"
    ? "active"
    : status === "stopped" ? "stopped" : "inactive";
}

export function ThreadAgentFollowerRow({ agent, canManage, removing, currentServerId, onRemove, onOpenProfile }: {
  agent: ThreadAgentFollower;
  canManage: boolean | undefined;
  removing: boolean;
  currentServerId: string | undefined;
  onRemove: (agentId: string, agentLabel: string) => Promise<void>;
  /** Opens the profile where the owner shows it (the task dialog); the app's
   *  profile panel otherwise. */
  onOpenProfile?: (agentId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const openProfile = useProfileStore((state) => state.openProfile);
  const agentLabel = agent.displayName || agent.name;
  // The server decides per Agent (`canRemove`): in a joint channel the host's
  // owner/admin or appointed manager may remove any server's Agent; another
  // server's admin only its own server's (#triage:#225).
  const canRemoveAgent = canManage && agent.canRemove !== false;
  const serverLabel = agent.serverName || agent.serverSlug;
  const removeLabel = canRemoveAgent
    ? formatMessage({ id: "thread.followers.remove" }, { agent: agentLabel })
    : formatMessage({ id: "thread.followers.peerRemoveHostOnly" });

  const openAgentProfile = useCallback(() => {
    setCachedAgentProfile(currentServerId, {
      ...agent,
      // Normalize before seeding the fallback cache so peer rows
      // can open a complete profile.
      status: followerAgentStatus(agent.status),
      description: null,
      model: "",
      runtime: "",
      serverRole: null,
      reasoningEffort: null,
      executionMode: "cloud",
      envVars: null,
      machineId: null,
      creatorType: null,
      creatorId: null,
      creator: null,
      createdAgents: [],
      deletedAt: null,
      createdAt: "",
    });
    if (onOpenProfile) onOpenProfile(agent.id);
    else openProfile("agent", agent.id);
  }, [agent, currentServerId, onOpenProfile, openProfile]);

  const handleRemoveClick = useCallback(() => {
    if (!canRemoveAgent) return;
    void onRemove(agent.id, agentLabel);
  }, [agent.id, agentLabel, canRemoveAgent, onRemove]);

  return (
    // artin (task #701): reuse the members list's row wholesale, so
    // the avatar's activity badge and the status sub-line stay
    // structurally identical to that surface.
    <div data-testid="thread-follower-row">
      <ChannelMemberRow
        type="agent"
        agentId={agent.id}
        agentAvatarUrl={agent.avatarUrl}
        agentFallbackActivity={agentStatusFallbackActivity(followerAgentStatus(agent.status))}
        name={(
          // An agent from another server: its server's name in quiet text after
          // its own, as a channel's member list writes it (MemberRowName; cindyz,
          // 2026-11-13, #wg-rbac:38225c7c: it was a blue chip here). The server
          // name gives way before the agent's.
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 shrink truncate">{agentLabel}</span>
            {agent.isCurrentServer === false && serverLabel ? (
              <span data-testid="thread-follower-origin-server" className="min-w-0 shrink-[999] truncate text-caption font-normal text-foreground-hint">
                {serverLabel}
              </span>
            ) : null}
          </span>
        )}
        secondary={<AgentActivityInfo agentId={agent.id} fallbackStatus={followerAgentStatus(agent.status)} />}
        onRowClick={openAgentProfile}
        trailing={canManage ? (
          <Tooltip content={removeLabel}>
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              className={canRemoveAgent ? undefined : "cursor-not-allowed"}
              disabled={!canRemoveAgent || removing}
              onClick={handleRemoveClick}
              aria-label={removeLabel}
              data-testid="thread-follower-remove"
            >
              <X size={14} />
            </Button>
          </Tooltip>
        ) : undefined}
      />
    </div>
  );
}
