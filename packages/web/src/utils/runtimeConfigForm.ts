import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  getDefaultModel,
  hydrateRuntimeConfig,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  parseRuntimeConfig,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_FAST_MODE_RUNTIMES,
  runtimeConfigModelValue,
  runtimeModelSupportsFastMode,
} from "@botiverse/raft-shared";
import type {
  BuiltInRuntimeAnyProviderId,
  BuiltInRuntimeGatewayProviderId,
  BuiltInRuntimeProviderId,
  ReasoningEffort,
  RuntimeConfig,
  RuntimeConfigHydrationInput,
  RuntimeModeConfig,
} from "@botiverse/raft-shared";

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
export const BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID: BuiltInProviderMode = BUILTIN_RUNTIME_PROVIDER_IDS[0] ?? "deepseek";

export function isBuiltInGatewayProviderMode(providerMode: string): providerMode is BuiltInRuntimeGatewayProviderId {
  return (BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS as readonly string[]).includes(providerMode);
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

/** Fast mode as it launches: a saved fast mode on a model that no longer runs fast launches at the standard speed. */
export function runtimeConfigFastMode(config: RuntimeConfig): boolean {
  return config.mode.kind === "fast" && runtimeModelSupportsFastMode(config.runtime, runtimeConfigModelValue(config));
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
  loadLocalPlugins?: boolean;
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
  const modelId = isBuiltInGateway || input.customModelMode
    ? customModelName || getDefaultModel(runtime)
    : input.model || getDefaultModel(runtime);
  const mode: RuntimeModeConfig = input.fastMode && runtimeModelSupportsFastMode(runtime, modelId)
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
          ...(input.loadLocalPlugins !== undefined ? { loadLocalPlugins: input.loadLocalPlugins } : {}),
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
      ? { kind: "custom", name: modelId }
      : { kind: "preset", id: modelId },
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

