import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Users, Plus, X, Search } from "lucide-react";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import {
  CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type { AgentActivity } from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useAuthStore } from "../../store/authStore";
import AvatarSlot from "../ui/AvatarSlot";
import SectionEyebrow from "../ui/SectionEyebrow";
import FormField from "../ui/FormField";
import AgentActivityDot from "./AgentActivityDot";
import {
  ChannelMemberListShell,
  ChannelMemberHoverActions,
  ChannelMemberRoleAndActions,
  ChannelMemberRow,
  ChannelMemberSectionHeader,
} from "../channel/ChannelMemberList";
import ConfirmDialog from "../ConfirmDialog";
import Modal from "../Modal";
import Button from "../ui/Button";
import { primeHumanProfileFromChannelMember, setCachedAgentProfile } from "../profile/profileFallbackCache";
import { isLocalProjectionMember } from "../../utils/channelLocalMembership";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { createPeopleSuggestionSearchEntries } from "../../utils/peopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import { formatActivityText } from "../../utils/activity";

function agentStatusFallbackActivity(status: Agent["status"]): AgentActivity {
  return status === "active" ? "online" : "offline";
}

function AgentActivityInfo({ agentId, fallbackStatus }: { agentId: string; fallbackStatus: Agent["status"] }) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  const activityText = formatActivityText(
    formatMessage,
    displayState.activity,
    displayState.activityDetail,
    displayState.activityDetailKind,
  );
  return (
    <div className="text-xs text-black/50 font-mono truncate">
      {activityText}
    </div>
  );
}

function JointPeerBadge({ label }: { label: string }) {
  return (
    <span className="inline-block max-w-full truncate border border-black bg-brutal-cyan/25 px-1 font-mono text-[10px] font-bold uppercase leading-4 text-black">
      {label}
    </span>
  );
}

function MemberSecondary({
  primary,
  jointPeerLabel,
}: {
  primary?: ReactNode;
  jointPeerLabel?: string | null;
}) {
  if (!jointPeerLabel) return primary || null;
  return (
    <div className="min-w-0 space-y-0.5">
      {primary}
      <JointPeerBadge label={jointPeerLabel} />
    </div>
  );
}

function AddMemberCandidateBody({
  name,
  description,
}: {
  name: ReactNode;
  description?: string | null;
}) {
  const normalizedDescription = description?.trim();

  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 items-center">
        <span className="truncate text-sm font-medium text-black">{name}</span>
      </span>
      {normalizedDescription ? (
        <span
          className="block truncate text-xs font-normal text-black/60"
          title={normalizedDescription}
        >
          {normalizedDescription}
        </span>
      ) : null}
    </span>
  );
}

export default function LegacyChannelMembers({ channelId }: { channelId: string }) {
  const { formatMessage } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const channels = useChannelStore((s) => s.channels);
  const currentChannel = channels.find((c) => c.id === channelId) ?? null;
  const currentServerId = useServerStore((s) => s.current?.id);
  const canOpenAgentProfiles = true;
  // Guests may open human profiles: the panel itself filters by capability
  // (guest capabilities are empty, so message/change-role/remove never render),
  // and the chat-panel entry never gated this. Gating only the roster entry made
  // the same panel reachable from chat but not from Members.
  const canOpenHumanProfiles = true;
  const currentUserId = useAuthStore((s) => s.user?.id);
  const serverMembers = useServerStore((s) => s.members);
  const { channelAgents, channelHumans, addAgent, removeAgent, addHuman, removeHuman, changeMemberRole, roleChangeFailed } = useChannelMembers(channelId);
  const openProfile = useProfileStore((s) => s.openProfile);
  const [showPanel, setShowPanel] = useState(false);
  const [showAddSection, setShowAddSection] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [removeTarget, setRemoveTarget] = useState<{ type: "agent" | "human"; id: string; name: string } | null>(null);
  const [roleChangingKey, setRoleChangingKey] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [protectedDemoteTarget, setProtectedDemoteTarget] = useState<string | null>(null);
  const channelManagerRoleActionsEnabled = useServerFeatureFlag(
    CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  ).enabled;

  const isAllChannel = currentChannel?.name === "all" && currentChannel?.type === "channel";
  const isArchived = !!currentChannel?.archivedAt;
  const isLocalMember = (serverId?: string) =>
    !currentChannel?.serverId || !serverId || serverId === currentChannel.serverId;
  const jointPeerLabel = (serverId?: string, serverName?: string | null, serverSlug?: string | null) =>
    currentChannel?.type === "joint" && !isLocalMember(serverId)
      ? serverName || serverSlug || null
      : null;
  const totalParticipants = channelAgents.length + channelHumans.length;
  const { capabilities } = useServerPermissions();
  const canAddChannelMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: currentChannel?.serverId,
    channelHumans,
    serverMembers,
    hasChannelMemberCapability: currentChannel?.channelCapabilities?.addChannelMembers === true,
    isAllChannel,
  }) && !isArchived;
  const canRemoveChannelMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: currentChannel?.serverId,
    channelHumans,
    serverMembers,
    hasChannelMemberCapability: currentChannel?.channelCapabilities?.removeChannelMembers ?? capabilities.removeChannelMembers,
    isAllChannel,
  }) && !isArchived;

  const memberSearchEntries = useMemo(() => {
    const channelAgentIds = new Set(channelAgents.map((agent) => agent.id));
    const channelHumanIds = new Set(channelHumans
      .filter((h) => isLocalProjectionMember(h, currentChannel))
      .map((h) => h.id));
    const candidates: PeopleSuggestionCandidate<(typeof agents)[number] | (typeof serverMembers)[number]>[] = [
      ...agents.filter((agent) => !agent.deletedAt && !channelAgentIds.has(agent.id)).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
      })),
      ...serverMembers.filter((member) => !channelHumanIds.has(member.userId)).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
      })),
    ];
    return createPeopleSuggestionSearchEntries(candidates);
  }, [agents, channelAgents, channelHumans, currentChannel, serverMembers]);
  const rankedMembers = useRankedComposerSuggestions(memberSearch, memberSearchEntries);
  const filteredAgents = rankedMembers.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.value as (typeof agents)[number]);
  const filteredHumans = rankedMembers.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.value as (typeof serverMembers)[number]);
  const hasAvailable = memberSearchEntries.length > 0;
  const hasFilteredResults = filteredAgents.length > 0 || filteredHumans.length > 0;
  const memberActions = (
    targetType: "user" | "agent",
    member: (typeof channelHumans)[number] | (typeof channelAgents)[number],
    removeAction?: () => void,
  ) => {
    const serverRole = member.serverRole ?? ("role" in member ? member.role : "member");
    const effectiveRole = member.effectiveChannelRole
      ?? (serverRole === "owner" || serverRole === "admin" || member.channelRole === "admin" ? "admin" : "member");
    const protectedServerAdmin = serverRole === "owner" || serverRole === "admin";
    const canExplainProtectedDemote = !isArchived
      && !isAllChannel
      && currentChannel?.channelCapabilities?.changeChannelMemberRoles === true
      && member.id !== currentUserId
      && protectedServerAdmin
      && effectiveRole !== "member";
    const nextRole = effectiveRole === "member" ? "admin" : "member";
    const key = `${targetType}:${member.id}`;
    const canChangeRole = !isArchived && !isAllChannel && member.canChangeChannelRole;
    const showRoleAction = channelManagerRoleActionsEnabled
      && (canChangeRole || canExplainProtectedDemote);
    if (!showRoleAction && !removeAction) return null;
    return (
      <ChannelMemberHoverActions
        roleAction={showRoleAction ? {
          label: formatMessage({ id: nextRole === "admin" ? "agent.channelMembers.makeAdminShort" : "agent.channelMembers.removeAdminShort" }),
          ariaLabel: formatMessage(
            { id: nextRole === "admin" ? "agent.channelMembers.makeAdmin" : "agent.channelMembers.removeAdmin" },
            { name: member.name },
          ),
          disabled: roleChangingKey === key,
          onClick: () => {
            if (canExplainProtectedDemote) {
              setProtectedDemoteTarget(member.displayName || member.name);
              return;
            }
            setRoleError(null);
            setRoleChangingKey(key);
            void changeMemberRole(targetType, member.id, nextRole)
              .catch(() => setRoleError(formatMessage({ id: "agent.channelMembers.updateRoleFailed" })))
              .finally(() => setRoleChangingKey((current) => current === key ? null : current));
          },
        } : undefined}
        removeAction={removeAction ? {
          label: formatMessage({ id: "agent.channelMembers.removeName" }, { name: member.name }),
          onClick: removeAction,
        } : undefined}
      />
    );
  };

  return (
    <>
      {/* Member count button in header */}
      <Button
        onClick={() => setShowPanel(true)}
        shape="iconText"
        className="min-w-7 gap-1 px-1.5"
        title={formatMessage({ id: "agent.channelMembers.viewParticipants" })}
      >
        <Users size={14} className="shrink-0" />
        <span className="min-w-[1ch] text-center font-mono text-[11px] font-bold leading-none tabular-nums">
          {totalParticipants > 99 ? "99+" : totalParticipants}
        </span>
      </Button>

      {/* Members modal panel */}
      {showPanel && (
        <Modal onClose={() => { setShowPanel(false); setShowAddSection(false); setMemberSearch(""); setRoleError(null); }}>
          <div className="w-full max-w-sm card-brutal p-6">
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold uppercase">
                {formatMessage({ id: "agent.channelMembers.membersCount" }, { count: totalParticipants })}
              </h2>
              <button
                onClick={() => { setShowPanel(false); setShowAddSection(false); setMemberSearch(""); setRoleError(null); }}
                className="btn-brutal-sm bg-white p-1"
              >
                <X size={20} />
              </button>
            </div>

            {/* Member list */}
            <ChannelMemberListShell>
              {(roleError || roleChangeFailed) && (
                <div className="m-3 border-2 border-black bg-brutal-red/20 px-3 py-2 text-sm font-bold" role="alert" data-testid="channel-member-role-error">
                  {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
                </div>
              )}
              {/* Agents section */}
              {channelAgents.length > 0 && (
                <>
                  <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.agents" })}</ChannelMemberSectionHeader>
                  {channelAgents.map((agent) => {
                    const canRemoveAgent = isLocalMember(agent.serverId);
                    const peerLabel = jointPeerLabel(agent.serverId, agent.serverName, agent.serverSlug);
                    return (
                      <ChannelMemberRow
                        key={agent.id}
                        type="agent"
                        agentId={agent.id}
                        agentAvatarUrl={agent.avatarUrl}
                        agentFallbackActivity={agentStatusFallbackActivity(agent.status)}
                        name={(
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{agent.displayName || agent.name}</span>
                            {peerLabel && <JointPeerBadge label={peerLabel} />}
                          </span>
                        )}
                        secondary={(
                          <MemberSecondary
                            primary={<AgentActivityInfo agentId={agent.id} fallbackStatus={agent.status} />}
                          />
                        )}
                        onAvatarClick={canOpenAgentProfiles ? () => {
                          setCachedAgentProfile(currentServerId, agent);
                          setShowPanel(false);
                          openProfile("agent", agent.id);
                        } : undefined}
                        trailing={<ChannelMemberRoleAndActions
                          role={agent.effectiveChannelRole ?? agent.serverRole ?? "member"}
                          actions={memberActions(
                            "agent",
                            agent,
                            !isAllChannel && canRemoveChannelMembers && canRemoveAgent
                              ? () => setRemoveTarget({ type: "agent", id: agent.id, name: agent.displayName || agent.name })
                              : undefined,
                          )}
                        />}
                      />
                    );
                  })}
                </>
              )}

              {/* Humans section */}
              {channelHumans.length > 0 && (
                <>
                  <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.humans" })}</ChannelMemberSectionHeader>
                  {channelHumans.map((human) => {
                    const canRemoveHuman = isLocalMember(human.serverId);
                    const peerLabel = jointPeerLabel(human.serverId, human.serverName, human.serverSlug);
                    return (
                      <ChannelMemberRow
                        key={human.id}
                        type="human"
                        humanAvatarUrl={human.avatarUrl}
                        gravatarHash={human.gravatarHash}
                        name={(
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{human.displayName || human.name}</span>
                            {peerLabel && <JointPeerBadge label={peerLabel} />}
                          </span>
                        )}
                        secondary={(
                          <MemberSecondary
                            primary={human.description ? <div className="truncate">{human.description}</div> : undefined}
                          />
                        )}
                        onAvatarClick={canOpenHumanProfiles ? () => {
                          if (currentChannel?.serverId) {
                            primeHumanProfileFromChannelMember(currentChannel.serverId, human);
                          }
                          setShowPanel(false);
                          openProfile("human", human.id);
                        } : undefined}
                        trailing={<ChannelMemberRoleAndActions
                          role={human.effectiveChannelRole ?? human.role}
                          actions={memberActions(
                            "user",
                            human,
                            !isAllChannel && canRemoveChannelMembers && canRemoveHuman
                              ? () => setRemoveTarget({ type: "human", id: human.id, name: human.displayName || human.name })
                              : undefined,
                          )}
                        />}
                      />
                    );
                  })}
                </>
              )}

              {totalParticipants === 0 && (
                <div className="px-3 py-4 text-sm text-black/50 font-mono text-center">
                  {formatMessage({ id: "agent.channelMembers.noMembers" })}
                </div>
              )}
            </ChannelMemberListShell>

            {/* Action buttons (hidden for #all) */}
            {!isAllChannel && canAddChannelMembers && (
              <div className="mt-4">
                <button
                  onClick={() => setShowAddSection(true)}
                  disabled={!hasAvailable}
                  className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-pink px-3 py-1.5 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={14} />
                  {formatMessage({ id: "agent.channelMembers.addMember" })}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Add Member modal (stacked on top of Members modal) */}
      {showAddSection && canAddChannelMembers && (
        <Modal onClose={() => setShowAddSection(false)} layer={1}>
          <div className="w-full max-w-sm card-brutal p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold uppercase">{formatMessage({ id: "agent.channelMembers.addMember" })}</h2>
              <button
                onClick={() => { setShowAddSection(false); setMemberSearch(""); }}
                className="btn-brutal-sm bg-white p-1"
              >
                <X size={20} />
              </button>
            </div>

            {hasAvailable && (
              <FormField label={formatMessage({ id: "agent.channelMembers.search" })} className="mb-3">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40" />
                  <input
                    type="text"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="input-brutal input-member-search w-full pl-9"
                    placeholder={formatMessage({ id: "agent.channelMembers.namePlaceholder" })}
                    autoFocus
                  />
                </div>
              </FormField>
            )}

            <div className="border-2 border-black bg-white shadow-brutal-sm max-h-72 overflow-y-auto">
              {/* Available agents */}
              {filteredAgents.length > 0 && (
                <>
                  <SectionEyebrow as="div" className="px-3 py-1.5 bg-white/50">
                    {formatMessage({ id: "agent.channelMembers.agents" })}
                  </SectionEyebrow>
                  {filteredAgents.map((agent) => {
                    return (
                      <button
                        key={agent.id}
                        onClick={() => addAgent(agent.id)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-black transition-colors hover:bg-soft-signal [@media(max-height:600px)]:py-1"
                      >
                        <AvatarSlot
                          context="compact-list"
                          type="agent"
                          agentAvatarUrl={agent.avatarUrl}
                          badge={<AgentActivityDot agentId={agent.id} />}
                          className="self-center"
                        />
                        <AddMemberCandidateBody
                          name={agent.displayName || agent.name}
                          description={agent.description}
                        />
                      </button>
                    );
                  })}
                </>
              )}

              {/* Available humans */}
              {filteredHumans.length > 0 && (
                <>
                  <SectionEyebrow as="div" className="px-3 py-1.5 bg-white/50">
                    {formatMessage({ id: "agent.channelMembers.humans" })}
                  </SectionEyebrow>
                  {filteredHumans.map((human) => (
                    <button
                      key={human.userId}
                      onClick={() => addHuman(human.userId)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-black transition-colors hover:bg-soft-signal [@media(max-height:600px)]:py-1"
                    >
                      <AvatarSlot
                        context="compact-list"
                        type="human"
                        humanAvatarUrl={human.avatarUrl}
                        gravatarHash={human.gravatarHash}
                        className="self-center"
                      />
                      <AddMemberCandidateBody
                        name={human.displayName || human.name}
                        description={human.description}
                      />
                    </button>
                  ))}
                </>
              )}

              {!hasAvailable && (
                <div className="px-3 py-4 text-sm text-black/50 font-mono text-center">
                  {formatMessage({ id: "agent.channelMembers.allMembersAdded" })}
                </div>
              )}

              {hasAvailable && !hasFilteredResults && (
                <div className="px-3 py-4 text-sm text-black/50 font-mono text-center">
                  {formatMessage({ id: "agent.channelMembers.noMatches" }, { query: memberSearch.trim() })}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.channelMembers.removeMemberTitle" })}
          message={formatMessage(
            { id: "agent.channelMembers.removeMemberMessage" },
            { name: removeTarget.name, channel: currentChannel?.name || formatMessage({ id: "agent.channelMembers.thisChannel" }) },
          )}
          confirmLabel={formatMessage({ id: "agent.channelMembers.removeMemberTitle" })}
          loadingLabel={formatMessage({ id: "agent.channelMembers.removing" })}
          layer={1}
          onConfirm={() =>
            removeTarget.type === "agent"
              ? removeAgent(removeTarget.id)
              : removeHuman(removeTarget.id)
          }
          onClose={() => setRemoveTarget(null)}
        />
      )}
      {protectedDemoteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.channelMembers.cannotDemoteServerAdminTitle" })}
          message={formatMessage(
            { id: "agent.channelMembers.cannotDemoteServerAdminMessage" },
            { name: protectedDemoteTarget },
          )}
          confirmLabel={formatMessage({ id: "common.ok" })}
          confirmColor="bg-white"
          hideCancel
          closeOnConfirm={false}
          onConfirm={() => setProtectedDemoteTarget(null)}
          onClose={() => setProtectedDemoteTarget(null)}
          layer={1}
          chromeLocale="active"
        />
      )}
    </>
  );
}
