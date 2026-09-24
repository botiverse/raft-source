import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  getDefaultModel,
  hydrateRuntimeConfig,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  parseRuntimeConfig,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_FAST_MODE_RUNTIMES,
} from "@botiverse/raft-shared";
import type {
  BuiltInRuntimeAnyProviderId,
  BuiltInRuntimeConfig,
  BuiltInRuntimeGatewayProviderId,
  BuiltInRuntimeProviderId,
  ReasoningEffort,
  RuntimeConfig,
  RuntimeConfigHydrationInput,
  RuntimeModeConfig,
} from "@botiverse/raft-shared";

export const CUSTOM_MODEL_SELECT_VALUE = "__custom__";
export type RuntimeProviderMode = "default" | "custom";

/** Stable codes for UI localization; `message` remains English for logs/tests. */
export type RuntimeConfigBuildErrorCode =
  | "optionSourcesInvalid"
  | "selectValidProvider"
  | "selectValidProviderConnection"
  | "selectValidProviderModel"
  | "apiKeyRequired"
  | "modelRequired"
  | "baseUrlInvalid"
  | "runtimeConfigInvalid";

export const RUNTIME_CONFIG_BUILD_ERROR_MESSAGE_ID = {
  optionSourcesInvalid: "agent.runtimeConfig.optionSourcesInvalid",
  selectValidProvider: "agent.runtimeConfig.selectValidProvider",
  selectValidProviderConnection: "agent.runtimeConfig.selectValidProviderConnection",
  selectValidProviderModel: "agent.runtimeConfig.selectValidProviderModel",
  apiKeyRequired: "agent.runtimeConfig.apiKeyRequired",
  modelRequired: "agent.runtimeConfig.modelRequired",
  baseUrlInvalid: "agent.runtimeConfig.baseUrlInvalid",
  runtimeConfigInvalid: "agent.detail.runtimeConfigInvalid",
} as const;

export class RuntimeConfigBuildError extends Error {
  readonly code: RuntimeConfigBuildErrorCode;

  constructor(codeOrMessage: RuntimeConfigBuildErrorCode | string, message?: string) {
    const known =
      codeOrMessage === "optionSourcesInvalid"
      || codeOrMessage === "selectValidProvider"
      || codeOrMessage === "selectValidProviderConnection"
      || codeOrMessage === "selectValidProviderModel"
      || codeOrMessage === "apiKeyRequired"
      || codeOrMessage === "modelRequired"
      || codeOrMessage === "baseUrlInvalid"
      || codeOrMessage === "runtimeConfigInvalid";
    const code: RuntimeConfigBuildErrorCode = known
      ? (codeOrMessage as RuntimeConfigBuildErrorCode)
      : "runtimeConfigInvalid";
    super(message ?? (known ? codeOrMessage : codeOrMessage));
    this.name = "RuntimeConfigBuildError";
    this.code = code;
  }
}

/**
 * Pi-runtime provider mode for the create-agent UI.
 *  - "configured": rely on the host's pi-coding-agent auth.json (default).
 *  - "<providerId>": web-supplied API key, injected as the corresponding env
 *    var (PI_BUILTIN_PROVIDER_ENV_KEYS) so the SDK's getEnvApiKey path
 *    resolves without any auth.json mutation.
 */
export type PiProviderMode = "configured" | string;
export type BuiltInProviderMode = BuiltInRuntimeAnyProviderId;
export const PI_PROVIDER_CONFIGURED: PiProviderMode = "configured";
export const PI_BUILTIN_PROVIDER_IDS = Object.keys(PI_BUILTIN_PROVIDER_ENV_KEYS);
export const BUILTIN_RUNTIME_PROVIDER_IDS = Object.keys(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS) as BuiltInRuntimeProviderId[];
export const BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS = Object.keys(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS) as BuiltInRuntimeGatewayProviderId[];
export const BUILTIN_RUNTIME_ALL_PROVIDER_IDS = [
  ...BUILTIN_RUNTIME_PROVIDER_IDS,
  ...BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS,
] as BuiltInRuntimeAnyProviderId[];
export const BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID: BuiltInProviderMode = BUILTIN_RUNTIME_PROVIDER_IDS[0] ?? "deepseek";

export function isBuiltInGatewayProviderMode(providerMode: string): providerMode is BuiltInRuntimeGatewayProviderId {
  return (BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS as readonly string[]).includes(providerMode);
}

export function supportsRuntimeBuiltInProvider(runtime: string): boolean {
  return runtime === "builtin";
}

export function supportsRuntimePiProvider(runtime: string): boolean {
  return runtime === "pi";
}

export function runtimeConfigBuiltInProviderApiKey(config: RuntimeConfig): string {
  if (config.runtime !== "builtin") return "";
  const provider = (config as { provider?: { kind?: string; apiKey?: string } }).provider;
  return (provider?.kind === "preset" || provider?.kind === "gateway") && typeof provider.apiKey === "string" ? provider.apiKey : "";
}

export function runtimeConfigBuiltInProviderBaseUrl(config: RuntimeConfig): string {
  if (config.runtime !== "builtin") return "";
  const provider = (config as { provider?: { kind?: string; baseUrl?: string } }).provider;
  return provider?.kind === "gateway" && typeof provider.baseUrl === "string" ? provider.baseUrl : "";
}

export function runtimeConfigBuiltInProviderSupportsImageInput(config: RuntimeConfig): boolean {
  // Built-in hydration can arrive without provider when member projections /
  // agent:created strip private runtimeConfig (same hole as shared legacy
  // builtInSelectionTraceAttrs). Never throw on render paths.
  if (config.runtime !== "builtin" || config.provider?.kind !== "gateway") return false;
  return config.provider.supportsImageInput === true;
}

export function runtimeConfigBuiltInProviderMode(config: RuntimeConfig): BuiltInProviderMode {
  if (config.runtime !== "builtin") return BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID;
  return config.provider?.kind === "preset" || config.provider?.kind === "gateway"
    ? config.provider.providerId
    : BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID;
}

export function runtimeConfigProviderConnectionId(config: RuntimeConfig): string {
  return config.runtime === "builtin" && config.provider?.kind === "connection"
    ? config.provider.connectionId
    : "";
}

export function runtimeConfigPiProviderMode(config: RuntimeConfig): PiProviderMode {
  if (config.runtime !== "pi") return PI_PROVIDER_CONFIGURED;
  return config.provider?.kind === "pi-builtin"
    ? config.provider.providerId
    : PI_PROVIDER_CONFIGURED;
}

export function runtimeConfigPiProviderApiKey(config: RuntimeConfig): string {
  return config.provider?.kind === "pi-builtin" ? config.provider.apiKey : "";
}

/**
 * Returns the SDK-known model list for a Built-in/Pi provider, or null when
 * the providerId isn't one we surface. The first entry is the default (kept
 * aligned with the SDK's defaultModelPerProvider).
 */
export function piBuiltinProviderModels(providerId: string): ReadonlyArray<{ id: string; label: string }> | null {
  return PI_BUILTIN_PROVIDER_MODELS[providerId] ?? null;
}

export function builtInProviderModels(providerId: string): ReadonlyArray<{ id: string; label: string }> | null {
  if (isBuiltInGatewayProviderMode(providerId)) return null;
  return PI_BUILTIN_PROVIDER_MODELS[providerId] ?? null;
}

export function piBuiltinProviderDefaultModel(providerId: string): string | null {
  return PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? null;
}

export function builtInProviderDefaultModel(providerId: string): string | null {
  return PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? null;
}

export function supportsRuntimeApiUrl(runtime: string): boolean {
  return runtime === "claude";
}

export function runtimeApiUrlUnsupportedCopy(runtime: string): string | null {
  if (runtime === "cursor") {
    return "Cursor CLI does not expose a per-agent API URL flag or env var. Configure provider routing in Cursor itself.";
  }
  return null;
}

export function supportsRuntimeCustomModelName(runtime: string): boolean {
  return runtime === "builtin" || runtime === "claude" || runtime === "codex" || runtime === "cursor" || runtime === "copilot" || runtime === "pi";
}

/** Antigravity owns model selection internally; its Web model field is ignored. */
export function runtimeIgnoresModel(runtime: string): boolean {
  return runtime === "antigravity";
}

export function supportsRuntimeFastMode(runtime: string): boolean {
  return RUNTIME_FAST_MODE_RUNTIMES.has(runtime);
}

export function supportsRuntimeCommand(runtime: string): boolean {
  return runtime === "claude";
}

export function runtimeConfigCustomModelName(config: RuntimeConfig): string {
  return config.model.kind === "custom" ? config.model.name : "";
}

export function runtimeConfigApiUrl(config: RuntimeConfig): string {
  return config.provider?.kind === "custom" ? config.provider.apiUrl : "";
}

export function runtimeConfigApiKey(config: RuntimeConfig): string {
  return config.provider?.kind === "custom" ? config.provider.apiKey : "";
}

export function runtimeConfigProviderMode(config: RuntimeConfig): RuntimeProviderMode {
  return config.provider?.kind === "custom" ? "custom" : "default";
}

export function runtimeConfigFastMode(config: RuntimeConfig): boolean {
  return config.mode.kind === "fast";
}

export function runtimeConfigCommand(config: RuntimeConfig): string {
  return config.command?.trim() ?? "";
}

export function buildRuntimeConfig(input: {
  runtime: string;
  model: string;
  customModelMode: boolean;
  customModelName?: string;
  providerMode?: RuntimeProviderMode;
  providerApiUrl?: string;
  providerApiKey?: string;
  builtInProviderMode?: BuiltInProviderMode;
  builtInProviderApiKey?: string;
  builtInProviderBaseUrl?: string;
  builtInProviderSupportsImageInput?: boolean;
  piProviderMode?: PiProviderMode;
  piProviderApiKey?: string;
  fastMode?: boolean;
  reasoningEffort?: ReasoningEffort | null;
  envVars?: Record<string, string> | null;
  command?: string | null;
}): RuntimeConfig {
  const runtime = input.runtime || "claude";
  const customModelName = input.customModelName?.trim() || input.model.trim();
  const providerMode: RuntimeProviderMode = input.providerMode
    ?? (input.providerApiUrl?.trim() ? "custom" : "default");
  const piProviderMode: PiProviderMode = input.piProviderMode ?? PI_PROVIDER_CONFIGURED;
  const builtInProviderMode: BuiltInProviderMode = input.builtInProviderMode ?? BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID;
  const piProviderApiKey = input.piProviderApiKey?.trim() ?? "";
  const builtInProviderApiKey = input.builtInProviderApiKey?.trim() ?? "";
  const builtInProviderBaseUrl = input.builtInProviderBaseUrl?.trim() ?? "";
  const builtInProviderSupportsImageInput = input.builtInProviderSupportsImageInput;
  const isBuiltInGateway = runtime === "builtin" && isBuiltInGatewayProviderMode(builtInProviderMode);
  const isPiBuiltin =
    runtime === "pi"
    && piProviderMode !== PI_PROVIDER_CONFIGURED
    && PI_BUILTIN_PROVIDER_IDS.includes(piProviderMode);
  const mode: RuntimeModeConfig = input.fastMode && supportsRuntimeFastMode(runtime)
    ? { kind: "fast" }
    : { kind: "default" };
  const runtimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    runtime,
    ...(supportsRuntimeApiUrl(runtime)
      ? {
          provider: providerMode === "custom"
            ? {
                kind: "custom" as const,
                apiUrl: input.providerApiUrl?.trim() ?? "",
                apiKey: input.providerApiKey?.trim() ?? "",
              }
            : { kind: "default" as const },
        }
      : {}),
    ...(runtime === "builtin"
      ? {
          provider: isBuiltInGatewayProviderMode(builtInProviderMode)
            ? {
                kind: "gateway" as const,
                providerId: BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS.includes(builtInProviderMode)
                  ? builtInProviderMode
                  : BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS[0] ?? "openai-compatible",
                baseUrl: builtInProviderBaseUrl,
                apiKey: builtInProviderApiKey,
                ...(typeof builtInProviderSupportsImageInput === "boolean"
                  ? { supportsImageInput: builtInProviderSupportsImageInput }
                  : {}),
              }
            : {
                kind: "preset" as const,
                providerId: BUILTIN_RUNTIME_PROVIDER_IDS.includes(builtInProviderMode)
                  ? builtInProviderMode
                  : BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID,
                apiKey: builtInProviderApiKey,
              },
          hostUserState: "forbidden" as const,
        }
      : {}),
    ...(runtime === "pi"
      ? {
          provider: isPiBuiltin
            ? {
                kind: "pi-builtin" as const,
                providerId: piProviderMode,
                apiKey: piProviderApiKey,
              }
            : { kind: "default" as const },
        }
      : {}),
    model: isBuiltInGateway || input.customModelMode
      ? { kind: "custom", name: customModelName || getDefaultModel(runtime) }
      : { kind: "preset", id: input.model || getDefaultModel(runtime) },
    mode,
    reasoningEffort: input.reasoningEffort ?? null,
    envVars: input.envVars ?? null,
    ...(supportsRuntimeCommand(runtime) && input.command?.trim()
      ? { command: input.command.trim() }
      : {}),
  };
  const parsed = parseRuntimeConfig({ runtimeConfig });
  if (!parsed.ok) throw new RuntimeConfigBuildError(parsed.error);
  return parsed.config;
}

export function buildManagedConnectionRuntimeConfig(input: {
  connectionId: string;
  providerId: string;
  model: string;
  envVars: Record<string, string> | null;
}): BuiltInRuntimeConfig {
  const connectionId = input.connectionId.trim();
  const model = input.model.trim();
  if (!connectionId || !BUILTIN_RUNTIME_ALL_PROVIDER_IDS.includes(input.providerId as BuiltInRuntimeAnyProviderId)) {
    throw new RuntimeConfigBuildError("selectValidProviderConnection", "Select a valid provider connection");
  }
  if (!model) throw new RuntimeConfigBuildError("modelRequired", "Model is required");
  const gateway = isBuiltInGatewayProviderMode(input.providerId);
  if (!gateway && !(builtInProviderModels(input.providerId) ?? []).some((candidate) => candidate.id === model)) {
    throw new RuntimeConfigBuildError("selectValidProviderModel", "Select a valid provider model");
  }
  const runtimeConfig: BuiltInRuntimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId },
    model: gateway ? { kind: "custom", name: model } : { kind: "preset", id: model },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: input.envVars,
    hostUserState: "forbidden",
  };
  const parsed = parseRuntimeConfig({ runtimeConfig });
  if (!parsed.ok || parsed.config.runtime !== "builtin") {
    throw new RuntimeConfigBuildError(
      "runtimeConfigInvalid",
      parsed.ok ? "Runtime config is invalid" : parsed.error,
    );
  }
  return parsed.config;
}

export function hydrateRuntimeConfigForm(input: RuntimeConfigHydrationInput): RuntimeConfig {
  // Agent API projections intentionally blank Built-in provider secrets. Run
  // the non-secret structure through the strict parser with an ephemeral local
  // placeholder, then restore the blank read value. This is a Web read adapter
  // only; create/update writes still use the strict parser and can never persist
  // the placeholder.
  const projected = input.runtimeConfig;
  if (
    projected
    && typeof projected === "object"
    && !Array.isArray(projected)
  ) {
    const projectedRecord = projected as Record<string, unknown>;
    const projectedProvider = projectedRecord.provider;
    if (
      projectedRecord.runtime !== "builtin"
      || !projectedProvider
      || typeof projectedProvider !== "object"
      || Array.isArray(projectedProvider)
      || (projectedProvider as Record<string, unknown>).apiKey !== ""
    ) {
      return hydrateRuntimeConfig(input);
    }
    const projectedProviderRecord = projectedProvider as Record<string, unknown>;
    const parsed = parseRuntimeConfig({
      runtimeConfig: {
        ...projectedRecord,
        provider: { ...projectedProviderRecord, apiKey: "redacted-read-adapter" },
      },
    });
    if (parsed.ok && parsed.config.runtime === "builtin" && parsed.config.provider.kind !== "connection") {
      return {
        ...parsed.config,
        provider: { ...parsed.config.provider, apiKey: "" },
      };
    }
  }
  return hydrateRuntimeConfig(input);
}

/**
 * Whether an agent-local built-in provider API key is genuinely missing.
 *
 * Selecting a saved Provider connection means the credential comes from the
 * connection reference, so an empty agent-local key is not a defect in that
 * state — this is the predicate behind that rule. It lives here, rather than
 * inline in the panel, so it can be tested for the right cause: asserting on
 * the rendered save button cannot distinguish "blocked by the key" from
 * "blocked because nothing changed yet", since both disable the same button.
 */
export function isBuiltInProviderApiKeyInvalid(input: {
  builtInProviderSupported: boolean;
  managedConnectionActive: boolean;
  apiKey: string;
  retainsExistingKey: boolean;
}): boolean {
  return input.builtInProviderSupported
    && !input.managedConnectionActive
    && !input.apiKey.trim()
    && !input.retainsExistingKey;
}

/**
 * The runtime-config save gate.
 *
 * Every reason the submit button can be disabled, in one place. Kept as a pure
 * function because the button collapses eleven independent causes into a single
 * boolean: a test that only reads `button.disabled` proves nothing about *which*
 * cause fired, so a regression in one term can hide behind another.
 */
export function isRuntimeConfigSaveDisabled(input: {
  saving: boolean;
  changed: boolean;
  runtimeCanSelect: boolean;
  providerConnectionInvalid: boolean;
  providerApiUrlInvalid: boolean;
  providerApiKeyInvalid: boolean;
  builtInProviderApiKeyInvalid: boolean;
  piProviderApiKeyInvalid: boolean;
  builtInProviderBaseUrlInvalid: boolean;
  customModelInvalid: boolean;
  modelSourceInvalid: boolean;
}): boolean {
  return input.saving
    || !input.changed
    || !input.runtimeCanSelect
    || input.providerConnectionInvalid
    || input.providerApiUrlInvalid
    || input.providerApiKeyInvalid
    || input.builtInProviderApiKeyInvalid
    || input.piProviderApiKeyInvalid
    || input.builtInProviderBaseUrlInvalid
    || input.customModelInvalid
    || input.modelSourceInvalid;
}
