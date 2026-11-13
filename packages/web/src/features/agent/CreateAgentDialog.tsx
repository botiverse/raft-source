import { Banner, BannerAction, BannerDescription, BannerTitle, Button, Input, ScrollArea, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectValue, Textarea, TextLink } from "@botiverse/raft-ui";
import CloseButton from "../../components/ui/CloseButton";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import Tooltip from "../../components/ui/Tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dices, X } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { orderMachinesLikeSidebar } from "../../components/layout/sidebarMachineOrder";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import { suggestAgentName, validateAgentNameReason, getRuntimeInfo, runtimeAvailabilitySuffix, PLAN_CONFIG, getBillingCapacityLimitLabel, getBillingCapacityLimitState, getBillingUsage, getEffectiveLimits, AGENT_LIMIT_REACHED_CODE, PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths, seatsFromTenths } from "@botiverse/raft-shared";
import type { CapacityLimitDetail, ProviderConnectionSummary, RuntimeSelectionOption, ServerPlan } from "@botiverse/raft-shared";
import { formatAgentNameValidationError } from "../../i18n/nameValidation";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelBesideBadge, runtimeShowsExperimentalBadge } from "../../utils/runtimeAvailabilityLabel";
import { useNewAgentRuntimeOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { RUNTIME_FORM_V2_UNAVAILABLE, useRuntimeFormV2 } from "../../hooks/useRuntimeFormV2";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { applyRuntimeFormV2Change, initialRuntimeFormV2Values, runtimeFormV2Submission, validateRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useAgentRuntimeProvider } from "../../hooks/useAgentRuntimeProvider";
import { HostedModelChoice, hostedModelPickerShown, initialHostedModel, useHostedRuntimeModels } from "../../components/agent/HostedModelChoice";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { CreateCindyFrame } from "./CreateCindyFrame";
import DialogCard from "../../components/ui/DialogCard";
import type { AddSeatsNeed, SeatUsage } from "../../components/billing/AddSeatsDialog";
import { AVATAR_KEYS } from "../../components/agent/PixelAvatar";
import AvatarSlot from "../../components/ui/AvatarSlot";
import RuntimeConfigFields from "../../components/agent/RuntimeConfigFields";
import { useRuntimeShowAllAction } from "../../components/agent/useRuntimeShowAllAction";
import { flatRuntimePickerOptions, groupRuntimePickerRows } from "../../components/agent/runtimePickerOptions";
import type { RuntimePickerRow } from "../../components/agent/runtimePickerOptions";
import RuntimeSignInNotice from "../../components/machine/RuntimeSignInNotice";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { useAuthStore } from "../../store/authStore";
import EditProviderConnectionModal from "../../components/settings/EditProviderConnectionModal";
import StableField, { FieldSelectTrigger } from "../../components/agent/StableField";
import SetupSessionFooter from "../../components/onboarding/SetupSessionFooter";
import { SETUP_PAPER, SETUP_PAPER_DOT_GRID, SETUP_STICKER_CARD } from "../../components/onboarding/setupPaper";
import { readCreateAgentLastConfig, writeCreateAgentLastConfig } from "../../utils/createAgentLastConfig";
import type { CreateAgentLastConfig } from "../../utils/createAgentLastConfig";
import { isCapacityLimitError } from "../../utils/capacityLimitError";
import { trackPaywallAction, usePaywallShown } from "../../analytics/paywall";
import { noteBillingEntry } from "../../analytics/billingEntry";
import { ICON_SM_END_PULL } from "../../components/ui/headEdges";
import { DialogCardFooter, DialogCommit } from "../../components/ui/NarrowDialog";
import { deferredDialog } from "../../boot/deferredUi";
import { useLocalComputerMachineId } from "../../components/machine/localComputer/localComputerStore";
import { useAddThisComputer } from "../../components/machine/localComputer/useAddThisComputer";
import { useNeedsComputerCopy } from "./useNeedsComputerCopy";
import { machineMeetsDaemonRequirement, pickFallbackMachine } from "./pickFallbackMachine";
import { showCreatedAgentToast } from "./createdAgentToast";

const AddSeatsDialog = deferredDialog(() => import("../../components/billing/AddSeatsDialog"));

/** Names already used on this server by agents or human members, so a suggested name avoids them. */
function takenAgentNames(): string[] {
  const agents = useAgentStore.getState().agents.filter((agent) => !agent.deletedAt).map((agent) => agent.name);
  return [...agents, ...useServerStore.getState().members.map((member) => member.name)];
}


const MAX_AGENT_DESCRIPTION_LENGTH = 3000;
/** The computer picker's value for "hosted by Raft": no computer, the agent runs on the provider. */
const HOSTED_COMPUTER_CHOICE = "__hosted_runtime__";

const ONBOARDING_RUNTIME_PRIORITY = ["claude", "codex", "grok", "builtin"];

function pickCreateAgentRuntime(
  availableRuntimes: readonly string[],
  supportedRuntimes: ReadonlySet<string>,
  onboarding: boolean,
  rememberedConfig: CreateAgentLastConfig | null,
): string {
  if (onboarding) {
    return ONBOARDING_RUNTIME_PRIORITY.find((id) => availableRuntimes.includes(id) && supportedRuntimes.has(id))
      || availableRuntimes.find((id) => supportedRuntimes.has(id))
      || availableRuntimes[0]
      || "";
  }
  if (
    rememberedConfig
    && availableRuntimes.includes(rememberedConfig.runtime)
    && supportedRuntimes.has(rememberedConfig.runtime)
  ) {
    return rememberedConfig.runtime;
  }
  return availableRuntimes.find((id) => supportedRuntimes.has(id)) || availableRuntimes[0] || "";
}

type ServerSetupProjection = {
  surface: "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
};

function onboardingCompleteErrorMessage(formatMessage: IntlShape["formatMessage"], err: unknown): string {
  const response = (err as { response?: { status?: number; data?: { error?: unknown } } }).response;
  const code = response?.data?.error;
  if (code === "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE") {
    return formatMessage({ id: "agent.create.cindyNotUsable" });
  }
  if (code === "LIVE_FACTS_UNAVAILABLE" || response?.status === 424) {
    return formatMessage({ id: "agent.create.cindyReadinessUnavailable" });
  }
  if (code === "INSUFFICIENT_PERMISSION" || response?.status === 403) {
    return formatMessage({ id: "agent.create.cindySetupPermission" });
  }
  if (typeof code === "string") {
    return formatMessage({ id: "agent.create.cindySetupErrorCode" }, { code });
  }
  return formatMessage({ id: "agent.create.cindySetupError" });
}

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

const EMPTY_RUNTIME_SELECTION_OPTIONS: readonly RuntimeSelectionOption[] = [];

function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}


export function CreateAgentDialog({
  onClose,
  defaultMachineId,
  onboarding = false,
  prefilledName,
  prefilledDescription,
  prefilledMachineId,
  prefilledMachineMode,
  prefilledHosting,
  prefilledHostedModel,
  minimumDaemonVersion,
  onCreated,
  onOnboardingComplete,
  onOnboardingLater,
  onOnboardingStartOver,
  onSubmitStart,
  onSubmitError,
  actionCardMessageId,
  actionCardConfirmationVersion,
  fromActionCard = false,
  stayOnCreate = false,
  external = false,
  previewOnly = false,
  previewRuntimeOptions,
  onboardingShell = "modal",
  autoJoinChannelName,
  prefilledNameNote,
}: {
  onClose: () => void;
  defaultMachineId?: string;
  onboarding?: boolean;
  /**
   * Prefilled name (action card shortcut, or the channel add-members create
   * entry carrying the search text). The field stays EDITABLE — only the
   * onboarding flow locks it (stdrc 2026-05-10 #proj-approval msg=2f20e3a2).
   * An invalid prefill surfaces its validation error immediately on open
   * instead of waiting for a submit attempt: the user did not type it into
   * this field, so silence would read as acceptance (task #1139 E-state).
   */
  prefilledName?: string;
  /** Same as prefilledName but for the description field. */
  prefilledDescription?: string;
  /**
   * Structured computer constraint from an action card. `preferred` preselects
   * the computer when it is online; `required` prevents silent fallback to any
   * other computer.
   */
  prefilledMachineId?: string;
  prefilledMachineMode?: "preferred" | "required";
  /**
   * Where an action card suggests the agent runs. `antiproton` preselects
   * "Hosted by Raft (Antiproton)" when it is available; the human can change it.
   */
  prefilledHosting?: "computer" | "antiproton";
  /** The card's hosted model, preselected only while the provider still offers it. */
  prefilledHostedModel?: string;
  /** Optional feature-specific hard gate for the Computer daemon. */
  minimumDaemonVersion?: string;
  /**
   * Channel add-members create entry (task #584): the channel this agent will
   * be added to right after creation. Renders a persistent context line so the
   * entry row's promise ("joins #channel after creation") stays visible until
   * submit instead of vanishing once the dialog opens.
   */
  autoJoinChannelName?: string;
  /**
   * Pre-formatted note explaining what happened to a prefilled name (the @ we
   * removed, the spaces we refused to touch). The caller owns the wording — it
   * knows what the user originally typed; this dialog only knows the result.
   */
  prefilledNameNote?: string;
  /**
   * Fired after the dialog successfully creates the agent. Used by the
   * action-card flow to call /api/actions/:msgId/mark-executed with the
   * new agent's id + name.
   */
  onCreated?: (agent: { id: string; name: string }) => void;
  /**
   * Fired after the onboarding setup-transition endpoint confirms completion.
   * The inline Screen C shell uses this to close the blocking setup modal
   * immediately instead of waiting for a follow-up projection refetch.
   */
  onOnboardingComplete?: () => void;
  /** Fired when the inline onboarding Screen C should durably defer setup. */
  onOnboardingLater?: () => Promise<void> | void;
  /** Roll the whole server back — offered until Cindy exists, which is the checkpoint. */
  onOnboardingStartOver?: () => Promise<void> | void;
  /**
   * Set by the action-card launcher so post-create navigation stays on the
   * action card itself (cindyz 2026-05-26 dm:@cindyz:b966e666 msg=f342577e:
   * "如果是通过 action card create, 应该停留在原本的 action card 里").
   * Overrides the "first agent → #all" rescue rule below — the action card
   * lives on a chat surface, so staying put is always the right move.
   */
  fromActionCard?: boolean;
  /** Keep the current surface after create; used by orchestrators that chain dialogs. */
  stayOnCreate?: boolean;
  /**
   * Action-card funnel hook: fired right before the create API call (after
   * client-side validation passes). Used to record `execute_attempt` in
   * the product funnel for the dialog-driven path. No-op for non-card
   * launches.
   */
  onSubmitStart?: () => void;
  /**
   * Action-card funnel hook: fired when the create API call throws. Used
   * to record `execute_fail`. Receives the raw error so the caller can
   * classify (status / code / network); the caller is responsible for
   * mapping to a low-cardinality `error_class`.
   */
  onSubmitError?: (err: unknown) => void;
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
  /** Opens the dedicated external-agent create flow. External agents have no Computer. */
  external?: boolean;
  /** Dev fixture mode: render the real form but never create an agent or finish setup. */
  previewOnly?: boolean;
  /** Dev fixture's explicit server projection. Never used as a production capability fallback. */
  previewRuntimeOptions?: readonly RuntimeSelectionOption[];
  /**
   * Where onboarding Screen C renders. "modal": self-wraps in its own raft-ui Dialog.
   * "step": bare content for the setup gate's Modal (browser flow) — first-agent
   * creation still navigates to the onboarding-owner channel behind the modal.
   * "page": bare content for the standalone onboarding page (client flow) — no
   * channel navigation, the user must stay on the page for survey/handoff.
   */
  onboardingShell?: "modal" | "step" | "page";
}) {
  const { formatMessage, formatNumber } = useIntl();
  const storeMachines = useMachineStore((s) => s.machines);
  const pinnedMachineId = useLocalComputerMachineId();
  // Same order as the Computers list (this device, then mine, then the rest).
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const machines = useMemo(
    () => orderMachinesLikeSidebar(storeMachines, pinnedMachineId, currentUserId),
    [storeMachines, pinnedMachineId, currentUserId],
  );
  const currentServer = useServerStore((s) => s.current);
  const rescanRuntimes = useMachineStore((s) => s.rescanRuntimes);
  const [runtimesRescanning, setRuntimesRescanning] = useState(false);
  // Portal target for the Create Cindy runtime selects — points at the modal
  // content so the Runs on / Model popovers open within the modal's stacking
  // context instead of behind it: the onboarding Create Cindy screen renders
  // inside the setup gate's Modal at layer 1 (z-[60]), where a body-level portal (the
  // default) lands under that layer and the popovers become invisible.
  const cindyRuntimeSelectPortalRef = useRef<HTMLElement>(null);
  // Keep the regular Create Agent popovers in the dialog's own layer too.
  // This matters when the shared dialog is opened from another modal surface,
  // such as Channel Settings: a body-level popup otherwise lands behind the
  // surrounding modal layer and its options cannot be selected.
  const createAgentSelectPortalRef = useRef<HTMLFormElement>(null);

  // A fresh create starts with a suggested name (`adjective-noun`) instead of
  // an empty field; the dice button next to the label rolls another. The name
  // is the agent's @handle, so a usable default beats an "untitled" one the
  // user has to rename later.
  const [name, setName] = useState(
    () => prefilledName ?? (onboarding ? "Cindy" : suggestAgentName(takenAgentNames())),
  );
  const [description, setDescription] = useState(
    prefilledDescription ?? (onboarding ? "Onboarding Assistant" : ""),
  );
  const remembersLastConfig = !onboarding && !external && !previewOnly;
  const rememberedConfig = useMemo(
    () => remembersLastConfig && currentServer
      ? readCreateAgentLastConfig(currentServer.id)
      : null,
    [currentServer, remembersLastConfig],
  );
  const defaultOnline = defaultMachineId
    && machines.find((m) => m.id === defaultMachineId)?.status === "online"
    && machineMeetsDaemonRequirement(machines.find((m) => m.id === defaultMachineId), minimumDaemonVersion)
    ? defaultMachineId
    : undefined;
  const prefilledMachine = prefilledMachineId
    ? machines.find((m) => m.id === prefilledMachineId)
    : undefined;
  const prefilledMachineOnline = prefilledMachine?.status === "online"
    && machineMeetsDaemonRequirement(prefilledMachine, minimumDaemonVersion);
  const rememberedMachineOnline = rememberedConfig
    ? machines.find((machine) =>
      machine.id === rememberedConfig.machineId
      && machine.status === "online"
      && machineMeetsDaemonRequirement(machine, minimumDaemonVersion)
    )?.id
    : undefined;
  const [selectedMachineId, setSelectedMachineId] = useState(
    prefilledMachineOnline
      ? prefilledMachineId!
      : prefilledMachineId
        ? ""
        : defaultOnline
          || rememberedMachineOnline
          || pickFallbackMachine(machines, minimumDaemonVersion, currentUserId)?.id
          || ""
  );
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const selectedMachineMeetsDaemonRequirement = machineMeetsDaemonRequirement(selectedMachine, minimumDaemonVersion);
  const createAgentSelectPortalProps = useMemo(() => ({ container: createAgentSelectPortalRef }), []);

  const machineOptions: SelectOption[] = useMemo(() => machines.map((machine) => {
    const isOffline = machine.status !== "online";
    const blockedByRequired = prefilledMachineMode === "required" && machine.id !== prefilledMachineId;
    const daemonTooOld = !machineMeetsDaemonRequirement(machine, minimumDaemonVersion);
    // The minimum version is in the line under the picker (agent.create.requiresDaemon).
    const daemonRequirementLabel = daemonTooOld && minimumDaemonVersion
      ? formatMessage({ id: "agent.create.updateRequiredSuffix" })
      : "";
    return {
      value: machine.id,
      label: machine.name + (machine.hostname ? ` (${machine.hostname})` : "") + (isOffline ? formatMessage({ id: "agent.create.offlineSuffix" }) : "") + daemonRequirementLabel,
      disabled: isOffline || blockedByRequired || daemonTooOld,
    };
  }), [machines, prefilledMachineMode, prefilledMachineId, minimumDaemonVersion, formatMessage]);
  // Hosted runtime (antiproton): a "computer" choice of its own in the normal form, when the
  // server's flag is on and the deployment is configured. A card that requires a computer
  // never offers it: confirming the card checks the agent landed on that computer.
  const hostedRuntimeProvider = useAgentRuntimeProvider(
    "antiproton",
    !external && !onboarding && !previewOnly && prefilledMachineMode !== "required",
  );
  const [hostedSelected, setHostedSelected] = useState(prefilledHosting === "antiproton");
  // With no computer connected, hosting is the only place the agent can run.
  const isHostedMode = hostedRuntimeProvider.available && (hostedSelected || machines.length === 0);
  const hostedModels = useHostedRuntimeModels("antiproton", isHostedMode);
  /** `undefined` until the creator picks; then an offered id, or `null` for the provider's default. */
  const [hostedModelPick, setHostedModelPick] = useState<string | null | undefined>(undefined);
  const hostedModelsView = hostedModels.state.kind === "ready" ? hostedModels.state.view : null;
  // Where the server may not pick (`antiproton_model_picker` off), Raft decides: no pick is sent.
  const hostedModel = hostedModelsView === null || hostedModelsView.locked || !hostedModelPickerShown(hostedModelsView)
    ? null
    : hostedModelPick !== undefined ? hostedModelPick
      : prefilledHostedModel !== undefined && hostedModelsView.models.some((option) => option.id === prefilledHostedModel)
        ? prefilledHostedModel
        : initialHostedModel(hostedModelsView);
  const computerOptions: SelectOption[] = useMemo(() => hostedRuntimeProvider.available
    ? [...machineOptions, { value: HOSTED_COMPUTER_CHOICE, label: formatMessage({ id: "agent.create.hostedRuntime.option" }) }]
    : machineOptions, [hostedRuntimeProvider.available, machineOptions, formatMessage]);
  const machineRuntimeIds = selectedMachine?.runtimes ?? [];
  const runtimeSelectionCatalog = useNewAgentRuntimeOptions(
    previewOnly ? null : selectedMachineId,
    machineRuntimeIds,
  );
  const runtimeAdmissionOptions = previewOnly
    ? previewRuntimeOptions ?? EMPTY_RUNTIME_SELECTION_OPTIONS
    : runtimeSelectionCatalog.options;
  const availableRuntimes = useMemo(
    () => runtimeAdmissionOptions
      .filter((option) => option.canSelectInThisContext)
      .map((option) => option.runtimeId),
    [runtimeAdmissionOptions],
  );
  // What a new agent can run on is this server's answer, its runtime-options rows (Antigravity
  // is one where its OAR flag is on), never the bundle's `deprecated`; the bundle only names them.
  // Memoized on the rows: the Set feeds effect deps below.
  const supportedSet = useMemo(() => new Set(runtimeAdmissionOptions
    .filter((option) => getRuntimeInfo(option.runtimeId)?.supported)
    .map((option) => option.runtimeId)), [runtimeAdmissionOptions]);
  const defaultRuntime = pickCreateAgentRuntime(
    availableRuntimes,
    supportedSet,
    onboarding,
    rememberedConfig,
  );
  const [runtime, setRuntime] = useState(defaultRuntime);
  const selectedRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.runtimeId === runtime);
  const [editingProviderConnection, setEditingProviderConnection] = useState<ProviderConnectionSummary | null>(null);
  const [error, setError] = useState("");
  const [createdOnboardingAgent, setCreatedOnboardingAgent] = useState<{ id: string; name: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  /** Has the user tried to submit at least once? Only then may a field report
   *  something the user has not done yet as an error. Never reset: once you have
   *  asked for the form to be checked, it stays checked, so corrections are
   *  confirmed live instead of going quiet until the next click. */
  // An invalid PREFILL shows its error from the first render: the user did not
  // type it into this field, so the usual "点击后才校验" silence would read as
  // the dialog accepting a name it will reject (task #1139 E-state). A name the
  // user types themselves keeps the submit-gated behavior below.
  const [validationAttempted, setValidationAttempted] = useState(
    () => !onboarding && !!prefilledName && validateAgentNameReason(prefilledName) !== null,
  );
  const createAgent = useAgentStore((s) => s.createAgent);
  const { capabilities } = useServerPermissions();
  const channels = useChannelStore((s) => s.channels);
  const allAgents = useAgentStore((s) => s.agents);
  const agents = allAgents.filter((a) => !a.deletedAt);
  const nav = useAppNavigate();
  // Saved Provider connections, for the v2 form's pencil (edit) action.
  const providerConnectionCatalog = useProviderConnections(!previewOnly && runtime === "builtin");
  // Protocol v2 (server-described form, rendered by field kind, submitted as
  // field values) is the only runtime form. Onboarding uses the same form as a
  // normal create (task #8: its technical fields sit in the collapsed Advanced
  // section). A runtime opts in with its admission row's `runtimeFormV2`
  // marker; a row without one, or a form needing client capabilities this
  // build lacks, is shown as unavailable and blocks Create. The DEV-only
  // preview has no server form: it renders the runtime picker alone.
  const runtimeHasFormV2 = !previewOnly && selectedRuntimeAdmission?.runtimeFormV2?.protocolVersion === 2;
  const runtimeFormV2Loaded = useRuntimeFormV2(
    runtimeHasFormV2 ? selectedMachineId : null,
    runtimeHasFormV2 ? runtime : null,
  );
  const runtimeFormV2 = runtimeHasFormV2 ? runtimeFormV2Loaded : RUNTIME_FORM_V2_UNAVAILABLE;
  const runtimeFormV2Key = runtimeFormV2.status === "ready" ? `${selectedMachineId}\0${runtime}` : "";
  const [v2Draft, setV2Draft] = useState<{ key: string; values: RuntimeFormV2Values } | null>(null);
  const [v2ServerErrors, setV2ServerErrors] = useState<Record<string, string>>({});
  const v2Values = runtimeFormV2.status === "ready"
    ? v2Draft?.key === runtimeFormV2Key
      ? v2Draft.values
      : initialRuntimeFormV2Values(runtimeFormV2.form, runtimeFormV2.sources)
    : null;
  const v2Errors = runtimeFormV2.status === "ready" && v2Values
    ? validateRuntimeFormV2(runtimeFormV2.form, runtimeFormV2.sources, v2Values)
    : {};
  // A required field whose option source is unavailable blocks like an empty one (option_source.status).
  const v2MissingRequired = Object.values(v2Errors).some((code) => code === "required" || code === "source_unavailable");
  const v2Malformed = Object.values(v2Errors).some((code) => code !== "required" && code !== "source_unavailable");
  const changeV2Value = useCallback((key: string, value: RuntimeFormV2Value) => {
    if (runtimeFormV2.status !== "ready" || !v2Values) return;
    setV2ServerErrors({});
    setV2Draft({
      key: runtimeFormV2Key,
      values: applyRuntimeFormV2Change(runtimeFormV2.form, runtimeFormV2.sources, v2Values, key, value),
    });
  }, [runtimeFormV2, v2Values, runtimeFormV2Key]);

  const runtimeFormV2Prop = useMemo(() => (!previewOnly && runtime ? {
    state: runtimeFormV2,
    values: v2Values,
    onChange: changeV2Value,
    serverErrors: v2ServerErrors,
  } : undefined), [previewOnly, runtime, runtimeFormV2, v2Values, changeV2Value, v2ServerErrors]);

  const runtimePickerRows = runtimeAdmissionOptions.flatMap((option): RuntimePickerRow[] => {
    const runtimeInfo = getRuntimeInfo(option.runtimeId);
    return runtimeInfo?.supported
      ? [{
          value: runtimeInfo.id,
          label: formatRuntimeLabelBesideBadge(runtimeInfo.id, formatMessage, option.admissionReason === "deprecated"),
          availabilitySuffix: formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtimeInfo, machineRuntimeIds), formatMessage),
          experimental: runtimeShowsExperimentalBadge(runtimeInfo.id, option.admissionReason === "deprecated"),
          disabled: !option.canSelectInThisContext,
          capabilityStatus: option.capabilityStatus,
          selectable: option.canSelectInThisContext,
        }]
      : [];
  });
  // Onboarding (Create Cindy) keeps its flat list: every runtime, the
  // undetected ones greyed out with "(not installed)" (see the panel below).
  const onboardingRuntimeOptions = flatRuntimePickerOptions(runtimePickerRows);
  // The regular form groups them by whether they can run on this Computer
  // right now; the not-installed ones only on request (Show All Supported,
  // the last row of the runtime list). The request belongs to the Computer it was made for:
  // picking another Computer starts collapsed again.
  const [showAllRuntimesFor, setShowAllRuntimesFor] = useState<string | null>(null);
  const showAllRuntimes = showAllRuntimesFor !== null && showAllRuntimesFor === selectedMachineId;
  const setShowAllRuntimes = useCallback(
    (showAll: boolean) => setShowAllRuntimesFor(showAll ? selectedMachineId : null),
    [selectedMachineId],
  );
  const runtimeComputerName = selectedMachine?.name ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const runtimePicker = groupRuntimePickerRows(runtimePickerRows, {
    showAll: showAllRuntimes,
    selectedValue: runtime,
    formatMessage,
  });
  const runtimeOptions = runtimePicker.options;
  const runtimeListAction = useRuntimeShowAllAction(runtimePicker.canToggle, showAllRuntimes, setShowAllRuntimes);
  const runtimeBelowDescription = (
    // Signed out is said, never enforced: Create stays as it is.
    <RuntimeSignInNotice
      serverId={currentServer?.id}
      machineId={selectedMachineId}
      machineName={runtimeComputerName}
      runtimeId={runtime}
      enabled={canViewMachineRuntimeAccountUsage(selectedMachine, currentUserId, capabilities)}
    />
  );

  const handleUpgradeToBilling = useCallback(() => {
    onClose();
    trackPaywallAction("seat_limit_agent_create", "view_billing");
    noteBillingEntry("seat_limit_agent_create");
    nav.toSettings("billing");
  }, [onClose, nav]);

  const openAddComputer = useAddThisComputer("create-agent");
  const handleConnectComputerClick = useCallback(() => { onClose(); openAddComputer(); }, [onClose, openAddComputer]);
  const needsCindy = useNeedsComputerCopy("agent.create.cindyNeedsComputerDescription"), needsAgent = useNeedsComputerCopy("agent.create.needsComputerDescription");

  const handleRescanRuntimes = useCallback(() => {
    if (!selectedMachineId) return;
    setRuntimesRescanning(true);
    void rescanRuntimes(selectedMachineId)
      .catch(() => undefined)
      // The fresh list lands on its own via the capabilities push; this
      // only stops the spinner, it is not "the answer arriving".
      .finally(() => setTimeout(() => setRuntimesRescanning(false), 1200));
  }, [selectedMachineId, rescanRuntimes]);

  const handleOnboardingStartOverClick = useCallback(() => {
    if (onOnboardingStartOver) void onOnboardingStartOver();
  }, [onOnboardingStartOver]);

  const handleOnboardingLaterClick = useCallback(() => {
    if (onOnboardingLater) void onOnboardingLater();
  }, [onOnboardingLater]);

  const handleMachineChange = useCallback((val: unknown) => {
    if (typeof val !== "string") return;
    setHostedSelected(val === HOSTED_COMPUTER_CHOICE);
    if (val === HOSTED_COMPUTER_CHOICE) return;
    setSelectedMachineId(val);
    setRuntime("");
  }, [setSelectedMachineId]);

  const reloadHostedModels = hostedModels.reload;
  const handleHostedModelsReload = useCallback(() => { void reloadHostedModels(); }, [reloadHostedModels]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (error) setError("");
  }, [error]);

  const handleRandomName = useCallback(() => {
    setName((current) => suggestAgentName([current, ...takenAgentNames()]));
    if (error) setError("");
  }, [error]);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
  }, []);

  const handleCloseEditProviderConnection = useCallback(() => {
    setEditingProviderConnection(null);
  }, []);

  const handleCompletedEditProviderConnection = useCallback(async () => {
    setEditingProviderConnection(null);
    await providerConnectionCatalog.refresh();
  }, [providerConnectionCatalog]);

  // One-shot prefill waiter: when the dialog opens with a `prefilledMachineId`
  // for an action-card-driven flow, the target machine may briefly be reported
  // as offline (machines list is socket-pushed). This effect waits for it to
  // come online and then seeds machine + dependent fields ONCE — gated by
  // `!selectedMachineId` so a user who's already picked anything is never
  // overridden. NOT a mirror-prop effect (the inputs are async-list events,
  // not props that should be reflected continuously); useState-initializer
  // refactor would require remounting on `online` flip and would lose user
  // input. Same FP family as PR #2524 / #2536's async-arrival pattern.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (selectedMachineId) return;
    // `selectedMachineId` is seeded from `machines` at mount. When the dialog
    // mounts before the machine list has loaded — which is the norm in the
    // onboarding setup gate, where it renders the moment the projection says
    // `create_agent` — that seed is "" and nothing ever re-ran it. The runtime
    // list is derived from the selected machine, so it stayed empty, every
    // runtime option was disabled, the onboarding panel (which shows only
    // selectable runtimes) rendered zero of them, and Create Cindy could never
    // be enabled. The waiter below already existed for the prefilled case; it
    // just never covered the plain "machines arrived late" one.
    const defaultMachine = defaultMachineId
      ? machines.find((m) =>
        m.id === defaultMachineId
        && m.status === "online"
        && machineMeetsDaemonRequirement(m, minimumDaemonVersion)
      )
      : undefined;
    const machine = prefilledMachineId
      ? machines.find((m) =>
        m.id === prefilledMachineId
        && machineMeetsDaemonRequirement(m, minimumDaemonVersion)
      )
      : defaultMachine
        ?? (rememberedConfig
          ? machines.find((m) =>
            m.id === rememberedConfig.machineId
            && m.status === "online"
            && machineMeetsDaemonRequirement(m, minimumDaemonVersion)
          )
          : undefined)
        ?? pickFallbackMachine(machines, minimumDaemonVersion, currentUserId);
    if (!machine || machine.status !== "online") return;
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setSelectedMachineId(machine.id);
    // oxlint-disable-next-line react-doctor/no-derived-state
    setRuntime("");
  }, [currentUserId, defaultMachineId, machines, minimumDaemonVersion, prefilledMachineId, rememberedConfig, selectedMachineId]);

  // Admission is server-owned and arrives after the raw machine capability list.
  // Keep an existing user choice only while the contextual catalog still admits
  // it; otherwise choose the first admitted capability for this create context.
  // This is an async-list reconciliation edge: the request cannot start until
  // the selected machine is known, and the resulting choice remains user-editable.
  // oxlint-disable-next-line react-doctor/no-effect-chain, react-doctor/no-cascading-set-state, react-doctor/no-pass-live-state-to-parent
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- local async-list reconciliation; this component owns both the catalog and editable draft
    if (!selectedMachineId || availableRuntimes.length === 0 || availableRuntimes.includes(runtime)) return;
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setRuntime(pickCreateAgentRuntime(
      availableRuntimes,
      supportedSet,
      onboarding,
      rememberedConfig,
    ));
  }, [
    availableRuntimes,
    onboarding,
    rememberedConfig,
    runtime,
    selectedMachineId,
    supportedSet,
  ]);

  const isExternalMode = external;
  // Neither an external nor a hosted agent runs on a computer: no computer, runtime or model fields.
  const skipsComputer = isExternalMode || isHostedMode;
  const plan = (currentServer?.plan || "free") as ServerPlan;
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  useEffect(() => {
    if (previewOnly) return;
    void loadBilling();
  }, [loadBilling, previewOnly]);
  const fallbackAgentCapacity = getEffectiveLimits(plan).maxAgents;
  const agentCapacity = billing?.capacity ?? { maxHumans: -1, maxAgents: fallbackAgentCapacity, maxUniversalSeats: -1 };
  const agentUsageState = billing?.usage ?? getBillingUsage(0, agents.length);
  const agentCapacityLimitState = getBillingCapacityLimitState(agentCapacity, agentUsageState, "agent");
  const atLimit = agentCapacityLimitState.reached;
  const limitLabel = getBillingCapacityLimitLabel("agent", agentCapacityLimitState.limitType);
  // Pro seats (task #10, behind pro_seat_add): for an owner, the line under the title
  // says how many are taken, and they add seats in place instead of meeting a
  // disabled Create. Admins and members keep the notice until they can ask an owner.
  // Not in the onboarding shell: its own form and notice stay as they are.
  const seatAddEnabled = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY).enabled;
  const seatCapacity = seatAddEnabled && billing?.capacity && billing.capacity.maxUniversalSeats !== -1 ? billing.capacity.maxUniversalSeats : null;
  // With the flag on, an owner adds seats here and anyone else asks an owner for
  // them (task #10); a member can't read billing, so only the refusal opens it.
  const seatsInPlace = seatAddEnabled && !onboarding;
  const asksOwner = !capabilities.manageBilling;
  const addsSeatsInPlace = seatCapacity !== null && seatsInPlace;
  const seatUsedTenths = seatTenths(billing?.usage?.humans ?? 0, billing?.usage?.agents ?? 0);
  const seatsShort = seatCapacity === null ? 0 : Math.max(0, Math.ceil((seatUsedTenths + 1) / PRO_AGENT_SEAT_BLOCK_SIZE) - seatCapacity);
  const seatDescription = !addsSeatsInPlace ? undefined : formatMessage(
    { id: seatsShort > 0 ? "agent.create.seatUsageFull" : "agent.create.seatUsage" },
    { used: formatNumber(seatsFromTenths(seatUsedTenths), { maximumFractionDigits: 1 }), seats: seatCapacity ?? 0, count: seatsShort },
  );
  const [seatNeed, setSeatNeed] = useState<AddSeatsNeed | null>(null);
  /** A member's numbers, from the server's refusal (they can't read billing). */
  const [seatUsage, setSeatUsage] = useState<SeatUsage | null>(null);
  // Set when the seats were just added: the resumed submit runs before this renders
  // the new billing, so it skips the seat check here (the server still checks).
  const resumingAfterSeats = useRef(false);
  // The seat-limit paywall: the at-limit notice, or the server's capacity refusal.
  // An owner who adds seats in place meets it in AddSeatsDialog, which counts it.
  usePaywallShown(((atLimit && !addsSeatsInPlace) || (Boolean(error) && isCapacityLimitError(error))) && "seat_limit_agent_create");
  // Lock name/description ONLY for the onboarding flow. Action-card-driven
  // prefill leaves the fields editable so the human can adjust whatever
  // the agent suggested (per stdrc 2026-05-10 #proj-approval msg=2f20e3a2:
  // "Create Agent 那个也可以编辑了").
  const nameLocked = onboarding;
  const descriptionLocked = onboarding;
  const lockedFieldClass = "border-line-hairline bg-fill-muted text-foreground-muted cursor-not-allowed";
  /**
   * One validator, two questions: "is this name usable?" and "should we say so
   * yet?" — previously conflated, which is why the empty case was unreachable.
   *
   * `validateAgentNameReason("")` returns `{ code: "required" }` and always has;
   * the old expression discarded it by testing `length > 0` first. With nothing
   * of our own to show, the browser's native `required` bubble was the only
   * feedback left — the orange popup in Cindy's screenshot, which no stylesheet
   * of ours can reach. It is not a separate error to author: same reason code,
   * same `validation.name.required` copy as everywhere else.
   */
  const nameValidationError = formatAgentNameValidationError(
    validateAgentNameReason(name),
    "agent.create.agentName",
    formatMessage,
  );
  /** What the FIELD shows. Gated exactly like every other field — "点击后才校验"
   *  (Cindy): before the first submit attempt the dialog says nothing, and after
   *  it every field reports live so a correction is confirmed as you type.
   *  Name deliberately does NOT keep a live-while-typing exception; being the one
   *  field that turns red on a different trigger from all the others is the kind
   *  of inconsistency nobody can explain to a user. */
  const inlineNameError = validationAttempted ? nameValidationError : null;
  /**
   * Field-level validation, gathered in one place.
   *
   * These deliberately do NOT disable Create Agent any more. A disabled button
   * cannot be clicked, and a validation that only ever fires on click can then
   * never fire — so the form went red on its own to say something, which is the
   * behaviour Cindy rejected. Disabling now means only "this form cannot be
   * submitted from this environment" (no computer, computer offline, runtime not
   * installed, at the agent limit) — conditions the user cannot fix by typing.
   *
   * Anything the user can fix by typing is checked HERE, on submit, and shown in
   * that field's own error slot. Nothing invalid reaches the API: `handleSubmit`
   * returns on this flag before any create call.
   */
  const fieldValidationBlocked = Boolean(nameValidationError) || (!skipsComputer && v2Malformed);

  const createDisabled =
    (atLimit && !addsSeatsInPlace) ||
    // An unavailable list still allows the default (no model is sent, nothing to check).
    (isHostedMode && (hostedModels.state.kind === "loading" || !name.trim())) ||
    (!skipsComputer && (
      !selectedMachineId ||
      (prefilledMachineMode === "required" && selectedMachineId !== prefilledMachineId) ||
      machines.length === 0 ||
      !runtime ||
      !supportedSet.has(runtime) ||
      !availableRuntimes.includes(runtime) ||
      selectedMachine?.status !== "online" ||
      !selectedMachineMeetsDaemonRequirement ||
      // The runtime form must be loaded, renderable and complete. The DEV-only
      // preview has no server form, so it is the one place this does not apply.
      (!previewOnly && (runtimeFormV2.status !== "ready" || v2MissingRequired)) ||
      // Mandatory-but-EMPTY. Not an error message — the button simply stays
      // disabled until the field has a value, and only then can its content be
      // judged. Malformed values are deliberately absent from this list: they
      // keep the button clickable so the click can report them.
      !name.trim()
    ));

  const handleSubmit = async (e: React.FormEvent) => {
    const seatsJustAdded = resumingAfterSeats.current;
    resumingAfterSeats.current = false;
    e.preventDefault();
    setError("");
    setSubmitting(true);
    // Mark the attempt BEFORE the early return, so the fields can speak even
    // though this handler stops here.
    setValidationAttempted(true);
    if (fieldValidationBlocked) {
      // Deliberately not `setError`: the dialog-level banner would repeat, word
      // for word, what the fields are already saying next to the inputs the user
      // has to fix — and with several fields invalid the banner could only name
      // one of them. Each field's own slot is where this belongs.
      setSubmitting(false);
      return;
    }
    if (!skipsComputer && !selectedMachineId) {
      setError(formatMessage({ id: "agent.create.selectComputerError" }));
      setSubmitting(false);
      return;
    }
    if (!skipsComputer && prefilledMachineMode === "required" && selectedMachineId !== prefilledMachineId) {
      setError(formatMessage({ id: "agent.create.actionCardRequiresComputer" }));
      setSubmitting(false);
      return;
    }
    if (!skipsComputer && minimumDaemonVersion && !selectedMachineMeetsDaemonRequirement) {
      setError(formatMessage({ id: "agent.create.minimumDaemonVersion" }, { version: minimumDaemonVersion }));
      setSubmitting(false);
      return;
    }
    if (!skipsComputer && !availableRuntimes.includes(runtime)) {
      setError(formatMessage({ id: "agent.create.runtimeNotInstalled" }));
      setSubmitting(false);
      return;
    }
    if (atLimit && addsSeatsInPlace && !seatsJustAdded) {
      // Out of seats: the owner adds them first, and the form submits again once they count.
      openAddSeats();
      setSubmitting(false);
      return;
    }
    // Funnel hook: fired AFTER client validation passes so we don't count
    // local form errors as attempts (the action card's `execute_attempt`, the
    // setup gate's `create_cindy`). Best-effort; no-op when nobody passes it.
    onSubmitStart?.();
    if (previewOnly) {
      setError(formatMessage({ id: "agent.create.previewOnlyCindy" }));
      setCreatedOnboardingAgent({ id: "preview-cindy", name: "Cindy" });
      setSubmitting(false);
      return;
    }
    // Capture "was this user's first agent?" BEFORE the create call mutates
    // agentStore — `agents` from the store will include the new agent after
    // success, so we have to snapshot the pre-create count here. Onboarding
    // flow is by construction first-agent territory too.
    const wasFirstAgent = onboarding || agents.length === 0;
    try {
      const avatarKey = onboarding ? "mug" : AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)];
      const reusedCreatedOnboardingAgent = Boolean(createdOnboardingAgent);
      const agent = createdOnboardingAgent ?? (isHostedMode
        ? await createAgent(name.trim(), {
            description: description.trim() || undefined,
            avatarUrl: `pixel:${avatarKey}`,
            external: true,
            provider: "antiproton",
            hostedModel,
            actionCardMessageId,
            actionCardConfirmationVersion,
          })
        : isExternalMode
        ? await createAgent(name.trim(), {
            description: description.trim() || undefined,
            avatarUrl: `pixel:${avatarKey}`,
            external: true,
            actionCardMessageId,
            actionCardConfirmationVersion,
          })
        : await (() => {
            // Create stays disabled until the form is ready; never create without it.
            if (runtimeFormV2.status !== "ready" || !v2Values) throw new Error("runtime form not ready");
            return createAgent(name.trim(), {
              description: description.trim() || undefined,
              runtime,
              // The rendered form's protocol (2, or 3 for runtime_form.v3); same formValues.
              formDefinitionRef: { protocolVersion: runtimeFormV2.form.protocolVersion, runtimeId: runtime },
              formValues: runtimeFormV2Submission(runtimeFormV2.form, v2Values, runtimeFormV2.sources),
              machineId: selectedMachineId,
              avatarUrl: `pixel:${avatarKey}`,
              onboarding,
              actionCardMessageId,
              actionCardConfirmationVersion,
            });
          })());
      if (remembersLastConfig && currentServer && !isHostedMode) {
        writeCreateAgentLastConfig(currentServer.id, {
          machineId: selectedMachineId,
          runtime,
        });
      }
      // Notify the action-card flow (if launched from one) so the card can
      // call /api/actions/:msgId/mark-executed with the new agent's ref.
      if (!reusedCreatedOnboardingAgent) {
        onCreated?.({ id: agent.id, name: agent.name });
      }
      if (onboarding) {
        if (!currentServer) {
          setError(formatMessage({ id: "agent.create.cindyNoActiveServer" }));
          setCreatedOnboardingAgent(agent);
          setSubmitting(false);
          return;
        }
        try {
          const { data } = await api.post<ServerSetupProjection>(`/servers/${currentServer.id}/setup-transition`, { action: "complete" });
          if (data.surface !== "complete") {
            setError(formatMessage({ id: "agent.create.cindySetupIncomplete" }));
            setCreatedOnboardingAgent(agent);
            setSubmitting(false);
            return;
          }
          onOnboardingComplete?.();
        } catch (completeError: unknown) {
          setError(onboardingCompleteErrorMessage(formatMessage, completeError));
          setCreatedOnboardingAgent(agent);
          setSubmitting(false);
          return;
        }
      }
      // Post-create landing (cindyz 2026-05-26 dm msg=f342577e, superseding "always jump to the new agent's DM"):
      //   - stayOnCreate (a channel's add-members create joins the agent there) → stay; the parent uses onCreated
      //   - external agent → /agent/:id: its runtime setup guide is the next required step
      //   - via action card → stay on the card (a chat surface; jumping away breaks the guided flow)
      //   - first agent (none yet, OR onboarding) → #onboarding-owner / #all (none resolvable → stay)
      //   - otherwise (the sidebar's Agents +, the Members page, a Computer) → stay, and once the dialog has
      //     closed a "Created <name>" toast whose View opens its DM and profile (#triage:abdb39d9, cindyz
      //     2026-11-12; supersedes the 2026-05-26 plain "stay" for these)
      const toastCreated = !stayOnCreate && !isExternalMode && !fromActionCard && !wasFirstAgent;
      if (stayOnCreate) {
        // Parent-managed flows keep the parent dialog in place
        // and use onCreated to capture the new agent.
      } else if (isExternalMode) {
        try {
          nav.toAgent(agent.id);
        } catch {
          // ignore — surface remains on whatever the user was looking at
        }
      } else if (!fromActionCard && wasFirstAgent && onboardingShell !== "page") {
        const landing = channels.find((c) => c.name === "onboarding-owner")
          ?? channels.find((c) => c.name === "all");
        if (landing) {
          try {
            nav.toChannel(landing.id);
          } catch {
            // ignore — surface remains on whatever the user was looking at
          }
        }
      }
      onClose();
      if (toastCreated) showCreatedAgentToast(agent, formatMessage, nav);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string; code?: string; capacityLimit?: CapacityLimitDetail; issues?: Array<{ code?: string; pointer?: string }> } } };
      const refusal = axiosErr.response?.data?.capacityLimit;
      if (seatsInPlace && axiosErr.response?.data?.code === AGENT_LIMIT_REACHED_CODE && refusal?.limitType === "universal") {
        // The seats ran out after billing was read (someone else took the last
        // one), or this viewer can't read billing: open it now, with the
        // refusal's numbers for someone who can't read billing.
        if (capabilities.manageBilling) await loadBilling();
        openAddSeats(billing ? null : { seats: refusal.limit, humans: refusal.humans, agents: refusal.agents });
        setSubmitting(false);
        return;
      }
      if (!skipsComputer) {
        // v2 issues point at /formValues/<field>: show them beside the field.
        const fieldErrors: Record<string, string> = {};
        for (const issue of axiosErr.response?.data?.issues ?? []) {
          const key = issue.pointer?.startsWith("/formValues/") ? issue.pointer.slice("/formValues/".length) : "";
          if (key) fieldErrors[key] = axiosErr.response?.data?.error ?? issue.code ?? "";
        }
        setV2ServerErrors(fieldErrors);
      }
      setError(axiosErr.response?.data?.error || formatMessage({ id: "agent.create.failedCreate" }));
      setSubmitting(false);
      // Funnel hook: dialog-driven `execute_fail`. The dialog stays open
      // so the user can retry; we record the funnel event regardless.
      onSubmitError?.(err);
    }
  };
  function openAddSeats(usage: SeatUsage | null = null) {
    const agentName = name.trim();
    const seats = usage?.seats ?? seatCapacity ?? 0;
    const short = usage ? Math.max(1, Math.ceil((seatTenths(usage.humans, usage.agents) + 1) / PRO_AGENT_SEAT_BLOCK_SIZE) - usage.seats) : Math.max(1, seatsShort);
    setSeatUsage(usage);
    setSeatNeed({
      tenths: 1,
      label: formatMessage({ id: "addSeats.createAgent.label" }, { name: agentName }),
      title: formatMessage({ id: "addSeats.createAgent.title" }, { name: agentName, count: short }),
      hint: formatMessage({ id: asksOwner ? "addSeats.askHint" : "addSeats.createAgent.hint" }, { name: agentName, seats, server: currentServer?.name ?? "" }),
      resume: formatMessage({ id: "addSeats.createAgent.resume" }, { name: agentName }),
      gate: "seat_limit_agent_create",
    });
  }
  const closeAddSeats = useCallback(() => setSeatNeed(null), []);
  // An admin or member asks an owner; once added, they create it from this form.
  const agentSeatAsk = useMemo(() => (asksOwner ? {
    purpose: { kind: "agent:create" as const, name: name.trim() },
    ...(seatUsage ? { usage: seatUsage } : {}),
  } : undefined), [asksOwner, name, seatUsage]);
  // The seats count now (billing has the new number), so the form goes through.
  const handleSeatsAdded = useCallback(() => {
    setSeatNeed(null);
    resumingAfterSeats.current = true;
    createAgentSelectPortalRef.current?.requestSubmit();
  }, []);
  const dialogTitle = isExternalMode
    ? formatMessage({ id: "agent.create.dialogTitleExternal" })
    : onboarding
      ? formatMessage({ id: "agent.create.dialogTitleOnboarding" })
      : formatMessage({ id: "agent.create.dialogTitle" });
  const submitLabel = formatMessage({ id: "agent.create.submitCreateAgent" });

  if (onboarding) {
    const formId = "create-cindy-onboarding-form";
    const content = (
      <CreateCindyFrame modal={onboardingShell === "modal"} onClose={onClose} portalRef={cindyRuntimeSelectPortalRef} className="w-full max-w-[calc(100vw-1rem)] md:max-w-[960px] md:h-[min(720px,calc(100dvh-2rem))] md:min-h-0">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line-seam px-6 pb-4 pt-6 sm:px-9">
          <div className="min-w-0">
            <SectionEyebrow as="div">
              {formatMessage({ id: "agent.create.setupServer" })}
            </SectionEyebrow>
            <h1 className="mt-1 text-title">{formatMessage({ id: "agent.create.meetCindy" })}</h1>
          </div>
          {/* Opened from the members panel this is an ordinary dialog, and an ordinary
              dialog can be closed. Inside the setup gate ("step" and "page" shells)
              the step is mandatory and carries its own Later, so no X there.

              Left on `variant="default"` deliberately, unlike the dialog shell's X.
              Reached from a hosted Cindy's DM banner (HostedCindyFailedBanner): when
              she could not start, this dialog connects a computer and converts her
              into a computer Cindy in place. */}
          {onboardingShell !== "modal" ? null : (
            <CloseButton
              type="button"
              onClick={onClose}


              className={`shrink-0 ${ICON_SM_END_PULL}`}
              aria-label={formatMessage({ id: "common.close" })}
            >
              <X size={20} />
            </CloseButton>
          )}
        </header>

        <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col md:min-h-0 md:flex-1 md:overflow-hidden">
          <div className="flex flex-col gap-0 md:grid md:grid-cols-[0.95fr_1.05fr] md:min-h-0 md:flex-1 md:overflow-hidden">
            <div className={`${SETUP_PAPER} flex flex-col border-b border-line-seam px-8 py-5 text-foreground md:min-h-0 md:justify-center md:border-b-0 md:border-r md:py-8`}>
              <div className={SETUP_PAPER_DOT_GRID} aria-hidden="true" />
              <div className={`${SETUP_STICKER_CARD} mx-auto flex w-full max-w-[320px] rotate-[-1.5deg] flex-col items-center px-6 pb-6 pt-7 text-center`}>
                <div className="relative mb-3 md:mb-5" data-testid="cindy-avatar-entrance">
                  <span className="onboarding-cindy-pop-mark absolute -right-5 top-1 size-3 rotate-12 rounded-[2px] border-[1.5px] border-sticker-ink bg-success" aria-hidden="true" />
                  <span className="onboarding-cindy-pop-mark absolute -left-5 top-8 size-2.5 -rotate-12 rounded-[2px] border-[1.5px] border-sticker-ink bg-sticker-paper [animation-delay:70ms]" aria-hidden="true" />
                  {/* Cindy is the onboarding hero: the DS xl sticker (99, hard
                      brand-art shadow) at every width. */}
                  <AvatarSlot context="profile-hero" type="agent" agentAvatarUrl="pixel:mug" className="onboarding-cindy-entrance z-raised" />
                </div>
                <h2 className="text-title md:text-display">
                  {formatMessage({ id: "agent.create.cindyName" })}
                </h2>
                {/* No role badge under the name: the blurb says what she does for you. */}
                <p className="mt-2 text-callout font-medium text-foreground-muted md:mt-3 md:text-body">
                  {formatMessage({ id: "agent.create.cindyHeroDescription" })}
                </p>
              </div>
            </div>

            <ScrollArea className="max-h-[min(70dvh,calc(100dvh-12rem))] md:max-h-none md:min-h-0" contentClassName="px-6 py-6 md:px-8">
              {atLimit && (
                <Banner status="warning" className="mb-4">
                  <BannerDescription>
                    {formatMessage(
                      { id: "agent.create.capacityReached" },
                      {
                        limitLabel,
                        usage: agentCapacityLimitState.usage,
                        limit: agentCapacityLimitState.limit,
                        planName: PLAN_CONFIG[(billing?.plan || plan) as ServerPlan].displayName,
                        upgrade: (chunks) => (
                          <TextLink
                            key="upgrade"
                            variant="strong"
                            onClick={handleUpgradeToBilling}
                          >
                            {chunks}
                          </TextLink>
                        ),
                      },
                    )}
                  </BannerDescription>
                </Banner>
              )}
              {error && !atLimit && (
                <Banner status="warning" className="mb-4">
                  <BannerDescription>
                    {error}
                  </BannerDescription>
                </Banner>
              )}

              {/* No computer, no runtime question. Asking someone to pick a runtime and a
                  model for a machine that does not exist is asking them to configure thin
                  air: every option is dead, nothing they choose can be checked, and the one
                  thing they actually need to do is not on the screen. So we say what is
                  missing and offer the action that fixes it. */}
              {machines.length === 0 ? (
                <Banner status="info" data-testid="create-cindy-needs-computer">
                  <BannerTitle>{formatMessage({ id: needsCindy.title })}</BannerTitle>
                  <BannerDescription>
                    {formatMessage({ id: needsCindy.description })}
                  </BannerDescription>
                  {/* The action button is `default`, not `accent`. I had used accent to
                      match the dialog shell's equivalent action; @cindyz ruled default
                      (2026-08-29). An action inside a Banner is not the screen's primary
                      — the footer's Create Cindy is — so it must not carry accent weight. */}
                  <BannerAction>
                    <Button
                      type="button"
                      onClick={handleConnectComputerClick}
                      variant="default"
                      size="md"
                    >
                      {formatMessage({ id: needsCindy.action })}
                    </Button>
                  </BannerAction>
                </Banner>
              ) : (
              <div className="stack-y-3">
                <RuntimeConfigFields
                  showValidationErrors={validationAttempted}
                  // The same v2 form as a normal create: its technical fields sit
                  // in the collapsed Advanced section (task #8).
                  runtimeFormV2={runtimeFormV2Prop}
                  runtime={runtime}
                  onRuntimeChange={setRuntime}
                  // Show every runtime, greying out the ones we did not detect (they
                  // carry a "(not installed)" suffix). Hiding them meant a user who
                  // simply forgot to install their tool saw no trace of it — and when
                  // nothing was detected at all, an empty list with no explanation.
                  runtimeOptions={onboardingRuntimeOptions}
                  runtimeLabel={formatMessage({ id: "agent.runtimeConfig.runtime" })}
                  reserveRuntimeMessage={false}
                  runtimesRescanning={runtimesRescanning}
                  onRescanRuntimes={selectedMachineId ? handleRescanRuntimes : undefined}
                  selectPortalContainer={cindyRuntimeSelectPortalRef}
                />
              </div>
              )}
              {/*
                The way back lives with the CONTENT, not in the button bar (@stdrc). Someone
                gets all the way to this form and only here realises they connected the wrong
                machine — the laptop with no Claude Code on it. That realisation happens while
                they are reading the runtime they just picked, so the door belongs beside it,
                not parked next to the button that commits them.
                Creating Cindy is the point of no return; until that click, "start over" is
                honest, and it is the only thing that helps them.
              */}
              {onOnboardingStartOver ? (
                // The description says WHEN this door is for — someone who has connected a
                // computer they won't actually keep running agents on (a borrowed laptop, the
                // machine without Claude Code, the wrong one of two). Only "Start over" is the
                // clickable part; the sentence around it is plain guidance, not a button.
                <div className="mt-6 flex flex-wrap items-baseline gap-x-1 text-callout text-foreground-muted">
                  <span data-testid="create-agent-start-over-description">
                    {formatMessage({ id: "agent.create.notYourComputer" })}
                  </span>
                  <TextLink
                    variant="strong"
                    onClick={handleOnboardingStartOverClick}
                    disabled={submitting}
                    data-testid="create-agent-start-over"
                  >
                    {formatMessage({ id: "agent.create.startOver" })}
                  </TextLink>
                  <span>{formatMessage({ id: "agent.create.connectDifferentOne" })}</span>
                </div>
              ) : null}
            </ScrollArea>
          </div>
          <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-line-seam px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-9">
            {onboarding ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SetupSessionFooter disabled={submitting} showServerSettings />
                {onOnboardingLater ? (
                  <TextLink
                    onClick={handleOnboardingLaterClick}
                    disabled={submitting}
                  >
                    {formatMessage({ id: "agent.create.setupMyself" })}
                  </TextLink>
                ) : null}
              </div>
            ) : <span aria-hidden="true" />}
            <Button
              type="submit"
              form={formId}
              disabled={createDisabled || submitting}
              variant="accent"
              size="lg"
              className="w-full sm:w-auto"
            >
              {submitting
                ? (createdOnboardingAgent
                    ? formatMessage({ id: "agent.create.finishing" })
                    : formatMessage({ id: "agent.create.creating" }))
                : createdOnboardingAgent
                  ? formatMessage({ id: "agent.create.finishSetup" })
                  : formatMessage({ id: "agent.create.createCindy" })}
            </Button>
          </footer>
        </form>
      </CreateCindyFrame>
    );
    return content;
  }

  // An agent runs on a computer. With none connected there is nothing to configure and
  // nothing to create: every field below would be dead, and the one action that unblocks
  // them is not on this screen. Ask for the computer instead (stdrc, 2026-07-13).
  if (!isExternalMode && machines.length === 0 && !hostedRuntimeProvider.available) {
    return (
      <DialogCard title={dialogTitle} onClose={onClose} testId="create-agent-needs-computer">
        <Banner status="info">
          <BannerTitle>{formatMessage({ id: needsAgent.title })}</BannerTitle>
          <BannerDescription>
            {formatMessage({ id: needsAgent.description })}
          </BannerDescription>
        </Banner>

        <DialogCardFooter className="mt-4">
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <Button
            type="button"
            onClick={handleConnectComputerClick}
            variant="primary"
            size="lg"
          >
            {formatMessage({ id: needsAgent.action })}
          </Button>
        </DialogCardFooter>
      </DialogCard>
    );
  }

  return (
    <>
      <DialogCard title={dialogTitle} description={seatDescription} onClose={onClose} testId="create-agent-dialog" narrow="sheet">
        {/* `stack-y-1` (4px) since 2026-09-03 (@cindyz): StableField already
            reserves a message row under every field, so the gap between fields
            is paying for space the row has already bought. The reasoning for
            never using 16px still stands verbatim: with every field now holding
            a 16px message row open whether or not it has anything to say, a 16px gap
            on top of it read as too airy — measured 36–38px
            from one control to the next label. This is the safe lever: the reserved
            row itself cannot shrink below the 16px a line of help text occupies
            without bringing back the layout jump it exists to prevent. 8px between fields
            still reads as 28px / 30px control-to-label, because that 16px row sits
            inside the gap — the token alone would have been misleading, which is why
            12px and 8px were compared as rendered screenshots before choosing.
            RuntimeConfigFields renders its fields as direct children of this form,
            so one class governs the whole rhythm; Agent Details has its own
            container and is untouched. */}
        <form ref={createAgentSelectPortalRef} noValidate onSubmit={handleSubmit} className="stack-y-1">
          {/* The add-members entry promised "joins #channel after creation";
              that promise must not vanish once this dialog covers the entry
              (task #584). Plain persistent line, not a Banner — it is context,
              not a warning, and it stays until submit. */}
          {autoJoinChannelName && (
            <p
              className="rounded-container bg-info-soft px-3 py-2 text-footnote font-semibold text-foreground"
              data-testid="create-agent-channel-context"
            >
              {formatMessage(
                { id: "agent.create.autoJoinChannel" },
                { channel: `#${autoJoinChannelName}` },
              )}
            </p>
          )}
          {/*
            * An action inside a Banner's TEXT is a `TextLink variant="strong"`.
            *
            * Every Button size is a CONTROL size — `md` is `h-8` plus
            * horizontal padding — so in a sentence it renders as a short box
            * beside the text: a gap on its left, the banner ~8px taller, and a
            * wrap onto its own line once width gets tight. A TextLink has no
            * box: it is a word in a line of text that happens to be clickable.
            * This is what Create Agent shipped before, and a screenshot does
            * not show it until the viewport is narrow enough to trigger the wrap.
            *
            * An action that wants real button chrome is not inline text — it
            * belongs in `<BannerAction>`, which lays out right-aligned and keeps
            * the button on one line while the description wraps.
            *
            * @cindyz reviewed the five placements on 2026-08-29
            * (#wg-design-exp:20aaae68): inline is the correct usage here;
            * anything else about Banner is fixed in raft-ui, not at callsites.
            */}
          {atLimit && !addsSeatsInPlace && (
            <Banner status="warning">
              <BannerDescription>
                {formatMessage(
                  { id: "agent.create.capacityReached" },
                  {
                    limitLabel,
                    usage: agentCapacityLimitState.usage,
                    limit: agentCapacityLimitState.limit,
                    planName: PLAN_CONFIG[(billing?.plan || plan) as ServerPlan].displayName,
                    upgrade: (chunks) => (
                      <TextLink
                        key="upgrade"
                        variant="strong"
                        onClick={handleUpgradeToBilling}
                      >
                        {chunks}
                      </TextLink>
                    ),
                  },
                )}
              </BannerDescription>
            </Banner>
          )}
          {error && !atLimit && (
            <Banner status="warning">
              <BannerDescription>
                {error}
                {isCapacityLimitError(error) && (
                  <>
                    {" "}
                    <TextLink
                      variant="strong"
                      onClick={handleUpgradeToBilling}
                    >
                      {formatMessage({ id: "agent.create.viewPlans" })}
                    </TextLink>
                  </>
                )}
              </BannerDescription>
            </Banner>
          )}
          {!isExternalMode && (
            <StableField label={formatMessage({ id: "agent.create.computer" })} required>
              {/* The zero-computer case never reaches here: it is answered above, with the
                  action that fixes it, instead of a grey box stating the problem. */}
              {(
                <Select
                  chrome="field"
                  value={isHostedMode ? HOSTED_COMPUTER_CHOICE : selectedMachineId}
                  onValueChange={handleMachineChange}
                  items={computerOptions}
                >
                  <FieldSelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.create.selectPlaceholder" })} />
                    <SelectIcon />
                  </FieldSelectTrigger>
                  <SelectContent portalProps={createAgentSelectPortalProps}>
                    <SelectList>
                      {renderSelectItems(computerOptions)}
                    </SelectList>
                  </SelectContent>
                </Select>
              )}
              {minimumDaemonVersion && !isHostedMode && (
                <p className="mt-1 text-caption text-foreground-hint">
                  {formatMessage(
                    { id: "agent.create.requiresDaemon" },
                    { version: minimumDaemonVersion },
                  )}
                </p>
              )}
              {prefilledMachineMode === "required" ? (
                <p className="mt-1 text-caption text-foreground-hint">
                  {prefilledMachine?.name
                    ? formatMessage(
                        { id: "agent.create.requiredByActionCardNamed" },
                        { name: prefilledMachine.name },
                      )
                    : formatMessage({ id: "agent.create.requiredByActionCard" })}
                </p>
              ) : prefilledMachineId ? (
                <p className="mt-1 text-caption text-foreground-hint">
                  {prefilledMachineOnline
                    ? formatMessage({ id: "agent.create.suggestedByActionCard" })
                    : formatMessage({ id: "agent.create.suggestedComputerUnavailable" })}
                </p>
              ) : null}
            </StableField>
          )}

          <StableField
            label={formatMessage({ id: "agent.create.name" })}
            required
            hint={
              nameLocked
                ? onboarding
                  ? formatMessage({ id: "agent.create.fixedForOnboarding" })
                  : formatMessage({ id: "agent.create.prefilledByActionCard" })
                : undefined
            }
            error={inlineNameError}
            htmlFor="create-agent-name"
            labelAccessory={nameLocked ? undefined : (
              <Tooltip content={formatMessage({ id: "agent.create.randomName" })}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-md"
                  className="ml-auto"
                  onClick={handleRandomName}
                  aria-label={formatMessage({ id: "agent.create.randomName" })}
                  data-testid="create-agent-random-name"
                >
                  <Dices size={12} aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
          >
            <Input
              id="create-agent-name"
              type="text"
              value={name}
              onChange={handleNameChange}
              className={`w-full ${nameLocked ? lockedFieldClass : ""}`}
              placeholder={formatMessage({ id: "agent.create.namePlaceholder" })}
              required
              readOnly={nameLocked}
            />
          </StableField>
          {/* E-state (task #1139): the @-strip is the ONE place we modify what
              the user typed, and that ruling passed on the condition that we
              say so. The caller composes the note because only it saw the
              original search text. */}
          {prefilledNameNote && (
            <p className="text-caption text-foreground-hint" data-testid="create-agent-prefill-note">
              {prefilledNameNote}
            </p>
          )}
          <StableField
            label={formatMessage({ id: "agent.create.description" })}
            // The counter goes through FormField's helper row rather than being an
            // extra child after the control. As a loose child it added its own
            // margin on top of the field's spacing, making the gap to the next
            // field 36px where every other gap is 16px; in the helper slot it
            // occupies the same row a hint or error would, so the field's
            // footprint matches any other hinted field.
            counter={descriptionLocked ? undefined : `${description.length}/${MAX_AGENT_DESCRIPTION_LENGTH}`}
          >
            <Textarea
              value={description}
              onChange={handleDescriptionChange}
              className={`w-full ${descriptionLocked ? lockedFieldClass : ""}`}
              placeholder={formatMessage({ id: "agent.create.descriptionPlaceholder" })}
              rows={3}
              maxLength={MAX_AGENT_DESCRIPTION_LENGTH}
              readOnly={descriptionLocked}
            />
            {descriptionLocked ? (
              <div className="mt-1 text-caption text-foreground-hint">
                {onboarding
                  ? formatMessage({ id: "agent.create.fixedForOnboarding" })
                  : formatMessage({ id: "agent.create.prefilledByActionCard" })}
              </div>
            ) : null}
          </StableField>
          {isHostedMode && hostedModelPickerShown(hostedModelsView) && (
            <StableField label={formatMessage({ id: "agent.detail.hostedModel.title" })}>
              <HostedModelChoice
                state={hostedModels.state}
                value={hostedModel}
                onChange={setHostedModelPick}
                onReload={handleHostedModelsReload}
                testId="create-agent-hosted-model"
              />
            </StableField>
          )}
          {!skipsComputer && selectedMachineId && (
            <>
            <RuntimeConfigFields
              showValidationErrors={validationAttempted}
              runtimeFormV2={runtimeFormV2Prop}
              runtime={runtime}
              onRuntimeChange={setRuntime}
              runtimeOptions={runtimeOptions}
              runtimeBelowDescription={runtimeBelowDescription}
              runtimeListAction={runtimeListAction}
              providerConnections={providerConnectionCatalog.connections}
              onEditProviderConnection={capabilities.manageExternalAuth ? setEditingProviderConnection : undefined}
              selectPortalContainer={createAgentSelectPortalRef}
            />
            </>
          )}

          <DialogCardFooter>
            <Button
              type="button"
              onClick={onClose}
              variant="ghost"
              size="lg"
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <DialogCommit>
              {(inHead) => (
                <Button
                  type="submit"
                  disabled={createDisabled}
                  variant="primary"
                  size={inHead ? "md" : "lg"}
                >
                  {submitLabel}
                </Button>
              )}
            </DialogCommit>
          </DialogCardFooter>
        </form>
        {/* Opened from the runtime fields' provider picker: inside this dialog's tree (outside the form, so its submit
            doesn't reach this one), so raft-ui stacks it over the card and Esc closes only it. */}
        {editingProviderConnection && (
          <EditProviderConnectionModal
            key={editingProviderConnection.id}
            connection={editingProviderConnection}
            providerOptions={providerConnectionCatalog.providerOptions}
            onClose={handleCloseEditProviderConnection}
            onCompleted={handleCompletedEditProviderConnection}
          />
        )}
      </DialogCard>
      {seatNeed ? (
        <AddSeatsDialog
          need={seatNeed}
          onClose={closeAddSeats}
          onAdded={handleSeatsAdded}
          ask={agentSeatAsk}
          onSent={onClose}
        />
      ) : null}
    </>
  );
}
