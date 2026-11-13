import type { TurnEndCompactionDriverOutcome, TurnEndContextFacts } from "../turnEndCompaction";
import { ProviderApiKeyInvalidError, RuntimeModelNotFoundError } from "../spawnFailureErrors";
import { withProcessEnvPatch } from "../processEnvPatch";
import type { ProviderRequestObserver } from "../providerRequestFetch";
import { PiRequestLog } from "../agentContextView/piRequestLog";
import { PiProviderCallTracker } from "./piProviderCallTracker";
import { PI_ANTHROPIC_REQUEST_SOURCE, PiAnthropicRequestMeter } from "./piAnthropicRequests";
import { readGatewayModelLimits, type GatewayModelLimits, type GatewayModelLimitsResult } from "../gatewayModelLimits";
import "../bundledPiOAuth";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  DefaultPackageManager,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
  type AgentSessionServices,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  isContextOverflow,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildLaunchPlan,
  errorClassOf,
  RUNTIME_ERROR_CLASSES,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  getRuntimeProviderDisplayName,
  humanizeRuntimeProviderSegment,
  hydrateRuntimeConfig,
  BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS,
  isBuiltInRuntimeCustomModelPresetProviderId,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES,
  isBuiltInRuntimeGatewayProviderId,
  isBuiltInRuntimeProviderId,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  RUNTIME_MODELS,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  type ActiveSpan,
  type AgentConfig,
  type BuiltInRuntimeProviderId,
  type RuntimeModelConfig,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
  type RuntimeConfig,
  type ProviderRequestActivity,
  type ProviderConnectionLaunchProjection,
  PI_RESPONSE_NOTICE_TEXT,
  currentDate,
  currentTimeMs,
  type AxSurfaceText,
  type ModelLimits,
  type ModelLimitValue,
} from "@botiverse/raft-shared";
import {
  normalizeRuntimeCompactionReason,
  type RuntimeCompactionReason,
} from "../runtimeCompactionProjection";
import { buildRuntimeErrorActivityDiagnostic } from "../runtimeErrorDiagnostics";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { formatBuiltInDefaultModelLimitsNote, withSystemPromptSection } from "./piModelLimitsNote";
import { buildPiTokenUsageEvent } from "./piEventNormalizer";
import { createManagedMcpPiTools } from "./managedMcpTools";
import { createPiCommandTool } from "./piCommandTool";
import { SendIntentArgumentScanner } from "./sendIntentScanner";
import { trackPiSessionMemory } from "./piSessionMemory";
import { buildPiSessionSeed, type PiSessionRotationStats, type PiSessionSeed } from "./piSessionSeed";
import {
  countPiUserExtensions,
  newestPiSessionFile,
  PI_DAEMON_EXTENSION_NAME,
  piSessionSeedRefusalTraceAttrs,
  resolvePiSessionRotationConfig,
  undoPiSessionRotationFiles,
  writePiSessionRotationFiles,
  type PiSessionRotationConfig,
  type PiSessionRotationSkipReason,
} from "./piSessionRotation";
import {
  createPiCompactionFitExtension,
  piCompactionFitTelemetryAttrs,
  takePiCompactionFit,
  type PiCompactionFit,
} from "./piCompactionFit";
import { RuntimeTurnOriginHolder, type RuntimeTurnOrigin } from "../runtimeTurnOrigin";
import {
  createProviderHttpClient,
  type ProviderHttpClient,
} from "../daemonFetch";
import {
  createPiToolExecutionObserver,
  type PiToolExecutionObserver,
} from "./piToolExecutionObservability";
import {
  type RuntimeLifecycleDiagnosticEvent,
  type RuntimeTerminalCausePhase,
  writeRuntimeLifecycleDiagnosticRecord,
  writeRuntimeTerminalCauseRecord,
} from "./index";
import type {
  ParsedEvent,
  RuntimeToolDiagnosticInput,
  RuntimeToolDiagnosticSnapshot,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeModelDetectionContext,
  RuntimeProbeResult,
  RuntimeProviderCallSnapshot,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  RuntimeSessionRotationHold,
  SpawnContext,
  SpawnResult,
} from "./types";

const PI_SESSION_DIR = ".pi-sessions";
const BUILTIN_SESSION_DIR = ".builtin-sessions";
const BUILTIN_AGENT_DIR = ".builtin-runtime";
export const PI_SDK_COMPACTION_ENABLED = true;
// Pi also activates some providers through ambient non-API-key credentials.
// Public Pi metadata exposes API-key env names via `findEnvKeys(provider)`;
// these remaining names are host credential sources, not per-provider API-key
// metadata, and must stay scrubbed for Built-in isolation.
const BUILTIN_BLOCKED_HOST_AMBIENT_CREDENTIAL_ENV_KEYS = [
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "CLOUDFLARE_ACCOUNT_ID",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
] as const;
const BUILTIN_BLOCKED_HOST_PROVIDER_ENV_KEYS = Array.from(new Set([
  ...BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  ...BUILTIN_BLOCKED_HOST_AMBIENT_CREDENTIAL_ENV_KEYS,
])) as readonly string[];

type PiModelRegistryLike = Pick<ModelRegistry, "getAvailable">;
/**
 * A pi SDK session the daemon opened, and how to open its session file again
 * on the same spawn resources (services, model, tools including managed MCP
 * tools, provider HTTP client, CLI transport): a rotation's resume, which
 * must neither redo the spawn's side effects nor change the request.
 */
export class PiSdkSessionHandle {
  constructor(
    readonly session: AgentSession,
    /**
     * Opens the newest file of the id, then disposes `session`. If the open
     * fails, `session` is left as it was, still usable.
     */
    readonly reopen: () => Promise<PiSdkSessionHandle>,
    /** task #1357 item 1: the limits registered for the session's model (`configureBuiltInGatewayCustomModel`); null when none were. */
    readonly modelLimits: ModelLimits | null = null,
  ) {}
}

/** A bare AgentSession (test doubles) cannot be reopened, so it is never rotated. */
type PiSessionFactory = (
  ctx: SpawnContext,
  sessionId: string,
  toolExecutionObserver?: PiToolExecutionObserver,
  providerObserver?: ProviderRequestObserver,
  providerCallTracker?: PiProviderCallTracker,
  anthropicRequests?: PiAnthropicRequestMeter,
) => Promise<AgentSession | PiSdkSessionHandle>;
type PiAssistantMessageEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

type RuntimeSessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

type RuntimeSessionEventName = keyof RuntimeSessionEvents;

interface PiResponseObservation {
  text: boolean;
  whitespace: boolean;
  thinkingOrTool: boolean;
  indeterminate: boolean;
}

export interface PiSdkEventMappingState {
  sessionId: string | null;
  sessionAnnounced: boolean;
  responseSessionId: string | null;
  responseObservation: PiResponseObservation | null;
  /** SDK final message object identity, not timestamps (two responses can share a millisecond). */
  endedResponses: WeakSet<object>;
  responseCancelled: boolean;
  pendingTurnEnd: boolean;
  pendingProviderError: string | null;
  providerErrorOwnedByCompaction: boolean;
  compactionTerminal: boolean;
  /** Counts this session's compactions; pi runs one at a time, so a start's id is its end's. */
  compactionCycle: number;
  /** The id of the compaction started and not yet ended; an end without one carries no id. */
  openCompactionCycle: number | null;
  thinkingBuffers: Map<number, string>;
  announcedThinkingIndexes: Set<number>;
  textBuffers: Map<number, string>;
  announcedTextIndexes: Set<number>;
  /** Agent typing line: `raft message send` targets in streaming bash arguments (created on first use). */
  sendIntentScanner?: SendIntentArgumentScanner;
}

export function createPiSdkEventMappingState(sessionId: string | null = null): PiSdkEventMappingState {
  return {
    sessionId,
    sessionAnnounced: false,
    responseSessionId: sessionId,
    responseObservation: null,
    endedResponses: new WeakSet(),
    responseCancelled: false,
    pendingTurnEnd: false,
    pendingProviderError: null,
    providerErrorOwnedByCompaction: false,
    compactionTerminal: false,
    compactionCycle: 0,
    openCompactionCycle: null,
    thinkingBuffers: new Map(),
    announcedThinkingIndexes: new Set(),
    textBuffers: new Map(),
    announcedTextIndexes: new Set(),
  };
}

type PiCompactionOutcome =
  | "compaction_succeeded"
  | "compaction_failed_or_exhausted"
  | "aborted";
type PiCompactionFailureReason = "recovery_exhausted" | "input_too_large" | "compaction_failed";
type PiCompactionProjection = {
  outcome: PiCompactionOutcome;
  reason: RuntimeCompactionReason;
  failureReason?: PiCompactionFailureReason;
  willRetry: boolean;
};

export interface PiCompactionInputEvidence {
  messageCount: number;
  inputTextLength: number;
  configuredContextLimit: number | null;
  /** What Raft trimmed so the summary request fit (piCompactionFit.ts); absent when nothing was trimmed. */
  fit?: PiCompactionFit;
}

function projectPiCompactionEnd(
  event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
): PiCompactionProjection {
  const reason = normalizeRuntimeCompactionReason(event.reason);
  if (event.aborted) {
    return { outcome: "aborted", reason, willRetry: event.willRetry === true };
  }
  if (event.result !== undefined) {
    return { outcome: "compaction_succeeded", reason, willRetry: event.willRetry === true };
  }
  const failureReason = reason === "overflow"
    && typeof event.errorMessage === "string"
    && /after one compact-and-retry attempt/iu.test(event.errorMessage)
    ? "recovery_exhausted"
    : isContextOverflow({
        role: "assistant",
        stopReason: "error",
        errorMessage: event.errorMessage ?? "",
      } as Parameters<typeof isContextOverflow>[0])
      ? "input_too_large"
      : "compaction_failed";
  return {
    outcome: "compaction_failed_or_exhausted",
    reason,
    failureReason,
    willRetry: event.willRetry === true,
  };
}

const PI_TELEMETRY_MESSAGE_COUNT_CAP = 1_024;
const PI_TELEMETRY_CONTEXT_LIMIT_CAP = 10_000_000;
const PI_TELEMETRY_INPUT_LENGTH_CAP = 1_048_577;

function bucketPiInputLength(value: number): string {
  if (value <= 0) return "0";
  if (value <= 1_024) return "1_1024";
  if (value <= 4_096) return "1025_4096";
  if (value <= 16_384) return "4097_16384";
  if (value <= 65_536) return "16385_65536";
  if (value <= 262_144) return "65537_262144";
  if (value <= 1_048_576) return "262145_1048576";
  return "over_1048576";
}

export function projectPiCompactionInputTelemetry(
  evidence: PiCompactionInputEvidence | undefined,
  reason: RuntimeCompactionReason,
): Record<string, string | number | boolean> {
  if (!evidence) {
    return {
      message_count_present: false,
      input_length_bucket: "unknown",
      configured_context_limit_present: false,
      input_range_classification: "unknown",
    };
  }

  const rawMessageCount = Number.isFinite(evidence.messageCount)
    ? Math.max(0, Math.floor(evidence.messageCount))
    : 0;
  const inputTextLength = Number.isFinite(evidence.inputTextLength)
    ? Math.max(0, Math.floor(evidence.inputTextLength))
    : 0;
  const configuredContextLimit = Number.isFinite(evidence.configuredContextLimit)
    && Number(evidence.configuredContextLimit) >= 1
    && Number(evidence.configuredContextLimit) <= PI_TELEMETRY_CONTEXT_LIMIT_CAP
    ? Math.floor(Number(evidence.configuredContextLimit))
    : null;

  return {
    message_count_capped: Math.min(rawMessageCount, PI_TELEMETRY_MESSAGE_COUNT_CAP),
    message_count_was_capped: rawMessageCount > PI_TELEMETRY_MESSAGE_COUNT_CAP,
    input_length_bucket: bucketPiInputLength(inputTextLength),
    ...(configuredContextLimit === null
      ? { configured_context_limit_present: false }
      : { configured_context_limit: configuredContextLimit }),
    input_range_classification: inputTextLength === 0
      ? "lower_bound_empty"
      : reason === "overflow"
        ? "upper_bound_overflow"
        : "nonempty",
    ...piCompactionFitTelemetryAttrs(evidence.fit),
  };
}

function piCompactionInputEvidence(session: AgentSession): PiCompactionInputEvidence {
  let inputTextLength = boundedTextLength(session.systemPrompt, PI_TELEMETRY_INPUT_LENGTH_CAP);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const message of messages) {
    if (inputTextLength >= PI_TELEMETRY_INPUT_LENGTH_CAP) break;
    inputTextLength += boundedTextLength(
      message,
      PI_TELEMETRY_INPUT_LENGTH_CAP - inputTextLength,
    );
  }
  const fit = takePiCompactionFit(session.sessionManager);
  return {
    messageCount: messages.length + (session.systemPrompt ? 1 : 0),
    inputTextLength,
    configuredContextLimit: session.model?.contextWindow ?? null,
    ...(fit ? { fit } : {}),
  };
}

function boundedTextLength(value: unknown, remaining: number, seen = new Set<object>()): number {
  if (remaining <= 0) return 0;
  if (typeof value === "string") return Math.min(value.length, remaining);
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of values) {
    total += boundedTextLength(child, remaining - total, seen);
    if (total >= remaining) break;
  }
  return total;
}

export function buildPiSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, PI_SESSION_DIR);
}

export function buildBuiltInSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, BUILTIN_SESSION_DIR);
}

export function buildBuiltInAgentDir(workingDirectory: string): string {
  return path.join(workingDirectory, BUILTIN_AGENT_DIR);
}

/** `target` as the agent names it from its workspace: relative inside it, absolute outside. */
function workspaceRelativePath(workingDirectory: string, target: string): string {
  const relative = path.relative(workingDirectory, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : target;
}

export function buildPiLegacyRpcArgs(ctx: SpawnContext, sessionId: string | null): string[] {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const args = [
    "--mode", "rpc",
    "--session-dir", buildPiSessionDir(ctx.workingDirectory),
    "--system-prompt", ctx.standingPrompt,
  ];

  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (launchRuntimeFields.reasoningEffort) {
    args.push("--thinking", launchRuntimeFields.reasoningEffort);
  }

  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  return args;
}

export async function buildPiSpawnEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

/**
 * A provider key goes into an HTTP header (`Authorization: Bearer <key>` or an
 * api-key header). A key with a pasted note or placeholder in it (e.g. Chinese
 * text) otherwise surfaces as Node's opaque "Cannot convert argument to a
 * ByteString because the character at index 7…" on every request. Refuse it up
 * front with a message that names the key.
 *
 * Only what every header form refuses is rejected: fetch trims leading and
 * trailing HTTP whitespace (tab, LF, CR, space) from a header value, so the
 * check runs on the trimmed key and then refuses what remains that no header
 * value can carry (a character above U+00FF, CR, LF, NUL). A key that worked in
 * some header form before is never newly refused.
 */
const HTTP_WHITESPACE_EDGES = /^[\t\n\r ]+|[\t\n\r ]+$/g;

export function assertProviderApiKeyIsHeaderSafe(apiKey: string, keyName: string): void {
  const leading = apiKey.length - apiKey.replace(/^[\t\n\r ]+/, "").length;
  const trimmed = apiKey.replace(HTTP_WHITESPACE_EDGES, "");
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code > 0xff || code === 0x0a || code === 0x0d || code === 0x00) {
      // task #1307: typed, so the start failure is classified as a key problem
      // instead of the generic runtime_spawn_failed.
      throw new ProviderApiKeyInvalidError({ keyName, position: leading + index + 1, charCode: code });
    }
  }
}

async function setHeaderSafeRuntimeApiKey(
  modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey">,
  providerId: string,
  apiKey: string,
  keyName: string,
): Promise<void> {
  assertProviderApiKeyIsHeaderSafe(apiKey, keyName);
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
}

export async function seedPiSessionModelRuntime(
  modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey">,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
  launchEnvVars: Record<string, string> | null = null,
): Promise<void> {
  // ModelRuntime.create() is intentionally offline here, and credential seeding must not
  // reach the network. Under pi 0.84.3 that guarantee moved INTO the library: credential
  // synchronization itself calls models.refresh({ allowNetwork: false, ... }) and only
  // reconciles cached/built-in catalog, composition and availability locally. Remote
  // freshness is the caller's separate concern, and we deliberately do not request it here.
  // Passing an options object is no longer possible — AuthOperationOptions is { signal? }.
  if (runtimeConfig.runtime === "pi" && runtimeConfig.provider?.kind === "pi-builtin") {
    await setHeaderSafeRuntimeApiKey(
      modelRuntime,
      runtimeConfig.provider.providerId,
      runtimeConfig.provider.apiKey,
      `The ${runtimeConfig.provider.providerId} API key`,
    );
    return;
  }
  if (runtimeConfig.runtime !== "builtin") return;
  if (runtimeConfig.provider.kind === "connection") {
    if (!providerConnection) throw new Error("Provider connection launch metadata is missing");
    const apiKeyEnv = isBuiltInRuntimeProviderId(providerConnection.providerId)
      ? BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerConnection.providerId]
      : BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerConnection.providerId];
    const apiKey = launchEnvVars?.[apiKeyEnv];
    if (!apiKey) throw new Error("Provider connection launch credential is missing");
    const runtimeProviderId = providerConnection.providerId === "openai-compatible"
      ? "openai"
      : providerConnection.providerId === "anthropic-compatible"
        ? "anthropic"
        : providerConnection.providerId;
    await setHeaderSafeRuntimeApiKey(modelRuntime, runtimeProviderId, apiKey, apiKeyEnv);
    return;
  }
  if (runtimeConfig.provider.kind === "preset") {
    await setHeaderSafeRuntimeApiKey(
      modelRuntime,
      runtimeConfig.provider.providerId,
      runtimeConfig.provider.apiKey,
      `The ${runtimeConfig.provider.providerId} API key`,
    );
    return;
  }
  if (runtimeConfig.provider.providerId === "openai-compatible") {
    await setHeaderSafeRuntimeApiKey(modelRuntime, "openai", runtimeConfig.provider.apiKey, "The OpenAI-compatible API key");
  } else if (runtimeConfig.provider.providerId === "anthropic-compatible") {
    await setHeaderSafeRuntimeApiKey(modelRuntime, "anthropic", runtimeConfig.provider.apiKey, "The Anthropic-compatible API key");
  }
}

export function buildPiSessionCreateEnvPatch(
  runtimeConfig: RuntimeConfig,
  envVars: Record<string, string> | null,
): Record<string, string> | null {
  if (!envVars) return null;
  const providerApiKeyEnvNames = runtimeConfig.runtime === "builtin"
    ? new Set([
        ...Object.values(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS),
        ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
      ])
    : runtimeConfig.runtime === "pi" && runtimeConfig.provider?.kind === "pi-builtin"
      ? new Set([PI_BUILTIN_PROVIDER_ENV_KEYS[runtimeConfig.provider.providerId]])
      : new Set<string>();
  if (providerApiKeyEnvNames.size === 0) return envVars;
  const filtered = Object.fromEntries(
    Object.entries(envVars).filter(([key]) => !providerApiKeyEnvNames.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

export { withProcessEnvPatch } from "../processEnvPatch";

/** The model-registry provider a built-in gateway custom model is registered
 * under. Registration and selection must use this one mapping. */
function builtInGatewayRegistryProvider(
  providerId: "openai-compatible" | "anthropic-compatible",
): { id: "openai"; api: "openai-completions"; apiKeyEnv: "OPENAI_API_KEY" }
  | { id: "anthropic"; api: "anthropic-messages"; apiKeyEnv: "ANTHROPIC_API_KEY" } {
  return providerId === "openai-compatible"
    ? { id: "openai", api: "openai-completions", apiKeyEnv: "OPENAI_API_KEY" }
    : { id: "anthropic", api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" };
}

export function resolvePiModelFromRegistry(
  modelId: string | null | undefined,
  modelRegistry: ModelRegistry,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
) {
  if (!modelId || modelId === "default") return undefined;
  // A built-in custom model reached through a gateway — configured directly or
  // through a managed provider connection — is registered under exactly one
  // provider (configureBuiltInGatewayCustomModel). Select only that entry: the
  // bare name can also exist in the SDK catalog under another provider (e.g.
  // github-copilot/kimi-k3), and a custom name may itself contain "/". A missing
  // entry must stay missing so the launch fails as RuntimeModelNotFoundError
  // instead of silently running a different provider's model.
  const gateway = resolveBuiltInGatewayLaunch(runtimeConfig, providerConnection);
  if (gateway && runtimeConfig.runtime === "builtin" && runtimeConfig.model.kind === "custom") {
    return modelRegistry.find(builtInGatewayRegistryProvider(gateway.providerId).id, runtimeConfig.model.name);
  }
  // A typed model on a preset provider that accepts one (task #10): the name is
  // the provider's own id (it may contain "/"), registered under exactly that
  // provider by configureBuiltInPresetCustomModel. Same rule as above: no
  // fallback, so an unregistered name fails as RuntimeModelNotFoundError.
  const presetCustom = resolveBuiltInPresetCustomModel(runtimeConfig);
  if (presetCustom) return modelRegistry.find(presetCustom.providerId, presetCustom.modelId);
  const [provider, ...modelParts] = modelId.split("/");
  if (provider && modelParts.length > 0) {
    return modelRegistry.find(provider, modelParts.join("/"));
  }

  return modelRegistry.getAll().find((model) => model.id === modelId);
}

function normalizeGatewayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function findMatchingOpenAICompatibleModel(
  modelRegistry: ModelRegistry,
  baseUrl: string,
  modelId: string,
): Model<"openai-completions"> | undefined {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  return modelRegistry.getAll().find(
    (model): model is Model<"openai-completions"> =>
      model.api === "openai-completions"
      && model.id === modelId
      && normalizeGatewayBaseUrl(model.baseUrl) === normalizedBaseUrl,
  );
}

/**
 * The SDK catalog entry for an Anthropic-compatible gateway, when the exact
 * endpoint and model id are a pair the SDK knows (for example MiniMax's own
 * hosts). Same rule as the OpenAI-compatible lookup: endpoint AND id, never
 * the id alone, so an unknown endpoint inherits nothing.
 */
function findMatchingAnthropicCompatibleModel(
  modelRegistry: ModelRegistry,
  baseUrl: string,
  modelId: string,
): Model<"anthropic-messages"> | undefined {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  return modelRegistry.getAll().find(
    (model): model is Model<"anthropic-messages"> =>
      model.api === "anthropic-messages"
      && model.id === modelId
      && normalizeGatewayBaseUrl(model.baseUrl) === normalizedBaseUrl,
  );
}

/**
 * Thinking contract of an Anthropic-compatible gateway model that the SDK
 * catalog does not describe yet, keyed by the exact endpoint (origin + base
 * path, compared case-insensitively on the host) and the full model id.
 *
 * Each entry states the upstream contract it encodes and where that contract
 * is documented. Nothing here applies to other endpoints or other ids, and a
 * later SDK catalog entry for the same pair (findMatchingAnthropicCompatibleModel)
 * takes precedence over this table.
 */
export interface AnthropicGatewayThinkingContract {
  /** `thinking.type: "adaptive"` + `output_config.effort`; the upstream rejects `disabled` and budget thinking. */
  forceAdaptiveThinking: true;
  /** `off: null` marks "no thinking" as unsupported (never send `disabled`); the rest map 1:1 to `output_config.effort`. */
  thinkingLevelMap: Model<"anthropic-messages">["thinkingLevelMap"];
  /**
   * The level Raft selects when the agent's reasoning effort is unset. The
   * SDK would otherwise clamp an unset level to the first supported one
   * (`minimal`), which is nobody's choice; this is the upstream's own default
   * for an omitted effort, so an agent that chose nothing gets what the API
   * gives a request that chose nothing.
   */
  defaultThinkingLevel: ThinkingLevel;
  /** Where the upstream contract is written down. */
  source: string;
}

const MINIMAX_M31_FLASH_PREVIEW_CONTRACT: AnthropicGatewayThinkingContract = {
  forceAdaptiveThinking: true,
  thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  // "MiniMax-M3.1-Flash-Preview always thinks and returns 400 if `disabled` is
  // sent"; "omitting `effort` defaults to `max`"; effort accepts
  // low|medium|high|xhigh|max — platform.minimax.io/docs/api-reference/text-anthropic-api
  // (Built-in Pi × MiniMax M3.1 report, 2026-10-13).
  defaultThinkingLevel: "max",
  source: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
};

/**
 * Exact (endpoint, model id) pairs with a known thinking contract. Hosts are
 * listed only with upstream documentation for that host and model; the user
 * report's own host is the first entry.
 */
const ANTHROPIC_GATEWAY_THINKING_CONTRACTS: ReadonlyArray<{ endpoint: string; modelId: string; contract: AnthropicGatewayThinkingContract }> = [
  // China site: platform.minimax.cn/docs/api-reference/text-anthropic-api lists this base URL and the model with the same rule.
  { endpoint: "https://api.minimax.cn/anthropic", modelId: "MiniMax-M3.1-Flash-Preview", contract: MINIMAX_M31_FLASH_PREVIEW_CONTRACT },
  // International site: platform.minimax.io/docs/api-reference/text-anthropic-api.
  { endpoint: "https://api.minimax.io/anthropic", modelId: "MiniMax-M3.1-Flash-Preview", contract: MINIMAX_M31_FLASH_PREVIEW_CONTRACT },
];

function normalizeGatewayEndpointForContract(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Test seam: the contract table to consult (defaults to the built-in one). */
export interface AnthropicGatewayContractDeps {
  thinkingContracts?: ReadonlyArray<{ endpoint: string; modelId: string; contract: AnthropicGatewayThinkingContract }>;
}

/** The thinking contract for this exact endpoint and model id, if one is on record. */
export function findAnthropicGatewayThinkingContract(
  baseUrl: string,
  modelId: string,
  deps: AnthropicGatewayContractDeps = {},
): AnthropicGatewayThinkingContract | undefined {
  const endpoint = normalizeGatewayEndpointForContract(baseUrl);
  if (!endpoint) return undefined;
  const table = deps.thinkingContracts ?? ANTHROPIC_GATEWAY_THINKING_CONTRACTS;
  return table.find((entry) => normalizeGatewayEndpointForContract(entry.endpoint) === endpoint && entry.modelId === modelId)?.contract;
}

/**
 * The thinking level a built-in session starts with. An explicit reasoning
 * effort is passed through (the SDK clamps it to the model's declared levels,
 * which is why a contract declares xhigh/max). Unset effort on a model whose
 * contract forbids "off" takes the contract's documented default instead of
 * the SDK's clamp of "unset" to the first supported level. Every other model
 * gets exactly what it got before: the unset value itself (`null` from the
 * launch fields), which the SDK clamps to its first supported level, "off" —
 * i.e. `thinking: disabled` — for a model that allows it. Verified by the
 * real-chain control test; a `null` → `undefined` change here would switch
 * every built-in agent without a chosen effort to the SDK's "medium" default.
 */
export function resolveBuiltInThinkingLevel(
  reasoningEffort: string | null | undefined,
  contract: AnthropicGatewayThinkingContract | null | undefined,
): ModelThinkingLevel | undefined {
  if (reasoningEffort) return reasoningEffort as ModelThinkingLevel;
  if (contract) return contract.defaultThinkingLevel;
  return reasoningEffort as ModelThinkingLevel | undefined;
}

export function resolveBuiltInGatewayModelInput(
  registryInput: Model<"openai-completions">["input"] | undefined,
  supportsImageInput: boolean | undefined,
): Model<"openai-completions">["input"] {
  const input = registryInput ?? ["text"];
  return supportsImageInput === true
    ? [...new Set([...input, "text" as const, "image" as const])]
    : input;
}

export function resolveBuiltInGatewayLaunch(
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
): {
  providerId: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  supportsImageInput?: boolean;
} | null {
  if (runtimeConfig.runtime !== "builtin") return null;
  if (runtimeConfig.model.kind !== "custom") return null;
  if (runtimeConfig.provider.kind === "gateway") return runtimeConfig.provider;
  if (
    runtimeConfig.provider.kind === "connection"
    && providerConnection
    && isBuiltInRuntimeGatewayProviderId(providerConnection.providerId)
    && providerConnection.endpointUrl
  ) {
    return {
      providerId: providerConnection.providerId,
      baseUrl: providerConnection.endpointUrl,
      supportsImageInput: providerConnection.supportsImageInput,
    };
  }
  return null;
}

/** What the gateway registration decided for the model's thinking contract. */
export interface BuiltInGatewayRegistration {
  /** The on-record contract applied to this (endpoint, id) pair; null when the SDK catalog knew the pair or nothing was on record. */
  thinkingContract: AnthropicGatewayThinkingContract | null;
  /**
   * task #1357 item 1: exactly the contextWindow and maxTokens registered for
   * the model, each with its own source. Null when no gateway custom model
   * was registered (other runtimes, providers or model kinds).
   */
  modelLimits: ModelLimits | null;
}

/**
 * The agent's declared limit (#proj-runtime:#50), else the value the gateway's
 * own model list reported (#proj-runtime:#53), else the value a matching
 * catalog entry had, else Raft's default; the source says which. What the
 * registry then applies on top is effectiveModelLimits.
 */
function registeredModelLimit(
  configured: number | undefined,
  gatewayValue: number | undefined,
  catalogValue: number | undefined,
  raftDefault: number,
): ModelLimitValue {
  if (typeof configured === "number") return { value: configured, source: "agent_config" };
  if (typeof gatewayValue === "number") return { value: gatewayValue, source: "gateway" };
  return typeof catalogValue === "number"
    ? { value: catalogValue, source: "catalog" }
    : { value: raftDefault, source: "raft_default" };
}

/**
 * The `modelOverrides` entry for a model in the models.json snapshot the
 * registry composes with, or undefined. pi-coding-agent keeps that snapshot
 * in `ModelRuntime#config` (a `ModelConfig`; neither is exported), read when
 * the session's services are built. Reading it, not comparing values, is
 * what tells an override that happens to equal Raft's default from no
 * override. Returns undefined when the registry has no such snapshot (a test
 * double, or an SDK that moved it: pi.modelLimits.test.ts then fails).
 */
function loadedModelOverride(
  modelRegistry: object,
  providerId: string,
  modelId: string,
): { contextWindow?: unknown; maxTokens?: unknown } | undefined {
  const config = (modelRegistry as { runtime?: { config?: { getProvider?: unknown } } }).runtime?.config;
  if (!config || typeof config.getProvider !== "function") return undefined;
  const provider = (config.getProvider as (id: string) => { modelOverrides?: Record<string, unknown> } | undefined).call(config, providerId);
  const overrides = provider?.modelOverrides;
  if (!overrides || !Object.hasOwn(overrides, modelId)) return undefined;
  const entry = overrides[modelId];
  return entry && typeof entry === "object" ? entry as { contextWindow?: unknown; maxTokens?: unknown } : undefined;
}

/**
 * The limits a model Raft just registered runs with. Pi applies the agent
 * dir's models.json `modelOverrides` over a registered provider's models, as
 * its topmost layer (pi-coding-agent `composeModelProvider`), so a field the
 * loaded file overrides runs with the file's value whatever Raft registered,
 * the agent's own setting included. Such a field is reported with the value
 * the registry holds, as `catalog` (the Pi model registry had it); every
 * other field keeps what was registered.
 */
function effectiveModelLimits(
  registered: ModelLimits,
  override: { contextWindow?: unknown; maxTokens?: unknown } | undefined,
  effective: { contextWindow: number; maxTokens: number } | undefined,
): ModelLimits {
  if (!override || !effective) return registered;
  return {
    contextWindow: typeof override.contextWindow === "number"
      ? { value: effective.contextWindow, source: "catalog" }
      : registered.contextWindow,
    maxTokens: typeof override.maxTokens === "number"
      ? { value: effective.maxTokens, source: "catalog" }
      : registered.maxTokens,
  };
}

/**
 * The key a Built-in gateway custom model sends, from where the session's own
 * seeding takes it (`seedPiSessionModelRuntime`); null when there is none.
 */
function builtInGatewayApiKey(
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null,
  launchEnvVars: Record<string, string> | null,
): string | null {
  if (runtimeConfig.runtime !== "builtin") return null;
  if (runtimeConfig.provider.kind === "gateway") return runtimeConfig.provider.apiKey || null;
  if (
    runtimeConfig.provider.kind === "connection"
    && providerConnection
    && isBuiltInRuntimeGatewayProviderId(providerConnection.providerId)
  ) {
    return launchEnvVars?.[BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerConnection.providerId]] || null;
  }
  return null;
}

/**
 * #proj-runtime:#53: read the gateway's model list for a Built-in gateway
 * custom model whose agent config lacks a limit. The contract is the public
 * docs page developers/gateway-model-limits. Never throws and never blocks a
 * start: every failure is an outcome, and registration falls through.
 */
export async function readBuiltInGatewayModelLimits(
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null,
  launchEnvVars: Record<string, string> | null,
  fetchImpl: typeof globalThis.fetch,
): Promise<GatewayModelLimitsResult> {
  const gateway = resolveBuiltInGatewayLaunch(runtimeConfig, providerConnection);
  if (!gateway || runtimeConfig.runtime !== "builtin" || runtimeConfig.model.kind !== "custom") {
    return { limits: null, outcome: "skipped", cached: false };
  }
  if (typeof runtimeConfig.model.contextWindow === "number" && typeof runtimeConfig.model.maxOutputTokens === "number") {
    return { limits: null, outcome: "skipped", cached: false };
  }
  const apiKey = builtInGatewayApiKey(runtimeConfig, providerConnection, launchEnvVars);
  if (!apiKey) return { limits: null, outcome: "skipped", cached: false };
  return readGatewayModelLimits({
    kind: gateway.providerId,
    baseUrl: gateway.baseUrl,
    apiKey,
    modelId: runtimeConfig.model.name,
    fetch: fetchImpl,
    // A stock CLIProxyAPI lists limits only in its `client_version=pi` catalog.
    clientVersionCatalog: true,
  });
}

/**
 * Preset providers whose own model list follows the gateway contract
 * (docs.raft.build/developers/gateway-model-limits): OpenRouter's
 * `<base>/models` lists `context_length` and `top_provider.max_completion_tokens`.
 */
const PRESET_MODEL_LIST_PROVIDER_IDS: ReadonlySet<string> = new Set(["openrouter"]);

/**
 * The base URL a preset provider's model list is read from: the provider's
 * catalog transport (the one its connection probe calls); null when the
 * provider has no model list Raft reads.
 */
export function builtInPresetModelListBaseUrl(providerId: string): string | null {
  if (!PRESET_MODEL_LIST_PROVIDER_IDS.has(providerId)) return null;
  const transport = (PI_BUILTIN_PROVIDER_CONNECTION_PROBES as Record<string, { api: string; baseUrl: string } | undefined>)[providerId];
  return transport?.api === "openai-completions" && transport.baseUrl ? transport.baseUrl : null;
}

/**
 * #proj-runtime:#53 follow-up to task #10: read OpenRouter's model list for a
 * typed OpenRouter model whose agent config lacks a limit, with the agent's
 * own OpenRouter key and the gateway reader's rules (5 s, 2 MB, no
 * redirects, an hour's cache per URL and key). The model is looked up by the
 * API id the config stores (normalizeBuiltInPresetCustomModel). Never throws
 * and never blocks a start.
 */
export async function readBuiltInPresetCustomModelLimits(
  runtimeConfig: RuntimeConfig,
  fetchImpl: typeof globalThis.fetch,
): Promise<GatewayModelLimitsResult & { baseUrl: string | null }> {
  const skipped = { limits: null, outcome: "skipped" as const, cached: false, baseUrl: null };
  const presetCustom = resolveBuiltInPresetCustomModel(runtimeConfig);
  if (!presetCustom || runtimeConfig.runtime !== "builtin" || runtimeConfig.provider.kind !== "preset") return skipped;
  const { model } = presetCustom;
  if (typeof model.contextWindow === "number" && typeof model.maxOutputTokens === "number") return skipped;
  const baseUrl = builtInPresetModelListBaseUrl(presetCustom.providerId);
  const apiKey = runtimeConfig.provider.apiKey;
  if (!baseUrl || !apiKey) return skipped;
  const result = await readGatewayModelLimits({
    kind: "openai-compatible",
    baseUrl,
    apiKey,
    modelId: presetCustom.modelId,
    fetch: fetchImpl,
  });
  return { ...result, baseUrl };
}

/**
 * task #10: a Built-in agent on a preset provider that accepts a typed model id
 * (BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS, i.e. OpenRouter) whose model
 * is that typed id; null for every other config. Saved connections are not
 * covered: their model stays list-only.
 */
export function resolveBuiltInPresetCustomModel(
  runtimeConfig: RuntimeConfig,
): { providerId: BuiltInRuntimeProviderId; modelId: string; model: Extract<RuntimeModelConfig, { kind: "custom" }> } | null {
  if (runtimeConfig.runtime !== "builtin" || runtimeConfig.model.kind !== "custom") return null;
  if (runtimeConfig.provider.kind !== "preset") return null;
  if (!isBuiltInRuntimeCustomModelPresetProviderId(runtimeConfig.provider.providerId)) return null;
  return { providerId: runtimeConfig.provider.providerId, modelId: runtimeConfig.model.name, model: runtimeConfig.model };
}

/**
 * task #10: register a typed model id under its preset provider so the launch
 * can resolve it. Transport settings (api, base URL, headers, compat) come
 * from the catalog entry with that exact id when there is one, else from any
 * catalog model of the same provider. Limits follow the gateway order: the
 * agent's declared value, else `reportedLimits` (the provider's own model
 * list, readBuiltInPresetCustomModelLimits), else the exact catalog entry, else Raft's
 * default; a `modelOverrides` value in the agent dir's models.json wins over
 * all of them (effectiveModelLimits). Null limits when nothing was registered.
 */
export function configureBuiltInPresetCustomModel(
  modelRegistry: Pick<ModelRegistry, "getAll" | "find" | "registerProvider">,
  runtimeConfig: RuntimeConfig,
  // From readBuiltInPresetCustomModelLimits; used only when the list was read
  // from the host this registration's model calls go to.
  reportedLimits: GatewayModelLimits | null = null,
  reportedFromBaseUrl: string | null = null,
): { modelLimits: ModelLimits | null } {
  const presetCustom = resolveBuiltInPresetCustomModel(runtimeConfig);
  if (!presetCustom) return { modelLimits: null };
  const { providerId, modelId, model } = presetCustom;
  const exact = modelRegistry.find(providerId, modelId);
  const template = exact ?? modelRegistry.getAll().find((model) => model.provider === providerId);
  // No catalog model of this provider at all: nothing to copy the transport
  // from. Leave the registry alone so the launch fails as model-not-found.
  if (!template) return { modelLimits: null };
  // OpenRouter serves one model list for every transport it offers (Pi's
  // catalog has both `<host>/api` and `<host>/api/v1`), so the list counts
  // when it came from the host this registration's model calls go to.
  const sameOrigin = (a: string, b: string) => {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  };
  const reported = reportedLimits && reportedFromBaseUrl && sameOrigin(reportedFromBaseUrl, template.baseUrl) ? reportedLimits : null;
  const contextWindow = registeredModelLimit(model.contextWindow, reported?.contextWindow, exact?.contextWindow, 200_000);
  const reportedMaxTokens = reported?.maxTokens !== undefined && reported.maxTokens <= contextWindow.value
    ? reported.maxTokens
    : undefined;
  const modelLimits: ModelLimits = {
    contextWindow,
    maxTokens: registeredModelLimit(model.maxOutputTokens, reportedMaxTokens, exact?.maxTokens, 8192),
  };
  const apiKeyEnv = BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerId];
  modelRegistry.registerProvider(providerId, {
    name: getRuntimeProviderDisplayName(providerId),
    baseUrl: template.baseUrl,
    apiKey: "$" + apiKeyEnv,
    api: template.api,
    ...(template.headers ? { headers: template.headers } : {}),
    models: [{
      id: modelId,
      name: exact?.name ?? modelId,
      reasoning: exact?.reasoning ?? true,
      thinkingLevelMap: exact?.thinkingLevelMap,
      input: exact?.input ?? ["text"],
      cost: exact?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelLimits.contextWindow.value,
      maxTokens: modelLimits.maxTokens.value,
      ...(template.compat ? { compat: template.compat } : {}),
    }],
  });
  return {
    modelLimits: effectiveModelLimits(modelLimits, loadedModelOverride(modelRegistry, providerId, modelId), modelRegistry.find(providerId, modelId)),
  };
}

export function configureBuiltInGatewayCustomModel(
  modelRegistry: ModelRegistry,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null,
  deps: AnthropicGatewayContractDeps = {},
  gatewayLimits: GatewayModelLimits | null = null,
): BuiltInGatewayRegistration {
  const gateway = resolveBuiltInGatewayLaunch(runtimeConfig, providerConnection);
  if (!gateway || runtimeConfig.runtime !== "builtin" || runtimeConfig.model.kind !== "custom") return { thinkingContract: null, modelLimits: null };

  const provider = builtInGatewayRegistryProvider(gateway.providerId);
  const matchingModel: Model<"openai-completions"> | Model<"anthropic-messages"> | undefined = provider.api === "openai-completions"
    ? findMatchingOpenAICompatibleModel(
        modelRegistry,
        gateway.baseUrl,
        runtimeConfig.model.name,
      )
    : findMatchingAnthropicCompatibleModel(
        modelRegistry,
        gateway.baseUrl,
        runtimeConfig.model.name,
      );
  // An Anthropic-compatible pair the SDK catalog does not know but whose
  // thinking contract is on record (exact endpoint + full model id). A catalog
  // match wins; every other pair keeps the SDK's defaults, so an unknown
  // endpoint inherits nothing from either source.
  const anthropicContract = provider.api === "anthropic-messages" && !matchingModel
    ? findAnthropicGatewayThinkingContract(gateway.baseUrl, runtimeConfig.model.name, deps)
    : undefined;
  const input = resolveBuiltInGatewayModelInput(
    matchingModel?.input,
    gateway.supportsImageInput,
  );
  const contextWindow = registeredModelLimit(runtimeConfig.model.contextWindow, gatewayLimits?.contextWindow, matchingModel?.contextWindow, 200_000);
  // A gateway max output that does not fit the context window the model ends
  // up with is ignored (docs page: "Max output must fit in the context window").
  const gatewayMaxTokens = gatewayLimits?.maxTokens !== undefined && gatewayLimits.maxTokens <= contextWindow.value
    ? gatewayLimits.maxTokens
    : undefined;
  const modelLimits: ModelLimits = {
    contextWindow,
    maxTokens: registeredModelLimit(runtimeConfig.model.maxOutputTokens, gatewayMaxTokens, matchingModel?.maxTokens, 8192),
  };

  modelRegistry.registerProvider(provider.id, {
    name: getRuntimeProviderDisplayName(gateway.providerId),
    baseUrl: gateway.baseUrl,
    apiKey: `$${provider.apiKeyEnv}`,
    api: provider.api,
    models: [{
      id: runtimeConfig.model.name,
      name: matchingModel?.name ?? runtimeConfig.model.name,
      reasoning: matchingModel?.reasoning ?? true,
      thinkingLevelMap: matchingModel?.thinkingLevelMap ?? anthropicContract?.thinkingLevelMap,
      input,
      cost: matchingModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelLimits.contextWindow.value,
      maxTokens: modelLimits.maxTokens.value,
      ...(provider.api === "openai-completions"
        ? {
            // A user-supplied OpenAI-compatible endpoint is not necessarily
            // native OpenAI. Keep unknown payloads portable, while preserving
            // exact SDK metadata when endpoint + model match a known provider
            // (for example Qwen Token Plan).
            compat: (matchingModel as Model<"openai-completions"> | undefined)?.compat ?? {
              supportsDeveloperRole: false,
              supportsStore: false,
            },
          }
        : matchingModel?.compat
          ? { compat: matchingModel.compat }
          : anthropicContract
            ? { compat: { forceAdaptiveThinking: anthropicContract.forceAdaptiveThinking } }
            : {}),
    }],
  });
  return {
    thinkingContract: anthropicContract ?? null,
    modelLimits: effectiveModelLimits(
      modelLimits,
      loadedModelOverride(modelRegistry, provider.id, runtimeConfig.model.name),
      modelRegistry.find(provider.id, runtimeConfig.model.name),
    ),
  };
}

export function detectPiModelsFromRegistry(modelRegistry: PiModelRegistryLike): RuntimeModelSet | null {
  const models: RuntimeModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of modelRegistry.getAvailable()) {
    const id = `${model.provider}/${model.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: `${model.name || humanizeRuntimeProviderSegment(model.id)} · ${getRuntimeProviderDisplayName(model.provider)}`,
      verified: "launchable",
    });
  }

  return models.length > 0 ? { models } : null;
}

function applyPiDaemonSettingsOverrides(settingsManager: SettingsManager): void {
  settingsManager.applyOverrides({ compaction: { enabled: PI_SDK_COMPACTION_ENABLED } });
}

function logPiServiceDiagnostics(context: string, services: AgentSessionServices): void {
  for (const diagnostic of services.diagnostics) {
    const message = `[pi-driver] ${context} diagnostic: ${diagnostic.message}`;
    if (diagnostic.type === "info") {
      console.info(message);
    } else {
      console.warn(message);
    }
  }
}

function formatPiModelLogId(model: Model<any> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "default";
}

function piServiceDiagnosticTraceAttrs(services: AgentSessionServices): Record<string, number> {
  let info = 0;
  let warning = 0;
  for (const diagnostic of services.diagnostics) {
    if (diagnostic.type === "info") {
      info++;
    } else {
      warning++;
    }
  }
  return {
    diagnostics_count: services.diagnostics.length,
    diagnostic_info_count: info,
    diagnostic_warning_count: warning,
  };
}

function addPiServiceTraceEvent(
  span: RuntimeModelDetectionContext["span"],
  name: string,
  services: AgentSessionServices,
  attrs: Record<string, unknown> = {},
): void {
  const modelRegistry = new ModelRegistry(services.modelRuntime);
  span?.addEvent(name, {
    available_models_count: modelRegistry.getAvailable().length,
    ...piServiceDiagnosticTraceAttrs(services),
    ...attrs,
  });
}

export async function detectPiModels(
  modelRegistry?: PiModelRegistryLike,
  traceContext: RuntimeModelDetectionContext = {},
): Promise<RuntimeModelSet | null> {
  if (modelRegistry) {
    return detectPiModelsFromRegistry(modelRegistry);
  }

  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
  });
  const detectedModelRegistry = new ModelRegistry(services.modelRuntime);
  logPiServiceDiagnostics("detect_models", services);
  addPiServiceTraceEvent(traceContext.span, "daemon.pi.models.services_ready", services);
  const result = detectPiModelsFromRegistry(detectedModelRegistry);
  traceContext.span?.addEvent("daemon.pi.models.result", {
    available_models_count: detectedModelRegistry.getAvailable().length,
    returned_models_count: result?.models?.length ?? 0,
    outcome: result ? "models_returned" : "no_models",
    ...piServiceDiagnosticTraceAttrs(services),
  });
  console.info(
    "[pi-driver] detect_models agentDir=%s available=%d returned=%d",
    agentDir,
    detectedModelRegistry.getAvailable().length,
    result?.models?.length ?? 0,
  );
  return result;
}

function piErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through.
    }
  }
  return "Unknown Pi error";
}

type PiProviderRequestFailureReason =
  | "provider_auth_denied"
  | "provider_rate_limited"
  | "provider_not_found"
  | "provider_request_rejected"
  | "provider_server_error"
  | "pre_response_transport_error"
  | "stream_read_error"
  | "provider_unknown_error";

type PiProviderRequestState = {
  phase: RuntimeTerminalCausePhase;
  responseStarted: boolean;
  failureReported: boolean;
  span: ActiveSpan | undefined;
  settle?: (status: "ok" | "error") => void;
};

function writePiLifecycleDiagnostic(
  ctx: SpawnContext,
  sessionId: string,
  event: RuntimeLifecycleDiagnosticEvent,
  logPrefix: string,
): boolean {
  const written = Boolean(writeRuntimeLifecycleDiagnosticRecord({
    runtime: ctx.config.runtime,
    sessionId,
    fallbackDir: ctx.workingDirectory,
    agentId: ctx.agentId,
    launchId: ctx.launchId ?? null,
    processInstanceId: ctx.processInstanceId ?? null,
    event,
  }));
  console.info("[%s] runtime_lifecycle %s", logPrefix, JSON.stringify({
    sessionId,
    launchId: ctx.launchId ?? null,
    processInstanceId: ctx.processInstanceId ?? null,
    event,
    diagnosticPersisted: written,
  }));
  return written;
}

/**
 * Closed set of error classes the persisted lifecycle diagnostics may name.
 * The sidecar is a diagnostic artifact that outlives the process, so an
 * `error.name` is copied only when it is one of these known categories;
 * anything else (including a name that merely looks identifier-shaped) is
 * written as `UnknownError`. The set is the shared runtime error taxonomy
 * plus the daemon's own startup/launch error classes and the JS built-ins
 * that reach the Built-in driver's start and transcript-persist paths.
 */
const DIAGNOSTIC_ERROR_CLASSES: ReadonlySet<string> = new Set<string>([
  ...RUNTIME_ERROR_CLASSES,
  "RuntimeModelNotFoundError",
  "RuntimeExecutableNotFoundError",
  "RuntimeSessionStartError",
  "RuntimeVersionTooOldError",
  "ProviderConnectionMaterializationError",
  "RunnerCredentialMintError",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "AbortError",
]);

export function safeDiagnosticErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && DIAGNOSTIC_ERROR_CLASSES.has(name) ? name : "UnknownError";
}

/**
 * Closed set of `error.code` values the persisted lifecycle diagnostics may copy:
 * Node/undici transport codes and Node file-system codes that reach the Built-in
 * driver's start and transcript-persist paths. Like the error class, the code is
 * externally controlled text, so an identifier-shaped value is not enough; anything
 * outside this set is omitted rather than persisted.
 */
const DIAGNOSTIC_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  // transport
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  // file system
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EEXIST",
  "EINVAL",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export function safeDiagnosticErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DIAGNOSTIC_ERROR_CODES.has(code) ? code : undefined;
}

function safeTranscriptEntryType(
  value: unknown,
): Extract<RuntimeLifecycleDiagnosticEvent, { kind: "transcript_persist" }>["entryType"] {
  switch (value) {
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return value;
    default:
      return "unknown";
  }
}

type PiDeliveryRequest = {
  requestMethod: () => "turn/start" | "turn/steer";
  text: string;
};

function normalizeProviderHttpStatus(value: unknown): number | null {
  const status = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{3}$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function readProviderHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const value of [record.status, record.statusCode]) {
      const status = normalizeProviderHttpStatus(value);
      if (status !== null) return status;
    }
    if (record.response && typeof record.response === "object") {
      const status = normalizeProviderHttpStatus(
        (record.response as Record<string, unknown>).status,
      );
      if (status !== null) return status;
    }
  }

  const message = piErrorMessage(error);
  const match = /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/iu.exec(message)
    ?? /\b([45]\d{2})\s+(?:status(?:\s+code)?|Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/iu.exec(message);
  return normalizeProviderHttpStatus(match?.[1]);
}

function classifyPiProviderRequestFailure(
  error: unknown,
  responseStarted: boolean,
): { reason: PiProviderRequestFailureReason; http_status?: number } {
  try {
    const httpStatus = readProviderHttpStatus(error);
    let reason: PiProviderRequestFailureReason;
    if (httpStatus === 401 || httpStatus === 403) {
      reason = "provider_auth_denied";
    } else if (httpStatus === 429) {
      reason = "provider_rate_limited";
    } else if (httpStatus === 404) {
      reason = "provider_not_found";
    } else if (httpStatus !== null && httpStatus < 500) {
      reason = "provider_request_rejected";
    } else if (httpStatus !== null) {
      reason = "provider_server_error";
    } else if (isPiProviderTransportFailure(error)) {
      reason = responseStarted ? "stream_read_error" : "pre_response_transport_error";
    } else {
      reason = "provider_unknown_error";
    }
    return {
      reason,
      ...(httpStatus === null ? {} : { http_status: httpStatus }),
    };
  } catch {
    return { reason: "provider_unknown_error" };
  }
}

function isPiProviderTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = typeof error === "string"
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : "";
  if (/^(?:Connection error\.?|fetch failed|Premature close|socket hang up|terminated)$/iu.test(message)) {
    return true;
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_[A-Z_]+)\b/u.test(message)) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (/^(?:APIConnectionError|ConnectTimeoutError|HeadersTimeoutError|SocketError)$/u.test(name)) {
    return true;
  }
  const code = typeof record.code === "string" ? record.code : "";
  return /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_[A-Z_]+)$/u.test(code);
}

function pushSessionInitIfNeeded(state: PiSdkEventMappingState, events: ParsedEvent[]): void {
  if (!state.sessionAnnounced && state.sessionId) {
    events.push({ kind: "session_init", sessionId: state.sessionId });
    state.sessionAnnounced = true;
  }
}

function piAssistantContentIndex(assistantEvent: PiAssistantMessageEvent): number {
  return "contentIndex" in assistantEvent && typeof assistantEvent.contentIndex === "number"
    ? assistantEvent.contentIndex
    : 0;
}

function announcePiThinkingIfNeeded(index: number, state: PiSdkEventMappingState): ParsedEvent[] {
  if (state.announcedThinkingIndexes.has(index)) return [];
  state.announcedThinkingIndexes.add(index);
  return [{ kind: "thinking", text: "" }];
}

function resetPiThinking(index: number, state: PiSdkEventMappingState): void {
  state.thinkingBuffers.delete(index);
  state.announcedThinkingIndexes.delete(index);
}

function announcePiTextIfNeeded(index: number, state: PiSdkEventMappingState): ParsedEvent[] {
  if (state.announcedTextIndexes.has(index)) return [];
  state.announcedTextIndexes.add(index);
  return [{ kind: "text", text: "" }];
}

function resetPiText(index: number, state: PiSdkEventMappingState): void {
  state.textBuffers.delete(index);
  state.announcedTextIndexes.delete(index);
}

function newPiResponseObservation(): PiResponseObservation {
  return { text: false, whitespace: false, thinkingOrTool: false, indeterminate: false };
}

function observePiText(observation: PiResponseObservation, text: unknown): void {
  if (typeof text !== "string") { observation.indeterminate = true; return; }
  if (text.trim()) observation.text = true;
  else if (text.length) observation.whitespace = true;
}

/** Untrusted SDK snapshot: an unfamiliar/malformed block is not proof of an empty response. */
function observePiResponseContent(observation: PiResponseObservation, content: unknown): void {
  if (!Array.isArray(content)) {
    observation.indeterminate = true;
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") { observation.indeterminate = true; continue; }
    if (block.type === "text" && typeof block.text === "string") observePiText(observation, block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") observation.thinkingOrTool = true;
    else if (block.type === "toolCall" && typeof block.id === "string" && block.id && typeof block.name === "string" && block.name) observation.thinkingOrTool = true;
    else observation.indeterminate = true;
  }
}

function observePiResponseStream(event: PiAssistantMessageEvent, state: PiSdkEventMappingState): void {
  const observation = state.responseObservation;
  if (!observation) return;
  if ("partial" in event) observePiResponseContent(observation, event.partial?.content);
  if (event.type === "text_delta") observePiText(observation, event.delta);
  else if (event.type === "text_end") observePiText(observation, event.content);
  else if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end"
    || event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") observation.thinkingOrTool = true;
  else if (event.type === "error") observation.indeterminate = true;
}

function mapPiAssistantMessageEvent(
  assistantEvent: PiAssistantMessageEvent,
  state: PiSdkEventMappingState,
): ParsedEvent[] {
  observePiResponseStream(assistantEvent, state);
  switch (assistantEvent.type) {
    case "thinking_start": {
      const index = piAssistantContentIndex(assistantEvent);
      resetPiThinking(index, state);
      return announcePiThinkingIfNeeded(index, state);
    }
    case "thinking_delta": {
      const index = piAssistantContentIndex(assistantEvent);
      const events = announcePiThinkingIfNeeded(index, state);
      if (typeof assistantEvent.delta === "string" && assistantEvent.delta.length > 0) {
        state.thinkingBuffers.set(index, `${state.thinkingBuffers.get(index) ?? ""}${assistantEvent.delta}`);
      }
      return events;
    }
    case "thinking_end": {
      const index = piAssistantContentIndex(assistantEvent);
      const buffered = state.thinkingBuffers.get(index) ?? "";
      const text = typeof assistantEvent.content === "string" && assistantEvent.content.length > 0
        ? assistantEvent.content
        : buffered;
      resetPiThinking(index, state);
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "text_start": {
      const index = piAssistantContentIndex(assistantEvent);
      resetPiText(index, state);
      return announcePiTextIfNeeded(index, state);
    }
    case "text_delta": {
      const index = piAssistantContentIndex(assistantEvent);
      const events = announcePiTextIfNeeded(index, state);
      if (typeof assistantEvent.delta === "string" && assistantEvent.delta.length > 0) {
        state.textBuffers.set(index, `${state.textBuffers.get(index) ?? ""}${assistantEvent.delta}`);
      }
      return events;
    }
    case "text_end": {
      const index = piAssistantContentIndex(assistantEvent);
      const buffered = state.textBuffers.get(index) ?? "";
      const text = typeof assistantEvent.content === "string" && assistantEvent.content.length > 0
        ? assistantEvent.content
        : buffered;
      resetPiText(index, state);
      return text ? [{ kind: "text", text }] : [];
    }
    case "error":
      return [{ kind: "error", message: piErrorMessage(assistantEvent.error.errorMessage || assistantEvent.error) }];
    case "toolcall_start":
    case "toolcall_delta": {
      // Agent typing line. The live block at `contentIndex` names the call
      // (id + name); `toolcall_delta` carries the next arguments-JSON text.
      const call = piStreamingToolCall(assistantEvent.partial, assistantEvent.contentIndex);
      if (!call) return [];
      const sendIntent = (state.sendIntentScanner ??= new SendIntentArgumentScanner())
        .append(call.id, call.name, assistantEvent.type === "toolcall_delta" ? assistantEvent.delta : undefined);
      return sendIntent ? [sendIntent] : [];
    }
    case "toolcall_end": {
      // Providers that hand over the arguments whole (no deltas) are read
      // here, still before the tool runs.
      const call = assistantEvent.toolCall;
      if (!call || typeof call.id !== "string" || typeof call.name !== "string") return [];
      const sendIntent = (state.sendIntentScanner ??= new SendIntentArgumentScanner())
        .complete(call.id, call.name, call.arguments);
      return sendIntent ? [sendIntent] : [];
    }
    case "start":
    case "done":
      return [];
    default: {
      const _exhaustive: never = assistantEvent;
      // An SDK version can add events before the daemon learns their shape.
      // Preserve uncertainty rather than mistaking their payload for silence.
      if (state.responseObservation) state.responseObservation.indeterminate = true;
      return [];
    }
  }
}

function piStreamingToolCall(partial: unknown, contentIndex: number): { id: string; name: string } | null {
  const content = (partial as { content?: unknown } | undefined)?.content;
  const block = Array.isArray(content) ? content[contentIndex] as { type?: unknown; id?: unknown; name?: unknown } | undefined : undefined;
  if (!block || block.type !== "toolCall" || typeof block.id !== "string" || !block.id) return null;
  return { id: block.id, name: typeof block.name === "string" ? block.name : "" };
}

function mapPiMessageEndEvent(
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
  state: PiSdkEventMappingState,
): ParsedEvent[] {
  const message = event.message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    usage?: unknown;
    content?: unknown;
  } | undefined;

  const events: ParsedEvent[] = [];
  // Pi dispatches the finalized message object to its listeners once, then persists it.
  // Replaying that SDK event must not create another notice; no content/timestamp hash.
  if (message?.role === "assistant" && state.endedResponses.has(message)) return events;
  if (message?.role === "assistant") {
    const observation = state.responseObservation ?? newPiResponseObservation();
    state.responseObservation = null;
    state.endedResponses.add(message);
    if (message.stopReason === "stop" && !state.responseCancelled) {
      observePiResponseContent(observation, message.content);
      if (!observation.indeterminate && !observation.text && !observation.thinkingOrTool) {
        const itemType = observation.whitespace ? "whitespace_response" : "empty_response";
        events.push({ kind: "runtime_diagnostic", severity: "info", source: "pi_empty_response", itemType,
          message: PI_RESPONSE_NOTICE_TEXT[itemType], sessionId: state.sessionId ?? undefined });
      }
    }
  }

  // The pi-ai AssistantMessage carries a `usage` object (tokens + cost) on both
  // successful and error turns. Emit token_usage telemetry only when usage is
  // actually present (mark-absent, never zero-fill). See piEventNormalizer.ts.
  // sessionId is left undefined; agentProcessManager resolves it from the live
  // driver session when recording the telemetry span.
  const usageEvent = buildPiTokenUsageEvent(message, null);
  if (usageEvent) events.push(usageEvent);

  if (message?.role === "assistant" && message.stopReason === "error") {
    // Pi owns overflow recovery. Emitting the provider rejection here would
    // terminalize the daemon before Pi can compact and retry, and it leaks the
    // provider's raw body into Activity. Preserve any bounded usage telemetry,
    // then wait for compaction_end as the authoritative recovery outcome.
    if (isContextOverflow(message as Parameters<typeof isContextOverflow>[0])) {
      state.pendingProviderError = null;
      state.providerErrorOwnedByCompaction = true;
      return events;
    }
    state.providerErrorOwnedByCompaction = false;
    state.pendingProviderError = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "Pi SDK assistant turn ended with an unknown provider error";
  }

  return events;
}

function piTerminalCausePhaseForSdkEvent(event: AgentSessionEvent): RuntimeTerminalCausePhase {
  switch (event.type) {
    case "message_update":
      return "message_stream";
    case "message_end":
      return "message_end";
    default:
      return "sdk_event";
  }
}

/**
 * Pi's bash tool reports a command that exited non-zero as `isError: true`
 * with `structuredContent.exit_code`: the command ran, so the tool call is ok
 * and the exit code is recorded. Any other error result is a failed call.
 * `durationMs` is Pi's own monotonic measurement of `execute()`.
 */
export function piToolEndOutcome(event: { isError?: boolean; durationMs?: number; result?: unknown }): { ok?: boolean; durationMs?: number; exitCode?: number } {
  const exit = (event.result as { structuredContent?: { exit_code?: unknown } } | undefined)?.structuredContent?.exit_code;
  const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
  return {
    ...(exitCode !== undefined ? { ok: true, exitCode } : typeof event.isError === "boolean" ? { ok: !event.isError } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
  };
}

export function mapPiSdkEventToParsedEvents(
  event: AgentSessionEvent,
  state: PiSdkEventMappingState,
  inputEvidence?: PiCompactionInputEvidence,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  pushSessionInitIfNeeded(state, events);
  if (state.responseSessionId !== state.sessionId) {
    state.responseSessionId = state.sessionId;
    state.responseObservation = null;
    state.endedResponses = new WeakSet();
    state.responseCancelled = false;
  }

  switch (event.type) {
    case "agent_start":
      state.responseObservation = null;
      state.responseCancelled = false;
      return events;
    case "turn_start":
    case "turn_end":
    case "tool_execution_update":
    case "queue_update":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
      return events;
    case "auto_retry_end":
      if (!event.success) {
        if (state.providerErrorOwnedByCompaction) {
          state.providerErrorOwnedByCompaction = false;
          return events;
        }
        events.push({
          kind: "error",
          // A missing message_end is malformed SDK sequencing. Preserve the
          // terminal boundary by using the SDK's final error when available,
          // otherwise emit the same bounded fallback as message_end.
          message: event.finalError?.trim()
            || state.pendingProviderError
            || "Pi SDK assistant turn ended with an unknown provider error",
        });
        state.pendingProviderError = null;
      } else if (event.success) {
        // The SDK emits auto_retry_end(success=true) after the successful
        // message_end. Only this lifecycle event authorizes discarding the
        // earlier buffered provider failure.
        state.pendingProviderError = null;
        state.providerErrorOwnedByCompaction = false;
      }
      return events;
    case "agent_settled":
      state.responseObservation = null;
      if (event.aborted) state.responseCancelled = true;
      if (state.pendingProviderError) {
        events.push({ kind: "error", message: state.pendingProviderError });
        state.pendingProviderError = null;
      }
      state.providerErrorOwnedByCompaction = false;
      if (state.pendingTurnEnd) {
        state.pendingTurnEnd = false;
        events.push({ kind: "turn_end", sessionId: state.sessionId || undefined });
      }
      return events;
    case "message_end":
      events.push(...mapPiMessageEndEvent(event, state));
      return events;
    case "message_start":
      if ((event.message as { role?: string }).role === "assistant") {
        state.responseObservation = newPiResponseObservation();
        state.thinkingBuffers.clear();
        state.announcedThinkingIndexes.clear();
        state.textBuffers.clear();
        state.announcedTextIndexes.clear();
      }
      return events;
    case "message_update":
      events.push(...mapPiAssistantMessageEvent(event.assistantMessageEvent, state));
      return events;
    case "tool_execution_start":
      events.push({
        kind: "tool_call",
        name: event.toolName || "unknown_tool",
        input: event.args ?? {},
        ...(event.toolCallId ? { callId: event.toolCallId } : {}),
      });
      return events;
    case "tool_execution_end":
      events.push({
        kind: "tool_output",
        name: event.toolName || "unknown_tool",
        ...(event.toolCallId ? { callId: event.toolCallId } : {}),
        ...piToolEndOutcome(event),
      });
      return events;
    case "compaction_start":
      if (state.compactionTerminal) return events;
      state.compactionCycle += 1;
      state.openCompactionCycle = state.compactionCycle;
      // task #1362: compacting between agent_end and agent_settled (Pi's own
      // post-run compaction, or an extension's from its agent_settled hook):
      // the daemon's turn end is still to come.
      events.push({
        kind: "compaction_started",
        cycleId: state.compactionCycle,
        ...(state.pendingTurnEnd ? { afterRunEnd: true as const } : {}),
      });
      return events;
    case "compaction_end": {
      if (state.compactionTerminal) return events;
      const projection = projectPiCompactionEnd(event);
      const { outcome, reason, failureReason, willRetry } = projection;
      const cycleId = state.openCompactionCycle ?? undefined;
      state.openCompactionCycle = null;
      if (outcome === "aborted") {
        events.push({
          kind: "compaction_interrupted",
          ...(cycleId === undefined ? {} : { cycleId }),
          outcome,
          reason,
          willRetry,
        });
      } else if (outcome === "compaction_succeeded") {
        events.push({ kind: "compaction_finished", ...(cycleId === undefined ? {} : { cycleId }) });
      } else {
        state.compactionTerminal = true;
      }
      events.push({
        kind: "telemetry",
        name: "recovery",
        source: "pi_compaction",
        attrs: {
          recovery_outcome: outcome,
          compaction_reason: reason,
          ...(failureReason ? { failure_reason: failureReason } : {}),
          will_retry: willRetry,
          ...projectPiCompactionInputTelemetry(inputEvidence, reason),
        },
      });
      if (outcome === "compaction_failed_or_exhausted") {
        const failureDiagnostic = typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0
          ? buildRuntimeErrorActivityDiagnostic(event.errorMessage)
          : undefined;
        events.push({
          kind: "error",
          // Machine-readable classifier only. APM projects this structured
          // terminal outcome through the existing bounded runtime guidance;
          // raw provider text and new user-facing adapter copy stay out.
          message: failureReason === "compaction_failed" ? "RuntimeError: context compaction failed" : "InputTooLargeError",
          terminalReason: "compaction_failed_or_exhausted",
          // One atomic terminal event owns both the error and compaction facts.
          // A separate interruption would produce duplicate terminal Activity.
          compaction: {
            outcome, reason, failureReason, willRetry: event.willRetry === true,
            ...(failureDiagnostic ? { failureDiagnostic } : {}),
          },
        });
      }
      return events;
    }
    case "agent_end":
      // agent_end precedes Pi's post-run retry/compaction handling. Publishing
      // daemon turn_end here allows APM to flush another prompt while recovery
      // is still resolving, which is the observed recovery loop. agent_settled
      // is the actual boundary after retry/compaction has terminated.
      state.pendingTurnEnd = true;
      return events;
    default:
      return events;
  }
}

const PI_RUNTIME_SESSION_DESCRIPTOR = {
  transport: "sdk",
  lifecycle: "sdk_session",
  stdout: {
    channel: "diagnostic",
  },
  input: {
    initial: "start",
    idle: "sdk_prompt",
    busy: "sdk_steer",
  },
  readiness: "sdk_ready",
  turnBoundary: "sdk_event",
  startPolicy: "immediate",
  inFlightWake: "steer",
  busyDelivery: "direct",
  postTurn: "keep_alive",
} as const satisfies RuntimeSessionDescriptor;

const PI_IDLE_PROMPT_RETRY_MS = 25;
const PI_IDLE_PROMPT_MAX_WAIT_MS = 1_000;

/**
 * View Context: records each provider request body, after the SDK's own
 * `onPayload` (extensions may replace it). Only the session's own turns: a
 * compaction's summary call carries an id of its own and can't send a message.
 *
 * pi-ai calls `onPayload` with the full body (system, tools, every message)
 * before it turns an Anthropic message-threads request into a `continue` that
 * carries only the new messages, so the record is the whole context with
 * threads on or off. piRequestLog.threads.test.ts pins that order.
 */
export function recordingRequests<O extends { onPayload?: unknown; sessionId?: string } | undefined>(
  requestLog: { log: PiRequestLog; sessionId: () => string | null } | undefined,
  model: { api?: unknown; provider?: unknown; id?: unknown },
  options: O,
): O {
  const sessionId = options?.sessionId;
  if (!requestLog || !sessionId || sessionId !== requestLog.sessionId()) return options;
  const caller = options?.onPayload as ((payload: unknown, model: never) => unknown) | undefined;
  return {
    ...options,
    onPayload: async (payload: unknown, payloadModel: never) => {
      const replaced = await caller?.(payload, payloadModel);
      requestLog.log.record(replaced ?? payload, {
        sessionId,
        provider: typeof model.provider === "string" ? model.provider : null,
        api: typeof model.api === "string" ? model.api : null,
        model: typeof model.id === "string" ? model.id : null,
      });
      return replaced;
    },
  };
}

function installProviderHttpClient(
  modelRuntime: ModelRuntime,
  providerHttpClient: ProviderHttpClient,
  customEndpoint: boolean,
  providerCallTracker?: PiProviderCallTracker,
  requestLog?: { log: PiRequestLog; sessionId: () => string | null },
  anthropicRequests?: PiAnthropicRequestMeter,
): void {
  const fetchForModel = (model: Parameters<ModelRuntime["stream"]>[0]) => {
    const prefix = model.id.split("/")[0];
    const provider = customEndpoint ? "custom" : isBuiltInRuntimeProviderId(model.provider) ? model.provider
      : isBuiltInRuntimeProviderId(prefix) ? prefix : "custom";
    return providerHttpClient.forProvider?.(provider) ?? providerHttpClient.fetch;
  };
  const stream = modelRuntime.stream.bind(modelRuntime);
  modelRuntime.stream = ((model, context, options) => {
    const providerOptions = {
      ...recordingRequests(requestLog, model, options),
      fetch: fetchForModel(model),
    } as typeof options;
    const call = (callOptions: typeof options) => providerCallTracker
      ? providerCallTracker.observe(model, callOptions, (observed) => stream(model, context, observed))
      : stream(model, context, callOptions);
    return anthropicRequests ? anthropicRequests.observe(model, providerOptions, call) : call(providerOptions);
  }) as ModelRuntime["stream"];

  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((model, context, options) => {
    const providerOptions = {
      ...recordingRequests(requestLog, model, options),
      fetch: fetchForModel(model),
    };
    const call = (callOptions: typeof providerOptions) => providerCallTracker
      ? providerCallTracker.observe(model, callOptions, (observed) => streamSimple(model, context, observed))
      : streamSimple(model, context, callOptions);
    return anthropicRequests ? anthropicRequests.observe(model, providerOptions, call) : call(providerOptions);
  }) as ModelRuntime["streamSimple"];
}

type PiAgentSessionOptions = { agentDir?: string; thinkingContracts?: AnthropicGatewayContractDeps["thinkingContracts"]; sessionDir?: string; traceName?: string; traceEventPrefix?: string; logPrefix?: string; exposeLaunchEnvToTools?: boolean; isolateHostProviderEnv?: boolean; agentDirSource?: "default" | "spawn_env" | "managed_builtin"; exposeLaunchTraceEvidence?: boolean };

export async function createPiAgentSessionForContext(
  ctx: SpawnContext,
  sessionId: string,
  opts: PiAgentSessionOptions = {},
  toolExecutionObserver?: PiToolExecutionObserver,
  providerObserver?: ProviderRequestObserver,
  providerCallTracker?: PiProviderCallTracker,
  anthropicRequests?: PiAnthropicRequestMeter,
): Promise<AgentSession> {
  return (await openPiAgentSessionForContext(ctx, sessionId, opts, toolExecutionObserver, providerObserver, providerCallTracker, anthropicRequests)).session;
}

/** The spawn of a pi SDK session: env, CLI transport, services, tools; the handle reopens the session on them. */
export async function openPiAgentSessionForContext(
  ctx: SpawnContext,
  sessionId: string,
  opts: PiAgentSessionOptions = {},
  toolExecutionObserver?: PiToolExecutionObserver,
  providerObserver?: ProviderRequestObserver,
  providerCallTracker?: PiProviderCallTracker,
  anthropicRequests?: PiAnthropicRequestMeter,
): Promise<PiSdkSessionHandle> {
  const sessionDir = opts.sessionDir ?? buildPiSessionDir(ctx.workingDirectory);
  mkdirSync(sessionDir, { recursive: true });

  const logPrefix = opts.logPrefix ?? "pi-driver";
  writePiLifecycleDiagnostic(ctx, sessionId, {
    kind: "session_start",
    phase: "started",
  }, logPrefix);

  let runtimeConfig: ReturnType<typeof hydrateRuntimeConfig>;
  let launchPlan: ReturnType<typeof buildLaunchPlan>;
  try {
    runtimeConfig = hydrateRuntimeConfig(ctx.config);
    launchPlan = buildLaunchPlan(runtimeConfig);
  } catch (error) {
    const errorCode = safeDiagnosticErrorCode(error);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "failed",
      errorClass: safeDiagnosticErrorClass(error),
      ...(errorCode ? { errorCode } : {}),
    }, logPrefix);
    throw error;
  }
  const { trace: launchTrace, configSource: _configSource, ...launchRuntimeFields } = launchPlan;
  launchRuntimeFields.envVars = {
    ...(launchRuntimeFields.envVars ?? {}),
    ...(ctx.config.envVars ?? {}),
  };
  if (Object.keys(launchRuntimeFields.envVars).length === 0) launchRuntimeFields.envVars = null;
  const managedProviderConnection = runtimeConfig.runtime === "builtin"
    && runtimeConfig.provider.kind === "connection"
    ? ctx.config.providerConnection ?? null
    : null;
  const managedProviderApiKeyEnv = managedProviderConnection
    && isBuiltInRuntimeProviderId(managedProviderConnection.providerId)
    ? BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[managedProviderConnection.providerId]
    : managedProviderConnection
      && isBuiltInRuntimeGatewayProviderId(managedProviderConnection.providerId)
      ? BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[managedProviderConnection.providerId]
      : null;
  const managedProviderKeyPresent = Boolean(
    managedProviderApiKeyEnv && launchRuntimeFields.envVars?.[managedProviderApiKeyEnv],
  );
  const launchTraceEvidenceAttrs = opts.exposeLaunchTraceEvidence ? {
    config_source: launchTrace.config_source,
    ...(runtimeConfig.runtime === "builtin" ? { host_user_state: runtimeConfig.hostUserState } : {}),
    ...(launchTrace.provider_id || managedProviderConnection
      ? { provider_id: launchTrace.provider_id ?? managedProviderConnection?.providerId }
      : {}),
    ...(launchTrace.model_kind ? { model_kind: launchTrace.model_kind } : {}),
    ...(launchTrace.model_id ? { model_id: launchTrace.model_id } : {}),
    ...(launchTrace.base_url_present !== undefined || managedProviderConnection
      ? { base_url_present: launchTrace.base_url_present ?? Boolean(managedProviderConnection?.endpointUrl) }
      : {}),
    ...(launchTrace.base_url_host_class ? { base_url_host_class: launchTrace.base_url_host_class } : {}),
    provider_key_present: launchTrace.provider_key_present || managedProviderKeyPresent,
    ...(launchTrace.provider_key_source || managedProviderKeyPresent
      ? { provider_key_source: launchTrace.provider_key_source ?? "server_managed_connection" }
      : {}),
  } : {};
  const requestedModel = launchRuntimeFields.model || "default";
  const traceSpan = ctx.tracer?.startSpan(opts.traceName ?? "daemon.pi.session.create", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: ctx.agentId,
      launchId: ctx.launchId || undefined,
      runtime: ctx.config.runtime,
      model: ctx.config.model,
      session_id_present: Boolean(sessionId),
      requested_model: requestedModel,
      ...launchTraceEvidenceAttrs,
    },
  });
  const traceEventPrefix = opts.traceEventPrefix ?? "daemon.pi.session";
  let providerHttpClient: ProviderHttpClient | undefined;

  let liveSessionId: string | null = null;
  try {
    const spawnEnv = await buildPiSpawnEnv(ctx);
    const agentDir = opts.agentDir ?? spawnEnv.PI_CODING_AGENT_DIR ?? getAgentDir();
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.create(ctx.workingDirectory, agentDir);
    // Resolve only enabled host extensions. Keep host auth, models and other
    // settings out of the managed Built-in session, and never install packages.
    let localExtensionPaths: string[] = [];
    if (runtimeConfig.runtime === "builtin" && runtimeConfig.loadLocalPlugins === true) {
      const hostAgentDir = spawnEnv.PI_CODING_AGENT_DIR ?? getAgentDir();
      const hostSettings = SettingsManager.create(ctx.workingDirectory, hostAgentDir, { projectTrusted: false });
      const hostPackages = new DefaultPackageManager({
        cwd: ctx.workingDirectory,
        agentDir: hostAgentDir,
        settingsManager: hostSettings,
      });
      const resources = await hostPackages.resolve(async () => "skip");
      localExtensionPaths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
    }
    const providerEnvScope = opts.isolateHostProviderEnv ? BUILTIN_BLOCKED_HOST_PROVIDER_ENV_KEYS : undefined;
    const sessionCreateEnvPatch = buildPiSessionCreateEnvPatch(runtimeConfig, launchRuntimeFields.envVars);
    // #proj-runtime:#53: the gateway's model list is read while the session's
    // services are built, through a client routed like its model calls (the
    // proxy env snapshot is taken here, with the session's env patch).
    // A typed OpenRouter model (task #10) reads OpenRouter's list the same way.
    type ModelListRead = GatewayModelLimitsResult & { providerKind: "gateway" | "openrouter"; baseUrl: string | null };
    const gatewayLimitsRead = ((): Promise<ModelListRead> => {
      const gateway = Boolean(resolveBuiltInGatewayLaunch(runtimeConfig, managedProviderConnection));
      const presetCustom = !gateway && resolveBuiltInPresetCustomModel(runtimeConfig) !== null;
      if (!gateway && !presetCustom) {
        return Promise.resolve({ limits: null, outcome: "skipped", cached: false, providerKind: "gateway", baseUrl: null });
      }
      const providerKind = gateway ? "gateway" as const : "openrouter" as const;
      let client: ProviderHttpClient;
      try {
        client = createProviderHttpClient({ ...process.env, ...(sessionCreateEnvPatch ?? {}) }, `pi-gateway-limits:${randomUUID()}`);
      } catch {
        return Promise.resolve({ limits: null, outcome: "failed:network", cached: false, providerKind, baseUrl: null });
      }
      // Never rejects; the client goes as soon as the read is done, whatever the session does.
      const read: Promise<ModelListRead> = gateway
        ? readBuiltInGatewayModelLimits(runtimeConfig, managedProviderConnection, launchRuntimeFields.envVars, client.fetch)
          .then((result) => ({ ...result, providerKind, baseUrl: null }))
        : readBuiltInPresetCustomModelLimits(runtimeConfig, client.fetch).then((result) => ({ ...result, providerKind }));
      return read.finally(() => client.dispose());
    })();
    const sessionServices = await withProcessEnvPatch(sessionCreateEnvPatch, async () => {
      const sessionProviderHttpClient = createProviderHttpClient(
        process.env,
        `pi-provider:${randomUUID()}`,
        { provider: "custom", observe: providerObserver },
      );
      try {
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          // The user's file as is: pi-ai's default Anthropic message threads apply (#runtime-watch:#1).
          modelsPath: path.join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
        installProviderHttpClient(modelRuntime, sessionProviderHttpClient,
          runtimeConfig.runtime === "builtin" && (runtimeConfig.provider.kind === "gateway"
            || (runtimeConfig.provider.kind === "connection" && Boolean(managedProviderConnection?.endpointUrl))),
          providerCallTracker,
          ctx.contextViewRequestLogDir ? {
            log: new PiRequestLog(ctx.contextViewRequestLogDir, (reason, error) => {
              console.warn("[%s] View Context request not recorded: %s %s", logPrefix, reason, error ? safeDiagnosticErrorClass(error) : "");
            }),
            sessionId: () => liveSessionId,
          } : undefined,
          anthropicRequests);
        // Request-time credentials and proxy routing must be session-local.
        // Holding a process.env patch across an async SDK turn serializes every
        // Pi agent in this runner. The short create-time scope also keeps
        // ModelRuntime's initial refresh from snapshotting forbidden host
        // provider credentials for Built-in.
        await seedPiSessionModelRuntime(
          modelRuntime,
          runtimeConfig,
          managedProviderConnection,
          launchRuntimeFields.envVars,
        );
        const services = await createAgentSessionServices({
          cwd: ctx.workingDirectory,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoaderOptions: {
            additionalExtensionPaths: localExtensionPaths,
            // Keeps an oversized compaction request inside the model limit (task #10).
            // Named so session rotation can tell it from a user extension.
            extensionFactories: [{ name: PI_DAEMON_EXTENSION_NAME, factory: createPiCompactionFitExtension() }],
            systemPromptOverride: () => ctx.standingPrompt,
          },
        });
        return { services, providerHttpClient: sessionProviderHttpClient };
      } catch (error) {
        sessionProviderHttpClient.dispose();
        throw error;
      }
    }, { removeFirst: providerEnvScope });
    const { services } = sessionServices;
    providerHttpClient = sessionServices.providerHttpClient;
    const modelRegistry = new ModelRegistry(services.modelRuntime);
    const contractDeps: AnthropicGatewayContractDeps = opts.thinkingContracts ? { thinkingContracts: opts.thinkingContracts } : {};
    const gatewayLimits = await gatewayLimitsRead;
    if (gatewayLimits.outcome !== "skipped") {
      traceSpan?.addEvent(`${traceEventPrefix}.gateway_model_limits`, {
        outcome: gatewayLimits.outcome,
        cached: gatewayLimits.cached,
        provider_kind: gatewayLimits.providerKind,
        context_window_reported: gatewayLimits.limits?.contextWindow !== undefined,
        max_tokens_reported: gatewayLimits.limits?.maxTokens !== undefined,
        ...(gatewayLimits.format ? { format: gatewayLimits.format } : {}),
        fallback_read: gatewayLimits.fallbackRead === true,
      });
    }
    const gatewayRegistration = configureBuiltInGatewayCustomModel(
      modelRegistry,
      runtimeConfig,
      managedProviderConnection,
      contractDeps,
      gatewayLimits.providerKind === "gateway" ? gatewayLimits.limits : null,
    );
    // A typed OpenRouter model (task #10) reports its limits on the same frame as a gateway one.
    const presetCustomRegistration = configureBuiltInPresetCustomModel(
      modelRegistry,
      runtimeConfig,
      gatewayLimits.providerKind === "openrouter" ? gatewayLimits.limits : null,
      gatewayLimits.baseUrl,
    );
    const registeredModelLimits = gatewayRegistration.modelLimits ?? presetCustomRegistration.modelLimits;
    applyPiDaemonSettingsOverrides(services.settingsManager);
    logPiServiceDiagnostics("create_session", services);
    addPiServiceTraceEvent(traceSpan, `${traceEventPrefix}.services_ready`, services, {
      agent_dir_source: opts.agentDirSource ?? (spawnEnv.PI_CODING_AGENT_DIR ? "spawn_env" : "default"),
      ...launchTraceEvidenceAttrs,
    });
    const model = resolvePiModelFromRegistry(
      launchRuntimeFields.model,
      modelRegistry,
      runtimeConfig,
      managedProviderConnection,
    );
    const resolvedModel = formatPiModelLogId(model);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "model_resolved",
      requestedModel,
      providerId: model?.provider ?? null,
      modelId: model?.id ?? null,
      modelApi: model?.api ?? null,
      configSource: launchTrace.config_source ?? null,
    }, logPrefix);
    traceSpan?.addEvent(`${traceEventPrefix}.model_resolved`, {
      available_models_count: modelRegistry.getAvailable().length,
      requested_model: requestedModel,
      requested_model_explicit: requestedModel !== "default",
      resolved_model: resolvedModel,
      resolved_model_present: Boolean(model),
      ...launchTraceEvidenceAttrs,
    });
    console.info(
      "[%s] create_session services_ready agentDir=%s available=%d requested=%s resolved=%s",
      logPrefix,
      agentDir,
      modelRegistry.getAvailable().length,
      requestedModel,
      resolvedModel,
    );
    if (launchRuntimeFields.model && launchRuntimeFields.model !== "default" && !model) {
      console.warn(
        "[%s] create_session missing_model requested=%s available=%d",
        logPrefix,
        requestedModel,
        modelRegistry.getAvailable().length,
      );
      traceSpan?.addEvent(`${traceEventPrefix}.missing_model`, {
        available_models_count: modelRegistry.getAvailable().length,
        requested_model: requestedModel,
        ...launchTraceEvidenceAttrs,
      });
      traceSpan?.end("error", {
        attrs: {
          outcome: "missing_model",
          available_models_count: modelRegistry.getAvailable().length,
          requested_model: requestedModel,
          resolved_model_present: false,
          ...piServiceDiagnosticTraceAttrs(services),
          ...launchTraceEvidenceAttrs,
        },
      });
      throw new RuntimeModelNotFoundError({ runtimeId: ctx.config.runtime || "pi", model: launchRuntimeFields.model });
    }

    const toolSpawnEnv = { ...spawnEnv };
    if (opts.exposeLaunchEnvToTools === false) {
      for (const key of Object.keys(launchRuntimeFields.envVars ?? {})) {
        delete toolSpawnEnv[key];
      }
    }

    const managedMcpTools = await createManagedMcpPiTools({
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
      processInstanceId: ctx.processInstanceId,
      readTurnOrigin: ctx.readTurnOrigin,
      onWarning: (message) => console.warn("[%s] %s", logPrefix, message),
    });
    // Built once per spawn. A rotation reopens the session file on these same
    // instances, so the resumed session sends the same tools (and request).
    const customTools = [
      createPiCommandTool(ctx.workingDirectory, toolSpawnEnv, {
        observer: toolExecutionObserver,
      }),
      ...managedMcpTools,
    ];
    const thinkingLevel = resolveBuiltInThinkingLevel(launchRuntimeFields.reasoningEffort, gatewayRegistration.thinkingContract);
    // A value Raft had to default is only a web warning for humans; the agent
    // is told in its system prompt how to declare the real one (models.json).
    const modelLimitsNote = registeredModelLimits && model
      ? formatBuiltInDefaultModelLimitsNote({
          providerId: model.provider,
          modelId: model.id,
          modelLimits: registeredModelLimits,
          modelsJsonPath: workspaceRelativePath(ctx.workingDirectory, path.join(agentDir, "models.json")),
        })
      : null;
    const sessionCreateServices = modelLimitsNote
      ? { ...services, resourceLoader: withSystemPromptSection(services.resourceLoader, modelLimitsNote) }
      : services;
    const sessionProviderHttpClient = sessionServices.providerHttpClient;
    // The spawn owns the provider client; it goes with the spawn's live
    // session. A session becomes live only once it is fully open, so one that
    // fails to open (a reopen's included) or one a reopen replaced never takes
    // the client with it. A failed first open releases it in the catch below.
    let liveSession: AgentSession | null = null;

    const openSdkSession = async (sessionFile: string | null): Promise<PiSdkSessionHandle> => {
      const sessionManager = sessionFile
        ? SessionManager.open(sessionFile, sessionDir, ctx.workingDirectory)
        : SessionManager.create(ctx.workingDirectory, sessionDir, { id: sessionId });
      liveSessionId = sessionManager.getSessionId();
      const persistSessionEntry = sessionManager._persist.bind(sessionManager);
      let lastTranscriptPersistOutcome: "deferred" | "persisted" | "failed" | null = null;
      sessionManager._persist = (entry) => {
        const entryType = safeTranscriptEntryType(entry.type);
        try {
          persistSessionEntry(entry);
          const persistedFile = sessionManager.getSessionFile();
          const outcome = persistedFile && existsSync(persistedFile) ? "persisted" : "deferred";
          if (outcome !== lastTranscriptPersistOutcome) {
            lastTranscriptPersistOutcome = outcome;
            writePiLifecycleDiagnostic(ctx, sessionId, {
              kind: "transcript_persist",
              outcome,
              entryType,
            }, logPrefix);
          }
        } catch (error) {
          lastTranscriptPersistOutcome = "failed";
          const errorCode = safeDiagnosticErrorCode(error);
          writePiLifecycleDiagnostic(ctx, sessionId, {
            kind: "transcript_persist",
            outcome: "failed",
            entryType,
            errorClass: safeDiagnosticErrorClass(error),
            ...(errorCode ? { errorCode } : {}),
          }, logPrefix);
          throw error;
        }
      };

      const { session } = await withProcessEnvPatch(sessionCreateEnvPatch, () => {
        // task #365: right before the SDK session exists, inside the env-patch
        // lock (waiting for it is an await too). What ran before it is local
        // preparation only: env, the session file, the session services and
        // the managed MCP tool list (a list call to this daemon's own proxy); no
        // provider request and no tool execution. A stale launch throws here
        // and the catch below releases the provider client.
        ctx.assertLaunchCurrent?.();
        return createAgentSessionFromServices({ services: sessionCreateServices, sessionManager, model, thinkingLevel, customTools });
      }, { removeFirst: providerEnvScope });
      const untrackSessionMemory = trackPiSessionMemory(session);
      const disposeSdkSession = session.dispose.bind(session);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        untrackSessionMemory();
        disposeSdkSession();
      };
      session.dispose = () => {
        if (released) return;
        try {
          release();
        } finally {
          if (liveSession === session) sessionProviderHttpClient.dispose();
        }
      };

      if (runtimeConfig.runtime === "builtin" && runtimeConfig.loadLocalPlugins === true) {
        try {
          // Complete the SDK extension lifecycle, including session_start hooks.
          await session.bindExtensions({ mode: "rpc" });
        } catch (error) {
          session.dispose();
          throw error;
        }
      }

      liveSession = session;
      return new PiSdkSessionHandle(session, async () => {
        // The same open a restart does, on this spawn's resources. The new
        // session rebinds the extension runtime the services share; pi's
        // dispose of the old one then marks that runtime stale, which only an
        // extension calling pi's API at run time would notice. Rotation runs
        // with the daemon's own extension alone, which does not.
        const reopenFile = newestPiSessionFile(sessionDir, sessionId);
        if (!reopenFile) throw new Error("Pi session rotation found no session file to reopen");
        const next = await openSdkSession(reopenFile);
        // The old session goes only once the new one is live (it has the client now).
        try {
          release();
        } catch (error) {
          console.warn("[%s] reopen: disposing the old session failed: %s", logPrefix, piErrorMessage(error));
        }
        return next;
      }, registeredModelLimits);
    };

    const opened = await openSdkSession(ctx.config.sessionId ? newestPiSessionFile(sessionDir, ctx.config.sessionId) : null);
    const session = opened.session;

    traceSpan?.addEvent(`${traceEventPrefix}.started`, {
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      session_id_present: Boolean(session.sessionId),
      ...launchTraceEvidenceAttrs,
    });
    traceSpan?.end("ok", {
      attrs: {
        outcome: "started",
        available_models_count: modelRegistry.getAvailable().length,
        requested_model: requestedModel,
        resolved_model: resolvedModel,
        resolved_model_present: Boolean(model),
        ...piServiceDiagnosticTraceAttrs(services),
        ...launchTraceEvidenceAttrs,
      },
    });
    console.info(
      "[%s] create_session started sessionId=%s requested=%s resolved=%s",
      logPrefix,
      sessionId,
      requestedModel,
      resolvedModel,
    );
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "ready",
    }, logPrefix);
    providerHttpClient = undefined;
    return opened;
  } catch (error) {
    providerHttpClient?.dispose();
    const errorCode = safeDiagnosticErrorCode(error);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "failed",
      errorClass: safeDiagnosticErrorClass(error),
      ...(errorCode ? { errorCode } : {}),
    }, logPrefix);
    traceSpan?.end("error", {
      attrs: {
        outcome: "error",
        error_class: errorClassOf(error),
        ...launchTraceEvidenceAttrs,
      },
    });
    throw error;
  }
}

/**
 * Pi SDK prompts currently in flight in this runner process, across all agents.
 *
 * This is the direct observable for the credential-isolation fix (task #510).
 * While request-time credentials were resolved from `process.env`, every
 * prompt/steer ran inside `runWithProcessEnvPatchLock`, so the lock was held for
 * the whole model turn and this counter could never exceed 1 — N agents sharing
 * one machine-wide runner serialized into a single queue (observed: 60-165s waits
 * for ~17s of real work). With session-local credentials the prompt path takes no
 * process-global lock, so this rises to the number of concurrently prompting
 * agents. A value > 1 is therefore proof the cross-agent queue is gone.
 */
let piPromptsInFlight = 0;

/** Test-only: read the process-wide in-flight prompt count. */
export function __piPromptsInFlightForTest(): number {
  return piPromptsInFlight;
}

export class PiSdkRuntimeSession implements RuntimeSession {
  readonly descriptor = PI_RUNTIME_SESSION_DESCRIPTOR;
  private readonly events = new EventEmitter();
  private readonly mappingState: PiSdkEventMappingState;
  private readonly toolExecutionObserver: PiToolExecutionObserver | undefined;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private didClose = false;
  private requestedStopReason: string | undefined;
  private cancellationSource: "requested_stop" | "requested_interrupt" | "dispose" | null = null;
  private exitInfo: RuntimeExitInfo | null = null;
  private activeProviderRequest: PiProviderRequestState | null = null;
  private readonly turnOrigin: RuntimeTurnOriginHolder;
  /** How to reopen the live SDK session for a rotation; null for a session that cannot be (test doubles). */
  private sessionHandle: PiSdkSessionHandle | null = null;
  /** Inputs accepted but not handed to the SDK yet (deferSdkCall, or waiting out a rotation). */
  private queuedInputs = 0;
  private readonly rotationConfig: PiSessionRotationConfig;
  /** A compaction finished for good (`willRetry: false`); its run has not settled yet. */
  private compactionAwaitingSettle = false;
  /** A compaction finished and its run settled since the last rotation (plan §1). */
  private rotationDue = false;
  /** Steps 3 and 4 of a running rotation (dispose, resume); inputs wait for it. */
  private rotation: Promise<void> | null = null;
  /** Task #1310: open provider calls, so a stall can say whether one was still running. */
  private readonly providerCallTracker: PiProviderCallTracker;
  /** #runtime-watch:#1: per-call request size on `anthropic-messages` (piAnthropicRequests.ts). */
  private readonly anthropicRequests: PiAnthropicRequestMeter;

  constructor(
    private readonly ctx: SpawnContext,
    private readonly setCurrentSessionId: (sessionId: string | null) => void,
    private readonly sessionFactory: PiSessionFactory = (
      sessionCtx,
      sessionId,
      observer,
      providerObserver,
      providerCallTracker,
      anthropicRequests,
    ) => openPiAgentSessionForContext(sessionCtx, sessionId, {}, observer, providerObserver, providerCallTracker, anthropicRequests),
  ) {
    this.mappingState = createPiSdkEventMappingState(ctx.config.sessionId || null);
    this.turnOrigin = new RuntimeTurnOriginHolder(ctx.processInstanceId);
    this.providerCallTracker = new PiProviderCallTracker((ended) => {
      ctx.tracer?.emitEvent("daemon.pi.provider_call.ended", {
        surface: "daemon",
        attrs: {
          agentId: ctx.agentId,
          launchId: ctx.launchId || undefined,
          runtime: ctx.config.runtime,
          ...ended,
        },
      });
    });
    this.anthropicRequests = new PiAnthropicRequestMeter({
      warmRecycleFlag: ctx.config.wakeRecycleWarm === true,
      // Through the manager's telemetry path: `daemon.runtime.telemetry.provider_request`, and the turn's byte totals.
      emitRequest: (attrs) => {
        if (this.didClose) return;
        this.emitRuntimeEvent({ kind: "telemetry", name: "provider_request", source: PI_ANTHROPIC_REQUEST_SOURCE, attrs });
      },
    });
    // Registered in the constructor so these run BEFORE any manager listener: on turn_end the
    // manager may immediately send the next idle prompt, which must see the previous turn closed.
    this.events.on("runtime_event", (event: ParsedEvent) => {
      if (event.kind === "turn_end") this.turnOrigin.endTurn();
    });
    this.events.on("exit", () => this.turnOrigin.close());
    this.rotationConfig = resolvePiSessionRotationConfig(ctx.config.piSessionRotation, ctx.config.envVars);
    const runtimeContext = ctx.config.runtimeContext;
    // Built-in runs the same Pi session and command tool, so it gets the same
    // tool facts; stalled recovery depends on them (task #1302).
    this.toolExecutionObserver = (ctx.config.runtime === "pi" || ctx.config.runtime === "builtin")
      && Boolean(runtimeContext?.serverId)
      && Boolean(runtimeContext?.machineId)
      && Boolean(ctx.launchId)
      ? createPiToolExecutionObserver({
          tracer: ctx.tracer,
          serverId: runtimeContext!.serverId!,
          machineId: runtimeContext!.machineId!,
          agentId: ctx.agentId,
          launchId: ctx.launchId!,
          runtime: ctx.config.runtime,
          runtimeVersion: PI_SDK_VERSION,
          runtimeSessionId: ctx.config.sessionId,
        })
      : undefined;
  }

  get pid(): undefined {
    return undefined;
  }

  get currentSessionId(): string | null {
    return this.mappingState.sessionId;
  }

  get exitCode(): number | null {
    return this.exitInfo?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exitInfo?.signal ?? null;
  }

  get closed(): boolean {
    return this.didClose;
  }

  // In-process SDK session: there is no OS pid to probe with signal-0, so
  // liveness is unknowable via the pid-probe boundary. Return undefined, which
  // callers treat the same as the historic "no pid" probe result (RS-011).
  providerCallSnapshot(): RuntimeProviderCallSnapshot {
    return this.providerCallTracker.snapshot();
  }

  isAlive(): boolean | undefined {
    return undefined;
  }

  emitToolDiagnosticSnapshots(
    input: RuntimeToolDiagnosticInput,
  ): RuntimeToolDiagnosticSnapshot[] {
    return this.toolExecutionObserver?.emitDiagnosticSnapshots(input) ?? [];
  }

  on<T extends RuntimeSessionEventName>(
    event: T,
    cb: (...args: RuntimeSessionEvents[T]) => void,
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null; origin?: RuntimeTurnOrigin | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    if (this.didClose) return { ok: false, reason: "closed" };
    this.started = true;
    const sessionId = input.sessionId || this.ctx.config.sessionId || randomUUID();
    this.mappingState.sessionId = sessionId;
    this.setCurrentSessionId(sessionId);
    this.toolExecutionObserver?.setRuntimeSessionId(sessionId);

    // task #365: before the native runtime session is created.
    this.ctx.assertLaunchCurrent?.();
    this.bindSession(await this.sessionFactory({
      ...this.ctx,
      readTurnOrigin: this.turnOrigin.read,
      config: {
        ...this.ctx.config,
        sessionId,
      },
    }, sessionId, this.toolExecutionObserver, (activity) => {
      this.recordProviderRequestActivity(activity);
      if (!this.didClose) this.emitRuntimeEvent({ kind: "provider_request", activity });
    }, this.providerCallTracker, this.anthropicRequests));

    this.turnOrigin.beginTurn(input.origin);
    this.launchPrompt(input.text);
    // Register the initial prompt before announcing readiness. The runtime
    // event is synchronous, and a zero-delay readiness-debt settlement may
    // enqueue a busy steer; FIFO setImmediate ordering must keep the initial
    // prompt ahead of that steer.
    this.emitSessionInit();
    return { ok: true, acceptedAs: "prompt" };
  }

  private bindSession(opened: AgentSession | PiSdkSessionHandle): void {
    this.sessionHandle = opened instanceof PiSdkSessionHandle ? opened : null;
    const session = opened instanceof PiSdkSessionHandle ? opened.session : opened;
    this.session = session;
    this.mappingState.responseObservation = null;
    this.mappingState.endedResponses = new WeakSet();
    this.mappingState.responseCancelled = false;
    this.mappingState.sessionId = session.sessionId;
    this.setCurrentSessionId(session.sessionId);
    this.toolExecutionObserver?.setRuntimeSessionId(session.sessionId);
    this.unsubscribe = session.subscribe((event) => {
      this.observeToolExecutionEvent(event);
      this.recordCompactionLifecycle(event);
      if (event.type === "compaction_start") this.providerCallTracker.noteCompactionStarted();
      else if (event.type === "compaction_end") this.providerCallTracker.noteCompactionEnded();
      this.noteRotationProgress(event);
      if (
        event.type === "message_start" &&
        (event.message as { role?: unknown }).role === "assistant"
      ) {
        this.markProviderResponseStarted();
      }
      const inputEvidence = event.type === "compaction_end"
        ? piCompactionInputEvidence(session)
        : undefined;
      for (const parsed of mapPiSdkEventToParsedEvents(
        event,
        this.mappingState,
        inputEvidence,
      )) {
        if (parsed.kind === "error") {
          this.reportProviderRequestFailure(parsed.message);
        }
        this.emitRuntimeEvent(parsed, piTerminalCausePhaseForSdkEvent(event));
      }
    });
    // task #1357 item 1: every session opened here (a start, a rotation's
    // reopen) reports the limits registered for its model, with the revision
    // of the config this spawn was built from.
    const modelLimits = opened instanceof PiSdkSessionHandle ? opened.modelLimits : null;
    if (modelLimits && session.sessionId) {
      this.emitRuntimeEvent({
        kind: "model_limits",
        sessionId: session.sessionId,
        configRevision: typeof this.ctx.config.configRevision === "number" ? this.ctx.config.configRevision : null,
        modelLimits,
      } satisfies ParsedEvent);
    }
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
    origin?: RuntimeTurnOrigin | null;
  }): RuntimeSendResult {
    if (this.didClose) return { ok: false, reason: "closed" };
    const rotation = this.rotation;
    if (rotation) {
      // A rotation is reopening the session: hand the input over once it is
      // done, to the resumed session, or to the old one when the reopen
      // failed (resumeRotatedSession undoes the files and keeps it). APM
      // counts an accepted input as told (a tracked mention is acked), so the
      // input must reach a live session; only a failed undo ends the runtime
      // with it still queued.
      this.queuedInputs += 1;
      void rotation.then(() => {
        this.queuedInputs -= 1;
        if (!this.didClose) this.send(input);
      });
      return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
    }
    const session = this.session;
    if (!session) return { ok: false, reason: "closed" };

    if (input.mode === "busy") {
      this.deferSdkCall(
        () => session.steer(input.text),
        "steer_request",
        { requestMethod: () => "turn/steer", text: input.text },
      );
      return { ok: true, acceptedAs: "steer" };
    }

    if (session.isStreaming) {
      // May still fall back to steering the running turn, so this cannot be shown to be a new turn:
      // it opens one with NO origin rather than lending its message to calls of the streaming run.
      this.turnOrigin.beginTurn(null);
      this.launchPromptAfterStreaming(input.text);
      return { ok: true, acceptedAs: "prompt" };
    }
    this.turnOrigin.beginTurn(input.origin);
    this.launchPrompt(input.text, true);
    return { ok: true, acceptedAs: "prompt" };
  }

  /**
   * task #25 step 2: abort the running prompt and keep the session. Pi's bash
   * tool kills the command's process tree on the abort signal, and the turn
   * ends through agent_settled like any other.
   */
  interruptTurn(): "sent" | "unsupported" {
    const session = this.session;
    if (this.didClose || !session?.isStreaming) return "unsupported";
    this.mappingState.responseObservation = null;
    this.mappingState.responseCancelled = true;
    this.cancellationSource = "requested_interrupt";
    this.toolExecutionObserver?.observeAbortRequested("interrupt");
    this.recordLifecycle({
      kind: "cancel_requested",
      source: "requested_interrupt",
      signal: null,
      providerRequestActive: Boolean(this.activeProviderRequest),
    });
    void Promise.resolve()
      .then(() => session.abort())
      .catch((error) => {
        this.events.emit("stderr", piErrorMessage(error));
      });
    return "sent";
  }

  /** #proj-runtime:#54 phase 3: Pi's own estimate of the session's context and its model's window (the registered limit for a custom model). */
  async turnEndContextFacts(): Promise<TurnEndContextFacts> {
    const usage = this.didClose ? undefined : this.session?.getContextUsage();
    const tokens = usage?.tokens;
    const window = usage?.contextWindow;
    return {
      contextTokens: typeof tokens === "number" && tokens > 0 ? tokens : null,
      windowTokens: typeof window === "number" && window > 0 ? window : null,
    };
  }

  /**
   * #proj-runtime:#54 phase 3: Pi's manual compaction on an idle session.
   * `compact()` aborts whatever runs first, so a streaming or compacting
   * session is refused here instead. Its compaction_start/compaction_end
   * events reach the manager as any compaction's do.
   */
  async compactAtTurnEnd(): Promise<TurnEndCompactionDriverOutcome> {
    const session = this.session;
    if (this.didClose || !session) return { kind: "refused", reason: "no_session" };
    if (session.isStreaming) return { kind: "refused", reason: "busy" };
    if (session.isCompacting) return { kind: "refused", reason: "compacting" };
    try {
      await session.compact();
      return { kind: "completed" };
    } catch (error) {
      return { kind: "failed", reason: classifyTurnEndCompactionError(error) };
    }
  }

  /** Pi's prompt() throws while a compaction is open, so the held delivery would be refused: abort it first. */
  async cancelTurnEndCompaction(): Promise<void> {
    const session = this.session;
    if (this.didClose || !session || !session.isCompacting) return;
    session.abortCompaction();
    const deadline = Date.now() + 5_000;
    while (session.isCompacting && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    if (this.didClose) return;
    this.mappingState.responseObservation = null;
    this.mappingState.responseCancelled = true;
    this.turnOrigin.close();
    this.requestedStopReason = opts?.reason;
    this.toolExecutionObserver?.observeAbortRequested("stop");
    const signal = opts?.signal ?? "SIGTERM";
    const session = this.session;
    if (session?.isStreaming || this.activeProviderRequest) {
      this.cancellationSource = "requested_stop";
      this.recordLifecycle({
        kind: "cancel_requested",
        source: "requested_stop",
        signal,
        providerRequestActive: Boolean(this.activeProviderRequest),
      });
    }
    if (session?.isStreaming) {
      const aborted = Promise.resolve()
        .then(() => session.abort())
        .catch((error) => {
          this.events.emit("stderr", piErrorMessage(error));
        });
      // abort() waits for the run to go idle, which never happens if a tool
      // ignores the abort. A forced stop (the stalled-recovery SIGKILL
      // escalation) must still end the session (task #1302).
      if (signal !== "SIGKILL") await aborted;
    }
    await this.disposeSession();
    this.emitExitAndClose(null, signal);
  }

  async dispose(): Promise<void> {
    if (this.didClose) return;
    this.mappingState.responseObservation = null;
    this.mappingState.responseCancelled = true;
    // session.dispose() aborts the running tool too.
    this.toolExecutionObserver?.observeAbortRequested("stop");
    if (this.session?.isStreaming || this.activeProviderRequest) {
      this.cancellationSource = "dispose";
      this.recordLifecycle({
        kind: "cancel_requested",
        source: "dispose",
        signal: null,
        providerRequestActive: Boolean(this.activeProviderRequest),
      });
    }
    await this.disposeSession();
    this.emitExitAndClose(0, null);
  }

  private emitSessionInit(): void {
    const sessionId = this.mappingState.sessionId;
    if (!sessionId || this.mappingState.sessionAnnounced) return;
    this.mappingState.sessionAnnounced = true;
    this.emitRuntimeEvent({ kind: "session_init", sessionId } satisfies ParsedEvent);
  }

  /**
   * pi session rotation (pi#10642, plan v2.1): after a compaction, move a
   * session file over the size threshold to a seed that starts at the latest
   * compaction, under the same session id, and resume from it so the old
   * SessionManager (which holds every entry ever written) is released.
   */
  rotateSessionIfDue(hold: () => RuntimeSessionRotationHold | null): void {
    if (!this.rotationDue || this.rotation || this.didClose) return;
    // pi resolves the settled run's prompt only after its agent_settled
    // listeners (the turn end that calls this among them) have returned.
    setImmediate(() => this.rotateIfStillDue(hold));
  }

  private noteRotationProgress(event: AgentSessionEvent): void {
    if (!this.rotationConfig.enabled || !this.sessionHandle) return;
    if (event.type === "compaction_end") {
      const projection = projectPiCompactionEnd(event);
      if (projection.outcome === "compaction_succeeded" && !projection.willRetry) this.compactionAwaitingSettle = true;
    } else if (event.type === "agent_settled" && this.compactionAwaitingSettle) {
      this.compactionAwaitingSettle = false;
      this.rotationDue = true;
    }
  }

  /** The SDK session has a run, retry, queued message or daemon input of its own. */
  private sessionBusy(session: AgentSession): boolean {
    return this.queuedInputs > 0
      || this.activeProviderRequest !== null
      || !session.isIdle
      || session.isRetrying
      || session.pendingMessageCount > 0;
  }

  private rotateIfStillDue(hold: () => RuntimeSessionRotationHold | null): void {
    const session = this.session;
    const handle = this.sessionHandle;
    if (!this.rotationDue || this.rotation || this.didClose || !session || !handle) return;
    const held = hold() ?? (this.sessionBusy(session) ? "runtime_busy" : null);
    if (held) {
      // Still due: the input in flight ends in another turn end.
      this.emitRotationEvent("pi.session.rotation_skipped", { reason: held });
      return;
    }
    this.rotationDue = false;
    const skip = (reason: PiSessionRotationSkipReason, attrs: Record<string, number> = {}) =>
      this.emitRotationEvent("pi.session.rotation_skipped", { reason, ...attrs });

    const userExtensions = countPiUserExtensions(session.resourceLoader.getExtensions().extensions);
    if (userExtensions > 0) return skip("user_extension", { user_extension_count: userExtensions });
    const oldFile = session.sessionManager.getSessionFile();
    let bytes: number;
    try {
      if (!oldFile) throw new Error("no session file");
      bytes = statSync(oldFile).size;
    } catch {
      return skip("session_file_unreadable");
    }
    if (bytes < this.rotationConfig.minBytes) {
      return skip("below_threshold", { session_bytes: bytes, min_bytes: this.rotationConfig.minBytes });
    }
    const seed = buildPiSessionSeed(session.sessionManager, { now: currentDate(), oldFileBytes: bytes });
    if (!seed.rotatable) {
      this.emitRotationEvent("pi.session.rotate_refused", { ...piSessionSeedRefusalTraceAttrs(seed), session_bytes: bytes });
      return;
    }
    // Steps 1 and 2. A failure leaves the old session running on its file,
    // unless the seed is left as the file a resume opens: then follow it.
    const files = writePiSessionRotationFiles(seed, oldFile);
    if (!files.ok) {
      this.emitRotationFailure(files.stage, files.error, files.resumeFrom === "seed" ? "resumed_seed" : "kept_old");
      if (files.resumeFrom === "old") return;
    }
    // Steps 3 and 4. Nothing above awaited, so no input got in between.
    this.rotation = this.resumeRotatedSession(handle, seed, oldFile, files.ok ? seed.stats : null).finally(() => {
      this.rotation = null;
    });
  }

  /**
   * Steps 3 and 4 on the spawn's own resources (PiSdkSessionHandle.reopen):
   * the spawn path is not run again, so the CLI transport, the published
   * context generation, the credential proxy and the tools stay as they are.
   * The session id does not change, so nothing is announced again. The seed
   * is opened before the old session goes: a failed open undoes the files
   * and the old session keeps running, with the inputs queued meanwhile.
   */
  private async resumeRotatedSession(
    handle: PiSdkSessionHandle,
    seed: PiSessionSeed,
    oldFile: string,
    stats: PiSessionRotationStats | null,
  ): Promise<void> {
    let next: PiSdkSessionHandle;
    try {
      next = await handle.reopen();
    } catch (error) {
      if (this.didClose) return;
      if (undoPiSessionRotationFiles(seed, oldFile)) {
        this.emitRotationFailure("resume", error, "kept_old");
        return;
      }
      // The seed is what a resume opens and the old file is gone from under
      // the old session: end this runtime; a restart resumes from the seed.
      this.emitRotationFailure("resume", error, "runtime_ended");
      this.emitRuntimeEvent({ kind: "error", message: `Pi session rotation could not resume the session: ${piErrorMessage(error)}` }, "session_start");
      this.emitExitAndClose(1, null);
      return;
    }
    if (this.didClose) {
      next.session.dispose();
      return;
    }
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
    // The old session's calls are no longer observed; a late result for one is ignored.
    this.providerCallTracker.abandonAll();
    this.bindSession(next);
    if (stats) {
      this.emitRotationEvent("pi.session.rotated", { ...stats });
      this.recordLifecycle({
        kind: "session_rotated",
        fromFile: path.basename(seed.rotatedOldFile),
        toFile: path.basename(seed.seedFile),
        entriesBefore: stats.entries_before,
        bytesBefore: stats.bytes_before,
        entriesAfter: stats.entries_after,
        bytesAfter: stats.bytes_after,
      });
      console.info("[%s] session_rotated %s", this.logPrefix(), JSON.stringify({ sessionId: next.session.sessionId, ...stats }));
    }
  }

  private emitRotationFailure(
    stage: "write_seed" | "rename_old" | "resume",
    error: unknown,
    outcome: "kept_old" | "resumed_seed" | "runtime_ended",
  ): void {
    const errorCode = safeDiagnosticErrorCode(error);
    this.emitRotationEvent("pi.session.rotation_failed", {
      stage,
      outcome,
      error_class: safeDiagnosticErrorClass(error),
      ...(errorCode ? { error_code: errorCode } : {}),
    });
    console.warn("[%s] session_rotation_failed stage=%s %s", this.logPrefix(), stage, piErrorMessage(error));
  }

  private emitRotationEvent(
    name: "pi.session.rotated" | "pi.session.rotation_skipped" | "pi.session.rotate_refused" | "pi.session.rotation_failed",
    attrs: Record<string, string | number>,
  ): void {
    this.ctx.tracer?.emitEvent(name, {
      surface: "daemon",
      attrs: {
        agentId: this.ctx.agentId,
        launchId: this.ctx.launchId || undefined,
        runtime: this.ctx.config.runtime,
        ...attrs,
      },
    });
  }

  private logPrefix(): string {
    return this.ctx.config.runtime === "builtin" ? "builtin-driver" : "pi-driver";
  }

  private launchPrompt(text: string, delivery = false): void {
    const session = this.session;
    if (!session) {
      this.emitRuntimeEvent({
        kind: "error",
        message: "Pi SDK session is not started",
      } satisfies ParsedEvent, "session_start");
      return;
    }
    this.deferSdkCall(
      () => {
        this.toolExecutionObserver?.beginRuntimeTurn();
        return session.prompt(text);
      },
      "prompt_request",
      delivery ? { requestMethod: () => "turn/start", text } : undefined,
    );
  }

  private launchPromptAfterStreaming(text: string): void {
    let requestMethod: "turn/start" | "turn/steer" = "turn/start";
    this.deferSdkCall(
      async () => {
        const session = this.session;
        if (!session) return;
        const ready = await this.waitForStreamingToClear(session);
        if (this.didClose || this.session !== session) {
          return;
        }
        if (ready) {
          this.toolExecutionObserver?.beginRuntimeTurn();
          await session.prompt(text);
        } else {
          requestMethod = "turn/steer";
          await session.steer(text);
        }
      },
      "prompt_request",
      { requestMethod: () => requestMethod, text },
    );
  }

  private observeToolExecutionEvent(event: AgentSessionEvent): void {
    const observer = this.toolExecutionObserver;
    if (!observer) return;
    switch (event.type) {
      case "turn_start":
        observer.observeRuntimeTurnStart();
        return;
      case "turn_end":
      case "agent_end":
        observer.observeRuntimeTurnEnd();
        return;
      case "tool_execution_update":
        observer.observeRuntimeUpdate(event.toolCallId);
        return;
      default:
        return;
    }
  }

  private recordLifecycle(event: RuntimeLifecycleDiagnosticEvent): void {
    const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
    if (!sessionId) return;
    writePiLifecycleDiagnostic(this.ctx, sessionId, event, this.logPrefix());
  }

  private recordProviderRequestActivity(activity: ProviderRequestActivity): void {
    this.recordLifecycle({
      kind: "provider_request",
      requestId: activity.requestId,
      providerId: activity.provider,
      phase: activity.phase,
      ...(activity.httpStatus === undefined ? {} : { httpStatus: activity.httpStatus }),
      ...(activity.phase === "cancelled"
        ? { cancelSource: this.cancellationSource ?? "sdk_internal_or_unknown" }
        : {}),
    });
  }

  private recordCompactionLifecycle(event: AgentSessionEvent): void {
    if (event.type === "compaction_start") {
      this.recordLifecycle({ kind: "compaction", phase: "started" });
      return;
    }
    if (event.type !== "compaction_end") return;
    const projection = projectPiCompactionEnd(event);
    this.recordLifecycle({
      kind: "compaction",
      phase: projection.outcome === "compaction_succeeded"
        ? "succeeded"
        : projection.outcome === "aborted"
          ? "aborted"
          : "failed",
      reason: projection.reason,
      ...(projection.failureReason ? { failureReason: projection.failureReason } : {}),
      willRetry: projection.willRetry,
    });
  }

  private async waitForStreamingToClear(session: AgentSession): Promise<boolean> {
    const deadline = Date.now() + PI_IDLE_PROMPT_MAX_WAIT_MS;
    while (!this.didClose && this.session === session && session.isStreaming) {
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(PI_IDLE_PROMPT_RETRY_MS);
    }
    return !this.didClose && this.session === session && !session.isStreaming;
  }

  private deferSdkCall(
    invoke: () => Promise<unknown>,
    phase: RuntimeTerminalCausePhase,
    delivery?: PiDeliveryRequest,
  ): void {
    const queuedAt = currentTimeMs();
    this.queuedInputs += 1;
    setImmediate(() => {
      this.queuedInputs -= 1;
      if (this.didClose) return;
      const span = this.ctx.tracer?.startSpan("daemon.pi.prompt", {
        surface: "daemon",
        kind: "internal",
        attrs: {
          agentId: this.ctx.agentId,
          launchId: this.ctx.launchId || undefined,
          runtime: this.ctx.config.runtime,
        },
      });
      const startedAt = currentTimeMs();
      piPromptsInFlight += 1;
      span?.addEvent("daemon.pi.prompt.start", {
        agentId: this.ctx.agentId,
        queued_ms: startedAt - queuedAt,
        prompts_in_flight: piPromptsInFlight,
      });
      const requestState: PiProviderRequestState = {
        phase,
        responseStarted: false,
        failureReported: false,
        span,
      };
      this.activeProviderRequest = requestState;
      let settled = false;
      const settle = (status: "ok" | "error") => {
        if (settled) return;
        settled = true;
        piPromptsInFlight -= 1;
        if (this.activeProviderRequest === requestState) {
          this.activeProviderRequest = null;
        }
        span?.end(requestState.failureReported ? "error" : status, {
          attrs: {
            queued_ms: startedAt - queuedAt,
            duration_ms: currentTimeMs() - startedAt,
            prompts_in_flight_after: piPromptsInFlight,
          },
        });
      };
      requestState.settle = settle;
      try {
        void invoke().then(() => settle("ok")).catch((error) => {
          this.reportProviderRequestFailure(error, requestState);
          settle("error");
          if (this.didClose) return;
          this.emitDeferredSdkCallFailure(error, phase, delivery);
        });
      } catch (error) {
        this.reportProviderRequestFailure(error, requestState);
        settle("error");
        if (this.didClose) return;
        this.emitDeferredSdkCallFailure(error, phase, delivery);
      }
    });
  }

  private emitDeferredSdkCallFailure(
    error: unknown,
    phase: RuntimeTerminalCausePhase,
    delivery?: PiDeliveryRequest,
  ): void {
    const message = piErrorMessage(error);
    if (delivery) {
      this.emitRuntimeEvent({
        kind: "delivery_error",
        message,
        requestMethod: delivery.requestMethod(),
        source: "pi_sdk_response",
        code: "runtime.delivery_error",
        payloadBytes: Buffer.byteLength(delivery.text, "utf8"),
      } satisfies ParsedEvent, phase);
      return;
    }
    this.emitRuntimeEvent({
      kind: "error",
      message,
    } satisfies ParsedEvent, phase);
  }

  private markProviderResponseStarted(): void {
    if (this.activeProviderRequest) {
      this.activeProviderRequest.responseStarted = true;
    }
  }

  private reportProviderRequestFailure(
    error: unknown,
    requestState: PiProviderRequestState | null = this.activeProviderRequest,
  ): void {
    if (!requestState || requestState.failureReported) return;
    requestState.failureReported = true;
    const classified = classifyPiProviderRequestFailure(
      error,
      requestState.responseStarted || readProviderHttpStatus(error) !== null,
    );
    const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
    requestState.span?.addEvent("daemon.pi.provider_request.failed", {
      phase: requestState.phase,
      response_started: requestState.responseStarted || classified.http_status !== undefined,
      reason: classified.reason,
      ...(classified.http_status === undefined ? {} : { http_status: classified.http_status }),
      // #424 (@Leiysky): the flag keeps the same expression and changes only its
      // name. `sessionId` here IS the runtime session id — it is assigned to
      // `mappingState.sessionId` and `setRuntimeSessionId()` on the same line
      // (:1792-1795) — so naming the flag `session_id_present` put it in a
      // different family from the value it describes. The raw key is gone: the
      // sink drops it and it has no hash form, so emitting it only bought a
      // dropped-attribute count on every provider failure. Reads the same way
      // as the `launch_id_present` / `launch_id` pair just below.
      runtime_session_id_present: Boolean(sessionId),
      launch_id_present: Boolean(this.ctx.launchId),
      ...(this.ctx.launchId ? { launch_id: this.ctx.launchId } : {}),
    });
    // Close the span after the value-free provider event but before the
    // terminal runtime error is emitted. This makes the provenance row
    // queryable first for both rejected prompts and message_end stream errors.
    requestState.settle?.("error");
  }

  private emitRuntimeEvent(event: ParsedEvent, phase: RuntimeTerminalCausePhase = "sdk_event"): void {
    if (event.kind === "error") {
      this.writeTerminalCause(event.message, phase);
    }
    this.events.emit("runtime_event", event);
  }

  private writeTerminalCause(message: string, phase: RuntimeTerminalCausePhase): void {
    try {
      const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
      if (!sessionId) return;
      const runtimeConfig = hydrateRuntimeConfig(this.ctx.config);
      const launchPlan = buildLaunchPlan(runtimeConfig);
      writeRuntimeTerminalCauseRecord({
        runtime: this.ctx.config.runtime,
        sessionId,
        fallbackDir: this.ctx.workingDirectory,
        agentId: this.ctx.agentId,
        launchId: this.ctx.launchId ?? null,
        processInstanceId: this.ctx.processInstanceId ?? null,
        providerId: launchPlan.trace.provider_id ?? null,
        modelId: launchPlan.trace.model_id ?? launchPlan.model ?? this.ctx.config.model ?? null,
        phase,
        message,
      });
    } catch {
      // Diagnostics must never mask the runtime's terminal error event.
    }
  }

  private async disposeSession(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    const session = this.session;
    this.session = null;
    try {
      session?.dispose();
    } catch (error) {
      this.events.emit("stderr", piErrorMessage(error));
    }
  }

  private emitExitAndClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.didClose) return;
    this.didClose = true;
    this.providerCallTracker.abandonAll();
    const info: RuntimeExitInfo = {
      code,
      signal,
      reason: this.requestedStopReason ? "requested" : "runtime_exit",
    };
    this.exitInfo = info;
    this.events.emit("exit", info);
    this.events.emit("close", info);
  }
}

/**
 * Pi SDK driver.
 *
 * Slock runs Pi through the TypeScript SDK as a native RuntimeSession. The
 * driver keeps the SDK session alive for same-session steering while visible
 * chat/task/attachment communication still goes through the workspace-local
 * `slock` CLI wrapper injected into PATH by prepareCliTransport.
 */
export class PiDriver implements RuntimeDriver {
  readonly id: string = "pi";
  readonly supportsNativeStandingPrompt = true;
  readonly standingPromptRefreshesOnResume = true;
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // Emits the compaction events (builtin extends this driver).
    compaction: "reported",
    // One request summarizes the whole session: once it no longer fits the model, every resume fails again (builtin extends this driver).
    compactionFailure: "sticks_to_session",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  // The Pi SDK runs in the daemon process (builtin extends this driver).
  readonly shipsWithComputer = true;

  protected sessionId: string | null = null;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  probe(): RuntimeProbeResult {
    return {
      available: true,
      version: PI_SDK_VERSION,
    };
  }

  async detectModels(ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return runtimeModelSourceOutcomeFromSet(await detectPiModels(undefined, ctx));
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    });
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error("PiDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    const windowsPowerShell = process.platform === "win32";
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: windowsPowerShell
        ? ["- Pi's `bash` tool is a compatibility name on Windows: it executes native Windows PowerShell 5.1. Use PowerShell syntax and never Bash heredocs or Unix-only commands."]
        : [],
      commandShell: windowsPowerShell ? "powershell" : "posix",
    });
  }

}

/**
 * Built-in / Quick Start runtime driver.
 *
 * Product/design contract:
 * - Built-in is a Slock Quick Start path, not user-visible Pi.
 * - It reuses the Pi SDK implementation internally but stores sessions and Pi
 *   agent state under `.builtin-*` directories in the agent workspace.
 * - RuntimeConfig is the only launch source: provider/model/key/baseUrl and
 *   reasoning effort are materialized by `buildLaunchPlan()`.
 * - Host Pi settings/auth and ambient provider env vars remain isolated.
 *   Host extensions (including installed packages) load only with the per-agent
 *   loadLocalPlugins opt-in. Session creation removes generated
 *   Pi provider API-key env names plus a small local set of non-API ambient
 *   credential envs before services/model registry initialization.
 * - Trace evidence is closed/non-secret (`provider_id`, `model_kind`,
 *   `model_id`, key presence/source, baseUrl presence/host class) and never
 *   records API key values, raw base URLs, local paths, or host env names.
 */
export class BuiltInDriver extends PiDriver {
  readonly id = "builtin";
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };

  probe(): RuntimeProbeResult {
    return {
      available: true,
      version: PI_SDK_VERSION,
    };
  }

  async detectModels(_ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return {
      kind: "live",
      value: {
        models: RUNTIME_MODELS.builtin,
        catalog: {
          protocolVersion: 1,
          runtime: "builtin",
          runtimeVersion: PI_SDK_VERSION,
          // task #10: this Computer runs a typed model id on these preset providers.
          customModelProviderIds: [...BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS],
        },
      },
    };
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    }, (sessionCtx, sessionId, observer, providerObserver, providerCallTracker, anthropicRequests) => openPiAgentSessionForContext(sessionCtx, sessionId, {
      agentDir: buildBuiltInAgentDir(sessionCtx.workingDirectory),
      sessionDir: buildBuiltInSessionDir(sessionCtx.workingDirectory),
      traceName: "daemon.builtin.session.create",
      traceEventPrefix: "daemon.builtin.session",
      logPrefix: "builtin-driver",
      agentDirSource: "managed_builtin",
      exposeLaunchTraceEvidence: true,
      exposeLaunchEnvToTools: false,
      isolateHostProviderEnv: true,
    }, observer, providerObserver, providerCallTracker, anthropicRequests));
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    const windowsPowerShell = process.platform === "win32";
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: windowsPowerShell
        ? ["- This runtime's `bash` tool is a compatibility name on Windows: it executes native Windows PowerShell 5.1. Use PowerShell syntax and never Bash heredocs or Unix-only commands."]
        : [],
      commandShell: windowsPowerShell ? "powershell" : "posix",
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** A short, content-free class for a failed turn-end compaction (no summary or provider text). */
function classifyTurnEndCompactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/token cap|incomplete|length/i.test(message)) return "summary_incomplete";
  if (/nothing to compact|no messages/i.test(message)) return "nothing_to_compact";
  if (/abort|cancel/i.test(message)) return "aborted";
  return "error";
}
