import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { X } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectValue,
  Textarea,
} from "raft-ui";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import { bothComputerVersionsKnown, isDaemonOutdated, validateAgentNameReason, getCreatableRuntimeOptions, runtimeAvailabilitySuffix, getDefaultModel, REASONING_EFFORT_RUNTIMES, PLAN_CONFIG, getBillingCapacityLimitLabel, getBillingCapacityLimitState, getBillingUsage, getEffectiveLimits } from "@botiverse/raft-shared";
import { formatAgentNameValidationError } from "../../i18n/nameValidation";
import { formatRuntimeConfigBuildError } from "../../utils/runtimeConfigBuildErrorPresentation";
import type { ResolvedAgentCreateFormDefinition, RuntimeConfig, RuntimeReasoningEffort, RuntimeFormDefinitionRef, RuntimeModelInfo, RuntimeSelectionOption, ServerPlan } from "@botiverse/raft-shared";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { runtimeModelSelectionIsRunnable, useRuntimeModels } from "../../hooks/useRuntimeModels";
import type { RuntimeModelSourceState } from "../../hooks/useRuntimeModels";

import { useNewAgentRuntimeOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { runtimeFormDefinitionRefKey, useRuntimeFormDefinitionCatalog } from "../../hooks/useRuntimeFormDefinition";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import Modal from "../Modal";
import DialogCard from "../ui/DialogCard";
import PixelAvatar, { AVATAR_KEYS } from "./PixelAvatar";
import RuntimeConfigFields from "./RuntimeConfigFields";
import StableField, { FieldSelectTrigger } from "./StableField";
import TextLink from "../ui/TextLink";
import SetupSessionFooter from "../onboarding/SetupSessionFooter";
import {
  buildRuntimeConfig,
  BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID,
  PI_PROVIDER_CONFIGURED,
  RuntimeConfigBuildError,
  builtInProviderDefaultModel,
  isBuiltInGatewayProviderMode,
  piBuiltinProviderDefaultModel,
  runtimeIgnoresModel,
  supportsRuntimeApiUrl,
  supportsRuntimeBuiltInProvider,
  supportsRuntimeCustomModelName,
  supportsRuntimePiProvider,
} from "../../utils/runtimeConfigForm";
import type {
  BuiltInProviderMode,
  PiProviderMode,
  RuntimeProviderMode,
} from "../../utils/runtimeConfigForm";
import { reconcileReasoningEffort } from "../../utils/reasoningEffortOptions";
import {
  readCreateAgentLastConfig,
  writeCreateAgentLastConfig,
} from "../../utils/createAgentLastConfig";
import type {
  CreateAgentLastConfig,
} from "../../utils/createAgentLastConfig";
import { buildConnectionDrivenBuiltInConfig, buildSchemaDrivenBuiltInConfig, buildSchemaDrivenKimiConfig } from "../../utils/schemaRuntimeConfigForm";

const MAX_AGENT_DESCRIPTION_LENGTH = 3000;

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

function isQuotaError(error: string): boolean {
  return error.includes("limit reached");
}

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

const EMPTY_RUNTIME_SELECTION_OPTIONS: readonly RuntimeSelectionOption[] = [];

function machineMeetsDaemonRequirement(
  machine: Machine | undefined,
  minimumDaemonVersion: string | undefined,
): boolean {
  return !!machine
    && (
      !minimumDaemonVersion
      || (
        bothComputerVersionsKnown(machine.daemonVersion, minimumDaemonVersion)
        && !isDaemonOutdated(machine.daemonVersion, minimumDaemonVersion)
      )
    );
}

function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

function OnboardingCreateCindyRuntimePanel({
  runtime,
  onRuntimeChange,
  runtimeOptions,
  model,
  onModelChange,
  customModelMode,
  onCustomModelModeChange,
  modelOptions,
  runtimeModels,
  providerMode,
  onProviderModeChange,
  providerApiUrl,
  onProviderApiUrlChange,
  providerApiKey,
  onProviderApiKeyChange,
  builtInProviderMode,
  onBuiltInProviderModeChange,
  builtInProviderApiKey,
  onBuiltInProviderApiKeyChange,
  builtInProviderBaseUrl,
  onBuiltInProviderBaseUrlChange,
  builtInProviderSupportsImageInput,
  onBuiltInProviderSupportsImageInputChange,
  piProviderMode,
  onPiProviderModeChange,
  piProviderApiKey,
  onPiProviderApiKeyChange,
  fastMode,
  onFastModeChange,
  command,
  onCommandChange,
  reasoningEffort,
  onReasoningEffortChange,
  selectedModelSuggestionOnly,
  advancedOpen,
  onAdvancedOpenChange,
  onRescanRuntimes,
  runtimesRescanning,
  selectPortalContainer,
  schemaBacked,
  formDefinition,
  formDefinitionLoading,
  formDefinitionError,
  formDefinitionErrorCode,
  showValidationErrors,
}: {
  runtime: string;
  onRuntimeChange: (runtime: string) => void;
  runtimeOptions: SelectOption[];
  model: string;
  onModelChange: (model: string) => void;
  customModelMode: boolean;
  onCustomModelModeChange: (enabled: boolean) => void;
  modelOptions: SelectOption[];
  runtimeModels: { source: RuntimeModelSourceState; models: RuntimeModelInfo[]; loading: boolean; rescan: () => void };
  providerMode: RuntimeProviderMode;
  onProviderModeChange: (mode: RuntimeProviderMode) => void;
  providerApiUrl: string;
  onProviderApiUrlChange: (value: string) => void;
  providerApiKey: string;
  onProviderApiKeyChange: (value: string) => void;
  builtInProviderMode: BuiltInProviderMode;
  onBuiltInProviderModeChange: (mode: BuiltInProviderMode) => void;
  builtInProviderApiKey: string;
  onBuiltInProviderApiKeyChange: (value: string) => void;
  builtInProviderBaseUrl: string;
  onBuiltInProviderBaseUrlChange: (value: string) => void;
  builtInProviderSupportsImageInput: boolean;
  onBuiltInProviderSupportsImageInputChange: (enabled: boolean) => void;
  piProviderMode: PiProviderMode;
  onPiProviderModeChange: (mode: PiProviderMode) => void;
  piProviderApiKey: string;
  onPiProviderApiKeyChange: (value: string) => void;
  fastMode: boolean;
  onFastModeChange: (enabled: boolean) => void;
  command: string;
  onCommandChange: (command: string) => void;
  reasoningEffort: RuntimeReasoningEffort | null;
  onReasoningEffortChange: (effort: RuntimeReasoningEffort | null) => void;
  selectedModelSuggestionOnly: boolean;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onRescanRuntimes?: () => void;
  runtimesRescanning?: boolean;
  /**
   * Portal target for the Runs on / Model select popovers. In the Create Cindy
   * onboarding flow the panel renders inside a `<Modal layer={1}>` (z-[60]); a
   * body-level portal (the default) lands under that layer and the popovers
   * become invisible/unclickable. Threading a container inside the modal keeps
   * the popovers in the modal's stacking context. Mirrors AgentDetailPanel's
   * runtime-edit modal. Optional so non-modal callers keep the body portal.
   */
  selectPortalContainer?: RefObject<HTMLElement | null>;
  schemaBacked: boolean;
  formDefinition: ResolvedAgentCreateFormDefinition | null;
  formDefinitionLoading: boolean;
  formDefinitionError: boolean;
  formDefinitionErrorCode?: string;
  /** Forwarded straight through; see RuntimeConfigFields. Not defaulted here —
   *  the onboarding panel has exactly one caller, and a default would let a
   *  second one silently get the un-gated behaviour. */
  showValidationErrors: boolean;
}) {
  const { formatMessage } = useIntl();

  return (
    <div className="space-y-3">
      <RuntimeConfigFields
        showValidationErrors={showValidationErrors}
        runtime={runtime}
        onRuntimeChange={onRuntimeChange}
        runtimeOptions={runtimeOptions}
        model={model}
        onModelChange={onModelChange}
        customModelMode={customModelMode}
        onCustomModelModeChange={onCustomModelModeChange}
        modelOptions={modelOptions}
        runtimeModels={runtimeModels}
        providerMode={providerMode}
        onProviderModeChange={onProviderModeChange}
        providerApiUrl={providerApiUrl}
        onProviderApiUrlChange={onProviderApiUrlChange}
        providerApiKey={providerApiKey}
        onProviderApiKeyChange={onProviderApiKeyChange}
        builtInProviderMode={builtInProviderMode}
        onBuiltInProviderModeChange={onBuiltInProviderModeChange}
        builtInProviderApiKey={builtInProviderApiKey}
        onBuiltInProviderApiKeyChange={onBuiltInProviderApiKeyChange}
        builtInProviderBaseUrl={builtInProviderBaseUrl}
        onBuiltInProviderBaseUrlChange={onBuiltInProviderBaseUrlChange}
        builtInProviderSupportsImageInput={builtInProviderSupportsImageInput}
        onBuiltInProviderSupportsImageInputChange={onBuiltInProviderSupportsImageInputChange}
        piProviderMode={piProviderMode}
        onPiProviderModeChange={onPiProviderModeChange}
        piProviderApiKey={piProviderApiKey}
        onPiProviderApiKeyChange={onPiProviderApiKeyChange}
        fastMode={fastMode}
        onFastModeChange={onFastModeChange}
        command={command}
        onCommandChange={onCommandChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={onReasoningEffortChange}
        envVarEntries={[]}
        onEnvVarEntriesChange={() => undefined}
        runtimeLabel={formatMessage({ id: "agent.runtimeConfig.runtime" })}
        runtimeHint={formatMessage({ id: "agent.create.runtimeHint" })}
        onRescanRuntimes={onRescanRuntimes}
        runtimesRescanning={runtimesRescanning}
        envVarsMode="hidden"
        technicalFieldsMode="hidden"
        // Create Cindy never selects a saved Provider connection, so the agent-local
        // key block must stay visible. Passed explicitly rather than inherited from the
        // default: relying on the default means flipping it silently hides the required
        // key field in onboarding, which no test could see.
        managedConnectionActive={false}
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={onAdvancedOpenChange}
        selectedModelSuggestionOnly={selectedModelSuggestionOnly}
        selectPortalContainer={selectPortalContainer}
        showBuiltInRequiredHint={runtime === "builtin"}
        schemaBacked={schemaBacked}
        formDefinition={formDefinition}
        formDefinitionLoading={formDefinitionLoading}
        formDefinitionError={formDefinitionError}
        formDefinitionErrorCode={formDefinitionErrorCode}
      />
    </div>
  );
}

export default function CreateAgentDialog({
  onClose,
  defaultMachineId,
  onboarding = false,
  prefilledName,
  prefilledDescription,
  prefilledMachineId,
  prefilledMachineMode,
  minimumDaemonVersion,
  onCreated,
  onOnboardingComplete,
  onOnboardingLater,
  onOnboardingStartOver,
  onSubmitStart,
  onSubmitError,
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
  /** Opens the dedicated external-agent create flow. External agents have no Computer. */
  external?: boolean;
  /** Dev fixture mode: render the real form but never create an agent or finish setup. */
  previewOnly?: boolean;
  /** Dev fixture's explicit server projection. Never used as a production capability fallback. */
  previewRuntimeOptions?: readonly RuntimeSelectionOption[];
  /**
   * Where onboarding Screen C renders. "modal": self-wraps in its own Modal.
   * "step": bare content for the setup gate's Modal (browser flow) — first-agent
   * creation still navigates to the onboarding-owner channel behind the modal.
   * "page": bare content for the standalone onboarding page (client flow) — no
   * channel navigation, the user must stay on the page for survey/handoff.
   */
  onboardingShell?: "modal" | "step" | "page";
}) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const currentServer = useServerStore((s) => s.current);
  const rescanRuntimes = useMachineStore((s) => s.rescanRuntimes);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const [runtimesRescanning, setRuntimesRescanning] = useState(false);
  // Portal target for the Create Cindy runtime selects — points at the modal
  // content so the Runs on / Model popovers open within the modal's stacking
  // context instead of behind it. See OnboardingCreateCindyRuntimePanel.
  const cindyRuntimeSelectPortalRef = useRef<HTMLElement>(null);

  const [name, setName] = useState(
    prefilledName ?? (onboarding ? "Cindy" : ""),
  );
  const [description, setDescription] = useState(
    prefilledDescription ?? (onboarding ? "Onboarding Assistant" : ""),
  );
  // Async, server-owned schema arrival must reconcile the editable draft that
  // was seeded before admission/definition fetches completed.
  // oxlint-disable react-doctor/no-event-handler
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
          || machines.find((m) => m.status === "online" && machineMeetsDaemonRequirement(m, minimumDaemonVersion))?.id
          || ""
  );
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const selectedMachineMeetsDaemonRequirement = machineMeetsDaemonRequirement(selectedMachine, minimumDaemonVersion);
  const machineOptions: SelectOption[] = machines.map((machine) => {
    const isOffline = machine.status !== "online";
    const blockedByRequired = prefilledMachineMode === "required" && machine.id !== prefilledMachineId;
    const daemonTooOld = !machineMeetsDaemonRequirement(machine, minimumDaemonVersion);
    const daemonRequirementLabel = daemonTooOld && minimumDaemonVersion
      ? ` ${formatMessage(
        { id: "agent.create.daemonVersionRequirement" },
        {
          version: machine.daemonVersion
            ? `v${machine.daemonVersion}`
            : formatMessage({ id: "agent.create.daemonVersionUnknown" }),
          minimum: minimumDaemonVersion,
        },
      )}`
      : "";
    return {
      value: machine.id,
      label: machine.name + (machine.hostname ? ` (${machine.hostname})` : "") + (isOffline ? formatMessage({ id: "agent.create.offlineSuffix" }) : "") + daemonRequirementLabel,
      disabled: isOffline || blockedByRequired || daemonTooOld,
    };
  });
  const machineRuntimeIds = selectedMachine?.runtimes ?? [];
  const runtimeSelectionCatalog = useNewAgentRuntimeOptions(
    previewOnly ? null : selectedMachineId,
    machineRuntimeIds,
  );
  const runtimeAdmissionOptions = previewOnly
    ? previewRuntimeOptions ?? EMPTY_RUNTIME_SELECTION_OPTIONS
    : runtimeSelectionCatalog.options;
  const runtimeFormDefinitionRefs = useMemo(
    () => previewOnly
      ? []
      : runtimeAdmissionOptions.flatMap((option): RuntimeFormDefinitionRef[] =>
          option.canSelectInThisContext && option.formDefinitionRef ? [option.formDefinitionRef] : []),
    [previewOnly, runtimeAdmissionOptions],
  );
  const runtimeFormDefinitionCatalog = useRuntimeFormDefinitionCatalog(
    previewOnly ? null : selectedMachineId,
    runtimeFormDefinitionRefs,
  );
  const availableRuntimes = useMemo(
    () => runtimeAdmissionOptions
      .filter((option) => option.canSelectInThisContext && (
        option.formDefinitionRef === undefined || !runtimeFormDefinitionCatalog.loading
      ))
      .map((option) => option.runtimeId),
    [runtimeAdmissionOptions, runtimeFormDefinitionCatalog.loading],
  );
  // The creatable runtime list is module-level config, so the supported set never changes —
  // memoize it once so it stays referentially stable (it feeds the effect deps
  // below; a fresh Set each render would defeat that effect's dependency check).
  const creatableRuntimes = useMemo(() => getCreatableRuntimeOptions(), []);
  const supportedSet = useMemo(() => new Set(creatableRuntimes.map((r) => r.id)), [creatableRuntimes]);
  const defaultRuntime = pickCreateAgentRuntime(
    availableRuntimes,
    supportedSet,
    onboarding,
    rememberedConfig,
  );
  const [runtime, setRuntime] = useState(defaultRuntime);
  const selectedRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.runtimeId === runtime);
  const formDefinitionRef = selectedRuntimeAdmission?.formDefinitionRef;
  const runtimeFormDefinitionEntry = formDefinitionRef
    ? runtimeFormDefinitionCatalog.entries[runtimeFormDefinitionRefKey(formDefinitionRef)]
    : undefined;
  const runtimeFormDefinition = formDefinitionRef
    ? {
        definition: runtimeFormDefinitionEntry?.definition ?? null,
        loading: runtimeFormDefinitionCatalog.loading,
        error: !runtimeFormDefinitionCatalog.loading && (runtimeFormDefinitionEntry?.error ?? true),
        errorCode: runtimeFormDefinitionEntry?.errorCode,
      }
    : { definition: null, loading: false, error: false, errorCode: undefined };
  const schemaBacked = formDefinitionRef !== undefined;
  const runtimeReasoningSupported = REASONING_EFFORT_RUNTIMES.has(runtime)
    && (runtime !== "kimi-sdk" || schemaBacked);
  const rememberedModelApplies = rememberedConfig?.runtime === defaultRuntime;
  const initialModel = rememberedModelApplies
    ? rememberedConfig.model
    : getDefaultModel(defaultRuntime || "claude");
  const [model, setModel] = useState(initialModel);
  const [customModelMode, setCustomModelMode] = useState(
    rememberedModelApplies ? rememberedConfig.customModelMode : false,
  );
  const [providerMode, setProviderMode] = useState<RuntimeProviderMode>("default");
  const [providerApiUrl, setProviderApiUrl] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [builtInProviderMode, setBuiltInProviderMode] = useState<BuiltInProviderMode>(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
  const [builtInProviderApiKey, setBuiltInProviderApiKey] = useState("");
  const [builtInProviderBaseUrl, setBuiltInProviderBaseUrl] = useState("");
  const [builtInProviderSupportsImageInput, setBuiltInProviderSupportsImageInput] = useState(false);
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [piProviderMode, setPiProviderMode] = useState<PiProviderMode>(PI_PROVIDER_CONFIGURED);
  const [piProviderApiKey, setPiProviderApiKey] = useState("");
  const [fastMode, setFastMode] = useState(false);
  const [command, setCommand] = useState("");
  // Seed to the default model's declared reasoning effort (e.g. GPT-5.6 → Medium);
  // non-gating models start at "Default" (null).
  const [reasoningEffort, setReasoningEffort] = useState<RuntimeReasoningEffort | null>(
    reconcileReasoningEffort(defaultRuntime || "claude", initialModel, null),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [envVarEntries, setEnvVarEntries] = useState<{ key: string; value: string }[]>([]);
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
  const channels = useChannelStore((s) => s.channels);
  const allAgents = useAgentStore((s) => s.agents);
  const agents = allAgents.filter((a) => !a.deletedAt);
  const nav = useAppNavigate();
  const providerConnectionCatalog = useProviderConnections(!previewOnly && runtime === "builtin");
  const availableProviderConnections = providerConnectionCatalog.connections.filter((connection) => connection.enabled && connection.status === "ready");
  const selectedProviderConnection = availableProviderConnections.find((connection) => connection.id === providerConnectionId) ?? null;

  // The definition's option sources, not client constants, own provider/model
  // defaults for schema-backed rows. Reconcile once the version-pinned
  // definition arrives or changes.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state, react-doctor/no-effect-chain, react-doctor/no-event-handler
  useEffect(() => {
    const definition = runtimeFormDefinition.definition;
    if (!definition) return;
    if (definition.runtimeId === "kimi-sdk") {
      const modelSource = definition.optionSources.model;
      if (modelSource?.kind !== "select") return;
      const selected = modelSource.options.find((option) => option.value === model)
        ?? modelSource.options.find((option) => option.value === modelSource.defaultValue)
        ?? modelSource.options[0];
      if (!selected) return;
      // oxlint-disable-next-line react-doctor/no-derived-state
      setModel(selected.value);
      // oxlint-disable-next-line react-doctor/no-derived-state
      setReasoningEffort((previous) => selected.supportedReasoningEfforts?.includes(previous ?? "")
        ? previous
        : selected.defaultReasoningEffort ?? null);
      return;
    }
    const providerSource = definition.optionSources.provider;
    const modelSource = definition.optionSources.model;
    if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") return;
    const providerId = providerSource.options.some((option) => option.value === builtInProviderMode)
      ? builtInProviderMode
      : providerSource.defaultValue;
    const customModel = modelSource.customValueAllowedByValue[providerId] === true;
    const allowedModels = modelSource.optionsByValue[providerId] ?? [];
    const nextModel = customModel
      ? model
      : allowedModels.some((option) => option.value === model)
        ? model
        : modelSource.defaultValueByValue[providerId] ?? allowedModels[0]?.value ?? "";
    // Async definition arrival narrows an editable draft to server-owned
    // options; these remain user-editable after the one-shot reconciliation.
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setBuiltInProviderMode(providerId as BuiltInProviderMode);
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setCustomModelMode(customModel);
    // oxlint-disable-next-line react-doctor/no-derived-state
    setModel(nextModel);
  }, [builtInProviderMode, model, runtimeFormDefinition.definition]);
  // oxlint-enable react-doctor/no-event-handler

  // Runtime admission can arrive after the raw Computer capability list. A
  // Claude-capable Computer still has a declared static model source during
  // that gap, so keep the historical pre-admission picker available. The
  // user's model choice anchors `runtime` to Claude in `changeModel`; dynamic
  // runtimes never receive this provisional source.
  const runtimeModelSourceRuntime = runtime || (machineRuntimeIds.includes("claude") ? "claude" : "");
  const runtimeModels = useRuntimeModels(selectedMachineId, runtimeModelSourceRuntime);
  const selectedModelInfo = customModelMode ? null : runtimeModels.models.find((m) => m.id === model);
  const selectedModelSuggestionOnly = selectedModelInfo?.verified === "suggestion_only";
  const apiUrlSupported = supportsRuntimeApiUrl(runtime);
  const providerApiUrlRequired = apiUrlSupported && providerMode === "custom";
  /**
   * Missing and malformed are NOT the same state (Cindy, 2026-08-26).
   *
   *   empty     → Create Agent is disabled. The disabled button IS the message;
   *               a field you have not filled in yet is not a mistake to report.
   *   malformed → Create Agent is clickable, and the click reports it in the
   *               field's error slot.
   *
   * The old single `…Invalid` booleans collapsed both into one, which is why the
   * form could only either shout at an untouched field or say nothing at all.
   */
  const urlMalformed = (value: string) =>
    value.trim().length > 0 && !/^https?:\/\//i.test(value.trim());
  const providerApiUrlMissing = providerApiUrlRequired && providerApiUrl.trim().length === 0;
  const providerApiUrlInvalid = urlMalformed(providerApiUrl);
  const providerApiKeyInvalid = providerApiUrlRequired && !providerApiKey.trim();
  const schemaProviderSource = runtimeFormDefinition.definition?.optionSources.provider;
  const schemaGatewayProvider = schemaProviderSource?.kind === "select"
    && schemaProviderSource.options.find((option) => option.value === builtInProviderMode)?.providerKind === "gateway";
  const schemaBuiltIn = runtimeFormDefinition.definition?.runtimeId === "builtin";
  const builtInApiKeyInvalid = !selectedProviderConnection && (schemaBuiltIn || supportsRuntimeBuiltInProvider(runtime)) && !builtInProviderApiKey.trim();
  const builtInBaseUrlRequired = schemaBuiltIn
    ? schemaGatewayProvider
    : supportsRuntimeBuiltInProvider(runtime) && isBuiltInGatewayProviderMode(builtInProviderMode);
  const builtInBaseUrlMissing = !selectedProviderConnection && builtInBaseUrlRequired
    && builtInProviderBaseUrl.trim().length === 0;
  const builtInBaseUrlInvalid = !selectedProviderConnection && urlMalformed(builtInProviderBaseUrl);
  const builtInGatewayModelRequired = builtInBaseUrlRequired;
  const piProviderSupported = supportsRuntimePiProvider(runtime);
  const piApiKeyRequired = piProviderSupported && piProviderMode !== PI_PROVIDER_CONFIGURED;
  const piApiKeyInvalid = piApiKeyRequired && !piProviderApiKey.trim();
  // A no-ref Codex admission row is the rolling-upgrade legacy path: it has no
  // form definition/catalog authority and historically delegates model
  // validation to Codex at launch. Keep that path compatible; dynamic runtimes
  // such as Cursor and Kimi still require the typed source authority below.
  const schemaModelSource = runtimeFormDefinition.definition?.optionSources.model;
  const schemaSelectedModel = schemaModelSource?.kind === "select"
    ? schemaModelSource.options.find((option) => option.value === model)
    : undefined;
  const schemaReasoningInvalid = runtimeFormDefinition.definition?.runtimeId === "kimi-sdk"
    && reasoningEffort !== null
    && !schemaSelectedModel?.supportedReasoningEfforts?.includes(reasoningEffort);
  const schemaModelAllowsSubmit = schemaModelSource?.kind === "select"
    ? schemaModelSource.options.some((option) => option.value === model)
    : false;
  const modelSourceAllowsSubmit = schemaBacked
    ? schemaModelAllowsSubmit || runtimeFormDefinition.definition?.runtimeId === "builtin"
    : (runtime === "codex" && !schemaBacked) || runtimeModelSelectionIsRunnable({
    source: runtimeModels.source,
    model,
    modelIgnored: runtimeIgnoresModel(runtime),
    customMode: customModelMode,
    customAllowed: supportsRuntimeCustomModelName(runtime),
    providerCatalog: supportsRuntimeBuiltInProvider(runtime) || piApiKeyRequired,
  });
  const runtimeOptions = runtimeAdmissionOptions.flatMap((option) => {
    const runtimeInfo = creatableRuntimes.find((runtime) => runtime.id === option.runtimeId);
    return runtimeInfo
      ? [{
          value: runtimeInfo.id,
          label: formatRuntimeLabelWithStatus(runtimeInfo.id, formatMessage) + formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtimeInfo, machineRuntimeIds), formatMessage),
          disabled: !option.canSelectInThisContext || (
            option.formDefinitionRef !== undefined && runtimeFormDefinitionCatalog.loading
          ),
        }]
      : [];
  });
  const modelOptions = runtimeModels.models.map((m) => ({ value: m.id, label: m.label }));

  // Change the selected model and reconcile reasoning against the new model's
  // declared supportedReasoningEfforts: keep a still-valid value, otherwise fall
  // back to the model's default effort (e.g. switching to GPT-5.6 luna drops an
  // Ultra selection down to Medium).
  const changeModel = (nextModel: string) => {
    // Before the async admission catalog arrives, the legacy picker deliberately
    // renders the Claude fallback catalog. Anchor that explicit user choice to
    // Claude immediately. Otherwise the admission effect still sees runtime=""
    // and can overwrite model B with the remembered/default model A between the
    // visible selection and submit.
    const nextRuntime = runtime || "claude";
    if (!runtime) {
      setRuntime(nextRuntime);
    }
    setModel(nextModel);
    setReasoningEffort((prev) => reconcileReasoningEffort(
      nextRuntime,
      nextModel,
      prev as import("@botiverse/raft-shared").ReasoningEffort | null,
      runtimeModels.models,
    ));
  };

  // One-shot prefill waiter: when the dialog opens with a `prefilledMachineId`
  // for an action-card-driven flow, the target machine may briefly be reported
  // as offline (machines list is socket-pushed). This effect waits for it to
  // come online and then seeds machine + dependent fields ONCE — gated by
  // `!selectedMachineId` so a user who's already picked anything is never
  // overridden. NOT a mirror-prop effect (the inputs are async-list events,
  // not props that should be reflected continuously); useState-initializer
  // refactor would require remounting on `online` flip and would lose user
  // input. Same FP family as PR #2524 / #2536's async-arrival pattern.
  //
  // Three sister rules fire on this effect; all are the same FP:
  //   - no-derived-state on each setState line (PR #2524's original disables)
  //   - no-cascading-set-state on the effect header (9 setState in one effect)
  //   - no-adjust-state-on-prop-change on each setState line
  // Disables broadened per @铁根 strategic note msg=2e922c7d: list every
  // sister rule on the same line so future flips don't need to re-touch.
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
        ?? machines.find((m) =>
          m.status === "online"
          && machineMeetsDaemonRequirement(m, minimumDaemonVersion)
        );
    if (!machine || machine.status !== "online") return;
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setSelectedMachineId(machine.id);
    // oxlint-disable-next-line react-doctor/no-derived-state
    setRuntime("");
    // oxlint-disable-next-line react-doctor/no-derived-state
    setModel(getDefaultModel("claude"));
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- YMNNE-family: async-arrival preference prefill; the user can still change this field after the one-shot seed (see docs/frontend/render-cost-contract.md)
    setCustomModelMode(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setProviderMode("default");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setProviderApiUrl("");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setProviderApiKey("");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setBuiltInProviderMode(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setBuiltInProviderApiKey("");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setBuiltInProviderBaseUrl("");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- reset the gateway-only capability with the dialog lifecycle.
    setBuiltInProviderSupportsImageInput(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setFastMode(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setCommand("");
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- YMNNE-family: pre-existing non-bug site grandfathered; reasoning is seeded from the resolved runtime/model default here, same async-arrival prefill path as the sibling setState lines (see docs/frontend/render-cost-contract.md)
    setReasoningEffort(reconcileReasoningEffort("claude", getDefaultModel("claude"), null));
  }, [defaultMachineId, machines, minimumDaemonVersion, onboarding, prefilledMachineId, rememberedConfig, selectedMachineId, supportedSet]);

  // Admission is server-owned and arrives after the raw machine capability list.
  // Keep an existing user choice only while the contextual catalog still admits
  // it; otherwise choose the first admitted capability for this create context.
  // This is an async-list reconciliation edge: the request cannot start until
  // the selected machine is known, and the resulting choice remains user-editable.
  // oxlint-disable-next-line react-doctor/no-effect-chain, react-doctor/no-cascading-set-state, react-doctor/no-pass-live-state-to-parent
  useEffect(() => {
    // Schema rows are temporarily absent from `availableRuntimes` while their
    // forms preload. Do not let that partial list overwrite a remembered or
    // default schema runtime with a legacy fallback: wait for the complete
    // admitted set, then reconcile exactly once. A legacy-only catalog has no
    // form refs and can still select immediately.
    if (runtimeFormDefinitionRefs.length > 0 && runtimeFormDefinitionCatalog.loading) return;
    // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- local async-list reconciliation; this component owns both the catalog and editable draft
    if (!selectedMachineId || availableRuntimes.length === 0 || availableRuntimes.includes(runtime)) return;
    const nextRuntime = pickCreateAgentRuntime(
      availableRuntimes,
      supportedSet,
      onboarding,
      rememberedConfig,
    );
    const rememberedModelApplies = rememberedConfig?.runtime === nextRuntime;
    const nextModel = rememberedModelApplies
      ? rememberedConfig.model
      : getDefaultModel(nextRuntime || "claude");
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setRuntime(nextRuntime);
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setModel(nextModel);
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setCustomModelMode(rememberedModelApplies ? rememberedConfig.customModelMode : false);
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates
    setReasoningEffort(reconcileReasoningEffort(nextRuntime || "claude", nextModel, null));
  }, [
    availableRuntimes,
    onboarding,
    rememberedConfig,
    runtime,
    runtimeFormDefinitionCatalog.loading,
    runtimeFormDefinitionRefs.length,
    selectedMachineId,
    supportedSet,
  ]);

  // List-dep default selection: when the async-loaded `runtimeModels.models`
  // list arrives or changes (machine/runtime switch), pick the documented
  // default if the current `model` isn't in the new list. NOT a mirror-prop
  // effect — `model` doesn't derive from a single prop, it's a user-editable
  // choice that may need to fall back when the available set shifts under
  // it (e.g. switching runtime). React-doctor's no-derived-state flags any
  // setState whose deps include an async-list, including this legitimate
  // "narrow user's choice to available set" pattern.
  // oxlint-disable-next-line react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    // A version-pinned schema row gets its models from the definition's bound
    // option source. The legacy machine-model reconciler must not race that
    // source and oscillate the selected value between two catalogs.
    if (schemaBacked || customModelMode || builtInGatewayModelRequired) return;
    const ids = runtimeModels.models.map((m) => m.id);
    if (ids.length === 0) return;
    if (ids.includes(model)) return;
    // oxlint-disable-next-line react-doctor/no-derived-state
    setModel(runtimeModels.default && ids.includes(runtimeModels.default) ? runtimeModels.default : ids[0]);
  }, [runtimeModels.models, runtimeModels.default, model, customModelMode, builtInGatewayModelRequired, schemaBacked]);

  const isExternalMode = external;
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
  // Lock name/description ONLY for the onboarding flow. Action-card-driven
  // prefill leaves the fields editable so the human can adjust whatever
  // the agent suggested (per stdrc 2026-05-10 #proj-approval msg=2f20e3a2:
  // "Create Agent 那个也可以编辑了").
  const nameLocked = onboarding;
  const descriptionLocked = onboarding;
  const lockedFieldClass = "bg-gray-100 text-black/50 cursor-not-allowed";
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
  const fieldValidationBlocked = Boolean(nameValidationError) || (!isExternalMode && (
    providerApiUrlInvalid || builtInBaseUrlInvalid || schemaReasoningInvalid
  ));

  const createDisabled =
    atLimit ||
    (!isExternalMode && (
      !selectedMachineId ||
      (prefilledMachineMode === "required" && selectedMachineId !== prefilledMachineId) ||
      machines.length === 0 ||
      !runtime ||
      !supportedSet.has(runtime) ||
      !availableRuntimes.includes(runtime) ||
      selectedMachine?.status !== "online" ||
      !selectedMachineMeetsDaemonRequirement ||
      (schemaBacked && !runtimeFormDefinition.definition) ||
      (Boolean(providerConnectionId) && !selectedProviderConnection) ||
      !modelSourceAllowsSubmit ||
      // Mandatory-but-EMPTY. Not an error message — the button simply stays
      // disabled until the field has a value, and only then can its content be
      // judged. Malformed values are deliberately absent from this list: they
      // keep the button clickable so the click can report them.
      !name.trim() ||
      providerApiUrlMissing ||
      providerApiKeyInvalid ||
      builtInApiKeyInvalid ||
      builtInBaseUrlMissing ||
      piApiKeyInvalid ||
      ((customModelMode || builtInGatewayModelRequired) && !model.trim())
    ));

  const handleSubmit = async (e: React.FormEvent) => {
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
    if (!isExternalMode && !selectedMachineId) {
      setError(formatMessage({ id: "agent.create.selectComputerError" }));
      setSubmitting(false);
      return;
    }
    if (!isExternalMode && prefilledMachineMode === "required" && selectedMachineId !== prefilledMachineId) {
      setError(formatMessage({ id: "agent.create.actionCardRequiresComputer" }));
      setSubmitting(false);
      return;
    }
    if (!isExternalMode && minimumDaemonVersion && !selectedMachineMeetsDaemonRequirement) {
      setError(formatMessage({ id: "agent.create.minimumDaemonVersion" }, { version: minimumDaemonVersion }));
      setSubmitting(false);
      return;
    }
    if (!isExternalMode && !availableRuntimes.includes(runtime)) {
      setError(formatMessage({ id: "agent.create.runtimeNotInstalled" }));
      setSubmitting(false);
      return;
    }
    if (!isExternalMode && !modelSourceAllowsSubmit) {
      setError(formatMessage({ id: "agent.create.modelSourceInvalid" }));
      setSubmitting(false);
      return;
    }
    // Funnel hook: fired AFTER client validation passes so we don't count
    // local form errors as `execute_attempt`. Best-effort; no-op outside
    // the action-card flow.
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
      const agent = createdOnboardingAgent ?? (isExternalMode
        ? await createAgent(name.trim(), {
            description: description.trim() || undefined,
            avatarUrl: `pixel:${avatarKey}`,
            external: true,
          })
        : await (async () => {
            // Build envVars object from entries (skip empty keys)
            const envVars: Record<string, string> = {};
            for (const entry of envVarEntries) {
              const k = entry.key.trim();
              if (k) envVars[k] = entry.value;
            }
            const runtimeConfig = schemaBacked && runtimeFormDefinition.definition
              ? runtimeFormDefinition.definition.runtimeId === "kimi-sdk"
                ? buildSchemaDrivenKimiConfig({
                    definition: runtimeFormDefinition.definition,
                    model,
                    reasoningEffort,
                    envVars: Object.keys(envVars).length > 0 ? envVars : null,
                  })
                : selectedProviderConnection
                ? buildConnectionDrivenBuiltInConfig({
                    definition: runtimeFormDefinition.definition,
                    connectionId: selectedProviderConnection.id,
                    providerId: selectedProviderConnection.providerId,
                    model,
                    envVars: Object.keys(envVars).length > 0 ? envVars : null,
                  })
                : buildSchemaDrivenBuiltInConfig({
                  definition: runtimeFormDefinition.definition,
                  providerId: builtInProviderMode,
                  apiKey: builtInProviderApiKey,
                  baseUrl: builtInProviderBaseUrl,
                  supportsImageInput: builtInProviderSupportsImageInput,
                  model,
                  envVars: Object.keys(envVars).length > 0 ? envVars : null,
                })
              : buildRuntimeConfig({
                  runtime,
                  model,
                  customModelMode,
                  customModelName: customModelMode ? model : undefined,
                  providerMode,
                  providerApiUrl,
                  providerApiKey,
                  builtInProviderMode,
                  builtInProviderApiKey,
                  builtInProviderBaseUrl,
                  builtInProviderSupportsImageInput,
                  piProviderMode,
                  piProviderApiKey,
                  fastMode,
                  reasoningEffort: runtimeReasoningSupported
                    ? reasoningEffort as import("@botiverse/raft-shared").ReasoningEffort | null
                    : null,
                  envVars: Object.keys(envVars).length > 0 ? envVars : null,
                  command,
                });
            const requestRuntimeConfig = runtime === "kimi-sdk" && !schemaBacked
              ? (() => {
                  const { reasoningEffort: _unmanagedReasoningEffort, ...legacyCompatibleConfig } = runtimeConfig;
                  return legacyCompatibleConfig as RuntimeConfig;
                })()
              : runtimeConfig;
            return createAgent(name.trim(), {
              description: description.trim() || undefined,
              model,
              runtime,
              runtimeConfig: requestRuntimeConfig,
              formDefinitionRef,
              reasoningEffort: runtime === "kimi-sdk"
                ? undefined
                : runtimeReasoningSupported
                  ? reasoningEffort as import("@botiverse/raft-shared").ReasoningEffort | undefined
                  : undefined,
              machineId: selectedMachineId,
              envVars: schemaBacked ? undefined : Object.keys(envVars).length > 0 ? envVars : undefined,
              avatarUrl: `pixel:${avatarKey}`,
              onboarding,
            });
          })());
      if (remembersLastConfig && currentServer) {
        writeCreateAgentLastConfig(currentServer.id, {
          machineId: selectedMachineId,
          runtime,
          model: model.trim(),
          customModelMode,
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
      // Post-create landing (cindyz 2026-05-26 dm msg=f342577e refined spec,
      // superseding the earlier "always jump to new agent DM" behavior):
      //   - external agent → route to /agent/:id immediately because the
      //     external runtime setup guide is the next required step
      //   - via action card → stay on the action card (the surface is
      //     already a chat surface; jumping away breaks the guided flow)
      //   - via other surfaces (Sidebar +Add / MachineDetail / etc.) → stay
      //     IF the user already has other agents
      //   - first agent (server has no agents yet, OR onboarding flow) →
      //     route to #all so the user lands somewhere productive instead
      //     of looking at an empty Sidebar+Add surface
      //   - fallback (no #all channel resolvable) → stay
      if (stayOnCreate) {
        // Orchestrator flows (e.g. Wiki setup) keep the parent dialog in place
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
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        err instanceof RuntimeConfigBuildError
          ? formatRuntimeConfigBuildError(err, formatMessage)
          : axiosErr.response?.data?.error || formatMessage({ id: "agent.create.failedCreate" }),
      );
      setSubmitting(false);
      // Funnel hook: dialog-driven `execute_fail`. The dialog stays open
      // so the user can retry; we record the funnel event regardless.
      onSubmitError?.(err);
    }
  };
  const dialogTitle = isExternalMode
    ? formatMessage({ id: "agent.create.dialogTitleExternal" })
    : onboarding
      ? formatMessage({ id: "agent.create.dialogTitleOnboarding" })
      : formatMessage({ id: "agent.create.dialogTitle" });
  const submitLabel = isExternalMode
    ? formatMessage({ id: "agent.create.dialogTitleExternal" })
    : formatMessage({ id: "agent.create.submitCreateAgent" });

  if (onboarding) {
    const formId = "create-cindy-onboarding-form";
    const content = (
      <section ref={cindyRuntimeSelectPortalRef} className="flex w-full max-w-[960px] flex-col border-2 border-black bg-white shadow-brutal md:h-[min(720px,calc(100dvh-2rem))] md:min-h-0 md:overflow-hidden" data-testid="create-cindy-screen-c">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b-2 border-black px-6 pb-4 pt-6 sm:px-9">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-bold uppercase tracking-wide text-black/55">
              {formatMessage({ id: "agent.create.setupServer" })}
            </div>
            <h1 className="mt-2 text-xl font-bold">{formatMessage({ id: "agent.create.meetCindy" })}</h1>
            <p className="mt-1 text-xs leading-5 text-black/60">
              {formatMessage({ id: "agent.create.cindyDescription" })}
            </p>
          </div>
          {/* Opened from the members panel this is an ordinary dialog, and an ordinary
              dialog can be closed. Inside the setup gate ("step" and "page" shells)
              the step is mandatory and carries its own Later, so no X there.

              Left on `variant="default"` deliberately, unlike the dialog shell's X.
              This branch is UNREACHABLE in production: it needs `onboarding` with a
              shell other than "step", and the only caller that could supply that
              feeds `onboarding` from a store flag nothing sets true —
              `setShowCreateAgent(show, onboarding = false)` has two call sites and
              both pass one argument. Restyling a dead path is noise in a diff, and
              worse, it implies the path is live. Whether this branch should exist
              at all is a separate question (@cindyz, 2026-08-29). */}
          {onboardingShell !== "modal" ? null : (
            <Button
              type="button"
              onClick={onClose}
              variant="default"
              size="icon-md"
              className="shrink-0"
              aria-label={formatMessage({ id: "common.close" })}
            >
              <X size={20} />
            </Button>
          )}
        </header>

        <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col md:min-h-0 md:flex-1 md:overflow-hidden">
          <div className="flex flex-col gap-0 md:grid md:grid-cols-[0.95fr_1.05fr] md:min-h-0 md:flex-1 md:overflow-hidden">
            <div className="flex flex-col border-b-2 border-black bg-soft-pink px-8 py-5 md:min-h-0 md:justify-center md:border-b-0 md:border-r-2 md:py-8">
              <div className="mx-auto flex max-w-[360px] flex-col items-center text-center">
                <div className="relative mb-3 md:mb-5" data-testid="cindy-avatar-entrance">
                  <span className="onboarding-cindy-pop-mark absolute -right-5 top-1 size-3 rotate-12 border-2 border-black bg-brutal-lime" aria-hidden="true" />
                  <span className="onboarding-cindy-pop-mark absolute -left-5 top-8 size-2.5 -rotate-12 border-2 border-black bg-soft-signal [animation-delay:70ms]" aria-hidden="true" />
                  {/* Every avatar frame in the app carries the black border (see
                      AvatarSlot); this hero was the one that did not. */}
                  <PixelAvatar avatarKey="mug" size={132} className="onboarding-cindy-entrance relative z-10 !size-[88px] border-2 border-black shadow-brutal-lg md:!size-[132px]" />
                </div>
                <h2 className="text-2xl font-black tracking-normal md:text-4xl">
                  {formatMessage({ id: "agent.create.cindyName" })}
                </h2>
                {/* The old "Onboarding assistant" badge spent a line restating
                    what the name and blurb already say. Say what she does for you. */}
                <p className="mt-2 text-sm font-medium leading-relaxed text-black/70 md:mt-3 md:text-base">
                  {formatMessage({ id: "agent.create.cindyHeroDescription" })}
                </p>
              </div>
            </div>

            <div className="max-h-[min(70dvh,calc(100dvh-12rem))] overflow-y-auto px-6 py-6 md:max-h-none md:min-h-0 md:px-8">
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
                          <Button
                            key="upgrade"
                            type="button"
                            onClick={() => {
                              onClose();
                              nav.toSettings("billing");
                            }}
                            variant="link"
                            size="inline"
                          >
                            {chunks}
                          </Button>
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
                  <BannerTitle>{formatMessage({ id: "agent.create.connectComputerFirst" })}</BannerTitle>
                  <BannerDescription>
                    {formatMessage({ id: "agent.create.cindyNeedsComputerDescription" })}
                  </BannerDescription>
                  {/* The action button is `default`, not `accent`. I had used accent to
                      match the dialog shell's equivalent action; @cindyz ruled default
                      (2026-08-29). An action inside a Banner is not the screen's primary
                      — the footer's Create Cindy is — so it must not carry accent weight. */}
                  <BannerAction>
                    <Button
                      type="button"
                      onClick={() => {
                        onClose();
                        setShowAddMachine(true);
                      }}
                      variant="default"
                      size="lg"
                    >
                      {formatMessage({ id: "agent.create.connectComputer" })}
                    </Button>
                  </BannerAction>
                </Banner>
              ) : (
              <OnboardingCreateCindyRuntimePanel
                showValidationErrors={validationAttempted}
                runtime={runtime}
                onRuntimeChange={(val) => {
                  setRuntime(val);
                  setModel(getDefaultModel(val) || "");
                  setReasoningEffort(reconcileReasoningEffort(val, getDefaultModel(val), null));
                  setCustomModelMode(false);
                  setProviderMode("default");
                  setProviderApiUrl("");
                  setProviderApiKey("");
                  setBuiltInProviderMode(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
                  setBuiltInProviderApiKey("");
                  setBuiltInProviderBaseUrl("");
                  setBuiltInProviderSupportsImageInput(false);
                  setPiProviderMode(PI_PROVIDER_CONFIGURED);
                  setPiProviderApiKey("");
                  setFastMode(false);
                  setCommand("");
                  setAdvancedOpen(false);
                }}
                // Show every runtime, greying out the ones we did not detect (they
                // carry a "(not installed)" suffix). Hiding them meant a user who
                // simply forgot to install their tool saw no trace of it — and when
                // nothing was detected at all, an empty list with no explanation.
                runtimeOptions={runtimeOptions}
                runtimesRescanning={runtimesRescanning}
                onRescanRuntimes={selectedMachineId ? () => {
                  setRuntimesRescanning(true);
                  void rescanRuntimes(selectedMachineId)
                    .catch(() => undefined)
                    // The fresh list lands on its own via the capabilities push; this
                    // only stops the spinner, it is not "the answer arriving".
                    .finally(() => setTimeout(() => setRuntimesRescanning(false), 1200));
                } : undefined}
                model={model}
                onModelChange={changeModel}
                customModelMode={customModelMode}
                onCustomModelModeChange={setCustomModelMode}
                modelOptions={modelOptions}
                runtimeModels={runtimeModels}
                providerMode={providerMode}
                onProviderModeChange={setProviderMode}
                providerApiUrl={providerApiUrl}
                onProviderApiUrlChange={setProviderApiUrl}
                providerApiKey={providerApiKey}
                onProviderApiKeyChange={setProviderApiKey}
                builtInProviderMode={builtInProviderMode}
                onBuiltInProviderModeChange={(next) => {
                  setBuiltInProviderMode(next);
                  if (isBuiltInGatewayProviderMode(next)) {
                    setModel("");
                    setCustomModelMode(true);
                    return;
                  }
                  setBuiltInProviderBaseUrl("");
                  const defaultModel = builtInProviderDefaultModel(next);
                  if (defaultModel) {
                    setModel(defaultModel);
                    setCustomModelMode(false);
                  }
                }}
                builtInProviderApiKey={builtInProviderApiKey}
                onBuiltInProviderApiKeyChange={setBuiltInProviderApiKey}
                builtInProviderBaseUrl={builtInProviderBaseUrl}
                onBuiltInProviderBaseUrlChange={setBuiltInProviderBaseUrl}
                builtInProviderSupportsImageInput={builtInProviderSupportsImageInput}
                onBuiltInProviderSupportsImageInputChange={setBuiltInProviderSupportsImageInput}
                piProviderMode={piProviderMode}
                onPiProviderModeChange={(next) => {
                  setPiProviderMode(next);
                  if (next !== PI_PROVIDER_CONFIGURED) {
                    const defaultModel = piBuiltinProviderDefaultModel(next);
                    if (defaultModel) {
                      setModel(defaultModel);
                      setCustomModelMode(false);
                    }
                  }
                }}
                piProviderApiKey={piProviderApiKey}
                onPiProviderApiKeyChange={setPiProviderApiKey}
                fastMode={fastMode}
                onFastModeChange={setFastMode}
                command={command}
                onCommandChange={setCommand}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={setReasoningEffort}
                advancedOpen={advancedOpen}
                onAdvancedOpenChange={setAdvancedOpen}
                selectedModelSuggestionOnly={selectedModelSuggestionOnly}
                selectPortalContainer={cindyRuntimeSelectPortalRef}
                schemaBacked={schemaBacked}
                formDefinition={runtimeFormDefinition.definition}
                formDefinitionLoading={runtimeFormDefinition.loading}
                formDefinitionError={runtimeFormDefinition.error}
                formDefinitionErrorCode={runtimeFormDefinition.errorCode}
              />
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
                <div className="mt-6 flex flex-wrap items-baseline gap-x-1 text-sm">
                  <span data-testid="create-agent-start-over-description">
                    {formatMessage({ id: "agent.create.notYourComputer" })}
                  </span>
                  <TextLink
                    variant="muted"
                    onClick={() => void onOnboardingStartOver()}
                    disabled={submitting}
                    data-testid="create-agent-start-over"
                  >
                    {formatMessage({ id: "agent.create.startOver" })}
                  </TextLink>
                  <span>{formatMessage({ id: "agent.create.connectDifferentOne" })}</span>
                </div>
              ) : null}
            </div>
          </div>
          <footer className="flex shrink-0 flex-col-reverse gap-3 border-t-2 border-black px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-9">
            {onboarding ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SetupSessionFooter disabled={submitting} />
                {onOnboardingLater ? (
                  <TextLink
                    variant="muted"
                    onClick={() => void onOnboardingLater()}
                    disabled={submitting}
                    className="text-sm"
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
      </section>
    );
    return onboardingShell === "modal" ? <Modal onClose={onClose}>{content}</Modal> : content;
  }

  // An agent runs on a computer. With none connected there is nothing to configure and
  // nothing to create: every field below would be dead, and the one action that unblocks
  // them is not on this screen. Ask for the computer instead (stdrc, 2026-07-13).
  if (!isExternalMode && machines.length === 0) {
    return (
      <Modal onClose={onClose}>
        <div className="w-full max-w-md card-brutal p-6" data-testid="create-agent-needs-computer">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold uppercase">{dialogTitle}</h2>
            <Button variant="outline" size="icon-md" onClick={onClose} aria-label={formatMessage({ id: "common.close" })}>
              <X size={20} />
            </Button>
          </div>

          <Banner status="info">
            <BannerTitle>{formatMessage({ id: "agent.create.connectComputerFirst" })}</BannerTitle>
            <BannerDescription>
              {formatMessage({ id: "agent.create.needsComputerDescription" })}
            </BannerDescription>
          </Banner>

          <div className="mt-4 flex justify-end gap-3">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onClose();
                setShowAddMachine(true);
              }}
              variant="accent"
                    size="lg"
            >
              {formatMessage({ id: "agent.create.connectComputer" })}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <DialogCard title={dialogTitle} onClose={onClose}>
        {/* `space-y-1` (4px) since 2026-09-03 (@cindyz): StableField already
            reserves a message row under every field, so the gap between fields
            is paying for space the row has already bought. The reasoning for
            never using 16px still stands verbatim: with every field now holding
            a 16px message row open whether or not it has anything to say, a 16px gap
            on top of it read as too airy — measured 36px (brutal) / 38px (elegant)
            from one control to the next label. This is the safe lever: the reserved
            row itself cannot shrink below the 16px a line of help text occupies
            without bringing back the layout jump it exists to prevent. 8px between fields
            still reads as 28px / 30px control-to-label, because that 16px row sits
            inside the gap — the token alone would have been misleading, which is why
            12px and 8px were compared as rendered screenshots before choosing.
            RuntimeConfigFields renders its fields as direct children of this form,
            so one class governs the whole rhythm; Agent Details has its own
            container and is untouched. */}
        <form noValidate onSubmit={handleSubmit} className="space-y-1">
          {/* The add-members entry promised "joins #channel after creation";
              that promise must not vanish once this dialog covers the entry
              (task #584). Plain persistent line, not a Banner — it is context,
              not a warning, and it stays until submit. */}
          {autoJoinChannelName && (
            <p
              className="border-2 border-black bg-brutal-cyan/60 px-3 py-2 text-xs font-bold text-black"
              data-testid="create-agent-channel-context"
            >
              {formatMessage(
                { id: "agent.create.autoJoinChannel" },
                { channel: `#${autoJoinChannelName}` },
              )}
            </p>
          )}
          {/*
            * An action inside a Banner's TEXT must be `size="inline"`.
            *
            * Every other Button size is a CONTROL size — `sm` is `h-7` plus
            * horizontal padding — so in a sentence it renders as a short box
            * beside the text: a gap on its left, the banner ~8px taller, and a
            * wrap onto its own line once width gets tight. Only `inline` is
            * `h-auto p-0 align-baseline leading-[inherit]`, i.e. a word in a
            * line of text that happens to be clickable. This is what Create
            * Agent shipped before, and a screenshot does not show it until the
            * viewport is narrow enough to trigger the wrap.
            *
            * An action that wants real button chrome is not inline text — it
            * belongs in `<BannerAction>`, which lays out right-aligned and keeps
            * the button on one line while the description wraps.
            *
            * @cindyz reviewed the five placements on 2026-08-29
            * (#wg-design-exp:20aaae68): inline is the correct usage here;
            * anything else about Banner is fixed in raft-ui, not at callsites.
            */}
          {atLimit && (
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
                      <Button
                        key="upgrade"
                        type="button"
                        onClick={() => {
                          onClose();
                          nav.toSettings("billing");
                        }}
                        variant="link"
                            size="inline"
                      >
                        {chunks}
                      </Button>
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
                {isQuotaError(error) && (
                  <>
                    {" "}
                    <Button
                      type="button"
                      onClick={() => {
                        onClose();
                        nav.toSettings("billing");
                      }}
                      variant="link"
                            size="inline"
                    >
                      {formatMessage({ id: "agent.create.viewPlans" })}
                    </Button>
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
                  value={selectedMachineId}
                  onValueChange={(val) => {
                    if (val == null) return;
                    setSelectedMachineId(val);
                    setRuntime("");
                    setModel(getDefaultModel("claude"));
                    setCustomModelMode(false);
                    setProviderMode("default");
                    setProviderApiUrl("");
                    setProviderApiKey("");
                    setBuiltInProviderMode(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
                    setBuiltInProviderApiKey("");
                    setBuiltInProviderBaseUrl("");
                    setBuiltInProviderSupportsImageInput(false);
                    setPiProviderMode(PI_PROVIDER_CONFIGURED);
                    setPiProviderApiKey("");
                    setFastMode(false);
                    setCommand("");
                    setReasoningEffort(reconcileReasoningEffort("claude", getDefaultModel("claude"), null));
                  }}
                  items={machineOptions}
                >
                  <FieldSelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.create.selectPlaceholder" })} />
                    <SelectIcon />
                  </FieldSelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {renderSelectItems(machineOptions)}
                    </SelectList>
                  </SelectContent>
                </Select>
              )}
              {minimumDaemonVersion && (
                <p className="mt-1 text-xs font-medium text-black/60">
                  {formatMessage(
                    { id: "agent.create.requiresDaemon" },
                    { version: minimumDaemonVersion },
                  )}
                </p>
              )}
              {prefilledMachineMode === "required" ? (
                <p className="mt-1 text-xs text-black/50">
                  {prefilledMachine?.name
                    ? formatMessage(
                        { id: "agent.create.requiredByActionCardNamed" },
                        { name: prefilledMachine.name },
                      )
                    : formatMessage({ id: "agent.create.requiredByActionCard" })}
                </p>
              ) : prefilledMachineId ? (
                <p className="mt-1 text-xs text-black/50">
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
          >
            <Input
              id="create-agent-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError("");
              }}
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
            <p className="text-xs text-black/60" data-testid="create-agent-prefill-note">
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
              onChange={(e) => setDescription(e.target.value)}
              className={`w-full ${descriptionLocked ? lockedFieldClass : ""}`}
              placeholder={formatMessage({ id: "agent.create.descriptionPlaceholder" })}
              rows={3}
              maxLength={MAX_AGENT_DESCRIPTION_LENGTH}
              readOnly={descriptionLocked}
            />
            {descriptionLocked ? (
              <div className="mt-1 text-xs text-black/60">
                {onboarding
                  ? formatMessage({ id: "agent.create.fixedForOnboarding" })
                  : formatMessage({ id: "agent.create.prefilledByActionCard" })}
              </div>
            ) : null}
          </StableField>
          {!isExternalMode && (
            <>
            {providerConnectionCatalog.featureEnabled && runtime === "builtin" && (availableProviderConnections.length > 0 || providerConnectionId) && (
              <StableField
                label={formatMessage({ id: "agent.create.providerConnection" })}
                hint={formatMessage({ id: "agent.create.providerConnectionHint" })}
              >
                <Select
                  chrome="field"
                  value={providerConnectionId || "__inline_provider_connection__"}
                  items={[
                    { value: "__inline_provider_connection__", label: formatMessage({ id: "agent.create.providerConnectionInline" }) },
                    ...availableProviderConnections.map((connection) => ({ value: connection.id, label: connection.name })),
                  ]}
                  onValueChange={(value) => {
                    if (value == null) return;
                    const nextId = value === "__inline_provider_connection__" ? "" : value;
                    setProviderConnectionId(nextId);
                    const connection = availableProviderConnections.find((candidate) => candidate.id === nextId);
                    if (!connection) return;
                    setBuiltInProviderMode(connection.providerId);
                    setBuiltInProviderApiKey("");
                    setBuiltInProviderBaseUrl("");
                    if (isBuiltInGatewayProviderMode(connection.providerId)) {
                      setModel("");
                      setCustomModelMode(true);
                    } else {
                      setModel(builtInProviderDefaultModel(connection.providerId) ?? "");
                      setCustomModelMode(false);
                    }
                  }}
                >
                  <FieldSelectTrigger className="w-full" data-testid="create-agent-provider-connection">
                    <SelectValue />
                    <SelectIcon />
                  </FieldSelectTrigger>
                  <SelectContent>
                    <SelectList>
                      <SelectItem value="__inline_provider_connection__">
                        <SelectItemText>{formatMessage({ id: "agent.create.providerConnectionInline" })}</SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                      {availableProviderConnections.map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>
                          <SelectItemText>{connection.name}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
                {providerConnectionId && !selectedProviderConnection && (
                  <p className="mt-1 text-xs font-bold text-brutal-red">
                    {formatMessage({ id: "agent.create.providerConnectionUnavailable" })}
                  </p>
                )}
              </StableField>
            )}
            <RuntimeConfigFields
              showValidationErrors={validationAttempted}
              runtime={runtime}
              onRuntimeChange={(val) => {
                setRuntime(val);
                setModel(getDefaultModel(val));
                setReasoningEffort(reconcileReasoningEffort(val, getDefaultModel(val), null));
                setCustomModelMode(false);
                setProviderMode("default");
                setProviderApiUrl("");
                setProviderApiKey("");
                setBuiltInProviderMode(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
                setBuiltInProviderApiKey("");
                setBuiltInProviderBaseUrl("");
                setBuiltInProviderSupportsImageInput(false);
                setProviderConnectionId("");
                setPiProviderMode(PI_PROVIDER_CONFIGURED);
                setPiProviderApiKey("");
                setFastMode(false);
                setCommand("");
                setAdvancedOpen(false);
              }}
              runtimeOptions={runtimeOptions}
              model={model}
              onModelChange={changeModel}
              customModelMode={customModelMode}
              onCustomModelModeChange={setCustomModelMode}
              modelOptions={modelOptions}
              runtimeModels={runtimeModels}
              rescanDisabled={!selectedMachineId}
              providerMode={providerMode}
              onProviderModeChange={setProviderMode}
              providerApiUrl={providerApiUrl}
              onProviderApiUrlChange={setProviderApiUrl}
              providerApiKey={providerApiKey}
              onProviderApiKeyChange={setProviderApiKey}
              builtInProviderMode={builtInProviderMode}
              onBuiltInProviderModeChange={(next) => {
                setBuiltInProviderMode(next);
                if (isBuiltInGatewayProviderMode(next)) {
                  setModel("");
                  setCustomModelMode(true);
                  return;
                }
                setBuiltInProviderBaseUrl("");
                const defaultModel = builtInProviderDefaultModel(next);
                if (defaultModel) {
                  setModel(defaultModel);
                  setCustomModelMode(false);
                }
              }}
              builtInProviderApiKey={builtInProviderApiKey}
              onBuiltInProviderApiKeyChange={setBuiltInProviderApiKey}
              builtInProviderBaseUrl={builtInProviderBaseUrl}
              onBuiltInProviderBaseUrlChange={setBuiltInProviderBaseUrl}
              builtInProviderSupportsImageInput={builtInProviderSupportsImageInput}
              onBuiltInProviderSupportsImageInputChange={setBuiltInProviderSupportsImageInput}
              piProviderMode={piProviderMode}
              onPiProviderModeChange={(next) => {
                setPiProviderMode(next);
                // Switching to a builtin provider locks the Model picker to
                // that provider's SDK first-class set; reset the selected
                // model to the provider's default so the picker shows a
                // valid value. Switching back to "Configured" lets the
                // host-discovered list (and any prior selection) recover.
                if (next !== PI_PROVIDER_CONFIGURED) {
                  const defaultModel = piBuiltinProviderDefaultModel(next);
                  if (defaultModel) {
                    setModel(defaultModel);
                    setCustomModelMode(false);
                  }
                }
              }}
              piProviderApiKey={piProviderApiKey}
              onPiProviderApiKeyChange={setPiProviderApiKey}
              fastMode={fastMode}
              onFastModeChange={setFastMode}
              command={command}
              onCommandChange={setCommand}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              envVarEntries={envVarEntries}
              onEnvVarEntriesChange={setEnvVarEntries}
              envVarsMode="advanced"
              technicalFieldsMode="advanced"
              advancedOpen={advancedOpen}
              onAdvancedOpenChange={setAdvancedOpen}
              selectedModelSuggestionOnly={selectedModelSuggestionOnly}
              schemaBacked={schemaBacked}
              formDefinition={runtimeFormDefinition.definition}
              formDefinitionLoading={runtimeFormDefinition.loading}
              formDefinitionError={runtimeFormDefinition.error}
              formDefinitionErrorCode={runtimeFormDefinition.errorCode}
              managedConnectionActive={Boolean(selectedProviderConnection)}
            />
            </>
          )}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              onClick={onClose}
              variant="outline"
              size="lg"
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <Button
              type="submit"
              disabled={createDisabled}
              variant="accent"
              size="lg"
            >
              {submitLabel}
            </Button>
          </div>
        </form>
    </DialogCard>
  );
}
