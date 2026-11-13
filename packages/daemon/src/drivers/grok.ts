import { ambientProcessEnv } from "../processEnvPatch";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { execFileSync, spawn } from "node:child_process";
import { spawnRuntimeChild } from "./runtimeChild";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import {
  clearClockTimeout,
  GROK_MODEL_DETECTION_TIMEOUT_MS,
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  setClockTimeout,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
  type AxSurfaceText,
  isRuntimeModelDetectionLookupReason,
} from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { resolveGrokHomeFromEnv } from "./grokHome";
import {
  parseGrokJsonRpcLine,
  GrokEventNormalizer,
  type GrokJsonRpcId,
  type GrokJsonRpcMessage,
} from "./grokEventNormalizer";
import {
  classifyProbeExecFailure,
  lookupCommandOnPath,
  lookupCommandOnPathAsync,
  resolveCommandOnPath,
  withWindowsUserEnvironment,
  withWindowsUserEnvironmentAsync,
  type ProbeDeps,
} from "./probe";
import { resolveWindowsDirectLaunch, resolveWindowsDirectLaunchAsync, type DirectLaunch } from "./windowsLaunch";
import { killProbeTreeAndSettle, ProbeChildError } from "./probeChild";
import type {
  ParsedEvent,
  RuntimeBusyDeliveryReadiness,
  RuntimeDriver,
  RuntimeProbeResult,
  RuntimeProbeUnavailableReason,
  SpawnContext,
  SpawnResult,
} from "./types";

const GROK_AGENT_ARGS = ["agent", "--no-leader", "--always-approve", "stdio"] as const;
const GROK_AGENT_PROBE_ARGS = ["agent", "stdio", "--help"] as const;
const GROK_INTERJECT_METHOD = "_x.ai/interject" as const;
const GROK_REQUEST_PERMISSION_METHOD = "session/request_permission" as const;
const KNOWN_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

type GrokLaunch = DirectLaunch;

interface PendingPromptRequest {
  method: "turn/start";
  generation: number;
  initial: boolean;
}

interface PendingSteerRequest {
  method: "turn/steer";
}

type PendingDeliveryRequest = PendingPromptRequest | PendingSteerRequest;

function hasJsonRpcField(message: GrokJsonRpcMessage, field: "result" | "error"): boolean {
  return Object.prototype.hasOwnProperty.call(message, field);
}

function isJsonRpcResponse(message: GrokJsonRpcMessage): boolean {
  return message.id !== undefined && (hasJsonRpcField(message, "result") || hasJsonRpcField(message, "error"));
}

function isJsonRpcServerRequest(message: GrokJsonRpcMessage): message is GrokJsonRpcMessage & { id: GrokJsonRpcId; method: string } {
  return message.id !== undefined && typeof message.method === "string" && !isJsonRpcResponse(message);
}

function payloadBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalJsonValue(record[key])]),
  );
}

function permissionRequestFingerprint(
  id: GrokJsonRpcId,
  params: unknown,
): string {
  return JSON.stringify(canonicalJsonValue({
    id,
    method: GROK_REQUEST_PERMISSION_METHOD,
    params,
  }));
}

export function grokLaunchAllowsPermissionAutoApproval(
  args: readonly string[],
  sessionMeta: Record<string, unknown>,
): boolean {
  return args.includes("--always-approve") && sessionMeta.yoloMode === true;
}

function offeredAllowOnceOptionId(params: Record<string, unknown>): string | null {
  if (!Array.isArray(params.options)) return null;
  for (const candidate of params.options) {
    const option = recordValue(candidate);
    if (option?.kind !== "allow_once") continue;
    const optionId = nonEmptyString(option.optionId);
    if (optionId) return optionId;
  }
  return null;
}

function describeProbeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; signal?: unknown; code?: unknown };
    if (typeof candidate.status === "number") return `exit status ${candidate.status}`;
    if (typeof candidate.signal === "string") return `terminated by ${candidate.signal}`;
    if (typeof candidate.code === "string") return candidate.code;
  }
  return "probe failed";
}

function grokDirectLaunch(command: string, args: string[], deps: ProbeDeps): GrokLaunch {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command, args, shell: false };
  return resolveWindowsDirectLaunch("grok", command, args, deps);
}

function readGrokVersion(command: string, deps: ProbeDeps): string | null {
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const launch = grokDirectLaunch(command, ["--version"], deps);
    const env = withWindowsUserEnvironment(launch.env ?? deps.env ?? ambientProcessEnv(), deps);
    const output = execFileSyncFn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 5000,
      shell: false,
    });
    return (Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "")).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolveGrokCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath("grok", deps);
}

/**
 * task #1242: the lookup's own verdict decides the message. Only a locator
 * "not found" is a confirmed absence; a lookup that timed out, was denied or
 * failed says nothing about whether Grok Build is installed, so the message
 * states only what happened and never suggests installing.
 */
function grokNotResolvedMessage(missReason: RuntimeProbeUnavailableReason | undefined): string {
  switch (missReason) {
    case "probe_timeout":
      return "The PATH lookup for `grok` did not finish within its budget. This is not evidence that Grok Build is missing; retry.";
    case "permission_denied":
      return "The PATH lookup for `grok` was denied permission to run. This is not evidence that Grok Build is missing.";
    case "probe_failed":
      return "The PATH lookup for `grok` did not produce a usable result. This is not evidence that Grok Build is missing; retry.";
    default:
      return "Cannot resolve the Grok Build CLI on PATH. Install Grok Build and run `grok login` first.";
  }
}

export function resolveGrokSpawn(args: string[], deps: ProbeDeps = {}): GrokLaunch {
  // One lookup; its verdict travels on the error so the caller never has to
  // look again (a second observation could not explain this failure).
  const { command, missReason } = lookupCommandOnPath("grok", deps);
  if (!command) {
    throw new RuntimeExecutableNotFoundError({ runtimeId: "grok", message: grokNotResolvedMessage(missReason), reason: missReason });
  }
  return grokDirectLaunch(command, args, deps);
}

/** task #1277 — an aborted probe child, which the async resolvers rethrow unchanged. */
function isProbeAbort(error: unknown): boolean {
  return error instanceof ProbeChildError && error.code === "ABORT_ERR";
}

/**
 * task #1277 — {@link resolveGrokSpawn} off the event loop: the same single
 * lookup and the same verdict on the error, with the PATH lookup (and, on
 * Windows, the environment read and the `node` lookup behind a shim) run as
 * bounded probe children instead of execFileSync.
 */
export async function resolveGrokSpawnAsync(args: string[], deps: ProbeDeps = {}): Promise<GrokLaunch> {
  const { command, missReason } = await lookupCommandOnPathAsync("grok", deps);
  if (!command) {
    throw new RuntimeExecutableNotFoundError({ runtimeId: "grok", message: grokNotResolvedMessage(missReason), reason: missReason });
  }
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command, args, shell: false };
  return resolveWindowsDirectLaunchAsync("grok", command, args, deps);
}

/**
 * What another host (the OAR host, RFC 060) needs to run grok the way this
 * driver does: the same executable, launch environment (Raft transport added,
 * credentials removed), model, effort and native session to resume. Built
 * with the same calls `spawn` makes, so the two cannot drift apart.
 */
export interface GrokLaunchPlan {
  /** The grok executable this driver would spawn (one PATH lookup). */
  command: string;
  /** The complete launch environment. */
  env: NodeJS.ProcessEnv;
  /** Absent for the runtime's default (`default` or none configured). */
  model?: string;
  /**
   * The effort the agent chose, with or without a model: this driver sends it
   * with `session/set_model`, on Grok's current model when the agent runs the
   * default; OAR applies it on its own (`set_config_option`).
   */
  reasoningEffort?: string;
  /** The native grok session (`session/load`) this launch resumes. */
  resumeSessionId?: string;
}

export async function prepareGrokLaunch(ctx: SpawnContext, deps: ProbeDeps = {}): Promise<GrokLaunchPlan> {
  const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const model = launchFields.model === "default" ? null : nonEmptyString(launchFields.model);
  const reasoningEffort = nonEmptyString(launchFields.reasoningEffort);
  const resumeSessionId = nonEmptyString(ctx.config.sessionId);
  const launch = await resolveGrokSpawnAsync([...GROK_AGENT_ARGS], { ...deps, env: deps.env ?? spawnEnv, signal: ctx.launchSignal });
  return {
    command: launch.command,
    env: spawnEnv,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

export function probeGrok(deps: ProbeDeps = {}): RuntimeProbeResult {
  const { command, missReason } = lookupCommandOnPath("grok", deps);
  if (!command) {
    return { available: false, unavailableReason: missReason, diagnostic: "No Grok Build CLI was found on PATH." };
  }
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const launch = grokDirectLaunch(command, [...GROK_AGENT_PROBE_ARGS], deps);
    const env = withWindowsUserEnvironment(launch.env ?? deps.env ?? ambientProcessEnv(), deps);
    execFileSyncFn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 5000,
      shell: false,
    });
  } catch (error) {
    if (error instanceof RuntimeExecutableNotFoundError) {
      // `grok` was found on PATH but its direct launch could not be resolved.
      return { available: false, unavailableReason: "probe_failed", diagnostic: error.message };
    }
    return {
      available: false,
      unavailableReason: classifyProbeExecFailure(error),
      diagnostic: `Grok Build agent stdio probe failed: ${describeProbeFailure(error)}.`,
    };
  }
  return {
    available: true,
    version: readGrokVersion(command, deps) ?? undefined,
  };
}

export { resolveGrokHomeFromEnv };

function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    _meta: {
      startupHints: {
        nonInteractive: true,
        skipGitStatus: true,
        skipProjectLayout: true,
      },
      clientType: "raft-daemon",
      clientVersion: "1.0.0",
    },
  };
}

function isCompatibleInitializeResult(result: unknown): boolean {
  const value = recordValue(result);
  const capabilities = recordValue(value?.agentCapabilities);
  return value?.protocolVersion === 1 && capabilities?.loadSession === true;
}

function initializeFailureMessage(): string {
  return "Grok Build ACP initialize response is missing protocolVersion=1 or loadSession support; upgrade Grok Build to a compatible release.";
}

function sessionIdFromResult(result: unknown, requestedSessionId?: string | null): string | null {
  const value = recordValue(result);
  if (!value) return requestedSessionId ?? null;
  const meta = recordValue(value._meta);
  return nonEmptyString(value.sessionId)
    ?? nonEmptyString(meta?.sessionId)
    ?? requestedSessionId
    ?? null;
}

function grokErrorMessage(message: GrokJsonRpcMessage, fallback: string): string {
  return nonEmptyString(message.error?.message) ?? fallback;
}

function isMissingSessionError(error: GrokJsonRpcMessage["error"]): boolean {
  if (!error) return false;
  const code = error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? nonEmptyString((error.data as Record<string, unknown>).code)
    : null;
  return code === "FS_NOT_FOUND"
    || /\b(path|session)\b.*\b(not found|missing)\b/i.test(error.message ?? "")
    || /\bno such file or directory\b/i.test(String(error.data ?? ""));
}

function recoveryEvents(requestedSessionId?: string | null): {
  telemetry: Extract<ParsedEvent, { kind: "telemetry" }>;
  recovery: Extract<ParsedEvent, { kind: "runtime_recovery" }>;
} {
  return {
    telemetry: {
      kind: "telemetry",
      name: "recovery",
      source: "grok_resume_missing_session",
      attrs: {
        resume_error_class: "missing_session",
        recovery_action: "fallback_fresh_thread",
      },
    },
    recovery: {
      kind: "runtime_recovery",
      source: "grok_resume_missing_session",
      resumeErrorClass: "missing_session",
      recoveryAction: "fallback_fresh_thread",
      message: "Grok Build could not resume its previous session; Raft started a fresh Grok session.",
      details: "Use Raft conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Grok session context is loaded.",
      ...(requestedSessionId ? { requestedSessionId } : {}),
    },
  };
}

function prependRecoveryNotice(
  prompt: string,
  recovery: Extract<ParsedEvent, { kind: "runtime_recovery" }>,
): string {
  return `${recovery.message}\n\n${recovery.details}\n\n${prompt}`;
}

function modelReasoningEfforts(meta: unknown): { efforts: string[]; defaultEffort?: string } {
  const value = recordValue(meta);
  if (!value) return { efforts: [] };
  const efforts: string[] = [];
  let defaultEffort: string | undefined;
  if (Array.isArray(value.reasoningEfforts)) {
    for (const entry of value.reasoningEfforts) {
      const entryRecord = recordValue(entry);
      const effort = typeof entry === "string"
        ? nonEmptyString(entry)
        : entryRecord
          ? nonEmptyString(entryRecord.id) ?? nonEmptyString(entryRecord.value)
          : null;
      if (!effort || !KNOWN_REASONING_EFFORTS.has(effort) || efforts.includes(effort)) continue;
      efforts.push(effort);
      if (entryRecord?.default === true) defaultEffort = effort;
    }
  }
  const current = nonEmptyString(value.reasoningEffort);
  if (!defaultEffort && current && efforts.includes(current)) defaultEffort = current;
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

export function grokModelSetFromInitializeResult(result: unknown): RuntimeModelSet | null {
  const resultRecord = recordValue(result);
  const meta = recordValue(resultRecord?._meta);
  const modelState = recordValue(meta?.modelState);
  if (!modelState || !Array.isArray(modelState.availableModels)) return null;
  const models: RuntimeModelInfo[] = [];
  for (const candidate of modelState.availableModels) {
    const entry = recordValue(candidate);
    if (!entry) continue;
    const id = nonEmptyString(entry.modelId);
    if (!id) continue;
    const { efforts, defaultEffort } = modelReasoningEfforts(entry._meta);
    models.push({
      id,
      label: nonEmptyString(entry.name) ?? id,
      verified: "launchable",
      ...(efforts.length > 0 ? { supportedReasoningEfforts: efforts } : {}),
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }
  if (models.length === 0) return null;
  const current = nonEmptyString(modelState.currentModelId);
  return {
    models,
    ...(current && models.some((model) => model.id === current) ? { default: current } : {}),
  };
}

export class GrokDriver implements RuntimeDriver {
  readonly id = "grok";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly stdoutChannel = "structured_protocol" as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // Never emits a compaction event.
    compaction: "unreported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  } as const;
  readonly startupReadiness = "initial_turn" as const;
  readonly requiresSessionInitForDelivery = true as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;

  private process: ChildProcess | null = null;
  private requestId = 0;
  private initializeRequestId: GrokJsonRpcId | null = null;
  private pendingSessionRequestId: GrokJsonRpcId | null = null;
  private pendingSessionRequestMethod: "session/new" | "session/load" | null = null;
  private pendingModelRequestId: GrokJsonRpcId | null = null;
  private pendingInitialPrompt: string | null = null;
  private pendingDeliveryRequests = new Map<GrokJsonRpcId, PendingDeliveryRequest>();
  private permissionRequestFingerprints = new Map<GrokJsonRpcId, string>();
  private requestedResumeSessionId: string | null = null;
  private freshSessionParams: Record<string, unknown> | null = null;
  private selectedModel: string | null = null;
  private selectedReasoningEffort: string | null = null;
  /** The model Grok runs when none is chosen, from the initialize result. */
  private initializeDefaultModel: string | null = null;
  private normalizer = new GrokEventNormalizer();
  private grokHomeRoot: string | null = null;
  private autoApprovePermissionRequests = false;

  get currentSessionId(): string | null {
    return this.normalizer.sessionId;
  }

  get currentRuntimeHomeDir(): string | null {
    return this.grokHomeRoot;
  }

  busyDeliveryReadiness(): RuntimeBusyDeliveryReadiness {
    return this.normalizer.canSteerBusy
      ? { ready: true }
      : { ready: false, reason: "no_active_turn" };
  }

  probe(): RuntimeProbeResult {
    return probeGrok();
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
    const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
    this.process = null;
    this.requestId = 0;
    this.initializeRequestId = null;
    this.pendingSessionRequestId = null;
    this.pendingSessionRequestMethod = null;
    this.pendingSessionAfterInitialize = null;
    this.pendingModelRequestId = null;
    this.pendingInitialPrompt = ctx.prompt;
    this.pendingDeliveryRequests.clear();
    this.permissionRequestFingerprints.clear();
    this.requestedResumeSessionId = nonEmptyString(ctx.config.sessionId);
    this.selectedModel = launchFields.model === "default" ? null : nonEmptyString(launchFields.model);
    this.selectedReasoningEffort = nonEmptyString(launchFields.reasoningEffort);
    this.initializeDefaultModel = null;
    this.normalizer.reset();
    this.autoApprovePermissionRequests = false;
    this.grokHomeRoot = resolveGrokHomeFromEnv(spawnEnv, {
      cwd: ctx.workingDirectory,
      homeDir: spawnEnv.HOME ?? spawnEnv.USERPROFILE ?? os.homedir(),
    });

    const meta = {
      systemPromptOverride: ctx.standingPrompt,
      yoloMode: true,
      ...(this.selectedModel ? { modelId: this.selectedModel } : {}),
    };
    this.autoApprovePermissionRequests = grokLaunchAllowsPermissionAutoApproval(GROK_AGENT_ARGS, meta);
    this.freshSessionParams = {
      cwd: ctx.workingDirectory,
      mcpServers: [],
      _meta: meta,
    };
    const sessionRequest = this.requestedResumeSessionId
      ? {
          method: "session/load" as const,
          params: {
            sessionId: this.requestedResumeSessionId,
            cwd: ctx.workingDirectory,
            mcpServers: [],
            _meta: meta,
          },
        }
      : { method: "session/new" as const, params: this.freshSessionParams };

    // task #1277: the PATH lookup (and on Windows the environment read and the
    // node-behind-shim lookup) run as bounded probe children under this start
    // attempt's signal; a cancelled lookup is rethrown, never a verdict.
    const launch = await resolveGrokSpawnAsync([...GROK_AGENT_ARGS], { env: spawnEnv, signal: ctx.launchSignal });
    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    // A start stopped while the lookup ran must not create a child.
    if (ctx.launchSignal?.aborted) throw new ProbeChildError("grok launch cancelled before the child was created", { code: "ABORT_ERR" });
    const proc = spawnRuntimeChild(launch.command, launch.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env ?? spawnEnv,
      shell: false,
    });
    this.process = proc;

    queueMicrotask(() => {
      this.pendingSessionAfterInitialize = sessionRequest;
      this.initializeRequestId = this.sendRequest("initialize", initializeParams());
    });

    return { process: proc };
  }

  private pendingSessionAfterInitialize: {
    method: "session/new" | "session/load";
    params: Record<string, unknown>;
  } | null = null;

  parseLine(line: string): ParsedEvent[] {
    const message = parseGrokJsonRpcLine(line);
    if (!message) return [];

    if (isJsonRpcServerRequest(message)) {
      if (message.method === GROK_REQUEST_PERMISSION_METHOD) {
        const fingerprint = permissionRequestFingerprint(message.id, message.params);
        const previousFingerprint = this.permissionRequestFingerprints.get(message.id);
        if (previousFingerprint !== undefined) {
          if (previousFingerprint === fingerprint) return [];
          return [{
            kind: "error",
            message: "Grok permission request reused a consumed JSON-RPC id with different request bytes",
          }];
        }
        this.permissionRequestFingerprints.set(message.id, fingerprint);
        const params = recordValue(message.params);
        const activeSessionId = this.normalizer.sessionId;
        if (!this.autoApprovePermissionRequests || !activeSessionId || !this.normalizer.canSteerBusy) {
          this.sendErrorResponse(
            message.id,
            "Grok permission request is outside an active always-approve turn",
            -32602,
          );
          return [];
        }
        if (!params || nonEmptyString(params.sessionId) !== activeSessionId) {
          this.sendErrorResponse(
            message.id,
            "Grok permission request session does not match the active Grok session",
            -32602,
          );
          return [];
        }
        const optionId = offeredAllowOnceOptionId(params);
        if (!optionId) {
          this.sendErrorResponse(
            message.id,
            "Grok permission request does not offer an allow_once option",
            -32602,
          );
          return [];
        }
        this.sendResultResponse(message.id, {
          outcome: { outcome: "selected", optionId },
        });
        return [];
      }
      this.sendErrorResponse(message.id, `Grok ACP client request "${message.method}" is not supported by the non-interactive Raft daemon`);
      return [];
    }

    if (!isJsonRpcResponse(message)) {
      return this.normalizer.normalizeNotification(message);
    }

    if (message.id === this.initializeRequestId) {
      this.initializeRequestId = null;
      if (hasJsonRpcField(message, "error")) {
        this.pendingSessionAfterInitialize = null;
        return [{
          kind: "error",
          message: grokErrorMessage(message, "Grok Build ACP initialize failed"),
          startupRequestMethod: "initialize",
        }];
      }
      if (!isCompatibleInitializeResult(message.result)) {
        this.pendingSessionAfterInitialize = null;
        return [{ kind: "error", message: initializeFailureMessage(), startupRequestMethod: "initialize" }];
      }
      this.initializeDefaultModel = grokModelSetFromInitializeResult(message.result)?.default ?? null;
      if (this.pendingSessionAfterInitialize) {
        const pending = this.pendingSessionAfterInitialize;
        this.pendingSessionAfterInitialize = null;
        this.sendSessionRequest(pending.method, pending.params);
      }
      return [];
    }

    if (message.id === this.pendingSessionRequestId) {
      const requestMethod = this.pendingSessionRequestMethod;
      this.pendingSessionRequestId = null;
      this.pendingSessionRequestMethod = null;
      if (hasJsonRpcField(message, "error")) {
        if (requestMethod === "session/load" && isMissingSessionError(message.error) && this.freshSessionParams) {
          const recovery = recoveryEvents(this.requestedResumeSessionId);
          if (this.pendingInitialPrompt !== null) {
            this.pendingInitialPrompt = prependRecoveryNotice(this.pendingInitialPrompt, recovery.recovery);
          }
          this.sendSessionRequest("session/new", this.freshSessionParams);
          return [recovery.telemetry, recovery.recovery];
        }
        return [{
          kind: "error",
          message: grokErrorMessage(message, "Grok Build session initialization failed"),
          ...(requestMethod ? { startupRequestMethod: requestMethod } : {}),
        }];
      }

      const sessionId = sessionIdFromResult(message.result, requestMethod === "session/load" ? this.requestedResumeSessionId : null);
      if (!sessionId) {
        return [{
          kind: "error",
          message: "Grok Build session response did not include a sessionId.",
          ...(requestMethod ? { startupRequestMethod: requestMethod } : {}),
        }];
      }
      this.normalizer.adoptSession(sessionId);
      // Grok takes the effort only with a model selection. An agent on Grok's
      // default model with an effort chosen selects that default explicitly,
      // or the effort would never reach Grok.
      const modelId = this.selectedModel
        ?? (this.selectedReasoningEffort ? this.initializeDefaultModel : null);
      if (modelId) {
        this.pendingModelRequestId = this.sendRequest("session/set_model", {
          sessionId,
          modelId,
          ...(this.selectedReasoningEffort ? { _meta: { reasoningEffort: this.selectedReasoningEffort } } : {}),
        });
        return [];
      }
      return this.startInitialPromptAndAnnounceSession(sessionId);
    }

    if (message.id === this.pendingModelRequestId) {
      this.pendingModelRequestId = null;
      if (hasJsonRpcField(message, "error")) {
        return [{
          kind: "error",
          message: grokErrorMessage(message, "Grok Build model selection failed"),
          startupRequestMethod: "session/set_model",
        }];
      }
      const sessionId = this.normalizer.sessionId;
      return sessionId ? this.startInitialPromptAndAnnounceSession(sessionId) : [{
        kind: "error",
        message: "Grok Build model selection completed before the session became ready.",
        startupRequestMethod: "session/set_model",
      }];
    }

    if (message.id !== undefined && this.pendingDeliveryRequests.has(message.id)) {
      const pending = this.pendingDeliveryRequests.get(message.id)!;
      this.pendingDeliveryRequests.delete(message.id);
      if (hasJsonRpcField(message, "error")) {
        if (pending.method === "turn/start") this.normalizer.abortPrompt(pending.generation);
        const errorMessage = grokErrorMessage(message, "Grok Build ACP delivery failed");
        if (pending.method === "turn/start" && pending.initial) {
          return [{ kind: "error", message: errorMessage, startupRequestMethod: "session/prompt" }];
        }
        return [{
          kind: "delivery_error",
          message: errorMessage,
          requestMethod: pending.method,
          source: "grok_acp_response",
          payloadBytes: payloadBytes(message.error),
        }];
      }
      if (pending.method === "turn/steer") return [];
      const result = recordValue(message.result) ?? {};
      const meta = recordValue(result._meta) ?? {};
      return this.normalizer.finishPrompt(pending.generation, {
        stopReason: result.stopReason,
        promptId: meta.promptId,
        agentResult: result.agentResult ?? meta.agentResult,
        usage: meta.usage ?? meta,
      });
    }

    return [];
  }

  encodeStdinMessage(
    text: string,
    sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    const liveSessionId = this.normalizer.sessionId ?? nonEmptyString(sessionId);
    if (!liveSessionId) return null;
    if (!this.normalizer.sessionId) this.normalizer.adoptSession(liveSessionId);

    if ((opts?.mode ?? "busy") === "busy") {
      if (!this.normalizer.canSteerBusy) return null;
      const id = this.nextRequestId();
      this.pendingDeliveryRequests.set(id, { method: "turn/steer" });
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: GROK_INTERJECT_METHOD,
        params: {
          sessionId: liveSessionId,
          text,
          interjectionId: `raft-${id}`,
        },
      });
    }

    const { id, request } = this.buildPromptRequest(text, liveSessionId, false);
    this.pendingDeliveryRequests.set(id, request);
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: liveSessionId,
        prompt: [{ type: "text", text }],
      },
    });
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectGrokModelsFromAcp();
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private sendRequest(method: string, params: Record<string, unknown>): GrokJsonRpcId {
    const id = this.nextRequestId();
    this.process?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  }

  private sendResultResponse(id: GrokJsonRpcId, result: Record<string, unknown>): void {
    this.process?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private sendErrorResponse(id: GrokJsonRpcId, message: string, code = -32601): void {
    this.process?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }) + "\n");
  }

  private sendSessionRequest(method: "session/new" | "session/load", params: Record<string, unknown>): void {
    this.pendingSessionRequestMethod = method;
    this.pendingSessionRequestId = this.sendRequest(method, params);
  }

  private buildPromptRequest(text: string, sessionId: string, initial: boolean): {
    id: number;
    request: PendingPromptRequest;
    wire: Record<string, unknown>;
  } {
    const id = this.nextRequestId();
    const generation = this.normalizer.beginPrompt();
    return {
      id,
      request: { method: "turn/start", generation, initial },
      wire: {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text }],
        },
      },
    };
  }

  private startInitialPromptAndAnnounceSession(sessionId: string): ParsedEvent[] {
    const prompt = this.pendingInitialPrompt;
    if (prompt === null) return [];
    this.pendingInitialPrompt = null;
    const built = this.buildPromptRequest(prompt, sessionId, true);
    this.pendingDeliveryRequests.set(built.id, built.request);
    this.process?.stdin?.write(JSON.stringify(built.wire) + "\n");
    return [{ kind: "session_init", sessionId }];
  }
}

interface GrokModelDetectionOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Lookup/exec stand-ins for tests (the PATH lookup that decides `runtime_not_found`). */
  deps?: ProbeDeps;
}

export async function detectGrokModelsFromAcp(
  options: GrokModelDetectionOptions = {},
): Promise<RuntimeModelSourceOutcome> {
  // task #1277: a form request must not block the daemon; the environment read
  // and the PATH lookup run as bounded probe children (the ACP child below was
  // already asynchronous).
  const baseEnv = options.env ?? ambientProcessEnv();
  const env = await withWindowsUserEnvironmentAsync(baseEnv, { ...options.deps, env: baseEnv });
  const signal = options.deps?.signal;
  let launch: GrokLaunch;
  try {
    launch = await resolveGrokSpawnAsync([...GROK_AGENT_ARGS], { ...options.deps, env });
  } catch (error) {
    // A cancelled detection is not a verdict: the abort travels up unchanged,
    // and nothing below (no fallback, no ACP child) runs on its behalf.
    if (isProbeAbort(error)) throw error;
    if (error instanceof RuntimeExecutableNotFoundError) {
      // task #1242: the verdict of the lookup that just failed, nothing newer.
      return {
        kind: "error", retryable: true, code: "runtime_not_found",
        ...(isRuntimeModelDetectionLookupReason(error.reason) ? { reason: error.reason } : {}),
      };
    }
    return { kind: "error", retryable: true, code: "detect_failed" };
  }
  if (signal?.aborted) throw new ProbeChildError("grok model detection aborted before the ACP child started", { code: "ABORT_ERR" });

  return await new Promise<RuntimeModelSourceOutcome>((resolve, reject) => {
    const proc = spawn(launch.command, launch.args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
      env: launch.env ?? env,
      shell: false,
      // task #1277: its own process group, so a cancel can end the whole ACP
      // tree (grok may start helpers), not only the direct child.
      detached: process.platform !== "win32",
    });
    let settled = false;
    let buffer = "";
    const initializeRequestId = 1;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      // Cancel ends the ACP tree, not only the direct child, and the rejection
      // says whether the tree was seen to end (never "kill sent" alone).
      void killProbeTreeAndSettle(proc).then((cleanup) => {
        reject(new ProbeChildError("grok model detection aborted", { code: "ABORT_ERR", cleanup }));
      });
    };
    const finish = (result: RuntimeModelSourceOutcome) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      proc.kill();
      resolve(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Server and cross-replica relay allow additional time for result transport.
    const timer = setClockTimeout(() => finish({ kind: "error", retryable: true, code: "detect_timeout" }), options.timeoutMs ?? GROK_MODEL_DETECTION_TIMEOUT_MS);

    proc.once("error", (error: NodeJS.ErrnoException) => finish({
      kind: "error", retryable: true, code: error.code === "ENOENT" ? "runtime_not_found" : "detect_failed",
    }));
    proc.once("exit", () => finish({ kind: "error", retryable: true, code: "detect_failed" }));
    proc.stdin?.on("error", () => finish({ kind: "error", retryable: true, code: "detect_failed" }));
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) {
        finish({ kind: "error", retryable: true, code: "detect_failed" });
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = parseGrokJsonRpcLine(line);
        if (!message || !isJsonRpcResponse(message) || message.id !== initializeRequestId) continue;
        if (hasJsonRpcField(message, "error")) {
          // ACP defines -32000 as authentication required. Never inspect prose.
          // https://agentclientprotocol.com/protocol/v1/schema#errorcode
          const code = recordValue(message.error)?.code;
          finish({
            kind: "error", retryable: true,
            code: code === -32000 ? "runtime_not_authenticated"
              : code === -32601 ? "protocol_unsupported" : "detect_failed",
          });
          return;
        }
        if (!hasJsonRpcField(message, "result") || !isCompatibleInitializeResult(message.result)) {
          finish({ kind: "error", retryable: true, code: "protocol_unsupported" });
          return;
        }
        finish(runtimeModelSourceOutcomeFromSet(grokModelSetFromInitializeResult(message.result)));
        return;
      }
    });

    proc.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id: initializeRequestId,
      method: "initialize",
      params: initializeParams(),
    }) + "\n");
  });
}
