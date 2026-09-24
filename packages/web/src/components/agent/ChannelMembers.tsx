import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, Users, Plus, X, Search } from "lucide-react";
import {
  SidebarList,
  SidebarSection,
  SidebarSectionChevron,
  SidebarSectionCount,
  SidebarSectionDisclosure,
  SidebarSectionHeader,
  SidebarSectionTitle,
} from "raft-ui";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { AgentActivity } from "@botiverse/raft-shared";
import {
  CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import CreateAgentDialog from "./CreateAgentDialog";
import CheckMarker from "../ui/CheckMarker";
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
import { useChannelMemberRemoval } from "../channel/useChannelMemberRemoval";
import Modal from "../Modal";
import ConfirmDialog from "../ConfirmDialog";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import type { ProfilePanelTarget } from "../profile/ProfilePanel";
import { primeHumanProfileFromChannelMember, setCachedAgentProfile } from "../profile/profileFallbackCache";
import { isLocalProjectionMember } from "../../utils/channelLocalMembership";
import { usePeopleSuggestionSearch } from "../../hooks/usePeopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import { formatActivityText } from "../../utils/activity";
import LegacyChannelMembers from "./LegacyChannelMembers";

const ProfilePanel = lazy(() => import("../profile/ProfilePanel"));

// Shared by the modal/panel member list and the drawer-internal members
// page (presentation="page"), which renders the same per-agent activity
// sub-line.
export function agentStatusFallbackActivity(status: Agent["status"]): AgentActivity {
  return status === "active" ? "online" : "offline";
}

export function AgentActivityInfo({ agentId, fallbackStatus }: { agentId: string; fallbackStatus: Agent["status"] }) {
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

// Shared by the modal/panel member list and the members page, which shows
// the same remote-server badge on joint-channel rows.
export function JointPeerBadge({ label }: { label: string }) {
  return (
    <span className="inline-block max-w-full truncate border border-black bg-brutal-cyan/25 px-1 font-mono text-[10px] font-bold leading-4 text-black">
      {label}
    </span>
  );
}

/** Live roster filter for the members page search box — matches on the
 *  handle or the display name, case-insensitive (query pre-normalized). */
function memberMatches(query: string, name: string, displayName: string | null): boolean {
  if (!query) return true;
  return (
    name.toLowerCase().includes(query)
    || (displayName ?? "").toLowerCase().includes(query)
  );
}

/** Raft UI disclosure for one member kind on the drawer-internal roster
 * page. Both categories start expanded; the primitive owns keyboard/ARIA
 * state and chevron rotation, while filtering continues to own the live
 * count and whether an empty category is rendered at all. */
function MemberPageSection({
  kind,
  label,
  count,
  children,
}: {
  kind: "humans" | "agents" | "external";
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <SidebarSection
      defaultOpen
      data-testid={`member-page-section-${kind}-group`}
    >
      <SidebarSectionHeader>
        <SidebarSectionDisclosure
          className="!normal-case"
          data-testid={`member-page-section-${kind}-toggle`}
        >
          <SidebarSectionChevron />
          <span
            className="flex min-w-0 items-center"
            data-testid={`member-page-section-${kind}`}
          >
            <SidebarSectionTitle>{label}</SidebarSectionTitle>
            <SidebarSectionCount>{" · "}{count}</SidebarSectionCount>
          </span>
        </SidebarSectionDisclosure>
      </SidebarSectionHeader>
      <SidebarList data-testid={`member-page-section-${kind}-panel`}>
        {children}
      </SidebarList>
    </SidebarSection>
  );
}

function AddMemberCandidateBody({
  name,
  description,
  trailing,
}: {
  name: ReactNode;
  description?: string | null;
  trailing?: ReactNode;
}) {
  const normalizedDescription = description?.trim();

  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-black">{name}</span>
        {trailing}
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

/** Selection-set key for the multi-select add flow — ids are UUIDs, so
 *  a `kind:id` prefix never collides with the id itself. */
function candidateKey(kind: "agent" | "human", id: string): string {
  return `${kind}:${id}`;
}

type ChannelMembersProps = {
  channelId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  presentation?: "modal" | "panel" | "page";
  onRequestClose?: () => void;
  onBack?: () => void;
  onClose?: () => void;
  initialView?: "add";
  prefetchedMembers?: {
    channelAgents: ChannelAgent[];
    channelHumans: ChannelHuman[];
    channelExternalMembers?: ChannelExternalMember[];
    loading: boolean;
    addMembers: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    addAgent: (agentId: string) => Promise<void>;
    removeAgent: (agentId: string) => Promise<void>;
    addHuman: (userId: string) => Promise<void>;
    removeHuman: (userId: string) => Promise<void>;
    changeMemberRole: (targetType: "user" | "agent", memberId: string, role: "member" | "admin") => Promise<void>;
    roleChangeFailed: boolean;
  };
};

function GatedChannelMembers({
  channelId,
  open,
  onOpenChange,
  hideTrigger = false,
  presentation = "modal",
  onRequestClose,
  onBack,
  onClose,
  initialView,
  prefetchedMembers,
}: ChannelMembersProps) {
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
  const localMembers = useChannelMembers(channelId, { enabled: !prefetchedMembers });
  const {
    channelAgents,
    channelHumans,
    channelExternalMembers = [],
    loading: membersLoading,
    addMembers,
    addAgent,
    removeAgent,
    addHuman,
    removeHuman,
    changeMemberRole,
    roleChangeFailed,
  } = prefetchedMembers ?? localMembers;
  const openProfile = useProfileStore((s) => s.openProfile);
  const topbarOverflowEnabled = useServerFeatureFlag(TOPBAR_OVERFLOW_FEATURE_FLAG_KEY).enabled;
  const channelManagerRoleActionsEnabled = useServerFeatureFlag(
    CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  ).enabled;
  const [internalShowPanel, setInternalShowPanel] = useState(false);
  const isPanel = presentation === "panel";
  const isPage = presentation === "page";
  const showPanel = open ?? internalShowPanel;
  const setShowPanel = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setInternalShowPanel(next);
  };
  const [showAddSection, setShowAddSection] = useState(initialView === "add");
  const [memberSearch, setMemberSearch] = useState("");
  // Members page (page mode) live roster filter — separate from the add
  // flow's candidate search (`memberSearch`).
  const [rosterQuery, setRosterQuery] = useState("");
  const [profileStack, setProfileStack] = useState<ProfilePanelTarget[]>([]);
  const selectedProfile = profileStack.at(-1) ?? null;
  const backProfile = useCallback(() => {
    setProfileStack((stack) => stack.slice(0, -1));
  }, []);
  const closeProfilePage = useCallback(() => {
    onClose?.();
  }, [onClose]);
  const openNestedProfile = useCallback((type: "agent" | "human", id: string) => {
    setProfileStack((stack) => [...stack, { type, id }]);
  }, []);
  const {
    requestRemove,
    confirmDialog: removeConfirmDialog,
    removeTarget,
  } = useChannelMemberRemoval({
    removeAgent,
    removeHuman,
    channelName: currentChannel?.name,
  });
  // task #187 multi-select add flow (flag-gated): selection is staged and
  // only committed on confirm; failed rows stay selected + highlighted so
  // the confirm button doubles as retry.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [failedKeys, setFailedKeys] = useState<Set<string>>(() => new Set());
  const [addError, setAddError] = useState<"none" | "some" | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  // Two-step contract (task #584): the create succeeded but the channel join
  // did not. The agent EXISTS on the server at this point — the banner + retry
  // exist so nobody "fixes" the failure by creating a same-named duplicate.
  const [pendingJoinAgent, setPendingJoinAgent] = useState<{ id: string; name: string } | null>(null);
  const [retryingJoin, setRetryingJoin] = useState(false);
  const [roleChangingKey, setRoleChangingKey] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [protectedDemoteTarget, setProtectedDemoteTarget] = useState<string | null>(null);

  const isAllChannel = currentChannel?.name === "all" && currentChannel?.type === "channel";
  const isArchived = !!currentChannel?.archivedAt;
  const isLocalMember = (serverId?: string) =>
    !currentChannel?.serverId || !serverId || serverId === currentChannel.serverId;
  const jointPeerLabel = (serverId?: string, serverName?: string | null, serverSlug?: string | null) =>
    currentChannel?.type === "joint" && !isLocalMember(serverId)
      ? serverName || serverSlug || null
      : null;
  const totalParticipants = channelAgents.length + channelHumans.length + channelExternalMembers.length;
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

  const memberSearchCandidates = useMemo(() => {
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
    return candidates;
  }, [agents, channelAgents, channelHumans, currentChannel, serverMembers]);
  const { entries: memberSearchEntries, ranked: rankedMembers } = usePeopleSuggestionSearch(
    memberSearch,
    memberSearchCandidates,
  );
  const filteredAgents = rankedMembers.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.value as (typeof agents)[number]);
  const filteredHumans = rankedMembers.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.value as (typeof serverMembers)[number]);
  const hasAvailable = memberSearchEntries.length > 0;
  const hasFilteredResults = filteredAgents.length > 0 || filteredHumans.length > 0;

  const candidateNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(candidateKey("agent", agent.id), agent.displayName || agent.name);
    }
    for (const member of serverMembers) {
      map.set(candidateKey("human", member.userId), member.displayName || member.name);
    }
    return map;
  }, [agents, serverMembers]);

  const resetAddFlow = () => {
    setShowAddSection(false);
    setMemberSearch("");
    setSelectedKeys(new Set());
    setFailedKeys(new Set());
    setAddError(null);
    setAdding(false);
  };
  const closePanel = () => {
    resetAddFlow();
    setRoleError(null);
    if (isPanel || isPage) onRequestClose?.();
    else setShowPanel(false);
  };

  const toggleCandidate = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // A touched row is no longer "failed" — the highlight follows the
    // last confirm attempt, not the user's corrections after it.
    setFailedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setAddError(null);
  };

  const handleConfirmAdd = async () => {
    if (adding || selectedKeys.size === 0) return;
    setAdding(true);
    setAddError(null);
    const userIds: string[] = [];
    const agentIds: string[] = [];
    for (const key of selectedKeys) {
      const sep = key.indexOf(":");
      const kind = key.slice(0, sep);
      const id = key.slice(sep + 1);
      if (kind === "agent") agentIds.push(id);
      else userIds.push(id);
    }
    try {
      await addMembers({ userIds, agentIds });
      resetAddFlow();
    } catch {
      // The server batch is atomic, so a rejected request means every selected
      // row remains unresolved and should stay selected for correction/retry.
      setFailedKeys(new Set(selectedKeys));
      // One failure, one story (task #584 D-state, Duoyu's corrected rule):
      // the D strip may replace the generic banner only when it covers the
      // WHOLE failed batch — i.e. the batch was exactly the pending agent.
      // In a mixed batch the two messages are not redundant: the strip talks
      // about the agent ("exists, don't re-create"), the generic banner is
      // the only sentence the other failed members get.
      const onlyPendingAgent = pendingJoinAgent
        && userIds.length === 0
        && agentIds.length === 1
        && agentIds[0] === pendingJoinAgent.id;
      if (!onlyPendingAgent) {
        setAddError("none");
      }
    } finally {
      setAdding(false);
    }
  };

  const showAddEntry = !membersLoading && canAddChannelMembers;

  const renderMemberActions = (
    targetType: "user" | "agent",
    member: ChannelHuman | ChannelAgent,
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
    const canChangeRole = !isArchived && !isAllChannel && member.canChangeChannelRole;
    const showRoleAction = channelManagerRoleActionsEnabled
      && (canChangeRole || canExplainProtectedDemote);
    if (!showRoleAction && !removeAction) return null;
    const nextRole = effectiveRole === "member" ? "admin" : "member";
    const key = `${targetType}:${member.id}`;
    return (
      <ChannelMemberHoverActions
        roleAction={showRoleAction ? {
          label: formatMessage({
            id: nextRole === "admin"
              ? "agent.channelMembers.makeAdminShort"
              : "agent.channelMembers.removeAdminShort",
          }),
          ariaLabel: formatMessage({
            id: nextRole === "admin"
              ? "agent.channelMembers.makeAdmin"
              : "agent.channelMembers.removeAdmin",
          }, { name: member.name }),
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

  /* Per-member row renderers, single-sourced between the modal/panel
     member list and the members page (page mode): the page makes the
     whole row the profile button and adds the server-role tag in the
     trailing slot; modal/panel keep the avatar-click affordance. */
  const renderAgentRow = (agent: ChannelAgent, pageMode: boolean) => {
    const canRemoveAgent = isLocalMember(agent.serverId);
    const peerLabel = jointPeerLabel(agent.serverId, agent.serverName, agent.serverSlug);
    const openAgentProfile = () => {
      setCachedAgentProfile(currentServerId, agent);
      if (isPage) {
        setProfileStack([{ type: "agent", id: agent.id }]);
        return;
      }
      closePanel();
      openProfile("agent", agent.id);
    };
    const role = agent.effectiveChannelRole ?? agent.serverRole ?? "member";
    const actions = renderMemberActions(
      "agent",
      agent,
      !isAllChannel && canRemoveChannelMembers && canRemoveAgent
        ? () => requestRemove({ type: "agent", id: agent.id, name: agent.displayName || agent.name })
        : undefined,
    );
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
        secondary={<AgentActivityInfo agentId={agent.id} fallbackStatus={agent.status} />}
        onAvatarClick={!canOpenAgentProfiles || pageMode ? undefined : openAgentProfile}
        onRowClick={canOpenAgentProfiles && pageMode ? openAgentProfile : undefined}
        trailing={<ChannelMemberRoleAndActions role={role} actions={actions} />}
      />
    );
  };

  const renderHumanRow = (human: ChannelHuman, pageMode: boolean) => {
    const canRemoveHuman = isLocalMember(human.serverId);
    const peerLabel = jointPeerLabel(human.serverId, human.serverName, human.serverSlug);
    const openHumanProfile = () => {
      if (currentChannel?.serverId) {
        primeHumanProfileFromChannelMember(currentChannel.serverId, human);
      }
      if (isPage) {
        setProfileStack([{ type: "human", id: human.id }]);
        return;
      }
      closePanel();
      openProfile("human", human.id);
    };
    const role = human.effectiveChannelRole ?? human.role;
    const actions = renderMemberActions(
      "user",
      human,
      !isAllChannel && canRemoveChannelMembers && canRemoveHuman
        ? () => requestRemove({ type: "human", id: human.id, name: human.displayName || human.name })
        : undefined,
    );
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
        secondary={human.description ? <div className="truncate">{human.description}</div> : undefined}
        onAvatarClick={!canOpenHumanProfiles || pageMode ? undefined : openHumanProfile}
        onRowClick={canOpenHumanProfiles && pageMode ? openHumanProfile : undefined}
        trailing={<ChannelMemberRoleAndActions role={role} actions={actions} />}
      />
    );
  };

  const renderExternalRow = (member: ChannelExternalMember) => (
    <ChannelMemberRow
      key={member.id}
      type="human"
      humanAvatarUrl={member.avatarUrl}
      name={(
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{member.displayName}</span>
          <span className="border border-black bg-brutal-lavender px-1 font-mono text-[10px] font-bold uppercase leading-4 text-black">
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </span>
        </span>
      )}
      secondary={member.handles[0] ? `@${member.handles[0]}` : undefined}
    />
  );

  // The search text doubles as the new agent's suggested name. The leading
  // "@" is display notation the candidate rows themselves teach (they render
  // handles as "@duoyu"), so stripping it recovers intent; everything else —
  // spaces included — is left for the human to fix inside the dialog, because
  // rewriting "deploy bot" into a handle they did not type would be guessing
  // (task #1139 E-state ruling).
  const createAgentPrefillName = memberSearch.trim().replace(/^@/, "");
  // The name carries over ONLY from the promoted (no-hit) row — that is where
  // the row's own label promises it. A generic「创建一个新 Agent」row must not
  // smuggle the search text into the dialog (Duoyu, PR #7372 design review).
  const createEntryPromoted = createAgentPrefillName.length > 0 && !hasFilteredResults;
  const joinCreatedAgent = async (agent: { id: string; name: string }) => {
    setRetryingJoin(true);
    try {
      // Same atomic batch facade as「添加所选」(handleConfirmAdd) — ONE
      // underlying call and ONE error contract for every way a created agent
      // reaches this channel (review finding on PR #7372: addAgent's single
      // POST was a second code path with its own failure semantics).
      await addMembers({ userIds: [], agentIds: [agent.id] });
      setPendingJoinAgent(null);
      setSelectedKeys((prev) => {
        const key = candidateKey("agent", agent.id);
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setMemberSearch("");
    } catch {
      setPendingJoinAgent(agent);
      // Stage the created agent in the ordinary flow too: the banner's retry
      // and「添加所选」both resolve through the same useChannelMembers add
      // path, so either affordance completes the join — no second mechanism.
      setSelectedKeys((prev) => new Set(prev).add(candidateKey("agent", agent.id)));
    } finally {
      setRetryingJoin(false);
    }
  };

  const addCandidateRows = (multiSelect: boolean, fillAvailableHeight = false) => (
    <div
      className={`border-2 border-black bg-white shadow-brutal-sm overflow-y-auto ${fillAvailableHeight ? "min-h-0 flex-1" : "max-h-72"}`}
      data-testid={multiSelect ? "add-member-candidate-list" : undefined}
    >
      {/* Available agents */}
      {filteredAgents.length > 0 && (
        <>
          <SectionEyebrow as="div" uppercase={false} className="px-3 py-1.5 bg-white/50">
            {formatMessage({ id: "agent.channelMembers.agents" })}
          </SectionEyebrow>
          {filteredAgents.map((agent) => {
            const key = candidateKey("agent", agent.id);
            if (!multiSelect) {
              return (
                <button
                  key={agent.id}
                  onClick={() => { void addAgent(agent.id).catch(() => {}); }}
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
            }
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => toggleCandidate(key)}
                disabled={adding}
                aria-pressed={selectedKeys.has(key)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-black transition-colors hover:bg-soft-signal disabled:cursor-not-allowed disabled:opacity-60 [@media(max-height:600px)]:py-1 ${failedKeys.has(key) ? "bg-brutal-red/15" : ""}`}
                data-testid={`add-candidate-agent-${agent.id}`}
              >
                <CheckMarker checked={selectedKeys.has(key)} disabled={adding} />
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
          <SectionEyebrow as="div" uppercase={false} className="px-3 py-1.5 bg-white/50">
            {formatMessage({ id: "agent.channelMembers.humans" })}
          </SectionEyebrow>
          {filteredHumans.map((human) => {
            const key = candidateKey("human", human.userId);
            if (!multiSelect) {
              return (
                <button
                  key={human.userId}
                  onClick={() => { void addHuman(human.userId).catch(() => {}); }}
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
              );
            }
            return (
              <button
                key={human.userId}
                type="button"
                onClick={() => toggleCandidate(key)}
                disabled={adding}
                aria-pressed={selectedKeys.has(key)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-black transition-colors hover:bg-soft-signal disabled:cursor-not-allowed disabled:opacity-60 [@media(max-height:600px)]:py-1 ${failedKeys.has(key) ? "bg-brutal-red/15" : ""}`}
                data-testid={`add-candidate-human-${human.userId}`}
              >
                <CheckMarker checked={selectedKeys.has(key)} disabled={adding} />
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
            );
          })}
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

      {/* Create-a-new-Agent entry (task #584, design task #1139): persistent
          bottom row in the candidate list. When the search has no hit the
          typed text becomes the suggested name and the row steps up to the
          primary next action; without create permission the row stays VISIBLE
          but disabled with the reason — hiding it here would recreate the
          dead end this entry exists to remove. */}
      {multiSelect && (
        capabilities.createAgents ? (
          <button
            type="button"
            onClick={() => setShowCreateAgent(true)}
            disabled={adding}
            data-testid="add-member-create-agent-entry"
            className={`flex w-full items-center gap-2.5 border-t-2 border-black px-3 py-2.5 text-left ${
              createEntryPromoted ? "bg-soft-signal" : "bg-white hover:bg-black/5"
            }`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center border-2 border-dashed border-black bg-white">
              <Plus size={14} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-bold">
                {createEntryPromoted
                  ? formatMessage({ id: "channel.addMembers.createAgentNamed" }, { name: createAgentPrefillName })
                  : formatMessage({ id: "channel.addMembers.createAgent" })}
              </span>
              <span className="truncate text-xs text-black/50">
                {formatMessage({ id: "channel.addMembers.createAgentAutoJoin" }, { channel: `#${currentChannel?.name ?? ""}` })}
              </span>
            </span>
          </button>
        ) : (
          <div className="border-t-2 border-black px-3 py-2.5" data-testid="add-member-create-agent-entry-disabled">
            <div className="flex items-center gap-2.5 opacity-50">
              <span className="flex size-6 shrink-0 items-center justify-center border-2 border-dashed border-black bg-white">
                <Plus size={14} />
              </span>
              <span className="text-sm font-bold">{formatMessage({ id: "channel.addMembers.createAgent" })}</span>
            </div>
            <p className="mt-1.5 text-xs text-black/50">
              {formatMessage({ id: "channel.addMembers.createAgentNoPermission" })}
            </p>
          </div>
        )
      )}
    </div>
  );

  const memberListView = (
    <>
      {/* Member list — panel mode renders flat sections (no bordered,
          inner-scrolling box); modal mode keeps the framed shell. */}
      <ChannelMemberListShell framed={!isPanel}>
        {(roleError || roleChangeFailed) && (
          <Banner intent="warning" className="m-3 font-bold" data-testid="channel-member-role-error">
            {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
          </Banner>
        )}
        {membersLoading && (
          <div
            className="flex items-center justify-center gap-2 px-3 py-4 font-mono text-sm text-black/50"
            data-testid="channel-members-loading"
          >
            <Spinner
              size="sm"
              label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {/* Agents section */}
        {!membersLoading && channelAgents.length > 0 && (
          <>
            <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.agents" })}</ChannelMemberSectionHeader>
            {channelAgents.map((agent) => renderAgentRow(agent, false))}
          </>
        )}

        {/* Humans section */}
        {!membersLoading && channelHumans.length > 0 && (
          <>
            <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.humans" })}</ChannelMemberSectionHeader>
            {channelHumans.map((human) => renderHumanRow(human, false))}
          </>
        )}

        {!membersLoading && channelExternalMembers.length > 0 && (
          <>
            <ChannelMemberSectionHeader>
              {formatMessage({ id: "agent.channelMembers.slackParticipants" })}
            </ChannelMemberSectionHeader>
            {channelExternalMembers.map(renderExternalRow)}
          </>
        )}

        {!membersLoading && totalParticipants === 0 && (
          <div className="px-3 py-4 text-sm text-black/50 font-mono text-center">
            {formatMessage({ id: "agent.channelMembers.noMembers" })}
          </div>
        )}
      </ChannelMemberListShell>

      {/* Add entry — flag off keeps the legacy bottom button; flag on
          moves it to the modal header (top 「＋ 添加」). */}
      {!topbarOverflowEnabled && showAddEntry && (
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
    </>
  );

  const addView = (
    <div
      className={isPage ? "flex min-h-0 flex-1 flex-col" : undefined}
      data-testid="add-member-view"
    >
      {addError && (
        <Banner intent="warning" className="mb-3 font-bold" data-testid="add-member-error">
          {formatMessage({
            id: addError === "none"
              ? "channel.addMembers.noneAdded"
              : "agent.channelMembers.someAddFailed",
          })}
        </Banner>
      )}

      {/* D-state (task #584): created but not joined. Membership is the truth
          that clears this — however the join completes (banner retry, the
          staged「添加所选」, or a socket refresh), the banner goes away. */}
      {pendingJoinAgent && !channelAgents.some((agent) => agent.id === pendingJoinAgent.id) && (
        <Banner intent="warning" className="mb-3" data-testid="add-member-create-agent-join-failed">
          <div className="text-sm font-bold">
            {formatMessage(
              { id: "channel.addMembers.createAgentJoinFailedTitle" },
              { name: pendingJoinAgent.name, channel: `#${currentChannel?.name ?? ""}` },
            )}
          </div>
          <div className="mt-0.5 text-xs">
            {formatMessage({ id: "channel.addMembers.createAgentJoinFailedBody" })}
          </div>
          <button
            type="button"
            onClick={() => { void joinCreatedAgent(pendingJoinAgent); }}
            disabled={retryingJoin || adding}
            className="btn-brutal-sm mt-2 inline-flex items-center gap-1.5 bg-white px-2 py-1 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="add-member-create-agent-retry-join"
          >
            {formatMessage({ id: "channel.addMembers.retryJoin" })}
          </button>
        </Banner>
      )}

      {/* Selected chips — staged selection with per-chip deselect. */}
      {selectedKeys.size > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" data-testid="add-member-selected-chips">
          {[...selectedKeys].map((key) => {
            const kind = key.startsWith("agent:") ? "agent" : "human";
            const tone = failedKeys.has(key)
              ? "bg-brutal-red/25"
              : kind === "agent"
                ? "bg-brutal-cyan"
                : "bg-brutal-lavender";
            return (
              <span
                key={key}
                className={`inline-flex items-center gap-1 border-2 border-black px-1.5 py-0.5 text-xs font-bold ${tone}`}
                data-member-kind={kind}
                data-testid={`add-member-selected-chip-${key}`}
              >
                <span className="max-w-32 truncate">{candidateNameByKey.get(key) ?? key}</span>
                <button
                  type="button"
                  onClick={() => toggleCandidate(key)}
                  disabled={adding}
                  className="shrink-0"
                  aria-label={formatMessage({ id: "agent.channelMembers.deselectName" }, { name: candidateNameByKey.get(key) ?? key })}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {hasAvailable && (
        <FormField label={formatMessage({ id: "agent.channelMembers.search" })} labelStyle="plain" className="mb-3">
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

      {addCandidateRows(true, isPage)}

      {/* Confirm — staged atomic commit; N=0 disabled; a rejected batch keeps
          every selected row available for correction/retry. */}
      <div className={`mt-4 ${isPage ? "shrink-0" : ""}`}>
        <button
          type="button"
          onClick={() => void handleConfirmAdd()}
          disabled={adding || selectedKeys.size === 0}
          className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-pink px-3 py-1.5 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="add-member-confirm"
        >
          <Plus size={14} />
          {adding
            ? formatMessage({ id: "agent.channelMembers.adding" })
            : formatMessage({ id: "agent.channelMembers.confirmAdd" }, { count: selectedKeys.size })}
        </button>
      </div>
    </div>
  );

  const showInModalAddView = topbarOverflowEnabled && showAddSection && canAddChannelMembers;

  // Shared header + view body: the Modal shell (legacy) and the overflow
  // drawer panel (task #187) render identical content — only the close
  // affordance differs (panel mode: the drawer chrome owns close).
  const panelHeader = (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {showInModalAddView && (
          <button
            onClick={resetAddFlow}
            className="btn-brutal-sm bg-white p-1"
            title={formatMessage({ id: "agent.channelMembers.backToMembers" })}
            aria-label={formatMessage({ id: "agent.channelMembers.backToMembers" })}
            data-testid="add-member-back"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <h2 className="truncate text-lg font-bold">
          {showInModalAddView
            ? formatMessage({ id: "agent.channelMembers.addMember" })
            : isPanel
              // task #187: the overflow drawer pins the human/agent split
              // count (Artea: 几 humans · 几 agents) instead of one total.
              ? formatMessage({ id: "message.chatPanel.overflow.members" })
              : membersLoading
                ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
                : formatMessage({ id: "agent.channelMembers.membersCount" }, { count: totalParticipants })}
        </h2>
        {isPanel && !showInModalAddView && (
          <span className="shrink-0 font-mono text-xs font-normal text-black/55">
            {membersLoading
              ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
              : formatMessage(
                  { id: "message.chatPanel.overflow.membersSummary" },
                  { humans: channelHumans.length, agents: channelAgents.length },
                )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {topbarOverflowEnabled && !showInModalAddView && showAddEntry && (
          <button
            onClick={() => setShowAddSection(true)}
            disabled={!hasAvailable}
            className="btn-brutal-sm bg-white p-1 disabled:opacity-50 disabled:cursor-not-allowed"
            title={formatMessage({ id: "agent.channelMembers.addMember" })}
            aria-label={formatMessage({ id: "agent.channelMembers.addMember" })}
            data-testid="add-member-open"
          >
            <Plus size={16} />
          </button>
        )}
        {!isPanel && (
          <button
            onClick={closePanel}
            className="btn-brutal-sm bg-white p-1"
            aria-label={formatMessage({ id: "message.channelSettings.close" })}
          >
            <X size={20} />
          </button>
        )}
      </div>
    </div>
  );
  // final3: member list gets a bounded, borderless-scroll region in the
  // drawer panel; the add view stays unwrapped. final9 raises the bound
  // to 280px so a typical channel fits without inner scrolling.
  const panelBody = showInModalAddView
    ? addView
    : isPanel
      ? (
        <div
          className="max-h-[280px] overflow-y-auto border-y border-black/10"
          data-testid="channel-members-scroll"
        >
          {memberListView}
        </div>
      )
      : memberListView;

  /* ── Members page (page mode, task #187): the overflow drawer's
     second-level view. One full-height column — yellow header (‹ back
     to the drawer root), persistent roster search, humans-first
     sections with counts + role tags, bottom-pinned ＋ add entry; the
     staged add flow renders in place as the drawer-internal third level,
     so the whole member interaction never leaves the drawer. ── */
  const normalizedRosterQuery = rosterQuery.trim().toLowerCase();
  const visibleHumans = channelHumans.filter((human) =>
    memberMatches(normalizedRosterQuery, human.name, human.displayName));
  const visibleAgents = channelAgents.filter((agent) =>
    memberMatches(normalizedRosterQuery, agent.name, agent.displayName));
  const visibleExternalMembers = channelExternalMembers.filter((member) =>
    memberMatches(normalizedRosterQuery, member.handles.join(" "), member.displayName));

  const pageHeader = (
    <div className="flex h-panel-header shrink-0 items-center gap-2 border-b-2 border-black bg-soft-signal px-4">
      {/* In the add view the back button is the add flow's own ‹ back
          (resetAddFlow), keeping the add-member-back contract the modal
          and panel headers use; otherwise it returns to the drawer root. */}
      <Button
        type="button"
        shape="icon"
        onClick={() => (showAddSection ? resetAddFlow() : onBack?.())}
        aria-label={formatMessage({
          id: showAddSection ? "agent.channelMembers.backToMembers" : "channel.membersPage.back",
        })}
        data-testid={showAddSection ? "add-member-back" : "member-page-back"}
      >
        <ArrowLeft size={16} />
      </Button>
      <h2 className="truncate text-base font-bold">
        {showAddSection
          ? formatMessage({ id: "agent.channelMembers.addMember" })
          : formatMessage({ id: "message.chatPanel.overflow.members" })}
      </h2>
      {!showAddSection && !membersLoading && (
        <span
          className="shrink-0 rounded-full bg-black px-2 py-0.5 font-mono text-xs text-brutal-cream"
          data-testid="member-page-count"
        >
          {totalParticipants}
        </span>
      )}
      {!showAddSection && membersLoading && (
        <Spinner
          size="sm"
          label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          data-testid="member-page-count-loading"
        />
      )}
      <div className="flex-1" />
    </div>
  );

  const pageListView = (
    <>
      {(roleError || roleChangeFailed) && (
        <Banner
          intent="warning"
          className="m-3 shrink-0 font-bold"
          data-testid="channel-member-role-error"
        >
          {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
        </Banner>
      )}

      {/* Persistent search — filters both sections live. */}
      <div className="shrink-0 border-b border-black/10 px-4 py-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40" />
          <input
            type="text"
            value={rosterQuery}
            onChange={(e) => setRosterQuery(e.target.value)}
            disabled={membersLoading}
            className="input-brutal input-member-search w-full pl-9"
            placeholder={formatMessage({ id: "channel.membersPage.searchPlaceholder" })}
            data-testid="member-page-search"
          />
        </div>
      </div>

      {/* Humans first (design master member-page), then agents. Each category
          uses Raft UI's disclosure primitive, starts expanded, and keeps its
          live filtered count in the trigger. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {membersLoading && (
          <div
            className="flex min-h-32 items-center justify-center gap-2 px-3 py-4 font-mono text-sm text-black/50"
            aria-live="polite"
            data-testid="member-page-loading"
          >
            <Spinner
              size="sm"
              label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {!membersLoading && visibleHumans.length > 0 && (
          <MemberPageSection
            kind="humans"
            label={formatMessage({ id: "agent.channelMembers.humans" })}
            count={visibleHumans.length}
          >
            {visibleHumans.map((human) => renderHumanRow(human, true))}
          </MemberPageSection>
        )}

        {!membersLoading && visibleAgents.length > 0 && (
          <MemberPageSection
            kind="agents"
            label={formatMessage({ id: "agent.channelMembers.agents" })}
            count={visibleAgents.length}
          >
            {visibleAgents.map((agent) => renderAgentRow(agent, true))}
          </MemberPageSection>
        )}

        {!membersLoading && visibleExternalMembers.length > 0 && (
          <MemberPageSection
            kind="external"
            label={formatMessage({ id: "agent.channelMembers.slackParticipants" })}
            count={visibleExternalMembers.length}
          >
            {visibleExternalMembers.map(renderExternalRow)}
          </MemberPageSection>
        )}

        {!membersLoading && totalParticipants === 0 && (
          <div className="px-3 py-4 text-center font-mono text-sm text-black/50">
            {formatMessage({ id: "agent.channelMembers.noMembers" })}
          </div>
        )}
        {!membersLoading
          && totalParticipants > 0
          && visibleHumans.length === 0
          && visibleAgents.length === 0
          && visibleExternalMembers.length === 0 && (
          <div className="px-3 py-4 text-center font-mono text-sm text-black/50">
            {formatMessage({ id: "agent.channelMembers.noMatches" }, { query: rosterQuery.trim() })}
          </div>
        )}
      </div>

      {/* ＋ Add members — bottom pinned; swaps in the staged multi-select
          add flow (drawer-internal third level, no Modal). Hidden while a
          remove confirm is staged so the bottom bar never stacks. */}
      {!removeTarget && showAddEntry && (
        <div className="shrink-0 border-t-2 border-black p-3">
          <button
            type="button"
            onClick={() => setShowAddSection(true)}
            disabled={!hasAvailable}
            className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-white px-3 py-2 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="member-page-add"
          >
            <Plus size={14} />
            {formatMessage({ id: "agent.channelMembers.addMember" })}
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Member count button in header */}
      {!isPanel && !isPage && !hideTrigger && (
        <Button
          onClick={() => setShowPanel(true)}
          shape="iconText"
          className="min-w-7 gap-1 px-1.5"
          title={formatMessage({ id: "agent.channelMembers.viewParticipants" })}
        >
          <Users size={14} className="shrink-0" />
          {membersLoading ? (
            <Spinner
              size="xs"
              label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
          ) : (
            <span className="min-w-[1ch] text-center font-mono text-[11px] font-bold leading-none tabular-nums">
              {totalParticipants > 99 ? "99+" : totalParticipants}
            </span>
          )}
        </Button>
      )}

      {/* Members modal panel */}
      {!isPanel && !isPage && showPanel && (
        <Modal onClose={closePanel}>
          <div className="w-full max-w-sm card-brutal p-6">
            {panelHeader}
            {panelBody}
          </div>
        </Modal>
      )}

      {/* Drawer-embedded panel (task #187): no Modal, no close X — the
          overflow sheet chrome owns back/close. */}
      {isPanel && (
        <div className="px-4 py-2" data-testid="channel-members-panel">
          {panelHeader}
          {panelBody}
        </div>
      )}

      {/* Drawer-internal members page (task #187): full-height column
          the host overflow drawer shows as its second-level view. */}
      {isPage && (
        <>
          {/* Keep the roster page mounted under the profile page. Its live
              search query, disclosures and scroll position are the actual
              "previous page" the Back control must restore. */}
          <div
            className={`${selectedProfile ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-white`}
            data-testid="member-page"
          >
            {pageHeader}
            {showAddSection && canAddChannelMembers ? (
              <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
                {addView}
              </div>
            ) : pageListView}
          </div>
          {selectedProfile && (
            <Suspense
              fallback={(
                <div className="flex min-h-0 flex-1 items-center justify-center bg-white text-sm font-display text-black/40">
                  {formatMessage({ id: "common.loading" })}
                </div>
              )}
            >
              <ProfilePanel
                key={`${selectedProfile.type}:${selectedProfile.id}`}
                target={selectedProfile}
                presentation="embedded"
                onBack={backProfile}
                onClose={closeProfilePage}
                onOpenProfile={openNestedProfile}
              />
            </Suspense>
          )}
        </>
      )}

      {/* Add Member modal (stacked on top of Members modal) — legacy
          single-click flow, flag off only. */}
      {!isPage && !topbarOverflowEnabled && showAddSection && canAddChannelMembers && (
        <Modal onClose={() => setShowAddSection(false)} layer={1}>
          <div className="w-full max-w-sm card-brutal p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">{formatMessage({ id: "agent.channelMembers.addMember" })}</h2>
              <button
                onClick={() => { setShowAddSection(false); setMemberSearch(""); }}
                className="btn-brutal-sm bg-white p-1"
              >
                <X size={20} />
              </button>
            </div>

            {hasAvailable && (
              <FormField label={formatMessage({ id: "agent.channelMembers.search" })} labelStyle="plain" className="mb-3">
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

            {addCandidateRows(false)}
          </div>
        </Modal>
      )}

      {/* One shared dialog across modal, panel, desktop Drawer, and the
          full-screen mobile Drawer. */}
      {removeConfirmDialog}
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
      {showCreateAgent && (
        <CreateAgentDialog
          prefilledName={createEntryPromoted ? createAgentPrefillName : undefined}
          prefilledNameNote={createEntryPromoted ? [
            // "改了要说": the @-strip is the one modification we make.
            ...(memberSearch.trim().startsWith("@")
              ? [formatMessage({ id: "channel.addMembers.prefillAtStripped" })]
              : []),
            ...(/\s/.test(createAgentPrefillName)
              ? [formatMessage(
                  { id: "channel.addMembers.prefillSpacesKept" },
                  {
                    dashed: createAgentPrefillName.replace(/\s+/g, "-"),
                    joined: createAgentPrefillName.replace(/\s+/g, ""),
                  },
                )]
              : []),
          ].join(" ") || undefined : undefined}
          stayOnCreate
          autoJoinChannelName={currentChannel?.name}
          onCreated={(agent) => { void joinCreatedAgent(agent); }}
          onClose={() => setShowCreateAgent(false)}
        />
      )}
    </>
  );
}

export default function ChannelMembers(props: ChannelMembersProps) {
  const topbarOverflowEnabled = useServerFeatureFlag(
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  ).enabled;

  if (!topbarOverflowEnabled) {
    if (props.presentation && props.presentation !== "modal") return null;
    return <LegacyChannelMembers channelId={props.channelId} />;
  }

  return <GatedChannelMembers {...props} />;
}
