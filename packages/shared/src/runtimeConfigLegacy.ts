import type {
  BuiltInRuntimeProviderConfig,
  BuiltInRuntimeGatewayProviderId,
  BuiltInRuntimeGatewayBaseUrlHostClass,
  BuiltInRuntimeProviderId,
  ClaudeRuntimeProviderConfig,
  PiRuntimeProviderConfig,
  RuntimeReasoningEffort,
  RuntimeConfig,
  RuntimeConfigHydrationInput,
  RuntimeConfigParseTraceAttrs,
  RuntimeModeConfig,
  RuntimeModelConfig,
  RuntimeModelInfo,
} from "./index.js";

interface RuntimeConfigLegacyHydrationDeps {
  runtimeConfigVersion: RuntimeConfig["version"];
  runtimeModels: Record<string, RuntimeModelInfo[]>;
  runtimeConfigFields: readonly string[];
  modelConfigFields: readonly string[];
  modeConfigFields: readonly string[];
  getDefaultModel(runtime: string): string;
  builtinProviderEnvKeys: Record<BuiltInRuntimeProviderId, string>;
  builtinGatewayProviderEnvKeys: Record<BuiltInRuntimeGatewayProviderId, string>;
  piBuiltinProviderEnvKeys: Record<string, string>;
  providerKnownFieldsFor(runtime: string | undefined, provider: Record<string, unknown>): readonly string[];
  stripControlledRuntimeEnvVars(runtime: string, envVars: Record<string, string> | null | undefined): Record<string, string> | null;
  composeRuntimeConfig(input: {
    runtime: string;
    provider?: BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig;
    model: RuntimeModelConfig;
    mode: RuntimeModeConfig;
    reasoningEffort?: RuntimeReasoningEffort | null;
    envVars?: Record<string, string> | null;
    command?: string | null;
  }): RuntimeConfig;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function whitelistRecord(
  record: Record<string, unknown>,
  knownFields: readonly string[],
): { value: Record<string, unknown>; droppedCount: number } {
  const known = new Set(knownFields);
  const value: Record<string, unknown> = {};
  let droppedCount = 0;
  for (const [key, fieldValue] of Object.entries(record)) {
    if (known.has(key)) {
      value[key] = fieldValue;
    } else {
      droppedCount += 1;
    }
  }
  return { value, droppedCount };
}

// Read-side compatibility only: older DB rows may contain fields that no
// current writer can emit. Hydration drops those unknown fields and records
// `legacy_sanitized`; request writes still go through parseRuntimeConfig and
// fail closed on the same unknown fields.
function sanitizeStoredRuntimeConfig(
  record: Record<string, unknown>,
  deps: Pick<RuntimeConfigLegacyHydrationDeps, "runtimeConfigFields" | "modelConfigFields" | "modeConfigFields" | "providerKnownFieldsFor">,
): { value: Record<string, unknown>; droppedCount: number } {
  const topLevel = whitelistRecord(record, deps.runtimeConfigFields);
  const value = { ...topLevel.value };
  let droppedCount = topLevel.droppedCount;
  const runtime = typeof value.runtime === "string" ? value.runtime : undefined;

  if (isPlainRecord(value.model)) {
    const model = whitelistRecord(value.model, deps.modelConfigFields);
    value.model = model.value;
    droppedCount += model.droppedCount;
  }
  if (isPlainRecord(value.mode)) {
    const mode = whitelistRecord(value.mode, deps.modeConfigFields);
    value.mode = mode.value;
    droppedCount += mode.droppedCount;
  }
  if (isPlainRecord(value.provider)) {
    const provider = whitelistRecord(value.provider, deps.providerKnownFieldsFor(runtime, value.provider));
    value.provider = provider.value;
    droppedCount += provider.droppedCount;
  }
  return { value, droppedCount };
}

function normalizeEnvVars(envVars: unknown): Record<string, string> | null {
  if (!isPlainRecord(envVars)) return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof key === "string" && typeof value === "string") {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isPresetRuntimeModel(runtimeModels: Record<string, RuntimeModelInfo[]>, runtime: string, model: string): boolean {
  return (runtimeModels[runtime] ?? []).some((candidate) => candidate.id === model);
}

function hasMapKey<T extends string>(map: Record<T, string>, key: string): key is T {
  return Object.prototype.hasOwnProperty.call(map, key);
}

function modelConfigFromLegacy(
  runtimeModels: Record<string, RuntimeModelInfo[]>,
  runtime: string,
  model: string,
): RuntimeModelConfig {
  return isPresetRuntimeModel(runtimeModels, runtime, model)
    ? { kind: "preset", id: model }
    : { kind: "custom", name: model };
}

// Legacy stored rows predate runtime-scoped provider arms and sometimes kept
// Claude custom-provider credentials only in envVars. Hydration may recover
// that shape for read/launch compatibility; parseRuntimeConfig requires the
// structured provider shape for any new runtimeConfig write.
function parseProviderConfig(
  runtime: string,
  value: unknown,
  builtinProviderEnvKeys: Record<BuiltInRuntimeProviderId, string>,
  builtinGatewayProviderEnvKeys: Record<BuiltInRuntimeGatewayProviderId, string>,
  piBuiltinProviderEnvKeys: Record<string, string>,
  legacyApiUrl?: string,
  legacyApiKey?: string,
): BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig | undefined {
  if (runtime === "builtin") {
    if (
      value
      && isPlainRecord(value)
      && value.kind === "connection"
      && typeof value.connectionId === "string"
      && value.connectionId.trim()
    ) {
      return { kind: "connection", connectionId: value.connectionId.trim() };
    }
    const providerId = isPlainRecord(value) && typeof value.providerId === "string"
      ? value.providerId.trim()
      : "";
    if (
      value
      && isPlainRecord(value)
      && (value.kind === "preset" || value.kind === "managed")
      && providerId
      && typeof value.apiKey === "string"
      && value.apiKey.trim()
      && hasMapKey(builtinProviderEnvKeys, providerId)
    ) {
      return { kind: "preset", providerId, apiKey: value.apiKey.trim() };
    }
    if (
      value
      && isPlainRecord(value)
      && value.kind === "gateway"
      && providerId
      && typeof value.baseUrl === "string"
      && value.baseUrl.trim()
      && typeof value.apiKey === "string"
      && value.apiKey.trim()
      && hasMapKey(builtinGatewayProviderEnvKeys, providerId)
    ) {
      return {
        kind: "gateway",
        providerId,
        baseUrl: value.baseUrl.trim(),
        apiKey: value.apiKey.trim(),
        ...(typeof value.supportsImageInput === "boolean"
          ? { supportsImageInput: value.supportsImageInput }
          : {}),
      };
    }
    return undefined;
  }
  if (runtime === "claude") {
    if (!isPlainRecord(value)) return { kind: "default" };
    if (
      value.kind === "custom"
      && typeof value.apiUrl === "string"
      && value.apiUrl.trim()
      && typeof value.apiKey === "string"
      && value.apiKey.trim()
    ) {
      return { kind: "custom", apiUrl: value.apiUrl.trim(), apiKey: value.apiKey.trim() };
    }
    if (value.kind === "custom" && legacyApiUrl?.trim() && legacyApiKey?.trim()) {
      return { kind: "custom", apiUrl: legacyApiUrl.trim(), apiKey: legacyApiKey.trim() };
    }
    return { kind: "default" };
  }
  if (runtime === "pi") {
    if (!isPlainRecord(value)) return { kind: "default" };
    if (
      value.kind === "pi-builtin"
      && typeof value.providerId === "string"
      && value.providerId.trim()
      && typeof value.apiKey === "string"
      && value.apiKey.trim()
      && Object.prototype.hasOwnProperty.call(piBuiltinProviderEnvKeys, value.providerId.trim())
    ) {
      return { kind: "pi-builtin", providerId: value.providerId.trim(), apiKey: value.apiKey.trim() };
    }
    return { kind: "default" };
  }
  return undefined;
}

// Legacy rows persisted `agent.model` as the launch model string before
// RuntimeConfig.model existed. Hydration maps that string into the structured
// model arm so old agents still launch, but strict writes must provide a valid
// RuntimeConfig.model object.
function parseModelConfig(
  runtimeModels: Record<string, RuntimeModelInfo[]>,
  runtime: string,
  value: unknown,
  fallback: string,
  usesLegacyClaudeCustomProvider?: boolean,
  legacyCustomModel?: string,
): RuntimeModelConfig {
  if (!isPlainRecord(value)) return modelConfigFromLegacy(runtimeModels, runtime, fallback);
  if (value.kind === "custom" && typeof value.name === "string" && value.name.trim()) {
    return { kind: "custom", name: value.name.trim() };
  }
  if (usesLegacyClaudeCustomProvider && runtime === "claude" && legacyCustomModel?.trim()) {
    return { kind: "custom", name: legacyCustomModel.trim() };
  }
  if (
    value.kind === "preset"
    && typeof value.id === "string"
    && value.id.trim()
  ) {
    return { kind: "preset", id: value.id.trim() };
  }
  return modelConfigFromLegacy(runtimeModels, runtime, fallback);
}

function parseModeConfig(value: unknown): RuntimeModeConfig {
  if (!isPlainRecord(value)) return { kind: "default" };
  if (value.kind === "fast") return { kind: "fast" };
  return { kind: "default" };
}

// Command is an old Claude-only launch override. Hydration ignores it for every
// other runtime to keep old rows readable; parseRuntimeConfig rejects non-Claude
// command payloads before they can become current persisted config.
function parseCommandConfig(runtime: string, value: unknown): string | undefined {
  if (runtime !== "claude" || typeof value !== "string") return undefined;
  const command = value.trim();
  return command ? command : undefined;
}

function providerKind(config: RuntimeConfig): string {
  return config.provider?.kind ?? "none";
}

function classifyBuiltInGatewayBaseUrlHost(baseUrl: string): BuiltInRuntimeGatewayBaseUrlHostClass {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "public";
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.")) return "localhost";
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((part) => Number(part));
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
  }
  if (hostname === "0.0.0.0" || hostname === "::" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return "private";
  return "public";
}

function builtInSelectionTraceAttrs(config: RuntimeConfig): Pick<RuntimeConfigParseTraceAttrs, "provider_id" | "model_id" | "model_kind" | "base_url_present" | "base_url_host_class"> {
  if (config.runtime !== "builtin") return {};
  // `BuiltInRuntimeConfig.provider` is typed non-optional, but hydration can
  // legitimately arrive without one: member/non-admin agent projections and the
  // `agent:created` broadcast strip the private `runtimeConfig`, so a Built-in
  // row reaches this read path as `runtime:"builtin"` with no provider. The type
  // is a promise the wire does not keep, which is why `providerKind()` above
  // already reports `provider_kind: "none"` for exactly this shape.
  //
  // Building TRACE ATTRIBUTES must never be what breaks a render. Fail soft:
  // omit `provider_id` rather than invent one, and never infer a default
  // provider here — strict create/update parsing stays fail-closed elsewhere.
  const provider: BuiltInRuntimeProviderConfig | undefined = config.provider;
  return {
    ...(provider && provider.kind !== "connection" ? { provider_id: provider.providerId } : {}),
    model_kind: config.model.kind,
    ...(config.model.kind === "preset" ? { model_id: config.model.id } : {}),
    ...(provider?.kind === "gateway"
      ? {
          base_url_present: true,
          base_url_host_class: classifyBuiltInGatewayBaseUrlHost(provider.baseUrl),
        }
      : {}),
  };
}

export function hydrateLegacyRuntimeConfigWithTrace(
  input: RuntimeConfigHydrationInput,
  deps: RuntimeConfigLegacyHydrationDeps,
): { config: RuntimeConfig; trace: RuntimeConfigParseTraceAttrs } {
  // This is the read/restore adapter between historical agent columns
  // (`runtime`, `model`, `reasoningEffort`, `envVars`) and the current
  // RuntimeConfig object. It is deliberately tolerant so existing agents keep
  // rendering and launching; current writes must use parseRuntimeConfig, which
  // rejects malformed or cross-runtime shapes instead of sanitizing them.
  const stored = isPlainRecord(input.runtimeConfig) && input.runtimeConfig.version === deps.runtimeConfigVersion
    ? input.runtimeConfig
    : null;
  const sanitized = stored ? sanitizeStoredRuntimeConfig(stored, deps) : null;
  const storedConfig = sanitized?.value ?? null;
  const runtime = (typeof stored?.runtime === "string" && stored.runtime.trim())
    || (typeof input.runtime === "string" && input.runtime.trim())
    || "claude";
  const fallbackModel = (typeof input.model === "string" && input.model.trim()) || deps.getDefaultModel(runtime);
  const legacyEnvVars = normalizeEnvVars(input.envVars);
  const storedEnvVars = normalizeEnvVars(storedConfig?.envVars);
  const legacyClaudeApiUrl = runtime === "claude" ? legacyEnvVars?.ANTHROPIC_BASE_URL : undefined;
  const legacyClaudeApiKey = runtime === "claude" ? legacyEnvVars?.ANTHROPIC_API_KEY : undefined;
  const legacyClaudeCustomModel = runtime === "claude" ? legacyEnvVars?.ANTHROPIC_CUSTOM_MODEL_OPTION : undefined;
  const provider = stored
    ? parseProviderConfig(runtime, storedConfig?.provider, deps.builtinProviderEnvKeys, deps.builtinGatewayProviderEnvKeys, deps.piBuiltinProviderEnvKeys, legacyClaudeApiUrl, legacyClaudeApiKey)
    : runtime === "claude" && legacyClaudeApiUrl && legacyClaudeApiKey
      // Agents created before structured RuntimeConfig stored Claude provider
      // credentials in envVars. Keep that read path so those agents still
      // launch, but do not treat envVars as a provider config source for new
      // structured writes.
      ? { kind: "custom" as const, apiUrl: legacyClaudeApiUrl, apiKey: legacyClaudeApiKey }
      : runtime === "claude"
        ? { kind: "default" as const }
        : undefined;
  const usesLegacyClaudeCustomProvider = runtime === "claude" && provider?.kind === "custom";
  const command = stored ? parseCommandConfig(runtime, storedConfig?.command) : undefined;
  const config = deps.composeRuntimeConfig({
    runtime,
    provider,
    model: stored
      ? parseModelConfig(deps.runtimeModels, runtime, storedConfig?.model, fallbackModel, usesLegacyClaudeCustomProvider, legacyClaudeCustomModel)
      : modelConfigFromLegacy(deps.runtimeModels, runtime, fallbackModel),
    mode: stored ? parseModeConfig(storedConfig?.mode) : { kind: "default" },
    reasoningEffort: (storedConfig?.reasoningEffort as RuntimeReasoningEffort | null | undefined)
      ?? input.reasoningEffort
      ?? null,
    // Runtime-owned env vars are legacy launch mirrors for provider/model
    // settings. Strip them from user envVars during hydration so the canonical
    // RuntimeConfig provider/model arms remain the only source for generated
    // launch env.
    envVars: deps.stripControlledRuntimeEnvVars(runtime, stored ? storedEnvVars : legacyEnvVars),
    command,
  });
  return {
    config,
    trace: {
      outcome: sanitized && sanitized.droppedCount > 0 ? "legacy_sanitized" : "accepted",
      runtime: config.runtime,
      provider_kind: providerKind(config),
      ...builtInSelectionTraceAttrs(config),
      ...(sanitized && sanitized.droppedCount > 0 ? { unknown_fields_dropped_count: sanitized.droppedCount } : {}),
    },
  };
}
