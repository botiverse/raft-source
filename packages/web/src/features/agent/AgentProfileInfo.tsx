import { Badge, Button, Card, Separator, DescriptionList } from "@botiverse/raft-ui";
import type { ButtonProps } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import EditProviderConnectionModal from "../../components/settings/EditProviderConnectionModal";
import { useState, useEffect, useRef, useMemo, useCallback, useImperativeHandle } from "react";
import type { ReactNode, Ref } from "react";
import { useIntl } from "react-intl";
import { Pencil, HelpCircle, MoveRight } from "lucide-react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { getRuntimeDisplayName, getRuntimeInfo, getModelLabel, isExternalAgentRuntime, runtimeAvailabilitySuffix, runtimeConfigModelValue, REASONING_EFFORT_RUNTIMES } from "@botiverse/raft-shared";
import type { ProviderConnectionSummary, ServerRole } from "@botiverse/raft-shared";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelBesideBadge, formatRuntimeLabelWithStatus, runtimeShowsExperimentalBadge } from "../../utils/runtimeAvailabilityLabel";
import { reasoningEffortLabelId } from "../../utils/reasoningEffortOptions";
import { RuntimeAccountUsageGateChip } from "../../components/machine/RuntimeAccountUsageChip";
import { AgentRuntimeUsageRow } from "./AgentRuntimeUsageRow";
import { projectRuntimeModelLabelPresentation, useRuntimeModels } from "../../hooks/useRuntimeModels";
import { useExistingAgentRuntimeOptions as useExistingAgentRuntimeSelectionOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { RUNTIME_FORM_V2_UNAVAILABLE, useRuntimeFormV2 } from "../../hooks/useRuntimeFormV2";
import type { RuntimeFormV2State } from "../../hooks/useRuntimeFormV2";
import { applyRuntimeFormV2Change, initialRuntimeFormV2Values, runtimeFormV2Submission, validateRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import { useAgentStore, useAgentDisplayState } from "../../store/agentStore";
import type { Agent, ExternalAgentStatus, OnboardingIdentityAdoptionPreview } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { resolveAgentMachineRow } from "../../utils/agentMachineRow";
import { resolveAgentServerRoleDisplay } from "../../utils/agentServerRoleDisplay";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { hydrateRuntimeConfigForm, runtimeConfigApiUrl, runtimeConfigCommand, runtimeConfigFastMode, supportsRuntimeFastMode } from "../../utils/runtimeConfigForm";
import { useAssistantPause } from "../../assistant/AssistantPaused";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import StatusDot from "../../components/ui/StatusDot";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import AvatarSlot from "../../components/ui/AvatarSlot";
import type { AgentProfileEditField } from "../../components/agent/AgentProfileEditDialog";
import RolePermissionHelpDialog from "../../components/member/RolePermissionHelpDialog";
import type { MessageId } from "../../i18n/messages/en";
import ConfirmDialog from "../../components/ConfirmDialog";
import Banner from "../../components/ui/Banner";
import RuntimeConfigFields from "../../components/agent/RuntimeConfigFields";
import { useRuntimeShowAllAction } from "../../components/agent/useRuntimeShowAllAction";
import { groupRuntimePickerRows } from "../../components/agent/runtimePickerOptions";
import type { RuntimePickerRow } from "../../components/agent/runtimePickerOptions";
import RuntimeSignInNotice from "../../components/machine/RuntimeSignInNotice";
import { useArchivedAgentMachineName } from "../../components/agentArchive/useArchivedAgentMachineName";
import { describeHostedRuntime, HostedRuntimeStatus } from "../../components/agent/HostedRuntimeStatus";
import { AgentConnections } from "../../components/agent/AgentConnections";
import { AgentHostedRuntimeUsage } from "../../components/agent/AgentHostedRuntimeUsage";
import { AgentHostedRuntimeModel } from "../../components/agent/AgentHostedRuntimeModel";
import { DialogCardFooter, DialogCommit } from "../../components/ui/NarrowDialog";
import { EnvVarsSection } from "./EnvVarsSection";
import { ExternalAgentConnectionCard } from "./ExternalAgentConnectionCard";
import { InfoRow } from "./InfoRow";
import { ManagedByAppValue } from "./ManagedAppIdentity";
import { AgentModelLimitsWarning } from "./AgentModelLimitsWarning";
import { RUNTIME_CHIP_CLASS, INFO_ICON_BUTTON_CLASS } from "./agentDetailClassNames";
import { useEditableAgentRoleOptions } from "./useEditableAgentRoleOptions";
import { RuntimeConfigEditorFrame } from "./RuntimeConfigEditorFrame";
import { announceRuntimeConfigApply } from "./runtimeConfigApplyNotice";

const HOSTED_RUNTIME_POLL_MS = 5_000;
const RUNTIME_FORM_V2_LOADING: RuntimeFormV2State = { status: "loading" };
// Private surfaces — workspace, activity, DMs, reminders, and integrations —
// are visible to creator OR admin. The legacy Permissions tab is intentionally
// no longer exposed from Agent detail; old saved tab orders are ignored because
// they no longer match AGENT_TABS.
const AGENT_ROLE_CONFIG: Record<Extract<ServerRole, "admin" | "member">, { labelId: MessageId }> = {
  admin: { labelId: "agent.detail.roleAdmin" },
  member: { labelId: "agent.detail.roleMember" },
};

type PendingConfirm = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  loadingLabel: string;
  confirmVariant: ButtonProps["variant"];
  plainMessage?: boolean;
  maxWidthClass?: string;
  onConfirm: () => Promise<void>;
};

/** What the panel may ask of the Profile tab (task #1351). */
export type RuntimeConfigEditorHandle = { open: () => void };
/**
 * `canRestartAgent`: may restart it (the menu's Restart); offers Restart now after a runtime config save.
 * task #1351, the billing banner's "View model settings" (the pencil's editor): on this tab the panel calls
 * `runtimeConfigEditorRef`; from another it lands here with `openRuntimeConfigRequested`, which holds the editor
 * open until it closes (`onRuntimeConfigOpenRequestHandled`).
 */
export function AgentProfileInfo({ agent, canManageAgent, canChangeAgentRole, canRestartAgent = false, onOpenProfile, onEdit, showOperationalInfo = true, runtimeConfigEditorRef, openRuntimeConfigRequested = false, onRuntimeConfigOpenRequestHandled }: {
  agent: Agent; canManageAgent: boolean; canChangeAgentRole: boolean; canRestartAgent?: boolean; onOpenProfile?: (type: "agent" | "human", id: string) => void; onEdit?: (field: AgentProfileEditField) => void; showOperationalInfo?: boolean;
  runtimeConfigEditorRef?: Ref<RuntimeConfigEditorHandle>; openRuntimeConfigRequested?: boolean; onRuntimeConfigOpenRequestHandled?: () => void;
}) {
  const archivedMachineName = useArchivedAgentMachineName(agent.deletedAt ? agent.id : null);
  const { formatDate, formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const retryHostedRuntimeProvisioning = useAgentStore((s) => s.retryHostedRuntimeProvisioning);
  const fetchOnboardingIdentityAdoption = useAgentStore((s) => s.fetchOnboardingIdentityAdoption);
  const adoptOnboardingIdentity = useAgentStore((s) => s.adoptOnboardingIdentity);
  const currentServer = useServerStore((s) => s.current);
  const deprecatedHere = useRuntimeDeprecatedHere();
  const displayState = useAgentDisplayState(agent.id, agent);
  const machines = useMachineStore((s) => s.machines);
  const nav = useAppNavigate();
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);
  const { capabilities } = useServerPermissions();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  // task #259: while the store has no snapshot yet the Computer row is not rendered, so it
  // cannot flash "No computer assigned" before flipping to the machine (decision 甲, both ends).
  const agentMachineRow = resolveAgentMachineRow(agent.machineId, machines, machineLoadStatus);
  const agentMachine = agentMachineRow.kind === "machine" ? agentMachineRow.machine : null;
  const machineStatus = agentMachine ? agentMachine.status : agent.machineId ? "offline" : null;
  const agentMachineVersion = agentMachine?.status === "online"
    ? (agentMachine.isComputer ? agentMachine.computerVersion : agentMachine.daemonVersion) ?? null
    : null;
  const configRef = useRef<HTMLDivElement>(null);
  const runtimeConfigModalRef = useRef<HTMLDivElement>(null);
  // Recompute only on the runtime-relevant agent fields; depending on the whole
  // `agent` would recompute on every unrelated agent update (activity/status/name)
  // and churn the hydrated form.
  const { envVars: agentEnvVars, model: agentModel, reasoningEffort: agentReasoningEffort, runtime: agentRuntime, runtimeConfig: agentRuntimeConfig } = agent;
  const currentRuntimeConfig = useMemo(() => hydrateRuntimeConfigForm({
    envVars: agentEnvVars,
    model: agentModel,
    reasoningEffort: agentReasoningEffort,
    runtime: agentRuntime,
    runtimeConfig: agentRuntimeConfig,
  }), [agentEnvVars, agentModel, agentReasoningEffort, agentRuntime, agentRuntimeConfig]);
  const currentRuntimeModel = runtimeConfigModelValue(currentRuntimeConfig);
  // The runtime editor's draft is the v2 form's own (v2EditDraft below); the one
  // thing drafted here is which runtime it edits. `startRuntimeConfigEditing`
  // re-seeds it from the agent immediately before the editor opens.
  const [runtimeConfigEditorOpened, setRuntimeConfigEditorOpened] = useState(false);
  const canOpenRuntimeConfigEditor = canManageAgent && !isExternalAgent;
  const editingRuntimeConfig = runtimeConfigEditorOpened || (openRuntimeConfigRequested && canOpenRuntimeConfigEditor);
  const [draftRuntime, setDraftRuntime] = useState(agent.runtime || "claude");
  const [editingProviderConnection, setEditingProviderConnection] = useState<ProviderConnectionSummary | null>(null);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);
  const [runtimeConfigSaveError, setRuntimeConfigSaveError] = useState("");
  const [externalStatus, setExternalStatus] = useState<ExternalAgentStatus | null>(null);
  const [externalStatusError, setExternalStatusError] = useState("");
  const openProfile = useProfileStore((s) => s.openProfile);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const isActive = displayState.isOnline || agent.status === "active";
  // Only the read-only display reads the model list: its label for the stored model.
  const runtimeModels = useRuntimeModels(agent.machineId, currentRuntimeConfig.runtime);
  const currentRuntimeModelPresentation = projectRuntimeModelLabelPresentation(currentRuntimeConfig.runtime, currentRuntimeModel, runtimeModels, agent.machineId);
  const currentRuntimeModelLabel = currentRuntimeModelPresentation.kind === "pending"
    ? formatMessage({ id: "common.loading" })
    : currentRuntimeModelPresentation.label;
  // Reconciler step 11c: what the running process reports it runs. A saved
  // change waiting for the agent's idle point differs from it; unknown or equal says nothing.
  const running = isActive ? agent.runtimeProfile?.current : null;
  const runningRuntime = running?.runtime || null;
  // A model name is set in Space Mono, as on the Model row (Raft DS); a runtime name is not.
  const modelLabel = (key: string, model: string) => <span key={key} className="font-mono">{getModelLabel(currentRuntimeConfig.runtime, model) || model}</span>;
  const runningConfigHint = runningRuntime && runningRuntime !== currentRuntimeConfig.runtime
    ? { running: getRuntimeDisplayName(runningRuntime), saved: getRuntimeDisplayName(currentRuntimeConfig.runtime) }
    : running?.model && currentRuntimeModel && running.model !== currentRuntimeModel
      ? { running: modelLabel("running", running.model), saved: modelLabel("saved", currentRuntimeModel) }
      : null;
  const availableRuntimes = agentMachine?.runtimes || [];
  // Gated on the same flag that governs display, so the loader and the surface
  // cannot drift apart: a remote joint agent shows no operational info and must
  // therefore not trigger this server's private runtime-options fetch either.
  const { options: runtimeAdmissionOptions, loading: runtimeAdmissionLoading } = useExistingAgentRuntimeSelectionOptions(
    agent.id,
    availableRuntimes,
    showOperationalInfo,
  );
  const draftRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.runtimeId === draftRuntime);
  // Protocol v2 edit — the only runtime editor: the same server-described form
  // as create, pre-filled by the server with this agent's values (writeOnly
  // fields blank = keep). Switching to another runtime loads that runtime's
  // create form instead (nothing to prefill, no secret to keep) and saves it as
  // a runtime switch (task #8). A saved provider connection is edited natively
  // (capability provider.saved_connection).
  // A runtime whose admission row has no v2 marker, or a form needing client
  // capabilities this build lacks, shows the form-unavailable notice and
  // cannot be saved; a failed load shows it with a retry.
  const draftRuntimeHasFormV2 = draftRuntimeAdmission?.runtimeFormV2?.protocolVersion === 2;
  const v2EditEligible = editingRuntimeConfig
    && showOperationalInfo
    && draftRuntimeHasFormV2;
  const v2RuntimeSwitched = draftRuntime !== agent.runtime;
  const runtimeFormV2Loaded = useRuntimeFormV2(
    v2EditEligible ? agent.machineId : null,
    v2EditEligible ? draftRuntime : null,
    v2RuntimeSwitched ? undefined : agent.id,
  );
  const runtimeFormV2Edit = draftRuntimeHasFormV2
    ? runtimeFormV2Loaded
    // Until the admission rows arrive nothing says the runtime lacks a form.
    : runtimeAdmissionLoading ? RUNTIME_FORM_V2_LOADING : RUNTIME_FORM_V2_UNAVAILABLE;
  const [v2EditDraft, setV2EditDraft] = useState<RuntimeFormV2Values | null>(null);
  const [v2EditServerErrors, setV2EditServerErrors] = useState<Record<string, string>>({});
  const v2EditInitial = useMemo(
    () => runtimeFormV2Edit.status === "ready" ? initialRuntimeFormV2Values(runtimeFormV2Edit.form, runtimeFormV2Edit.sources) : null,
    [runtimeFormV2Edit],
  );
  const v2EditValues = v2EditDraft ?? v2EditInitial;
  // A runtime switch is a change by itself, even with the new form's defaults untouched.
  const v2EditChanged = v2RuntimeSwitched
    || Boolean(v2EditDraft && v2EditInitial && JSON.stringify(v2EditDraft) !== JSON.stringify(v2EditInitial));
  // A required field whose option source is unavailable cannot be saved (option_source.status),
  // nor a blank secret whose bound fields changed (writeOnlyKeepRequiresUnchanged).
  const v2EditBlocked = runtimeFormV2Edit.status === "ready" && v2EditValues !== null
    && Object.values(validateRuntimeFormV2(runtimeFormV2Edit.form, runtimeFormV2Edit.sources, v2EditValues, { editing: !v2RuntimeSwitched }))
      .some((code) => code === "source_unavailable" || code === "secret_reentry_required");
  // The runtime must still be selectable here: its Computer capability can go away mid-edit.
  const draftRuntimeCanSelect = draftRuntimeAdmission?.canSelectInThisContext === true;
  const v2EditSaveDisabled = savingRuntimeConfig || !draftRuntimeCanSelect || runtimeFormV2Edit.status !== "ready" || !v2EditChanged || v2EditBlocked;
  const changeV2EditValue = useCallback((key: string, value: RuntimeFormV2Value) => {
    if (runtimeFormV2Edit.status !== "ready" || !v2EditValues) return;
    setV2EditServerErrors({});
    setV2EditDraft(applyRuntimeFormV2Change(runtimeFormV2Edit.form, runtimeFormV2Edit.sources, v2EditValues, key, value));
  }, [runtimeFormV2Edit, v2EditValues]);
  // Deprecated is this server's answer: its row for the agent's runtime (matched by id: rows are not
  // re-fetched after a switch), else its runtime catalog, which falls back to the bundled one.
  const currentRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.current && option.runtimeId === currentRuntimeConfig.runtime);
  const currentRuntimeDeprecated = currentRuntimeAdmission ? currentRuntimeAdmission.admissionReason === "deprecated" : deprecatedHere(currentRuntimeConfig.runtime);
  const canViewRuntimeAccountUsage = showOperationalInfo
    && canViewMachineRuntimeAccountUsage(agentMachine, currentUserId, capabilities);
  // Saved Provider connections, for the v2 form's pencil (edit) action.
  const providerConnectionCatalog = useProviderConnections(canManageAgent);
  // Which runtimes the agent may switch to is the server's rows (a deprecated
  // runtime it offers again is one); the bundled catalog only names them.
  const runtimePickerRows = runtimeAdmissionOptions.flatMap((option): RuntimePickerRow[] => {
    const runtimeInfo = getRuntimeInfo(option.runtimeId);
    const deprecatedHere = option.admissionReason === "deprecated";
    return runtimeInfo?.supported
      ? [{
          value: runtimeInfo.id,
          label: formatRuntimeLabelBesideBadge(runtimeInfo.id, formatMessage, deprecatedHere),
          availabilitySuffix: formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtimeInfo, availableRuntimes), formatMessage),
          experimental: runtimeShowsExperimentalBadge(runtimeInfo.id, deprecatedHere),
          disabled: !option.canSelectInThisContext,
          capabilityStatus: option.capabilityStatus,
          selectable: option.canSelectInThisContext,
          // The agent's runtime is always listed, first, even when deprecated.
          current: runtimeInfo.id === currentRuntimeConfig.runtime,
        }]
      : [];
  });
  const [showAllRuntimes, setShowAllRuntimes] = useState(false);
  const runtimeComputerName = agentMachine?.name ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const runtimePicker = groupRuntimePickerRows(runtimePickerRows, {
    showAll: showAllRuntimes,
    selectedValue: draftRuntime,
    formatMessage,
  });
  const runtimeOptions = runtimePicker.options;
  const runtimeListAction = useRuntimeShowAllAction(runtimePicker.canToggle, showAllRuntimes, setShowAllRuntimes);
  const runtimeBelowDescription = (
    // Signed out is said, never enforced: Save stays as it is.
    <RuntimeSignInNotice
      serverId={currentServer?.id}
      machineId={agentMachine?.id}
      machineName={runtimeComputerName}
      runtimeId={draftRuntime}
      enabled={editingRuntimeConfig && canViewRuntimeAccountUsage}
    />
  );

  const [showRoleHelp, setShowRoleHelp] = useState(false);
  const [onboardingIdentityState, setOnboardingIdentityState] = useState<{
    agentId: string | null;
    preview: OnboardingIdentityAdoptionPreview | null;
    error: string;
  }>({ agentId: null, preview: null, error: "" });
  const isCurrentServerOnboardingAgent = Boolean(
    canManageAgent
    && showOperationalInfo
    && currentServer?.onboardingAgentId
    && currentServer.onboardingAgentId === agent.id,
  );

  const currentAgentServerRole = agent.serverRole === "admin" ? "admin" : agent.serverRole === "member" ? "member" : null;
  const editableAgentRoleOptions = useEditableAgentRoleOptions(agent);
  const canEditServerRole = canChangeAgentRole && currentAgentServerRole !== null && editableAgentRoleOptions.length > 0;
  const currentAgentServerRoleInfo = currentAgentServerRole ? AGENT_ROLE_CONFIG[currentAgentServerRole] : null;
  // task #261: unrecognized role -> show the name the server sent; no role / deleted -> no chip.
  const serverRoleDisplay = resolveAgentServerRoleDisplay(agent.serverRole, agent.deletedAt);

  useEffect(() => {
    if (!isCurrentServerOnboardingAgent) return;
    let canceled = false;
    void fetchOnboardingIdentityAdoption(agent.id)
      .then((preview) => {
        if (!canceled) setOnboardingIdentityState({ agentId: agent.id, preview, error: "" });
      })
      .catch((err: unknown) => {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        if (!canceled) setOnboardingIdentityState({
          agentId: agent.id,
          preview: null,
          error: axiosErr.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadOfficialIdentityFailed" }),
        });
      });
    return () => {
      canceled = true;
    };
  }, [agent.avatarUrl, agent.description, agent.displayName, agent.id, agent.name, fetchOnboardingIdentityAdoption, isCurrentServerOnboardingAgent]);

  useEffect(() => {
    if (!isExternalAgent || !canManageAgent) return;
    let canceled = false;
    const loadExternalStatus = async () => {
      setExternalStatusError("");
      try {
        const status = await fetchExternalAgentStatus(agent.id);
        if (!canceled) setExternalStatus(status);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        if (!canceled) setExternalStatusError(axiosErr.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadExternalSetupStatusFailed" }));
      }
    };
    void loadExternalStatus();
    return () => {
      canceled = true;
    };
  }, [agent.id, canManageAgent, fetchExternalAgentStatus, isExternalAgent]);

  // Hosted runtime (antiproton): the provisioning record replaces the manual setup steps.
  const hostedRuntime = externalStatus?.hostedRuntime ?? agent.hostedRuntime ?? null;
  const hostedRuntimeInProgress = hostedRuntime ? describeHostedRuntime(hostedRuntime).inProgress : false;
  // A paused assistant's runtime reads Paused, not Running (#10654).
  const hostedRuntimePaused = useAssistantPause(agent.id) !== null;
  useEffect(() => {
    if (!isExternalAgent || !canManageAgent || !hostedRuntimeInProgress) return;
    let canceled = false;
    const timer = setInterval(() => {
      void fetchExternalAgentStatus(agent.id)
        .then((status) => { if (!canceled) setExternalStatus(status); })
        .catch(() => undefined);
    }, HOSTED_RUNTIME_POLL_MS);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [agent.id, canManageAgent, fetchExternalAgentStatus, hostedRuntimeInProgress, isExternalAgent]);
  const handleRetryHostedRuntime = useCallback(async (options?: { model?: string | null }) => {
    await retryHostedRuntimeProvisioning(agent.id, options);
    setExternalStatus(await fetchExternalAgentStatus(agent.id));
  }, [agent.id, fetchExternalAgentStatus, retryHostedRuntimeProvisioning]);


  const currentOnboardingIdentityPreview = onboardingIdentityState.agentId === agent.id ? onboardingIdentityState.preview : null;
  const currentOnboardingIdentityError = onboardingIdentityState.agentId === agent.id ? onboardingIdentityState.error : "";

  const closeRuntimeConfigEditor = useCallback(() => {
    setV2EditDraft(null);
    setV2EditServerErrors({});
    setRuntimeConfigEditorOpened(false);
    onRuntimeConfigOpenRequestHandled?.();
    setRuntimeConfigSaveError("");
    setDraftRuntime(currentRuntimeConfig.runtime);
  }, [currentRuntimeConfig.runtime, onRuntimeConfigOpenRequestHandled]);

  const requestConfirm = useCallback((config: PendingConfirm) => {
    closeRuntimeConfigEditor();
    setPendingConfirm(config);
  }, [closeRuntimeConfigEditor]);
  const closePendingConfirm = useCallback(() => setPendingConfirm(null), []);

  const handleAdoptOnboardingIdentity = useCallback(() => {
    const onboardingIdentityPreview = currentOnboardingIdentityPreview;
    if (!onboardingIdentityPreview || onboardingIdentityPreview.changes.length === 0) return;
    const formatIdentityValue = (value: string | null) => value && value.trim()
      ? value
      : formatMessage({ id: "agent.detail.blank" });
    const grantsServerAdmin = onboardingIdentityPreview.changes.some(
      (change) => change.field === "serverRole" && change.after === "admin",
    );
    requestConfirm({
      title: grantsServerAdmin
        ? formatMessage({ id: "agent.detail.updateIdentityAndAdminRole" })
        : formatMessage({ id: "agent.detail.updateOfficialIdentity" }),
      message: (
        <div className="stack-y-4">
          {/* The title and the before → after list say it: no "Review…" line (HelperText step 1). */}
          <dl>
            {onboardingIdentityPreview.changes.map((change, index) => (
              <div
                key={change.field}
                data-onboarding-identity-change={change.field}
                className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3 pb-3 last:pb-0"
              >
                {index > 0 ? <Separator className="col-span-full" /> : null}
                <dt className="text-footnote font-medium text-foreground-hint">{change.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-callout">
                  <span className="min-w-0 break-words text-foreground-hint">{formatIdentityValue(change.before)}</span>
                  <MoveRight aria-hidden="true" size={16} className="shrink-0 text-foreground-hint" />
                  <span className="min-w-0 break-words font-semibold text-foreground">{formatIdentityValue(change.after)}</span>
                </dd>
              </div>
            ))}
          </dl>
          {grantsServerAdmin && (
            <Banner intent="warning" withIcon>
              {formatMessage({ id: "agent.detail.grantsAdminWarning" })}
            </Banner>
          )}
          <p className="text-caption text-foreground-hint">{formatMessage({ id: "agent.detail.customizeAfterIdentityUpdate" })}</p>
        </div>
      ),
      confirmLabel: grantsServerAdmin
        ? formatMessage({ id: "agent.detail.updateIdentityAndRole" })
        : formatMessage({ id: "agent.detail.updateIdentity" }),
      loadingLabel: formatMessage({ id: "agent.detail.updating" }),
      confirmVariant: "primary",
      plainMessage: true,
      maxWidthClass: "max-w-md",
      onConfirm: async () => {
        const result = await adoptOnboardingIdentity(agent.id);
        setOnboardingIdentityState({ agentId: agent.id, preview: result, error: "" });
      },
    });
  }, [adoptOnboardingIdentity, agent.id, currentOnboardingIdentityPreview, formatMessage, requestConfirm]);

  const createdDate = formatDate(agent.createdAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const currentProviderApiUrl = runtimeConfigApiUrl(currentRuntimeConfig);
  const currentCommand = runtimeConfigCommand(currentRuntimeConfig);

  const startRuntimeConfigEditing = useCallback(() => {
    setRuntimeConfigSaveError("");
    setDraftRuntime(currentRuntimeConfig.runtime);
    setShowAllRuntimes(false);
    setRuntimeConfigEditorOpened(true);
  }, [currentRuntimeConfig.runtime]);
  useImperativeHandle(runtimeConfigEditorRef, () => ({
    open: () => { if (canOpenRuntimeConfigEditor) startRuntimeConfigEditing(); },
  }), [canOpenRuntimeConfigEditor, startRuntimeConfigEditing]);

  const changeDraftRuntime = useCallback((id: string) => {
    setDraftRuntime(id);
    // The v2 draft belongs to the form it was made in.
    setV2EditDraft(null);
    setV2EditServerErrors({});
  }, []);

  const runtimeFormV2EditProps = useMemo(() => ({
    state: runtimeFormV2Edit,
    values: v2EditValues,
    onChange: changeV2EditValue,
    serverErrors: v2EditServerErrors,
    editing: !v2RuntimeSwitched,
  }), [changeV2EditValue, runtimeFormV2Edit, v2EditServerErrors, v2EditValues, v2RuntimeSwitched]);

  const closeRoleHelp = useCallback(() => setShowRoleHelp(false), []);
  const closeEditingProviderConnection = useCallback(() => setEditingProviderConnection(null), []);
  const refreshProviderConnections = providerConnectionCatalog.refresh;
  const completeEditingProviderConnection = useCallback(async () => {
    setEditingProviderConnection(null);
    await refreshProviderConnections();
  }, [refreshProviderConnections]);

  const saveRuntimeFormV2Edit = async () => {
    if (runtimeFormV2Edit.status !== "ready" || !v2EditValues) return;
    if (!v2EditChanged) {
      closeRuntimeConfigEditor();
      return;
    }
    const { form, sources } = runtimeFormV2Edit;
    // Field errors are already shown beside the fields; nothing to send yet.
    if (Object.keys(validateRuntimeFormV2(form, sources, v2EditValues, { editing: !v2RuntimeSwitched })).length > 0) return;
    const fields = {
      // The rendered form's protocol (2, or 3 for runtime_form.v3); same formValues.
      formDefinitionRef: { protocolVersion: form.protocolVersion, runtimeId: draftRuntime },
      formValues: runtimeFormV2Submission(form, v2EditValues, sources),
    };
    const save = async (restartMode?: "restart" | "session") => {
      try {
        const saved = await updateAgent(agent.id, fields, restartMode ? { restartMode } : undefined);
        setV2EditDraft(null);
        return saved.configApply;
      } catch (err: unknown) {
        const data = (err as { response?: { data?: { error?: string; issues?: Array<{ pointer?: string }> } } }).response?.data;
        const fieldErrors: Record<string, string> = {};
        for (const issue of data?.issues ?? []) {
          const key = issue.pointer?.startsWith("/formValues/") ? issue.pointer.slice("/formValues/".length) : "";
          if (key) fieldErrors[key] = data?.error ?? "";
        }
        setV2EditServerErrors(fieldErrors);
        setRuntimeConfigSaveError(data?.error ?? formatMessage({ id: "agent.detail.runtimeConfigInvalid" }));
        throw err;
      }
    };
    // A stopped agent's runtime switch is confirmed: it starts on a new session.
    if (v2RuntimeSwitched && !isActive) {
      requestConfirm({
        title: formatMessage({ id: "agent.detail.switchRuntimeConfig" }),
        message: formatMessage({ id: "agent.detail.switchRuntimeInactiveMessage" }, { from: getRuntimeDisplayName(agent.runtime), to: getRuntimeDisplayName(draftRuntime) }),
        confirmLabel: formatMessage({ id: "agent.detail.saveRuntimeChange" }),
        loadingLabel: formatMessage({ id: "agent.detail.applying" }),
        confirmVariant: "warning",
        onConfirm: async () => {
          await save("session");
        },
      });
      return;
    }
    // Reconciler step 11c (Tenny decision 1): a running agent is not
    // interrupted. Saved without restartMode, the change applies at its next
    // idle point (a runtime switch, or a Codex model change since `thread/resume`
    // pins the model, on a new session: the server clears it); the toast says
    // so and offers Restart now.
    const newSession = v2RuntimeSwitched || (draftRuntime === "codex" && v2EditValues.model !== v2EditInitial?.model);
    setSavingRuntimeConfig(true);
    try {
      const configApply = await save();
      closeRuntimeConfigEditor();
      announceRuntimeConfigApply({
        configApply,
        agentActive: isActive,
        agentName: agent.displayName || agent.name,
        newSession,
        formatMessage,
        ...(canRestartAgent && !agent.deletedAt ? { restartNow: (mode: "restart" | "session") => resetAgent(agent.id, mode) } : {}),
      });
    } catch {
      // Shown beside the fields and in the banner.
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleSaveRuntimeConfiguration = async () => {
    setRuntimeConfigSaveError("");
    await saveRuntimeFormV2Edit();
  };

  return (
    <>
      {/* Onboarding identity adoption. The display name itself is edited in the
          profile header (AgentHeaderName), which shows the same value. */}
      {(currentOnboardingIdentityPreview?.canAdopt || currentOnboardingIdentityError) && (
        <div className="px-(--surface-inset) pt-4">
          {currentOnboardingIdentityPreview?.canAdopt && (
            <Button variant="accent" size="md"
              type="button"
              onClick={handleAdoptOnboardingIdentity}
            >
              {formatMessage({ id: "agent.detail.updateOfficialIdentity" })}
            </Button>
          )}
          {currentOnboardingIdentityError && (
            <div className="mt-2 text-footnote font-semibold text-warning-strong">{currentOnboardingIdentityError}</div>
          )}
        </div>
      )}

      {/* Description */}
      <div className="px-(--surface-inset) py-3">
        <div className="flex items-center gap-2 mb-1">
          <SectionEyebrow as="div">
            {formatMessage({ id: "machine.detail.description" })}
          </SectionEyebrow>
          {canManageAgent && onEdit && !agent.managedByAppInstallId && (
            <Tooltip content={formatMessage({ id: "agent.detail.editDescription" })}>
              <button
                type="button"
                aria-label={formatMessage({ id: "agent.detail.editDescription" })}
                onClick={() => onEdit("description")}
                className={INFO_ICON_BUTTON_CLASS}
              >
                <Pencil size={14} />
              </button>
            </Tooltip>
          )}
        </div>
        <p className="text-subhead text-foreground">
          {(agent.managedByAppInstallId
            ? (agent.managedByApp ? agent.managedByApp.description : agent.description)
            : agent.description) || (
            <span className="text-foreground-hint">{formatMessage({ id: "machine.detail.noDescription" })}</span>
          )}
        </p>
      </div>

      {showOperationalInfo && isExternalAgent && canManageAgent && !agent.managedByAppInstallId && (
        <>
        <Separator />
        <div className="px-(--surface-inset) py-4">
          {hostedRuntime ? (
            <>
              <SectionEyebrow as="div" className="mb-2">
                {formatMessage({ id: "agent.detail.externalSetup" })}
              </SectionEyebrow>
              <Card className="block stack-y-3 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge appearance="soft" variant={externalStatus?.setupState === "connected" ? "success" : "muted"}>
                    <StatusDot presence={externalStatus?.setupState === "connected" ? "online" : "offline"} className="shrink-0" />
                    {formatMessage({ id: externalStatus?.setupState === "connected" ? "machine.detail.connected" : "agent.detail.waitingForLogin" })}
                  </Badge>
                </div>
                <HostedRuntimeStatus summary={hostedRuntime} onRetry={handleRetryHostedRuntime} paused={hostedRuntimePaused} />
              </Card>
            </>
          ) : externalStatus ? (
            <ExternalAgentConnectionCard
              key={agent.id}
              agent={agent}
              status={externalStatus}
              canIssueCredentials={capabilities.issueAgentCredentials || (agent.creatorType === "user" && agent.creatorId === currentUserId)}
              onStatus={setExternalStatus}
            />
          ) : null}
          {externalStatusError && (
            <p className="mt-2 text-footnote font-semibold text-warning-strong">{externalStatusError}</p>
          )}
        </div>
        </>
      )}

      {showOperationalInfo && isExternalAgent && canManageAgent && !agent.managedByAppInstallId && hostedRuntime?.state === "active" && (
        <>
          <AgentHostedRuntimeModel key={`model-${agent.id}`} agentId={agent.id} />
          <AgentConnections key={agent.id} agentId={agent.id} agentName={agent.displayName || agent.name} />
          <AgentHostedRuntimeUsage key={`usage-${agent.id}`} agentId={agent.id} />
        </>
      )}

      {showOperationalInfo && (
        <>
          {/* Info */}
          <Separator />
          <div className="px-(--surface-inset) py-4">
            <SectionEyebrow as="div" className="mb-3">
              {formatMessage({ id: "machine.detail.info" })}
            </SectionEyebrow>
            <DescriptionList direction="horizontal">
              {/* Role: server-role editing is an agent-ops surface; a managed
                  bot's authority is the app's grant, not a server role. */}
              {!agent.managedByAppInstallId && (
              <InfoRow
                label={formatMessage({ id: "agent.detail.role" })}
                actions={
                  <>
                    <Tooltip content={formatMessage({ id: "agent.detail.rolePermissions" })}>
                      <button type="button" onClick={() => setShowRoleHelp(true)} className={INFO_ICON_BUTTON_CLASS}>
                        <HelpCircle size={14} />
                      </button>
                    </Tooltip>
                    {canEditServerRole && onEdit && (
                      <Tooltip content={formatMessage({ id: "agent.detail.editRole" })}>
                        <button
                          type="button"
                          aria-label={formatMessage({ id: "agent.detail.editRole" })}
                          onClick={() => onEdit("role")}
                          className={INFO_ICON_BUTTON_CLASS}
                        >
                          <Pencil size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </>
                }
              >
                {currentAgentServerRoleInfo ? (
                  <span>{formatMessage({ id: currentAgentServerRoleInfo.labelId })}</span>
                ) : serverRoleDisplay.kind === "unrecognized" ? (
                  <Tooltip content={agent.serverRole ?? ""}>
                    <span className="min-w-0 truncate">{serverRoleDisplay.label}</span>
                  </Tooltip>
                ) : null}
              </InfoRow>
              )}
              {/* Computer: name, connection and version each get a row, so a long
                  (wrapping) computer name never has the status wedged into it. */}
              {!agent.managedByAppInstallId && (<>
              <InfoRow label={formatMessage({ id: "machine.detail.computer" })}>
                {isExternalAgent ? (
                  <span className="text-foreground-muted">{formatMessage({ id: "agent.detail.externalRuntime" })}</span>
                ) : agentMachineRow.kind === "pending" ? null : agentMachine ? (
                  // Long names truncate; the full name shows on hover.
                  <Tooltip content={agentMachine.name}>
                    <button
                      onClick={() => { useProfileStore.getState().closeProfile(); useThreadStore.getState().closeThread(); nav.toMachine(agentMachine.id); }}
                      className="block max-w-full truncate text-left font-mono text-foreground hover:underline"
                    >
                      {agentMachine.name}
                    </button>
                  </Tooltip>
                ) : archivedMachineName ? (
                  // An archived agent has no Computer; say where it last ran.
                  <span className="text-foreground-muted" data-testid="agent-archived-last-computer">
                    {formatMessage({ id: "agent.detail.lastComputer" }, { name: archivedMachineName })}
                  </span>
                ) : (
                  <span className="text-foreground-hint">
                    {formatMessage({ id: "agent.detail.noComputerAssigned" })}
                  </span>
                )}
              </InfoRow>
              {!isExternalAgent && agentMachine && (
                <>
                  {/* "Computer status", not "Status": the header already shows the agent's own
                      activity, and these are two different things. */}
                  <InfoRow label={formatMessage({ id: "agent.detail.computerStatus" })} testId="agent-computer-connection">
                    <span className="flex items-center gap-1.5">
                      <StatusDot
                        presence={machineStatus === "online" ? "online" : "offline"}
                        className="shrink-0"
                      />
                      {machineStatus === "online"
                        ? formatMessage({ id: "activity.status.online" })
                        : formatMessage({ id: "machine.detail.offline" })}
                    </span>
                  </InfoRow>
                  <InfoRow label={formatMessage({ id: "machine.detail.computerVersion" })} testId="agent-computer-version">
                    {/* The version only: whether it is online is the row above. */}
                    <span className="font-mono">{agentMachineVersion ? formatMessage({ id: "machine.rack.version" }, { version: agentMachineVersion }) : "—"}</span>
                  </InfoRow>
                </>
              )}
              </>)}
              {/* Created */}
              <InfoRow label={formatMessage({ id: "machine.detail.created" })}>
                <span className="font-mono">{createdDate}</span>
              </InfoRow>
              {/* Creator: a managed bot's creator IS the app, already shown
                  by the managed-by row. */}
              {!agent.managedByAppInstallId && (<>
              <InfoRow label={formatMessage({ id: "agent.detail.creator" })}>
                {agent.creator ? (
                  <Tooltip content={agent.creator.displayName || agent.creator.name}>
                  <button
                    type="button"
                    onClick={() => {
                      const type = agent.creator!.type === "human" ? "human" : "agent";
                      (onOpenProfile ?? openProfile)(type, agent.creator!.id);
                    }}
                    className="flex max-w-full items-center gap-2 text-left hover:underline"
                  >
                    {agent.creator.type === "human" ? (
                      <AvatarSlot
                        context="creator-link"
                        type="human"
                        humanAvatarUrl={agent.creator.avatarUrl}
                      />
                    ) : (
                      <AvatarSlot
                        context="creator-link"
                        type="agent"
                        agentAvatarUrl={agent.creator.avatarUrl}
                      />
                    )}
                    <span className="min-w-0 truncate">{agent.creator.displayName || agent.creator.name}</span>
                    <span className="min-w-0 flex-1 max-w-fit truncate font-mono text-mono-meta text-foreground-hint">@{agent.creator.name}</span>
                  </button>
                  </Tooltip>
                ) : (
                  <span className="text-foreground-hint">
                    {formatMessage({ id: "agent.detail.noCreatorAssigned" })}
                  </span>
                )}
              </InfoRow>
              </>)}
              {/* App-bot identity — the owning app IS this bot's identity:
                  logo + name + badge, not runtime/person metadata. */}
              {agent.managedByAppInstallId && (
                <InfoRow label={formatMessage({ id: "agent.detail.managedByApp" })}>
                  <ManagedByAppValue agent={agent} />
                  {/* P4b: the app-published status line (Slack App Home).
                      App-published text, not presence — the card stays silent
                      when the app publishes nothing. */}
                  {agent.managedByApp?.botStatusText && (
                    <span className="mt-1 block text-caption text-foreground-muted">
                      {agent.managedByApp.botStatusText}
                    </span>
                  )}
                </InfoRow>
              )}
            </DescriptionList>
          </div>

          {!isExternalAgent && (
            <>
            <Separator />
            <div ref={configRef} className="px-(--surface-inset) py-4">
              <div className="w-full">
                <div className="flex items-center gap-2 mb-3">
                  <SectionEyebrow as="div">
                    {formatMessage({ id: "agent.detail.runtimeConfig" })}
                  </SectionEyebrow>
                  {canManageAgent && !editingRuntimeConfig && (
                    <Tooltip content={formatMessage({ id: "agent.detail.editRuntimeConfig" })}>
                    <button
                      type="button"
                      aria-label={formatMessage({ id: "agent.detail.editRuntimeConfig" })}
                      onClick={startRuntimeConfigEditing}
                      className={INFO_ICON_BUTTON_CLASS}
                    >
                      <Pencil size={14} />
                    </button>
                    </Tooltip>
                  )}
                </div>
                {/* Vertical label | value rows (same as Info); values keep their original styling. */}
                <DescriptionList direction="horizontal">
                  <InfoRow label={formatMessage({ id: "agent.runtimeConfig.runtime" })}>
                    <RuntimeAccountUsageGateChip
                        enabled={canViewRuntimeAccountUsage}
                        runtimeId={currentRuntimeConfig.runtime}
                        runtimeVersion={agentMachine?.runtimeVersions?.[currentRuntimeConfig.runtime]}
                        serverId={currentServer?.id ?? null}
                        machineId={agentMachine?.id ?? ""}
                        appearance="soft"
                        variant="information"
                        className={RUNTIME_CHIP_CLASS}
                      >
                        {/* A plain string child: the usage chip derives its accessible
                            name from it, so the cpu icon lives on the hero chip only. */}
                        {formatRuntimeLabelWithStatus(currentRuntimeConfig.runtime, formatMessage, currentRuntimeDeprecated)}
                      </RuntimeAccountUsageGateChip>
                  </InfoRow>
                  <AgentRuntimeUsageRow enabled={canViewRuntimeAccountUsage && !isExternalAgent} serverId={currentServer?.id ?? null} machineId={agentMachine?.id ?? ""} runtimeId={currentRuntimeConfig.runtime} model={currentRuntimeModel} />
                  {currentRuntimeDeprecated && (
                    <Banner intent="warning" density="sm" className="col-span-full my-1">
                      {formatMessage({ id: "agent.detail.deprecatedRuntimeWarning" })}
                    </Banner>
                  )}
                  <InfoRow label={formatMessage({ id: "agent.runtimeConfig.model" })}>
                    <span className="min-w-0 break-all font-mono">{currentRuntimeModelLabel}</span>
                    {runningConfigHint && (
                      <span className="mt-1 block text-caption text-foreground-muted" data-testid="agent-runtime-config-running">
                        {formatMessage({ id: "agent.runtimeConfig.runningSwitchesWhenIdle" }, runningConfigHint)}
                      </span>
                    )}
                  </InfoRow>
                  {REASONING_EFFORT_RUNTIMES.has(currentRuntimeConfig.runtime) && (
                    <InfoRow label={formatMessage({ id: "agent.runtimeConfig.reasoning" })}>
                      <span>
                        {currentRuntimeConfig.reasoningEffort
                          ? formatMessage({ id: reasoningEffortLabelId(currentRuntimeConfig.reasoningEffort) ?? "agent.runtimeConfig.default" })
                          : formatMessage({ id: "agent.runtimeConfig.default" })}
                      </span>
                    </InfoRow>
                  )}
                  {supportsRuntimeFastMode(currentRuntimeConfig.runtime) && (
                    <InfoRow label={formatMessage({ id: "agent.runtimeConfig.mode" })}>
                      <span>
                        {runtimeConfigFastMode(currentRuntimeConfig)
                          ? formatMessage({ id: "agent.runtimeConfig.fastMode" })
                          : formatMessage({ id: "agent.runtimeConfig.default" })}
                      </span>
                    </InfoRow>
                  )}
                  {currentRuntimeConfig.runtime === "claude" && (
                    <>
                      <InfoRow label={formatMessage({ id: "agent.runtimeConfig.provider" })}>
                        {currentProviderApiUrl
                            ? <span className="min-w-0 break-all font-mono">{currentProviderApiUrl}</span>
                            : <span className="text-foreground-hint">{formatMessage({ id: "agent.runtimeConfig.default" })}</span>}
                      </InfoRow>
                      <InfoRow label={formatMessage({ id: "agent.runtimeConfig.command" })}>
                        {currentCommand
                            ? <span className="min-w-0 break-all font-mono">{currentCommand}</span>
                            : <span className="text-foreground-hint">{formatMessage({ id: "agent.runtimeConfig.default" })}</span>}
                      </InfoRow>
                    </>
                  )}
                </DescriptionList>
                {agent.modelLimits?.defaultsReported && <AgentModelLimitsWarning className="mt-3" />}
                <div className="mt-3">
                  <EnvVarsSection agent={agent} canManageAgent={false} />
                </div>
              </div>
            </div>
            </>
          )}
        </>
      )}
      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          loadingLabel={pendingConfirm.loadingLabel}
          confirmVariant={pendingConfirm.confirmVariant}
          plainMessage={pendingConfirm.plainMessage}
          maxWidthClass={pendingConfirm.maxWidthClass}
          chromeLocale="active"
          onConfirm={pendingConfirm.onConfirm}
          onClose={closePendingConfirm}
          layer={1}
        />
      )}

      {showRoleHelp && (
        <RolePermissionHelpDialog
          subject="agent"
          onClose={closeRoleHelp}
        />
      )}

      {editingRuntimeConfig && (
        <RuntimeConfigEditorFrame
          title={formatMessage({ id: "agent.detail.editRuntimeConfig" })}
          onClose={closeRuntimeConfigEditor}
          surfaceRef={runtimeConfigModalRef}
          // Opened from the editor's provider picker: inside the editor's tree, so it stacks over it (layer 1, as the
          // editor), and Esc closes only it.
          nested={editingProviderConnection ? (
            <EditProviderConnectionModal
              key={editingProviderConnection.id}
              connection={editingProviderConnection}
              providerOptions={providerConnectionCatalog.providerOptions}
              onClose={closeEditingProviderConnection}
              onCompleted={completeEditingProviderConnection}
              layer={1}
            />
          ) : null}
        >
            <form
              className="stack-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveRuntimeConfiguration();
              }}
            >
              <RuntimeConfigFields
                runtime={draftRuntime}
                onRuntimeChange={changeDraftRuntime}
                runtimeOptions={runtimeOptions}
                runtimeBelowDescription={runtimeBelowDescription}
                runtimeListAction={runtimeListAction}
                selectPortalContainer={runtimeConfigModalRef}
                providerConnections={providerConnectionCatalog.connections}
                onEditProviderConnection={capabilities.manageExternalAuth ? setEditingProviderConnection : undefined}
                runtimeFormV2={runtimeFormV2EditProps}
              />
              {agent.modelLimits?.defaultsReported && draftRuntime === "builtin" && !v2EditChanged && <AgentModelLimitsWarning />}

              {runtimeConfigSaveError ? (
                <Banner intent="warning" density="sm">
                  {runtimeConfigSaveError}
                </Banner>
              ) : null}

              <DialogCardFooter>
                <Button variant="ghost" size="lg"
                  type="button"
                  onClick={closeRuntimeConfigEditor}
                  disabled={savingRuntimeConfig}
                >
                  {formatMessage({ id: "common.confirm.cancel" })}
                </Button>
                <DialogCommit>
                  {(inHead) => (
                    <Button variant="primary" size={inHead ? "md" : "lg"}
                      type="submit"
                      disabled={v2EditSaveDisabled}
                    >
                      {formatMessage({ id: "agent.detail.saveRuntimeConfig" })}
                    </Button>
                  )}
                </DialogCommit>
              </DialogCardFooter>
            </form>
        </RuntimeConfigEditorFrame>
      )}
    </>
  );
}
