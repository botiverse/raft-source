import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { logger } from "../logger";
import { ambientProcessEnv } from "../processEnvPatch";
import { spawnRuntimeChild } from "./runtimeChild";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
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

export function buildAntigravityArgs(ctx: SpawnContext): string[] {
  const args = [
    // Piped stdin selects headless mode; --print would consume the next flag.
    "--print-timeout",
    runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config)).envVars?.ANTIGRAVITY_PRINT_TIMEOUT || DEFAULT_PRINT_TIMEOUT,
    "--dangerously-skip-permissions",
  ];

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
    }).split("\n");
  } catch {
    return; // Not a repository, or no git.
  }
  const pattern = `/${lines[0]}${relativePath}`;
  const excludeFile = path.resolve(cwd, lines[1]!);
  try {
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern)) return;
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

/**
 * @deprecated Retained only to run and resume existing Antigravity agents.
 * Shared runtime availability and server admission reject new agents and
 * transitions from other runtimes; keep this driver for existing-agent compatibility.
 *
 * `agy` with piped stdin is a per-turn CLI. It prints assistant text as normal stdout
 * and exits after the turn. The CLI persists conversation state in its own
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
    toLaunchSpec: (_modelId: string) => ({ args: [] }),
  };
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;

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
    // `agy --print` has no stable external session id. This is the daemon's
    // logical session marker, so emit it only with meaningful runtime output.
    if (!this.sessionAnnounced && this.sessionId) {
      events.push({ kind: "session_init", sessionId: this.sessionId });
      this.sessionAnnounced = true;
    }

    if (isErrorLine(trimmed)) {
      events.push({ kind: "error", message: trimmed });
      return events;
    }

    events.push({ kind: "text", text: line });
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
