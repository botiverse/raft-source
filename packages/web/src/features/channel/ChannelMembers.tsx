import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, InputGroup, ScrollArea, InputGroupAddon, InputGroupInput, PanelAction, PanelHeader, Spinner } from "@botiverse/raft-ui";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, Bot, Users, Plus, Plug, Mail, UserPlus, X, Search, AlertTriangle } from "lucide-react";
import { isAgentInMemberLists, useAgentStore } from "../../store/agentStore";
import { useStoredChannel } from "../../store/useStoredChannel";
import { useServerStore } from "../../store/serverStore";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import AvatarSlot from "../../components/ui/AvatarSlot";
import Banner from "../../components/ui/Banner";
import EmptyState from "../../components/ui/EmptyState";
import { trackAgentCreateOpened } from "../../analytics/journey";
import { CreateAgentDialog } from "../../components/agent/DeferredCreateAgentDialog";
import AgentActivityDot from "../../components/agent/AgentActivityDot";
import AppBadge from "../../components/agent/AppBadge";
import { ChannelMemberListShell, ChannelMemberRoleAndActions, ChannelMemberRow, ChannelMemberSectionHeader } from "../../components/channel/ChannelMemberList";
import { useChannelMemberRemoval } from "../../components/channel/useChannelMemberRemoval";
import ConfirmDialog from "../../components/ConfirmDialog";
import Tooltip from "../../components/ui/Tooltip";
import type { ProfilePanelProps, ProfilePanelTarget } from "../../components/profile/ProfilePanel";
import { primeHumanProfileFromChannelMember, setCachedAgentProfile } from "../../components/profile/profileFallbackCache";
import { isLocalProjectionMember, memberServerBadgeLabels } from "../../utils/channelLocalMembership";
import type { ServerBadgeMember } from "../../utils/channelLocalMembership";
import { useSidePanelEscapeStep } from "../../components/task/sidePanelEscape";
import { MemberChoiceList, memberChoiceKey, useMemberChoiceSearch } from "../../components/channel/MemberChoiceList";
import type { MemberChoice } from "../../components/channel/MemberChoiceList";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import { MemberRoleActions } from "../../components/agent/MemberRoleActions";
import { ICON_SM_END_PULL, ICON_SM_START_PULL } from "../../components/ui/headEdges";
import AgentActivitySubscription from "../../components/agent/AgentActivitySubscription";
import { AgentActivityInfo, agentStatusFallbackActivity, JointServerBadges } from "../../components/agent/channelMemberParts";
import AddExternalMemberDialog from "../../components/channel/AddExternalMemberDialog";
import ExternalInviteRows from "../../components/channel/ExternalInviteRows";
import { useChannelExternalInvites, useExternalInviteAccess, useExternalInviteManagement } from "../../components/channel/externalInvites";
import { useAddExternalMemberEntry } from "../../components/channel/externalChannelSlot";
import { MemberPageSection } from "./MemberPageSection";
import { handleLabel, memberMatches } from "./channelMemberText";
import { groupsByViewerServer, jointMemberOrigin, rosterRoleTag, splitByViewerServer } from "./jointMemberGroups";
import { MemberRowName } from "./MemberRowName";
import { AvatarOriginCorner } from "../../components/member/MemberLabelParts";
import { ViewerServerGroupPage, ViewerServerGroupPanel } from "./ViewerServerGroups";
import { OpenAgentSetup } from "./OpenAgentSetup";
import { lazyPanel } from "../../boot/deferredUi";

const ProfilePanel = lazyPanel<ProfilePanelProps>(() => import("../../components/profile/ProfilePanel"));

type ChannelMembersProps = {
  channelId: string;
  /** Required: every caller names the host it renders in (the overflow
   *  drawer panel or its members page); there is no standalone shell. */
  presentation: "panel" | "page";
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

export function ChannelMembers({
  channelId,
  presentation,
  onRequestClose,
  onBack,
  onClose,
  initialView,
  prefetchedMembers,
}: ChannelMembersProps) {
  const { formatMessage } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const currentChannel = useStoredChannel(channelId) ?? null;
  const currentServerId = useServerStore((s) => s.current?.id);
  const currentServerName = useServerStore((s) => s.current?.name ?? "");
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
    removeAgent,
    removeHuman,
    changeMemberRole,
    roleChangeFailed,
  } = prefetchedMembers ?? localMembers;
  const openProfile = useProfileStore((s) => s.openProfile);
  const isPage = presentation === "page";
  // External invites (#wg-rbac:#16): host owners and admins, flag on, an
  // ordinary channel. Everyone else sees neither the entries nor the Invited group.
  const externalInviteAccess = useExternalInviteAccess(currentChannel);
  // The Invited group and Withdraw also stay while the flag is off and the
  // channel is still external (no new invites or resends then).
  const externalInviteManagement = useExternalInviteManagement(currentChannel);
  const {
    invites: externalInvites,
    failed: externalInvitesFailed,
    reload: reloadExternalInvites,
  } = useChannelExternalInvites(channelId, externalInviteManagement);
  // Invite People Outside's two entries; in a second channel at the Free plan's one external channel, the upgrade dialog.
  const { showAddExternal, openAddExternalFromRow, openAddExternalFromPage, closeAddExternal } = useAddExternalMemberEntry(currentChannel, externalInviteAccess);
  const [showAddSection, setShowAddSection] = useState(initialView === "add");
  // The add picker lists agents from the roster store. Ask for it when the
  // picker opens instead of relying on boot timing: the connect snapshot (or its
  // bounded fallback) may not have landed yet, and an empty roster would offer to
  // create an agent that already exists. loadAgents dedupes in-flight calls.
  // (A picker opened directly via initialView="add" is covered by its opener.)
  const loadAgents = useAgentStore((s) => s.loadAgents);
  const openAddSection = useCallback(() => {
    setShowAddSection(true);
    void loadAgents();
  }, [loadAgents]);
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
  // task #187 multi-select add flow: selection is staged and
  // only committed on confirm; failed rows stay selected + highlighted so
  // the confirm button doubles as retry.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [failedKeys, setFailedKeys] = useState<Set<string>>(() => new Set());
  const [addError, setAddError] = useState<"none" | "some" | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateExternalAgent, setShowCreateExternalAgent] = useState(false);
  // Two-step contract (task #584): the create succeeded but the channel join
  // did not. The agent EXISTS on the server at this point — the banner + retry
  // exist so nobody "fixes" the failure by creating a same-named duplicate.
  // setupAfterJoin: an external agent does nothing until set up, so once its
  // join lands it opens /agent/:id (the setup guide), like the sidebar flow.
  const [pendingJoinAgent, setPendingJoinAgent] = useState<{ id: string; name: string; setupAfterJoin?: boolean } | null>(null);
  const [retryingJoin, setRetryingJoin] = useState(false);
  const [roleChangingKey, setRoleChangingKey] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [protectedDemoteTarget, setProtectedDemoteTarget] = useState<string | null>(null);

  const isAllChannel = currentChannel?.name === "all" && currentChannel?.type === "channel";
  const isArchived = !!currentChannel?.archivedAt;
  const isLocalMember = (serverId?: string) =>
    !currentChannel?.serverId || !serverId || serverId === currentChannel.serverId;
  // Joint rosters badge every server a non-local member participates through
  // (RFC 075 phase 1): a person on both sides shows both servers.
  const jointServerLabels = (member: ServerBadgeMember) =>
    currentChannel?.type === "joint"
      ? memberServerBadgeLabels(member, currentChannel.serverId)
      : [];
  const groupByViewerServer = groupsByViewerServer(currentChannel?.type, channelHumans, channelAgents);
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

  // Agents not in the channel, then people not in it: the shared people
  // search's fields, and each row's avatar and lines (MemberChoiceList).
  const addFailedLabel = formatMessage({ id: "agent.channelMembers.addFailed" });
  const memberCandidates = useMemo(() => {
    const channelAgentIds = new Set(channelAgents.map((agent) => agent.id));
    const channelHumanIds = new Set(channelHumans
      .filter((h) => isLocalProjectionMember(h, currentChannel))
      .map((h) => h.id));
    const choices: MemberChoice<unknown>[] = [
      ...agents.filter((agent) => isAgentInMemberLists(agent) && !channelAgentIds.has(agent.id)).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        media: (
          <AvatarSlot
            context="compact-list"
            type="agent"
            agentAvatarUrl={agent.avatarUrl}
            badge={agent.managedByAppInstallId ? undefined : <AgentActivityDot agentId={agent.id} />}
          />
        ),
        badge: agent.managedByAppInstallId
          ? <AppBadge className="shrink-0" appName={agent.managedByApp?.name} botName={agent.displayName || agent.name} />
          : undefined,
      })),
      ...serverMembers.filter((member) => !channelHumanIds.has(member.userId)).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
        media: (
          <AvatarSlot
            context="compact-list"
            type="human"
            humanAvatarUrl={member.avatarUrl}
          />
        ),
      })),
    ];
    return choices;
  }, [agents, channelAgents, channelHumans, currentChannel, serverMembers]);
  // The search runs over the candidates; the rows add their lines, so a failed
  // add doesn't send every entry to the ranking worker again.
  const candidateMatches = useMemberChoiceSearch(memberSearch, memberCandidates);
  const memberChoices = useMemo(() => memberCandidates.map((choice) => {
    const key = memberChoiceKey(choice.kind, choice.id);
    return {
      ...choice,
      lines: [
        choice.description?.trim() || null,
        // The last confirm failed for this row: say so under its name, in
        // the warning colour its chip uses too.
        failedKeys.has(key) ? <span key="failed" className="text-warning-strong">{addFailedLabel}</span> : null,
      ],
    };
  }), [addFailedLabel, failedKeys, memberCandidates]);
  const hasAvailable = memberCandidates.length > 0;
  const hasFilteredResults = candidateMatches === undefined || candidateMatches.length > 0;

  const candidateNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(memberChoiceKey("agent", agent.id), agent.displayName || agent.name);
    }
    for (const member of serverMembers) {
      map.set(memberChoiceKey("human", member.userId), member.displayName || member.name);
    }
    return map;
  }, [agents, serverMembers]);

  const resetAddFlow = useCallback(() => {
    setShowAddSection(false);
    setMemberSearch("");
    setSelectedKeys(new Set());
    setFailedKeys(new Set());
    setAddError(null);
    setAdding(false);
  }, []);
  const closePanel = useCallback(() => {
    resetAddFlow();
    setRoleError(null);
    onRequestClose?.();
  }, [resetAddFlow, onRequestClose]);


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

  // The list's checkboxes: a row whose choice changed is no longer "failed"
  // (the warning follows the last confirm, not later corrections), as a
  // chip's deselect does.
  const handleCandidatesChange = useCallback((keys: string[]) => {
    const next = new Set(keys);
    const touched = [...selectedKeys, ...next].filter((key) => selectedKeys.has(key) !== next.has(key));
    setSelectedKeys(next);
    setFailedKeys((failed) => {
      if (!touched.some((key) => failed.has(key))) return failed;
      const remaining = new Set(failed);
      for (const key of touched) remaining.delete(key);
      return remaining;
    });
    setAddError(null);
  }, [selectedKeys]);
  const selectedKeyList = useMemo(() => [...selectedKeys], [selectedKeys]);

  const handleConfirmAdd = useCallback(async () => {
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
  }, [adding, selectedKeys, addMembers, resetAddFlow, pendingJoinAgent]);

  const showAddEntry = !membersLoading && canAddChannelMembers;

  const renderMemberActions = (
    targetType: "user" | "agent",
    member: ChannelHuman | ChannelAgent,
    removeAction?: () => void,
  ) => (
    <MemberRoleActions
      targetType={targetType}
      member={member}
      removeAction={removeAction}
      isArchived={isArchived}
      isAllChannel={isAllChannel}
      roleCapabilitiesEnabled={currentChannel?.channelCapabilities?.changeChannelMemberRoles === true}
      currentUserId={currentUserId}
      roleChangingKey={roleChangingKey}
      changeMemberRole={changeMemberRole}
      formatMessage={formatMessage}
      onProtectedDemote={setProtectedDemoteTarget}
      onRoleError={setRoleError}
      onRoleChanging={setRoleChangingKey}
    />
  );

  /* Per-member row renderers, single-sourced between the panel
     member list and the members page (page mode): the page makes the
     whole row the profile button and adds the server-role tag in the
     trailing slot; the panel keeps the avatar-click affordance. */
  const renderAgentRow = (agent: ChannelAgent, pageMode: boolean) => {
    const canRemoveAgent = agent.canRemoveFromChannel ?? (canRemoveChannelMembers && isLocalMember(agent.serverId));
    const serverLabels = jointServerLabels(agent);
    const origin = jointMemberOrigin(agent, currentChannel);
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
      !isAllChannel && !isArchived && canRemoveAgent
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
        name={<MemberRowName name={agent.displayName || agent.name} origin={origin} localTags={<JointServerBadges labels={serverLabels} />} />}
        avatarCorner={<AvatarOriginCorner origin={origin} />}
        secondary={<AgentActivityInfo agentId={agent.id} fallbackStatus={agent.status} />}
        onAvatarClick={!canOpenAgentProfiles || pageMode ? undefined : openAgentProfile}
        onRowClick={canOpenAgentProfiles && pageMode ? openAgentProfile : undefined}
        trailing={<ChannelMemberRoleAndActions role={role} actions={actions} />}
      />
    );
  };

  const renderHumanRow = (human: ChannelHuman, pageMode: boolean) => {
    const canRemoveHuman = human.canRemoveFromChannel ?? (canRemoveChannelMembers && isLocalMember(human.serverId));
    const serverLabels = jointServerLabels(human);
    const origin = jointMemberOrigin(human, currentChannel);
    const openHumanProfile = () => {
      if (currentChannel?.serverId) {
        primeHumanProfileFromChannelMember(currentChannel.serverId, currentChannel.id, human);
      }
      if (isPage) {
        setProfileStack([{ type: "human", id: human.id }]);
        return;
      }
      closePanel();
      openProfile("human", human.id, { channelId: currentChannel?.id ?? null });
    };
    const role = rosterRoleTag(human, currentChannel);
    const actions = renderMemberActions(
      "user",
      human,
      !isAllChannel && !isArchived && canRemoveHuman
        ? () => requestRemove({ type: "human", id: human.id, name: human.displayName || human.name })
        : undefined,
    );
    return (
      <ChannelMemberRow
        key={human.id}
        type="human"
        humanAvatarUrl={human.avatarUrl}
        name={<MemberRowName name={human.displayName || human.name} origin={origin} localTags={<JointServerBadges labels={serverLabels} sourceOf={groupByViewerServer ? human.displayName || human.name : undefined} />} />}
        avatarCorner={<AvatarOriginCorner origin={origin} />}
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
          <Badge appearance="outline" className="shrink-0">
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </Badge>
        </span>
      )}
      secondary={member.handles[0]
        ? <span className="font-mono text-mono-meta">{handleLabel(member.handles[0])}</span>
        : undefined}
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
  const [setupAgentId, setSetupAgentId] = useState<string | null>(null);
  const joinCreatedAgent = useCallback(async (agent: { id: string; name: string; setupAfterJoin?: boolean }) => {
    setRetryingJoin(true);
    try {
      // Same atomic batch facade as「添加所选」(handleConfirmAdd) — ONE
      // underlying call and ONE error contract for every way a created agent
      // reaches this channel (review finding on PR #7372: addAgent's single
      // POST was a second code path with its own failure semantics).
      await addMembers({ userIds: [], agentIds: [agent.id] });
      setPendingJoinAgent(null);
      setSelectedKeys((prev) => {
        const key = memberChoiceKey("agent", agent.id);
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setMemberSearch("");
      // Only after the join succeeded: a failure keeps the user on its warning.
      if (agent.setupAfterJoin) setSetupAgentId(agent.id);
    } catch {
      setPendingJoinAgent(agent);
      // Stage the created agent in the ordinary flow too: the banner's retry
      // and「添加所选」both resolve through the same useChannelMembers add
      // path, so either affordance completes the join — no second mechanism.
      setSelectedKeys((prev) => new Set(prev).add(memberChoiceKey("agent", agent.id)));
    } finally {
      setRetryingJoin(false);
    }
  }, [addMembers]);

  const handleRetryJoin = useCallback(() => {
    if (pendingJoinAgent) void joinCreatedAgent(pendingJoinAgent);
  }, [joinCreatedAgent, pendingJoinAgent]);


  const handleConfirmAddClick = useCallback(() => {
    void handleConfirmAdd();
  }, [handleConfirmAdd]);

  const handleBackOrReset = useCallback(() => {
    if (showAddSection) resetAddFlow();
    else onBack?.();
  }, [showAddSection, resetAddFlow, onBack]);
  // In the channel details, Escape goes back a page (a profile, the add flow, the list) before they close (panel.md).
  const escapeBack = selectedProfile ? backProfile : handleBackOrReset;
  useSidePanelEscapeStep(isPage && (!!selectedProfile || showAddSection || !!onBack), () => (escapeBack(), true));

  const handleRosterQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRosterQuery(e.target.value);
  }, []);

  const handleClearProtectedDemote = useCallback(() => {
    setProtectedDemoteTarget(null);
  }, []);

  const handleCreatedAgent = useCallback((agent: { id: string; name: string }) => {
    void joinCreatedAgent(agent);
  }, [joinCreatedAgent]);

  const handleCreatedExternalAgent = useCallback((agent: { id: string; name: string }) => {
    void joinCreatedAgent({ ...agent, setupAfterJoin: true });
  }, [joinCreatedAgent]);

  const handleOpenCreateAgent = useCallback(() => {
    trackAgentCreateOpened("channel_members");
    setShowCreateAgent(true);
  }, []);

  const memberGroupLabels = useMemo(() => ({
    agent: formatMessage({ id: "agent.channelMembers.agents" }),
    human: formatMessage({ id: "agent.channelMembers.humans" }),
  }), [formatMessage]);

  const handleCloseCreateAgent = useCallback(() => {
    setShowCreateAgent(false);
  }, []);

  // The sidebar Agents "+" menu's second item, in the same order (artin,
  // #wg-mobile:8697bb4a). Same create-then-join path as the hosted item.
  const handleOpenCreateExternalAgent = useCallback(() => {
    trackAgentCreateOpened("channel_members");
    setShowCreateExternalAgent(true);
  }, []);

  const handleCloseCreateExternalAgent = useCallback(() => {
    setShowCreateExternalAgent(false);
  }, []);

  // design v5.0 A1: under Create Agent, the same row style, for host owners
  // and admins only. Opens Invite People Outside <server>.
  const addExternalMemberRow = externalInviteAccess ? (
    <button
      type="button"
      onClick={openAddExternalFromRow}
      disabled={adding}
      data-testid="add-member-external-entry"
      className="flex w-full items-center gap-2.5 rounded-chip px-2.5 py-2 text-left text-foreground transition-colors enabled:hover:overlay-subtle disabled:cursor-not-allowed disabled:text-foreground-disabled"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-sticker border-[1.5px] border-dashed border-foreground-hint text-foreground-hint">
        <Mail size={14} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-callout font-semibold">
          {formatMessage({ id: "channel.externalInvite.title" }, { server: currentServerName })}
        </span>
        <span className="truncate text-caption text-foreground-hint">
          {formatMessage({ id: "channel.externalInvite.entry.description" }, { server: currentServerName })}
        </span>
      </span>
    </button>
  ) : null;

  // The way to an agent that isn't in the list (task #584, design task
  // #1139), as the list's footer: pinned under the scrolling candidates (task
  // #99), not their last row. When the search has no hit the typed text
  // becomes the suggested name and the row steps up to the next action.
  // ONE row opens a menu with the Members page agent "+" menu's items, in its
  // order and with its icons (task #proj-raft-ui:#176): hosted, then external.
  // Both items share one gate (createAgents); a computer or the plan limit is
  // the dialog's own business, which offers the way forward. So without the
  // permission the whole row stays VISIBLE but disabled with the reason, since
  // hiding it would recreate the dead end it removes.
  const createAgentAutoJoinLine = formatMessage(
    { id: "channel.addMembers.createAgentAutoJoin" },
    { channel: `#${currentChannel?.name ?? ""}` },
  );
  const createAgentFooter = capabilities.createAgents ? (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={adding}
        data-testid="add-member-create-agent-entry"
        render={(
          <button
            type="button"
            className={`flex w-full items-center gap-2.5 rounded-chip px-2.5 py-2 text-left text-foreground transition-colors disabled:cursor-not-allowed disabled:text-foreground-disabled ${
              createEntryPromoted ? "bg-brand-soft enabled:hover:overlay-subtle" : "enabled:hover:overlay-subtle"
            }`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-sticker border-[1.5px] border-dashed border-foreground-hint text-foreground-hint">
              <Plus size={14} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-callout font-semibold">
                {createEntryPromoted
                  ? formatMessage({ id: "channel.addMembers.createAgentNamed" }, { name: createAgentPrefillName })
                  : formatMessage({ id: "channel.addMembers.createAgent" })}
              </span>
              <span className="truncate text-caption text-foreground-hint">{createAgentAutoJoinLine}</span>
            </span>
          </button>
        )}
      />
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={4}
        aria-label={formatMessage({ id: "channel.addMembers.createAgent" })}
        data-testid="add-member-create-agent-menu"
      >
        <DropdownMenuItem onClick={handleOpenCreateAgent} data-testid="add-member-create-agent-menu-hosted">
          <Bot aria-hidden="true" />
          {formatMessage({ id: "layout.sidebar.createAgent" })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOpenCreateExternalAgent} data-testid="add-member-create-agent-menu-external">
          <Plug aria-hidden="true" />
          {formatMessage({ id: "layout.sidebar.createExternalAgent" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {addExternalMemberRow}
    </>
  ) : (
    <div className="px-2.5 py-2" data-testid="add-member-create-agent-entry-disabled">
      <div className="flex items-center gap-2.5 text-foreground-disabled">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sticker border-[1.5px] border-dashed border-foreground-disabled">
          <Plus size={14} aria-hidden="true" />
        </span>
        <span className="text-callout font-semibold">{formatMessage({ id: "channel.addMembers.createAgent" })}</span>
      </div>
      <p className="mt-1.5 text-caption text-foreground-hint">
        {formatMessage({ id: "channel.addMembers.createAgentNoPermission" })}
      </p>
      {addExternalMemberRow && <div className="-mx-2.5 mt-1.5">{addExternalMemberRow}</div>}
    </div>
  );

  // The candidates: raft-ui's ChoiceList through MemberChoiceList (search at
  // any count, Agents and People headings, the create entry as its footer).
  // On the members page it takes the height left above Confirm (artin task
  // #1060); elsewhere it scrolls past 18rem.
  const addCandidateRows = (fillAvailableHeight = false) => (
    <div
      className={fillAvailableHeight ? "flex min-h-0 flex-1 flex-col" : undefined}
      data-testid="add-member-candidate-list"
    >
      <MemberChoiceList
        choices={memberChoices}
        value={selectedKeyList}
        onValueChange={handleCandidatesChange}
        query={memberSearch}
        onQueryChange={setMemberSearch}
        matchedValues={candidateMatches}
        ariaLabel={formatMessage({ id: "agent.channelMembers.addMember" })}
        groupLabels={memberGroupLabels}
        searchLabel={formatMessage({ id: "agent.channelMembers.search" })}
        searchPlaceholder={formatMessage({ id: "agent.channelMembers.namePlaceholder" })}
        clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
        noMatchLabel={formatMessage({ id: "agent.channelMembers.noMatches" }, { query: memberSearch.trim() })}
        empty={formatMessage({ id: "agent.channelMembers.allMembersAdded" })}
        footer={createAgentFooter}
        fill={fillAvailableHeight}
        disabled={adding}
      />
    </div>
  );

  // design v5.0 A4: open invites first, above Humans; only for the people
  // who can manage them (useExternalInviteManagement).
  const externalInvitesFailedBanner = externalInviteManagement && externalInvitesFailed && externalInvites.length === 0 && (
    <div className="p-3">
      <Banner
        intent="warning"
        data-testid="external-invites-load-failed"
        actions={(
          <Button size="md" variant="outline" type="button" onClick={reloadExternalInvites}>
            {formatMessage({ id: "channel.externalInvite.retry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "channel.externalInvite.loadFailed" })}
      </Banner>
    </div>
  );

  const memberListView = (
    <>
      {/* Member list — panel mode renders flat sections (no bordered,
          inner-scrolling box); the drawer panel owns the scroll region. */}
      <ChannelMemberListShell framed={false}>
        {(roleError || roleChangeFailed) && (
          <div className="p-3">
            <Banner intent="warning" data-testid="channel-member-role-error">
              {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
            </Banner>
          </div>
        )}
        {membersLoading && (
          <div
            className="flex items-center justify-center gap-2 px-3 py-4 text-callout text-foreground-hint"
            data-testid="channel-members-loading"
          >
            <Spinner
              size="sm"
              aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {externalInvitesFailedBanner}
        {!membersLoading && externalInvites.length > 0 && (
          <div data-testid="channel-members-invited">
            <ChannelMemberSectionHeader>{formatMessage({ id: "channel.externalInvite.invited" })}</ChannelMemberSectionHeader>
            <ExternalInviteRows channelId={channelId} canResend={externalInviteAccess} invites={externalInvites} />
          </div>
        )}

        {!membersLoading && groupByViewerServer && channelAgents.length > 0 && <AgentActivitySubscription agentIdKey={channelAgents.map((agent) => agent.id).join(",")} />}
        {!membersLoading && groupByViewerServer && splitByViewerServer(channelHumans, channelAgents).map((group) => (
          <ViewerServerGroupPanel key={String(group.inViewerServer)} inViewerServer={group.inViewerServer} serverName={currentServerName} count={0}>
            {group.humans.map((human) => renderHumanRow(human, false))}{group.agents.map((agent) => renderAgentRow(agent, false))}
          </ViewerServerGroupPanel>))}

        {/* Agents section */}
        {!membersLoading && !groupByViewerServer && channelAgents.length > 0 && (
          <>
            <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.agents" })}</ChannelMemberSectionHeader>
            <AgentActivitySubscription agentIdKey={channelAgents.map((agent) => agent.id).join(",")} />
            {channelAgents.map((agent) => renderAgentRow(agent, false))}
          </>
        )}

        {/* Humans section */}
        {!membersLoading && !groupByViewerServer && channelHumans.length > 0 && (
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
          <div className="px-3 py-4 text-center text-callout text-foreground-hint">
            {formatMessage({ id: "agent.channelMembers.noMembers" })}
          </div>
        )}
      </ChannelMemberListShell>

    </>
  );

  const addView = (
    <div
      className={isPage ? "flex min-h-0 flex-1 flex-col" : undefined}
      data-testid="add-member-view"
    >
      {addError && (
        <Banner intent="warning" className="mb-3" data-testid="add-member-error">
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
        <Banner
          intent="warning"
          className="mb-3"
          data-testid="add-member-create-agent-join-failed"
          title={formatMessage(
            { id: "channel.addMembers.createAgentJoinFailedTitle" },
            { name: pendingJoinAgent.name, channel: `#${currentChannel?.name ?? ""}` },
          )}
          actions={(
            <Button size="md" variant="outline"
              type="button"
              onClick={handleRetryJoin}
              disabled={retryingJoin || adding}
              data-testid="add-member-create-agent-retry-join"
            >
              {formatMessage({ id: "channel.addMembers.retryJoin" })}
            </Button>
          )}
        >
          {formatMessage({ id: "channel.addMembers.createAgentJoinFailedBody" })}
        </Banner>
      )}

      {/* Selected chips — staged selection with per-chip deselect. */}
      {selectedKeys.size > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" data-testid="add-member-selected-chips">
          {[...selectedKeys].map((key) => {
            const kind = key.startsWith("agent:") ? "agent" : "human";
            const failedNow = failedKeys.has(key);
            const memberName = candidateNameByKey.get(key) ?? key;
            return (
              <Badge
                key={key}
                appearance="soft"
                variant={failedNow ? "warning" : "default"}
                className="pr-0.5"
                data-member-kind={kind}
                data-member-status={failedNow ? "failed" : "selected"}
                data-testid={`add-member-selected-chip-${key}`}
              >
                <span className="max-w-32 truncate">{memberName}</span>
                {failedNow ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5" data-member-failure="true">
                    <AlertTriangle size={12} aria-hidden="true" />
                    <span>{formatMessage({ id: "agent.channelMembers.addFailed" })}</span>
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleCandidate(key)}
                  disabled={adding}
                  className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-sticker text-foreground-hint transition-colors hover:bg-fill-medium hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground-disabled disabled:hover:bg-transparent"
                  aria-label={formatMessage({ id: "agent.channelMembers.deselectName" }, { name: memberName })}
                >
                  <X size={14} />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {addCandidateRows(isPage)}

      {/* Confirm — staged atomic commit; N=0 disabled; a rejected batch keeps
          every selected row available for correction/retry. */}
      <div className={`mt-4 ${isPage ? "shrink-0" : ""}`}>
        <Button size="lg"
          type="button"
          onClick={handleConfirmAddClick}
          disabled={adding || selectedKeys.size === 0}
          variant="primary"
          className="w-full"
          data-testid="add-member-confirm"
        >
          <UserPlus size={14} />
          {adding
            ? formatMessage({ id: "agent.channelMembers.adding" })
            : formatMessage({ id: "agent.channelMembers.confirmAdd" }, { count: selectedKeys.size })}
        </Button>
      </div>
    </div>
  );

  const showInPanelAddView = showAddSection && canAddChannelMembers;

  // Header + view body for the overflow drawer panel (task #187); the
  // drawer chrome owns close.
  const panelHeader = (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {showInPanelAddView && (
          <Tooltip content={formatMessage({ id: "agent.channelMembers.backToMembers" })}>
            <Button size="icon-md" variant="ghost"
              className={ICON_SM_START_PULL}
              onClick={resetAddFlow}
              aria-label={formatMessage({ id: "agent.channelMembers.backToMembers" })}
              data-testid="add-member-back"
            >
              <ArrowLeft size={16} />
            </Button>
          </Tooltip>
        )}
        <h2 className="truncate text-headline">
          {showInPanelAddView
            ? formatMessage({ id: "agent.channelMembers.addMember" })
            // task #187: the overflow drawer pins the human/agent split
            // count (Artea: 几 humans · 几 agents) instead of one total.
            : formatMessage({ id: "message.chatPanel.overflow.members" })}
        </h2>
        {!showInPanelAddView && (
          <span className="shrink-0 text-caption text-foreground-hint">
            {membersLoading
              ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
              : formatMessage(
                  { id: "message.chatPanel.overflow.membersSummary" },
                  { humans: channelHumans.length, agents: channelAgents.length },
                )}
          </span>
        )}
      </div>
      {/* The last 32px icon button's icon box ends on the 20px margin. */}
      <div className={`flex shrink-0 items-center gap-1.5 ${ICON_SM_END_PULL}`}>
        {!showInPanelAddView && showAddEntry && (
          <Tooltip content={formatMessage({ id: "agent.channelMembers.addMember" })}>
            <Button size="icon-md" variant="ghost"
              onClick={openAddSection}
              disabled={!hasAvailable}
              aria-label={formatMessage({ id: "agent.channelMembers.addMember" })}
              data-testid="add-member-open"
            >
              <UserPlus size={16} />
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
  // final3: member list gets a bounded, borderless-scroll region in the
  // drawer panel; the add view stays unwrapped. final9 raises the bound
  // to 280px so a typical channel fits without inner scrolling.
  const panelBody = showInPanelAddView
    ? addView
    : (
      // A raft-ui ScrollArea. Its rows hold buttons, so it is no tab stop; it sits in
      // the drawer's own scroll, so a scroll at its end carries on there.
      <ScrollArea
        tabIndex={-1}
        overscroll="auto"
        className="max-h-[280px] border-y border-line-hairline"
        data-testid="channel-members-scroll"
      >
        {memberListView}
      </ScrollArea>
    );

  /* ── Members page (page mode, task #187): the overflow drawer's
     second-level view. One full-height column — paper panel header (‹ back
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
  const visibleExternalInvites = useMemo(() => externalInvites.filter((invite) =>
    memberMatches(normalizedRosterQuery, invite.email, null)), [externalInvites, normalizedRosterQuery]);

  // raft-ui PanelHeader owns the edges: Back's icon box starts on the content
  // margin, as on every other head (headEdges.ts).
  const pageHeader = (
    <PanelHeader>
      {/* In the add view the back button is the add flow's own ‹ back
          (resetAddFlow), keeping the add-member-back contract the
          panel header uses; otherwise it returns to the drawer root. */}
      <PanelAction
        onClick={handleBackOrReset}
        aria-label={formatMessage({
          id: showAddSection ? "agent.channelMembers.backToMembers" : "channel.membersPage.back",
        })}
        data-testid={showAddSection ? "add-member-back" : "member-page-back"}
      >
        <ArrowLeft />
      </PanelAction>
      <h2 className="truncate text-headline">
        {showAddSection
          ? formatMessage({ id: "agent.channelMembers.addMember" })
          : formatMessage({ id: "message.chatPanel.overflow.members" })}
      </h2>
      {!showAddSection && !membersLoading && (
        <Badge
          appearance="outline"
          className="shrink-0"
          data-testid="member-page-count"
        >
          {totalParticipants}
        </Badge>
      )}
      {!showAddSection && membersLoading && (
        <Spinner
          size="sm"
          aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          data-testid="member-page-count-loading"
        />
      )}
      <div className="flex-1" />
    </PanelHeader>
  );

  const pageListView = (
    <>
      {(roleError || roleChangeFailed) && (
        <div className="shrink-0 p-3">
          <Banner
            intent="warning"
            data-testid="channel-member-role-error"
          >
            {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
          </Banner>
        </div>
      )}

      {/* Persistent search — filters both sections live. */}
      <div className="shrink-0 border-b border-line-hairline px-4 py-3">
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={rosterQuery}
            onChange={handleRosterQueryChange}
            disabled={membersLoading}
            placeholder={formatMessage({ id: "channel.membersPage.searchPlaceholder" })}
            data-escape-clears=""
            data-testid="member-page-search"
          />
        </InputGroup>
      </div>

      {/* Humans first (design master member-page), then agents. Each category
          uses Raft UI's disclosure primitive, starts expanded, and keeps its
          live filtered count in the trigger.

          The RUI sidebar section header bleeds by `--sidebar-row-inset-x`
          (6px each side) to escape its sidebar gutter; this page has no such
          gutter, so that bleed grew the header to calc(100% + 12px) and made
          the column scroll sideways. Zeroing the inset drops the negative
          margins, and w-full! replaces the 100%+12px width with one that fits
          the container - the chevron, label and count keep their exact
          positions, and the scrollbar disappears at its cause, not hidden.

          TEMPORARY (Artea, 2026-09-17): this page borrows RUI's sidebar
          section family for its groups, and that reuse is what leaks sidebar
          geometry into member rows. Two removals are tracked:
          - rui #284 derives the bleed width from the same variable instead of
            the hard-coded 12px; once the pinned raft-ui carries it, drop
            w-full! and keep only the inset declaration;
          - a generic rui Collapsible (commissioned in #proj-rui) will replace
            this SidebarSection reuse entirely, at which point both the inset
            declaration and this bridge are removed. */}
      <ScrollArea className="min-h-0 flex-1 [--sidebar-row-inset-x:0px]">
        {membersLoading && (
          <div
            className="flex min-h-32 items-center justify-center gap-2 px-3 py-4 text-callout text-foreground-hint"
            aria-live="polite"
            data-testid="member-page-loading"
          >
            <Spinner
              size="sm"
              aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {externalInvitesFailedBanner}
        {!membersLoading && visibleExternalInvites.length > 0 && (
          <MemberPageSection
            kind="invited"
            label={formatMessage({ id: "channel.externalInvite.invited" })}
            count={visibleExternalInvites.length}
          >
            <ExternalInviteRows channelId={channelId} canResend={externalInviteAccess} invites={visibleExternalInvites} />
          </MemberPageSection>
        )}

        {!membersLoading && groupByViewerServer && splitByViewerServer(visibleHumans, visibleAgents).map((group) => (
          <ViewerServerGroupPage key={String(group.inViewerServer)} inViewerServer={group.inViewerServer} serverName={currentServerName} count={group.humans.length + group.agents.length}>
            {group.humans.map((human) => renderHumanRow(human, true))}{group.agents.map((agent) => renderAgentRow(agent, true))}
          </ViewerServerGroupPage>))}

        {!membersLoading && !groupByViewerServer && visibleHumans.length > 0 && (
          <MemberPageSection
            kind="humans"
            label={formatMessage({ id: "agent.channelMembers.humans" })}
            count={visibleHumans.length}
          >
            {visibleHumans.map((human) => renderHumanRow(human, true))}
          </MemberPageSection>
        )}

        {!membersLoading && !groupByViewerServer && visibleAgents.length > 0 && (
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
          <EmptyState
            icon={<Users size={36} aria-hidden="true" />}
            title={formatMessage({ id: "agent.channelMembers.noMembers" })}
          />
        )}
        {!membersLoading
          && totalParticipants > 0
          && visibleHumans.length === 0
          && visibleAgents.length === 0
          && visibleExternalMembers.length === 0
          && visibleExternalInvites.length === 0 && (
          <EmptyState
            icon={<Search size={36} aria-hidden="true" />}
            title={formatMessage({ id: "agent.channelMembers.noMatches" }, { query: rosterQuery.trim() })}
          />
        )}
      </ScrollArea>

      {/* ＋ Add members — bottom pinned; swaps in the staged multi-select
          add flow (drawer-internal third level, no Modal). Hidden while a
          remove confirm is staged so the bottom bar never stacks. */}
      {!removeTarget && (showAddEntry || (!membersLoading && externalInviteAccess)) && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line-seam p-3">
          {showAddEntry && (
            <Button
              size="lg"
              variant="outline"
              type="button"
              onClick={openAddSection}
              disabled={!hasAvailable}
              className="w-full"
              data-testid="member-page-add"
            >
              <UserPlus size={14} />
              {formatMessage({ id: "agent.channelMembers.addMember" })}
            </Button>
          )}
          {/* design v5.0 A1: "Invite People Outside Acme" stays under Add
              Member and opens the same dialog as the Add Member row. */}
          {externalInviteAccess && (
            <Button
              size="lg"
              variant="outline"
              type="button"
              onClick={openAddExternalFromPage}
              className="w-full"
              data-testid="member-page-invite-outside"
            >
              <Mail size={14} aria-hidden="true" />
              {formatMessage({ id: "channel.externalInvite.title" }, { server: currentServerName })}
            </Button>
          )}
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Drawer-embedded panel (task #187): no Modal, no close X — the
          overflow sheet chrome owns back/close. */}
      {!isPage && (
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
            className={`${selectedProfile ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-layer-canvas text-foreground`}
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
                <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-canvas text-callout text-foreground-hint">
                  {formatMessage({ id: "common.loading" })}
                </div>
              )}
            >
              <ProfilePanel
                key={`${selectedProfile.type}:${selectedProfile.id}`}
                target={selectedProfile}
                channelId={currentChannel?.id ?? null}
                presentation="embedded"
                onBack={backProfile}
                onClose={closeProfilePage}
                onOpenProfile={openNestedProfile}
              />
            </Suspense>
          )}
        </>
      )}

      {/* One shared dialog across panel, desktop Drawer, and the
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
          confirmVariant="outline"
          hideCancel
          closeOnConfirm={false}
          onConfirm={handleClearProtectedDemote}
          onClose={handleClearProtectedDemote}
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
          onCreated={handleCreatedAgent}
          onClose={handleCloseCreateAgent}
        />
      )}
      {setupAgentId && <OpenAgentSetup key={setupAgentId} agentId={setupAgentId} />}
      {showAddExternal && externalInviteAccess && currentChannel && (currentChannel.type === "channel" || currentChannel.type === "private" || currentChannel.type === "joint") && (
        <AddExternalMemberDialog
          channelId={channelId}
          channelType={currentChannel.type}
          serverName={currentServerName} inviteEntry={showAddExternal}
          onClose={closeAddExternal}
          layer={1}
        />
      )}
      {showCreateExternalAgent && (
        // stayOnCreate: the dialog must not jump to /agent/:id before the
        // join runs; handleCreatedExternalAgent opens it once the join lands.
        <CreateAgentDialog
          external
          stayOnCreate
          autoJoinChannelName={currentChannel?.name}
          onCreated={handleCreatedExternalAgent}
          onClose={handleCloseCreateExternalAgent}
        />
      )}
    </>
  );
}
