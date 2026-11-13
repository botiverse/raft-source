import { ambientProcessEnv } from "../processEnvPatch";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { execFileSync } from "node:child_process";
import { spawnRuntimeChild } from "./runtimeChild";
import { existsSync } from "node:fs";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./types";
import { buildGeminiTokenUsageEvent } from "./geminiEventNormalizer";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { resolveNodeHostLaunch } from "./nodeHostLaunch";
import { resolveCommandOnPath, resolveCommandOnPathAsync, type ProbeDeps } from "./probe";
import { OpenToolCalls } from "./openToolCalls";
import { ProbeChildError, runProbeChild } from "./probeChild";
import {
  prepareManagedMcpRuntimeProxy,
  writeManagedMcpRuntimeConfigFile,
} from "../managedMcpRuntimeProxy";
import { resolveRaftHome } from "../raftHome";

export async function buildGeminiSpawnEnv(
  ctx: SpawnContext,
  platform: NodeJS.Platform = process.platform,
  managedMcpSettingsPath?: string | null,
): Promise<NodeJS.ProcessEnv> {
  const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" }, platform);
  const launchEnvVars = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config)).envVars;
  // Gemini CLI's trusted-workspace gate breaks our managed headless flow
  // unless we explicitly trust the daemon-owned agent workspace. Keep an
  // explicit agent env override authoritative for operators who need it.
  if (!Object.prototype.hasOwnProperty.call(launchEnvVars ?? {}, "GEMINI_CLI_TRUST_WORKSPACE")) {
    spawnEnv.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  // On Windows, Gemini CLI's node-pty dependency calls AttachConsole which
  // fails in headless daemon spawn environments. Bypass PTY initialization
  // by telling Gemini to use node:child_process instead.
  // Respect explicit user override for operators who need PTY behavior.
  if (platform === "win32" && !Object.prototype.hasOwnProperty.call(launchEnvVars ?? {}, "GEMINI_PTY_INFO")) {
    spawnEnv.GEMINI_PTY_INFO = "child_process";
  }
  if (managedMcpSettingsPath) {
    spawnEnv.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = managedMcpSettingsPath;
  }
  return spawnEnv;
}

export function buildGeminiManagedMcpSettings(managedMcp: {
  name: string;
  url: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [managedMcp.name]: { httpUrl: managedMcp.url },
    },
  };
}

function normalizeExecOutput(raw: unknown): string {
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
}

export function buildGeminiArgs(config: AgentConfig): string[] {
  const args = [
    "--output-format", "stream-json",
    "--yolo",
    // Gemini CLI headless mode is selected by -p/--prompt. Keep the actual
    // prompt off argv and feed it through stdin below; this avoids Windows
    // cmd.exe's 8191-character command-line limit and keeps long wake payloads
    // below CreateProcess argv pressure too.
    "-p", "",
  ];

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  return args;
}

/**
 * task #1277 — budget for the two Windows discovery children of the async
 * resolver (`npm root -g`, `where.exe gemini`). The synchronous resolver runs
 * them with no timeout (unchanged here); a child that exceeds this budget is
 * treated like any other discovery failure: the next candidate is tried, and
 * a runtime that is not found stays "not resolved", never "not installed".
 */
export const GEMINI_WINDOWS_DISCOVERY_TIMEOUT_MS = 5000;

/** `where.exe` exits 1 when nothing matched and 2 when it could not run (documented). */
const WHERE_EXE_NO_MATCH_STATUS = 1;

/**
 * task #1242 (review on #9801): only a child's documented clean "no match"
 * exit decides anything. A budget timeout is `probe_timeout`; every other way
 * a child can fail — spawn error (`code`), a non-zero status that is not the
 * documented no-match status, a signal, or an error of unknown shape — is
 * `probe_failed`. `runProbeChild` reports an ordinary non-zero exit through
 * `status` with no `code`, so a `code`-only check misses it.
 */
export function classifyDiscoveryFailure(
  error: unknown,
  child: { cleanNoMatchStatus?: number } = {},
): "probe_timeout" | "probe_failed" | "no_match" {
  if (error instanceof ProbeChildError) {
    if (error.code === "ETIMEDOUT") return "probe_timeout";
    if (error.code !== undefined) return "probe_failed";
    if (error.signal) return "probe_failed";
    if (typeof error.status === "number" && error.status === child.cleanNoMatchStatus) return "no_match";
    return "probe_failed";
  }
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "ETIMEDOUT") return "probe_timeout";
  return "probe_failed";
}

function isProbeAbort(error: unknown): boolean {
  return error instanceof ProbeChildError && error.code === "ABORT_ERR";
}

/** task #1277 — {@link resolveGeminiSpawn} off the event loop, under the caller's signal. */
export async function resolveGeminiSpawnAsync(
  commandArgs: string[],
  deps: ProbeDeps = {},
): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: (await resolveCommandOnPathAsync("gemini", deps)) ?? "gemini",
      args: commandArgs,
      env: deps.env ?? ambientProcessEnv(),
    };
  }

  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  let geminiEntry: string | null = null;
  // task #1242: a discovery child that timed out (or failed to run) did not
  // decide anything. When no entry is found, the error carries that verdict so
  // downstream never reads "not resolved" as "not installed".
  let undecided: "probe_timeout" | "probe_failed" | undefined;
  const noteUndecided = (error: unknown, child: { cleanNoMatchStatus?: number }) => {
    const verdict = classifyDiscoveryFailure(error, child);
    if (verdict === "probe_timeout") undecided = "probe_timeout";
    else if (verdict === "probe_failed" && undecided === undefined) undecided = "probe_failed";
  };

  try {
    const globalRoot = (await runChild("npm", ["root", "-g"], {
      env,
      timeoutMs: GEMINI_WINDOWS_DISCOVERY_TIMEOUT_MS,
      platform,
      signal: deps.signal,
    })).stdout.trim();
    const candidate = winPath.join(globalRoot, "@google", "gemini-cli", "bundle", "gemini.js");
    if (existsSyncFn(candidate)) geminiEntry = candidate;
  } catch (error) {
    if (isProbeAbort(error)) throw error;
    // `npm root -g` has no clean "no match" exit: any failure is undecided.
    noteUndecided(error, {});
    // Fall through to resolving the npm shim location.
  }

  if (!geminiEntry) {
    try {
      const cmdPath = (await runChild("where.exe", ["gemini"], {
        env,
        timeoutMs: GEMINI_WINDOWS_DISCOVERY_TIMEOUT_MS,
        platform,
        signal: deps.signal,
      })).stdout.trim().split(/\r?\n/)[0] ?? "";
      const candidate = winPath.join(winPath.dirname(cmdPath), "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
      if (existsSyncFn(candidate)) geminiEntry = candidate;
    } catch (error) {
      if (isProbeAbort(error)) throw error;
      noteUndecided(error, { cleanNoMatchStatus: WHERE_EXE_NO_MATCH_STATUS });
    }
  }

  if (!geminiEntry) {
    throw new RuntimeExecutableNotFoundError({ runtimeId: "gemini", ...(undecided ? { reason: undecided } : {}), message:
      undecided === "probe_timeout"
        ? "The Gemini CLI discovery on Windows did not finish within its budget. This is not evidence that Gemini is missing; retry."
        : undecided === "probe_failed"
          ? "The Gemini CLI discovery on Windows could not run. This is not evidence that Gemini is missing; retry."
          : "Cannot resolve Gemini CLI entry point on Windows. " +
            "Ensure @google/gemini-cli is installed globally via npm (npm i -g @google/gemini-cli)." });
  }

  const nodeHost = resolveNodeHostLaunch({
    env,
    execPath: deps.execPath,
    execIsElectron: deps.execIsElectron,
  });
  return {
    command: nodeHost.command,
    args: [...nodeHost.execArgv, geminiEntry, ...commandArgs],
    env: nodeHost.env,
  };
}

export function resolveGeminiSpawn(
  commandArgs: string[],
  deps: ProbeDeps = {},
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: resolveCommandOnPath("gemini", deps) ?? "gemini",
      args: commandArgs,
      env: deps.env ?? ambientProcessEnv(),
    };
  }

  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  let geminiEntry: string | null = null;

  try {
    const globalRoot = normalizeExecOutput(execFileSyncFn("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })).trim();
    const candidate = winPath.join(globalRoot, "@google", "gemini-cli", "bundle", "gemini.js");
    if (existsSyncFn(candidate)) geminiEntry = candidate;
  } catch {
    // Fall through to resolving the npm shim location.
  }

  if (!geminiEntry) {
    try {
      const cmdPath = normalizeExecOutput(execFileSyncFn("where.exe", ["gemini"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      })).trim().split(/\r?\n/)[0];
      const candidate = winPath.join(winPath.dirname(cmdPath), "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
      if (existsSyncFn(candidate)) geminiEntry = candidate;
    } catch {
      // ignore
    }
  }

  if (!geminiEntry) {
    throw new RuntimeExecutableNotFoundError({ runtimeId: "gemini", message:
      "Cannot resolve Gemini CLI entry point on Windows. " +
      "Ensure @google/gemini-cli is installed globally via npm (npm i -g @google/gemini-cli)." });
  }

  const nodeHost = resolveNodeHostLaunch({
    env,
    execPath: deps.execPath,
    execIsElectron: deps.execIsElectron,
  });
  return {
    command: nodeHost.command,
    args: [...nodeHost.execArgv, geminiEntry, ...commandArgs],
    env: nodeHost.env,
  };
}

/**
 * Gemini CLI driver.
 *
 * Uses `--output-format stream-json` which emits NDJSON events:
 *   init, message (role=user/assistant, delta), tool_use, tool_result, result, error
 *
 * No stdin streaming support — each turn is a separate process invocation.
 */
export class GeminiDriver implements RuntimeDriver {
  readonly id = "gemini";
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
    // Never emits a compaction event.
    compaction: "unreported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "suggestion_only",
    toLaunchSpec: (modelId: string) => (modelId && modelId !== "default" ? { args: ["--model", modelId] } : { args: [] }),
  } as const;
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private readonly openTools = new OpenToolCalls();

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || null;
    this.sessionAnnounced = false;
    this.openTools.clear();

    const managedMcp = await prepareManagedMcpRuntimeProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      processInstanceId: ctx.processInstanceId,
      readTurnOrigin: ctx.readTurnOrigin,
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
    });
    const managedMcpSettingsPath = managedMcp
      ? writeManagedMcpRuntimeConfigFile({
          agentId: ctx.agentId,
          launchId: ctx.launchId,
          slockHome: ctx.slockHome ?? resolveRaftHome(),
          runtime: "gemini",
          filename: "settings.json",
          content: JSON.stringify(buildGeminiManagedMcpSettings(managedMcp)),
        })
      : null;

    const spawnEnv = await buildGeminiSpawnEnv(ctx, process.platform, managedMcpSettingsPath);
    // task #1277: the launch resolution (PATH lookup; on Windows the npm and
    // where.exe discovery) runs as bounded probe children under this start
    // attempt's signal; a cancelled lookup is rethrown, never a verdict.
    const { command, args, env } = await resolveGeminiSpawnAsync(buildGeminiArgs(ctx.config), { env: spawnEnv, signal: ctx.launchSignal });

    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    // A start stopped while the lookup ran must not create a child.
    if (ctx.launchSignal?.aborted) throw new ProbeChildError("gemini launch cancelled before the child was created", { code: "ABORT_ERR" });
    const proc = spawnRuntimeChild(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
    });

    proc.stdin?.end(ctx.prompt);

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
      case "init":
        if (event.session_id) {
          this.sessionId = event.session_id;
          events.push({ kind: "session_init", sessionId: event.session_id });
          this.sessionAnnounced = true;
        }
        break;

      case "message":
        if (event.role === "assistant" && event.content) {
          if (event.delta) {
            events.push({ kind: "text", text: event.content });
          } else {
            events.push({ kind: "text", text: event.content });
          }
        }
        break;

      case "tool_use": {
        const name = event.tool_name || "unknown_tool";
        const callId = typeof event.tool_id === "string" && event.tool_id ? event.tool_id : undefined;
        if (callId && !this.openTools.start(callId, name)) break;
        events.push({ kind: "tool_call", name, input: event.parameters, ...(callId ? { callId } : {}) });
        break;
      }

      case "tool_result": {
        // Gemini sends no exit code or duration, and reports a cancelled call
        // as "success"; the daemon times the call itself.
        const callId = typeof event.tool_id === "string" ? event.tool_id : "";
        const name = callId ? this.openTools.end(callId) : undefined;
        if (name !== undefined) events.push({ kind: "tool_output", name, callId, ok: event.status === "success" });
        break;
      }

      case "error":
        events.push({ kind: "error", message: event.message || "Unknown Gemini error" });
        break;

      case "result":
        // The turn's end closes whatever is still open (the daemon resets its count too).
        this.openTools.clear();
        if (event.status !== "success") {
          const raw = event.error_message || event.message || event.error || "";
          const detail = typeof raw === "string" ? raw : (raw?.message || JSON.stringify(raw));
          const msg = detail
            ? `Gemini error: ${detail}`
            : `Gemini session ended with status: ${event.status}`;
          events.push({ kind: "error", message: msg });
        }
        {
          // Gemini `result` events carry a `stats` object with token counts.
          // Emit token_usage telemetry only when usage is actually present
          // (mark-absent, never zero-fill). See geminiEventNormalizer.ts.
          const usageEvent = buildGeminiTokenUsageEvent(event.stats, this.sessionId);
          if (usageEvent) events.push(usageEvent);
        }
        events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
        break;
    }

    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    // Gemini CLI does not support stdin streaming
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

}
