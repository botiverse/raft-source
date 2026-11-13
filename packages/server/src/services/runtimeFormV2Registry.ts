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
import { createHash } from "node:crypto";

import {
  BASE_REASONING_EFFORTS,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  CUSTOM_MODEL_CONTEXT_WINDOW_MAX,
  CUSTOM_MODEL_MAX_OUTPUT_TOKENS_MAX,
  defaultReasoningEffortsForRuntime,
  isReasoningEffortOfferedOnRuntime,
  runtimeOffersUndeclaredReasoningEfforts,
  runtimeChoiceModel,
  isControlledRuntimeEnvKey,
  getDefaultModel,
  getRuntimeProviderDisplayName,
  builtInPresetProviderModelId,
  isBuiltInRuntimeCustomModelPresetProviderId,
  isBuiltInRuntimeGatewayProviderId,
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
  sanitizeRuntimeModelUnavailable,
  type AgentCreateFormIssue,
  type AgentCreateFormOption,
  type AgentCreateFormOptionSource,
  type RuntimeConfig,
  type RuntimeFormV2Marker,
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
import { isProviderConnectionsEnabled } from "./providerConnectionFeature";
import { listProviderConnections } from "./providerConnectionService";
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

/**
 * Saved provider connections inside a v2 form (contract capability
 * `provider.saved_connection`, task #46). An entry opts in with
 * `savedConnection`; the served form then lists the capability, marks the
 * connection-owned fields with `x-connectionOwned` and carries a `revision`
 * token the client echoes on option-source requests (?formRevision=). The
 * token binds the form's semantics — not the option data — so a flag flip or
 * an entry change invalidates it and the client refetches the whole form
 * (409 form_revision_stale) instead of seeing options its copy never declared.
 * Bump the salt when the meaning of any of this changes.
 */
export const RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY = "provider.saved_connection";
/** Option value encoding for a saved connection (contract: value === "connection:" + connectionId). */
export const SAVED_CONNECTION_VALUE_PREFIX = "connection:";
/** The field whose source carries the saved-connection options (Built-in's provider select). */
export const SAVED_CONNECTION_FIELD = "providerId";
const SAVED_CONNECTION_REVISION_SALT = "saved-connection.v1";

export function savedConnectionFormRevision(
  runtimeId: string,
  baseForm: { schemaVersion: string; requiredClientCapabilities?: string[] | null },
  /** task #10: the client's advertised capabilities; a client that sends none keeps the revision it always had. */
  clientCapabilities: readonly string[] = [],
): string {
  const parts: unknown[] = [runtimeId, baseForm.schemaVersion, [...(baseForm.requiredClientCapabilities ?? [])].sort(), SAVED_CONNECTION_REVISION_SALT];
  if (clientCapabilities.length > 0) parts.push([...clientCapabilities].sort());
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

/** task #10: whether the client renders a dependent value with options + typing as a combobox (advertised capability; implied by runtime_form.v3). */
export function clientRendersDependentCustomWithOptions(clientCapabilities: readonly string[] | undefined): boolean {
  const advertised = clientCapabilities ?? [];
  return advertised.includes("dependent_select.custom_value_with_options") || advertised.includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY);
}

/**
 * The v2 form as a server serves it: the entry's static form, plus the
 * saved-connection capability when the entry supports it and the server has
 * provider connections enabled. Without the flag the form is served exactly
 * as before — no capability, no revision, no x-connectionOwned.
 */
export async function buildRuntimeFormV2ForServer(
  runtimeId: unknown,
  serverId: string,
  clientCapabilities: readonly string[] = [],
): Promise<RuntimeFormV2Definition | null> {
  const entry = runtimeFormV2Entry(runtimeId);
  if (!entry) return null;
  const form = entry.buildForm();
  if (!entry.savedConnection || !await isProviderConnectionsEnabled(serverId)) return form;
  return withSavedConnectionForm(entry, form, clientCapabilities);
}

/** The saved-connection build of an entry's form (flag on): capability, x-connectionOwned markers, revision. */
export function withSavedConnectionForm(
  entry: RuntimeFormV2Entry,
  form: RuntimeFormV2Definition,
  clientCapabilities: readonly string[] = [],
): RuntimeFormV2Definition {
  if (!entry.savedConnection) return form;
  const capabilities = [...new Set([...(form.requiredClientCapabilities ?? []), RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY])];
  const owned = new Set(entry.savedConnection.connectionOwnedFields);
  const dataSchema = {
    ...form.dataSchema,
    properties: Object.fromEntries(
      Object.entries(form.dataSchema.properties ?? {}).map(([key, property]) =>
        owned.has(key) ? [key, { ...property, "x-connectionOwned": true }] : [key, property]),
    ),
  };
  return {
    ...form,
    dataSchema,
    requiredClientCapabilities: capabilities,
    revision: savedConnectionFormRevision(entry.runtimeId, form, clientCapabilities),
  };
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
   * The request came on the v2 endpoint, whose forms carry
   * `option_source.status`: a non-live source is answered with
   * status/reason/retryable instead of a 409. Absent on the v1 endpoint, whose
   * clients keep the old bodies exactly (strict parsers, no status fields).
   */
  sourceStatus?: boolean;
  /** The server the form belongs to; saved-connection options are server-scoped. */
  serverId?: string;
  /**
   * `?formRevision=` from Definition.revision (capability
   * `provider.saved_connection`). Absent: answer with the plain direct-option
   * protocol — never any connection options. Present: it must match the
   * server's current build or the client gets 409 form_revision_stale and
   * refetches the whole form.
   */
  formRevision?: string;
  /** The caller may list this server's provider connections (manageExternalAuth). */
  connectionsVisible?: boolean;
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
  /**
   * Saved-connection submits only: the providerId of the connection the route
   * resolved server-side before mapping (capability
   * `provider.saved_connection`). The connection's provider — never the model
   * name — decides the model kind: a gateway connection always takes a custom
   * model even when the typed name collides with a built-in preset id, and a
   * preset connection only takes a model from its own list. Absent (unit
   * tests, non-connection submits): the static fallback applies and the
   * route's per-connection compatibility check stays the final authority.
   */
  savedConnectionProviderId?: string;
}

export interface RuntimeFormV2Entry {
  runtimeId: string;
  /** The form served on v2 create, and the base of the v2 edit response. */
  buildForm(): RuntimeFormV2Definition;
  /**
   * Saved provider connections (capability `provider.saved_connection`):
   * present on runtimes whose form offers them. `connectionOwnedFields` are
   * the dataSchema keys a selected connection owns — marked
   * `x-connectionOwned` on the served form, kept out of formValues by the
   * client and refused on submit by the server.
   */
  savedConnection?: { connectionOwnedFields: readonly string[] };
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
  /** Stored runtimeConfig → field values for edit; writeOnly fields never included. Null: not editable here. */
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
 * Extend a catalog-filtered Built-in source with the server's saved provider
 * connections: saved options lead the provider list, and the model maps are
 * keyed by the same `connection:<id>` values (one key space, contract). All
 * connection fields are display metadata — on save the route re-resolves the
 * connection by id in the current server scope and re-checks flag, credential
 * and model compatibility. A gateway connection keeps the direct gateway's
 * custom-model semantics: the Computer's catalog never narrows what it may
 * type. Connections that are not selectable right now stay listed as
 * `unavailable` so an edit of a bound agent can show the binding and block a
 * silent rewrite.
 */
async function withSavedConnectionOptions(
  serverId: string,
  source: AgentCreateFormOptionSource,
): Promise<AgentCreateFormOptionSource> {
  const connections = await listProviderConnections(serverId);
  if (source.kind === "select" && source.pointer === `/${SAVED_CONNECTION_FIELD}`) {
    const saved = connections.map((connection) => ({
      value: `${SAVED_CONNECTION_VALUE_PREFIX}${connection.id}`,
      label: `${getRuntimeProviderDisplayName(connection.providerId as string)} · ${connection.name}`,
      providerKind: isBuiltInRuntimeGatewayProviderId(connection.providerId) ? "gateway" as const : "preset" as const,
      connectionId: connection.id,
      underlyingProviderId: connection.providerId,
      group: "saved" as const,
      ...(connection.enabled && connection.hasCredential
        ? {}
        : { unavailable: true, unavailableReason: connection.enabled ? "missing_credential" : "disabled" }),
    }));
    return {
      ...source,
      options: [...saved, ...source.options.map((option) => ({ ...option, group: "direct" as const }))],
    };
  }
  if (source.kind === "dependent_select" && source.pointer === "/model") {
    const optionsByValue = { ...source.optionsByValue };
    const defaultValueByValue = { ...source.defaultValueByValue };
    const customValueAllowedByValue = { ...source.customValueAllowedByValue };
    for (const connection of connections) {
      const key = `${SAVED_CONNECTION_VALUE_PREFIX}${connection.id}`;
      if (isBuiltInRuntimeGatewayProviderId(connection.providerId)) {
        optionsByValue[key] = [];
        customValueAllowedByValue[key] = true;
        continue;
      }
      optionsByValue[key] = optionsByValue[connection.providerId] ?? [];
      const presetDefault = defaultValueByValue[connection.providerId];
      if (typeof presetDefault === "string" && presetDefault) defaultValueByValue[key] = presetDefault;
      customValueAllowedByValue[key] = false;
    }
    return { ...source, optionsByValue, defaultValueByValue, customValueAllowedByValue };
  }
  return source;
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
 * on an older Computer, a listed OpenRouter model with a limit would be a
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
  // Saved provider connections (capability `provider.saved_connection`): the
  // connection owns the credential and the gateway endpoint fields; the form
  // marks them x-connectionOwned, clients keep them out of formValues and the
  // submit mapping below refuses any client-sent value for them.
  savedConnection: { connectionOwnedFields: ["apiKey", "baseUrl", "supportsImageInput"] },
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
      hint: "Use a model ID the selected provider supports.",
    };
    uiSchema.localization = localization;
    form.uiSchema = uiSchema;
    return form;
  },
  validateProjection: () => validateBuiltInPiDefinitionProjection(),
  async resolveOptionSource(context) {
    // Form-consistency gate (contract, Definition.revision): a revisioned
    // request is answered only when the token matches the current build;
    // otherwise the client must refetch the whole form. An unrevisioned
    // request keeps the plain direct-option protocol and never sees
    // connection options, so pre-existing clients are unaffected.
    const revisioned = context.formRevision !== undefined;
    let savedConnectionsEnabled = false;
    if (revisioned) {
      savedConnectionsEnabled = context.serverId !== undefined
        && await isProviderConnectionsEnabled(context.serverId);
    }
    // A v3 request's revision is checked by the route (runtimeFormV3Revision).
    if (revisioned && !(context.clientCapabilities ?? []).includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY)) {
      const current = savedConnectionsEnabled
        ? savedConnectionFormRevision("builtin", builtinEntry.buildForm(), context.clientCapabilities ?? [])
        : null;
      if (context.formRevision !== current) {
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
    // Saved-connection enrichment still applies on this path: the connections
    // are server data, independent of the Computer's liveness.
    const withEnrichment = async (sourceIn: AgentCreateFormOptionSource | null): Promise<RuntimeFormOptionSourceResolution> => {
      // task #10: a client that does not advertise
      // dependent_select.custom_value_with_options would render a listed
      // provider that takes a typed id as a blank text box (losing the
      // default): it gets that provider list-only, as before.
      const source = sourceIn && !clientRendersDependentCustomWithOptions(context.clientCapabilities)
        ? builtInPiListOnlyOptionSource(sourceIn)
        : sourceIn;
      if (!revisioned || !savedConnectionsEnabled || !context.connectionsVisible || !context.serverId || !source) {
        return { kind: "source", source };
      }
      return { kind: "source", source: await withSavedConnectionOptions(context.serverId, source) };
    };
    // Only the model source carries a status (v2): the provider select is static.
    const withStatus = (source: AgentCreateFormOptionSource | null, reason: RuntimeFormV2OptionSourceReason | null) =>
      source && context.sourceStatus && context.sourceId === "model"
        ? { ...source, ...optionSourceStatusFields(reason, sourceHasOptions(source)) }
        : source;
    const bundled = (reason: RuntimeFormV2OptionSourceReason) =>
      withEnrichment(withStatus(buildBuiltInPiFormOptionSource(context.sourceId), reason));
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
    // A probe that answered without the catalog fails closed, as on v1, but
    // per source on v2: `unavailable` with the reason and no options, instead
    // of the 409 builtin_catalog_unavailable. A live answer without a catalog
    // stays the typed 409 builtin_catalog_capability_required on both: that
    // Computer must be upgraded before any Built-in model can run.
    if (context.sourceStatus && context.sourceId === "model" && detection.outcome.kind !== "live") {
      const source = buildBuiltInPiFormOptionSource(context.sourceId);
      return withEnrichment(source && unavailableSource(source, optionSourceReasonForOutcome(detection.outcome) ?? "probe_failed"));
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
    return withEnrichment(withStatus(source, null));
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
    // A saved-connection selection: decode the id and refuse every field the
    // connection owns — any client-sent value, empty string or null included
    // (contract, `provider.saved_connection`; clients omit these fields). The
    // route then re-resolves the connection by id in the current server scope
    // (flag, enabled, credential, model compatibility); nothing here trusts
    // the submitted metadata.
    if (providerId.startsWith(SAVED_CONNECTION_VALUE_PREFIX)) {
      const connectionId = providerId.slice(SAVED_CONNECTION_VALUE_PREFIX.length).trim();
      if (!connectionId) return formValueIssue("select_valid_provider", "providerId");
      for (const owned of builtinEntry.savedConnection!.connectionOwnedFields) {
        if (owned in values) return formValueIssue("connection_field_forbidden", owned);
      }
      const connectionModel = typeof values.model === "string" ? values.model.trim() : "";
      if (!connectionModel) return formValueIssue("model_required", "model");
      // The model kind follows the connection's server-resolved provider, not
      // the typed name: a gateway connection always stores a custom model
      // (even when the name collides with a built-in preset id), and a preset
      // connection only accepts a model from its own list. Without a resolved
      // provider (unit-level calls) the static lists are the fallback; the
      // route's per-connection check remains the final authority either way.
      const connectionGateway = options.savedConnectionProviderId !== undefined
        && isBuiltInRuntimeGatewayProviderId(options.savedConnectionProviderId);
      const connectionPresetModels = options.savedConnectionProviderId !== undefined && !connectionGateway
        ? PI_BUILTIN_PROVIDER_MODELS[options.savedConnectionProviderId as keyof typeof PI_BUILTIN_PROVIDER_MODELS]
        : undefined;
      const presetKnown = connectionGateway
        ? false
        : connectionPresetModels
          ? connectionPresetModels.some((candidate) => candidate.id === connectionModel)
          : Object.values(PI_BUILTIN_PROVIDER_MODELS)
              .some((models) => models.some((candidate) => candidate.id === connectionModel));
      const connectionLimits = readModelLimitValues(values, !presetKnown);
      if (!connectionLimits.ok) return connectionLimits.build;
      return {
        ok: true,
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: { kind: "connection", connectionId },
          model: presetKnown ? { kind: "preset", id: connectionModel } : { kind: "custom", name: connectionModel, ...connectionLimits.limits },
          mode: { kind: "default" },
          reasoningEffort: effort.value,
          envVars,
          hostUserState: "forbidden",
          loadLocalPlugins: values.loadLocalPlugins === true,
        },
      };
    }
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
    const customAllowed = model.customValueAllowedByValue[providerId] === true;
    const listed = (model.optionsByValue[providerId] ?? []).some((candidate) => candidate.value === modelValue);
    if (!customAllowed && !listed) {
      return formValueIssue("select_valid_provider_model", "model");
    }
    const gateway = option.providerKind === "gateway";
    // A gateway always stores a custom model. On a preset provider that takes
    // a typed id (task #10: OpenRouter) the limits are explicit overrides for
    // any model: a listed model without one is its preset; a listed model with
    // one is a custom model named by its Pi id (the catalog id minus Raft's
    // `openrouter/`); an unlisted typed id is custom. The shared parser
    // applies the same rule to every write path (normalizeBuiltInPresetCustomModel).
    const presetTypable = !gateway && customAllowed && isBuiltInRuntimeCustomModelPresetProviderId(providerId);
    const listedOverride = presetTypable && listed && hasModelLimitValues(values);
    const customModel = gateway || (presetTypable && (!listed || listedOverride));
    if (!gateway && !listed && !customModel) return formValueIssue("select_valid_provider_model", "model");
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl.trim() : "";
    if (gateway && !/^https?:\/\//i.test(baseUrl)) return formValueIssue("base_url_invalid", "baseUrl");
    const limits = readModelLimitValues(values, customModel);
    if (!limits.ok) return limits.build;
    const customName = listedOverride ? builtInPresetProviderModelId(providerId, modelValue) : modelValue;
    return {
      ok: true,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: gateway
          ? { kind: "gateway", providerId, baseUrl, ...(apiKey ? { apiKey } : {}), supportsImageInput: values.supportsImageInput === true }
          : { kind: "preset", providerId, ...(apiKey ? { apiKey } : {}) },
        model: customModel ? { kind: "custom", name: customName, ...limits.limits } : { kind: "preset", id: modelValue },
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
    // A bound saved connection edits through the same v2 form: the provider
    // field carries the connection option value; the credential itself is
    // connection-owned and never appears in the values (writeOnly rule).
    if (provider && provider.kind === "connection" && typeof provider.connectionId === "string" && provider.connectionId) {
      return {
        providerId: `${SAVED_CONNECTION_VALUE_PREFIX}${provider.connectionId}`,
        model: modelValueOf(runtimeConfig),
        ...modelLimitValuesOf(runtimeConfig),
        reasoningEffort,
        loadLocalPlugins: runtimeConfig.loadLocalPlugins === true,
        envVars: envVarsOf(runtimeConfig),
      };
    }
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
      appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind !== "connection",
      keepsIdentity(incoming, existing) {
        const next = incoming.provider as Record<string, unknown>;
        const saved = existing.provider as Record<string, unknown>;
        if (next.kind === "connection" || saved.kind === "connection") return false;
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
      return { kind: "source", source: context.sourceStatus ? { ...source, ...optionSourceStatusFields(reason, true) } : source };
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
      // and offline only — every other non-live outcome keeps its typed 409
      // (this is the hard failure users saw as "model list unavailable" on
      // fresh machines).
      return managedDefault("missing_config");
    }
    if (detected.kind !== "live" && context.sourceStatus) {
      // Same fail-closed decision as v1, per source: no options to launch
      // with, the reason, and whether a retry can help.
      return {
        kind: "source",
        source: unavailableSource(
          buildKimiSdkFormOptionSource({ models: [], defaultModel: undefined }),
          optionSourceReasonForOutcome(detected) ?? "probe_failed",
        ),
      };
    }
    if (detected.kind !== "live") {
      return {
        kind: "reply",
        status: 409,
        body: {
          error: "Kimi model source is unavailable",
          issues: [{ code: `runtime_model_source_${detected.kind}`, pointer: "/optionSources/model" }],
        },
      };
    }
    const live = buildKimiSdkFormOptionSource({ models: detected.value.models, defaultModel: detected.value.default });
    return {
      kind: "source",
      source: context.sourceStatus ? { ...live, ...optionSourceStatusFields(optionSourceReasonForOutcome(detected), sourceHasOptions(live)) } : live,
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

/**
 * A v1 option-source response never carries `unavailableOptions` (a v2
 * contract field): released mobile apps decode some v1 bodies with unknown
 * keys refused.
 */
export function withoutV2OnlyOptionSourceFields(source: RuntimeFormV2OptionSourceBody): RuntimeFormV2OptionSourceBody {
  if (!("unavailableOptions" in source)) return source;
  const { unavailableOptions: _v2Only, ...rest } = source;
  return rest as RuntimeFormV2OptionSourceBody;
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
        ...(options.command ? { command: { type: "string", title: "Claude Command" } } : {}),
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: reasoningModelFieldKeys(options),
      layout: { advanced: [...(options.command ? ["/command"] : []), "/envVars"] },
      visibility: options.customProvider
        ? [
            { pointer: "/apiUrl", when: { pointer: "/provider", in: ["custom"] } },
            { pointer: "/authType", when: { pointer: "/provider", in: ["custom"] } },
            { pointer: "/apiKey", when: { pointer: "/provider", in: ["custom"] } },
          ]
        : [],
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
 * else the bundled entry for the same id, else the live entry. Every option
 * carries its efforts: the declared set in catalog order (unknown ids dropped),
 * or the BASE set for a model that declares none, which is what the server's
 * static rule (allowedReasoningEffortsForModel) accepts for it.
 */
function reasoningModelOption(
  runtimeId: string,
  model: RuntimeModelInfo,
): AgentCreateFormOption {
  const bundled = RUNTIME_MODELS[runtimeId]?.find((candidate) => candidate.id === model.id);
  const info = model.supportedReasoningEfforts?.length ? model : bundled ?? model;
  const declared = info.supportedReasoningEfforts?.length ? info.supportedReasoningEfforts : null;
  // None where the runtime applies only listed levels (runtimeOffersUndeclaredReasoningEfforts).
  const undeclared = runtimeOffersUndeclaredReasoningEfforts(runtimeId) ? defaultReasoningEffortsForRuntime(runtimeId) : [];
  const efforts = REASONING_EFFORTS
    .map((effort) => effort.id)
    .filter((id) => (declared ? declared.includes(id) : undeclared.includes(id)))
    .filter((id) => isReasoningEffortOfferedOnRuntime(runtimeId, id));
  const defaultEffort = declared && info.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort as never)
    ? info.defaultReasoningEffort
    : undefined;
  return {
    value: model.id,
    label: model.label,
    supportedReasoningEfforts: efforts,
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
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
  const sources = options.customProvider ? "provider\0authType\0model" : "model";
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
 * Claude's custom-provider API key: write-only in the v2 form (never in
 * `values`; a blank one on edit keeps the stored key while the API URL is
 * unchanged).
 *
 * `redactOnAgentRead: false`: the v1 agent read (GET /api/agents[/:id]) keeps
 * returning it to editors, because installed mobile apps prefill the key from
 * that read and refuse to save a Custom provider with a blank key (MembersPage
 * providerKeyInvalid); blanking it there would force every such user to retype
 * the key. Flip to true once released clients treat it as write-only.
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
  redactOnAgentRead: false,
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
      if (context.sourceId !== "model") return { kind: "source", source: null };
      const probe = await probeModels(context, runtimeId);
      if (probe.kind === "handled") return { kind: "handled" };
      if (probe.kind === "live") {
        // "The runtime chooses" (Antigravity's `default`) stays first and
        // preselected, and a stored one stays listed on edit.
        const runtimeChoice = runtimeChoiceModel(runtimeId);
        if (runtimeChoice) {
          const models = [runtimeChoice, ...probe.models.filter((model) => model.id !== runtimeChoice.id)];
          return { kind: "source", source: reasoningModelOptionSource(runtimeId, models, runtimeChoice.id, null, options, probe.unavailable) };
        }
        return { kind: "source", source: reasoningModelOptionSource(runtimeId, probe.models, probe.default, null, options, probe.unavailable) };
      }
      return {
        kind: "source",
        source: reasoningModelOptionSource(runtimeId, RUNTIME_MODELS[runtimeId] ?? [], undefined, probe.reason, options),
      };
    },
    runtimeConfigFromValues(values, envVars, valueOptions) {
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      // A form without a reasoning field ignores a stray value, like fastMode below.
      const effort = options.reasoning ? values.reasoningEffort : null;
      if (effort !== undefined && effort !== null && typeof effort !== "string") {
        return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
      }
      const fastMode = values.fastMode;
      if (fastMode !== undefined && fastMode !== null && typeof fastMode !== "boolean") {
        return formValueIssue("invalid_boolean", "fastMode");
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
          mode: options.fastMode && fastMode === true && runtimeModelSupportsFastMode(runtimeId, modelValue)
            ? { kind: "fast" }
            : { kind: "default" },
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
        model: modelValueOf(runtimeConfig),
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
        ...(options.command ? { command: typeof runtimeConfig.command === "string" ? runtimeConfig.command : "" } : {}),
        envVars: envVarsOf(runtimeConfig),
      };
    },
    ...(options.customProvider ? { writeOnlySecrets: [CLAUDE_CUSTOM_PROVIDER_API_KEY] } : {}),
    reconcileWithLiveModels(runtimeConfig, submittedReasoningEffort, models, storedReasoningEffort = null) {
      const modelValue = runtimeConfig.model.kind === "custom" ? runtimeConfig.model.name : runtimeConfig.model.id;
      const live = models.find((model) => model.id === modelValue);
      // Not in the live list: a custom model, or a bundled one this Computer
      // does not report. The static rule already applied stays final.
      if (!live) return { kind: "unchanged" };
      if (!options.reasoning) {
        // Nothing to decide but the model kind: a live-listed one is a preset.
        return runtimeConfig.model.kind === "custom"
          ? { kind: "updated", runtimeConfig: { ...runtimeConfig, model: { kind: "preset", id: modelValue } } as RuntimeConfig }
          : { kind: "unchanged" };
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

// Runtimes that run only on the Computer's OAR host (Qwen Code, Qoder). OAR's
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

// CodeBuddy Code, OAR-only like Qwen Code and Qoder: the models
// the Computer's CodeBuddy login offers (OAR listModels, a new ACP session's
// model menu), a typed id allowed. The effort is CodeBuddy's ACP thought
// level, which it reports for its current model only, so it is offered only
// for a model whose levels the Computer listed (as Antigravity's).
const codebuddyEntry = reasoningModelFormEntry("codebuddy", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  modelHint: "Models available to this computer's CodeBuddy Code login. You can also type a model ID.",
});

// Antigravity on the OAR host: the models the Computer's `agy` login offers
// (OAR listModels), a typed id allowed, and "AGY configured default" (`default`,
// no model passed) kept first and preselected, so a stored default still means
// "agy chooses". The effort is agy's thought level, offered only for a model
// whose levels the Computer listed; OAR applies it as the session's `effort`.
// A model id that already names its level carries none (the daemon drops it).
const antigravityEntry = reasoningModelFormEntry("antigravity", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  modelHint: "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.",
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
 *   providerId, apiKey }`). Pi has no saved provider connections: the legacy
 *   dialogs load them only for Built-in, and the parser has no `connection`
 *   provider for Pi.
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
 * The Pi built-in provider key: write-only in the v2 form (never in `values`;
 * a blank one on edit keeps the stored key while the provider is unchanged).
 *
 * `redactOnAgentRead: false`, like Claude's key: the legacy web edit form
 * prefills the key from the v1 agent read (AgentDetailPanel,
 * runtimeConfigPiProviderApiKey) and refuses to save a blank one, and the
 * strict parser rejects a blank `pi-builtin` key, so a blanked read would not
 * even hydrate there. Flip to true once released clients treat it as write-only.
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
  redactOnAgentRead: false,
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
  // Batch 2. Kimi CLI, Gemini CLI and Antigravity are deprecated (as is Copilot
  // CLI, batch 3b): the admission row offers them (and so their v2 marker) only
  // as an edited agent's current runtime, and a create with them is refused like
  // any deprecated runtime.
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
  [codebuddyEntry.runtimeId, codebuddyEntry],
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
 * The edit body on the per-server v2 build: same as buildRuntimeFormV2EditBody,
 * but the base form comes from buildRuntimeFormV2ForServer, so a builtin edit
 * on a server with provider connections carries the saved-connection
 * capability, the x-connectionOwned markers and the revision token.
 */
export async function buildRuntimeFormV2EditBodyForServer(
  runtimeId: string,
  runtimeConfig: unknown,
  serverId: string,
  clientCapabilities: readonly string[] = [],
): Promise<RuntimeFormV2Definition | null> {
  const entry = runtimeFormV2Entry(runtimeId);
  const values = runtimeFormValuesFromRuntimeConfig(runtimeConfig);
  if (!entry || !values) return null;
  const base = await buildRuntimeFormV2ForServer(runtimeId, serverId, clientCapabilities) ?? entry.buildForm();
  const keep = runtimeFormV2WriteOnlyKeepRequiresUnchanged(runtimeId);
  return { ...base, ...(keep ? { writeOnlyKeepRequiresUnchanged: keep } : {}), values };
}

/**
 * task #10: a stored Built-in config a newer client wrote on a preset provider
 * that takes a typed id (OpenRouter): a custom model, either a typed id or a
 * listed model saved with limit overrides. Null for every other config.
 */
function storedBuiltInPresetCustomModel(runtimeConfig: unknown): {
  providerId: string;
  /** The Model value the edit form shows (listedModelValueOf). */
  modelValue: string;
  /** A typed id no catalog entry has: a list-only client cannot show it. */
  unlisted: boolean;
  hasLimits: boolean;
} | null {
  if (!isPlainRecord(runtimeConfig) || runtimeConfig.runtime !== "builtin") return null;
  const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
  const model = isPlainRecord(runtimeConfig.model) ? runtimeConfig.model : null;
  if (provider?.kind !== "preset" || typeof provider.providerId !== "string" || model?.kind !== "custom") return null;
  if (!isBuiltInRuntimeCustomModelPresetProviderId(provider.providerId)) return null;
  const modelValue = listedModelValueOf(provider.providerId, runtimeConfig);
  const unlisted = !(PI_BUILTIN_PROVIDER_MODELS[provider.providerId] ?? []).some((candidate) => candidate.id === modelValue);
  return {
    providerId: provider.providerId,
    modelValue,
    unlisted,
    hasLimits: typeof model.contextWindow === "number" || typeof model.maxOutputTokens === "number",
  };
}

/**
 * task #10: the Built-in v2 edit form for one agent, one client, one Computer.
 * - The limit fields show for the preset providers the client and Computer
 *   support (`typedPresetProviderIds`, builtInTypedModelProvidersFor) and,
 *   whatever those say, for the agent's own provider while it HAS a stored
 *   limit: a hidden field is left out of the submit, and a save without it
 *   would silently delete the limit.
 * - A client without `dependent_select.custom_value_with_options` gets a
 *   stored typed OpenRouter id it cannot show in a list-only Model field
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
  const limitProviders = stored?.hasLimits && !typedPresetProviderIds.includes(stored.providerId)
    ? [...typedPresetProviderIds, stored.providerId]
    : [...typedPresetProviderIds];
  let next = withBuiltInModelLimitVisibility(form, limitProviders);
  if (stored?.unlisted && !clientRendersDependentCustomWithOptions(clientCapabilities)) {
    const providers = (buildBuiltInPiFormOptionSource("provider") as { options?: Array<{ value: string }> } | null)?.options ?? [];
    next = {
      ...next,
      uiSchema: {
        ...next.uiSchema,
        visibility: [
          ...(next.uiSchema?.visibility ?? []),
          { pointer: "/model", when: { pointer: "/providerId", in: providers.map((option) => option.value).filter((value) => value !== stored.providerId) } },
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
 * saved with a typed OpenRouter id or limit overrides.
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
  if (values.providerId !== stored.providerId) return refuse("providerId");
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
 * Only asks the Computer when there is something to decide (an effort, or a
 * custom model). Legacy (non-v2) submits never come here.
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
  if (!entry?.reconcileWithLiveModels || !input.machineId) return { kind: "unchanged" };
  const effort = typeof input.submittedReasoningEffort === "string" && input.submittedReasoningEffort
    ? input.submittedReasoningEffort
    : null;
  if (effort === null && input.runtimeConfig.model.kind !== "custom") return { kind: "unchanged" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    outcome = await input.detect(input.machineId, input.runtimeConfig.runtime);
  } catch {
    return { kind: "unchanged" };
  }
  if (outcome.kind !== "live" || outcome.value.models.length === 0) return { kind: "unchanged" };
  const stored = input.existing?.runtime === input.runtimeConfig.runtime ? input.existing.reasoningEffort ?? null : null;
  return entry.reconcileWithLiveModels(input.runtimeConfig, effort, outcome.value.models, stored);
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
 * without a v2 form, managed provider connections).
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
