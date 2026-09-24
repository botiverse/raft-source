import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import {
  clearClockTimeout,
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  setClockTimeout,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
  type AxSurfaceText,
} from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import { resolveGrokHomeFromEnv } from "./grokHome.js";
import {
  parseGrokJsonRpcLine,
  GrokEventNormalizer,
  type GrokJsonRpcId,
  type GrokJsonRpcMessage,
} from "./grokEventNormalizer.js";
import {
  requiresWindowsShell,
  resolveCommandOnPath,
  withWindowsUserEnvironment,
  type ProbeDeps,
} from "./probe.js";
import type {
  ParsedEvent,
  RuntimeBusyDeliveryReadiness,
  RuntimeDriver,
  RuntimeProbeResult,
  SpawnContext,
  SpawnResult,
} from "./types.js";

const GROK_AGENT_ARGS = ["agent", "--no-leader", "--always-approve", "stdio"] as const;
const GROK_AGENT_PROBE_ARGS = ["agent", "stdio", "--help"] as const;
const GROK_INTERJECT_METHOD = "_x.ai/interject" as const;
const GROK_REQUEST_PERMISSION_METHOD = "session/request_permission" as const;
const KNOWN_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

interface GrokLaunch {
  command: string;
  args: string[];
  shell: boolean;
}

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

function readGrokVersion(command: string, shell: boolean, deps: ProbeDeps): string | null {
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const env = withWindowsUserEnvironment(deps.env ?? process.env, deps);
  try {
    const output = execFileSyncFn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 5000,
      shell,
    });
    return (Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "")).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolveGrokCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath("grok", deps);
}

export function resolveGrokSpawn(args: string[], deps: ProbeDeps = {}): GrokLaunch {
  const command = resolveGrokCommand(deps);
  if (!command) {
    throw new Error("Cannot resolve the Grok Build CLI on PATH. Install Grok Build and run `grok login` first.");
  }
  const platform = deps.platform ?? process.platform;
  return {
    command,
    args,
    shell: requiresWindowsShell(command, platform),
  };
}

export function probeGrok(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveGrokCommand(deps);
  if (!command) {
    return { available: false, diagnostic: "No Grok Build CLI was found on PATH." };
  }
  const platform = deps.platform ?? process.platform;
  const shell = requiresWindowsShell(command, platform);
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const env = withWindowsUserEnvironment(deps.env ?? process.env, deps);
  try {
    execFileSyncFn(command, [...GROK_AGENT_PROBE_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 5000,
      shell,
    });
  } catch (error) {
    return {
      available: false,
      diagnostic: `Grok Build agent stdio probe failed: ${describeProbeFailure(error)}.`,
    };
  }
  return {
    available: true,
    version: readGrokVersion(command, shell, deps) ?? undefined,
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
  readonly session = { recovery: "resume_or_fresh" } as const;
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

    const launch = resolveGrokSpawn([...GROK_AGENT_ARGS], { env: spawnEnv });
    const proc = spawn(launch.command, launch.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: launch.shell,
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
      const modelId = this.selectedModel;
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
    return runtimeModelSourceOutcomeFromSet(await detectGrokModelsFromAcp());
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
}

export async function detectGrokModelsFromAcp(
  options: GrokModelDetectionOptions = {},
): Promise<RuntimeModelSet | null> {
  const env = withWindowsUserEnvironment(options.env ?? process.env, { env: options.env ?? process.env });
  let launch: GrokLaunch;
  try {
    launch = resolveGrokSpawn([...GROK_AGENT_ARGS], { env });
  } catch {
    return null;
  }

  return await new Promise<RuntimeModelSet | null>((resolve) => {
    const proc = spawn(launch.command, launch.args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
      env,
      shell: launch.shell,
    });
    let settled = false;
    let buffer = "";
    const initializeRequestId = 1;
    const finish = (result: RuntimeModelSet | null) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      proc.kill();
      resolve(result);
    };
    const timer = setClockTimeout(() => finish(null), options.timeoutMs ?? 5000);

    proc.once("error", () => finish(null));
    proc.once("exit", () => finish(null));
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = parseGrokJsonRpcLine(line);
        if (!message || !isJsonRpcResponse(message) || message.id !== initializeRequestId) continue;
        if (!hasJsonRpcField(message, "result") || !isCompatibleInitializeResult(message.result)) {
          finish(null);
          return;
        }
        finish(grokModelSetFromInitializeResult(message.result));
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
