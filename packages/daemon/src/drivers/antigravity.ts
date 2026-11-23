import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { logger } from "../logger";
import { ambientProcessEnv } from "../processEnvPatch";
import { spawnRuntimeChild } from "./runtimeChild";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig, type RuntimeModelSet, type RuntimeModelSourceOutcome, type AxSurfaceText } from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { lookupCommandOnPath, resolveCommandOnPath, readCommandVersion, type ProbeDeps } from "./probe";
import { resolveWindowsDirectLaunch, type DirectLaunch } from "./windowsLaunch";
import { detectAntigravityModelSource } from "./antigravityModels";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types";
import {
  installManagedMcpRuntimeJsonOverlay,
  prepareManagedMcpRuntimeProxy,
} from "../managedMcpRuntimeProxy";

const DEFAULT_PRINT_TIMEOUT = "30m";
export const ANTIGRAVITY_ENV_OVERRIDES = {
  // `agy` switches to a separate file-based token store when it detects an SSH
  // session. Daemon agents commonly run under SSH-managed hosts, while the
  // human login lives in the normal local Antigravity credential store.
  SSH_CLIENT: undefined,
  SSH_CONNECTION: undefined,
  SSH_TTY: undefined,
} as const;

export function resolveAntigravitySpawn(
  commandArgs: string[],
  deps: ProbeDeps = {},
): DirectLaunch {
  const command = resolveCommandOnPath("agy", deps) ?? "agy";
  if ((deps.platform ?? process.platform) !== "win32") return { command, args: commandArgs, shell: false };
  return resolveWindowsDirectLaunch("antigravity", command, commandArgs, deps);
}

/**
 * The model and effort as agy's own flags (agy 1.5.9 `--help`: `--model`
 * "Model for the current CLI session", `--effort` "Reasoning effort for the
 * current CLI session (low|medium|high|xhigh|max)"; OAR
 * experiments/antigravity-native-gaps-2026-11-15/native-flags.json). As the OAR
 * launch (oarAntigravityLaunch.ts): the saved id verbatim (agy takes a combined
 * id such as `gemini-3.8-flash-high` as it is), `default` leaves both to agy,
 * and no effort leaves the model's own level.
 */
export function antigravityModelArgs(model: string | null | undefined, effort: string | null | undefined): string[] {
  const id = model?.trim() ?? "";
  if (!id || id === "default") return [];
  const level = effort?.trim() ?? "";
  return ["--model", id, ...(level ? ["--effort", level] : [])];
}

/**
 * The effort the legacy spawn passes (#oar-raft:#35). agy refuses a start
 * whose `--effort` the model has no menu for ("--effort is not supported for
 * model …"); a saved effort can predate the model list that shows that. When
 * the Computer's last list shows the model with its effort menu and the level
 * isn't on it (an empty menu: the model takes none), the start leaves
 * `--effort` out and agy uses the model's own level. A model not listed, or
 * listed without a menu read, passes the saved effort as before.
 */
export function antigravityLegacyEffort(model: string | null | undefined, effort: string | null | undefined, listed: RuntimeModelSet | null | undefined): string | null | undefined {
  const level = effort?.trim();
  if (!level) return effort;
  const menu = listed?.models.find((entry) => entry.id === model?.trim())?.supportedReasoningEfforts;
  return menu && !menu.includes(level) ? null : effort;
}

export function buildAntigravityArgs(ctx: SpawnContext): string[] {
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const args = [
    // Piped stdin selects headless mode; --print would consume the next flag.
    "--print-timeout",
    launchFields.envVars?.ANTIGRAVITY_PRINT_TIMEOUT || DEFAULT_PRINT_TIMEOUT,
    // One NDJSON event per line from the start (`init` first), so the start
    // is ready on agy's first event, not on the turn's final text.
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];

  // An agy without these flags exits on them ("flags provided but not
  // defined"): the start fails visibly instead of running another model.
  const effort = antigravityLegacyEffort(launchFields.model, launchFields.reasoningEffort, ctx.cachedRuntimeModels?.());
  if (effort !== launchFields.reasoningEffort) {
    logger.info(`[Agent ${ctx.agentId}] Antigravity: model ${launchFields.model} offers no effort ${launchFields.reasoningEffort}; starting without --effort`);
  }
  args.push(...antigravityModelArgs(launchFields.model, effort));

  if (ctx.config.sessionId) {
    args.push("--continue");
  }

  return args;
}

export function buildAntigravityManagedMcpConfig(
  config: Record<string, unknown>,
  managedMcp: { name: string; url: string },
): Record<string, unknown> {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
        ? config.mcpServers as Record<string, unknown>
        : {}),
      [managedMcp.name]: {
        serverUrl: managedMcp.url,
        transport: "http",
      },
    },
  };
}

/**
 * Keep a file holding a launch's MCP token out of `git add -A`, in the
 * repository's own exclude file, never its `.gitignore`. `relativePath` is from
 * the workspace, and the line names that one path. A workspace that isn't a
 * repository has nothing to do; nothing here stops the launch.
 */
export function excludeFromWorkspaceGit(workingDirectory: string, relativePath: string): void {
  let cwd: string;
  let lines: string[];
  try {
    // git's relative answers are from the physical directory.
    cwd = realpathSync(workingDirectory);
    lines = execFileSync("git", ["rev-parse", "--show-prefix", "--git-path", "info/exclude"], {
      cwd,
      encoding: "utf8",
      env: ambientProcessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    }).split(/\r?\n/);
  } catch {
    return; // Not a repository, or no git.
  }
  const pattern = `/${lines[0]}${relativePath}`;
  const excludeFile = path.resolve(cwd, lines[1]!);
  try {
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).includes(pattern)) return;
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    appendFileSync(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  } catch (error) {
    logger.warn(`[Antigravity] Could not exclude ${relativePath} from git: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * What a launch needs around the `agy` command, on either host: Raft's CLI
 * transport in its environment, and the managed MCP server in the workspace's
 * own `.agents/mcp_config.json` (never through ACP, where `agy` would store it).
 */
export async function prepareAntigravityEnvironment(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  const managedMcp = await prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    processInstanceId: ctx.processInstanceId,
    readTurnOrigin: ctx.readTurnOrigin,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
  });
  if (managedMcp) {
    const filePath = path.join(ctx.workingDirectory, ".agents", "mcp_config.json");
    // A file the user already has is theirs to commit or not.
    if (!existsSync(filePath)) excludeFromWorkspaceGit(ctx.workingDirectory, ".agents/mcp_config.json");
    installManagedMcpRuntimeJsonOverlay({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      filePath,
      apply: (config) => buildAntigravityManagedMcpConfig(config, managedMcp),
    });
  }
  const { spawnEnv } = await prepareCliTransport(ctx, {
    NO_COLOR: "1",
    ...ANTIGRAVITY_ENV_OVERRIDES,
  });
  return spawnEnv;
}

const ERROR_LINE_PREFIX_RE = /^(?:(?:error|fatal|exception|failure):\s*|failed(?:\b|:))/i;
const ERROR_LINE_PATTERNS = [
  /authentication timed out/i,
  /\bpermission denied\b/i,
  /\bunauthorized\b/i,
  /\brate limit(?:ed)?\b/i,
  /\bserver error\b/i,
  /\bnetwork error\b/i,
  /\brequest timed out\b/i,
  /\btimed out waiting\b/i,
  /\b(?:http|status)\s+(?:401|403|429|500|502|503|504)\b/i,
];

function isErrorLine(line: string): boolean {
  return (
    ERROR_LINE_PREFIX_RE.test(line) ||
    ERROR_LINE_PATTERNS.some((pattern) => pattern.test(line))
  );
}

type StreamRecord = Record<string, unknown>;

function asStreamRecord(value: unknown): StreamRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as StreamRecord : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** agy's error field: a string, or an object with a `message` (as `tool_info.error`). */
function streamErrorText(value: unknown): string | undefined {
  return nonEmptyString(value) ?? nonEmptyString(asStreamRecord(value)?.message);
}

/** One `--output-format stream-json` line: an object with a string `event`, else null. */
function parseStreamEvent(line: string): StreamRecord | null {
  if (!line.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asStreamRecord(parsed);
  return record && typeof record.event === "string" ? record : null;
}

/** agy's `result.status` values that end a turn without a failure of its own. */
const STOPPED_RESULT_STATUSES = new Set(["CANCELED", "INTERRUPTED"]);

/**
 * The legacy host for Antigravity: it runs an agent the server does not send
 * to the OAR host (`agent_runtime_oar_antigravity` off, or a Computer that did
 * not advertise `runtime-host:oar`), and is the fallback when an OAR start fails
 * (agentHost/oarAntigravityLaunch.ts).
 *
 * `agy` with piped stdin is a per-turn CLI that exits after the turn. It runs
 * with `--output-format stream-json`: one JSON event per line (agy's headless
 * docs): `init` at the start, `step_update` per step (`agent_response` steps
 * carry `text_delta`, `tool` steps `tool_name` / `tool_info`), and one final
 * `result` with `status`, `response` and, on failure, `error`. Plain text
 * printed no event until the turn's answer, so a long first turn never
 * reached startup readiness. The CLI persists conversation state in its own
 * workspace-local store; after Slock has seen one turn, follow-up launches use
 * `--continue` for that workspace instead of trying to interpret the opaque
 * Antigravity conversation files.
 */
export class AntigravityDriver implements RuntimeDriver {
  readonly id = "antigravity";
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
    // OAR lists what the signed-in `agy` offers now; the OAR launch passes the choice.
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ args: antigravityModelArgs(modelId, null) }),
  };
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  /** Tool steps announced this turn, by step index. */
  private toolSteps = new Map<string, { name: string; done: boolean }>();
  private sawResponseText = false;

  probe(): RuntimeProbeResult {
    const { command, missReason } = lookupCommandOnPath("agy");
    if (!command) return { available: false, unavailableReason: missReason };
    return {
      available: true,
      version: readCommandVersion(command) ?? undefined,
    };
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || randomUUID();
    this.sessionAnnounced = false;
    this.toolSteps.clear();
    this.sawResponseText = false;

    const launch = resolveAntigravitySpawn(buildAntigravityArgs(ctx));
    const spawnEnv = await prepareAntigravityEnvironment(ctx);

    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    const proc = spawnRuntimeChild(launch.command, launch.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env ?? spawnEnv,
      shell: false,
    });

    proc.stdin?.end(ctx.prompt);

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const events: ParsedEvent[] = [];
    // This is the daemon's logical session marker (resume is `--continue`, not
    // agy's conversation id), emitted with agy's first output: its `init`
    // event, which is startup readiness.
    if (!this.sessionAnnounced && this.sessionId) {
      events.push({ kind: "session_init", sessionId: this.sessionId });
      this.sessionAnnounced = true;
    }

    const streamEvent = parseStreamEvent(trimmed);
    if (streamEvent) {
      events.push(...this.parseStreamEvent(streamEvent));
      return events;
    }

    // Anything agy prints outside the stream (a sign-in prompt, a fatal error).
    if (isErrorLine(trimmed)) {
      events.push({ kind: "error", message: trimmed });
      return events;
    }

    events.push({ kind: "text", text: line });
    return events;
  }

  private parseStreamEvent(record: StreamRecord): ParsedEvent[] {
    switch (record.event) {
      case "init":
        // Readiness is the session_init above.
        return [];
      case "step_update":
        return this.parseStepUpdate(asStreamRecord(record.step_update));
      case "result":
        return this.parseResult(asStreamRecord(record.result));
      default: {
        // An event this driver does not know is progress, unless it reports an error.
        const error = streamErrorText(record.error);
        if (error) return [{ kind: "error", message: `Antigravity error: ${error}` }];
        return [{ kind: "internal_progress", source: "antigravity_stream_event", itemType: String(record.event) }];
      }
    }
  }

  private parseStepUpdate(step: StreamRecord | null): ParsedEvent[] {
    const stepType = typeof step?.step_type === "string" ? step.step_type : undefined;
    const progress: ParsedEvent[] = [{ kind: "internal_progress", source: "antigravity_stream_event", itemType: stepType ?? "step_update" }];
    if (!step) return progress;

    if (stepType === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      if (!delta) return progress;
      this.sawResponseText = true;
      return [{ kind: "text", text: delta }];
    }

    if (stepType === "tool") {
      const info = asStreamRecord(step.tool_info);
      const name = nonEmptyString(step.tool_name) ?? nonEmptyString(info?.name) ?? "unknown_tool";
      const index = typeof step.step_index === "number" || typeof step.step_index === "string" ? String(step.step_index) : "";
      const done = step.state === "DONE";
      const events: ParsedEvent[] = [];
      if (!index) {
        // Without an index a step's updates cannot be told apart: report it once, when done.
        if (done) {
          events.push({ kind: "tool_call", name, input: info?.parameters ?? {} });
          events.push({ kind: "tool_output", name, ok: !info?.error });
        }
        return events.length > 0 ? events : progress;
      }
      const callId = `step-${index}`;
      let known = this.toolSteps.get(index);
      if (!known) {
        known = { name, done: false };
        this.toolSteps.set(index, known);
        events.push({ kind: "tool_call", name, input: info?.parameters ?? {}, callId });
      }
      if (done && !known.done) {
        known.done = true;
        events.push({ kind: "tool_output", name: known.name, callId, ok: !info?.error });
      }
      return events.length > 0 ? events : progress;
    }

    return progress;
  }

  private parseResult(result: StreamRecord | null): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const status = typeof result?.status === "string" ? result.status : undefined;
    if (status === "SUCCESS") {
      const response = nonEmptyString(result?.response);
      // The turn's answer when agy streamed none of it.
      if (response && !this.sawResponseText) events.push({ kind: "text", text: response });
    } else if (!status || !STOPPED_RESULT_STATUSES.has(status)) {
      const detail = streamErrorText(result?.error);
      events.push({
        kind: "error",
        message: detail ? `Antigravity error: ${detail}` : `Antigravity turn ended with status ${status ?? "unknown"}`,
      });
    }
    this.toolSteps.clear();
    this.sawResponseText = false;
    events.push({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  /** The `agy` login's models through OAR's `listModels` (antigravityModels.ts). */
  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectAntigravityModelSource();
  }
}
