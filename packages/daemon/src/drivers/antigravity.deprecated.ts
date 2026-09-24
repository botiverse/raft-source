import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import { resolveCommandOnPath, readCommandVersion, requiresWindowsShell, type ProbeDeps } from "./probe.js";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types.js";
import {
  installManagedMcpRuntimeJsonOverlay,
  prepareManagedMcpRuntimeProxy,
} from "../managedMcpRuntimeProxy.js";

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
): { command: string; args: string[]; shell: boolean } {
  const command = resolveCommandOnPath("agy", deps) ?? "agy";
  return {
    command,
    args: commandArgs,
    shell: requiresWindowsShell(command, deps.platform),
  };
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
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "suggestion_only" as const,
    toLaunchSpec: (_modelId: string) => ({ args: [] }),
  };
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;

  probe(): RuntimeProbeResult {
    const command = resolveCommandOnPath("agy");
    if (!command) return { available: false };
    return {
      available: true,
      version: readCommandVersion(command) ?? undefined,
    };
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || randomUUID();
    this.sessionAnnounced = false;

    const managedMcp = await prepareManagedMcpRuntimeProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
    });
    if (managedMcp) {
      installManagedMcpRuntimeJsonOverlay({
        agentId: ctx.agentId,
        launchId: ctx.launchId,
        filePath: path.join(ctx.workingDirectory, ".agents", "mcp_config.json"),
        apply: (config) => buildAntigravityManagedMcpConfig(config, managedMcp),
      });
    }

    const { command, args, shell } = resolveAntigravitySpawn(buildAntigravityArgs(ctx));
    const { spawnEnv } = await prepareCliTransport(ctx, {
      NO_COLOR: "1",
      ...ANTIGRAVITY_ENV_OVERRIDES,
    });

    const proc = spawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell,
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

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return { kind: "unsupported" };
  }
}
