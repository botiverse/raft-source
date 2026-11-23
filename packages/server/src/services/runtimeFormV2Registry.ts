/**
 * Runtime form protocol v2: one registry entry per runtime that has a v2 form
 * (packages/runtime-form/README.md, "Protocol v2").
 *
 * An entry owns everything the server needs to serve and accept that runtime's
 * v2 form: the definition, its option sources, the mapping between a stored
 * runtimeConfig and form values (both directions), and which runtimeConfig
 * values are write-only secrets. The v2 routes, GET /api/agents/:id/runtime-form
 * and the v2 submit path consult only this registry, so giving a runtime a v2
 * form means adding an entry here and nothing else.
 *
 * Being registered here does not make a runtime visible to v1 clients: the v1
 * definition routes and `formDefinitionRef` on the runtime admission row stay
 * on the frozen v1 set in runtimeFormDefinitionService. The admission row
 * carries a separate `runtimeFormV2` marker for every registered runtime.
 */
import { configForms as oarConfigForms } from "@botiverse/oar/forms";
import { narrowOarForm, reasoningModelOptionsFromOar, type RaftModelNarrowing } from "./runtimeFormFromOar";
import {
  RUNTIME_FORM_V3_CLIENT_CAPABILITY,
  toRuntimeFormV2,
  type RuntimeFormV2ChoiceCopy,
  type RuntimeFormV2ClientCapability,
  type RuntimeFormV2Definition,
  type RuntimeFormV2OptionSourceReason,
  type RuntimeFormV2OptionSourceStatus,
  type RuntimeFormV2SubmitRef,
  type RuntimeFormV2UnavailableOption,
} from "@botiverse/raft-runtime-form";

import {
  ANTIGRAVITY_AGY_CHOOSES_MODEL,
  BASE_REASONING_EFFORTS,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  CUSTOM_MODEL_CONTEXT_WINDOW_MAX,
  CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX,
  defaultReasoningEffortsForRuntime,
  isReasoningEffortOfferedOnRuntime,
  runtimeOffersUndeclaredReasoningEfforts,
  sanitizeRuntimeEffortUnavailableReason,
  isControlledRuntimeEnvKey,
  getDefaultModel,
  getRuntimeProviderDisplayName,
  builtInPresetProviderModelId,
  isBuiltInRuntimeCustomModelPresetProviderId,
  builtInPresetTypedModelReasons,
  BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS,
  isRuntimeDeprecated,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  PI_BUILTIN_PROVIDER_MODELS,
  PI_REASONING_EFFORTS,
  REASONING_EFFORTS,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  runtimeModelSupportsFastMode,
  CODEX_PRIMARY_FAST_SERVICE_TIER,
  CODEX_NON_FAST_SERVICE_TIERS,
  runtimeConfigModelValue,
  runtimeServiceTierText,
  isRuntimeServiceTierId,
  type RuntimeServiceTierChoice,
  sanitizeRuntimeModelUnavailable,
  type AgentCreateFormIssue,
  type AgentCreateFormOption,
  type AgentCreateFormOptionSource,
  type RuntimeConfig,
  type RuntimeFormV2Marker,
  type RuntimeModelConfig,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import type { MachineLocalRoutingResult } from "../machineLocalReplay";
import { RouteFailureError } from "../tracing/routeFailure";
import type { ComputerProbeState } from "./computerProbeCacheService";
import type { AgentOrchestrator, MachineRuntimeModelDetection } from "./agentOrchestrator";
import {
  filterBuiltInPiFormOptionSourceForCatalog,
  requireBuiltInCatalogCapability,
} from "./builtinModelCatalogCompatibility";
import {
  builtInPiListOnlyOptionSource,
  buildBuiltInPiFormDefinition,
  buildBuiltInPiFormOptionSource,
  buildKimiSdkFormDefinition,
  buildKimiSdkFormOptionSource,
  validateBuiltInPiDefinitionProjection,
  validateKimiSdkDefinitionProjection,
} from "./runtimeFormDefinitionService";
import {
  optionSourceReasonForOutcome,
  optionSourceReasonForProbeError,
  optionSourceStatusFields,
} from "./runtimeFormV2SourceStatus";

export const RUNTIME_FORM_V2_MARKER: RuntimeFormV2Marker = Object.freeze({ protocolVersion: 2 });

/** task #10: whether the client renders a dependent value with options + typing as a combobox (advertised capability; implied by runtime_form.v3). */
export function clientRendersDependentCustomWithOptions(clientCapabilities: readonly string[] | undefined): boolean {
  const advertised = clientCapabilities ?? [];
  return advertised.includes("dependent_select.custom_value_with_options") || advertised.includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY);
}

/** What an option-source resolver asks of the Computer: its model probe, and the Built-in catalog with versions. */
export interface RuntimeFormModelProbe {
  detectMachineRuntimeModels: AgentOrchestrator["detectMachineRuntimeModels"];
  detectMachineRuntimeModelsWithAuthority(
    machineId: string,
    runtime: string,
    options?: { force?: boolean },
  ): Promise<Pick<MachineRuntimeModelDetection, "outcome" | "daemonVersion" | "computerVersion">>;
}

export interface RuntimeFormOptionSourceContext {
  sourceId: string;
  machineId: string;
  machine: { daemonVersion?: string | null; computerVersion?: string | null };
  /**
   * `?refresh=1` on the v2 endpoint (a client's retry, `option_source.status`,
   * or the refresh action on any source-bound field): ask the Computer again.
   * Entries pass it to the Computer as `force`, which bypasses the daemon's
   * model-list cache; the server's own last-good copy
   * (computerProbeCacheService) is only used when the Computer does not answer
   * in time.
   */
  refresh?: boolean;
  /**
   * `?formRevision=` from Definition.revision. Present: it must match the
   * server's current build or the client gets 409 form_revision_stale and
   * refetches the whole form.
   */
  formRevision?: string;
  /**
   * task #10: the client's advertised capabilities (`?clientCapabilities=`).
   * Without `dependent_select.custom_value_with_options` a preset provider that
   * takes a typed id is served list-only, exactly as before.
   */
  clientCapabilities?: readonly string[];
  /**
   * The Computer's model probe. The route passes a bounded one
   * (boundedRuntimeFormProbe): it answers within the replay budget from the
   * Computer or its last good answer, and throws a daemon_timeout otherwise.
   */
  agentOrchestrator: RuntimeFormModelProbe;
  /**
   * Machine-affinity routing: make sure this replica owns the Computer's
   * socket, replaying the request to the owner otherwise. "handled" means a
   * response was already sent; "confirmed_local" means `agentOrchestrator`
   * may be asked now.
   */
  routeToComputer(): Promise<MachineLocalRoutingResult>;
}

/**
 * An option-source response body. The additive fields are sent only to forms
 * that list the matching capability: `customValueAllowed` (`select.custom_value`)
 * and `status`/`reason`/`retryable` (`option_source.status`).
 */
export type RuntimeFormV2OptionSourceBody = AgentCreateFormOptionSource & {
  customValueAllowed?: boolean;
  status?: RuntimeFormV2OptionSourceStatus;
  reason?: RuntimeFormV2OptionSourceReason;
  retryable?: boolean;
  /** With `status` only (runtimeFormV2SourceStatus.optionSourceWithProbeState). */
  state?: Exclude<ComputerProbeState, "ok">;
  fetchedAt?: string;
  /** Live model selects only (unavailableModelOptions). */
  unavailableOptions?: RuntimeFormV2UnavailableOption[];
};

export type RuntimeFormOptionSourceResolution =
  /** null: the runtime has no source by that id (404 unknown_option_source). */
  | { kind: "source"; source: RuntimeFormV2OptionSourceBody | null }
  /** The response was already sent (replayed to another replica). */
  | { kind: "handled" }
  | { kind: "reply"; status: number; body: Record<string, unknown> };

function sourceHasOptions(source: AgentCreateFormOptionSource): boolean {
  return source.kind === "dependent_select"
    ? Object.values(source.optionsByValue).some((options) => options.length > 0)
    : "options" in source && source.options.length > 0;
}

/** A v2 source that fails closed: no options, the reason, and whether a retry can help. */
function unavailableSource(source: AgentCreateFormOptionSource, reason: RuntimeFormV2OptionSourceReason): RuntimeFormV2OptionSourceBody {
  const empty = source.kind === "dependent_select"
    ? { ...source, optionsByValue: {} }
    : { ...source, options: [], defaultValue: "" } as AgentCreateFormOptionSource;
  return { ...empty, ...optionSourceStatusFields(reason, false) };
}

export type FormValuesBuildResult =
  | { ok: true; runtimeConfig: Record<string, unknown>; formDefinitionRef: RuntimeFormV2SubmitRef }
  | { ok: false; issue: AgentCreateFormIssue; message?: string };

type RuntimeConfigBuild =
  | { ok: true; runtimeConfig: Record<string, unknown> }
  | { ok: false; issue: AgentCreateFormIssue; message?: string };

/** A runtimeConfig value the server keeps but never sends to a client. */
export interface RuntimeConfigWriteOnlySecret {
  /** Where the secret sits in runtimeConfig, e.g. ["provider", "apiKey"]. */
  path: readonly [string, ...string[]];
  /**
   * An update that omits the secret keeps the stored one only while it would
   * still authenticate the same thing (same provider, same endpoint, ...).
   */
  keepsIdentity(incoming: Record<string, unknown>, existing: Record<string, unknown>): boolean;
  /**
   * The v2 form field carrying the secret and the form fields keepsIdentity
   * depends on, sent on edit as `writeOnlyKeepRequiresUnchanged` so a client
   * asks for a new secret before submit. Must name exactly what keepsIdentity
   * checks (runtimeFormV2WriteOnlyKeep.test.ts); its comparison (trim, then
   * trailing slashes removed) must not be stricter than the client's.
   */
  form?: { field: string; keepRequiresUnchanged: readonly string[] };
  /**
   * Whether this stored config carries the secret at all. Where it does, reads
   * always show the key as "" (present, blank), matching the pre-registry
   * output for released clients even when nothing is stored.
   */
  appliesTo(config: Record<string, unknown>): boolean;
  /**
   * Whether the v1 agent read (withAgentProjection: GET /api/agents and
   * /api/agents/:id) blanks it too. Default true. False only where released
   * clients read the secret back from that response to save it again; the v2
   * edit values never carry it either way.
   */
  redactOnAgentRead?: boolean;
}

export interface RuntimeFormValuesOptions {
  editing?: boolean;
  /**
   * Edit only: the agent's stored runtimeConfig, for values the form does not
   * show but the saved config keeps.
   */
  existing?: RuntimeConfig | null;
}

export interface RuntimeFormV2Entry {
  runtimeId: string;
  /** The form served on v2 create, and the base of the v2 edit response. */
  buildForm(): RuntimeFormV2Definition;
  /** Self-check of the served projection; any issue is a 500 drift. */
  validateProjection(): AgentCreateFormIssue[];
  resolveOptionSource(context: RuntimeFormOptionSourceContext): Promise<RuntimeFormOptionSourceResolution>;
  /**
   * Submitted field values → runtimeConfig. `envVars` is already read from the
   * values. The result then goes through the same validation as any request.
   */
  runtimeConfigFromValues(
    values: Record<string, unknown>,
    envVars: Record<string, string> | null,
    options: RuntimeFormValuesOptions,
  ): RuntimeConfigBuild;
  /**
   * Stored runtimeConfig → field values for edit; writeOnly fields never
   * included. Null: not editable here.
   */
  valuesFromRuntimeConfig(runtimeConfig: Record<string, unknown>): Record<string, unknown> | null;
  writeOnlySecrets?: readonly RuntimeConfigWriteOnlySecret[];
  /**
   * v2 submit only: reconcile the validated runtimeConfig with the Computer's
   * live model list (reconcileRuntimeFormV2SubmissionWithLiveModels). Absent:
   * the static validation is final.
   */
  reconcileWithLiveModels?(
    runtimeConfig: RuntimeConfig,
    submittedReasoningEffort: string | null,
    models: readonly RuntimeModelInfo[],
    /** Edit only: the effort the agent has saved now (same runtime), else null. */
    storedReasoningEffort?: string | null,
    /** Edit only: the fast tier the agent has saved now (same runtime), else null. */
    storedServiceTier?: string | null,
  ): LiveModelReconciliation;
}

export type LiveModelReconciliation =
  | { kind: "unchanged" }
  | { kind: "updated"; runtimeConfig: RuntimeConfig }
  | { kind: "rejected"; issue: AgentCreateFormIssue };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const formValueIssue = (code: string, key: string): RuntimeConfigBuild =>
  ({ ok: false, issue: { code, pointer: `/formValues/${key}` } });

/**
 * #proj-runtime:#50: the form's model limits (strings; blank or absent: not
 * set), parsed and bounded like `RuntimeConfig.model`. Only a model stored as
 * custom takes them: a gateway's, or (task #10) any model on a preset provider
 * that takes a typed id. Anything set on another preset model is refused.
 */
function readModelLimitValues(
  values: Record<string, unknown>,
  customModel: boolean,
): { ok: true; limits: { contextWindow?: number; maxOutputTokens?: number } } | { ok: false; build: RuntimeConfigBuild } {
  const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
  for (const field of BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS) {
    const raw = values[field];
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/[_,\s]/g, "") : "";
    if (!text) continue;
    if (!customModel) return { ok: false, build: formValueIssue("model_limit_not_allowed", field) };
    if (!/^[0-9]+$/.test(text)) return { ok: false, build: formValueIssue("model_limit_invalid", field) };
    const value = Number(text);
    const max = field === "contextWindow" ? CUSTOM_MODEL_CONTEXT_WINDOW_MAX : CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX;
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) return { ok: false, build: formValueIssue("model_limit_invalid", field) };
    limits[field] = value;
  }
  if (limits.contextWindow !== undefined && limits.maxOutputTokens !== undefined && limits.maxOutputTokens > limits.contextWindow) {
    return { ok: false, build: formValueIssue("model_limit_invalid", "maxOutputTokens") };
  }
  return { ok: true, limits };
}

/** Whether the form carries any model limit (non-blank), i.e. an explicit override. */
function hasModelLimitValues(values: Record<string, unknown>): boolean {
  return BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS.some((field) => {
    const raw = values[field];
    return typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");
  });
}

/**
 * task #10: the Model value an edit shows. A typed model on a preset provider
 * whose Pi id is a catalog model (a listed model saved with limit overrides)
 * shows as that listed model, with its limits in their fields; re-saving
 * builds the same config, and clearing both limits saves the preset.
 */
function listedModelValueOf(providerId: string, runtimeConfig: Record<string, unknown>): string {
  const model = isPlainRecord(runtimeConfig.model) ? runtimeConfig.model : null;
  if (model?.kind === "custom" && typeof model.name === "string" && isBuiltInRuntimeCustomModelPresetProviderId(providerId)) {
    const catalogId = `${providerId}/${model.name}`;
    if ((PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).some((candidate) => candidate.id === catalogId)) return catalogId;
  }
  return modelValueOf(runtimeConfig);
}

/** The form values of a stored custom model's limits (strings, as the form fields are). */
function modelLimitValuesOf(runtimeConfig: Record<string, unknown>): { contextWindow?: string; maxOutputTokens?: string } {
  const model = isPlainRecord(runtimeConfig.model) && runtimeConfig.model.kind === "custom" ? runtimeConfig.model : null;
  if (!model) return {};
  return {
    ...(typeof model.contextWindow === "number" ? { contextWindow: String(model.contextWindow) } : {}),
    ...(typeof model.maxOutputTokens === "number" ? { maxOutputTokens: String(model.maxOutputTokens) } : {}),
  };
}

function readEnvVars(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([key]) => key.trim() !== "");
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : null;
}

function modelValueOf(runtimeConfig: Record<string, unknown>): string {
  const model = isPlainRecord(runtimeConfig.model) ? runtimeConfig.model : {};
  return typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
}

const envVarsOf = (runtimeConfig: Record<string, unknown>) =>
  isPlainRecord(runtimeConfig.envVars) ? runtimeConfig.envVars : {};

/**
 * The Built-in model a submit stores for a provider. A gateway always
 * stores a custom model. On a preset provider that takes a typed id (task
 * #10) the limits are explicit overrides for any model: a listed model
 * without one is its preset; a listed model with one is a custom model named
 * by its Pi id (the catalog id minus Raft's `<provider>/`); an unlisted typed
 * id is custom. The shared parser applies the same rule to every write path
 * (normalizeBuiltInPresetCustomModel). `modelSource` is the static model
 * source; the target Computer's catalog is checked by the route.
 */
function builtInModelFromValues(
  providerId: string,
  gateway: boolean,
  modelValue: string,
  values: Record<string, unknown>,
  effort: string | null,
  modelSource: Extract<AgentCreateFormOptionSource, { kind: "dependent_select" }>,
): { ok: true; model: RuntimeModelConfig } | { ok: false; build: RuntimeConfigBuild } {
  const refuse = (code: string, key: string) => ({ ok: false as const, build: formValueIssue(code, key) });
  const customAllowed = modelSource.customValueAllowedByValue[providerId] === true;
  const listed = (modelSource.optionsByValue[providerId] ?? []).some((candidate) => candidate.value === modelValue);
  if (!customAllowed && !listed) return refuse("select_valid_provider_model", "model");
  const presetTypable = !gateway && customAllowed && isBuiltInRuntimeCustomModelPresetProviderId(providerId);
  const listedOverride = presetTypable && listed && hasModelLimitValues(values);
  const customModel = gateway || (presetTypable && (!listed || listedOverride));
  if (!gateway && !listed && !customModel) return refuse("select_valid_provider_model", "model");
  // A typed id runs with reasoning only where the provider's catalog says
  // every model reasons (builtInPresetTypedModelReasons); elsewhere an
  // effort would be clamped to off without a word, so it is refused.
  if (presetTypable && !listed && effort !== null && !builtInPresetTypedModelReasons(providerId)) {
    return refuse("reasoning_effort_not_supported", "reasoningEffort");
  }
  const limits = readModelLimitValues(values, customModel);
  if (!limits.ok) return limits;
  if (!customModel) return { ok: true, model: { kind: "preset", id: modelValue } };
  const name = listedOverride ? builtInPresetProviderModelId(providerId, modelValue) : modelValue;
  return { ok: true, model: { kind: "custom", name, ...limits.limits } };
}

/** #proj-runtime:#50: the Built-in form's optional model limits, keyed as on `RuntimeConfig.model`. */
const BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS = ["contextWindow", "maxOutputTokens"] as const;

/** The providers the limit fields show for: every gateway, plus the given preset providers that take a typed id. */
function builtInModelLimitProviderIds(typedPresetProviderIds: Iterable<string>): string[] {
  return [
    ...Object.keys(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
    ...[...typedPresetProviderIds].filter((providerId) => isBuiltInRuntimeCustomModelPresetProviderId(providerId)),
  ];
}

/**
 * task #10: the Built-in v2 definition for one Computer. The limit fields show
 * for a preset provider only when that Computer runs a typed id for it (its
 * catalog's customModelProviderIds, as the filtered model source reports):
 * on an older Computer, a listed model of such a provider with a limit would be a
 * custom model it cannot run, so the fields are hidden there and the save is
 * refused (builtin_custom_model_upgrade_required) anyway.
 */
export function withBuiltInModelLimitVisibility(
  form: RuntimeFormV2Definition,
  typedPresetProviderIds: Iterable<string>,
): RuntimeFormV2Definition {
  const fields = new Set<string>(BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS.map((field) => `/${field}`));
  const visibleFor = builtInModelLimitProviderIds(typedPresetProviderIds);
  return {
    ...form,
    uiSchema: {
      ...form.uiSchema,
      visibility: (form.uiSchema?.visibility ?? []).map((rule) => fields.has(rule.pointer)
        ? { ...rule, when: { ...rule.when, in: visibleFor } }
        : rule),
    },
  };
}

/**
 * #proj-runtime:#53: the hints link the public page on how a gateway reports
 * both limits in its model list (also linked from
 * packages/daemon/src/gatewayModelLimits.ts) as an inline Markdown link, the
 * only markup v2 hints carry; the copy tables link the localized page.
 */
const BUILTIN_CONTEXT_WINDOW_HINT =
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)";
const BUILTIN_MAX_OUTPUT_TOKENS_HINT =
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)";

const builtinEntry: RuntimeFormV2Entry = {
  runtimeId: "builtin",
  // v2-only copy lives here, never in the v1 definition: changing that would
  // force a schemaVersion bump that breaks every installed app still on v1
  // (packages/runtime-form/README.md, "Bumping a version"). Only v2 clients
  // show a hint under the Built-in Pi model field.
  buildForm() {
    const form = toRuntimeFormV2(buildBuiltInPiFormDefinition());
    // Pi accepts the same thinking levels for every provider/model and clamps
    // them at launch. Keep this optional v2 field off the frozen v1 definition.
    form.dataSchema.properties.reasoningEffort = {
      type: "string",
      title: "Reasoning",
      "x-optionSource": "reasoningEffort",
    };
    form.optionSources!.reasoningEffort = {
      kind: "select",
      sourceId: "reasoningEffort",
      pointer: "/reasoningEffort",
    };
    form.uiSchema!.order!.splice(form.uiSchema!.order!.indexOf("model") + 1, 0, "reasoningEffort");
    // #proj-runtime:#50: a model's optional limits (v2 only), as explicit
    // overrides. Shown for a gateway and (task #10) for a preset provider that
    // takes a typed id, where they apply to a listed model too; the
    // definition route narrows that to the providers the target Computer runs
    // one for (withBuiltInModelLimitVisibility). In Advanced: by the v2
    // renderer convention Advanced starts open whenever a visible field in it
    // has a value (a saved agent's, or one set in the form), so a value that
    // takes effect is never collapsed out of sight.
    // Text fields: the v2 renderer has no integer kind; the submit mapping
    // parses and bounds them.
    form.uiSchema!.layout = {
      ...form.uiSchema!.layout,
      advanced: [
        ...BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS.map((field) => `/${field}`),
        ...(form.uiSchema!.layout?.advanced ?? []),
      ],
    };
    for (const field of BUILTIN_GATEWAY_MODEL_LIMIT_FIELDS) {
      form.dataSchema.properties[field] = { type: "string", title: field === "contextWindow" ? "Context window (tokens)" : "Max output tokens" };
      form.uiSchema!.order!.splice(form.uiSchema!.order!.indexOf("loadLocalPlugins"), 0, field);
      form.uiSchema!.visibility = [
        ...(form.uiSchema!.visibility ?? []),
        { pointer: `/${field}`, when: { pointer: "/providerId", in: builtInModelLimitProviderIds(BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS) } },
      ];
    }
    const uiSchema = form.uiSchema ?? {};
    const localization = uiSchema.localization ?? {};
    localization.reasoningEffort = {
      label: "Reasoning",
    };
    localization.contextWindow = {
      label: "Context window (tokens)",
      placeholder: "200000",
      hint: BUILTIN_CONTEXT_WINDOW_HINT,
    };
    localization.maxOutputTokens = {
      label: "Max output tokens",
      placeholder: "8192",
      hint: BUILTIN_MAX_OUTPUT_TOKENS_HINT,
    };
    localization.model = {
      ...localization.model,
      hint: "Pick a model from the list. Where the provider allows it, you can also type a model ID.",
    };
    uiSchema.localization = localization;
    form.uiSchema = uiSchema;
    return form;
  },
  validateProjection: () => validateBuiltInPiDefinitionProjection(),
  async resolveOptionSource(context) {
    // Form-consistency gate (contract, Definition.revision): a v2 form carries
    // no revision any more (only the retired saved provider connections gave
    // it one), so a revisioned v2 request comes from a form served before
    // that and must refetch the whole form. A v3 request's revision is
    // checked by the route (runtimeFormV3Revision).
    if (context.formRevision !== undefined && !(context.clientCapabilities ?? []).includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY)) {
      return {
        kind: "reply",
        status: 409,
        body: {
          error: "Runtime form has changed; refetch it before loading options",
          code: "form_revision_stale",
          recovery: "refetch_form",
        },
      };
    }
    if (context.sourceId === "reasoningEffort") {
      return {
        kind: "source",
        source: {
          protocolVersion: 1,
          runtimeId: "builtin",
          schemaVersion: buildBuiltInPiFormDefinition().schemaVersion,
          kind: "select",
          sourceId: "reasoningEffort",
          pointer: "/reasoningEffort",
          options: [
            { value: "", label: "Default" },
            ...PI_REASONING_EFFORTS.map((value) => ({
              value,
              label: REASONING_EFFORTS.find((effort) => effort.id === value)!.label,
            })),
          ],
          defaultValue: "",
        },
      };
    }
    // Offline or unreachable Computer: the bundled catalog, so the form stays
    // usable. Starting the agent still checks the Computer's own catalog
    // (agentOrchestrator, builtin_catalog_*), so an unsupported pick fails there.
    const forClient = async (
      sourceIn: AgentCreateFormOptionSource | null,
    ): Promise<RuntimeFormOptionSourceResolution> => {
      // task #10: a client that does not advertise
      // dependent_select.custom_value_with_options would render a listed
      // provider that takes a typed id as a blank text box (losing the
      // default): it gets that provider list-only, as before.
      const source = sourceIn && !clientRendersDependentCustomWithOptions(context.clientCapabilities)
        ? builtInPiListOnlyOptionSource(sourceIn)
        : sourceIn;
      return { kind: "source", source };
    };
    // Only the model source carries a status (v2): the provider select is static.
    const withStatus = (source: AgentCreateFormOptionSource | null, reason: RuntimeFormV2OptionSourceReason | null) =>
      source && context.sourceId === "model"
        ? { ...source, ...optionSourceStatusFields(reason, sourceHasOptions(source)) }
        : source;
    const bundled = (reason: RuntimeFormV2OptionSourceReason) =>
      forClient(withStatus(buildBuiltInPiFormOptionSource(context.sourceId), reason));
    const routing = await context.routeToComputer();
    if (routing === "handled") return { kind: "handled" };
    if (routing !== "confirmed_local") return bundled("machine_offline");
    let detection;
    try {
      detection = await context.agentOrchestrator.detectMachineRuntimeModelsWithAuthority(context.machineId, "builtin", { force: context.refresh === true });
    } catch (error) {
      if (!(error instanceof RouteFailureError)) throw error;
      return bundled(optionSourceReasonForProbeError(error));
    }
    // A probe that answered without the catalog fails closed per source:
    // `unavailable` with the reason and no options. A live answer without a
    // catalog stays the typed 409 builtin_catalog_capability_required: that
    // Computer must be upgraded before any Built-in model can run.
    if (context.sourceId === "model" && detection.outcome.kind !== "live") {
      const source = buildBuiltInPiFormOptionSource(context.sourceId);
      return forClient(source && unavailableSource(source, optionSourceReasonForOutcome(detection.outcome) ?? "probe_failed"));
    }
    const catalog = requireBuiltInCatalogCapability(detection.outcome, {
      machineId: context.machineId,
      daemonVersion: detection.daemonVersion,
      computerVersion: detection.computerVersion,
    });
    const unfilteredSource = buildBuiltInPiFormOptionSource(context.sourceId);
    const source = unfilteredSource
      ? filterBuiltInPiFormOptionSourceForCatalog(unfilteredSource, catalog.supportedModelIds, catalog.customModelProviderIds)
      : null;
    return forClient(withStatus(source, null));
  },
  runtimeConfigFromValues(values, envVars, options) {
    const effort = piEffort(values, "reasoningEffort");
    if (!effort.ok) return effort;
    if (effort.value !== null && !PI_REASONING_EFFORTS.includes(effort.value as typeof PI_REASONING_EFFORTS[number])) {
      return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
    }
    const provider = buildBuiltInPiFormOptionSource("provider");
    const model = buildBuiltInPiFormOptionSource("model");
    if (provider?.kind !== "select" || model?.kind !== "dependent_select") {
      return { ok: false, issue: { code: "option_sources_invalid", pointer: "/formValues" } };
    }
    const providerId = typeof values.providerId === "string" ? values.providerId : "";
    const option = provider.options.find((candidate) => candidate.value === providerId);
    if (!option) return formValueIssue("select_valid_provider", "providerId");
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    // writeOnly fields are never sent to a client, so on edit a blank one means
    // "keep the stored value"; the PATCH path retains it (and refuses when the
    // provider changed). This follows capabilities.writeOnlyPointers, not the name.
    const apiKeyMayBeBlank = options.editing === true
      && buildBuiltInPiFormDefinition().capabilities.writeOnlyPointers.includes("/apiKey");
    if (!apiKey && !apiKeyMayBeBlank) return formValueIssue("api_key_required", "apiKey");
    const modelValue = typeof values.model === "string" ? values.model.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "model");
    const gateway = option.providerKind === "gateway";
    const decided = builtInModelFromValues(providerId, gateway, modelValue, values, effort.value, model);
    if (!decided.ok) return decided.build;
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl.trim() : "";
    if (gateway && !/^https?:\/\//i.test(baseUrl)) return formValueIssue("base_url_invalid", "baseUrl");
    return {
      ok: true,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: gateway
          ? { kind: "gateway", providerId, baseUrl, ...(apiKey ? { apiKey } : {}), supportsImageInput: values.supportsImageInput === true }
          : { kind: "preset", providerId, ...(apiKey ? { apiKey } : {}) },
        model: decided.model,
        mode: { kind: "default" },
        reasoningEffort: effort.value,
        envVars,
        hostUserState: "forbidden",
        loadLocalPlugins: values.loadLocalPlugins === true,
      },
    };
  },
  valuesFromRuntimeConfig(runtimeConfig) {
    const reasoningEffort = typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "";
    const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
    // An older row hydrated without a provider (none stored, no provider key
    // among its env vars) still opens: the provider is blank and must be
    // chosen, as on create. Edit has no v1 fallback any more (task #8).
    if (!provider || (provider.kind !== "preset" && provider.kind !== "gateway")) {
      return {
        providerId: "",
        model: modelValueOf(runtimeConfig),
        reasoningEffort,
        loadLocalPlugins: runtimeConfig.loadLocalPlugins === true,
        envVars: envVarsOf(runtimeConfig),
      };
    }
    return {
      providerId: typeof provider.providerId === "string" ? provider.providerId : "",
      ...(provider.kind === "gateway"
        ? { baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "", supportsImageInput: provider.supportsImageInput === true, ...modelLimitValuesOf(runtimeConfig) }
        // A preset provider's typed model (task #10) keeps its limits; a preset model has none.
        : modelLimitValuesOf(runtimeConfig)),
      model: provider.kind === "preset" && typeof provider.providerId === "string"
        ? listedModelValueOf(provider.providerId, runtimeConfig)
        : modelValueOf(runtimeConfig),
      reasoningEffort,
      loadLocalPlugins: runtimeConfig.loadLocalPlugins === true,
      envVars: envVarsOf(runtimeConfig),
    };
  },
  writeOnlySecrets: [
    {
      // Omitting the provider secret keeps it only while runtime, provider kind,
      // provider id and (for a gateway) base URL are unchanged. Explicit
      // blank/null values and provider switches still reach the parser and fail
      // closed; clients can never recover the retained value.
      path: ["provider", "apiKey"],
      appliesTo: (config) => isPlainRecord(config.provider),
      keepsIdentity(incoming, existing) {
        const next = incoming.provider as Record<string, unknown>;
        const saved = existing.provider as Record<string, unknown>;
        if (next.kind !== saved.kind || next.providerId !== saved.providerId) return false;
        return saved.kind !== "gateway"
          || (typeof next.baseUrl === "string" && typeof saved.baseUrl === "string" && sameApiEndpoint(next.baseUrl, saved.baseUrl));
      },
      // The provider kind follows providerId; baseUrl is shown (and stored) for a gateway only.
      form: { field: "apiKey", keepRequiresUnchanged: ["providerId", "baseUrl"] },
    },
  ],
};

const kimiSdkEntry: RuntimeFormV2Entry = {
  runtimeId: "kimi-sdk",
  buildForm: () => {
    return toRuntimeFormV2(buildKimiSdkFormDefinition());
  },
  validateProjection: () => validateKimiSdkDefinitionProjection(),
  async resolveOptionSource(context) {
    if (context.sourceId !== "model") return { kind: "source", source: null };
    // The declared managed default, offered when the Computer cannot answer
    // (v2: marked `fallback` with the reason).
    const managedDefault = (reason: RuntimeFormV2OptionSourceReason): RuntimeFormOptionSourceResolution => {
      const source = buildKimiSdkFormOptionSource({
        models: RUNTIME_MODELS["kimi-sdk"] ?? [],
        defaultModel: getDefaultModel("kimi-sdk"),
      });
      return { kind: "source", source: { ...source, ...optionSourceStatusFields(reason, true) } };
    };
    const routing = await context.routeToComputer();
    if (routing === "handled") return { kind: "handled" };
    // Offline or unreachable: the managed default, like the other runtimes'
    // bundled lists, instead of blocking the form.
    if (routing !== "confirmed_local") return managedDefault("machine_offline");
    let detected;
    try {
      detected = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, "kimi-sdk", { force: context.refresh === true });
    } catch (error) {
      if (!(error instanceof RouteFailureError)) throw error;
      return managedDefault(optionSourceReasonForProbeError(error));
    }
    if (detected.kind === "error" && detected.code === "computer_offline") return managedDefault("machine_offline");
    if (detected.kind === "missing_config") {
      // Normal first-install shape: the machine has no ~/.kimi-code/config.toml
      // yet because nothing has been provisioned. The reviewed product
      // contract already allows creation in this state (it may still fail at
      // runtime, where the user can actually fix it); the form must not
      // hard-block it. Offer the declared managed default for missing_config
      // and offline only; every other non-live outcome is `unavailable` below
      // (a hard block here was what users saw as "model list unavailable" on
      // fresh machines).
      return managedDefault("missing_config");
    }
    if (detected.kind !== "live") {
      // Fail closed, per source: no options to launch
      // with, the reason, and whether a retry can help.
      return {
        kind: "source",
        source: unavailableSource(
          buildKimiSdkFormOptionSource({ models: [], defaultModel: undefined }),
          optionSourceReasonForOutcome(detected) ?? "probe_failed",
        ),
      };
    }
    const live = buildKimiSdkFormOptionSource({ models: detected.value.models, defaultModel: detected.value.default });
    return {
      kind: "source",
      source: { ...live, ...optionSourceStatusFields(optionSourceReasonForOutcome(detected), sourceHasOptions(live)) },
    };
  },
  runtimeConfigFromValues(values, envVars) {
    const modelValue = typeof values.model === "string" ? values.model.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "model");
    const effort = values.reasoningEffort;
    if (effort !== undefined && effort !== null && typeof effort !== "string") {
      return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
    }
    return {
      ok: true,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "kimi-sdk",
        model: { kind: "preset", id: modelValue },
        mode: { kind: "default" },
        reasoningEffort: typeof effort === "string" && effort !== "" ? effort : null,
        envVars,
      },
    };
  },
  valuesFromRuntimeConfig: (runtimeConfig) => ({
    model: modelValueOf(runtimeConfig),
    reasoningEffort: typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "",
    envVars: envVarsOf(runtimeConfig),
  }),
};

/**
 * v2-only forms for runtimes the legacy web form handles with just a model
 * picker and environment variables. There is no v1 form for them: the label
 * `schemaVersion` only names the form the server built.
 */
function simpleFormRef(runtimeId: string) {
  return { protocolVersion: 1 as const, runtimeId, schemaVersion: `${runtimeId}.${isRuntimeDeprecated(runtimeId) ? "edit" : "create"}.v1` };
}

function buildSimpleForm(runtimeId: string, model: { hint?: string } | null): RuntimeFormV2Definition {
  const ref = simpleFormRef(runtimeId);
  return toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: model ? ["model"] : [],
      properties: {
        ...(model ? { model: { type: "string", title: "Model", minLength: 1 } } : {}),
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: model ? ["model", "envVars"] : ["envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [],
      localization: {
        ...(model ? { model: { label: "Model", ...(model.hint ? { hint: model.hint } : {}) } } : {}),
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: { providerKinds: [], writeOnlyPointers: [], forbiddenPointers: ["/hostUserState"] },
    optionSources: model ? { model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" } } : {},
  }, {});
}

/** The model select built from a list of models (live, or the bundled RUNTIME_MODELS fallback). */
/**
 * The models a live list from this Computer cannot offer, for
 * `OptionSource.unavailableOptions`: the ones its runtime listed but disabled
 * (with the runtime's reason, sanitized again here since the daemon's text is
 * untrusted). Raft's bundled catalog never adds entries here: when the
 * Computer provides a list, that list alone decides what is offered.
 * Compatibility: these stay out of `options`, which every older web and mobile
 * client offers as selectable; a client that ignores this field only loses the
 * hint. Empty for a non-live probe (the bundled fallback).
 */
export function unavailableModelOptions(live: RuntimeModelSet): RuntimeFormV2UnavailableOption[] {
  const usable = new Set(live.models.map((model) => model.id));
  return (sanitizeRuntimeModelUnavailable(live.unavailable) ?? [])
    .filter((model) => !usable.has(model.id))
    .map((model) => ({ value: model.id, label: model.label, ...(model.reason ? { reason: model.reason } : {}) }));
}

function withUnavailableOptions<T extends object>(source: T, unavailable: readonly RuntimeFormV2UnavailableOption[] | undefined): T {
  return unavailable?.length ? { ...source, unavailableOptions: [...unavailable] } : source;
}

function modelSelectOptionSource(
  runtimeId: string,
  models: readonly { id: string; label: string }[],
  defaultModel: string | undefined,
): AgentCreateFormOptionSource {
  const options = models.map((model) => ({ value: model.id, label: model.label }));
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "model",
    kind: "select",
    pointer: "/model",
    options,
    defaultValue: defaultModel && options.some((option) => option.value === defaultModel)
      ? defaultModel
      : (options[0]?.value ?? ""),
  };
}

/**
 * The select a live-probed runtime serves when its probe is not live: the
 * bundled RUNTIME_MODELS list, which is what the legacy web form offers in that
 * state. An empty list is an empty select; submitting then fails with
 * model_required on /formValues/model.
 */
export function staticModelFallbackOptionSource(
  runtimeId: string,
  models: readonly { id: string; label: string }[] = RUNTIME_MODELS[runtimeId] ?? [],
): AgentCreateFormOptionSource {
  return modelSelectOptionSource(runtimeId, models, undefined);
}

function simpleProjectionIssues(form: RuntimeFormV2Definition, hasModel: boolean): AgentCreateFormIssue[] {
  const properties = Object.keys(form.dataSchema.properties).sort().join("\0");
  const expected = (hasModel ? ["envVars", "model"] : ["envVars"]).join("\0");
  const sources = Object.keys(form.optionSources ?? {}).join("\0");
  if (properties !== expected || (form.dataSchema.required ?? []).join("\0") !== (hasModel ? "model" : "")) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  if (sources !== (hasModel ? "model" : "") || (hasModel && form.optionSources?.model?.pointer !== "/model")) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  return [];
}

/** The legacy web builder's shape for a runtime without provider, fast mode, reasoning or command. */
function simpleRuntimeConfig(runtimeId: string, model: Record<string, unknown>, envVars: Record<string, string> | null) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: runtimeId,
    model,
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars,
  };
}

/**
 * A runtime whose form is a model select plus environment variables. `live`:
 * options come from the Computer's model probe and fall back to the bundled
 * list whenever the probe is not live; otherwise the bundled list is the source.
 */
function modelFormEntry(runtimeId: string, options: { live: boolean; hint?: string }): RuntimeFormV2Entry {
  return {
    runtimeId,
    buildForm: () => buildSimpleForm(runtimeId, { hint: options.hint }),
    validateProjection: () => simpleProjectionIssues(buildSimpleForm(runtimeId, { hint: options.hint }), true),
    async resolveOptionSource(context) {
      if (context.sourceId !== "model") return { kind: "source", source: null };
      const fallback = { kind: "source", source: staticModelFallbackOptionSource(runtimeId) } as const;
      if (!options.live) return fallback;
      const routing = await context.routeToComputer();
      if (routing === "handled") return { kind: "handled" };
      if (routing !== "confirmed_local") return fallback;
      let detected;
      try {
        detected = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, runtimeId, { force: context.refresh === true });
      } catch {
        // Offline, timed out or failed probes keep the form usable, as legacy does.
        return fallback;
      }
      if (detected.kind !== "live" || detected.value.models.length === 0) return fallback;
      return {
        kind: "source",
        source: withUnavailableOptions(
          modelSelectOptionSource(runtimeId, detected.value.models, detected.value.default),
          unavailableModelOptions(detected.value),
        ),
      };
    },
    runtimeConfigFromValues(values, envVars) {
      // Like legacy, no custom model and no server-side list check: the probed
      // list is advisory and the runtime validates the model at launch.
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      return { ok: true, runtimeConfig: simpleRuntimeConfig(runtimeId, { kind: "preset", id: modelValue }, envVars) };
    },
    valuesFromRuntimeConfig: (runtimeConfig) => ({ model: modelValueOf(runtimeConfig), envVars: envVarsOf(runtimeConfig) }),
  };
}

/**
 * Runtimes whose form has a live model list (batch 3a: Codex, Grok; batch 3b:
 * Claude, Cursor, Copilot). Every model source says whether it is live
 * (`option_source.status`) and a reasoning effort carries `choice.labels`
 * copy; neither is listed as required. `select.custom_value` is required
 * where the legacy form offers a custom model. The legacy
 * web form (packages/web/src/components/agent/RuntimeConfigFields.tsx with
 * utils/reasoningEffortOptions.ts and utils/runtimeConfigForm.ts) is the oracle
 * for fields, options and the runtimeConfig a submit assembles.
 */
export interface ReasoningModelFormOptions {
  /** `select.custom_value`: a typed model that is not listed is stored as a custom model (supportsRuntimeCustomModelName). */
  customModel: boolean;
  /** A boolean field mapped to runtimeConfig.mode (RUNTIME_FAST_MODE_RUNTIMES). */
  fastMode: boolean;
  /**
   * #wg-runtime-form:#27/#31 (Codex, mutually exclusive with fastMode): a `speed`
   * select (Standard "", Fast "priority", Ultrafast "ultrafast", ...) shown for
   * models whose Computer lists two or more fast tiers (`serviceTierChoices`);
   * single-tier models show `fastMode`, zero-tier models hide both.
   */
  speed?: boolean;
  /**
   * A reasoning effort that follows the selected model (REASONING_EFFORT_RUNTIMES),
   * with `choice.labels` for its English copy. Cursor has none.
   */
  reasoning: boolean;
  /**
   * Claude only (supportsRuntimeApiUrl): a Default/Custom provider select with
   * an API URL and a write-only API key for Custom (runtimeConfig.provider).
   */
  customProvider?: boolean;
  /** Claude only (supportsRuntimeCommand): the executable to launch (runtimeConfig.command). */
  command?: boolean;
  /**
   * Antigravity (#oar-raft:#25): a stored model id that meant "the runtime
   * chooses" before a model was required. The edit form shows no model for
   * it, so the person picks one, and a save refuses it.
   */
  retiredRuntimeChoice?: string;
  /**
   * No bundled list, a typed model allowed: when the Computer's list cannot be
   * read, the source is a `fallback` with no options (a typed model id still
   * submits), not `unavailable` (which blocks a required field).
   */
  typedModelWhenUnlisted?: boolean;
  /**
   * DSH: the shape a model must have to launch (dsh routes by `provider/model`
   * and OAR refuses a bare name only at the start); a model that does not fit
   * is refused at the field with `message`.
   */
  modelFormat?: { valid: (model: string) => boolean; message: string };
  modelHint: string;
}

/**
 * Effort labels and descriptions in English, the source language of v2 copy;
 * runtimeFormV2Copy.ts translates them per Accept-Language. The strings are the
 * legacy web picker's en messages (agent.reasoningEffort.<id>, <id>Description),
 * which runtimeFormV2Batch3a.test.ts keeps equal; web and mobile show them as sent.
 */
const REASONING_EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  off: "Answers directly, without a thinking phase",
  minimal: "Very light reasoning for the fastest responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

export function reasoningEffortChoices(): Record<string, RuntimeFormV2ChoiceCopy> {
  return Object.fromEntries(REASONING_EFFORTS.map((effort) => [
    effort.id,
    { label: effort.label, ...(REASONING_EFFORT_DESCRIPTIONS[effort.id] ? { description: REASONING_EFFORT_DESCRIPTIONS[effort.id] } : {}) },
  ]));
}

/**
 * `choice.labels` and `option_source.status` are never listed: every client
 * that renders a v2 form implements both (web and mobile >= 1.15), and they
 * only check names here, so listing them would gate nothing.
 */
function reasoningModelCapabilities(options: ReasoningModelFormOptions): RuntimeFormV2ClientCapability[] {
  return options.customModel ? ["select.custom_value"] : [];
}

/**
 * Claude's provider choice, as the legacy select offers it. The copy is the
 * legacy web form's English (agent.runtimeConfig.default / .custom / .providerHint).
 */
const CUSTOM_PROVIDER_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "custom", label: "Custom" },
] as const;

/** How a Custom provider sends its key (ClaudeCustomProviderAuthType); the first is the default. */
const CUSTOM_PROVIDER_AUTH_TYPE_OPTIONS = [
  { value: "api_key", label: "API key (x-api-key)" },
  { value: "auth_token", label: "Bearer token (Authorization)" },
] as const;

/** Every field key of a form built with these options, in order. */
function reasoningModelFieldKeys(options: ReasoningModelFormOptions): string[] {
  return [
    ...(options.customProvider ? ["provider", "apiUrl", "authType", "apiKey"] : []),
    "model",
    ...(options.reasoning ? ["reasoningEffort"] : []),
    ...(options.fastMode ? ["fastMode"] : []),
    ...(options.speed ? ["speed"] : []),
    ...(options.command ? ["command"] : []),
    "envVars",
  ];
}

const reasoningModelRequired = (options: ReasoningModelFormOptions) =>
  // The provider is required so that a client which cannot load its (static)
  // source blocks the save instead of hiding the field and dropping a custom
  // provider. API URL and API key are shown only for Custom, so they are not in
  // `required`; the server refuses a Custom provider without them.
  options.customProvider ? ["provider", "model"] : ["model"];

function buildReasoningModelForm(runtimeId: string, options: ReasoningModelFormOptions): RuntimeFormV2Definition {
  const ref = simpleFormRef(runtimeId);
  const base = toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: reasoningModelRequired(options),
      properties: {
        ...(options.customProvider
          ? {
              provider: { type: "string", title: "Provider", minLength: 1 },
              apiUrl: { type: "string", title: "API URL", format: "uri" },
              authType: { type: "string", title: "Authentication" },
              apiKey: { type: "string", title: "API Key", writeOnly: true },
            }
          : {}),
        model: { type: "string", title: "Model", minLength: 1 },
        ...(options.reasoning ? { reasoningEffort: { type: "string", title: "Reasoning" } } : {}),
        ...(options.fastMode ? { fastMode: { type: "boolean", title: "Fast mode" } } : {}),
        ...(options.speed ? { speed: { type: "string", title: "Speed" } } : {}),
        ...(options.command ? { command: { type: "string", title: "Claude Command" } } : {}),
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: reasoningModelFieldKeys(options),
      layout: { advanced: [...(options.command ? ["/command"] : []), "/envVars"] },
      visibility: [
        ...(options.customProvider
          ? [
              { pointer: "/apiUrl", when: { pointer: "/provider", in: ["custom"] } },
              { pointer: "/authType", when: { pointer: "/provider", in: ["custom"] } },
              { pointer: "/apiKey", when: { pointer: "/provider", in: ["custom"] } },
            ]
          : []),
      ],
      localization: {
        ...(options.customProvider
          ? {
              provider: {
                label: "Provider",
                hint: "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.",
              },
              apiUrl: { label: "API URL", placeholder: "https://gateway.example.com" },
              authType: {
                label: "Authentication",
                hint: "Use Bearer token for a gateway that expects an Authorization header.",
              },
              apiKey: { label: "API Key", placeholder: "sk-ant-..." },
            }
          : {}),
        model: { label: "Model", hint: options.modelHint },
        ...(options.reasoning
          ? { reasoningEffort: { label: "Reasoning", hint: "Available values depend on the selected model." } }
          : {}),
        ...(options.fastMode
          ? { fastMode: { label: "Fast mode", hint: "Launch this runtime with higher speed at a higher cost per token." } }
          : {}),
        ...(options.speed
          ? { speed: { label: "Speed", hint: "Speeds this model offers on this computer's Codex account. Faster speeds use more of your plan." } }
          : {}),
        ...(options.command
          ? {
              command: {
                label: "Claude Command",
                hint: "Executable path or command name; Slock adds the Claude stream-json runtime arguments.",
                placeholder: "claude",
              },
            }
          : {}),
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: {
      // providerKinds names Built-in provider kinds only; Claude's choice is the provider field.
      providerKinds: [],
      writeOnlyPointers: options.customProvider ? ["/apiKey"] : [],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      ...(options.customProvider
        ? {
            provider: { ...ref, sourceId: "provider", kind: "select", pointer: "/provider" },
            authType: { ...ref, sourceId: "authType", kind: "select", pointer: "/authType" },
          }
        : {}),
      model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" },
      ...(options.speed ? { speed: { ...ref, sourceId: "speed", kind: "dependent_select", pointer: "/speed", dependsOn: "/model" } } : {}),
    },
  }, options.reasoning
    ? { reasoningEffort: { field: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" } }
    : {});
  if (options.reasoning) {
    const localization = base.uiSchema?.localization ?? {};
    localization.reasoningEffort = { ...localization.reasoningEffort, choices: reasoningEffortChoices() };
  }
  const { protocolVersion, runtimeId: id, schemaVersion, ...rest } = base;
  return { protocolVersion, runtimeId: id, schemaVersion, requiredClientCapabilities: reasoningModelCapabilities(options), ...rest };
}

/**
 * A model's effort metadata as the legacy picker resolves it
 * (reasoningEffortOptionsForModel): a live entry that declares efforts wins,
 * even an empty set (the model takes none), else the bundled entry for the
 * same id, else the live entry. Every option carries its efforts: the declared
 * set in catalog order (unknown ids dropped), or the BASE set for a model that
 * declares none, which is what the server's static rule
 * (allowedReasoningEffortsForModel) accepts for it.
 */
function reasoningModelOption(
  runtimeId: string,
  model: RuntimeModelInfo,
): AgentCreateFormOption {
  const bundled = RUNTIME_MODELS[runtimeId]?.find((candidate) => candidate.id === model.id);
  const info = Array.isArray(model.supportedReasoningEfforts) ? model : bundled ?? model;
  const declared = Array.isArray(info.supportedReasoningEfforts) ? info.supportedReasoningEfforts : null;
  // None where the runtime applies only listed levels (runtimeOffersUndeclaredReasoningEfforts).
  const undeclared = runtimeOffersUndeclaredReasoningEfforts(runtimeId) ? defaultReasoningEffortsForRuntime(runtimeId) : [];
  const efforts = REASONING_EFFORTS
    .map((effort) => effort.id)
    .filter((id) => (declared ? declared.includes(id) : undeclared.includes(id)))
    .filter((id) => isReasoningEffortOfferedOnRuntime(runtimeId, id));
  const defaultEffort = declared && info.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort as never)
    ? info.defaultReasoningEffort
    : undefined;
  // Why an empty menu is empty, so the form can say so instead of hiding the
  // field (additive; an empty menu with neither stays "not reported", e.g. an
  // older Computer): the Computer could not read the levels, or the runtime
  // declared that the model takes none.
  const unreadableReason = efforts.length === 0 && !declared
    ? sanitizeRuntimeEffortUnavailableReason(model.reasoningEffortUnavailableReason)
    : undefined;
  return {
    value: model.id,
    label: model.label,
    supportedReasoningEfforts: efforts,
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(unreadableReason ? { reasoningEffortUnavailableReason: unreadableReason } : {}),
    ...(efforts.length === 0 && declared?.length === 0 ? { reasoningEffortNone: true } : {}),
  };
}

/**
 * The model source of a live-list form: the live list when the probe is live,
 * else the bundled RUNTIME_MODELS list (legacy does the same) marked `fallback`
 * with the reason, or `unavailable` with no options when there is no bundled
 * list. Options carry their efforts only on a form with a reasoning effort.
 */
export function reasoningModelOptionSource(
  runtimeId: string,
  models: readonly RuntimeModelInfo[],
  defaultModel: string | undefined,
  reason: RuntimeFormV2OptionSourceReason | null,
  options: Pick<ReasoningModelFormOptions, "customModel"> & { reasoning?: boolean },
  /** Live probes only (unavailableModelOptions); never on the bundled fallback. */
  unavailable?: readonly RuntimeFormV2UnavailableOption[],
): RuntimeFormV2OptionSourceBody {
  const select = modelSelectOptionSource(runtimeId, models, defaultModel);
  const listed = options.reasoning === false
    ? select
    : { ...select, options: models.map((model) => reasoningModelOption(runtimeId, model)) } as AgentCreateFormOptionSource;
  return withUnavailableOptions({
    ...listed,
    ...(options.customModel ? { customValueAllowed: true } : {}),
    ...optionSourceStatusFields(reason, models.length > 0),
  }, unavailable);
}

/**
 * Claude's provider select: static, so it has no `status` (that describes a
 * probed list) and never allows a typed value.
 */
function customProviderOptionSource(runtimeId: string): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "provider",
    kind: "select",
    pointer: "/provider",
    options: CUSTOM_PROVIDER_OPTIONS.map((option) => ({ ...option })),
    defaultValue: "default",
    customValueAllowed: false,
  };
}

/** Claude's Custom authentication select: static, like the provider select. */
function customProviderAuthTypeOptionSource(runtimeId: string): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "authType",
    kind: "select",
    pointer: "/authType",
    options: CUSTOM_PROVIDER_AUTH_TYPE_OPTIONS.map((option) => ({ ...option })),
    defaultValue: "api_key",
    customValueAllowed: false,
  };
}

type ModelProbe =
  | { kind: "handled" }
  | { kind: "live"; models: readonly RuntimeModelInfo[]; default?: string; unavailable: RuntimeFormV2UnavailableOption[] }
  | { kind: "not_live"; reason: RuntimeFormV2OptionSourceReason };

async function probeModels(context: RuntimeFormOptionSourceContext, runtimeId: string): Promise<ModelProbe> {
  const routing = await context.routeToComputer();
  if (routing === "handled") return { kind: "handled" };
  if (routing !== "confirmed_local") return { kind: "not_live", reason: "machine_offline" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    outcome = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, runtimeId, { force: context.refresh === true });
  } catch (error) {
    return { kind: "not_live", reason: optionSourceReasonForProbeError(error) };
  }
  const reason = optionSourceReasonForOutcome(outcome);
  if (reason !== null || outcome.kind !== "live") return { kind: "not_live", reason: reason ?? "probe_failed" };
  return {
    kind: "live",
    models: outcome.value.models,
    default: outcome.value.default,
    unavailable: unavailableModelOptions(outcome.value),
  };
}

function reasoningModelProjectionIssues(form: RuntimeFormV2Definition, options: ReasoningModelFormOptions): AgentCreateFormIssue[] {
  const expected = [...reasoningModelFieldKeys(options)].sort().join("\0");
  if (
    Object.keys(form.dataSchema.properties).sort().join("\0") !== expected
    || (form.dataSchema.required ?? []).join("\0") !== reasoningModelRequired(options).join("\0")
  ) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  const sources = [...(options.customProvider ? ["provider", "authType"] : []), "model", ...(options.speed ? ["speed"] : [])].join("\0");
  if (
    Object.keys(form.optionSources ?? {}).join("\0") !== sources
    || form.optionSources?.model?.pointer !== "/model"
    || (options.customProvider && form.optionSources?.provider?.pointer !== "/provider")
    || (options.customProvider && form.optionSources?.authType?.pointer !== "/authType")
  ) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  if ((form.requiredClientCapabilities ?? []).join("\0") !== reasoningModelCapabilities(options).join("\0")) {
    return [{ code: "definition_capabilities_drift", pointer: "/requiredClientCapabilities" }];
  }
  return [];
}

/** The same base URL, ignoring surrounding whitespace and trailing slashes. */
function sameApiEndpoint(a: string, b: string): boolean {
  const endpoint = (url: string) => url.trim().replace(/\/+$/, "");
  return endpoint(a) === endpoint(b);
}

/**
 * Claude's custom-provider API key: write-only on both the v2 form and the v1
 * agent read (`GET /api/agents[/:id]` blanks it to `""`; web and mobile 1.24+
 * edit through `GET /api/agents/:id/runtime-form`, and legacy v1 PATCHes with a
 * blank key keep the stored one via `retainLegacyBlankWriteOnlySecrets`).
 */
const CLAUDE_CUSTOM_PROVIDER_API_KEY: RuntimeConfigWriteOnlySecret = {
  path: ["provider", "apiKey"],
  appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind === "custom",
  keepsIdentity(incoming, existing) {
    const next = isPlainRecord(incoming.provider) ? incoming.provider : {};
    const saved = isPlainRecord(existing.provider) ? existing.provider : {};
    return next.kind === "custom" && saved.kind === "custom"
      && typeof next.apiUrl === "string" && typeof saved.apiUrl === "string"
      && sameApiEndpoint(next.apiUrl, saved.apiUrl);
  },
  form: { field: "apiKey", keepRequiresUnchanged: ["provider", "apiUrl"] },
  redactOnAgentRead: true,
};

type ProviderBuild =
  | { ok: true; provider: Record<string, unknown> }
  | { ok: false; issue: AgentCreateFormIssue };

/** The legacy builder's Claude provider (buildRuntimeConfig, supportsRuntimeApiUrl). */
function customProviderFromValues(
  runtimeId: string,
  values: Record<string, unknown>,
  options: RuntimeFormValuesOptions,
): ProviderBuild {
  const mode = typeof values.provider === "string" ? values.provider.trim() : "";
  if (mode === "default") return { ok: true, provider: { kind: "default" } };
  if (mode !== "custom") return formValueIssue("select_valid_provider", "provider") as ProviderBuild;
  const apiUrl = typeof values.apiUrl === "string" ? values.apiUrl.trim() : "";
  if (!/^https?:\/\//i.test(apiUrl)) return formValueIssue("api_url_invalid", "apiUrl") as ProviderBuild;
  // Blank or absent means API key: the select's default, and what a v2 client
  // sends when the user leaves it. (v1 writes, which never carry the field,
  // keep a stored choice in retainOmittedClaudeAuthType instead.)
  const authType = values.authType === undefined || values.authType === null || values.authType === ""
    ? "api_key"
    : values.authType;
  if (authType !== "api_key" && authType !== "auth_token") {
    return formValueIssue("select_valid_auth_type", "authType") as ProviderBuild;
  }
  const auth = authType === "auth_token" ? { authType } : {};
  const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
  if (apiKey) return { ok: true, provider: { kind: "custom", apiUrl, apiKey, ...auth } };
  // A blank write-only key on edit means "keep the stored one": omit it so the
  // PATCH path (retainOmittedWriteOnlySecrets) restores it. Only while it would
  // still authenticate the same endpoint; otherwise ask for a key here instead
  // of failing later without a field pointer.
  const existing = options.existing;
  const provider = { kind: "custom", apiUrl, ...auth };
  if (
    options.editing === true
    && existing?.runtime === runtimeId
    && CLAUDE_CUSTOM_PROVIDER_API_KEY.keepsIdentity({ provider }, existing as unknown as Record<string, unknown>)
  ) {
    return { ok: true, provider };
  }
  return formValueIssue("api_key_required", "apiKey") as ProviderBuild;
}

/**
 * #wg-runtime-form:#31: the fast tiers a live Codex model declares, with
 * non-fast tiers (`default`, `flex`) and malformed ids dropped.
 */
export function fastServiceTiersOf(model: RuntimeModelInfo | undefined): RuntimeServiceTierChoice[] {
  return (model?.serviceTierChoices ?? []).filter(
    (choice) => isRuntimeServiceTierId(choice.id) && !CODEX_NON_FAST_SERVICE_TIERS.has(choice.id),
  );
}

/**
 * #wg-runtime-form:#27/#31: the fast tiers a live model offers for the `speed`
 * dropdown, primary first; empty unless the Computer named two or more and the
 * first is Codex's primary tier (a model with one fast tier uses the `fastMode`
 * checkbox; an older Computer names none and uses `fastMode`).
 */
export function offeredServiceTiers(model: RuntimeModelInfo | undefined): RuntimeServiceTierChoice[] {
  const choices = fastServiceTiersOf(model);
  return choices.length >= 2 && choices[0]!.id === CODEX_PRIMARY_FAST_SERVICE_TIER ? choices : [];
}

/**
 * #wg-runtime-form:#31: whether a live Codex model explicitly disallows fast
 * mode (either statically unsupported or declared `serviceTierChoices` with
 * zero fast tiers). Both `fastMode` and `speed` stay hidden for such models.
 */
export function codexModelDisallowsFastMode(model: RuntimeModelInfo): boolean {
  if (!runtimeModelSupportsFastMode("codex", model.id)) return true;
  return Array.isArray(model.serviceTierChoices) && fastServiceTiersOf(model).length === 0;
}

/**
 * #wg-runtime-form:#31: shape Codex's served form for one Computer's live model
 * list so `fastMode` (checkbox) and `speed` (Standard / Fast / Ultrafast menu)
 * are mutually exclusive per model, and neither appears for a model declaring
 * zero fast tiers:
 * - models with >=2 fast tiers -> `speed` SHOW rule, `fastMode` HIDE rule;
 * - models with 1 fast tier (or unreported / custom) -> `fastMode` visible, `speed` hidden;
 * - models declaring 0 fast tiers -> `fastMode` HIDE rule, `speed` hidden;
 * - no multi-tier models on this Computer (or offline) -> `speed` omitted from the form.
 */
export function withCodexSpeedVisibility<T extends RuntimeFormV2Definition>(
  form: T,
  models: readonly RuntimeModelInfo[],
): T {
  const multiTierIds = [...new Set(models.filter((model) => offeredServiceTiers(model).length >= 2).map((model) => model.id))];
  const noFastIds = [...new Set(models.filter((model) => codexModelDisallowsFastMode(model)).map((model) => model.id))];
  const hideFastModeIds = [...new Set([...multiTierIds, ...noFastIds])];

  const next = structuredClone(form);
  if (multiTierIds.length === 0) {
    delete next.dataSchema.properties.speed;
    if (next.dataSchema.required) next.dataSchema.required = next.dataSchema.required.filter((key) => key !== "speed");
    if (next.uiSchema) {
      if (next.uiSchema.order) next.uiSchema.order = next.uiSchema.order.filter((key) => key !== "speed");
      if (next.uiSchema.layout?.advanced) next.uiSchema.layout.advanced = next.uiSchema.layout.advanced.filter((pointer) => pointer !== "/speed");
      delete next.uiSchema.localization?.speed;
    }
    if (next.optionSources) delete next.optionSources.speed;
    const values = (next as { values?: Record<string, unknown> }).values;
    if (values) delete values.speed;
  }

  const rules = (next.uiSchema?.rules ?? []).filter(
    (rule) => rule.scope !== "#/properties/fastMode" && rule.scope !== "#/properties/speed",
  );
  if (hideFastModeIds.length > 0 && Object.hasOwn(next.dataSchema.properties, "fastMode")) {
    rules.push({
      scope: "#/properties/fastMode",
      effect: "HIDE",
      condition: { scope: "#/properties/model", schema: { enum: hideFastModeIds } },
    });
  }
  if (multiTierIds.length > 0 && Object.hasOwn(next.dataSchema.properties, "speed")) {
    rules.push({
      scope: "#/properties/speed",
      effect: "SHOW",
      condition: { scope: "#/properties/model", schema: { enum: multiTierIds } },
    });
  }
  if (rules.length > 0) {
    next.uiSchema = { ...next.uiSchema, rules };
  }
  return next;
}

const titleCaseTier = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/[_-]+/g, " ");

const CODEX_STANDARD_SPEED_LABEL = "Standard · Default speed";

/**
 * "Fast · 2x speed, increased usage": Codex's own name and description (Option
 * has no description field), cleaned again here: any Computer can report them.
 */
function serviceTierLabel(choice: RuntimeServiceTierChoice): string {
  const name = runtimeServiceTierText(choice.name, 40) || titleCaseTier(choice.id);
  const description = runtimeServiceTierText(choice.description, 120);
  return description ? `${name} · ${description}` : name;
}

/**
 * The `speed` source: a key per live model with two or more fast tiers —
 * Standard ("", default) followed by each fast tier by its id (`priority`,
 * `ultrafast`, ...). Models with one or zero fast tiers have no key (single-tier
 * models use `fastMode`; zero-tier models hide both).
 */
export function speedOptionSource(
  runtimeId: string,
  models: readonly RuntimeModelInfo[],
  reason: RuntimeFormV2OptionSourceReason | null,
): RuntimeFormV2OptionSourceBody {
  const optionsByValue: Record<string, AgentCreateFormOption[]> = {};
  const defaultValueByValue: Record<string, string> = {};
  for (const model of models) {
    const tiers = offeredServiceTiers(model);
    if (tiers.length === 0) continue;
    optionsByValue[model.id] = [
      { value: "", label: CODEX_STANDARD_SPEED_LABEL },
      ...tiers.map((tier) => ({ value: tier.id, label: serviceTierLabel(tier) })),
    ];
    defaultValueByValue[model.id] = "";
  }
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "speed",
    kind: "dependent_select",
    pointer: "/speed",
    dependsOn: "/model",
    optionsByValue,
    defaultValueByValue,
    customValueAllowedByValue: {},
    // It follows the model probe: live, or unavailable (hidden) without a live list.
    ...optionSourceStatusFields(reason, false),
  } as RuntimeFormV2OptionSourceBody;
}

/**
 * #wg-runtime-form:#27: a Codex speed tier nothing could check against the
 * Computer (no Computer, its list unreadable, a legacy write) is kept only when
 * it is the saved one on the same model; any other becomes the primary tier.
 * Returns the same object when nothing changes.
 */
export function withoutUncheckedServiceTier(runtimeConfig: RuntimeConfig, existing: RuntimeConfig | null | undefined): RuntimeConfig {
  const tier = runtimeConfig.mode.kind === "fast" ? runtimeConfig.mode.serviceTier : undefined;
  if (!tier) return runtimeConfig;
  const saved = existing?.runtime === runtimeConfig.runtime
    && existing.mode.kind === "fast"
    && existing.mode.serviceTier === tier
    && runtimeConfigModelValue(existing) === runtimeConfigModelValue(runtimeConfig);
  return saved ? runtimeConfig : { ...runtimeConfig, mode: { kind: "fast" } };
}

/**
 * A Codex speed choice against the Computer's live list:
 * - if the model explicitly declares zero fast tiers, fast mode falls back to default;
 * - a named fast tier (`ultrafast`, ...) is kept when the model offers it; a saved one
 *   the model no longer offers falls back to the primary tier; a newly chosen one is refused.
 */
function reconcileServiceTier(
  runtimeConfig: RuntimeConfig,
  live: RuntimeModelInfo | undefined,
  storedServiceTier: string | null,
): LiveModelReconciliation {
  if (live && codexModelDisallowsFastMode(live) && runtimeConfig.mode.kind === "fast") {
    return { kind: "updated", runtimeConfig: { ...runtimeConfig, mode: { kind: "default" } } };
  }
  const tier = runtimeConfig.mode.kind === "fast" ? runtimeConfig.mode.serviceTier : undefined;
  if (!tier || offeredServiceTiers(live).some((choice) => choice.id === tier)) return { kind: "unchanged" };
  if (tier !== storedServiceTier) {
    return { kind: "rejected", issue: { code: "service_tier_not_supported", pointer: "/formValues/speed" } };
  }
  return { kind: "updated", runtimeConfig: { ...runtimeConfig, mode: { kind: "fast" } } };
}

function reasoningModelFormEntry(runtimeId: string, options: ReasoningModelFormOptions): RuntimeFormV2Entry {
  const bundledIds = () => new Set((RUNTIME_MODELS[runtimeId] ?? []).map((model) => model.id));
  return {
    runtimeId,
    buildForm: () => buildReasoningModelForm(runtimeId, options),
    validateProjection: () => reasoningModelProjectionIssues(buildReasoningModelForm(runtimeId, options), options),
    async resolveOptionSource(context) {
      if (options.customProvider && context.sourceId === "provider") {
        return { kind: "source", source: customProviderOptionSource(runtimeId) };
      }
      if (options.customProvider && context.sourceId === "authType") {
        return { kind: "source", source: customProviderAuthTypeOptionSource(runtimeId) };
      }
      if (options.speed && context.sourceId === "speed") {
        const probe = await probeModels(context, runtimeId);
        if (probe.kind === "handled") return { kind: "handled" };
        return { kind: "source", source: speedOptionSource(runtimeId, probe.kind === "live" ? probe.models : [], probe.kind === "live" ? null : probe.reason) };
      }
      if (context.sourceId !== "model") return { kind: "source", source: null };
      const probe = await probeModels(context, runtimeId);
      if (probe.kind === "handled") return { kind: "handled" };
      if (probe.kind === "live") {
        return { kind: "source", source: reasoningModelOptionSource(runtimeId, probe.models, probe.default, null, options, probe.unavailable) };
      }
      const fallback = reasoningModelOptionSource(runtimeId, RUNTIME_MODELS[runtimeId] ?? [], undefined, probe.reason, options);
      return {
        kind: "source",
        source: options.typedModelWhenUnlisted && options.customModel
          ? { ...fallback, ...optionSourceStatusFields(probe.reason, true) }
          : fallback,
      };
    },
    runtimeConfigFromValues(values, envVars, valueOptions) {
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue || modelValue === options.retiredRuntimeChoice) return formValueIssue("model_required", "model");
      if (options.modelFormat && modelValue !== "default" && !options.modelFormat.valid(modelValue)) {
        return { ok: false, issue: { code: "invalid_model", pointer: "/formValues/model" }, message: options.modelFormat.message };
      }
      // A form without a reasoning field ignores a stray value, like fastMode below.
      const effort = options.reasoning ? values.reasoningEffort : null;
      if (effort !== undefined && effort !== null && typeof effort !== "string") {
        return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
      }
      const fastMode = values.fastMode;
      if (fastMode !== undefined && fastMode !== null && typeof fastMode !== "boolean") {
        return formValueIssue("invalid_boolean", "fastMode");
      }
      // #wg-runtime-form:#31: `speed` (Standard / Fast / Ultrafast) and `fastMode`
      // (checkbox) are mutually exclusive on Codex. When `speed` is present, it
      // decides `mode` directly (`""` = default, `"priority"` = primary fast,
      // another id = named tier). Otherwise `fastMode` decides, keeping a saved
      // named tier only when editing the same model while offline (`speed` absent).
      const speed = options.speed ? values.speed : undefined;
      if (speed !== undefined && speed !== null && speed !== "" && !isRuntimeServiceTierId(speed)) {
        return formValueIssue("invalid_service_tier", "speed");
      }
      const existingMode = valueOptions?.editing && valueOptions.existing?.runtime === runtimeId ? valueOptions.existing.mode : null;
      const sameModel = valueOptions?.editing && valueOptions.existing?.runtime === runtimeId
        && modelValueOf(valueOptions.existing as unknown as Record<string, unknown>) === modelValue;
      let mode: RuntimeConfig["mode"] = { kind: "default" };
      if (options.speed && typeof speed === "string") {
        if (speed !== "" && runtimeModelSupportsFastMode(runtimeId, modelValue)) {
          mode = speed === CODEX_PRIMARY_FAST_SERVICE_TIER
            ? { kind: "fast" }
            : { kind: "fast", serviceTier: speed };
        }
      } else if (options.fastMode && fastMode === true && runtimeModelSupportsFastMode(runtimeId, modelValue)) {
        const keptTier = options.speed && speed === undefined && sameModel && existingMode?.kind === "fast"
          ? existingMode.serviceTier ?? null
          : null;
        mode = { kind: "fast", ...(keptTier ? { serviceTier: keptTier } : {}) };
      }
      const command = options.command ? values.command : null;
      if (command !== undefined && command !== null && typeof command !== "string") {
        return formValueIssue("invalid_command", "command");
      }
      let provider: Record<string, unknown> | null = null;
      if (options.customProvider) {
        const built = customProviderFromValues(runtimeId, values, valueOptions);
        if (!built.ok) return built;
        provider = built.provider;
        // A Custom provider owns both auth variables: the one it sets would
        // override a typed value, and the other would reach the gateway as a
        // second credential. Default leaves them to the user.
        if (provider.kind === "custom" && envVars && Object.hasOwn(envVars, "ANTHROPIC_AUTH_TOKEN")) {
          return {
            ok: false,
            issue: { code: "controlled_env_var", pointer: "/formValues/envVars" },
            message: "ANTHROPIC_AUTH_TOKEN cannot be set in Environment Variables with a Custom provider. Put the token in API Key and choose Bearer token under Authentication instead.",
          };
        }
      }
      // `select.custom_value`: a listed value is a preset, an unlisted typed one
      // a custom model. "Listed" here is the bundled list; a model that only the
      // Computer's live list names is turned back into a preset by
      // reconcileWithLiveModels once the submit knows the Computer.
      const model = options.customModel && !bundledIds().has(modelValue)
        ? { kind: "custom", name: modelValue }
        : { kind: "preset", id: modelValue };
      return {
        ok: true,
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: runtimeId,
          ...(provider ? { provider } : {}),
          model,
          mode,
          reasoningEffort: typeof effort === "string" && effort.trim() !== "" ? effort.trim() : null,
          envVars,
          ...(typeof command === "string" && command.trim() ? { command: command.trim() } : {}),
        },
      };
    },
    valuesFromRuntimeConfig(runtimeConfig) {
      const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
      const custom = provider?.kind === "custom";
      return {
        // The API key is write-only: never part of the values.
        ...(options.customProvider
          ? {
              provider: custom ? "custom" : "default",
              ...(custom
                ? {
                    apiUrl: typeof provider.apiUrl === "string" ? provider.apiUrl : "",
                    authType: provider.authType === "auth_token" ? "auth_token" : "api_key",
                  }
                : {}),
            }
          : {}),
        model: modelValueOf(runtimeConfig) === options.retiredRuntimeChoice ? "" : modelValueOf(runtimeConfig),
        ...(options.reasoning
          ? { reasoningEffort: typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "" }
          : {}),
        ...(options.fastMode
          ? {
              fastMode: isPlainRecord(runtimeConfig.mode)
                && runtimeConfig.mode.kind === "fast"
                && runtimeModelSupportsFastMode(runtimeId, modelValueOf(runtimeConfig)),
            }
          : {}),
        ...(options.speed
          ? {
              speed: isPlainRecord(runtimeConfig.mode)
                && runtimeConfig.mode.kind === "fast"
                && runtimeModelSupportsFastMode(runtimeId, modelValueOf(runtimeConfig))
                ? (isRuntimeServiceTierId(runtimeConfig.mode.serviceTier)
                    ? runtimeConfig.mode.serviceTier
                    : CODEX_PRIMARY_FAST_SERVICE_TIER)
                : "",
            }
          : {}),
        ...(options.command ? { command: typeof runtimeConfig.command === "string" ? runtimeConfig.command : "" } : {}),
        envVars: envVarsOf(runtimeConfig),
      };
    },
    ...(options.customProvider ? { writeOnlySecrets: [CLAUDE_CUSTOM_PROVIDER_API_KEY] } : {}),
    reconcileWithLiveModels(submittedConfig, submittedReasoningEffort, models, storedReasoningEffort = null, storedServiceTier = null) {
      const modelValue = submittedConfig.model.kind === "custom" ? submittedConfig.model.name : submittedConfig.model.id;
      const live = models.find((model) => model.id === modelValue);
      const tierDecision = options.speed ? reconcileServiceTier(submittedConfig, live, storedServiceTier) : { kind: "unchanged" as const };
      if (tierDecision.kind === "rejected") return tierDecision;
      const runtimeConfig = tierDecision.kind === "updated" ? tierDecision.runtimeConfig : submittedConfig;
      const changed: LiveModelReconciliation = tierDecision.kind === "updated" ? tierDecision : { kind: "unchanged" };
      // Not in the live list: a custom model, or a bundled one this Computer
      // does not report. The static rule already applied stays final.
      if (!live) return changed;
      if (!options.reasoning) {
        // Nothing to decide but the model kind: a live-listed one is a preset.
        return runtimeConfig.model.kind === "custom"
          ? { kind: "updated", runtimeConfig: { ...runtimeConfig, model: { kind: "preset", id: modelValue } } as RuntimeConfig }
          : changed;
      }
      const efforts = reasoningModelOption(runtimeId, live).supportedReasoningEfforts ?? [];
      let effort = submittedReasoningEffort;
      if (effort !== null && !efforts.includes(effort)) {
        // The saved effort of a model that lists no levels any more (agy lists
        // them for its current model only, which can change): the field is
        // hidden, so the user could neither see nor clear it. Saving keeps
        // the rest and falls back to Default. A newly chosen one is refused.
        if (efforts.length > 0 || effort !== storedReasoningEffort) {
          return { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } };
        }
        effort = null;
      }
      return {
        kind: "updated",
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: modelValue },
          reasoningEffort: effort as RuntimeConfig["reasoningEffort"],
        } as RuntimeConfig,
      };
    },
  };
}

const codexEntry = reasoningModelFormEntry("codex", {
  customModel: true,
  fastMode: true,
  speed: true,
  reasoning: true,
  modelHint: "Models available from this computer's Codex CLI. You can also type a model ID.",
});

// Grok's form is OAR's (`@botiverse/oar/forms`): its fields and the modes Grok
// accepts come from configForms.grok. Raft offers less (a listed model, no
// runtime default, no typed id, required) and keeps its own hint, so the served
// v2 form stays unchanged.
export const GROK_RAFT_NARROWING: RaftModelNarrowing = {
  modes: ["preset"],
  required: true,
  hint: "Models available from this computer's Grok CLI.",
};
export const grokRaftForm = narrowOarForm(oarConfigForms.grok!, GROK_RAFT_NARROWING);
const grokEntry = reasoningModelFormEntry("grok", reasoningModelOptionsFromOar(grokRaftForm));

// Batch 3b. Each follows the legacy predicates in utils/runtimeConfigForm.ts
// (supportsRuntimeCustomModelName, supportsRuntimeApiUrl, supportsRuntimeCommand,
// supportsRuntimeFastMode) and REASONING_EFFORT_RUNTIMES. Copilot's Computer
// "probe" answers with the declared static catalog (STATIC_RUNTIME_MODEL_SOURCE_IDS);
// Claude's asks Claude Code and falls back to that catalog; Cursor's asks the Cursor CLI.
const claudeEntry = reasoningModelFormEntry("claude", {
  customModel: true,
  fastMode: true,
  reasoning: true,
  customProvider: true,
  command: true,
  modelHint: "Models Claude Code accepts. You can also type a model ID.",
});

const cursorEntry = reasoningModelFormEntry("cursor", {
  customModel: true,
  fastMode: false,
  reasoning: false,
  modelHint: "Models available from this computer's Cursor CLI. You can also type a model ID.",
});

const copilotEntry = reasoningModelFormEntry("copilot", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  modelHint: "Models GitHub Copilot CLI accepts. You can also type a model ID.",
});

// Runtimes that run only on the Computer's OAR host (Qwen Code, Qoder; DSH below). OAR's
// forms do not have them yet, so Raft writes them like Cursor's: the model
// list the Computer reads through OAR, a typed id allowed, no effort.
const qwenEntry = reasoningModelFormEntry("qwen", {
  customModel: true,
  fastMode: false,
  reasoning: false,
  modelHint: "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.",
});

const qoderEntry = reasoningModelFormEntry("qoder", {
  customModel: true,
  fastMode: false,
  reasoning: false,
  modelHint: "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.",
});

// DeepSeek Harness, OAR-only like Qwen Code and Qoder: the models the
// Computer's dsh lists (OAR listModels, `provider/model`), a typed id allowed
// (dsh refuses a bare model name). The effort is the model's own reasoning
// effort, offered only for a model whose efforts the Computer listed
// (`runtimeOffersUndeclaredReasoningEfforts`). No sign-in: its DeepSeek key
// is configured in dsh or the agent's environment.
const dshEntry = reasoningModelFormEntry("dsh", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  // OAR's dshAgentOptions: a provider and a model on either side of the first `/`.
  modelFormat: {
    valid: (model) => /^[^/\s]+\/\S+$/u.test(model),
    message: "DeepSeek Harness selects a model as provider/model, such as deepseek/deepseek-chat.",
  },
  modelHint: "Models DeepSeek Harness can use on this computer, as provider/model. You can also type one. Set its DeepSeek API key in dsh's own settings on the computer, or as DEEPSEEK_API_KEY under Environment Variables.",
});

// Antigravity on the OAR host: the models the Computer's `agy` login offers
// (OAR listModels), a typed id allowed (also when the list cannot be read).
// A model is required (#oar-raft:#25): the one agy starts on (the live list's
// default) is preselected. "AGY configured default" (`default`, no model
// passed) is no longer offered; an agent that stored it keeps running until
// someone edits it, and its edit form asks for a model. The effort is agy's
// thought level, offered only for a model whose levels the Computer listed;
// OAR applies it as the session's `effort`. A model id that already names its
// level carries none (the daemon drops it).
const antigravityEntry = reasoningModelFormEntry("antigravity", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  retiredRuntimeChoice: ANTIGRAVITY_AGY_CHOOSES_MODEL,
  typedModelWhenUnlisted: true,
  modelHint: "Models available to this computer's Antigravity login; the one Antigravity starts on is preselected. You can also type a model ID.",
});

/**
 * Batch 4: Pi (the Pi CLI runtime on the Computer, runtime "pi"; not Built-in
 * Pi, which is "builtin"). The legacy web form is the oracle
 * (packages/web/src/components/agent/RuntimeConfigFields.tsx, the
 * `piProviderSupported` branch, with utils/runtimeConfigForm.ts
 * buildRuntimeConfig):
 *
 * - Provider: "Configured" (the Computer's own Pi auth.json; runtimeConfig
 *   provider `{ kind: "default" }`) or one of the Pi built-in providers
 *   (PI_BUILTIN_PROVIDER_ENV_KEYS, today DeepSeek; `{ kind: "pi-builtin",
 *   providerId, apiKey }`).
 * - Configured: the model list comes from the Computer's Pi probe, and a typed
 *   custom model is allowed (supportsRuntimeCustomModelName).
 * - A built-in provider: an API key, and the provider's own model list
 *   (PI_BUILTIN_PROVIDER_MODELS); legacy locks the model picker to that list
 *   (no Custom) and resets the model to the provider's default on a switch.
 * - A reasoning effort in both cases (REASONING_EFFORT_RUNTIMES). Pi models
 *   never declare efforts (the probe reports none and RUNTIME_MODELS.pi has
 *   none), so every listed model offers the BASE set, as the legacy picker does.
 *
 * The v2 contract has no select whose list depends on another field and also
 * accepts a typed value (dependent_select is either a list or free text per
 * parent value), so the two model lists are two fields, each shown for its
 * provider: `model` (a select with `select.custom_value`) and `providerModel`
 * (a dependent_select on the provider). Each has its own effort field, derived
 * from it, because a derived field follows exactly one parent. Both effort
 * fields fill runtimeConfig.reasoningEffort; the submit reads the pair that
 * belongs to the chosen provider.
 */
const PI_CONFIGURED_PROVIDER = "configured";
const PI_BUILTIN_PROVIDER_IDS = Object.keys(PI_BUILTIN_PROVIDER_ENV_KEYS);
const PI_FIELD_KEYS = ["provider", "apiKey", "model", "reasoningEffort", "providerModel", "providerReasoningEffort", "envVars"] as const;
const PI_REQUIRED = ["provider", "model", "providerModel"] as const;
const PI_CAPABILITIES: RuntimeFormV2ClientCapability[] = ["select.custom_value"];
const PI_EFFORT_DERIVATION = { attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" } as const;

function buildPiForm(): RuntimeFormV2Definition {
  const ref = simpleFormRef("pi");
  const configured = { pointer: "/provider", in: [PI_CONFIGURED_PROVIDER] };
  const builtin = { pointer: "/provider", in: [...PI_BUILTIN_PROVIDER_IDS] };
  const reasoningCopy = { label: "Reasoning", hint: "Available values depend on the selected model.", choices: reasoningEffortChoices() };
  const base = toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      // `model` and `providerModel` are each shown for one kind of provider;
      // a client checks `required` only for fields it shows. The API key is
      // shown only for a built-in provider and asked for by the server.
      required: [...PI_REQUIRED],
      properties: {
        provider: { type: "string", title: "Provider", minLength: 1 },
        apiKey: { type: "string", title: "API Key", writeOnly: true },
        model: { type: "string", title: "Model", minLength: 1 },
        reasoningEffort: { type: "string", title: "Reasoning" },
        providerModel: { type: "string", title: "Model", minLength: 1 },
        providerReasoningEffort: { type: "string", title: "Reasoning" },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: [...PI_FIELD_KEYS],
      layout: { advanced: ["/envVars"] },
      visibility: [
        { pointer: "/apiKey", when: builtin },
        { pointer: "/model", when: configured },
        { pointer: "/reasoningEffort", when: configured },
        { pointer: "/providerModel", when: builtin },
        { pointer: "/providerReasoningEffort", when: builtin },
      ],
      localization: {
        // The legacy web form's English (agent.runtimeConfig.provider / .piProviderHint).
        provider: {
          label: "Provider",
          hint: "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.",
        },
        apiKey: { label: "API Key", placeholder: "sk-..." },
        model: { label: "Model", hint: "Models available from this computer's Pi configuration. You can also type a model ID." },
        reasoningEffort: reasoningCopy,
        providerModel: { label: "Model", hint: "Models the selected provider offers." },
        providerReasoningEffort: reasoningCopy,
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: {
      // providerKinds names Built-in provider kinds only; Pi's choice is the provider field.
      providerKinds: [],
      writeOnlyPointers: ["/apiKey"],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      provider: { ...ref, sourceId: "provider", kind: "select", pointer: "/provider" },
      model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" },
      providerModel: { ...ref, sourceId: "providerModel", kind: "dependent_select", pointer: "/providerModel", dependsOn: "/provider" },
    },
  }, {
    reasoningEffort: { field: "model", ...PI_EFFORT_DERIVATION },
    providerReasoningEffort: { field: "providerModel", ...PI_EFFORT_DERIVATION },
  });
  const { protocolVersion, runtimeId, schemaVersion, ...rest } = base;
  return { protocolVersion, runtimeId, schemaVersion, requiredClientCapabilities: [...PI_CAPABILITIES], ...rest };
}

/** The provider select: static (no probe, so no `status`), no typed value. */
function piProviderOptionSource(): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef("pi"),
    sourceId: "provider",
    kind: "select",
    pointer: "/provider",
    options: [
      { value: PI_CONFIGURED_PROVIDER, label: "Configured" },
      ...PI_BUILTIN_PROVIDER_IDS.map((providerId) => ({ value: providerId, label: getRuntimeProviderDisplayName(providerId) })),
    ],
    defaultValue: PI_CONFIGURED_PROVIDER,
    customValueAllowed: false,
  };
}

/**
 * A built-in provider's models, from the Pi SDK catalog; static, so no
 * `status`. Each option offers the BASE efforts (reasoningModelOption: these
 * ids are not in RUNTIME_MODELS.pi and declare none).
 */
function piProviderModelOptionSource(): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef("pi"),
    sourceId: "providerModel",
    kind: "dependent_select",
    pointer: "/providerModel",
    dependsOn: "/provider",
    optionsByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [
      providerId,
      (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => reasoningModelOption("pi", model)),
    ])),
    defaultValueByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [
      providerId,
      PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? "",
    ])),
    customValueAllowedByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [providerId, false])),
  };
}

function piProjectionIssues(form: RuntimeFormV2Definition): AgentCreateFormIssue[] {
  if (
    Object.keys(form.dataSchema.properties).sort().join("\0") !== [...PI_FIELD_KEYS].sort().join("\0")
    || (form.dataSchema.required ?? []).join("\0") !== PI_REQUIRED.join("\0")
  ) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  if (
    Object.keys(form.optionSources ?? {}).join("\0") !== "provider\0model\0providerModel"
    || form.optionSources?.provider?.pointer !== "/provider"
    || form.optionSources?.model?.pointer !== "/model"
    || form.optionSources?.providerModel?.pointer !== "/providerModel"
    || form.optionSources?.providerModel?.dependsOn !== "/provider"
  ) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  if ((form.requiredClientCapabilities ?? []).join("\0") !== PI_CAPABILITIES.join("\0")) {
    return [{ code: "definition_capabilities_drift", pointer: "/requiredClientCapabilities" }];
  }
  // Every served provider model must be one the strict parser accepts.
  for (const providerId of PI_BUILTIN_PROVIDER_IDS) {
    const models = PI_BUILTIN_PROVIDER_MODELS[providerId] ?? [];
    const defaultModel = PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS];
    if (models.length === 0 || !models.some((model) => model.id === defaultModel)) {
      return [{ code: "definition_model_registry_drift", pointer: `/optionSources/providerModel/optionsByValue/${providerId}` }];
    }
  }
  return [];
}

/**
 * The Pi built-in provider key: write-only on both the v2 form and the v1 agent
 * read (`GET /api/agents[/:id]` blanks it to `""`; web and mobile 1.24+ edit
 * through `GET /api/agents/:id/runtime-form`, and legacy v1 PATCHes with a
 * blank key keep the stored one via `retainLegacyBlankWriteOnlySecrets`).
 */
const PI_BUILTIN_PROVIDER_API_KEY: RuntimeConfigWriteOnlySecret = {
  path: ["provider", "apiKey"],
  appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind === "pi-builtin",
  keepsIdentity(incoming, existing) {
    const next = isPlainRecord(incoming.provider) ? incoming.provider : {};
    const saved = isPlainRecord(existing.provider) ? existing.provider : {};
    return next.kind === "pi-builtin" && saved.kind === "pi-builtin"
      && typeof next.providerId === "string" && typeof saved.providerId === "string"
      && next.providerId.trim() === saved.providerId.trim();
  },
  form: { field: "apiKey", keepRequiresUnchanged: ["provider"] },
  redactOnAgentRead: true,
};

const KNOWN_REASONING_EFFORT_IDS: ReadonlySet<string> = new Set(REASONING_EFFORTS.map((effort) => effort.id));

/** A submitted effort: "" or null is the runtime default; anything else must be a known effort. */
function piEffort(values: Record<string, unknown>, key: string): { ok: true; value: string | null } | { ok: false; issue: AgentCreateFormIssue } {
  const effort = values[key];
  if (effort === undefined || effort === null || (typeof effort === "string" && effort.trim() === "")) return { ok: true, value: null };
  if (typeof effort !== "string" || !KNOWN_REASONING_EFFORT_IDS.has(effort.trim())) {
    return { ok: false, issue: { code: "invalid_reasoning_effort", pointer: `/formValues/${key}` } };
  }
  return { ok: true, value: effort.trim() };
}

const piEntry: RuntimeFormV2Entry = {
  runtimeId: "pi",
  buildForm: buildPiForm,
  validateProjection: () => piProjectionIssues(buildPiForm()),
  async resolveOptionSource(context) {
    if (context.sourceId === "provider") return { kind: "source", source: piProviderOptionSource() };
    if (context.sourceId === "providerModel") return { kind: "source", source: piProviderModelOptionSource() };
    if (context.sourceId !== "model") return { kind: "source", source: null };
    const probe = await probeModels(context, "pi");
    if (probe.kind === "handled") return { kind: "handled" };
    const options = { customModel: true, reasoning: true };
    if (probe.kind === "live") {
      return { kind: "source", source: reasoningModelOptionSource("pi", probe.models, probe.default, null, options, probe.unavailable) };
    }
    // Not live: the bundled "Configured Default / Auto" entry, marked fallback,
    // like every other probed runtime (the legacy web form offers no list here
    // and only a typed model; see the batch 4 notes in the README).
    return { kind: "source", source: reasoningModelOptionSource("pi", RUNTIME_MODELS.pi ?? [], undefined, probe.reason, options) };
  },
  runtimeConfigFromValues(values, envVars, options) {
    const providerChoice = typeof values.provider === "string" ? values.provider.trim() : "";
    const base = { version: RUNTIME_CONFIG_VERSION, runtime: "pi", mode: { kind: "default" }, envVars };
    if (providerChoice === PI_CONFIGURED_PROVIDER) {
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      const effort = piEffort(values, "reasoningEffort");
      if (!effort.ok) return effort;
      // `select.custom_value`: a listed value is a preset, an unlisted typed one
      // a custom model; reconcileWithLiveModels turns a model only the live list
      // names back into a preset.
      const bundled = (RUNTIME_MODELS.pi ?? []).some((model) => model.id === modelValue);
      return {
        ok: true,
        runtimeConfig: {
          ...base,
          provider: { kind: "default" },
          model: bundled ? { kind: "preset", id: modelValue } : { kind: "custom", name: modelValue },
          reasoningEffort: effort.value,
        },
      };
    }
    if (!PI_BUILTIN_PROVIDER_IDS.includes(providerChoice)) return formValueIssue("select_valid_provider", "provider");
    const modelValue = typeof values.providerModel === "string" ? values.providerModel.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "providerModel");
    // Legacy locks the picker to the provider's list (no Custom).
    if (!(PI_BUILTIN_PROVIDER_MODELS[providerChoice] ?? []).some((model) => model.id === modelValue)) {
      return formValueIssue("select_valid_provider_model", "providerModel");
    }
    const effort = piEffort(values, "providerReasoningEffort");
    if (!effort.ok) return effort;
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    const provider: Record<string, unknown> = { kind: "pi-builtin", providerId: providerChoice, ...(apiKey ? { apiKey } : {}) };
    // A blank write-only key on edit means "keep the stored one": omit it so the
    // PATCH path (retainOmittedWriteOnlySecrets) restores it, only while the
    // provider is the same; otherwise ask for a key at the field.
    if (
      !apiKey
      && !(options.editing === true
        && options.existing?.runtime === "pi"
        && PI_BUILTIN_PROVIDER_API_KEY.keepsIdentity({ provider }, options.existing as unknown as Record<string, unknown>))
    ) {
      return formValueIssue("api_key_required", "apiKey");
    }
    return {
      ok: true,
      runtimeConfig: { ...base, provider, model: { kind: "preset", id: modelValue }, reasoningEffort: effort.value },
    };
  },
  valuesFromRuntimeConfig(runtimeConfig) {
    const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
    const effort = typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "";
    const envVars = envVarsOf(runtimeConfig);
    // The API key is write-only: never part of the values.
    if (provider?.kind === "pi-builtin") {
      return {
        provider: typeof provider.providerId === "string" ? provider.providerId : "",
        providerModel: modelValueOf(runtimeConfig),
        providerReasoningEffort: effort,
        envVars,
      };
    }
    return { provider: PI_CONFIGURED_PROVIDER, model: modelValueOf(runtimeConfig), reasoningEffort: effort, envVars };
  },
  writeOnlySecrets: [PI_BUILTIN_PROVIDER_API_KEY],
  reconcileWithLiveModels(runtimeConfig, submittedReasoningEffort, models) {
    // Only the Configured provider's model comes from the Computer; a built-in
    // provider's model is checked against its own catalog.
    if (runtimeConfig.provider?.kind === "pi-builtin") return { kind: "unchanged" };
    const modelValue = runtimeConfig.model.kind === "custom" ? runtimeConfig.model.name : runtimeConfig.model.id;
    const live = models.find((model) => model.id === modelValue);
    if (!live) return { kind: "unchanged" };
    const efforts = reasoningModelOption("pi", live).supportedReasoningEfforts ?? [];
    if (submittedReasoningEffort !== null && !efforts.includes(submittedReasoningEffort)) {
      return { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } };
    }
    return {
      kind: "updated",
      runtimeConfig: {
        ...runtimeConfig,
        model: { kind: "preset", id: modelValue },
        reasoningEffort: submittedReasoningEffort as RuntimeConfig["reasoningEffort"],
      } as RuntimeConfig,
    };
  },
};

const REGISTRY = new Map<string, RuntimeFormV2Entry>([
  [builtinEntry.runtimeId, builtinEntry],
  [kimiSdkEntry.runtimeId, kimiSdkEntry],
  // Batch 2. Kimi CLI and Gemini CLI are deprecated (as is Copilot CLI, batch
  // 3b): the admission row offers them (and so their v2 marker) only as an
  // edited agent's current runtime, and a create with them is refused like any
  // deprecated runtime. Antigravity, deprecated then, is offered for new agents
  // again (a create form, `antigravity.create.v1`).
  ["opencode", modelFormEntry("opencode", { live: true, hint: "Models available from this computer's OpenCode configuration." })],
  ["kimi", modelFormEntry("kimi", { live: true, hint: "Models available from this computer's Kimi CLI configuration." })],
  ["gemini", modelFormEntry("gemini", { live: false })],
  [antigravityEntry.runtimeId, antigravityEntry],
  // Batch 3a: the first forms that need client capabilities.
  [codexEntry.runtimeId, codexEntry],
  [grokEntry.runtimeId, grokEntry],
  // Batch 3b: Claude, Cursor and Copilot. None has a v1 form. Copilot CLI is
  // deprecated, so its form is edit-only (`copilot.edit.v1`).
  [claudeEntry.runtimeId, claudeEntry],
  [cursorEntry.runtimeId, cursorEntry],
  [copilotEntry.runtimeId, copilotEntry],
  // Batch 4: Pi. No v1 form.
  [piEntry.runtimeId, piEntry],
  // OAR-only runtimes: offered where a Computer reports them, no server flag
  // (runtimeAdmissionService.ts).
  [qwenEntry.runtimeId, qwenEntry],
  [qoderEntry.runtimeId, qoderEntry],
  [dshEntry.runtimeId, dshEntry],
]);

export function runtimeFormV2Entry(runtimeId: unknown): RuntimeFormV2Entry | null {
  return typeof runtimeId === "string" ? REGISTRY.get(runtimeId) ?? null : null;
}

export function runtimeFormV2RuntimeIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Test seam: register an entry (for example a runtime that has a v2 form but no
 * v1 ref) and return the function that restores the previous registration.
 */
export function registerRuntimeFormV2EntryForTests(entry: RuntimeFormV2Entry): () => void {
  const previous = REGISTRY.get(entry.runtimeId);
  REGISTRY.set(entry.runtimeId, entry);
  return () => {
    if (previous) REGISTRY.set(entry.runtimeId, previous);
    else REGISTRY.delete(entry.runtimeId);
  };
}

/**
 * Test seam: take a runtime out of the registry (every catalog runtime has a v2
 * form since batch 4, so this is how a test gets a real runtime without one)
 * and return the function that puts it back.
 */
export function removeRuntimeFormV2EntryForTests(runtimeId: string): () => void {
  const previous = REGISTRY.get(runtimeId);
  REGISTRY.delete(runtimeId);
  return () => {
    if (previous) REGISTRY.set(runtimeId, previous);
  };
}

/** The v2 form the server sends today for a registered runtime. */
export function buildRuntimeFormV2(runtimeId: string): RuntimeFormV2Definition {
  const entry = runtimeFormV2Entry(runtimeId);
  if (!entry) throw new Error(`runtime ${runtimeId} has no v2 form`);
  return entry.buildForm();
}

/**
 * `writeOnlyKeepRequiresUnchanged` for the runtime's edit form, from its
 * write-only secrets' declared bindings; undefined when it has none.
 */
export function runtimeFormV2WriteOnlyKeepRequiresUnchanged(runtimeId: string): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const secret of runtimeFormV2Entry(runtimeId)?.writeOnlySecrets ?? []) {
    if (secret.form) out[`/${secret.form.field}`] = secret.form.keepRequiresUnchanged.map((key) => `/${key}`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The body of GET /api/agents/:id/runtime-form: the create form, the agent's
 * current values (writeOnly fields never included) and, where a stored secret
 * is bound to other fields, writeOnlyKeepRequiresUnchanged. Null when the
 * runtime or this config has no editable v2 form.
 */
export function buildRuntimeFormV2EditBody(runtimeId: string, runtimeConfig: unknown): RuntimeFormV2Definition | null {
  const entry = runtimeFormV2Entry(runtimeId);
  const values = runtimeFormValuesFromRuntimeConfig(runtimeConfig);
  if (!entry || !values) return null;
  const keep = runtimeFormV2WriteOnlyKeepRequiresUnchanged(runtimeId);
  return { ...entry.buildForm(), ...(keep ? { writeOnlyKeepRequiresUnchanged: keep } : {}), values };
}

/**
 * task #10: a stored Built-in config a newer client wrote on a preset provider
 * that takes a typed id: a custom model, either a typed id or a listed model
 * saved with limit overrides. Null for every other config.
 */
function storedBuiltInPresetCustomModel(runtimeConfig: unknown): {
  /** The preset provider the model runs on (the provider field's value). */
  catalogProviderId: string;
  /** The Model value the edit form shows (valuesFromRuntimeConfig). */
  modelValue: string;
  /** A value no catalog entry has: a list-only client cannot show it. */
  unlisted: boolean;
  hasLimits: boolean;
} | null {
  if (!isPlainRecord(runtimeConfig) || runtimeConfig.runtime !== "builtin") return null;
  const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
  const model = isPlainRecord(runtimeConfig.model) ? runtimeConfig.model : null;
  if (model?.kind !== "custom") return null;
  const catalogProviderId = provider?.kind === "preset" && typeof provider.providerId === "string"
    ? provider.providerId
    : null;
  if (!catalogProviderId || !isBuiltInRuntimeCustomModelPresetProviderId(catalogProviderId)) return null;
  const modelValue = listedModelValueOf(catalogProviderId, runtimeConfig);
  const unlisted = !(PI_BUILTIN_PROVIDER_MODELS[catalogProviderId] ?? []).some((candidate) => candidate.id === modelValue);
  return {
    catalogProviderId,
    modelValue,
    unlisted,
    hasLimits: typeof model.contextWindow === "number" || typeof model.maxOutputTokens === "number",
  };
}

/**
 * task #10: the preset providers a client and Computer take a typed model id
 * (and so the limits) for (`presets`, the v2 limit rule).
 */
export interface BuiltInTypedModelProviders {
  presets: readonly string[];
}

/**
 * task #10: an edit form also shows the limit fields for the agent's own
 * provider while it HAS a stored limit, whatever the client and Computer say:
 * a hidden field is left out of the submit, and a save without it would
 * silently delete the limit.
 */
export function withStoredLimitProvider(
  typed: BuiltInTypedModelProviders,
  storedRuntimeConfig: unknown,
): BuiltInTypedModelProviders {
  const stored = storedBuiltInPresetCustomModel(storedRuntimeConfig);
  if (!stored?.hasLimits || typed.presets.includes(stored.catalogProviderId)) return typed;
  return { presets: [...typed.presets, stored.catalogProviderId] };
}

/**
 * task #10: the Built-in v2 edit form for one agent, one client, one Computer.
 * - The limit fields show for the preset providers the client and Computer
 *   support (`typedPresetProviderIds`, builtInTypedModelProvidersFor) and,
 *   whatever those say, for the agent's own provider while it HAS a stored
 *   limit: a hidden field is left out of the submit, and a save without it
 *   would silently delete the limit.
 * - A client without `dependent_select.custom_value_with_options` gets a
 *   stored typed preset-provider id it cannot show in a list-only Model field
 *   hidden for that provider, so a save that does not touch the model keeps
 *   it (guardBuiltInEditFromClient fills it back in); choosing another
 *   provider shows the field again.
 */
export function withBuiltInEditVisibility(
  form: RuntimeFormV2Definition,
  typedPresetProviderIds: readonly string[],
  clientCapabilities: readonly string[],
  storedRuntimeConfig: unknown,
): RuntimeFormV2Definition {
  const stored = storedBuiltInPresetCustomModel(storedRuntimeConfig);
  const limitProviders = withStoredLimitProvider({ presets: typedPresetProviderIds }, storedRuntimeConfig).presets;
  let next = withBuiltInModelLimitVisibility(form, limitProviders);
  if (stored?.unlisted && !clientRendersDependentCustomWithOptions(clientCapabilities)) {
    const providers = (buildBuiltInPiFormOptionSource("provider") as { options?: Array<{ value: string }> } | null)?.options ?? [];
    next = {
      ...next,
      uiSchema: {
        ...next.uiSchema,
        visibility: [
          ...(next.uiSchema?.visibility ?? []),
          { pointer: "/model", when: { pointer: "/providerId", in: providers.map((option) => option.value).filter((value) => value !== stored.catalogProviderId) } },
        ],
      },
    };
  }
  return next;
}

/** Copy for runtime_form_client_upgrade_required (task #10); the clients that get it predate any translation of it. */
export const RUNTIME_FORM_CLIENT_UPGRADE_REQUIRED_MESSAGE =
  "This agent's model was set in a newer version of Raft, so update the app or use Raft on the web to change its model or provider";

/**
 * task #10: an edit save from a client without
 * `dependent_select.custom_value_with_options` of an agent a newer client
 * saved with a typed preset-provider id or limit overrides.
 * - Same provider and model (or, for a stored typed id whose Model field was
 *   hidden, the model left out): saved, with the stored model filled back in,
 *   so nothing a newer client set is lost.
 * - Another provider or another model: refused
 *   (runtime_form_client_upgrade_required). The old form cannot say whether
 *   the stored limits should carry over to the new target, so they are
 *   neither carried over nor cleared without a word.
 * Every other client and agent: the values unchanged.
 */
export function guardBuiltInEditFromClient(
  values: unknown,
  storedRuntimeConfig: unknown,
  clientCapabilities: readonly string[],
): { ok: true; values: unknown } | { ok: false; issue: AgentCreateFormIssue; message: string } {
  if (clientRendersDependentCustomWithOptions(clientCapabilities) || !isPlainRecord(values)) return { ok: true, values };
  const stored = storedBuiltInPresetCustomModel(storedRuntimeConfig);
  if (!stored) return { ok: true, values };
  const refuse = (key: string) => ({
    ok: false as const,
    issue: { code: "runtime_form_client_upgrade_required", pointer: `/formValues/${key}` },
    message: RUNTIME_FORM_CLIENT_UPGRADE_REQUIRED_MESSAGE,
  });
  if (values.providerId !== stored.catalogProviderId) return refuse("providerId");
  const model = typeof values.model === "string" ? values.model.trim() : "";
  // Filled back in only where the Model field was hidden (a typed id the old
  // list cannot show); a visible field sent blank is the usual model_required.
  if (!model) return stored.unlisted ? { ok: true, values: { ...values, model: stored.modelValue } } : { ok: true, values };
  if (model !== stored.modelValue) return refuse("model");
  return { ok: true, values };
}

/** A v2/v3 submit envelope's protocolVersion: both submit the same formValues. */
export function isRuntimeFormV2SubmitProtocol(protocolVersion: unknown): protocolVersion is 2 | 3 {
  return protocolVersion === 2 || protocolVersion === 3;
}

/**
 * The envelope of a v2 or v3 submit: `{ protocolVersion: 2 | 3, runtimeId }`
 * naming a runtime in this registry (built configs record protocolVersion 2:
 * the formValues semantics are the same). v1 refs are validated by
 * validateRuntimeFormDefinitionRef and never reach here.
 */
export function validateRuntimeFormV2SubmitRef(value: unknown): AgentCreateFormIssue[] {
  if (!isPlainRecord(value)) return [{ code: "form_definition_ref_required", pointer: "/formDefinitionRef" }];
  if (!isRuntimeFormV2SubmitProtocol(value.protocolVersion)) return [{ code: "unsupported_form_protocol", pointer: "/formDefinitionRef/protocolVersion" }];
  if (!runtimeFormV2Entry(value.runtimeId)) return [{ code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" }];
  return [];
}

/**
 * The provider fields own these env keys, and validation strips them from
 * envVars. A submitted one would be dropped without a word, so the submit is
 * refused instead. Stored configs are already stripped, so re-submitting an
 * unchanged form still passes.
 */
function controlledEnvVarKey(runtimeId: string, envVars: Record<string, string> | null): string | null {
  if (!envVars) return null;
  return Object.keys(envVars).find((key) => isControlledRuntimeEnvKey(runtimeId, key)) ?? null;
}

function controlledEnvVarMessage(runtimeId: string, key: string): string {
  if (runtimeId === "codex") {
    return `${key} cannot be set in Environment Variables. Raft does not set a Codex endpoint; configure a custom provider in the computer's own Codex config instead.`;
  }
  const where = runtimeId !== "claude"
    ? "Set it with the Provider fields"
    : key.toUpperCase() === "ANTHROPIC_CUSTOM_MODEL_OPTION"
      ? "Type the model ID in the Model field"
      : "Set the API URL and key under Provider → Custom";
  return `${key} cannot be set in Environment Variables. ${where} instead.`;
}

/**
 * Protocol v2 submit: a client sends the form's values keyed by dataSchema field
 * name, and the server assembles the runtimeConfig. Clients therefore need no
 * knowledge of how a runtime nests its config (packages/runtime-form README,
 * "Protocol v2"). The result then goes through the same validation as a
 * runtimeConfig a client built itself.
 */
export function buildRuntimeConfigFromFormValues(
  runtimeId: unknown,
  values: unknown,
  options: RuntimeFormValuesOptions = {},
): FormValuesBuildResult {
  const entry = runtimeFormV2Entry(runtimeId);
  if (!entry) return { ok: false, issue: { code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" } };
  if (!isPlainRecord(values)) return { ok: false, issue: { code: "form_values_required", pointer: "/formValues" } };
  const envVars = readEnvVars(values.envVars);
  if (envVars === undefined) return { ok: false, issue: { code: "invalid_string_map", pointer: "/formValues/envVars" } };
  const controlledKey = controlledEnvVarKey(entry.runtimeId, envVars);
  if (controlledKey) {
    return {
      ok: false,
      issue: { code: "controlled_env_var", pointer: "/formValues/envVars" },
      message: controlledEnvVarMessage(entry.runtimeId, controlledKey),
    };
  }
  const built = entry.runtimeConfigFromValues(values, envVars, options);
  if (!built.ok) return built;
  return { ok: true, runtimeConfig: built.runtimeConfig, formDefinitionRef: { protocolVersion: 2, runtimeId: entry.runtimeId } };
}

/**
 * v2 submit, after the assembled runtimeConfig passed the ordinary validation:
 * reconcile it with the Computer's live model list (the live-list forms: Codex,
 * Grok, Claude, Cursor, Copilot, and Pi's Configured provider).
 *
 * The ordinary validation knows only the bundled RUNTIME_MODELS: a reasoning
 * effort a model does not declare there is dropped (parseRuntimeConfig's
 * per-model gate), so a live-only model's `max` would silently become null, and
 * a model only the live list names would be stored as custom. Here, when the
 * probe is live and lists the selected model, the live option decides: the
 * model is a preset, and the submitted effort is kept if the option offers it
 * and refused (400 /formValues/reasoningEffort) if not. When the probe is not
 * live, fails, or does not list the model, the static rule stands (unchanged).
 * A Codex speed tier (#wg-runtime-form:#27) is checked the same way; one that
 * cannot be checked is refused when newly chosen (400 /formValues/speed,
 * `service_tier_unchecked`) and otherwise stays only as the saved tier on the
 * same model (withoutUncheckedServiceTier). Only asks the Computer when there is
 * something to decide (an effort, a tier, or a custom model). Legacy (non-v2)
 * submits never come here (routes/agents.ts dropUncheckedServiceTier).
 */
export async function reconcileRuntimeFormV2SubmissionWithLiveModels(input: {
  runtimeConfig: RuntimeConfig;
  submittedReasoningEffort: unknown;
  /** Edit only: the agent's saved runtimeConfig, whose effort a model without levels may drop rather than refuse. */
  existing?: RuntimeConfig | null;
  machineId: string | null | undefined;
  detect: (machineId: string, runtime: string) => Promise<RuntimeModelSourceOutcome>;
}): Promise<LiveModelReconciliation> {
  const entry = runtimeFormV2Entry(input.runtimeConfig.runtime);
  // A tier this submit cannot check: a newly chosen one is refused, so the
  // person hears it did not take (Tenny, #15382 review); a resent saved one
  // stays only on the same model (withoutUncheckedServiceTier).
  const unchecked = (): LiveModelReconciliation => {
    const chosen = input.runtimeConfig.mode.kind === "fast" ? input.runtimeConfig.mode.serviceTier ?? null : null;
    const saved = input.existing?.runtime === input.runtimeConfig.runtime && input.existing.mode.kind === "fast"
      ? input.existing.mode.serviceTier ?? null
      : null;
    if (chosen !== null && chosen !== saved) {
      return { kind: "rejected", issue: { code: "service_tier_unchecked", pointer: "/formValues/speed" } };
    }
    const kept = withoutUncheckedServiceTier(input.runtimeConfig, input.existing);
    return kept === input.runtimeConfig ? { kind: "unchanged" } : { kind: "updated", runtimeConfig: kept };
  };
  if (!entry?.reconcileWithLiveModels || !input.machineId) return unchecked();
  const effort = typeof input.submittedReasoningEffort === "string" && input.submittedReasoningEffort
    ? input.submittedReasoningEffort
    : null;
  const tier = input.runtimeConfig.mode.kind === "fast" ? input.runtimeConfig.mode.serviceTier ?? null : null;
  const fastCodex = input.runtimeConfig.runtime === "codex" && input.runtimeConfig.mode.kind === "fast";
  if (effort === null && tier === null && !fastCodex && input.runtimeConfig.model.kind !== "custom") return { kind: "unchanged" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    outcome = await input.detect(input.machineId, input.runtimeConfig.runtime);
  } catch {
    return unchecked();
  }
  if (outcome.kind !== "live" || outcome.value.models.length === 0) return unchecked();
  const sameRuntime = input.existing?.runtime === input.runtimeConfig.runtime ? input.existing : null;
  const stored = sameRuntime?.reasoningEffort ?? null;
  const storedTier = sameRuntime?.mode.kind === "fast" ? sameRuntime.mode.serviceTier ?? null : null;
  return entry.reconcileWithLiveModels(input.runtimeConfig, effort, outcome.value.models, stored, storedTier);
}

/**
 * A v2 client only has field values, so issues found after assembly (the
 * validation chain reports /runtimeConfig/...) are pointed back at the field the
 * value came from. The assembled config is produced by
 * buildRuntimeConfigFromFormValues, so the mapping is deterministic: the
 * deepest pointer segment that names a form field wins (provider/apiKey ->
 * apiKey, model/id -> model); anything else points at the whole form.
 */
export function formValuesPointerForRuntimeConfigPointer(runtimeId: unknown, pointer: string): string {
  if (!pointer.startsWith("/runtimeConfig")) return pointer;
  const fields = new Set(Object.keys(runtimeFormV2Entry(runtimeId)?.buildForm().dataSchema.properties ?? {}));
  const segments = pointer.split("/").slice(2);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (fields.has(segments[index]!)) return `/formValues/${segments[index]}`;
  }
  return "/formValues";
}

/**
 * The inverse of buildRuntimeConfigFromFormValues, for editing: the stored
 * runtimeConfig as form values keyed by field name. writeOnly fields are never
 * included. Null when the config is not one a v2 form can edit (runtimes
 * without a v2 form).
 */
export function runtimeFormValuesFromRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(runtimeConfig)) return null;
  return runtimeFormV2Entry(runtimeConfig.runtime)?.valuesFromRuntimeConfig(runtimeConfig) ?? null;
}

function valueAt(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isPlainRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function withValueAt(record: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return record;
  if (rest.length === 0) return { ...record, [key]: value };
  const child = record[key];
  return { ...record, [key]: withValueAt(isPlainRecord(child) ? child : {}, rest, value) };
}

/**
 * API read path: blank every declared write-only secret (except one declared
 * `redactOnAgentRead: false`); the stored value never leaves the server.
 */
export function redactWriteOnlyRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  let redacted = config as unknown as Record<string, unknown>;
  for (const secret of runtimeFormV2Entry(config.runtime)?.writeOnlySecrets ?? []) {
    if (secret.redactOnAgentRead === false) continue;
    const parent = valueAt(redacted, secret.path.slice(0, -1));
    if (!isPlainRecord(parent) || !secret.appliesTo(redacted)) continue;
    redacted = withValueAt(redacted, secret.path, "");
  }
  return redacted as unknown as RuntimeConfig;
}

/**
 * Update path: a request that omits a declared write-only secret keeps the
 * stored one while the runtime is unchanged and the secret's identity holds
 * (RuntimeConfigWriteOnlySecret.keepsIdentity). Anything else is passed through
 * unchanged, so a missing secret still fails the parser.
 */
/**
 * v1 runtimeConfig writes only: released clients build the Claude Custom
 * provider themselves and know nothing of `authType`, so their edit would turn
 * a stored Bearer-token provider back into an API-key one without the user
 * seeing the choice. Keep the stored `auth_token` while the API URL is
 * unchanged. Not for v2 submits, where the server builds the provider from the
 * form and an omitted authType means the user chose API key.
 */
export function retainOmittedClaudeAuthType(incoming: unknown, existing: RuntimeConfig): unknown {
  if (!isPlainRecord(incoming) || incoming.runtime !== "claude" || existing.runtime !== "claude") return incoming;
  const provider = incoming.provider;
  const saved = existing.provider;
  if (!isPlainRecord(provider) || provider.kind !== "custom" || Object.hasOwn(provider, "authType")) return incoming;
  if (saved?.kind !== "custom" || saved.authType !== "auth_token") return incoming;
  if (typeof provider.apiUrl !== "string" || !sameApiEndpoint(provider.apiUrl, saved.apiUrl)) return incoming;
  return { ...incoming, provider: { ...provider, authType: saved.authType } };
}

/**
 * v1 runtimeConfig writes only: pre-1.24 mobile apps read `provider.apiKey`
 * from `GET /api/agents[/:id]`. Once `redactOnAgentRead` blanks Claude custom
 * and Pi built-in keys to `""`, an older app submitting an untouched edit sends
 * `apiKey: ""`. Keep the stored key while the runtime and provider identity
 * hold (same rule as `retainOmittedWriteOnlySecrets`), without affecting v2
 * submits or Built-in's explicit-blank rejection.
 */
export function retainLegacyBlankWriteOnlySecrets(incoming: unknown, existing: RuntimeConfig): unknown {
  if (!isPlainRecord(incoming) || typeof incoming.runtime !== "string") return incoming;
  const runtime = incoming.runtime.trim();
  if ((runtime !== "claude" && runtime !== "pi") || runtime !== existing.runtime) return incoming;
  const saved = existing as unknown as Record<string, unknown>;
  let result = incoming;
  for (const secret of runtimeFormV2Entry(runtime)?.writeOnlySecrets ?? []) {
    const parentPath = secret.path.slice(0, -1);
    const key = secret.path[secret.path.length - 1]!;
    const incomingParent = valueAt(result, parentPath);
    if (!isPlainRecord(incomingParent) || !Object.hasOwn(incomingParent, key)) continue;
    const rawIncoming = incomingParent[key];
    if (typeof rawIncoming !== "string" || rawIncoming.trim() !== "") continue;
    const kept = valueAt(saved, secret.path);
    if (typeof kept !== "string" || !kept) continue;
    if (!isPlainRecord(valueAt(saved, parentPath)) || !secret.keepsIdentity(result, saved)) continue;
    result = withValueAt(result, secret.path, kept);
  }
  return result;
}

export function retainOmittedWriteOnlySecrets(incoming: unknown, existing: RuntimeConfig): unknown {
  if (!isPlainRecord(incoming) || typeof incoming.runtime !== "string") return incoming;
  const runtime = incoming.runtime.trim();
  if (runtime !== existing.runtime) return incoming;
  const saved = existing as unknown as Record<string, unknown>;
  let result = incoming;
  for (const secret of runtimeFormV2Entry(runtime)?.writeOnlySecrets ?? []) {
    const parentPath = secret.path.slice(0, -1);
    const key = secret.path[secret.path.length - 1]!;
    const incomingParent = valueAt(result, parentPath);
    if (!isPlainRecord(incomingParent) || Object.hasOwn(incomingParent, key)) continue;
    const kept = valueAt(saved, secret.path);
    if (typeof kept !== "string" || !kept) continue;
    if (!isPlainRecord(valueAt(saved, parentPath)) || !secret.keepsIdentity(result, saved)) continue;
    result = withValueAt(result, secret.path, kept);
  }
  return result;
}
