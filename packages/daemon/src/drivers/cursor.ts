import { ambientProcessEnv } from "../processEnvPatch";
import { spawn } from "node:child_process";
import { spawnRuntimeChild } from "./runtimeChild";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { clearClockTimeout, CURSOR_MODEL_DETECTION_TIMEOUT_MS, hydrateRuntimeConfig, setClockTimeout, runtimeConfigToLaunchFields, runtimeModelSourceOutcomeFromSet, type AgentConfig, type RuntimeModelInfo, type RuntimeModelSet, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./types";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { OpenToolCalls } from "./openToolCalls";
import { withWindowsUserEnvironment, type ProbeDeps } from "./probe";
import { resolveRuntimeLaunch, type DirectLaunch, type WindowsLaunchDeps } from "./windowsLaunch";
import {
  installManagedMcpRuntimeJsonOverlay,
  prepareManagedMcpRuntimeProxy,
} from "../managedMcpRuntimeProxy";

interface CursorModelsCommandResult {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error;
  /** The probe was killed at its deadline rather than failing on its own. */
  timedOut?: boolean;
}

type CursorModelsAsyncCommand = () => Promise<CursorModelsCommandResult>;

export async function buildCursorSpawnEnv(ctx: SpawnContext, deps: ProbeDeps = {}): Promise<NodeJS.ProcessEnv> {
  const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  return withWindowsUserEnvironment(spawnEnv, deps);
}

export function buildCursorManagedMcpConfig(
  config: Record<string, unknown>,
  managedMcp: { name: string; url: string },
): Record<string, unknown> {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
        ? config.mcpServers as Record<string, unknown>
        : {}),
      [managedMcp.name]: { url: managedMcp.url },
    },
  };
}

/**
 * Prompts longer than this go to cursor-agent on stdin instead of as the last
 * argv entry (`cursor-agent --print` reads stdin when it gets no prompt
 * argument and stdin is not a TTY).
 *
 * Windows caps a whole command line at 32,767 UTF-16 units and quoting can
 * double backslashes and quotes (plus node.exe/index.js paths and flags), so
 * first turns carrying the standing prompt failed with `spawn ENAMETOOLONG`
 * (#triage:#309). Linux caps one argument at 128 KiB (E2BIG). Short prompts keep using argv, so an old Cursor CLI that
 * cannot read stdin only fails where argv already could not carry the prompt.
 */
export const CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS = 6_000;
export const CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES = 64 * 1024;

export function cursorPromptViaStdin(prompt: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    ? prompt.length > CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS
    : Buffer.byteLength(prompt, "utf8") > CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES;
}

/** The argv and, for a long prompt, the stdin text of one Cursor turn: the prompt is in exactly one of them. */
export function buildCursorLaunchInput(
  ctx: SpawnContext,
  platform: NodeJS.Platform = process.platform,
): { args: string[]; stdinPrompt: string | null } {
  const viaStdin = cursorPromptViaStdin(ctx.prompt, platform);
  return { args: buildCursorArgs(ctx, platform), stdinPrompt: viaStdin ? ctx.prompt : null };
}

export function buildCursorArgs(ctx: SpawnContext, platform: NodeJS.Platform = process.platform): string[] {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--force",
  ];

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (ctx.config.sessionId) {
    args.push("--resume", ctx.config.sessionId);
  }

  if (!cursorPromptViaStdin(ctx.prompt, platform)) args.push(ctx.prompt);
  return args;
}

export interface CursorLaunchDeps extends WindowsLaunchDeps {
  readdirSyncFn?: (dirPath: string) => string[];
}

const CURSOR_VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2}-\d{2}-\d{2}))?-[a-f0-9]+$/;

function cursorVersionSortKey(name: string): string | null {
  const match = CURSOR_VERSION_DIR.exec(name);
  if (!match) return null;
  const [, year, month, day, time] = match;
  return `${year}${month!.padStart(2, "0")}${day!.padStart(2, "0")}${time ?? "00-00-00"}`;
}

/**
 * The Windows installer puts `cursor-agent.cmd` next to a `versions` directory;
 * the wrapper hands off to PowerShell, which runs the newest
 * `versions\<version>\node.exe versions\<version>\index.js`. Do the same
 * directly so the argv never passes through cmd.exe or PowerShell.
 */
export function resolveCursorWindowsInstallLaunch(
  shimPath: string,
  args: string[],
  deps: CursorLaunchDeps = {},
): DirectLaunch | null {
  const winPath = path.win32;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const readdirSyncFn = deps.readdirSyncFn ?? ((dirPath: string) => readdirSync(dirPath));
  const versionsDir = winPath.join(winPath.dirname(shimPath), "versions");
  let names: string[];
  try {
    names = readdirSyncFn(versionsDir);
  } catch {
    return null;
  }
  const versions = names
    .map((name) => ({ name, key: cursorVersionSortKey(name) }))
    .filter((entry): entry is { name: string; key: string } => entry.key !== null)
    .sort((a, b) => (a.key === b.key ? b.name.localeCompare(a.name) : b.key.localeCompare(a.key)));
  for (const { name } of versions) {
    const versionDir = winPath.join(versionsDir, name);
    const node = winPath.join(versionDir, "node.exe");
    const entry = winPath.join(versionDir, "index.js");
    if (!existsSyncFn(node) || !existsSyncFn(entry)) continue;
    return {
      command: node,
      args: [entry, ...args],
      env: { ...(deps.env ?? ambientProcessEnv()), CURSOR_INVOKED_AS: winPath.basename(shimPath) },
      shell: false,
    };
  }
  return null;
}

export function resolveCursorLaunch(args: string[], deps: CursorLaunchDeps = {}): DirectLaunch {
  return resolveRuntimeLaunch("cursor", "cursor-agent", args, {
    ...deps,
    resolveBatchLaunch: (shimPath, batchArgs) => resolveCursorWindowsInstallLaunch(shimPath, batchArgs, deps),
  });
}

/**
 * Cursor CLI driver.
 *
 * Uses `--print --output-format stream-json`, NDJSON events: system/init,
 * assistant (text), tool_call (started/completed, paired by `call_id`),
 * connection, result.
 *
 * No stdin streaming support — each turn is a separate process invocation.
 * A long prompt is written to stdin once and stdin closed (cursorPromptViaStdin).
 */
export class CursorDriver implements RuntimeDriver {
  readonly id = "cursor";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // Emits the compaction events.
    compaction: "reported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private readonly openTools = new OpenToolCalls();

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.openTools.clear();
    const managedMcp = await prepareManagedMcpRuntimeProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      processInstanceId: ctx.processInstanceId,
      readTurnOrigin: ctx.readTurnOrigin,
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
    });
    if (managedMcp) {
      installManagedMcpRuntimeJsonOverlay({
        agentId: ctx.agentId,
        launchId: ctx.launchId,
        filePath: path.join(ctx.workingDirectory, ".cursor", "mcp.json"),
        apply: (config) => buildCursorManagedMcpConfig(config, managedMcp),
      });
    }

    const { args, stdinPrompt } = buildCursorLaunchInput(ctx);

    const spawnEnv = await buildCursorSpawnEnv(ctx);

    const launch = resolveCursorLaunch(args, { env: spawnEnv });
    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    const proc = spawnRuntimeChild(launch.command, launch.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env ?? spawnEnv,
      shell: false,
    });
    // spawnRuntimeChild already guards stdin errors (EPIPE if the child exits first).
    if (stdinPrompt !== null) proc.stdin?.end(stdinPrompt);

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];

    switch (event.type) {
      case "system":
        if (event.subtype === "init" && event.session_id) {
          events.push({ kind: "session_init", sessionId: event.session_id });
        } else if (event.subtype === "status" && event.status === "compacting") {
          events.push({ kind: "compaction_started" });
        } else if (event.subtype === "compact_boundary") {
          events.push({ kind: "compaction_finished" });
        }
        break;

      case "assistant": {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              events.push({ kind: "thinking", text: block.thinking });
            } else if (block.type === "text" && block.text) {
              events.push({ kind: "text", text: block.text });
            }
          }
        }
        break;
      }

      case "tool_call": {
        // task #26: Cursor reports each call as its own `tool_call` event,
        // `started` then `completed`, paired by `call_id`; assistant content
        // carries only text.
        const callId = typeof event.call_id === "string" ? event.call_id : "";
        if (!callId) break;
        if (event.subtype === "started") {
          const call = cursorToolCall(event.tool_call);
          if (this.openTools.start(callId, call.name)) {
            events.push({ kind: "tool_call", name: call.name, input: call.input, callId });
          }
        } else if (event.subtype === "completed") {
          const name = this.openTools.end(callId);
          if (name !== undefined) events.push({ kind: "tool_output", name, callId, ...cursorToolOutcome(event.tool_call) });
        }
        break;
      }

      case "connection":
        // A call started before a reconnect never gets its completion.
        if (event.subtype === "reconnecting") {
          for (const call of this.openTools.drain()) {
            events.push({ kind: "tool_output", name: call.name, callId: call.callId });
          }
        }
        break;

      case "result": {
        this.openTools.clear();
        const subtype = typeof event.subtype === "string" ? event.subtype : "success";
        if (subtype !== "success" || event.is_error) {
          const parts: string[] = [];
          if (Array.isArray(event.errors)) {
            for (const err of event.errors) {
              if (typeof err === "string" && err.trim()) parts.push(err.trim());
            }
          }
          if (typeof event.result === "string" && event.result.trim()) {
            parts.push(event.result.trim());
          }
          const detail = parts.join(" | ") || "Execution failed";
          events.push({ kind: "error", message: detail });
        }
        events.push({ kind: "turn_end", sessionId: event.session_id });
        break;
      }
    }

    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    // Cursor CLI does not support stdin streaming
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectCursorModelSource();
  }

}

export function parseCursorModelsOutput(output: string): RuntimeModelSet | null {
  const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
  const models: RuntimeModelInfo[] = [];
  let defaultModel: string | undefined;

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^available models$/i.test(line) || /^tip:/i.test(line)) continue;
    if (/^no models available/i.test(line) || /^failed to load models:/i.test(line)) continue;

    let modelLine = line;
    const markerMatch = modelLine.match(/\s+\(([^)]+)\)$/);
    const markers = markerMatch?.[1]?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
    if (markers.length > 0 && markers.every((part) => part === "current" || part === "default")) {
      const markerStart = markerMatch?.index ?? modelLine.length;
      modelLine = modelLine.slice(0, markerStart).trim();
    }

    const match = modelLine.match(/^(\S+)(?:\s+-\s+(.+))?$/);
    if (!match) continue;

    const id = match[1]?.trim();
    if (!id || id.startsWith("-")) continue;

    const label = match[2]?.trim() || id;
    models.push({ id, label, verified: "launchable" });
    if (markers.includes("default")) defaultModel = id;
  }

  if (models.length === 0) return null;
  return { models, default: defaultModel };
}

export async function detectCursorModelSource(
  runCommand: CursorModelsAsyncCommand = () => runCursorModelsCommandAsync(),
): Promise<RuntimeModelSourceOutcome> {
  const result = await runCommand();
  if (result.timedOut) return { kind: "error", retryable: true, code: "detect_timeout" };
  if (result.error || result.status !== 0) {
    return { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet(parseCursorModelsOutput(String(result.stdout || "")));
}

export function buildCursorModelProbeEnv(deps: ProbeDeps = {}): NodeJS.ProcessEnv {
  return withWindowsUserEnvironment({
    ...(deps.env ?? ambientProcessEnv()),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  }, deps);
}

/** Cap on probe stdout: a model listing is a few KB; spawnSync's old default was 1 MiB. */
export const CURSOR_MODEL_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CursorModelsProbeOptions {
  timeoutMs?: number;
  command?: string;
  args?: string[];
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  /** Kill the probe and every process it started. */
  killTree?: (pid: number, platform: NodeJS.Platform) => void;
}

/**
 * Kill a probe's whole process tree. POSIX probes run in their own process
 * group (detached), so signalling -pid reaches a wrapper's children; Windows
 * has no groups, so `taskkill /T` walks the tree.
 */
export function killCursorProbeTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, env: ambientProcessEnv() }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/**
 * Async `cursor-agent models`. The old spawnSync froze the whole daemon for up
 * to its timeout. stdin is closed so a login prompt cannot wait for input,
 * output is capped, and the deadline or the cap kills the probe's process tree
 * (a surviving child would otherwise linger or hold stdout open).
 */
export function runCursorModelsCommandAsync(options: CursorModelsProbeOptions = {}): Promise<CursorModelsCommandResult> {
  const {
    timeoutMs = CURSOR_MODEL_DETECTION_TIMEOUT_MS,
    command,
    args = ["models"],
    maxOutputBytes = CURSOR_MODEL_PROBE_MAX_OUTPUT_BYTES,
    platform = process.platform,
    killTree = killCursorProbeTree,
  } = options;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: unknown;
    const output = () => Buffer.concat(chunks).toString("utf8");
    const finish = (result: CursorModelsCommandResult) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const env = buildCursorModelProbeEnv();
      const launch = command
        ? { command, args, env: undefined }
        : resolveCursorLaunch(args, { env, platform });
      child = spawn(launch.command, launch.args, {
        env: launch.env ?? env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, error: error as Error });
      return;
    }
    const kill = () => {
      if (child.pid !== undefined) killTree(child.pid, platform);
      else child.kill("SIGKILL");
    };
    timer = setClockTimeout(() => {
      kill();
      finish({ status: null, stdout: output(), timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        kill();
        finish({ status: null, error: new Error(`cursor-agent models output exceeded ${maxOutputBytes} bytes`) });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => finish({ status: null, stdout: output(), error }));
    child.on("close", (status) => finish({ status, stdout: output() }));
  });
}

/** Cursor's tool kinds, named the way the shared tool display knows them. */
const CURSOR_TOOL_NAMES: Record<string, string> = {
  shell: "Shell",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  webFetch: "WebFetch",
  webSearch: "WebSearch",
};

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * The call inside Cursor's `tool_call` object: one `<kind>ToolCall: { args,
 * result? }` entry (`shellToolCall`, `readToolCall`, `mcpToolCall`, ...), or
 * the older `function: { name, arguments }` form.
 */
function cursorToolEntry(toolCall: unknown): { kind: string; body: JsonObject } | null {
  for (const [key, value] of Object.entries(asJsonObject(toolCall) ?? {})) {
    const body = asJsonObject(value);
    if (!body) continue;
    if (key.endsWith("ToolCall")) return { kind: key.slice(0, -"ToolCall".length), body };
    if (key === "function") return { kind: "function", body };
  }
  return null;
}

function cursorToolCall(toolCall: unknown): { name: string; input: unknown } {
  const entry = cursorToolEntry(toolCall);
  if (!entry) return { name: "unknown_tool", input: {} };
  if (entry.kind === "function") {
    let input: unknown = entry.body.arguments ?? {};
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        input = { arguments: input };
      }
    }
    return { name: nonEmptyString(entry.body.name) ?? "unknown_tool", input };
  }
  const args = asJsonObject(entry.body.args) ?? {};
  if (entry.kind === "mcp") {
    return { name: nonEmptyString(args.toolName) ?? nonEmptyString(args.name) ?? "mcp", input: args.args ?? args };
  }
  return { name: CURSOR_TOOL_NAMES[entry.kind] ?? entry.kind, input: args };
}

/**
 * A completed call's outcome. `result` holds one variant: `success`, or a
 * failure such as `rejected` or `permissionDenied`. A shell command that ran
 * and exited non-zero is `failure` with its exit code, which is a finished
 * command rather than a failed call; one killed or aborted is not. Zero values
 * may be left out of Cursor's JSON, so a shell `success` without `exitCode`
 * exited 0; a `failure` with neither is left unknown.
 */
function cursorToolOutcome(toolCall: unknown): { ok?: boolean; exitCode?: number } {
  const entry = cursorToolEntry(toolCall);
  const result = asJsonObject(entry?.body.result);
  if (!entry || !result) return {};
  const variant = Object.keys(result)[0];
  const detail = asJsonObject(variant ? result[variant] : undefined) ?? {};
  if (entry.kind === "shell" && (variant === "success" || variant === "failure")) {
    // A command killed by a signal, OOM-killed or aborted did not run to its exit.
    if (detail.aborted === true || nonEmptyString(detail.signal) || detail.oomKill === true || detail.oom_kill === true) {
      return { ok: false, ...(Number.isInteger(detail.exitCode) ? { exitCode: detail.exitCode as number } : {}) };
    }
    const exitCode = Number.isInteger(detail.exitCode) ? (detail.exitCode as number) : variant === "success" ? 0 : undefined;
    return exitCode !== undefined ? { ok: true, exitCode } : {};
  }
  if (variant === "success") return { ok: !(entry.kind === "mcp" && detail.isError === true) };
  return { ok: false };
}
