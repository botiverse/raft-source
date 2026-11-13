import { Badge, Button, ConversationPanelTabs, ScrollArea, SortableTabsList, SortableTabsTab, Tabs, TabsLabel, ProfilePanelBody, useOrderedTabs, Separator, PanelNotice, PanelNoticeActions, PanelNoticeContent } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useIntl } from "react-intl";
import { Archive, Bug, Pencil, Check, X, RotateCcw, Lock, Copy, SquareTerminal } from "lucide-react";
import { useLocation } from "react-router-dom";
import { SIDEBAR_TAB_QUERY_PARAM, useAppNavigate } from "../../hooks/useAppNavigate";
import { AGENT_USAGE_FEATURE_FLAG_KEY, getRuntimeDisplayName, isExternalAgentRuntime, parseRaftPermalink, isAdminOrOwner } from "@botiverse/raft-shared";
import type { ExternalAgentDiagnosticsView, ReminderSummary } from "@botiverse/raft-shared";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { classifyTypedRuntimeError, classifyRuntimeError, classifyRuntimeErrorCode, RUNTIME_ERROR_LABEL_ID, RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, runtimeLookupDisplayForReason } from "../../utils/classifyRuntimeError";
import { touchDragRegion } from "../../utils/touchDragRegion";
import { getSocket } from "../../api/socket";
import { useAgentStore, useAgentCurrentActivityState } from "../../store/agentStore";
import type { Agent, ActivityLogEntry, ExternalAgentStatus } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { isMachineOffline, useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { raftPermalinkHostnames } from "../../store/raftAppHosts";
import { useAuthStore } from "../../store/authStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { agentRuntimePermissions, canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { stopAgentTurnWithFeedback } from "../../components/agent/stopAgentTurn";
import { canStopSubagentsOf } from "../../components/agent/stopSubagent";
import { AssistantPausedChip, AssistantPausedNotice, isPersonalAssistant, useAssistantPause } from "../../assistant/AssistantPaused";
import { AssistantOwnerSection } from "../../assistant/AssistantOwnerSection";
import { showToast } from "../../components/toastBridge";
import { formatActivityText, getActivityErrorDisplayDetail } from "../../utils/activity";
import { buildAgentDiagnosticInfo } from "../../utils/agentDiagnosticInfo";
import { useCopyText } from "../../hooks/useCopyText";
import CopyButton from "../../components/ui/CopyButton";
import { isCustomAvatar } from "../../components/agent/PixelAvatar";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import { PROFILE_HANDLE_FONT_CLASS } from "../../components/ui/PanelHeader";
import { RowRegionBody } from "../../components/layout/RowRegionBody";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import AvatarSlot from "../../components/ui/AvatarSlot";
import AvatarEditVeil from "../../components/ui/AvatarEditVeil";
import AppBadge from "../../components/agent/AppBadge";
import AgentProfileEditDialog from "../../components/agent/AgentProfileEditDialog";
import type { AgentProfileEditField } from "../../components/agent/AgentProfileEditDialog";
import api from "../../api/client";
import AgentWorkspace from "../../components/agent/AgentWorkspace";
import AgentActivityLog from "../../components/agent/AgentActivityLog";
import AgentSkills from "../../components/agent/AgentSkills";
import AgentRemindersSection from "../../components/agent/AgentRemindersSection";
import AgentAppAccessTab from "../../components/agent/AgentAppAccessTab";
import AgentTabErrorBoundary from "../../components/agent/AgentTabErrorBoundary";
import ReportIssueDialog from "../../components/agent/ReportIssueDialog";
import ResetAgentDialog from "../../components/agent/ResetAgentDialog";
import ConfirmDialog from "../../components/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import { useAgentActivitySubscription } from "../../store/agentActivitySubscriptions";
import { AgentMigrationSection } from "../../components/agentMigration/AgentMigrationSection";
import { AgentArchiveDialog } from "../../components/agentArchive/AgentArchiveDialog";
import { AgentArchiveSection } from "../../components/agentArchive/AgentArchiveSection";
import { recordProfileOpenE2eEvent } from "../../utils/profileOpenE2eTimeline";
import { agentOffersLounge, useAgentLoungeEnabled, useOpenAgentLounge } from "../../components/agent/agentLounge";
import { AgentChatTab } from "./AgentChatTab";
import { PROFILE_AVATAR_BUTTON_CLASS, RUNTIME_CHIP_CLASS, INFO_ICON_BUTTON_CLASS } from "./agentDetailClassNames";
import { useEditableAgentRoleOptions } from "./useEditableAgentRoleOptions";
import { AgentHeaderName } from "./AgentHeaderName";
import { AgentProfileInfo } from "./AgentProfileInfo";
import { AppBotFromApp } from "./ManagedAppIdentity";
import type { RuntimeConfigEditorHandle } from "./AgentProfileInfo";
import { AgentRecentActivity } from "./AgentRecentActivity";
import { AgentStartStopButton } from "./AgentStartStopButton";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { AgentDetailHeader } from "./AgentDetailHeader";
import { AgentComputerOfflineCard } from "./AgentComputerOfflineCard";
import { AgentRuntimeErrorNotice } from "./AgentRuntimeErrorNotice";
import { isMachineOfflineError, startRefusalText } from "../../utils/machineOfflineError";
import { restartResetOffered } from "../../utils/agentBlockedState";
import { AGENT_PANEL_TABS, AGENT_TABS, PUBLIC_AGENT_TABS } from "./agentDetailTabs";
import { AgentUsageTab } from "./AgentUsageTab";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { AgentTab } from "./agentDetailTabs";

recordProfileOpenE2eEvent({ kind: "module-evaluated", module: "agent-detail" });
const FEEDBACK_EXPORT_ENABLED = Boolean(import.meta.env?.VITE_FEEDBACK_EXPORT_URL?.replace(/\/+$/, ""));
const EMPTY_ACTIVITY_LOG: ActivityLogEntry[] = [];

const NO_ROLE_OPTIONS: ReturnType<typeof useEditableAgentRoleOptions> = [];

export function AgentDetailPanel({ agent, onClose, onBack, onOpenProfile, activityOnly = false }: {
  agent: Agent;
  onClose?: () => void;
  onBack?: () => void;
  onOpenProfile?: (type: "agent" | "human", id: string) => void;
  /** The mobile app's embedded Activity tab (/agent/:agentId/activity): only
   *  the activity log and the runtime error notice. The app draws the agent
   *  header and the tab row itself, so ours (and the header's actions) go. */
  activityOnly?: boolean;
}) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const stopAgentTurn = useAgentStore((s) => s.stopAgentTurn);
  const openDM = useChannelStore((s) => s.openDM);
  const { role: currentRole, capabilities } = useServerPermissions();
  const nav = useAppNavigate();
  // Its live activity in detail while this panel is open (store/agentActivitySubscriptions.ts).
  useAgentActivitySubscription(agent.id);
  const activityState = useAgentCurrentActivityState(agent.id);
  const activityLog = useAgentStore((s) => s.activityLogs[agent.id] ?? EMPTY_ACTIVITY_LOG);
  const machines = useMachineStore((s) => s.machines);
  const currentServer = useServerStore((s) => s.current);
  const deprecatedHere = useRuntimeDeprecatedHere();
  const currentUser = useAuthStore((s) => s.user);
  const agentMachine = agent.machineId ? machines.find((m) => m.id === agent.machineId) : null;
  const isRemoteJointAgent = Boolean(currentServer?.id && agent.serverId && agent.serverId !== currentServer.id);
  const isBoundedPublicProjection = isRemoteJointAgent || agent.profileProjection === "channel_summary";
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);

  // Which profile field the edit dialog opened on; null = closed.
  const [editField, setEditField] = useState<AgentProfileEditField | null>(null);
  const editableRoleOptions = useEditableAgentRoleOptions(agent);
  const [startError, setStartError] = useState("");
  const computerOffline = isMachineOffline(machines, agent.machineId);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const [panelExternalStatus, setPanelExternalStatus] = useState<ExternalAgentStatus | null>(null);
  const canManageAgent = !isBoundedPublicProjection && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.editAgents,
  );
  // Archive actions (archive, delete its workspace) need deleteAgents or creator.
  const canArchiveAgent = !isBoundedPublicProjection && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.deleteAgents,
  );
  // Runtime control, Stop Agent and Full reset: the rule the Members page's menu shares (agentRuntimePermissions).
  const { canControlAgentRuntime, canStopAgent, canResetAgentWorkspace } = agentRuntimePermissions(
    agent,
    currentUser?.id,
    capabilities,
    { isExternalAgent, isBoundedPublicProjection },
  );
  // Same authority as restart. A Computer agent's turn can be stopped while it is
  // online (checked in the header); of the external agents only a hosted one
  // that is up has a turn to stop.
  const canStopTurn = !isBoundedPublicProjection && (!isExternalAgent || agent.hostedRuntime?.state === "active")
    && canViewAgentPrivateSurfaces(agent, currentUser?.id, capabilities.controlAgentRuntime);
  // Approve, deny, grant and revoke app access: the agent's creator or an owner/admin.
  const canManageAgentAccess = !isBoundedPublicProjection && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.manageExternalAuth,
  );
  const canChangeAgentRole = !isBoundedPublicProjection && capabilities.changeMemberRoles;
  // A personal assistant (#10654): only its owner may start it; a server
  // owner/admin's Stop on it is a lasting pause, so it is labelled and
  // confirmed as one.
  const assistantPause = useAssistantPause(agent.id);
  const isAssistant = isPersonalAssistant(agent) || assistantPause !== null;
  const isAssistantOwner = isAssistant && Boolean(currentUser?.id) && (agent.assistantOwnerUserId
    ? agent.assistantOwnerUserId === currentUser?.id
    : agent.creatorType === "user" && agent.creatorId === currentUser?.id);
  // Only a server owner/admin may stop (pause) someone else's assistant; the
  // server refuses anyone else with 403 assistant_owner_only (#10654).
  const isServerAdmin = isAdminOrOwner(currentRole);
  const canPauseAssistant = isAssistant && !isAssistantOwner && !isBoundedPublicProjection && !agent.deletedAt
    && assistantPause === null && isServerAdmin;
  // A member who is not the owner can't stop someone else's assistant either.
  const canStopThisTurn = canStopTurn && (!isAssistant || isAssistantOwner || isServerAdmin);
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const pauseAssistant = useAgentStore((s) => s.pauseAssistant);
  useEffect(() => {
    if (!isExternalAgent || isBoundedPublicProjection) return;
    let canceled = false;
    const load = async () => {
      try {
        const status = await fetchExternalAgentStatus(agent.id);
        if (!canceled) setPanelExternalStatus(status);
      } catch {
        if (!canceled) setPanelExternalStatus(null);
      }
    };
    void load();
    return () => { canceled = true; };
  }, [agent.id, fetchExternalAgentStatus, isBoundedPublicProjection, isExternalAgent]);

  const diagnosticCopyController = useCopyText({
    resetKey: agent.id,
    timeoutMs: 2_000,
  });
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const location = useLocation();
  const canViewPrivateAgentSurfaces = canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    canManageAgent,
  );
  // External agents: the diagnostic copy text is built from the server's
  // external-agent diagnostics (presence, status, push, pulls, provisioning).
  const fetchExternalAgentDiagnostics = useAgentStore((s) => s.fetchExternalAgentDiagnostics);
  // Keyed by agent: a switch to another agent never shows the previous one's facts.
  const [loadedExternalDiagnostics, setLoadedExternalDiagnostics] = useState<{ agentId: string; view: ExternalAgentDiagnosticsView } | null>(null);
  const externalDiagnostics = loadedExternalDiagnostics?.agentId === agent.id ? loadedExternalDiagnostics.view : null;
  useEffect(() => {
    if (!isExternalAgent || isBoundedPublicProjection || !canViewPrivateAgentSurfaces) return;
    let canceled = false;
    fetchExternalAgentDiagnostics(agent.id)
      // A body without the view's shape (e.g. an older server) counts as unavailable.
      .then((view) => { if (!canceled && view?.presence && view.status && view.push) setLoadedExternalDiagnostics({ agentId: agent.id, view }); })
      .catch(() => undefined);
    return () => { canceled = true; };
  }, [agent.id, canViewPrivateAgentSurfaces, fetchExternalAgentDiagnostics, isBoundedPublicProjection, isExternalAgent]);
  const hasRuntimeError = activityState?.activity === "error" || Boolean(agent.lastRuntimeError);
  const rawRuntimeError = hasRuntimeError
    ? (activityState?.activity === "error" ? activityState.activityDetail : agent.lastRuntimeError?.message) ?? ""
    : "";
  // #688(d): surface the authoritative typed diagnostic (errorClass/reason/
  // fingerprint) that the daemon+server persisted, when present — instead of
  // re-deriving only from message text. Falls back to the message classifier
  // for untyped/legacy error authority.
  const typedRuntimeError =
    agent.lastRuntimeError?.errorClass && agent.lastRuntimeError.errorReason
      ? agent.lastRuntimeError
      : null;
  const typedRuntimeErrorErrKind = classifyTypedRuntimeError(typedRuntimeError);
  // #wg-rbac:#57: the server sends every viewer the error's code, from the
  // same source as the text above (the error activity's, else the stored
  // error's); members get no error text, so the code is what picks the copy.
  const runtimeErrorCode = hasRuntimeError
    ? classifyRuntimeErrorCode(activityState?.activity === "error" ? activityState.errorCode : agent.lastRuntimeError?.code)
    : null;
  // Runtime-error sentinel: known stable runtime errors map to catalog copy;
  // unknown errors keep the raw text / generic fallback (never mistranslated).
  // Text patterns only for a viewer the server sends the text to, and only
  // when there is no code.
  const runtimeErrorKind = typedRuntimeErrorErrKind
    ?? (rawRuntimeError && !runtimeErrorCode && canViewPrivateAgentSurfaces ? classifyRuntimeError(rawRuntimeError) : null);
  // task #735: a "not installed" classification only keeps the install copy
  // when the start failure's typed carrier confirms the miss (lookupReason
  // "not_on_path"). A timed-out/denied/failed lookup — and an old daemon that
  // carries no reason — is unresolved, never "install it".
  const startLookupDisplay = runtimeErrorKind === "notInstalled"
    ? runtimeLookupDisplayForReason(
        activityState?.spawnFailure?.reason === "runtime_not_found"
          ? activityState.spawnFailure.lookupReason
          : undefined,
      )
    : null;
  const activityErrorText = startLookupDisplay
    ? formatMessage(
        { id: RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID[startLookupDisplay] },
        { runtimeName: getRuntimeDisplayName(agent.runtime) },
      )
    : runtimeErrorKind
    ? formatMessage({ id: RUNTIME_ERROR_LABEL_ID[runtimeErrorKind] })
    : hasRuntimeError
      ? formatActivityText(formatMessage, "error", rawRuntimeError)
      : formatMessage({ id: "activity.status.agentErrorFallback" });
  // task #1351: the billing banner's one action opens the Profile tab's runtime
  // editor, where its pencil is (the mobile activity-only page has no Profile tab).
  const canOpenModelSettings = canManageAgent && !agent.deletedAt && !isExternalAgent && !activityOnly;
  // The raw diagnostic stays available for the copy button even when the
  // banner shows the classified catalog message.
  const diagnosticErrorMessage = hasRuntimeError && canViewPrivateAgentSurfaces
    ? (typedRuntimeError
      ? [rawRuntimeError, `class=${typedRuntimeError.errorClass} reason=${typedRuntimeError.errorReason} fingerprint=${typedRuntimeError.fingerprint}`].filter(Boolean).join("\n")
      : rawRuntimeError)

    : null;

  // Reactive cleanup: close the delete-confirm dialog if the agent gets
  // deleted externally (socket/another tab) while the dialog is open. The
  // setShowDeleteConfirm(false) is a deliberate response to a prop change,
  // not a mirror-prop pattern. Lifting the dialog state up would force a
  // wider refactor with no behavior benefit.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (agent.deletedAt && showDeleteConfirm) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setShowDeleteConfirm(false);
    }
  }, [agent.deletedAt, showDeleteConfirm]);

  const agentUsagePanelEnabled = useServerFeatureFlag(AGENT_USAGE_FEATURE_FLAG_KEY).enabled;
  const visibleAgentTabs = useMemo(
    () => AGENT_TABS.filter((tab) => {
      // App-managed bots are identities, not runtimes: no activity feed,
      // reminders, workspace, integrations or MCP — those belong to the app.
      // This precedes the archived branch: an archived bot is still a bot.
      if (agent.managedByAppInstallId) return tab === "profile" || tab === "chat";
      // An archived agent keeps its profile and a read-only workspace.
      if (agent.deletedAt) return tab === "profile" || (tab === "workspace" && canViewPrivateAgentSurfaces);
      if (PUBLIC_AGENT_TABS.has(tab)) return true;
      // Usage (#proj-o11y:#36): only behind its flag, for whoever sees Activity.
      if (tab === "usage" && !agentUsagePanelEnabled) return false;
      return canViewPrivateAgentSurfaces;
    }),
    [agent.deletedAt, agent.managedByAppInstallId, agentUsagePanelEnabled, canViewPrivateAgentSurfaces],
  );
  const visibleAgentTabItems = useMemo(
    () => AGENT_PANEL_TABS.filter((tab) => visibleAgentTabs.includes(tab.id)),
    [visibleAgentTabs],
  );
  const agentPanelTabOrder = useServerStore((s) => s.sidebarOrder.agentPanelTabOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const normalizedAgentPanelTabOrder = useMemo(
    () => agentPanelTabOrder.map((tab) => tab === "channels" || tab === "dms" ? "chat" : tab),
    [agentPanelTabOrder],
  );
  const orderedAgentTabs = useOrderedTabs(visibleAgentTabItems, normalizedAgentPanelTabOrder);
  const reorderAgentTabs = useCallback((nextOrder: AgentTab[]) => {
    void updateSidebarOrder({ agentPanelTabOrder: nextOrder });
  }, [updateSidebarOrder]);
  const orderedAgentTabIds = useMemo(() => orderedAgentTabs.map((tab) => tab.id), [orderedAgentTabs]);
  const defaultAgentTab: AgentTab = visibleAgentTabs.includes("profile")
    ? "profile"
    : visibleAgentTabs[0] ?? "profile";
  const rawTab = searchParams.get("agentTab");
  const isFullPageAgentRoute = /^\/s\/[^/]+\/agent\/[^/]+$/.test(location.pathname);
  const legacyFullPageTab = isFullPageAgentRoute ? searchParams.get("tab") : null;
  const requestedTab = rawTab ?? legacyFullPageTab;
  // The retired MCP tab's links land on the Apps tab, where MCP Apps are listed now.
  const resolvedTab = requestedTab === "mcp" ? "integrations" : requestedTab;
  const activeTab: AgentTab = activityOnly
    ? "activity"
    : orderedAgentTabs.some((tab) => tab.id === resolvedTab) ? (resolvedTab as AgentTab) : defaultAgentTab;
  const setActiveTab = useCallback((tab: AgentTab) => {
    // Agent detail tabs keep their own scoped query key. We still strip the
    // legacy generic `tab` when it holds an old agent- or sidebar-tab value so
    // old shared URLs normalize onto `agentTab` + `sidebarTab`.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === defaultAgentTab) next.delete("agentTab");
      else next.set("agentTab", tab);
      if (isFullPageAgentRoute) {
        const legacyTab = next.get("tab");
        if (legacyTab === "machines") {
          next.set(SIDEBAR_TAB_QUERY_PARAM, "members");
          next.delete("tab");
        } else if (legacyTab && (AGENT_TABS.includes(legacyTab as AgentTab) || legacyTab === "mcp")) {
          next.delete("tab");
        }
      }
      return next;
    }, { replace: true });
  }, [defaultAgentTab, isFullPageAgentRoute, setSearchParams]);
  const openActivityTab = useCallback(() => setActiveTab("activity"), [setActiveTab]);
  // "View model settings" (task #1351): on the Profile tab its editor opens at
  // once; from another tab the request holds it open there until it closes.
  const runtimeConfigEditorRef = useRef<RuntimeConfigEditorHandle>(null);
  const [runtimeConfigOpenRequested, setRuntimeConfigOpenRequested] = useState(false);
  const openModelSettings = useCallback(() => {
    if (runtimeConfigEditorRef.current) {
      runtimeConfigEditorRef.current.open();
      return;
    }
    setActiveTab("profile");
    setRuntimeConfigOpenRequested(true);
  }, [setActiveTab]);
  const consumeRuntimeConfigOpenRequest = useCallback(() => setRuntimeConfigOpenRequested(false), []);
  // The profile's now card says what the agent is doing, in place of the status chip (xxchan).
  const showRecentActivity = visibleAgentTabs.includes("activity") && !agent.deletedAt;


  // Find existing DM channel for this agent (for Message button)
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const dmChannel = useMemo(
    () => dmChannels.find((c) => c.peerId === agent.id),
    [dmChannels, agent.id]
  );

  const getDiagnosticInfo = useCallback(() => buildAgentDiagnosticInfo({
    agent,
    serverId: currentServer?.id,
    machine: agentMachine,
    activityState,
    activityLog,
    errorMessage: diagnosticErrorMessage,
    externalDiagnostics,
    formatMessage,
  }), [activityLog, activityState, agent, agentMachine, currentServer?.id, diagnosticErrorMessage, externalDiagnostics, formatMessage]);
  const handleDiagnosticCopyError = useCallback(() => {
    setStartError(formatMessage({ id: "agent.detail.copyDiagnosticInfoFailed" }));
  }, [formatMessage]);

  const [reminderItems, setReminderItems] = useState<ReminderSummary[]>([]);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [remindersError, setRemindersError] = useState<string | null>(null);

  // Reminders are a PRIVATE agent surface. A peer-server agent's public profile
  // must not make this server fetch them, and a caught error is not the same as
  // a request that was never sent. The scope key also fences stale responses: an
  // in-flight load started for one (viewer server, agent) must never commit
  // after a switch. (task #21)
  const reminderScopeKey = `${currentServer?.id ?? ""}:${agent.id}`;
  const reminderScopeRef = useRef(reminderScopeKey);
  reminderScopeRef.current = reminderScopeKey;

  const loadReminders = useCallback(async () => {
    if (!canViewPrivateAgentSurfaces) {
      // Clear rather than leave a previous agent's private reminders on screen.
      setReminderItems([]);
      setRemindersError(null);
      setRemindersLoading(false);
      return;
    }
    // Capture the key ITSELF, not a ref read: that is what makes it a real
    // input to this callback (the lint was right — a dependency the body never
    // uses is not a dependency). The ref is only for the post-await comparison.
    const startedScope = reminderScopeKey;
    // Drop the previous scope's rows BEFORE awaiting. Re-issuing the request is
    // not enough: while the new scope loads, stale private rows from the old
    // server stayed on screen.
    setReminderItems([]);
    setRemindersLoading(true);
    setRemindersError(null);
    try {
      const { data } = await api.get("/reminders", {
        params: {
          ownerAgentId: agent.id,
          status: "scheduled",
        },
      });
      if (reminderScopeRef.current !== startedScope) return;
      setReminderItems((data?.reminders ?? []) as ReminderSummary[]);
    } catch (err: any) {
      if (reminderScopeRef.current !== startedScope) return;
      setRemindersError(err.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadRemindersFailed" }));
    } finally {
      if (reminderScopeRef.current === startedScope) setRemindersLoading(false);
    }
    // `reminderScopeKey` is a DEPENDENCY, not just a ref read: the viewer server
    // is part of load ownership, so switching servers must re-run this loader
    // even when the private-permission boolean happens to be unchanged.
    // Without it the ref updates but nothing reloads, and stale rows/loading
    // survive the switch. (task #21 review)
  }, [agent.id, canViewPrivateAgentSurfaces, reminderScopeKey]);

  // Async-loader: kicks `loadReminders` on mount + agent change. Same FP
  // family as PR #2530's useChannelMembers / AgentSkills async loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  // Socket listener: handles fire/snooze/cancel/update events for the active
  // agent's reminders. Three setState calls inside the event handlers are
  // reactive to server-pushed events, NOT a derived-from-prop pattern.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    // Same gate as the loader: no private socket subscriptions or reconnect
    // refetch for a peer-server agent's public profile.
    if (!canViewPrivateAgentSurfaces) return;
    const socket = getSocket();
    // Fire: one-shot reminders disappear; recurring reminders stay in the list
    // but advance to the next scheduled fire time (server sends nextFireAt).
    const handleReminderFired = (data: {
      reminderId: string;
      ownerAgentId: string;
      nextFireAt?: string | null;
    }) => {
      if (data.ownerAgentId !== agent.id) return;
      setReminderItems((current) => {
        if (!data.nextFireAt) {
          return current.filter((item) => item.reminderId !== data.reminderId);
        }
        return current.map((item) =>
          item.reminderId === data.reminderId ? { ...item, fireAt: data.nextFireAt! } : item,
        );
      });
    };
    const handleReminderScheduled = (data: { reminder: ReminderSummary }) => {
      if (data.reminder?.ownerAgentId !== agent.id) return;
      setReminderItems((current) => {
        // Ignore non-scheduled payloads defensively; only scheduled reminders
        // belong in the pending list (the API query filters status=scheduled).
        if (data.reminder.status !== "scheduled") return current;
        // Upsert: replace if we already have this id, else append + sort asc
        // by fireAt so the next-firing reminder stays on top.
        const without = current.filter((item) => item.reminderId !== data.reminder.reminderId);
        const next = [...without, data.reminder];
        next.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
        return next;
      });
    };
    const handleReminderCanceled = (data: { reminderId: string; ownerAgentId: string }) => {
      if (data.ownerAgentId !== agent.id) return;
      setReminderItems((current) => current.filter((item) => item.reminderId !== data.reminderId));
    };
    const handleReconnect = () => {
      void loadReminders();
    };

    socket.on("reminder:fired", handleReminderFired);
    socket.on("reminder:scheduled", handleReminderScheduled);
    socket.on("reminder:canceled", handleReminderCanceled);
    socket.on("connect", handleReconnect);
    return () => {
      socket.off("reminder:fired", handleReminderFired);
      socket.off("reminder:scheduled", handleReminderScheduled);
      socket.off("reminder:canceled", handleReminderCanceled);
      socket.off("connect", handleReconnect);
    };
  }, [agent.id, canViewPrivateAgentSurfaces, reminderScopeKey, loadReminders]);

  const handleOpenReminderMsgRef = useCallback(
    (permalink: string) => {
      // At the click: the page's host and the server's app hosts as they are now.
      const parsed = parseRaftPermalink(permalink, raftPermalinkHostnames());
      if (!parsed) {
        // Anchor outside the app (shouldn't happen — msgPermalink is
        // server-built against APP_URL) — fall back to a full navigation.
        window.location.href = permalink;
        return;
      }
      if (parsed.threadParentMessageId) {
        nav.toThreadMessage(
          parsed.channelId,
          parsed.threadParentMessageId,
          parsed.messageId,
          parsed.routeKind,
        );
      } else if (parsed.routeKind === "dm") {
        nav.toDmMessage(parsed.channelId, parsed.messageId);
      } else {
        nav.toMessage(parsed.channelId, parsed.messageId);
      }
    },
    [nav],
  );

  const handleRetryReminders = useCallback(async () => {
    await loadReminders();
  }, [loadReminders]);

  // A machine_offline refusal already marked the Computer offline in the machine store (agentStore.startAgent), so the
  // offline card takes Start's place (#triage:#206); any other refusal says why under the header; a Start that went
  // through clears it.
  const handleStartSettled = useCallback((err: unknown) => {
    if (err === null) setStartError("");
    else if (!isMachineOfflineError(err)) setStartError(startRefusalText(err, formatMessage));
  }, [formatMessage]);
  const handleStop = useCallback(async () => {
    setStartError("");
    try {
      await stopAgent(agent.id);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setStartError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.stopAgentFailed" }));
    }
  }, [agent.id, formatMessage, stopAgent]);

  const handleMessage = useCallback(async () => {
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    if (dmChannel) {
      nav.toDm(dmChannel.id);
    } else if (!agent.deletedAt) {
      const ch = await openDM(agent.id);
      if (ch) nav.toDm(ch.id);
    }
  }, [agent.deletedAt, agent.id, dmChannel, nav, openDM]);
  // Agent Lounge v0: the profile's Lounge entry (an agent of this server only).
  const loungeEnabled = useAgentLoungeEnabled();
  const openAgentLounge = useOpenAgentLounge();
  const handleOpenLounge = useCallback(() => {
    void openAgentLounge(agent.id);
  }, [agent.id, openAgentLounge]);
  const openResetDialog = useCallback(() => setShowResetDialog(true), []);
  const closeResetDialog = useCallback(() => setShowResetDialog(false), []);
  const openStopConfirm = useCallback(() => setShowStopConfirm(true), []);
  const stopCurrentTurn = useCallback(() => {
    void stopAgentTurnWithFeedback(() => stopAgentTurn(agent.id), formatMessage);
  }, [agent.id, formatMessage, stopAgentTurn]);
  // App-managed bots render no presence: it would sit always-offline on a signal that does not apply to them.
  const headerStatus = assistantPause
    ? <AssistantPausedChip />
    : agent.managedByAppInstallId
      ? null
      : (
        <AgentStatusBadge
          agentId={agent.id}
          fallbackStatus={agent.status}
          showDetail={canViewPrivateAgentSurfaces}
          externalStatus={isExternalAgent ? panelExternalStatus : undefined}
          onStop={canStopThisTurn ? stopCurrentTurn : undefined}
          // Retry is the menu's Restart: offered where Restart is (not while the Computer is offline).
          credentialAgent={agent} canRestart={restartResetOffered(canControlAgentRuntime, computerOffline)}
          onOpenModelSettings={canOpenModelSettings ? openModelSettings : undefined}
        />
      );
  const closeStopConfirm = useCallback(() => setShowStopConfirm(false), []);
  const openPauseConfirm = useCallback(() => setShowPauseConfirm(true), []);
  const closePauseConfirm = useCallback(() => setShowPauseConfirm(false), []);
  const currentUserId = currentUser?.id ?? null;
  const currentUserName = currentUser?.displayName || currentUser?.name || "";
  const handlePauseAssistant = useCallback(async () => {
    if (!currentUserId) return;
    // Errors stay in the dialog (ConfirmDialog shows them); a pause that took
    // says so, anything else reads like a Stop Current Turn.
    const { outcome, paused } = await pauseAssistant(agent.id, { id: currentUserId, name: currentUserName });
    if (paused) {
      showToast({ title: formatMessage({ id: "assistant.pause.paused" }), type: "success" });
    } else {
      await stopAgentTurnWithFeedback(async () => outcome, formatMessage);
    }
  }, [agent.id, currentUserId, currentUserName, formatMessage, pauseAssistant]);
  const openReportDialog = useCallback(() => setShowReportDialog(true), []);
  const closeReportDialog = useCallback(() => setShowReportDialog(false), []);
  const openDeleteConfirm = useCallback(() => setShowDeleteConfirm(true), []);
  const closeDeleteConfirm = useCallback(() => setShowDeleteConfirm(false), []);
  const editAvatar = useCallback(() => setEditField("avatar"), []);
  const editDisplayName = useCallback(() => setEditField("displayName"), []);
  const closeEditField = useCallback(() => setEditField(null), []);
  const agentAvatarUrl = agent.avatarUrl;
  const agentTitle = agent.managedByAppInstallId
    ? (agent.managedByApp ? agent.managedByApp.name : (agent.displayName || agent.name))
    : (agent.displayName || agent.name);
  const viewAvatar = useCallback(() => {
    useImageLightboxStore.getState().openImage(agentAvatarUrl!, agentTitle);
  }, [agentAvatarUrl, agentTitle]);

  // Only the creator and admins see an agent's activity (and app bots and
  // archived agents have none); the full panel just hides the tab, so the
  // activity-only page says so instead of showing an empty list.
  if (activityOnly && !visibleAgentTabs.includes("activity")) {
    return (
      <ProfilePanelBody className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-sans">
        <EmptyState
          className="flex flex-1 flex-col justify-center"
          icon={<Lock size={36} />}
          title={formatMessage({
            id: agent.managedByAppInstallId || agent.deletedAt
              ? "agent.detail.activityNone"
              : "agent.detail.activityUnavailable",
          })}
          data-testid="agent-activity-unavailable"
        />
      </ProfilePanelBody>
    );
  }

  return (
    <ProfilePanelBody className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-sans">
      {/* Header — isolated component to prevent activity changes from re-rendering ChatPanel */}
      {!activityOnly && <AgentDetailHeader
        agent={agent}
        canControlAgentRuntime={canControlAgentRuntime}
        canStopAgent={canStopAgent}
        canMessageAgent={!isBoundedPublicProjection}
        onClose={onClose}
        onBack={onBack}
        onMessage={handleMessage}
        onOpenLounge={loungeEnabled && !isBoundedPublicProjection && agentOffersLounge(agent) ? handleOpenLounge : undefined}
        onShowResetDialog={openResetDialog}
        onShowStopConfirm={openStopConfirm}
        onPauseAssistant={canPauseAssistant ? openPauseConfirm : undefined}
        onStartSettled={handleStartSettled}
        computerOffline={computerOffline}
      />}
      {/* Under the head: hidden while a region expanded in its column shows the profile as its head alone (#189 rule 5). */}
      <RowRegionBody>
      {/* Start error: a raft-ui PanelNotice, the strip under the head closed
          by the same seam the head draws above it. */}
      {startError && (
        <PanelNotice>
          <Tooltip content={startError}><PanelNoticeContent render={<span />} className="truncate">{startError}</PanelNoticeContent></Tooltip>
          <PanelNoticeActions>
            <button
              onClick={() => setStartError("")}
              className={INFO_ICON_BUTTON_CLASS}
            >
              <X size={16} />
            </button>
          </PanelNoticeActions>
        </PanelNotice>
      )}

      {/* Agent runtime error banner (the billing one too, task #1351): it
          follows the stored error state, with no dismissal of its own. */}
      {hasRuntimeError && (
        <AgentRuntimeErrorNotice
          errorText={activityErrorText}
          canViewDetails={canViewPrivateAgentSurfaces}
          runtimeErrorKind={runtimeErrorKind}
          runtimeErrorCode={runtimeErrorCode}
          errorDetail={canViewPrivateAgentSurfaces ? getActivityErrorDisplayDetail(rawRuntimeError) : ""}
          agentTitle={agentTitle}
          getDiagnosticInfo={getDiagnosticInfo}
          onOpenModelSettings={canOpenModelSettings ? openModelSettings : undefined}
          showAskAdmin={!activityOnly}
          onViewLogs={activeTab !== "activity" ? openActivityTab : undefined}
        />
      )}

      {/* Tab bar — the same raft-ui chrome as the chat panel tabs. raft-ui's
          tab row scrolls itself when the tabs do not fit (wheel too), fades
          at the hidden side and keeps the selected tab in view. */}
      {!activityOnly && <div ref={touchDragRegion} className="min-w-0 max-w-full">
        <ConversationPanelTabs
          render={<Tabs<AgentTab> value={activeTab} onValueChange={setActiveTab} />}
        >
          <SortableTabsList<AgentTab>
            value={orderedAgentTabIds}
            onReorder={reorderAgentTabs}
          >
            {orderedAgentTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <SortableTabsTab
                  key={tab.id}
                  value={tab.id}
                  data-testid={`panel-tab-${tab.id}`}
                >
                  <Icon />
                  <TabsLabel>{formatMessage({ id: tab.labelId })}</TabsLabel>
                </SortableTabsTab>
              );
            })}
          </SortableTabsList>
        </ConversationPanelTabs>
      </div>}

      {/* Tab content — fills remaining space. One tab with bad data shows a
          retry in place of its content instead of blanking the whole panel. */}
      <AgentTabErrorBoundary resetKey={`${agent.id}:${activeTab}`}>
      {activeTab === "profile" ? (
        <ScrollArea className="flex-1 bg-layer-canvas">
          {isRemoteJointAgent && (agent.serverName || agent.serverSlug) && (
              <>
              <div className="px-(--surface-inset) py-3">
              <SectionEyebrow as="div" className="mb-1">
                {formatMessage({ id: "agent.detail.from" })}
              </SectionEyebrow>
                <div className="text-subhead font-semibold text-foreground">{agent.serverName || agent.serverSlug}</div>
            </div>
              <Separator />
              </>
          )}
          {/* Profile hero — the DS ScreenAgent hero: the big square pixel sticker
              (the panel's one piece of brand art, hard sticker shadow from the
              AvatarSlot recipe), then name, @handle, the agent tag + runtime chip,
              and the presence chip. */}
          <div className="flex items-start gap-4 px-(--surface-inset) py-5">
            {agent.managedByAppInstallId || isAssistant ? (
              // A managed bot's avatar IS the owning app's logo (Slack: bot
              // avatar follows the app icon, changeable only via app config).
              // A personal assistant is always Ottie (fixed name and avatar).
              // Neither is editable here.
              <AvatarSlot context="profile-hero" type="agent" agentAvatarUrl={agent.avatarUrl} />
            ) : canManageAgent ? (
              <Tooltip content={formatMessage({ id: "agent.detail.changeAvatar" })}>
              <button
                type="button"
                aria-label={formatMessage({ id: "agent.detail.changeAvatar" })}
                data-testid="agent-change-avatar"
                onClick={editAvatar}
                className={PROFILE_AVATAR_BUTTON_CLASS}
              >
                <AvatarSlot context="profile-hero" type="agent" agentAvatarUrl={agent.avatarUrl} />
                <AvatarEditVeil icon={Pencil} />
              </button>
              </Tooltip>
            ) : isCustomAvatar(agent.avatarUrl) && !agent.deletedAt ? (
              <Tooltip content={formatMessage({ id: "agent.detail.viewAvatar" })}>
              <button
                type="button"
                onClick={viewAvatar}
                className={PROFILE_AVATAR_BUTTON_CLASS}
                aria-label={formatMessage({ id: "agent.detail.viewAvatar" })}
              >
                <AvatarSlot context="profile-hero" type="agent" agentAvatarUrl={agent.avatarUrl} />
              </button>
              </Tooltip>
            ) : (
              <AvatarSlot
                context="profile-hero"
                type="agent"
                agentAvatarUrl={agent.avatarUrl}
                className={agent.deletedAt ? "grayscale opacity-dimmed" : undefined}
              />
            )}
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex min-w-0 items-center gap-2">
                <AgentHeaderName
                  agent={agent}
                  onEdit={canManageAgent && !agent.deletedAt && !agent.managedByAppInstallId && !isAssistant ? editDisplayName : undefined}
                />
              </div>
              {/* The hover title duplicates the visible handle but is load-bearing
                  for the i18n literal gate: scripts/i18n-literal-baseline.json audits
                  this exact template literal (protocol class), so removing the
                  attribute would force a three-baseline ratchet. Kept deliberately. */}
              <div className={`truncate text-mono-meta ${PROFILE_HANDLE_FONT_CLASS} text-foreground-hint`} title={`@${agent.name}`}>@{agent.name}</div>
              {/* Identity tags: what it is (agent) and, where operational info is
                  visible, what it runs on (the DS runtime chip). */}
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                {agent.managedByAppInstallId ? (
                  <>
                    {/* An App bot is labelled App, not "Agent": the
                        badge (the name above is the App's live name) and which
                        App it comes from. The Managed by app row below stays. */}
                    <AppBadge appName={agent.managedByApp?.name} botName={agent.managedByApp?.name} />
                    <AppBotFromApp agent={agent} />
                  </>
                ) : (
                  <Badge appearance="outline">{formatMessage({ id: "sidebar.findConversationAgentTag" })}</Badge>
                )}
                {!isBoundedPublicProjection && agent.runtime && !agent.managedByAppInstallId && (
                  <Badge appearance="soft" variant="information" className={RUNTIME_CHIP_CLASS} data-testid="agent-profile-runtime-chip">
                    <SquareTerminal size={14} aria-hidden="true" />
                    {formatRuntimeLabelWithStatus(agent.runtime, formatMessage, deprecatedHere(agent.runtime))}
                  </Badge>
                )}
              </div>
              {/* Live activity has its own line under the handle, so it never squeezes the name. App-managed bots render no presence: it would sit always-offline on a signal that does not apply to them. */}
              {/* With the now card, the status is its first line (xxchan). */}
              {!agent.deletedAt && !showRecentActivity && headerStatus && <div className="mt-1.5 min-w-0">{headerStatus}</div>}
            </div>
          </div>
          {!agent.deletedAt && assistantPause && (
            <div className="px-(--surface-inset) pb-4">
              <AssistantPausedNotice agentId={agent.id} isOwner={isAssistantOwner} />
            </div>
          )}
          {!agent.deletedAt && !isExternalAgent && !isBoundedPublicProjection && (
            <div className="px-5 pb-4 empty:hidden"><AgentComputerOfflineCard agentId={agent.id} /></div>
          )}


          {editField && (
            <AgentProfileEditDialog
              agent={agent}
              open
              field={editField}
              onClose={closeEditField}
              roleOptions={canChangeAgentRole && !agent.deletedAt ? editableRoleOptions : NO_ROLE_OPTIONS}
            />
          )}

          {showRecentActivity && <AgentRecentActivity agentId={agent.id} onOpenActivity={openActivityTab} status={headerStatus} />}
          <AgentProfileInfo
            agent={agent}
            onEdit={canManageAgent && !agent.deletedAt ? setEditField : undefined}
            canManageAgent={canManageAgent && !agent.deletedAt}
            canChangeAgentRole={canChangeAgentRole && !agent.deletedAt}
            canRestartAgent={canControlAgentRuntime && !agent.deletedAt}
            onOpenProfile={onOpenProfile}
            showOperationalInfo={!isBoundedPublicProjection}
            runtimeConfigEditorRef={runtimeConfigEditorRef}
            openRuntimeConfigRequested={runtimeConfigOpenRequested}
            onRuntimeConfigOpenRequestHandled={consumeRuntimeConfigOpenRequest}
          />

          {/* The owner's assistant settings, where its header's gear lands (#proj-assistant:#21). */}
          {isAssistantOwner && !agent.deletedAt && <AssistantOwnerSection agentId={agent.id} />}

          {/* Skills are runtime capabilities; a managed bot has none of its own. */}
          {canViewPrivateAgentSurfaces && !agent.deletedAt && !agent.managedByAppInstallId && (
            <>
              <Separator />
              <AgentSkills agentId={agent.id} embedded />
            </>
          )}

          {/* A cloud agent keeps the section only to show the end of its move to the cloud. */}
          {canManageAgent && !agent.deletedAt && (!isExternalAgent || agent.hostedRuntime) && (
            <AgentMigrationSection agent={agent} arrivalOnly={isExternalAgent} />
          )}

          {agent.deletedAt && canViewPrivateAgentSurfaces && (
            <AgentArchiveSection agent={agent} canManage={canArchiveAgent} />
          )}

          {/* Actions: runtime operations (diagnostics copy, issue report,
              archive) belong to agents with a runtime; a managed bot's
              lifecycle is the grant revoke on the owning app. */}
          {canManageAgent && !agent.deletedAt && !agent.managedByAppInstallId && (
            <>
            <Separator />
            <div className="px-(--surface-inset) py-4">
              <SectionEyebrow as="div" className="mb-3">
                {formatMessage({ id: "agent.detail.actions" })}
              </SectionEyebrow>
              <div className="stack-y-2">
                {!isExternalAgent && (
                  <>
                    <AgentStartStopButton agentId={agent.id} canStopAgent={canStopAgent} onShowStopConfirm={openStopConfirm} computerOffline={computerOffline} onStartSettled={handleStartSettled} />
                    {restartResetOffered(true, computerOffline) && (
                    <Button variant="outline" size="lg"
                      onClick={openResetDialog}
                      className="flex w-full items-center justify-center gap-2"
                    >
                      <RotateCcw size={14} />
                      {formatMessage({ id: "agent.detail.restartReset" })}
                    </Button>
                    )}
                  </>
                )}
                <CopyButton
                  controller={diagnosticCopyController}
                  text={getDiagnosticInfo}
                  onCopyError={handleDiagnosticCopyError}
                >
                  {({ copied, disabled, onClick, onMouseDown }) => (
                    <Button variant="outline" size="lg"
                      onClick={onClick}
                      onMouseDown={onMouseDown}
                      disabled={disabled}
                      className="flex w-full items-center justify-center gap-2"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied
                        ? formatMessage({ id: "agent.detail.diagnosticInfoCopied" })
                        : formatMessage({ id: "agent.detail.copyDiagnosticInfo" })}
                    </Button>
                  )}
                </CopyButton>
                {FEEDBACK_EXPORT_ENABLED && (
                  <Button variant="outline" size="lg"
                    onClick={openReportDialog}
                    className="flex w-full items-center justify-center gap-2"
                  >
                    <Bug size={14} />
                    {formatMessage({ id: "agent.reportIssue.title" })}
                  </Button>
                )}
                {canArchiveAgent && (
                  <Button variant="danger" size="lg"
                    onClick={openDeleteConfirm}
                    className="flex w-full items-center justify-center gap-2"
                    data-testid="agent-archive-button"
                  >
                    <Archive size={14} />
                    {formatMessage({ id: "agent.detail.deleteAgent" })}
                  </Button>
                )}
              </div>
            </div>
            </>
          )}
        </ScrollArea>
      ) : activeTab === "chat" ? (
        <AgentChatTab key={agent.id} agentId={agent.id} />
      ) : activeTab === "reminders" ? (
        <AgentRemindersSection
          variant="tab"
          reminders={reminderItems}
          loading={remindersLoading}
          error={remindersError}
          onRetry={handleRetryReminders}
          onOpenMsgRef={handleOpenReminderMsgRef}
        />
      ) : activeTab === "workspace" ? (
        <AgentWorkspace agentId={agent.id} compact={!!onClose} hosted={isExternalAgent} />
      ) : activeTab === "activity" ? (
        <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas" data-testid="agent-activity-tab">
          <AgentActivityLog key={agent.id} agentId={agent.id} machineId={agent.machineId} canStopSubagents={canStopSubagentsOf(agent, canControlAgentRuntime)} />
        </div>
      ) : activeTab === "usage" ? (
        <AgentUsageTab key={agent.id} agentId={agent.id} />
      ) : activeTab === "integrations" ? (
        <AgentAppAccessTab agentId={agent.id} canManageAgentAccess={canManageAgentAccess} />
      ) : null}
      </AgentTabErrorBoundary>
      </RowRegionBody>
      {canControlAgentRuntime && showResetDialog && (
        <ResetAgentDialog
          agentId={agent.id}
          agentName={agent.displayName || agent.name}
          canFullReset={canResetAgentWorkspace}
          memberRuntimeOnly={currentRole === "member"}
          onClose={closeResetDialog}
        />
      )}

      {canManageAgent && showReportDialog && (
        <ReportIssueDialog
          agent={agent}
          dmChannelId={dmChannel?.id}
          onClose={closeReportDialog}
        />
      )}

      {canStopAgent && showStopConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.stopAgent" })}
          message={formatMessage(
            { id: "agent.detail.stopAgentConfirmMessage" },
            { name: agent.displayName || agent.name },
          )}
          confirmLabel={formatMessage({ id: "agent.detail.stopAgentConfirm" })}
          loadingLabel={formatMessage({ id: "agent.detail.stopping" })}
          confirmVariant="warning"
          chromeLocale="active"
          onConfirm={handleStop}
          onClose={closeStopConfirm}
        />
      )}

      {canPauseAssistant && showPauseConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "assistant.pause.confirmTitle" }, { name: agent.displayName || agent.name })}
          message={formatMessage({ id: "assistant.pause.confirmBody" })}
          confirmLabel={formatMessage({ id: "assistant.pause.confirm" })}
          loadingLabel={formatMessage({ id: "assistant.pause.pausing" })}
          confirmVariant="warning"
          confirmTestId="assistant-pause-confirm"
          chromeLocale="active"
          onConfirm={handlePauseAssistant}
          onClose={closePauseConfirm}
        />
      )}

      {canArchiveAgent && showDeleteConfirm && (
        <AgentArchiveDialog agent={agent} onClose={closeDeleteConfirm} />
      )}
    </ProfilePanelBody>
  );
}
